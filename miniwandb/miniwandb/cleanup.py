"""Explicit permanent deletion of trashed runs and optional imported source logs."""

import re
import shutil
from pathlib import Path

from .storage import connect, resolve_dir


class PurgeConflict(ValueError):
    pass


def inside(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def source_target(source, directory):
    """Only recognized W&B run directories or the exact imported history file."""
    path = Path(source)
    if not path.is_absolute() or path != path.resolve():
        raise PurgeConflict("来源路径已变更或包含符号链接，不能自动删除")
    if path.suffix.lower() not in (".wandb", ".jsonl", ".csv"):
        raise PurgeConflict("仅支持删除导入时记录的 .wandb / JSONL / CSV 来源")
    run_dir = path.parent
    if path.name == "wandb-history.jsonl" and path.parent.name == "files":
        run_dir = path.parent.parent
    match = re.fullmatch(r"(?:offline-)?run-\d{8}_\d{6}-([A-Za-z0-9_-]+)", run_dir.name)
    recognized = match and (path.name == "run-%s.wandb" % match.group(1)
                            or (path.name == "wandb-history.jsonl" and path.parent.name == "files"))
    target = run_dir if recognized else path
    if target.is_symlink() or target != target.resolve():
        raise PurgeConflict("来源目录已变更或包含符号链接，不能自动删除")
    if inside(resolve_dir(directory), target):
        raise PurgeConflict("不能删除包含 MiniWandb 数据库的目录")
    if target.exists() and (target.is_dir() != bool(recognized)):
        raise PurgeConflict("来源文件类型已变更，不能自动删除")
    return target, "directory" if recognized else "file"


def _plan(db, directory, ids):
    if not isinstance(ids, list) or not ids or len(ids) > 1000:
        raise ValueError("请选择 1 到 1000 个回收站实验")
    if not all(isinstance(run_id, str) and run_id for run_id in ids):
        raise ValueError("实验 ID 必须是非空字符串")
    ids = list(dict.fromkeys(ids))
    has_imports = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='imports'").fetchone()
    imports = [dict(row) for row in db.execute("SELECT run_id,source FROM imports")] if has_imports else []
    sources = {row["run_id"]: row["source"] for row in imports}
    entries = []
    for run_id in ids:
        row = db.execute("SELECT runs.id,runs.name,runs.project,runs.status,trash.trashed_at FROM runs "
                         "LEFT JOIN trash ON trash.run_id=runs.id WHERE runs.id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        if row["trashed_at"] is None:
            raise PurgeConflict("只能永久删除回收站中的实验；请先移入回收站")
        if row["status"] == "running":
            raise PurgeConflict("运行中的实验不能永久删除；请先结束对应训练")
        entry = dict(row)
        entry["metrics"] = db.execute("SELECT COUNT(*) FROM metrics WHERE run_id=?", (run_id,)).fetchone()[0]
        entry["evaluations"] = db.execute("SELECT COUNT(*) FROM evaluations WHERE run_id=?", (run_id,)).fetchone()[0]
        entry["output_characters"] = db.execute("SELECT coalesce(sum(length(text)),0) FROM run_output WHERE run_id=?", (run_id,)).fetchone()[0]
        entry.update(source=sources.get(run_id), target=None, kind=None, source_exists=False, source_error=None)
        if entry["source"]:
            try:
                target, kind = source_target(entry["source"], directory)
                for other in imports:
                    if other["run_id"] not in ids and inside(Path(other["source"]).resolve(), target):
                        raise PurgeConflict("该来源还被其他实验引用，不能单独删除来源文件")
                entry.update(target=str(target), kind=kind, source_exists=target.exists())
            except (OSError, ValueError) as error:
                entry["source_error"] = str(error)
        entries.append(entry)
    return entries


def preview_purge(directory, ids):
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN")
            return {"experiments": _plan(db, directory, ids)}
    finally:
        db.close()


def purge_runs(directory, ids, delete_sources=False):
    if not isinstance(delete_sources, bool):
        raise ValueError("delete_sources 必须是布尔值")
    db = connect(directory)
    removed = []
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            entries = _plan(db, directory, ids)
            targets = {}
            if delete_sources:
                for entry in entries:
                    if entry["source_error"]:
                        raise PurgeConflict(entry["source_error"])
                    if entry["target"]:
                        targets[Path(entry["target"])] = entry["kind"]
                # Collapse files covered by a selected run directory.
                targets = {path: kind for path, kind in targets.items() if not any(
                    other != path and other_kind == "directory" and inside(path, other)
                    for other, other_kind in targets.items()
                )}
                for path, kind in targets.items():
                    # Revalidate immediately before filesystem changes. rmtree does
                    # not follow symlinks inside the selected experiment directory.
                    if path.is_symlink() or path != path.resolve():
                        raise PurgeConflict("来源路径已变更，未执行数据库删除")
                    if not path.exists():
                        continue
                    if kind == "directory":
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                    removed.append(str(path))
            keys = [(entry["id"],) for entry in entries]
            if db.execute("SELECT name FROM sqlite_master WHERE name='imports'").fetchone():
                db.executemany("DELETE FROM imports WHERE run_id=?", keys)
            db.executemany("DELETE FROM metrics WHERE run_id=?", keys)
            db.executemany("DELETE FROM trash WHERE run_id=?", keys)
            db.executemany("DELETE FROM runs WHERE id=?", keys)
            db.execute("DELETE FROM cv_groups WHERE NOT EXISTS (SELECT 1 FROM cv_members WHERE cv_members.group_id=cv_groups.id)")
        return {"deleted": len(entries), "metrics": sum(entry["metrics"] for entry in entries), "source_paths": removed}
    finally:
        db.close()


def compact(directory):
    """Return unused SQLite pages to disk. Use after training has stopped."""
    db = connect(directory)
    path = resolve_dir(directory) / "experiments.sqlite3"
    try:
        if db.execute("SELECT 1 FROM runs WHERE status='running' LIMIT 1").fetchone():
            raise PurgeConflict("请先结束训练，再回收数据库占用空间")
        before = sum(p.stat().st_size for p in (path, Path(str(path) + "-wal")) if p.exists())
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("VACUUM")
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        after = sum(p.stat().st_size for p in (path, Path(str(path) + "-wal")) if p.exists())
        return {"before_bytes": before, "after_bytes": after}
    finally:
        db.close()
