import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from miniwandb import Run
from miniwandb.cleanup import PurgeConflict, compact, preview_purge, purge_runs
from miniwandb.importer import import_sources
from miniwandb.storage import Reader, connect, set_trashed


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directory = self.root / "records"
        self.run_dir = self.root / "wandb/run-20260101_000000-abc"
        (self.run_dir / "files").mkdir(parents=True)
        self.source = self.run_dir / "files/wandb-history.jsonl"
        self.source.write_text('{"_step":2,"loss":0.5}\n{"_step":8,"loss":0.2}\n')
        import_sources([self.source], self.directory, report=lambda _: None)
        reader = Reader(self.directory)
        self.run_id = reader.runs()[0]["id"]
        reader.close()
        with Run(id="keep", dir=self.directory) as run:
            run.log({"loss": 9})
        set_trashed(self.directory, [self.run_id])

    def tearDown(self):
        self.temp.cleanup()

    def test_permanent_delete_removes_sql_records_and_preserves_sources_by_default(self):
        plan = preview_purge(self.directory, [self.run_id])["experiments"]
        self.assertEqual(plan[0]["target"], str(self.run_dir))
        self.assertEqual(plan[0]["metrics"], 2)
        result = purge_runs(self.directory, [self.run_id])
        self.assertEqual(result["deleted"], 1)
        self.assertTrue(self.source.is_file())
        db = connect(self.directory)
        try:
            for table, key in (("runs", "id"), ("metrics", "run_id"), ("trash", "run_id"), ("imports", "run_id")):
                self.assertEqual(db.execute("SELECT COUNT(*) FROM %s WHERE %s=?" % (table, key), (self.run_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM metrics WHERE run_id='keep'").fetchone()[0], 1)
        finally:
            db.close()

    def test_optional_source_directory_deletion_never_follows_attachment_symlinks(self):
        model = self.root / "model.pt"
        model.write_bytes(b"model outside experiment")
        (self.run_dir / "files/model.pt").symlink_to(model)
        other = self.root / "wandb/run-20260102_000000-other"
        other.mkdir()
        (other / "log.txt").write_text("unselected")
        result = purge_runs(self.directory, [self.run_id], delete_sources=True)
        self.assertEqual(result["source_paths"], [str(self.run_dir)])
        self.assertFalse(self.run_dir.exists())
        self.assertEqual(model.read_bytes(), b"model outside experiment")
        self.assertTrue((other / "log.txt").is_file())

    def test_nontrash_or_missing_id_rejects_whole_batch_before_deleting_files(self):
        with self.assertRaises(PurgeConflict):
            purge_runs(self.directory, [self.run_id, "keep"], True)
        with self.assertRaises(KeyError):
            purge_runs(self.directory, [self.run_id, "missing"], True)
        self.assertTrue(self.source.is_file())
        reader = Reader(self.directory)
        try:
            self.assertEqual(len(reader.runs(trashed=True)), 1)
        finally:
            reader.close()

    def test_shared_sources_and_changed_symlink_paths_are_rejected(self):
        db = connect(self.directory)
        with db:
            db.execute("INSERT INTO imports(run_id,source,imported_at) VALUES('keep',?,0)", (str(self.source),))
        db.close()
        with self.assertRaisesRegex(PurgeConflict, "其他实验引用"):
            purge_runs(self.directory, [self.run_id], True)
        self.assertTrue(self.source.is_file())
        db = connect(self.directory)
        with db:
            db.execute("DELETE FROM imports WHERE run_id='keep'")
        db.close()
        moved = self.root / "moved"
        self.run_dir.rename(moved)
        self.run_dir.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(PurgeConflict, "符号链接"):
            purge_runs(self.directory, [self.run_id], True)
        self.assertTrue((moved / "files/wandb-history.jsonl").is_file())

    def test_source_cleanup_failure_preserves_database_for_retry(self):
        with patch("miniwandb.cleanup.shutil.rmtree", side_effect=OSError("permission denied")):
            with self.assertRaises(OSError):
                purge_runs(self.directory, [self.run_id], True)
        reader = Reader(self.directory)
        try:
            self.assertEqual(len(reader.history(self.run_id)), 2)
            self.assertEqual(len(reader.runs(trashed=True)), 1)
        finally:
            reader.close()
        purge_runs(self.directory, [self.run_id], True)
        self.assertFalse(self.run_dir.exists())

    def test_generic_history_file_deletion_preserves_its_parent_directory(self):
        source = self.root / "exports/history.csv"
        source.parent.mkdir()
        source.write_text('_step,loss\n0,0.1\n')
        other = source.parent / "unrelated.txt"
        other.write_text("preserve")
        import_sources([source], self.directory, report=lambda _: None)
        reader = Reader(self.directory)
        try:
            run_id = next(run["id"] for run in reader.runs() if run["name"] == "history")
        finally:
            reader.close()
        set_trashed(self.directory, [run_id])
        purge_runs(self.directory, [run_id], True)
        self.assertFalse(source.exists())
        self.assertTrue(other.is_file())

    def test_active_training_cannot_be_purged_or_compacted(self):
        with Run(id="training", dir=self.directory) as run:
            run.log({"loss": 1})
            set_trashed(self.directory, [run.id])
            with self.assertRaises(PurgeConflict):
                purge_runs(self.directory, [run.id])
            with self.assertRaises(PurgeConflict):
                compact(self.directory)
            run.log({"loss": 0.5})

    def test_compaction_reclaims_space_and_preserves_unselected_history(self):
        db = connect(self.directory)
        with db:
            db.executemany("INSERT INTO metrics(run_id,step,key,value,timestamp) VALUES(?,?,?,?,?)",
                           [(self.run_id, step, "long_metric_name_for_storage", 1.0, 1000) for step in range(10000)])
        db.close()
        purge_runs(self.directory, [self.run_id])
        result = compact(self.directory)
        self.assertLess(result["after_bytes"], result["before_bytes"])
        reader = Reader(self.directory)
        try:
            self.assertEqual(reader.history("keep")[0]["metrics"], {"loss": 9})
        finally:
            reader.close()

    def test_cli_previews_without_yes_and_requires_explicit_source_option(self):
        def command(*args):
            result = subprocess.run([sys.executable, "-m", "miniwandb", "purge", *args, "--dir", str(self.directory)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        self.assertIn("Preview only", command(self.run_id, "--delete-sources"))
        self.assertTrue(self.source.is_file())
        self.assertIn("Permanently deleted: 1", command("--all-trash", "--yes"))
        self.assertTrue(self.source.is_file())


if __name__ == "__main__":
    unittest.main()
