"""Durable scalar logging, with no imports from ML frameworks."""

import dataclasses
import json
import math
import numbers
import os
import re
import sys
import threading
import time
import traceback
import uuid
from collections.abc import Mapping
from pathlib import Path

from .storage import connect, decode_run, resolve_dir


def json_value(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return json_value(dataclasses.asdict(value))
    if isinstance(value, Mapping):
        return {str(k): json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(v) for v in value]
    if hasattr(value, "item"):
        return json_value(value.item())
    if hasattr(value, "__dict__"):
        return json_value(vars(value))
    raise TypeError("Config value is not JSON serializable: " + type(value).__name__)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class Run:
    """An independent experiment. Use a context manager to record failures."""

    def __init__(self, project="default", name=None, config=None, notes="", tags=None,
                 dir=None, id=None, resume=False, capture_output=False):
        if not isinstance(project, str) or not project.strip():
            raise ValueError("project must be a non-empty string")
        if name is not None and not isinstance(name, str):
            raise TypeError("name must be a string")
        if not isinstance(notes, str):
            raise TypeError("notes must be a string")
        if tags is not None and (not isinstance(tags, (list, tuple)) or not all(isinstance(t, str) for t in tags)):
            raise TypeError("tags must be a list of strings")
        if id is not None and (not isinstance(id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", id)):
            raise ValueError("id must contain 1-128 letters, digits, underscores or hyphens")
        if resume and id is None:
            raise ValueError("resume=True requires an explicit id")
        if not isinstance(capture_output, bool):
            raise TypeError("capture_output must be a bool")
        prepared_config = json_value(config) if config is not None else {}
        if not isinstance(prepared_config, dict):
            raise TypeError("config must be a mapping, Namespace, or dataclass")
        self.dir = resolve_dir(dir)
        self.id = id if id is not None else uuid.uuid4().hex[:12]
        self._pid = os.getpid()
        self._lock = threading.RLock()
        self._closed = False
        self._capture = None
        self._db = None
        now = time.time()
        try:
            if capture_output:
                from .output import OutputCapture
                self._capture = OutputCapture(self)
            self._db = connect(self.dir)
            with self._db:
                row = self._db.execute("SELECT * FROM runs WHERE id=?", (self.id,)).fetchone()
                if resume:
                    if row is None:
                        raise ValueError("Cannot resume missing run: " + self.id)
                    # Resumption retains the original project, name, notes, tags and config.
                    self._db.execute(
                        "UPDATE runs SET status='running',finished_at=NULL,updated_at=? WHERE id=?",
                        (now, self.id),
                    )
                else:
                    if row is not None:
                        raise ValueError("Run id already exists; use resume=True: " + self.id)
                    self._db.execute(
                        "INSERT INTO runs(id,project,name,notes,tags,config,status,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,'running',?,?)",
                        (self.id, project, name or self.id, notes, dumps(list(tags or [])),
                         dumps(prepared_config), now, now),
                    )
                    from .crossval import register_config_group
                    register_config_group(self._db, self.id, project, name or self.id, prepared_config)
                record = decode_run(self._db.execute("SELECT * FROM runs WHERE id=?", (self.id,)).fetchone())
            self.project = record["project"]
            self.name = record["name"]
            self._config = record["config"]
            self._summary = record["summary"]
            self._last_step = record["last_step"]
            if self._capture:
                self._capture.start()
        except BaseException:
            if self._capture:
                self._capture.stop()
            if self._db:
                self._db.close()
            raise

    @property
    def config(self):
        """Return a copy; persist edits with update_config()."""
        return json.loads(dumps(self._config))

    @property
    def summary(self):
        return dict(self._summary)

    @property
    def step(self):
        """The next automatic step (first step is zero)."""
        return self._last_step + 1

    def _check(self):
        if os.getpid() != self._pid:
            raise RuntimeError("Run belongs to another process; log only from the main/rank-0 process")
        if self._closed:
            raise RuntimeError("Run is finished")

    def log(self, data, step=None):
        if not isinstance(data, Mapping) or not data:
            raise ValueError("log expects a non-empty mapping of scalar metrics")
        metrics = {}
        for key, value in data.items():
            if not isinstance(key, str) or not key:
                raise ValueError("Metric names must be non-empty strings")
            if hasattr(value, "item"):
                value = value.item()
            if value is not None and not isinstance(value, numbers.Real):
                raise TypeError("Metric %r must be numeric or None" % key)
            numeric = float(value) if value is not None else None
            metrics[key] = numeric if numeric is not None and math.isfinite(numeric) else None
        with self._lock:
            self._check()
            if step is None:
                step = self._last_step + 1
            if isinstance(step, bool) or not isinstance(step, numbers.Integral) or not 0 <= step <= 2**63 - 2:
                raise ValueError("step must be a non-negative SQLite-sized integer")
            step = int(step)
            if step < self._last_step:
                raise ValueError("step must not go backwards (last step: %d)" % self._last_step)
            now = time.time()
            summary = dict(self._summary, **metrics)
            with self._db:
                self._db.executemany(
                    "INSERT INTO metrics(run_id,step,key,value,timestamp) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(run_id,step,key) DO UPDATE SET value=excluded.value,timestamp=excluded.timestamp",
                    [(self.id, step, key, value, now) for key, value in metrics.items()],
                )
                self._db.execute("UPDATE runs SET summary=?,last_step=?,updated_at=? WHERE id=?",
                                 (dumps(summary), step, now, self.id))
            self._summary = summary
            self._last_step = step

    def update_config(self, values):
        values = json_value(values)
        if not isinstance(values, dict):
            raise TypeError("Config updates must be a mapping")
        with self._lock:
            self._check()
            config = dict(self._config, **values)
            with self._db:
                self._db.execute("UPDATE runs SET config=?,updated_at=? WHERE id=?",
                                 (dumps(config), time.time(), self.id))
                if {"cv_id", "cv_name", "fold", "n_splits"}.intersection(values):
                    from .crossval import register_config_group
                    register_config_group(self._db, self.id, self.project, self.name, config)
            self._config = config

    def log_evaluation(self, dataset, metrics, *, name="final", metadata=None, replace=False):
        """Record final dataset scores without advancing the training step."""
        with self._lock:
            self._check()
            from .evaluation import log_evaluation
            return log_evaluation(dataset, metrics, run_id=self.id, dir=self.dir,
                                  name=name, metadata=metadata, replace=replace)

    def log_output(self, text):
        """Append text without advancing step or invalidating training history."""
        if not isinstance(text, str):
            raise TypeError("log_output expects text")
        with self._lock:
            self._check()
            if text:
                with self._db:
                    self._db.executemany("INSERT INTO run_output(run_id,text,timestamp) VALUES(?,?,?)",
                                         ((self.id, text[start:start + 8192], time.time()) for start in range(0, len(text), 8192)))

    def finish(self, exit_code=0):
        with self._lock:
            if self._closed:
                return
            self._check()
            now = time.time()
            try:
                if exit_code != 0 and self._capture and sys.exc_info()[0] is not None:
                    self.log_output("".join(traceback.format_exception(*sys.exc_info())))
                with self._db:
                    self._db.execute("UPDATE runs SET status=?,finished_at=?,updated_at=? WHERE id=?",
                                     ("finished" if exit_code == 0 else "failed", now, now, self.id))
            finally:
                if self._capture:
                    self._capture.stop()
                self._db.close()
                self._closed = True

    def __enter__(self):
        self._check()
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.finish(exit_code=0 if exc_type is None else 1)
        return False
