import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from miniwandb import Run
from miniwandb.storage import Reader, set_trashed


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name
        with Run(id="keep", dir=self.directory, config={"lr": 0.001}) as run:
            run.log({"loss": 0.5}, step=3)
        with Run(id="remove", dir=self.directory) as run:
            run.log({"loss": 0.2}, step=8)

    def tearDown(self):
        self.temp.cleanup()

    def reader(self):
        return Reader(self.directory)

    def test_trash_and_restore_preserve_all_experiment_data(self):
        reader = self.reader()
        try:
            original = reader.run("remove")
            history = reader.history("remove")
            self.assertEqual(set_trashed(self.directory, ["remove"]), 1)
            self.assertEqual([r["id"] for r in reader.runs()], ["keep"])
            self.assertIsNone(reader.run("remove"))
            self.assertEqual([r["id"] for r in reader.runs(trashed=True)], ["remove"])
            hidden = reader.run("remove", include_trashed=True)
            self.assertIsNotNone(hidden["trashed_at"])
            self.assertEqual(reader.history("remove"), history)
            # Repeated operations are harmless and preserve the original trash timestamp.
            set_trashed(self.directory, ["remove", "remove"])
            self.assertEqual(reader.run("remove", include_trashed=True)["trashed_at"], hidden["trashed_at"])
            set_trashed(self.directory, ["remove"], trashed=False)
            self.assertEqual(reader.run("remove"), original)
            self.assertEqual(reader.history("remove"), history)
            self.assertEqual(reader.runs(trashed=True), [])
        finally:
            reader.close()

    def test_batch_with_missing_id_does_not_change_any_record(self):
        with self.assertRaises(KeyError):
            set_trashed(self.directory, ["keep", "missing"])
        reader = self.reader()
        try:
            self.assertEqual(len(reader.runs()), 2)
            self.assertEqual(reader.runs(trashed=True), [])
        finally:
            reader.close()
        for value in ([], None, "remove", [None], [""], list(range(1001))):
            with self.assertRaises(ValueError):
                set_trashed(self.directory, value)

    def test_trashing_does_not_interrupt_training(self):
        with Run(id="training", dir=self.directory) as run:
            run.log({"loss": 1})
            set_trashed(self.directory, ["training"])
            run.log({"loss": 0.5})
        set_trashed(self.directory, ["training"], trashed=False)
        reader = self.reader()
        try:
            self.assertEqual(reader.run("training")["status"], "finished")
            self.assertEqual(len(reader.history("training")), 2)
        finally:
            reader.close()

    def test_cli_lists_and_restores_explicit_ids(self):
        def command(*args):
            result = subprocess.run([sys.executable, "-m", "miniwandb", *args, "--dir", self.directory],
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        command("trash", "remove")
        self.assertNotIn("remove\t", command("list"))
        self.assertIn("remove\t", command("list", "--trash"))
        command("restore", "remove")
        self.assertIn("remove\t", command("list"))


if __name__ == "__main__":
    unittest.main()
