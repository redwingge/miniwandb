"""Final dataset scores, separate from step-based training history."""

import math
import numbers
import time
from collections.abc import Mapping

from .storage import Reader, connect
from .tracker import dumps, json_value


def log_evaluation(dataset, metrics, *, run_id, dir=None, name="final", metadata=None, replace=False):
    """Save one checkpoint's scalar scores on a named dataset, even after finish()."""
    for label, value in (("run_id", run_id), ("dataset", dataset), ("name", name)):
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ValueError(label + " must be a non-empty string of at most 500 characters")
    if not isinstance(replace, bool):
        raise TypeError("replace must be a bool")
    if not isinstance(metrics, Mapping) or not metrics or len(metrics) > 1000:
        raise ValueError("metrics must contain 1 to 1000 scalar metrics")
    scores = {}
    for key, value in metrics.items():
        if not isinstance(key, str) or not key.strip() or len(key) > 500:
            raise ValueError("Metric names must be non-empty strings of at most 500 characters")
        if hasattr(value, "item"):
            value = value.item()
        if value is not None and (isinstance(value, bool) or not isinstance(value, numbers.Real)):
            raise TypeError("Final metric %r must be numeric or None" % key)
        value = float(value) if value is not None else None
        scores[key] = value if value is not None and math.isfinite(value) else None
    details = json_value(metadata) if metadata is not None else {}
    if not isinstance(details, dict):
        raise TypeError("metadata must be a mapping")
    encoded = dumps(scores), dumps(details)
    db = connect(dir)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone():
                raise KeyError("Experiment not found: " + run_id)
            if db.execute("SELECT run_id FROM trash WHERE run_id=?", (run_id,)).fetchone():
                raise ValueError("Restore the experiment before adding final evaluations")
            existing = db.execute("SELECT * FROM evaluations WHERE run_id=? AND dataset=? AND name=?",
                                  (run_id, dataset, name)).fetchone()
            if existing:
                import json
                if json.loads(existing["metrics"]) == scores and json.loads(existing["metadata"]) == details:
                    return {"run_id": run_id, "dataset": dataset, "name": name, "status": "unchanged"}
                if not replace:
                    raise ValueError("Evaluation already exists; use replace=True to correct it or another name for another checkpoint")
            now = time.time()
            db.execute("INSERT INTO evaluations VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,dataset,name) "
                       "DO UPDATE SET metrics=excluded.metrics,metadata=excluded.metadata,updated_at=excluded.updated_at",
                       (run_id, dataset, name, *encoded, now, now))
        return {"run_id": run_id, "dataset": dataset, "name": name, "status": "replaced" if existing else "saved"}
    finally:
        db.close()


def comparison(directory, ids, trashed=False):
    if not isinstance(ids, list) or not 1 <= len(ids) <= 1000 or not all(isinstance(i, str) and i for i in ids):
        raise ValueError("请选择 1 到 1000 条实验记录")
    reader = Reader(directory)
    try:
        reader.db.execute("BEGIN")
        runs = reader.runs(trashed=trashed)
        by_id = {run["id"]: run for run in runs}
        if any(run_id not in by_id for run_id in ids):
            raise KeyError("Experiment not found")
        groups, targets = {}, []
        for run_id in dict.fromkeys(ids):
            run = by_id[run_id]
            if run["cv"]:
                groups[run["cv"]["group_id"]] = run["cv"]
            else:
                targets.append({"id": run_id, "name": run["name"], "project": run["project"],
                                "n_splits": 1, "runs": [run]})
        for group_id, group in groups.items():
            members = [run for run in runs if run["cv"] and run["cv"]["group_id"] == group_id]
            chosen = []
            for fold in range(group["n_splits"]):
                completed = [run for run in members if run["cv"]["fold"] == fold and run["status"] == "finished"]
                preferred = [run for run in completed if run["cv"]["preferred"]]
                candidates = preferred or completed
                if candidates:
                    chosen.append(max(candidates, key=lambda run: (run["created_at"], run["id"])))
            targets.append({"id": group_id, "name": group["name"], "project": group["project"],
                            "n_splits": group["n_splits"], "runs": chosen})
        result = []
        for target in targets:
            records = []
            for run in target.pop("runs"):
                for evaluation in reader.evaluations(run["id"]):
                    records.append({**evaluation, "run_name": run["name"], "status": run["status"],
                                    "fold": run["cv"]["fold"] if run["cv"] else None})
            result.append({**target, "records": records})
        return {"models": result}
    finally:
        reader.close()
