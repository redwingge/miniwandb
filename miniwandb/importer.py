"""Read local W&B logs; never log in, sync, or change the original files."""

import csv
import hashlib
import json
import math
import numbers
import time
from dataclasses import dataclass, field
from pathlib import Path

from .storage import connect
from .tracker import dumps, json_value


@dataclass
class Experiment:
    source_id: str = ""
    entity: str = ""
    project: str = "wandb-import"
    name: str = ""
    notes: str = ""
    tags: list = field(default_factory=list)
    config: dict = field(default_factory=dict)
    summary: dict = field(default_factory=dict)
    history: list = field(default_factory=list)
    created_at: float = 0
    status: str = "imported"
    warnings: list = field(default_factory=list)


def sdk_types():
    try:
        from wandb.sdk.internal.datastore import DataStore
        from wandb.proto.wandb_internal_pb2 import Record
    except ImportError as error:
        raise RuntimeError(
            'Reading .wandb requires the optional SDK: python -m pip install "wandb>=0.17,<0.27". '
            'Run this command in the Python environment used for your previous training.'
        ) from error
    return DataStore, Record


def numeric(value):
    return isinstance(value, numbers.Real) and math.isfinite(value)


def scalars(values, prefix=""):
    result = {}
    for key, value in values.items():
        if not isinstance(key, str) or not key or key.startswith("_"):
            continue
        name = prefix + key
        if isinstance(value, dict):
            if "_type" not in value:  # images, tables, histograms are not scalar metrics
                result.update(scalars(value, name + "/"))
        elif value is None or isinstance(value, numbers.Real):
            number = float(value) if value is not None else None
            result[name] = number if number is not None and math.isfinite(number) else None
    return result


def item_path(item):
    return list(item.nested_key) if item.nested_key else [item.key]


def item_value(item):
    # Newer protobuf schemas can store a typed value instead of value_json.
    if "value" in item.DESCRIPTOR.oneofs_by_name:
        kind = item.WhichOneof("value")
        if kind:
            if kind == "none":
                return None
            value = getattr(item, kind)
            return json.loads(value) if kind == "json" else value
    return json.loads(item.value_json)


def apply_update(target, record):
    for removing, items in ((False, record.update), (True, record.remove)):
        for item in items:
            path = item_path(item)
            if not path or not path[0] or path[0].startswith("_"):
                continue
            parent = target
            for key in path[:-1]:
                if key not in parent or not isinstance(parent[key], dict):
                    if removing:
                        parent = None
                        break
                    parent[key] = {}
                parent = parent[key]
            if parent is not None:
                if removing:
                    parent.pop(path[-1], None)
                else:
                    parent[path[-1]] = item_value(item)


def append_history(experiment, row, fallback_step=None):
    if not isinstance(row, dict):
        raise ValueError("History rows must be JSON objects")
    step = row.get("_step", fallback_step)
    if step is None:
        step = experiment.history[-1][0] + 1 if experiment.history else 0
    if isinstance(step, bool) or not numeric(step) or int(step) != step or not 0 <= step <= 2**63 - 2:
        raise ValueError("Invalid history step")
    step = int(step)
    timestamp = row.get("_timestamp")
    if not numeric(timestamp):
        runtime = row.get("_runtime")
        timestamp = experiment.created_at + runtime if experiment.created_at and numeric(runtime) else experiment.created_at
    metrics = scalars(row)
    if metrics:
        experiment.history.append((step, float(timestamp or 0), metrics))


def read_binary(path):
    DataStore, Record = sdk_types()
    experiment = Experiment(status="interrupted")
    store = DataStore()
    try:
        store.open_for_scan(str(path))
        while True:
            data = store.scan_data()
            if data is None:
                break
            record = Record()
            record.ParseFromString(data)
            kind = record.WhichOneof("record_type")
            if kind == "run":
                run = record.run
                experiment.source_id = run.run_id or experiment.source_id
                experiment.entity = run.entity or experiment.entity
                experiment.project = run.project or experiment.project
                experiment.name = run.display_name or experiment.name
                experiment.notes = run.notes or experiment.notes
                experiment.tags = list(run.tags)
                if run.start_time.seconds:
                    experiment.created_at = run.start_time.seconds + run.start_time.nanos / 1e9
                apply_update(experiment.config, run.config)
                apply_update(experiment.summary, run.summary)
            elif kind == "config":
                apply_update(experiment.config, record.config)
            elif kind == "summary":
                apply_update(experiment.summary, record.summary)
            elif kind == "history":
                row = {"/".join(item_path(item)): item_value(item) for item in record.history.item}
                fallback = record.history.step.num if record.history.HasField("step") else None
                append_history(experiment, row, fallback)
            elif kind == "exit" and not getattr(record.exit, "not_complete", False):
                experiment.status = "finished" if record.exit.exit_code == 0 else "failed"
    finally:
        store.close()
    return experiment


