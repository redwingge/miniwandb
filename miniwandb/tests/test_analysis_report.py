import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from miniwandb import Run
from miniwandb.analysis_report import build_analysis_bundle
from miniwandb.crossval import edit_membership
from miniwandb.storage import Reader, set_trashed


class AnalysisReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = self.temp.name

    def run_record(self, run_id, fold=None, score=0.8, status="finished", **config):
        if fold is not None:
            config.update(cv_id="model-a", cv_name="Model A", fold=fold, n_splits=3)
        run = Run(id=run_id, project="test", name=run_id, dir=self.directory, config=config)
        run.log({"valid/mcc": score}, step=0)
        run.log_evaluation("test_a", {"mcc": score}, metadata={"checkpoint": "best"})
        if status != "running":
            run.finish(exit_code=0 if status == "finished" else 1)
        else:
            self.addCleanup(run.finish)
        return run

    def bundle(self, ids, **options):
        archive = zipfile.ZipFile(io.BytesIO(build_analysis_bundle(self.directory, ids, **options)))
        return archive, json.loads(archive.read("experiments.json"))

    def test_full_history_statistics_bounded_sampling_missing_and_epoch(self):
        run = Run(id="curve", dir=self.directory)
        for step in range(1200):
            data = {"valid/loss": None if step == 501 else float(step), "lr": 0.001}
            if step % 100 == 0:
                data["epoch"] = step // 100
            run.log(data, step=step)
        run.finish()
        archive, payload = self.bundle([run.id], max_points=60, step_unit="batch")
        curves = payload["experiments"][0]["curves"]
        loss = curves["valid/loss"]
        self.assertEqual((loss["observations"], loss["finite_observations"], loss["missing_observations"]), (1200, 1199, 1))
        self.assertEqual(loss["best"]["step"], 0)
        self.assertEqual(loss["last"]["step"], 1199)
        self.assertEqual(loss["last"]["epoch"], 11)
        self.assertEqual(loss["tail_window"]["slope_per_step"], 1)
        self.assertTrue(loss["sampled"])
        self.assertLessEqual(len(loss["points"]), 60)
        self.assertIn(501, [point["step"] for point in loss["points"]])
        self.assertIsNone(curves["lr"]["best"])
        self.assertEqual(payload["context"]["step_unit"], "batch")
        self.assertIn("sampled_curves.csv", archive.namelist())
        reader = Reader(self.directory)
        try:
            self.assertEqual(reader.db.execute("SELECT COUNT(*) FROM metrics WHERE run_id='curve'").fetchone()[0], 2412)
        finally:
            reader.close()

    def test_cv_expansion_latest_finished_not_best_and_missing_fold(self):
        old = self.run_record("old", fold=0, score=0.99)
        self.run_record("new", fold=0, score=0.7)
        self.run_record("failed", fold=0, score=1.0, status="failed")
        self.run_record("fold1", fold=1, score=0.9)
        self.run_record("running", fold=2, status="running")
        archive, payload = self.bundle([old.id])
        self.assertEqual(len(payload["experiments"]), 5)
        group = payload["groups"][0]
        self.assertEqual([rep["run_id"] for rep in group["representatives"]], ["new", "fold1", None])
        self.assertEqual(group["missing_folds"], [2])
        score = group["final_summary"][0]
        self.assertEqual(score["n"], 2)
        self.assertAlmostEqual(score["mean"], 0.8)
        self.assertAlmostEqual(score["std_ddof1"], 0.02 ** 0.5)
        raw = list(csv.DictReader(io.StringIO(archive.read("final_scores.csv").decode("utf-8-sig"))))
        self.assertEqual(len(raw), 5)
        self.assertEqual(next(row for row in raw if row["run_id"] == "failed")["selection_reason"], "not_finished")
        self.assertEqual(next(row for row in raw if row["run_id"] == "old")["is_representative"], "False")
        edit_membership(self.directory, [old.id], preferred=True)
        _, preferred = self.bundle(["new"])
        self.assertEqual(preferred["groups"][0]["representatives"][0]["run_id"], "old")

    def test_dataset_version_separation_missing_config_and_optional_logs(self):
        first = self.run_record("first", fold=0, lr=None)
        second = self.run_record("second", fold=1)
        # Final scores may be attached after a run has ended.
        import miniwandb
        miniwandb.log_evaluation("test_b", {"mcc": 0.5}, run_id=first.id, dir=self.directory)
        miniwandb.log_evaluation("test_a", {"mcc": 0.6}, name="last", run_id=second.id, dir=self.directory)
        _, payload = self.bundle([first.id], primary_metric="valid/mcc", direction="min", include_output=False)
        self.assertFalse(payload["include_output"])
        self.assertNotIn("output_excerpt", payload["experiments"][0])
        self.assertEqual(len(payload["groups"][0]["final_summary"]), 3)
        for record in payload["experiments"]:
            self.assertEqual(record["curves"]["valid/mcc"]["direction_source"], "explicit")
        archive, _ = self.bundle([first.id])
        parameters = archive.read("parameter_comparison.csv").decode("utf-8-sig")
        self.assertIn("<not-recorded>", parameters)
        self.assertIn("null", parameters)

    def test_output_tail_limits_names_and_unknown_metadata(self):
        run = Run(id="log", dir=self.directory)
        run.log_output("start\n" + "x" * 20000 + "end\n")
        run.finish()
        archive, payload = self.bundle([run.id])
        record = payload["experiments"][0]
        self.assertTrue(record["output_excerpt"]["truncated"])
        text = archive.read(record["output_excerpt"]["file"]).decode()
        self.assertLessEqual(len(text), 16384)
        self.assertTrue(text.endswith("end\n"))
        self.assertEqual(payload["context"]["step_unit"], "unknown")
        self.assertFalse(any("sqlite" in path for path in archive.namelist()))

    def test_final_score_matrix_sorted_with_explicit_representative_and_long_table(self):
        import miniwandb
        self.run_record("old", fold=0, score=.99)
        self.run_record("new", fold=0, score=.7)
        self.run_record("second", fold=1, score=.9)
        miniwandb.log_evaluation("test_a", {"mcc": .7, "sp": .8, "absent": None}, run_id="new", dir=self.directory,
                                metadata={"checkpoint": "best.pt", "epoch": 4}, replace=True)
        miniwandb.log_evaluation("test_b", {"mcc": .5}, name="last", run_id="second", dir=self.directory)
        archive, payload = self.bundle(["old"])
        wide = list(csv.DictReader(io.StringIO(archive.read("final_scores.csv").decode("utf-8-sig"))))
        long = list(csv.DictReader(io.StringIO(archive.read("final_scores_long.csv").decode("utf-8-sig"))))
        self.assertEqual([(row["dataset"], row["run_id"]) for row in wide],
                         [("test_a", "old"), ("test_a", "new"), ("test_a", "second"), ("test_b", "second")])
        selected = next(row for row in wide if row["run_id"] == "new")
        self.assertEqual((selected["group_name"], selected["fold"], selected["is_representative"], selected["selection_reason"]),
                         ("Model A", "0", "True", "latest_finished"))
        self.assertEqual((selected["metric/mcc"], selected["metric/sp"], selected["metric/absent"], selected["checkpoint"]),
                         ("0.7", "0.8", "", "best.pt"))
        self.assertEqual(next(row for row in wide if row["run_id"] == "old")["selection_reason"], "superseded_attempt")
        self.assertEqual(len(long), 6)
        self.assertEqual(json.loads(selected["metadata"]), {"checkpoint": "best.pt", "epoch": 4})
        self.assertEqual(payload["export_formats"]["final_scores.csv"]["metric_columns"]["metric/mcc"], "mcc")

    def test_validation_and_trash_scope(self):
        self.run_record("one")
        for options in ({"max_points": 1}, {"direction": "max"}, {"include_output": 1}, {"step_unit": "minute"}):
            with self.assertRaises(ValueError):
                self.bundle(["one"], **options)
        with self.assertRaises(ValueError):
            self.bundle([])
        with self.assertRaises(KeyError):
            self.bundle(["absent"])
        set_trashed(self.directory, ["one"], True)
        with self.assertRaises(KeyError):
            self.bundle(["one"])
        _, payload = self.bundle(["one"], trashed=True)
        self.assertTrue(payload["selection"]["trash"])

    def test_cli_exports_readable_zip(self):
        self.run_record("cli")
        output = Path(self.directory) / "report.zip"
        result = subprocess.run([sys.executable, "-m", "miniwandb", "export-ai", "cli", "--dir", self.directory,
                                 "--output", str(output), "--no-output"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(output) as archive:
            self.assertIn("analysis_instructions.md", archive.namelist())


if __name__ == "__main__":
    unittest.main()
