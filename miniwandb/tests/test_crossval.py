import json
import math
from pathlib import Path
import tempfile
import unittest

from miniwandb import Run
from miniwandb.crossval import assign_group, apply_candidates, edit_membership, preview_groups, summary
from miniwandb.importer import import_sources
from miniwandb.storage import Reader, connect, set_trashed
from miniwandb.cleanup import purge_runs


class CrossValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name

    def tearDown(self):
        self.temp.cleanup()

    def make(self, run_id, fold=0, cv="batch-one", status="finished", values=(0.2, 0.4), project="RBP", config=None):
        settings = {"fold": fold, "seed": 42, "lora_lr": 0.0001}
        if cv is not None:
            settings.update(cv_id=cv, cv_name="MP_focal", n_splits=3)
        settings.update(config or {})
        run = Run(id=run_id, project=project, name="MP_fold_%d" % fold, config=settings, dir=self.directory)
        for value in values:
            run.log({"valid/mcc": value})
        if status != "running":
            run.finish(exit_code=0 if status == "finished" else 1)
        return run

    def records(self):
        reader = Reader(self.directory)
        try:
            return reader.runs()
        finally:
            reader.close()

    def test_native_registration_validation_and_project_isolation(self):
        self.make("a", 0); self.make("b", 1)
        self.assertEqual(len({run["cv"]["group_id"] for run in self.records()}), 1)
        for run_id, fold, config in (("bad-fold", 3, {}), ("bad-splits", 1, {"n_splits": 5})):
            with self.assertRaises(ValueError): self.make(run_id, fold, config=config)
        self.assertEqual(len(self.records()), 2)
        self.make("other", project="other-project")
        self.assertEqual(len({run["cv"]["group_id"] for run in self.records()}), 2)

    def test_latest_successful_attempt_not_best_score_and_manual_preference(self):
        self.make("old", values=(0.95,)); self.make("new", values=(0.2, 0.4))
        self.make("failed", status="failed", values=(1.0,)); self.make("fold1", 1, values=(0.6,))
        group_id = self.records()[0]["cv"]["group_id"]
        result = summary(self.directory, [group_id], "valid/mcc")["groups"][0]
        self.assertEqual((result["completed"], result["n_splits"], result["n"]), (2, 3, 2))
        self.assertAlmostEqual(result["mean"], 0.5)
        self.assertAlmostEqual(result["std"], math.sqrt(0.02))
        self.assertEqual(result["folds"][0]["run_id"], "new")
        self.assertIsNone(result["folds"][2]["value"])
        edit_membership(self.directory, ["old"], preferred=True)
        self.assertAlmostEqual(summary(self.directory, [group_id], "valid/mcc")["groups"][0]["mean"], 0.775)
        with Run(id="old", resume=True, dir=self.directory) as run:
            run.update_config({"cv_name":"MP_focal"})
        self.assertTrue(next(run for run in self.records() if run["id"]=="old")["cv"]["preferred"])
        with self.assertRaises(ValueError): edit_membership(self.directory, ["failed"], preferred=True)

    def test_missing_null_incomplete_trash_and_reduction_semantics(self):
        self.make("a", values=(None,))
        group_id = self.records()[0]["cv"]["group_id"]
        result = summary(self.directory, [group_id], "valid/mcc")["groups"][0]
        self.assertEqual(result["n"], 0); self.assertIsNone(result["mean"])
        self.make("b", 1, values=(0.7, 0.2)); active = self.make("live", 2, status="running", values=(1.0,))
        for reduction, expected in (("max", 0.7), ("min", 0.2), ("last", 0.2)):
            result = summary(self.directory, [group_id], "valid/mcc", reduction)["groups"][0]
            self.assertEqual(result["n"], 1); self.assertEqual(result["mean"], expected); self.assertIsNone(result["std"])
        set_trashed(self.directory, ["b"])
        self.assertEqual(summary(self.directory, [group_id], "valid/mcc")["groups"][0]["n"], 0)
        self.assertEqual(summary(self.directory, [group_id], "valid/mcc", trashed=True)["groups"][0]["mean"], 0.7)
        active.finish()

    def test_final_evaluation_summary_uses_exact_dataset_version_and_representatives(self):
        from miniwandb import log_evaluation
        old = self.make("old")
        latest = self.make("latest")
        second = self.make("second", fold=1)
        self.make("failed", fold=2, status="failed")
        for run_id, dataset, name, value in ((old.id, "test_a", "final", .99), (latest.id, "test_b", "final", .2),
                                             (second.id, "test_a", "final", .6), (second.id, "test_a", "last", .4),
                                             ("failed", "test_a", "final", 1.0)):
            log_evaluation(dataset, {"mcc": value, "sp": None}, name=name, run_id=run_id, dir=self.directory,
                           metadata={"checkpoint": name + ".pt"})
        group_id = self.records()[0]["cv"]["group_id"]
        result = summary(self.directory, [group_id], "mcc", source="evaluation", dataset="test_a")
        group = result["groups"][0]
        self.assertEqual((result["source"], result["dataset"], result["evaluation"], result["reduction"]),
                         ("evaluation", "test_a", "final", "final"))
        self.assertEqual((group["completed"], group["n"], group["mean"], group["std"]), (2, 1, .6, None))
        self.assertEqual(group["folds"][0]["run_id"], latest.id)
        self.assertEqual(group["folds"][0]["missing_reason"], "evaluation_not_recorded")
        self.assertEqual(group["folds"][1]["evaluation_metadata"], {"checkpoint": "final.pt"})
        last = summary(self.directory, [group_id], "mcc", source="evaluation", dataset="test_a", evaluation="last")
        self.assertEqual(last["groups"][0]["mean"], .4)
        edit_membership(self.directory, [old.id], preferred=True)
        preferred = summary(self.directory, [group_id], "mcc", source="evaluation", dataset="test_a")["groups"][0]
        self.assertAlmostEqual(preferred["mean"], .795)
        null = summary(self.directory, [group_id], "sp", source="evaluation", dataset="test_a")["groups"][0]
        self.assertEqual(null["n"], 0)
        self.assertEqual(null["folds"][0]["missing_reason"], "missing_value")
        for options in ({"source": "invalid"}, {"source": "evaluation"},
                        {"source": "evaluation", "dataset": "test_a", "evaluation": ""}):
            with self.assertRaises(ValueError):
                summary(self.directory, [group_id], "mcc", **options)

    def test_final_catalog_and_trash_scope(self):
        from miniwandb import log_evaluation
        first = self.make("first")
        second = self.make("second", fold=1)
        before = next(run for run in self.records() if run["id"] == first.id)
        log_evaluation("test", {"mcc": .8, "sp": .9}, run_id=first.id, dir=self.directory)
        log_evaluation("test", {"mcc": .6}, run_id=second.id, dir=self.directory)
        after = next(run for run in self.records() if run["id"] == first.id)
        self.assertEqual(after["updated_at"], before["updated_at"])
        self.assertNotEqual(after["evaluations_updated_at"], before["evaluations_updated_at"])
        self.assertEqual(after["evaluation_keys"], [{"dataset": "test", "name": "final", "metrics": ["mcc", "sp"]}])
        set_trashed(self.directory, [first.id])
        group_id = after["cv"]["group_id"]
        visible = summary(self.directory, [group_id], "mcc", source="evaluation", dataset="test")["groups"][0]
        trash = summary(self.directory, [group_id], "mcc", trashed=True, source="evaluation", dataset="test")["groups"][0]
        self.assertEqual(visible["mean"], .6)
        self.assertEqual(trash["mean"], .8)

    def test_preview_does_not_group_until_review_and_conflicts_are_blocked(self):
        for fold in (0, 1):
            self.make("old%d" % fold, fold, cv=None, config={"wandb_run_name":"MP", "model_type":"%d_3fold" % fold, "kfold_set":fold})
        preview = preview_groups(self.directory, ["old0", "old1"])
        self.assertEqual(len(preview["candidates"]), 1)
        self.assertFalse(preview["candidates"][0]["blocked"])
        self.assertTrue(all(run["cv"] is None for run in self.records()))
        self.assertEqual(apply_candidates(self.directory, ["old0", "old1"], [preview["candidates"][0]["id"]])["updated"], 2)
        self.make("conflict", 0, cv=None, config={"model_type":"1_3fold", "kfold_set":1})
        preview = preview_groups(self.directory, ["conflict"])
        self.assertTrue(preview["candidates"][0]["blocked"])
        with self.assertRaises(ValueError): apply_candidates(self.directory, ["conflict"], [preview["candidates"][0]["id"]])
        assign_group(self.directory, ["conflict"], {"conflict":1}, "resolved", 3)
        self.assertEqual(preview_groups(self.directory, ["conflict"])["runs"][0]["fold"], 1)

    def test_duplicate_candidates_and_different_hyperparameters(self):
        for key in ("a", "b"): self.make(key, cv=None, config={"wandb_run_name":"MP", "n_splits":3})
        self.make("c", cv=None, config={"wandb_run_name":"MP", "n_splits":3, "lora_lr":0.002})
        preview = preview_groups(self.directory, ["a", "b", "c"])
        self.assertEqual(len(preview["candidates"]), 2)
        self.assertTrue(next(item for item in preview["candidates"] if len(item["runs"])==2)["blocked"])

    def test_manual_move_validation_atomicity_and_configs_unchanged(self):
        self.make("a", cv=None); self.make("b", 1, cv=None)
        before = {run["id"]:run["config"] for run in self.records()}
        first = assign_group(self.directory, ["a", "b"], {"a":0,"b":1}, "one", 3)
        with self.assertRaises(ValueError): assign_group(self.directory, ["a"], {"a":0}, "two", 3)
        second = assign_group(self.directory, ["a"], {"a":0}, "two", 3, allow_move=True)
        self.assertNotEqual(first["group_id"], second["group_id"])
        with self.assertRaises(ValueError): assign_group(self.directory, ["a", "b"], {"a":0,"b":None}, "bad", 3, allow_move=True)
        self.assertEqual(before, {run["id"]:run["config"] for run in self.records()})
        self.assertEqual(len({run["cv"]["group_id"] for run in self.records()}), 2)

    def test_reimport_preserves_membership_and_detach_survives_resume(self):
        path = Path(self.directory)/"history.jsonl"; path.write_text('{"_step":0,"valid/mcc":0.7}\n')
        import_sources([path], self.directory, report=lambda _:None)
        run_id = self.records()[0]["id"]
        assign_group(self.directory, [run_id], {run_id:0}, "manual", 3)
        import_sources([path], self.directory, replace=True, report=lambda _:None)
        self.assertEqual(self.records()[0]["cv"]["name"], "manual")
        self.make("native"); edit_membership(self.directory, ["native"])
        with Run(id="native", resume=True, dir=self.directory): pass
        self.assertIsNone(next(run for run in self.records() if run["id"]=="native")["cv"])

    def test_summary_only_fallback_and_purge_cascade(self):
        self.make("a"); group_id = self.records()[0]["cv"]["group_id"]
        db = connect(self.directory)
        with db: db.execute("UPDATE runs SET summary=? WHERE id='a'", (json.dumps({"summary_only":0.75}),))
        db.close()
        result = summary(self.directory, [group_id], "summary_only", "last")["groups"][0]
        self.assertEqual(result["mean"], 0.75); self.assertEqual(result["folds"][0]["value_source"], "summary")
        self.assertEqual(summary(self.directory, [group_id], "summary_only", "max")["groups"][0]["n"], 0)
        set_trashed(self.directory, ["a"]); purge_runs(self.directory, ["a"])
        db = connect(self.directory)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM cv_members").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM cv_groups").fetchone()[0], 0); db.close()


if __name__ == "__main__": unittest.main()