def read_text(path):
    experiment = Experiment()
    with path.open(encoding="utf-8-sig", newline="") as stream:
        if path.suffix.lower() == ".csv":
            for row in csv.DictReader(stream):
                values = {}
                for key, value in row.items():
                    if value in ("", None):
                        # Blank fields in a sparse CSV are absent observations.
                        continue
                    if key is None:
                        raise ValueError("CSV row has too many columns")
                    try:
                        values[key] = json.loads(value)
                    except (ValueError, TypeError):
                        values[key] = value
                append_history(experiment, values)
        else:
            for line in stream:
                if line.strip():
                    append_history(experiment, json.loads(line))
    experiment.warnings.append("History export only; original run metadata may be unavailable")
    return experiment


def read_experiment(path):
    path = Path(path).expanduser().resolve()
    experiment = read_binary(path) if path.suffix == ".wandb" else read_text(path)
    if path.suffix == ".wandb":
        experiment.source_id = experiment.source_id or path.stem.removeprefix("run-")
    else:
        experiment.source_id = hashlib.sha256(str(path).encode()).hexdigest()[:16]
    experiment.name = experiment.name or (path.parent.parent.name if path.parent.name == "files" else path.stem)
    # Summary sidecars contain final values, never a reconstructed training curve.
    sidecar = (path.parent / "files" if path.suffix == ".wandb" else path.parent) / "wandb-summary.json"
    if sidecar.is_file():
        try:
            summary = json.loads(sidecar.read_text(encoding="utf-8"))
            if isinstance(summary, dict):
                experiment.summary.update(summary)
        except (OSError, ValueError):
            experiment.warnings.append("Could not read wandb-summary.json; using transaction-log summary")
    timestamps = [timestamp for _, timestamp, _ in experiment.history if timestamp > 0]
    if not experiment.created_at:
        experiment.created_at = min(timestamps) if timestamps else path.stat().st_mtime
    experiment.history = [(step, timestamp or experiment.created_at, metrics)
                          for step, timestamp, metrics in experiment.history]
    if not experiment.history:
        experiment.warnings.append("No scalar history found; this experiment has no curves")
    return experiment


def discover(sources):
    """Prefer .wandb over text history for each run; ignore latest-run symlink aliases."""
    found = set()
    for source in sources:
        path = Path(source).expanduser()
        if not path.exists():
            raise FileNotFoundError("Source does not exist: " + str(path))
        if path.is_file():
            if path.suffix.lower() not in (".wandb", ".jsonl", ".csv"):
                raise ValueError("Expected a .wandb, .jsonl, .csv file or a W&B directory")
            found.add(path.resolve())
            continue
        binary = {p.resolve() for p in path.rglob("*.wandb") if p.is_file()}
        found.update(binary)
        binary_parents = {p.parent for p in binary}
        for history in path.rglob("wandb-history.jsonl"):
            if history.parent.parent.resolve() not in binary_parents and history.parent.resolve() not in binary_parents:
                found.add(history.resolve())
    return sorted(found)


