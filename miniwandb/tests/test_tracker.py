import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import miniwandb as wandb
from miniwandb import Run
from miniwandb.storage import Reader


class Scalar:
    def item(self):
        return 0.25


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name

    def tearDown(self):
        wandb.finish()
        self.temp.cleanup()

    def read(self, run_id):
        reader = Reader(self.directory)
        try:
            return reader.run(run_id), reader.history(run_id)
        finally:
            reader.close()

    def test_persistence_sparse_metrics_and_same_step(self):
        with Run(project="RBP", name="fold-0", notes="中文备注", tags=["MP"],
                 config=Namespace(lr=1e-4, path=Path("data")), dir=self.directory) as run:
            run.log({"train/loss": Scalar(), "nan": math.nan}, step=5)
            run.log({"valid/auroc": 0.9, "train/loss": 0.2}, step=5)
            run.log({"train/loss": 0.1})
            # Read while the writer is still open: every log has already committed.
            record, rows = self.read(run.id)
            self.assertEqual(record["status"], "running")
            self.assertEqual(record["config"], {"lr": 1e-4, "path": "data"})
            self.assertEqual([r["step"] for r in rows], [5, 6])
            self.assertEqual(rows[0]["metrics"], {"nan": None, "train/loss": 0.2, "valid/auroc": 0.9})
            self.assertEqual(record["summary"]["valid/auroc"], 0.9)
        record, _ = self.read(run.id)
        self.assertEqual(record["status"], "finished")
        self.assertIsNotNone(record["finished_at"])

    def test_validation_is_atomic_and_steps_monotonic(self):
        with Run(dir=self.directory) as run:
            run.log({"loss": 1}, step=10)
            for metrics, step, error in [({"loss": 2}, 9, ValueError), ({"loss": 2}, 1.5, ValueError),
                                          ({"loss": 2}, True, ValueError), ({"": 2}, 11, ValueError),
                                          ({"loss": 2, "bad": [1, 2]}, 11, TypeError), ({}, 11, ValueError)]:
                with self.subTest(metrics=metrics, step=step):
                    with self.assertRaises(error):
                        run.log(metrics, step=step)
            self.assertEqual(run.step, 11)
            self.assertEqual(self.read(run.id)[1][0]["metrics"], {"loss": 1.0})
            run.log({"inf": float("inf"), "null": None})
            json.dumps(self.read(run.id), allow_nan=False)
        with self.assertRaises(RuntimeError):
            run.log({"loss": 1})
        run.finish()

    def test_context_records_failure_without_swallowing_error(self):
        with self.assertRaisesRegex(RuntimeError, "training failed"):
            with Run(dir=self.directory) as run:
                run.log({"loss": 1})
                raise RuntimeError("training failed")
        self.assertEqual(self.read(run.id)[0]["status"], "failed")

    def test_resume_and_duplicate_protection(self):
        with Run(project="original", id="fixed", config={"lr": 0.1}, dir=self.directory) as run:
            run.log({"loss": 1}, step=8)
        with self.assertRaises(ValueError):
            Run(id="fixed", dir=self.directory)
        with Run(id="fixed", resume=True, config={"lr": 9}, dir=self.directory) as resumed:
            self.assertEqual(resumed.project, "original")
            self.assertEqual(resumed.step, 9)
            self.assertEqual(resumed.config, {"lr": 0.1})
            config = resumed.config
            config["lr"] = 5
            self.assertEqual(resumed.config["lr"], 0.1)
            resumed.update_config(Namespace(lr=0.05, fold=2))
            resumed.log({"loss": 0.5})
        record, rows = self.read("fixed")
        self.assertEqual(record["config"], {"lr": 0.05, "fold": 2})
        self.assertEqual([row["step"] for row in rows], [8, 9])
        for kwargs in ({"resume": True}, {"resume": True, "id": "missing"}, {"id": "../bad"}):
            with self.assertRaises(ValueError):
                Run(dir=self.directory, **kwargs)

    def test_module_api_accepts_current_training_config(self):
        run = wandb.init(project="RBP", config=Namespace(seed=42), dir=self.directory)
        wandb.log({"train/loss_all": 0.2, "train/lr": 1e-4})
        wandb.log({"valid/auroc_all": Scalar()})
        second = wandb.init(dir=self.directory)
        self.assertEqual(self.read(run.id)[0]["status"], "finished")
        self.assertEqual(wandb.run, second)
        wandb.finish(exit_code=1)
        self.assertEqual(self.read(second.id)[0]["status"], "failed")
        wandb.finish()
        with self.assertRaises(RuntimeError):
            wandb.log({"loss": 1})

    def test_multithread_auto_steps_do_not_collide(self):
        with Run(dir=self.directory) as run:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda n: run.log({"loss": n}), range(40)))
            self.assertEqual(run.step, 40)
        self.assertEqual(len(self.read(run.id)[1]), 40)

    def test_process_guard(self):
        with Run(dir=self.directory) as run:
            with patch("miniwandb.tracker.os.getpid", return_value=os.getpid() + 1):
                with self.assertRaisesRegex(RuntimeError, "another process"):
                    run.log({"loss": 1})

    def test_multiple_processes_write_separate_runs(self):
        script = """import sys
from miniwandb import Run
with Run(id=sys.argv[2], dir=sys.argv[1]) as run:
    for step in range(20):
        run.log({'loss': step})
"""
        processes = [subprocess.Popen([sys.executable, "-c", script, self.directory, "worker-%d" % i],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(3)]
        for proc in processes:
            out, err = proc.communicate(timeout=30)
            self.assertEqual(proc.returncode, 0, out + err)
        for i in range(3):
            record, rows = self.read("worker-%d" % i)
            self.assertEqual(record["status"], "finished")
            self.assertEqual(len(rows), 20)

    def test_dataclass_and_environment_directory(self):
        @dataclass
        class Config:
            lr: float = 0.1
        with patch.dict(os.environ, {"MINIWANDB_DIR": self.directory}):
            with Run(config=Config()) as run:
                self.assertEqual(run.config, {"lr": 0.1})
                self.assertEqual(run.dir, Path(self.directory))


if __name__ == "__main__":
    unittest.main()
