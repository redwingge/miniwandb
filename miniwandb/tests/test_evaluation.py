import json
from pathlib import Path
import tempfile
import unittest

import miniwandb
from miniwandb import Run
from miniwandb.cleanup import preview_purge, purge_runs
from miniwandb.crossval import edit_membership
from miniwandb.evaluation import comparison
from miniwandb.importer import import_sources
from miniwandb.storage import Reader, connect, set_trashed


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name

    def tearDown(self):
        miniwandb.finish()
        self.temp.cleanup()

    def records(self, run_id):
        reader = Reader(self.directory)
        try:
            return reader.run(run_id, include_trashed=True), reader.history(run_id), reader.evaluations(run_id)
        finally:
            reader.close()

    def make(self, run_id, fold=0, score=0.7, status=0, cv="model-a", evaluate=True):
        run = Run(id=run_id, name=run_id, project="RBP", dir=self.directory,
                  config={"cv_id": cv, "cv_name": cv, "n_splits": 3, "fold": fold} if cv else {})
        if evaluate:
            run.log_evaluation("test_1580", {"mcc": score, "sp": 0.9}, metadata={"checkpoint":"best.pth"})
            run.log_evaluation("test_46541", {"mcc": score - 0.1})
        run.finish(exit_code=status)
        return run

    def test_final_scores_are_separate_durable_and_do_not_change_training_or_status(self):
        with Run(id="model", dir=self.directory) as run:
            run.log({"valid/mcc": 0.8}, step=7)
        before = self.records("model")
        miniwandb.log_evaluation("test_1580", {"mcc": 0.7, "sp": 0.9}, run_id="model", dir=self.directory,
                                metadata={"threshold": 0.4, "checkpoint": Path("best.pth")})
        after, history, evaluations = self.records("model")
        self.assertEqual(history, before[1])
        for key in ("summary", "status", "finished_at", "last_step", "updated_at"):
            self.assertEqual(after[key], before[0][key])
        self.assertGreater(after["evaluations_updated_at"], 0)
        self.assertEqual(evaluations[0]["metrics"], {"mcc": 0.7, "sp": 0.9})
        self.assertEqual(evaluations[0]["metadata"]["checkpoint"], "best.pth")

    def test_module_active_run_and_explicit_duplicate_correction(self):
        run = miniwandb.init(id="active", dir=self.directory)
        payload = {"mcc": 0.5, "missing": float("nan")}
        miniwandb.log_evaluation("test", payload)
        self.assertEqual(miniwandb.log_evaluation("test", payload)["status"], "unchanged")
        with self.assertRaises(ValueError): miniwandb.log_evaluation("test", {"mcc": 0.8})
        self.assertEqual(miniwandb.log_evaluation("test", {"mcc": 0.8}, replace=True)["status"], "replaced")
        run.log_evaluation("test", {"mcc": 0.3}, name="last")
        self.assertEqual(len(self.records("active")[2]), 2)
        self.assertEqual(run.step, 0)
        miniwandb.finish()
        with self.assertRaises(RuntimeError): miniwandb.log_evaluation("test", {"mcc": 1})

    def test_validation_is_atomic_missing_runs_and_trashed_runs_are_rejected(self):
        run = self.make("model", cv=None)
        before = self.records("model")[2]
        for metrics in ({"mcc": [0.1, 0.2]}, {"mcc": True}, {"": 0.2}, {}):
            with self.assertRaises((ValueError, TypeError)):
                miniwandb.log_evaluation("other", metrics, run_id=run.id, dir=self.directory)
        with self.assertRaises(KeyError): miniwandb.log_evaluation("test", {"mcc": 1}, run_id="absent", dir=self.directory)
        set_trashed(self.directory, ["model"])
        with self.assertRaises(ValueError): miniwandb.log_evaluation("test", {"mcc": 1}, run_id="model", dir=self.directory)
        self.assertEqual(self.records("model")[2], before)

    def test_cv_expands_full_group_selects_success_or_preference_and_never_fills_missing(self):
        self.make("a-old", score=0.99)
        self.make("a-retry", score=0.4)
        self.make("a-failed", score=1, status=1)
        self.make("a-fold1", fold=1, score=0.6)
        self.make("b-fold0", cv="model-b", score=0.8)
        result = comparison(self.directory, ["a-old", "b-fold0"])["models"]
        self.assertEqual(len(result), 2)
        group = next(model for model in result if model["name"]=="model-a")
        records = [r for r in group["records"] if r["dataset"]=="test_1580"]
        self.assertEqual({r["run_id"] for r in records}, {"a-retry", "a-fold1"})
        self.assertEqual(group["n_splits"], 3)
        edit_membership(self.directory, ["a-old"], preferred=True)
        records = comparison(self.directory, ["a-fold1"])["models"][0]["records"]
        self.assertIn("a-old", {r["run_id"] for r in records})
        edit_membership(self.directory, ["a-old"], preferred=False)
        self.make("a-no-eval", evaluate=False)
        records = comparison(self.directory, ["a-fold1"])["models"][0]["records"]
        self.assertEqual({r["run_id"] for r in records}, {"a-fold1"})

    def test_trash_restore_purge_and_reimport_preserve_expected_lifecycle(self):
        source = Path(self.directory) / "source.jsonl"
        source.write_text('{"_step":0,"loss":0.1}')
        import_sources([source], self.directory, report=lambda _: None)
        reader = Reader(self.directory)
        imported = reader.runs()[0]["id"]; reader.close()
        miniwandb.log_evaluation("test", {"mcc": 0.5}, run_id=imported, dir=self.directory)
        before = self.records(imported)[2]
        import_sources([source], self.directory, replace=True, report=lambda _: None)
        self.assertEqual(self.records(imported)[2], before)
        set_trashed(self.directory, [imported])
        with self.assertRaises(KeyError): comparison(self.directory, [imported])
        self.assertEqual(comparison(self.directory, [imported], trashed=True)["models"][0]["records"][0]["metrics"]["mcc"], 0.5)
        set_trashed(self.directory, [imported], trashed=False)
        self.assertEqual(self.records(imported)[2], before)
        set_trashed(self.directory, [imported])
        self.assertEqual(preview_purge(self.directory, [imported])["experiments"][0]["evaluations"], 1)
        purge_runs(self.directory, [imported])
        db = connect(self.directory)
        self.assertEqual(db.execute("SELECT count(*) FROM evaluations").fetchone()[0], 0); db.close()


if __name__ == "__main__":
    unittest.main()