def save_experiment(experiment, directory, source, project=None, replace=False):
    """Import a whole run in one transaction; parsing errors cannot leave partial runs."""
    identity = dumps([experiment.entity, experiment.project, experiment.source_id])
    run_id = "wb-" + hashlib.sha256(identity.encode()).hexdigest()[:24]
    db = connect(directory)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS imports (run_id TEXT PRIMARY KEY REFERENCES runs(id), source TEXT NOT NULL, imported_at REAL NOT NULL)")
        with db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone()
            old_trash = db.execute("SELECT trashed_at FROM trash WHERE run_id=?", (run_id,)).fetchone()
            old_cv = db.execute("SELECT group_id,fold,preferred FROM cv_members WHERE run_id=?", (run_id,)).fetchone()
            old_evaluations = db.execute("SELECT * FROM evaluations WHERE run_id=?", (run_id,)).fetchall()
            old_output = db.execute("SELECT * FROM run_output WHERE run_id=?", (run_id,)).fetchall()
            if existing:
                if not replace:
                    return {"id": run_id, "status": "skipped", "steps": 0, "warnings": []}
                if not db.execute("SELECT run_id FROM imports WHERE run_id=?", (run_id,)).fetchone():
                    raise ValueError("Refusing to replace a run not created by the W&B importer")
                db.execute("DELETE FROM imports WHERE run_id=?", (run_id,))
                db.execute("DELETE FROM metrics WHERE run_id=?", (run_id,))
                db.execute("DELETE FROM runs WHERE id=?", (run_id,))
            latest = {}
            # Duplicate steps are merged; later records win for the same metric.
            for step, timestamp, metrics in sorted(experiment.history, key=lambda row: row[0]):
                latest.update(metrics)
            latest.update(scalars(experiment.summary))
            last_step = max((row[0] for row in experiment.history), default=-1)
            updated = max([experiment.created_at] + [row[1] for row in experiment.history])
            finished = updated if experiment.status in ("finished", "failed") else None
            db.execute(
                "INSERT INTO runs(id,project,name,notes,tags,config,summary,status,created_at,updated_at,finished_at,last_step) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, project or experiment.project, experiment.name, experiment.notes,
                 dumps(experiment.tags), dumps(json_value(experiment.config)), dumps(latest),
                 experiment.status, experiment.created_at, updated, finished, last_step),
            )
            db.executemany(
                "INSERT INTO metrics(run_id,step,key,value,timestamp) VALUES(?,?,?,?,?) "
                "ON CONFLICT(run_id,step,key) DO UPDATE SET value=excluded.value,timestamp=excluded.timestamp",
                ((run_id, step, key, value, timestamp) for step, timestamp, metrics in experiment.history
                 for key, value in metrics.items()),
            )
            db.execute("INSERT INTO imports(run_id,source,imported_at) VALUES(?,?,?)", (run_id, str(source), time.time()))
            if old_evaluations:
                db.executemany("INSERT INTO evaluations VALUES(?,?,?,?,?,?,?)", [tuple(row) for row in old_evaluations])
            if old_output:
                db.executemany("INSERT INTO run_output VALUES(?,?,?,?)", [tuple(row) for row in old_output])
            if old_trash:
                db.execute("INSERT INTO trash(run_id,trashed_at) VALUES(?,?)", (run_id, old_trash[0]))
            if old_cv:
                db.execute("INSERT INTO cv_members VALUES(?,?,?,?)", (run_id, old_cv[0], old_cv[1], old_cv[2]))
            elif not existing:
                from .crossval import register_config_group
                try:
                    register_config_group(db, run_id, project or experiment.project, experiment.name, experiment.config)
                except ValueError:
                    experiment.warnings.append("CV metadata is invalid; imported as an ungrouped experiment")
        return {"id": run_id, "status": "imported", "steps": len({r[0] for r in experiment.history}), "warnings": experiment.warnings}
    finally:
        db.close()


def import_sources(sources, directory=None, project=None, replace=False, limit=None, report=print):
    paths = discover(sources)
    if limit is not None:
        if limit < 1:
            raise ValueError("--limit must be at least 1")
        paths = paths[:limit]
    if not paths:
        raise ValueError("No .wandb files or wandb-history.jsonl files found")
    counts = {"imported": 0, "skipped": 0, "failed": 0}
    for index, path in enumerate(paths, 1):
        report("[%d/%d] Reading %s" % (index, len(paths), path))
        try:
            experiment = read_experiment(path)
            result = save_experiment(experiment, directory, path, project, replace)
            counts[result["status"]] += 1
            report("  %s: %s / %s (%d history steps)" % (result["status"], experiment.project, experiment.name, result["steps"]))
            for warning in result["warnings"]:
                report("  Warning: " + warning)
        except Exception as error:
            counts["failed"] += 1
            report("  Failed: %s: %s" % (type(error).__name__, error))
    return counts
