import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from miniwandb.importer import discover, import_sources, read_experiment, save_experiment, sdk_types
from miniwandb.storage import Reader, set_trashed


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.logs = self.root / "destination"
        self.source = self.root / "history.jsonl"
        rows = [{"_step": 5, "_timestamp": 1000, "train/loss": 0.5, "epoch": 1},
                {"_step": 5, "_timestamp": 1001, "valid": {"auc": 0.9}, "image": {"_type": "image-file", "width": 10}},
                {"_step": 8, "_timestamp": 1020, "train/loss": 0.2, "nan": float("nan")}]
        self.source.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        reader = Reader(self.logs)
        try:
            runs = reader.runs()
            return runs, [reader.history(run["id"]) for run in runs]
        finally:
            reader.close()

    def test_jsonl_preserves_steps_timestamps_sparse_metrics_and_nulls(self):
        counts = import_sources([self.source], self.logs, project="old-runs", report=lambda _: None)
        self.assertEqual(counts, {"imported": 1, "skipped": 0, "failed": 0})
        runs, histories = self.snapshot()
        self.assertEqual(runs[0]["created_at"], 1000)
        self.assertEqual(runs[0]["status"], "imported")
        self.assertEqual(runs[0]["project"], "old-runs")
        self.assertEqual(runs[0]["summary"]["valid/auc"], 0.9)
        self.assertEqual([row["step"] for row in histories[0]], [5, 8])
        self.assertEqual(histories[0][0]["timestamp"], 1001)
        self.assertEqual(histories[0][0]["metrics"], {"epoch": 1, "train/loss": 0.5, "valid/auc": 0.9})
        self.assertIsNone(histories[0][1]["metrics"]["nan"])
        self.assertNotIn("image/width", runs[0]["summary"])

    def test_import_is_idempotent_and_replace_removes_stale_metrics(self):
        import_sources([self.source], self.logs, report=lambda _: None)
        before, _ = self.snapshot()
        self.source.write_text('{"_step": 0, "_timestamp": 5000, "new": 9}\n')
        result = import_sources([self.source], self.logs, report=lambda _: None)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(self.snapshot()[0], before)
        result = import_sources([self.source], self.logs, replace=True, report=lambda _: None)
        self.assertEqual(result["imported"], 1)
        runs, histories = self.snapshot()
        self.assertEqual(len(runs), 1)
        self.assertEqual(histories[0][0]["metrics"], {"new": 9})
        self.assertNotIn("train/loss", runs[0]["summary"])

    def test_parse_failure_leaves_no_partial_run_and_continues(self):
        bad = self.root / "bad.jsonl"
        bad.write_text('{"_step": 0, "loss": 1}\ntruncated-json')
        result = import_sources([bad, self.source], self.logs, report=lambda _: None)
        self.assertEqual(result, {"imported": 1, "skipped": 0, "failed": 1})
        self.assertEqual(len(self.snapshot()[0]), 1)

    def test_replace_failure_rolls_back_original(self):
        experiment = read_experiment(self.source)
        save_experiment(experiment, self.logs, self.source)
        before = self.snapshot()
        experiment.history = [(0, 1000, {"bad": object()})]
        with self.assertRaises((TypeError, ValueError)):
            save_experiment(experiment, self.logs, self.source, replace=True)
        self.assertEqual(self.snapshot(), before)

    def test_csv_does_not_turn_sparse_blanks_into_fake_null_points(self):
        path = self.root / "history.csv"
        path.write_text('_step,_timestamp,train/loss,valid/auc\n0,1000,0.5,\n1,1010,,0.9\n')
        experiment = read_experiment(path)
        self.assertEqual(experiment.history[0][2], {"train/loss": 0.5})
        self.assertEqual(experiment.history[1][2], {"valid/auc": 0.9})

    def test_directory_discovery_prefers_binary_and_deduplicates_aliases(self):
        run = self.root / "wandb/run-20260101_000000-abc"
        (run / "files").mkdir(parents=True)
        binary = run / "run-abc.wandb"
        binary.touch()
        (run / "files/wandb-history.jsonl").write_text("{}")
        (run.parent / "latest-run").symlink_to(run, target_is_directory=True)
        self.assertEqual(discover([run.parent, binary]), [binary.resolve()])

    def test_summary_only_does_not_manufacture_a_curve(self):
        self.source.write_text("")
        (self.root / "wandb-summary.json").write_text('{"loss":0.2,"_step":99}')
        import_sources([self.source], self.logs, report=lambda _: None)
        runs, histories = self.snapshot()
        self.assertEqual(runs[0]["summary"], {"loss": 0.2})
        self.assertEqual(histories, [[]])

    def test_reimport_does_not_resurrect_trashed_experiment(self):
        import_sources([self.source], self.logs, report=lambda _: None)
        run_id = self.snapshot()[0][0]["id"]
        set_trashed(self.logs, [run_id])
        counts = import_sources([self.source], self.logs, replace=True, report=lambda _: None)
        self.assertEqual(counts["imported"], 1)
        reader = Reader(self.logs)
        try:
            self.assertEqual(reader.runs(), [])
            self.assertEqual(reader.runs(trashed=True)[0]["id"], run_id)
            self.assertEqual(len(reader.history(run_id)), 2)
        finally:
            reader.close()

    def test_cli_runs_without_wandb_for_jsonl(self):
        result = subprocess.run([sys.executable, "-m", "miniwandb", "import-wandb", str(self.source),
                                 "--dir", str(self.logs)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Imported: 1", result.stdout)


class BinaryImporterTests(unittest.TestCase):
    def test_real_wandb_records(self):
        try:
            DataStore, Record = sdk_types()
        except RuntimeError:
            self.skipTest("optional wandb SDK not installed")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "run-original.wandb"
            store = DataStore()
            store.open_for_write(str(source))
            try:
                record = Record()
                record.run.run_id = "original"
                record.run.entity = "team"
                record.run.project = "RBP"
                record.run.display_name = "中文实验"
                record.run.notes = "original notes"
                record.run.tags.extend(["MP"])
                record.run.start_time.seconds = 1000
                config = record.run.config.update.add()
                config.key = "lr"
                config.value_json = "0.001"
                store.write(record)
                record = Record()
                config = record.config.update.add()
                config.nested_key.extend(["optimizer", "weight_decay"])
                config.value_json = "0.01"
                store.write(record)
                for step, timestamp, value in ((3, 1010, 0.5), (8, 1020, 0.2)):
                    record = Record()
                    for key, val in (("_step", step), ("_timestamp", timestamp), ("train/loss", value)):
                        item = record.history.item.add()
                        item.nested_key.extend([key])
                        item.value_json = json.dumps(val)
                    store.write(record)
                record = Record()
                record.exit.exit_code = 1
                store.write(record)
            finally:
                store.close()
            experiment = read_experiment(source)
            self.assertEqual(experiment.name, "中文实验")
            self.assertEqual(experiment.config, {"lr": 0.001, "optimizer": {"weight_decay": 0.01}})
            self.assertEqual(experiment.status, "failed")
            destination = root / "imported"
            counts = import_sources([source], destination, report=lambda _: None)
            self.assertEqual(counts["imported"], 1)
            reader = Reader(destination)
            try:
                run = reader.runs()[0]
                self.assertEqual(run["project"], "RBP")
                self.assertEqual(run["created_at"], 1000)
                self.assertEqual(run["tags"], ["MP"])
                rows = reader.history(run["id"])
                self.assertEqual([row["step"] for row in rows], [3, 8])
                self.assertEqual([row["timestamp"] for row in rows], [1010, 1020])
            finally:
                reader.close()


if __name__ == "__main__":
    unittest.main()
