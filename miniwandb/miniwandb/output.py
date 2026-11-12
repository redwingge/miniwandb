"""Opt-in Python stream mirroring and explicit attachment of existing logs."""

import os
import sys
import threading
import time
from pathlib import Path

from .storage import connect

_lock = threading.RLock()
_active = None


class Tee:
    def __init__(self, original, capture):
        self.original = original
        self.capture = capture

    def write(self, text):
        if os.getpid() != self.capture.pid:
            return self.original.write(text)
        with self.capture.run._lock:
            result = self.original.write(text)
            if text and not self.capture.closed and not self.capture.run._closed:
                self.capture.run.log_output(text)
        return len(text) if result is None else result

    def flush(self):
        self.original.flush()

    def __getattr__(self, name):
        return getattr(self.original, name)


class OutputCapture:
    def __init__(self, run):
        global _active
        self.run, self.pid, self.closed = run, os.getpid(), False
        self.stdout = self.stderr = None
        with _lock:
            if _active is not None and _active.pid == self.pid and not _active.closed:
                raise RuntimeError("Only one run may capture Python output per process; finish it first")
            _active = self

    def start(self):
        self.stdout, self.stderr = Tee(sys.stdout, self), Tee(sys.stderr, self)
        sys.stdout, sys.stderr = self.stdout, self.stderr

    def stop(self):
        global _active
        with _lock:
            self.closed = True
            if self.stdout is not None and sys.stdout is self.stdout:
                sys.stdout = self.stdout.original
            if self.stderr is not None and sys.stderr is self.stderr:
                sys.stderr = self.stderr.original
            if _active is self:
                _active = None


def attach_output(path, *, run_id, dir=None, replace=False):
    """Attach a UTF-8 text file to an existing, non-running experiment atomically."""
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run_id must be a non-empty string")
    if not isinstance(replace, bool):
        raise TypeError("replace must be a bool")
    with Path(path).expanduser().open(encoding="utf-8", errors="replace", newline="") as source:
        db = connect(dir)
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                run = db.execute("SELECT status FROM runs WHERE id=?", (run_id,)).fetchone()
                if run is None:
                    raise KeyError(run_id)
                if run[0] == "running":
                    raise ValueError("Finish the experiment before attaching a log file")
                if db.execute("SELECT 1 FROM trash WHERE run_id=?", (run_id,)).fetchone():
                    raise ValueError("Restore the experiment before attaching output")
                if db.execute("SELECT 1 FROM run_output WHERE run_id=? LIMIT 1", (run_id,)).fetchone() and not replace:
                    raise ValueError("Output already exists; use replace=True to replace it")
                if replace:
                    db.execute("DELETE FROM run_output WHERE run_id=?", (run_id,))
                count = 0
                for text in iter(lambda: source.read(8192), ""):
                    db.execute("INSERT INTO run_output(run_id,text,timestamp) VALUES(?,?,?)", (run_id, text, time.time()))
                    count += len(text)
            return {"run_id": run_id, "characters": count}
        finally:
            db.close()
