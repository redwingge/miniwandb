"""SQLite storage shared by training processes and the local dashboard."""

import json
import os
import sqlite3
import time
from pathlib import Path


def resolve_dir(directory=None):
    return Path(directory or os.environ.get("MINIWANDB_DIR", "miniwandb_runs")).expanduser().resolve()


def connect(directory):
    directory = resolve_dir(directory)
    directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(directory / "experiments.sqlite3"), timeout=30, check_same_thread=False)
    db.row_factory = sqlite3.Row
    # Two processes can race while switching a new database to WAL. SQLite
    # may report SQLITE_BUSY immediately here despite the connection timeout.
    deadline = time.monotonic() + 30
    while True:
        try:
            db.execute("PRAGMA journal_mode=WAL")
            break
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                db.close()
                raise
            time.sleep(0.05)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            name TEXT NOT NULL,
            notes TEXT NOT NULL,
            tags TEXT NOT NULL,
            config TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            finished_at REAL,
            last_step INTEGER NOT NULL DEFAULT -1
        );
        CREATE TABLE IF NOT EXISTS metrics (
            run_id TEXT NOT NULL REFERENCES runs(id),
            step INTEGER NOT NULL,
            key TEXT NOT NULL,
            value REAL,
            timestamp REAL NOT NULL,
            PRIMARY KEY (run_id, step, key)
        );
        CREATE INDEX IF NOT EXISTS metrics_by_key ON metrics(run_id, key, step);
        CREATE TABLE IF NOT EXISTS trash (
            run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
            trashed_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cv_groups (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            name TEXT NOT NULL,
            n_splits INTEGER NOT NULL,
            origin TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cv_members (
            run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL REFERENCES cv_groups(id) ON DELETE CASCADE,
            fold INTEGER NOT NULL,
            preferred INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS cv_members_by_group ON cv_members(group_id,fold);
        CREATE TABLE IF NOT EXISTS evaluations (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            dataset TEXT NOT NULL,
            name TEXT NOT NULL,
            metrics TEXT NOT NULL,
            metadata TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (run_id,dataset,name)
        );
        CREATE TABLE IF NOT EXISTS run_output (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            timestamp REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS output_by_run ON run_output(run_id,seq);
    """)
    return db


def set_trashed(directory, run_ids, trashed=True):
    """Move an explicit set of experiments to/from trash, atomically."""
    if not isinstance(run_ids, list) or not run_ids or len(run_ids) > 1000:
        raise ValueError("Choose between 1 and 1000 experiment IDs")
    if not all(isinstance(run_id, str) and run_id for run_id in run_ids):
        raise ValueError("Experiment IDs must be non-empty strings")
    run_ids = list(dict.fromkeys(run_ids))
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            for run_id in run_ids:
                if db.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone() is None:
                    raise KeyError(run_id)
            if trashed:
                db.executemany("INSERT OR IGNORE INTO trash(run_id,trashed_at) VALUES(?,?)",
                               [(run_id, time.time()) for run_id in run_ids])
            else:
                db.executemany("DELETE FROM trash WHERE run_id=?", [(run_id,) for run_id in run_ids])
        return len(run_ids)
    finally:
        db.close()


def decode_run(row):
    if row is None:
        return None
    result = dict(row)
    for key in ("tags", "config", "summary"):
        result[key] = json.loads(result[key])
    return result


class Reader:
    """One connection per request. All public reader methods are read-only."""

    def __init__(self, directory):
        path = resolve_dir(directory) / "experiments.sqlite3"
        self.db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def runs(self, trashed=False):
        condition = "IS NOT NULL" if trashed else "IS NULL"
        records = [decode_run(row) for row in self.db.execute(
            "SELECT runs.*,trash.trashed_at FROM runs LEFT JOIN trash ON trash.run_id=runs.id "
            "WHERE trash.run_id " + condition + " ORDER BY created_at DESC, id"
        )]
        members = self._cv_members()
        versions = self._evaluation_versions()
        catalog = self._evaluation_catalog()
        for record in records:
            record["cv"] = members.get(record["id"])
            record["evaluations_updated_at"] = versions.get(record["id"])
            record["evaluation_keys"] = catalog.get(record["id"], [])
        return records

    def _evaluation_catalog(self):
        if not self.db.execute("SELECT name FROM sqlite_master WHERE name='evaluations'").fetchone():
            return {}
        catalog = {}
        for row in self.db.execute("SELECT run_id,dataset,name,metrics FROM evaluations ORDER BY dataset,name"):
            catalog.setdefault(row["run_id"], []).append({"dataset": row["dataset"], "name": row["name"],
                                                         "metrics": sorted(json.loads(row["metrics"]))})
        return catalog

    def _evaluation_versions(self):
        if not self.db.execute("SELECT name FROM sqlite_master WHERE name='evaluations'").fetchone():
            return {}
        return dict(self.db.execute("SELECT run_id,max(updated_at) FROM evaluations GROUP BY run_id"))

    def _cv_members(self):
        # Older databases can still be read before the server's first migration.
        if not self.db.execute("SELECT name FROM sqlite_master WHERE name='cv_members'").fetchone():
            return {}
        return {row["run_id"]: {key: row[key] for key in row.keys() if key != "run_id"} for row in self.db.execute(
            "SELECT m.run_id,m.group_id,m.fold,m.preferred,g.name,g.n_splits,g.project,g.origin,g.created_at AS group_created_at "
            "FROM cv_members m JOIN cv_groups g ON g.id=m.group_id"
        )}

    def run(self, run_id, include_trashed=False):
        condition = "" if include_trashed else " AND trash.run_id IS NULL"
        record = decode_run(self.db.execute(
            "SELECT runs.*,trash.trashed_at FROM runs LEFT JOIN trash ON trash.run_id=runs.id "
            "WHERE runs.id=?" + condition, (run_id,),
        ).fetchone())
        if record is not None:
            record["cv"] = self._cv_members().get(run_id)
            record["evaluations_updated_at"] = self._evaluation_versions().get(run_id)
        return record

    def history(self, run_id):
        rows = []
        for record in self.db.execute(
            "SELECT step,key,value,timestamp FROM metrics WHERE run_id=? ORDER BY step,key",
            (run_id,),
        ):
            if not rows or rows[-1]["step"] != record["step"]:
                rows.append({"step": record["step"], "timestamp": record["timestamp"], "metrics": {}})
            rows[-1]["timestamp"] = max(rows[-1]["timestamp"], record["timestamp"])
            rows[-1]["metrics"][record["key"]] = record["value"]
        return rows

    def evaluations(self, run_id):
        if not self.db.execute("SELECT name FROM sqlite_master WHERE name='evaluations'").fetchone():
            return []
        records = []
        for row in self.db.execute("SELECT * FROM evaluations WHERE run_id=? ORDER BY dataset,name", (run_id,)):
            record = dict(row)
            for key in ("metrics", "metadata"):
                record[key] = json.loads(record[key])
            records.append(record)
        return records

    def output(self, run_id, after=None, limit=131072):
        """A bounded initial tail, then cursor-based incremental text chunks."""
        if after is not None and (not isinstance(after, int) or after < 0):
            raise ValueError("after must be a non-negative integer")
        if not isinstance(limit, int) or not 8192 <= limit <= 262144:
            raise ValueError("limit must be between 8192 and 262144 characters")
        if not self.db.execute("SELECT name FROM sqlite_master WHERE name='run_output'").fetchone():
            return {"text": "", "next": 0, "has_more": False, "available": False, "truncated": False}
        bounds = self.db.execute("SELECT min(seq),max(seq) FROM run_output WHERE run_id=?", (run_id,)).fetchone()
        first, latest = bounds
        if latest is None:
            return {"text": "", "next": 0, "has_more": False, "available": False, "truncated": False}
        if after and first > after:
            return dict(self.output(run_id, limit=limit), reset=True)
        if after is None:
            rows = list(self.db.execute("SELECT seq,text FROM run_output WHERE run_id=? ORDER BY seq DESC LIMIT 200", (run_id,)))
            rows.reverse()
            text = "".join(row["text"] for row in rows)
            return {"text": text[-limit:], "next": latest, "has_more": False, "available": True,
                    "truncated": len(text) > limit or rows[0]["seq"] > first}
        rows, size = [], 0
        for row in self.db.execute("SELECT seq,text FROM run_output WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200", (run_id, after)):
            if rows and size + len(row["text"]) > limit:
                break
            rows.append(row); size += len(row["text"])
        cursor = rows[-1]["seq"] if rows else after
        return {"text": "".join(row["text"] for row in rows), "next": cursor, "has_more": cursor < latest,
                "available": True, "truncated": False}

    def output_chunks(self, run_id):
        if self.db.execute("SELECT name FROM sqlite_master WHERE name='run_output'").fetchone():
            for row in self.db.execute("SELECT text FROM run_output WHERE run_id=? ORDER BY seq", (run_id,)):
                yield row[0]
