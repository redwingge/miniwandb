import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import miniwandb
from miniwandb import Run
from miniwandb.cleanup import preview_purge, purge_runs
from miniwandb.importer import import_sources
from miniwandb.storage import Reader, set_trashed


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name

    def tearDown(self):
        miniwandb.finish()
        self.temp.cleanup()

    def output(self, run_id, **kwargs):
        reader = Reader(self.directory)
        try:
            return reader.output(run_id, **kwargs)
        finally:
            reader.close()

    def test_capture_tees_both_streams_and_restores_after_finish(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with Run(id="capture", dir=self.directory, capture_output=True) as run:
                print("hello 中文")
                print("progress\rnext", file=sys.stderr)
                self.assertEqual(self.output(run.id)["text"], "hello 中文\nprogress\rnext\n")
                run.log({"loss": 0.5}, step=3)
            self.assertIs(sys.stdout, stdout); self.assertIs(sys.stderr, stderr)
            print("outside")
        self.assertEqual(stdout.getvalue(), "hello 中文\noutside\n")
        self.assertEqual(stderr.getvalue(), "progress\rnext\n")
        self.assertNotIn("outside", self.output(run.id)["text"])

    def test_output_without_capture_keeps_history_and_metadata_unchanged(self):
        with Run(id="manual", dir=self.directory) as run:
            reader = Reader(self.directory)
            before = reader.run(run.id); reader.close()
            run.log_output("<script>not HTML</script>\n")
            reader = Reader(self.directory)
            try:
                self.assertEqual(reader.run(run.id), before)
                self.assertEqual(reader.history(run.id), [])
                self.assertEqual("".join(reader.output_chunks(run.id)), "<script>not HTML</script>\n")
            finally: reader.close()
            self.assertEqual(run.step, 0)
            with self.assertRaises(TypeError): run.log_output(b"bytes")

    def test_bounded_tail_incremental_chunks_and_replacement_reset(self):
        original = "中" * (8192 * 5 + 3)
        with Run(id="large", dir=self.directory) as run: run.log_output(original)
        initial = self.output("large", limit=8192)
        self.assertTrue(initial["truncated"]); self.assertEqual(initial["text"], original[-8192:])
        cursor, result = 0, ""
        while True:
            page = self.output("large", after=cursor, limit=8192)
            result += page["text"]; cursor = page["next"]
            if not page["has_more"]: break
        self.assertEqual(result, original)
        replacement = Path(self.directory) / "output.log"; replacement.write_text("replacement\n")
        miniwandb.attach_output(replacement, run_id="large", dir=self.directory, replace=True)
        page = self.output("large", after=cursor)
        self.assertTrue(page["reset"]); self.assertEqual(page["text"], "replacement\n")
        for kwargs in ({"after":-1},{"limit":1},{"limit":262145}):
            with self.assertRaises(ValueError): self.output("large", **kwargs)

    def test_failure_traceback_and_sequential_runs_do_not_mix(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError,"training error"):
                with Run(id="failed", dir=self.directory, capture_output=True):
                    print("first run")
                    raise RuntimeError("training error")
            with Run(id="second",dir=self.directory,capture_output=True): print("second run")
        failed = self.output("failed")["text"]
        self.assertIn("Traceback",failed); self.assertEqual(failed.count("RuntimeError: training error"),1)
        self.assertNotIn("second run",failed)
        self.assertEqual(self.output("second")["text"],"second run\n")
        reader=Reader(self.directory)
        try: self.assertEqual(reader.run("failed")["status"],"failed")
        finally: reader.close()

    def test_only_one_capture_and_initialization_failure_releases_reservation(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with Run(id="one",dir=self.directory,capture_output=True):
                with self.assertRaises(RuntimeError): Run(id="two",dir=self.directory,capture_output=True)
            with self.assertRaises(ValueError): Run(id="one",dir=self.directory,capture_output=True)
            with Run(id="two",dir=self.directory,capture_output=True): print("ok")
        reader=Reader(self.directory)
        try: self.assertEqual(len(reader.runs()),2)
        finally: reader.close()
        with self.assertRaises(TypeError): Run(dir=self.directory,capture_output="yes")

    def test_module_failure_and_resume_append_output(self):
        with contextlib.redirect_stdout(io.StringIO()):
            miniwandb.init(id="module",dir=self.directory,capture_output=True)
            miniwandb.log_output("manual\n")
            try: raise ValueError("module error")
            except ValueError: miniwandb.finish(exit_code=1)
            with Run(id="module",resume=True,dir=self.directory,capture_output=True): print("resumed")
        text=self.output("module")["text"]
        self.assertIn("manual\n",text); self.assertIn("ValueError: module error",text); self.assertTrue(text.endswith("resumed\n"))

    def test_attach_legacy_output_preserves_status_and_survives_import_trash_restore(self):
        history=Path(self.directory)/"history.jsonl";history.write_text('{"_step":0,"loss":0.2}')
        import_sources([history],self.directory,report=lambda _:None)
        reader=Reader(self.directory);run=reader.runs()[0];reader.close()
        path=Path(self.directory)/"legacy.log";path.write_text("original log\n")
        miniwandb.attach_output(path,run_id=run["id"],dir=self.directory)
        with self.assertRaises(ValueError): miniwandb.attach_output(path,run_id=run["id"],dir=self.directory)
        import_sources([history],self.directory,replace=True,report=lambda _:None)
        self.assertEqual(self.output(run["id"])["text"],"original log\n")
        set_trashed(self.directory,[run["id"]])
        with self.assertRaises(ValueError): miniwandb.attach_output(path,run_id=run["id"],dir=self.directory,replace=True)
        set_trashed(self.directory,[run["id"]],False)
        reader=Reader(self.directory)
        try: self.assertEqual(reader.run(run["id"])["status"],run["status"])
        finally:reader.close()
        set_trashed(self.directory,[run["id"]])
        self.assertEqual(preview_purge(self.directory,[run["id"]])["experiments"][0]["output_characters"],13)
        purge_runs(self.directory,[run["id"]])
        self.assertFalse(self.output(run["id"])["available"])

    @unittest.skipUnless(hasattr(__import__('os'),'fork'),'requires fork')
    def test_forked_child_does_not_use_parent_database_capture(self):
        code='''import os,sys
from miniwandb import Run
with Run(id="fork",dir=sys.argv[1],capture_output=True):
    child=os.fork()
    if child==0:
        print("child",flush=True)
        os._exit(0)
    os.waitpid(child,0)
    print("parent")
'''
        result=subprocess.run([sys.executable,"-c",code,self.directory],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn("child",result.stdout)
        self.assertEqual(self.output("fork")["text"],"parent\n")


if __name__ == "__main__": unittest.main()
