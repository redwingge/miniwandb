"""Cross-validation membership, reviewed legacy grouping and descriptive statistics."""

import hashlib
import json
import math
import numbers
import re
import statistics
import time
import uuid

from .storage import connect, decode_run


VOLATILE = {"fold", "fold_index", "kfold_set", "cv_id", "cv_name", "start_k", "k",
            "wandb_note", "wandb_run_name", "run_name", "model_dir", "data_size", "threshold"}


def normalized_config(config):
    result = {key: value for key, value in config.items() if key not in VOLATILE and not key.startswith("_")}
    if isinstance(result.get("model_type"), str):
        result["model_type"] = re.sub(r"^\d+_(\d+fold)", r"{fold}_\1", result["model_type"])
    return result


def valid_integer(value, minimum=0, maximum=99):
    return not isinstance(value, bool) and isinstance(value, numbers.Real) and math.isfinite(value) and int(value) == value and minimum <= value <= maximum


def register_config_group(db, run_id, project, name, config):
    """Called in the writer's transaction only for new runs or explicit CV updates."""
    external = config.get("cv_id")
    if external is None:
        return
    if not isinstance(external, str) or not external.strip():
        raise ValueError("cv_id must be a non-empty string")
    fold, splits = config.get("fold"), config.get("n_splits")
    if not valid_integer(splits, 2, 100) or not valid_integer(fold, 0, int(splits) - 1):
        raise ValueError("CV config requires n_splits >= 2 and 0 <= fold < n_splits")
    group_id = "cv-" + hashlib.sha256(json.dumps([project, external], ensure_ascii=False).encode()).hexdigest()[:24]
    group_name = config.get("cv_name") or re.sub(r"[_ -]*fold[_ -]*\d+$", "", name, flags=re.I) or name
    if not isinstance(group_name, str) or not group_name.strip():
        raise ValueError("cv_name must be a string")
    previous = db.execute("SELECT n_splits FROM cv_groups WHERE id=?", (group_id,)).fetchone()
    if previous and previous[0] != splits:
        raise ValueError("The same cv_id must use the same n_splits")
    db.execute("INSERT OR IGNORE INTO cv_groups(id,project,name,n_splits,origin,created_at) VALUES(?,?,?,?,'config',?)",
               (group_id, project, group_name, int(splits), time.time()))
    db.execute("INSERT INTO cv_members(run_id,group_id,fold,preferred) VALUES(?,?,?,0) "
               "ON CONFLICT(run_id) DO UPDATE SET preferred=CASE WHEN cv_members.group_id=excluded.group_id AND cv_members.fold=excluded.fold THEN cv_members.preferred ELSE 0 END,group_id=excluded.group_id,fold=excluded.fold",
               (run_id, group_id, int(fold)))


def checked_runs(db, ids):
    if not isinstance(ids, list) or not ids or len(ids) > 1000 or not all(isinstance(value, str) and value for value in ids):
        raise ValueError("请选择 1 到 1000 条实验记录")
    records = []
    for run_id in dict.fromkeys(ids):
        row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        records.append(decode_run(row))
    return records


def infer_fold(run):
    config = run["config"]
    folds, splits, warnings = [], [], []
    for key in ("fold", "fold_index", "kfold_set"):
        if key in config and valid_integer(config[key]):
            folds.append((key, int(config[key])))
    if valid_integer(config.get("n_splits"), 2, 100):
        splits.append(int(config["n_splits"]))
    model = str(config.get("model_type", ""))
    match = re.search(r"(?:^|_)(\d+)_(\d+)fold(?:_|$)", model, re.I)
    if match:
        folds.append(("model_type", int(match[1]))); splits.append(int(match[2]))
    match = re.search(r"(?:^|[_ -])fold[_ -]*(\d+)(?:$|[_ -])", run["name"], re.I)
    if match:
        folds.append(("名称", int(match[1])))
    else:
        match = re.search(r"_(\d+)_(\d+)fold(?:_|$)", run["name"], re.I)
        if match:
            folds.append(("名称", int(match[1]))); splits.append(int(match[2]))
    if len(set(splits)) > 1:
        warnings.append("总折数信息不一致")
    n_splits = splits[0] if splits else 5
    if not splits:
        warnings.append("未记录总折数，暂按 5 折预览")
    values = {value for _, value in folds}
    fold = next(iter(values)) if len(values) == 1 else None
    conflict = len(values) > 1 or len(set(splits)) > 1
    if conflict:
        warnings.append("fold 信息冲突：" + "、".join("%s=%s" % item for item in folds))
    if fold is None or not 0 <= fold < n_splits:
        warnings.append("无法确定 0 起始的 fold 编号，请手动指定")
        fold = None
    return {"fold": fold, "n_splits": n_splits, "warnings": warnings, "conflict": conflict}


def _assign(db, ids, folds, name, splits, group_id=None, allow_move=False, origin="manual"):
    records = checked_runs(db, ids)
    if not isinstance(name, str) or not name.strip() or len(name) > 250:
        raise ValueError("请输入不超过 250 字的组名")
    if not valid_integer(splits, 2, 100):
        raise ValueError("总折数须为 2 到 100 的整数")
    if not isinstance(folds, dict):
        raise ValueError("请为每条实验指定 fold")
    projects = {run["project"] for run in records}
    if len(projects) != 1:
        raise ValueError("同一个 CV 组内的记录须属于同一项目；不同项目可在组间比较")
    project = next(iter(projects))
    if group_id:
        group = db.execute("SELECT * FROM cv_groups WHERE id=?", (group_id,)).fetchone()
        if group is None:
            raise KeyError(group_id)
        if group["project"] != project or group["n_splits"] != splits:
            raise ValueError("目标组的项目和总折数必须一致")
    for run in records:
        if not valid_integer(folds.get(run["id"]), 0, int(splits) - 1):
            raise ValueError("每条记录都需要指定 0 到 %d 的 fold" % (splits - 1))
        previous = db.execute("SELECT group_id FROM cv_members WHERE run_id=?", (run["id"],)).fetchone()
        if previous and previous[0] != group_id and not allow_move:
            raise ValueError("部分实验已有分组；请确认允许移动后重试")
    if not group_id:
        group_id = "cv-" + uuid.uuid4().hex[:24]
        db.execute("INSERT INTO cv_groups VALUES(?,?,?,?,?,?)", (group_id, project, name.strip(), int(splits), origin, time.time()))
    for run in records:
        db.execute("INSERT INTO cv_members(run_id,group_id,fold,preferred) VALUES(?,?,?,0) "
                   "ON CONFLICT(run_id) DO UPDATE SET preferred=CASE WHEN cv_members.group_id=excluded.group_id AND cv_members.fold=excluded.fold THEN cv_members.preferred ELSE 0 END,group_id=excluded.group_id,fold=excluded.fold",
                   (run["id"], group_id, int(folds[run["id"]])))
    return group_id


def assign_group(directory, ids, folds, name, n_splits, group_id=None, allow_move=False):
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            result = _assign(db, ids, folds, name, n_splits, group_id, allow_move)
        return {"group_id": result, "updated": len(set(ids))}
    finally:
        db.close()


def _preview(db, ids):
    candidates, existing = {}, []
    for run in checked_runs(db, ids):
        member = db.execute("SELECT m.group_id,m.fold,g.n_splits FROM cv_members m JOIN cv_groups g ON g.id=m.group_id WHERE m.run_id=?", (run["id"],)).fetchone()
        info = infer_fold(run)
        if member:
            info["fold"], info["n_splits"] = member["fold"], member["n_splits"]
        existing.append({"id": run["id"], "name": run["name"], "project": run["project"], "created_at": run["created_at"],
                         "group_id": member[0] if member else None, **info})
        if member:
            continue
        base = run["config"].get("wandb_run_name") or run["config"].get("run_name") or run["name"]
        base = re.sub(r"[_ -]*fold[_ -]*\d+(?=$|[_ -])", "", str(base), flags=re.I)
        base = re.sub(r"_\d+_\d+fold(?=_|$)", "", base, flags=re.I).strip("_ -") or run["name"]
        identity = json.dumps([run["project"], base, normalized_config(run["config"]), info["n_splits"]], sort_keys=True, ensure_ascii=False)
        candidate_id = hashlib.sha256(identity.encode()).hexdigest()[:24]
        candidate = candidates.setdefault(candidate_id, {"id": candidate_id, "name": base, "project": run["project"],
                "n_splits": info["n_splits"], "runs": [], "warnings": [], "blocked": False, "config": normalized_config(run["config"])})
        candidate["runs"].append({"id": run["id"], "name": run["name"], "fold": info["fold"], "created_at": run["created_at"]})
        candidate["warnings"].extend(info["warnings"])
        candidate["blocked"] |= info["fold"] is None or info["conflict"]
    for candidate in candidates.values():
        folds = [run["fold"] for run in candidate["runs"] if run["fold"] is not None]
        if len(folds) != len(set(folds)):
            candidate["warnings"].append("同一 fold 有多次记录，可能是重跑或多轮 CV，请改用手动归组")
            candidate["blocked"] = True
        candidate["warnings"] = list(dict.fromkeys(candidate["warnings"]))
    return {"runs": existing, "candidates": list(candidates.values())}


def preview_groups(directory, ids):
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN")
            return _preview(db, ids)
    finally:
        db.close()


def apply_candidates(directory, ids, candidate_ids):
    if not isinstance(candidate_ids, list) or not candidate_ids:
        raise ValueError("请勾选要确认的候选组")
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            preview = _preview(db, ids)
            chosen = {candidate["id"]: candidate for candidate in preview["candidates"]}
            groups = []
            for candidate_id in dict.fromkeys(candidate_ids):
                candidate = chosen.get(candidate_id)
                if not candidate or candidate["blocked"]:
                    raise ValueError("候选组不存在或有冲突，请重新预览或手动归组")
                group_ids = [run["id"] for run in candidate["runs"]]
                folds = {run["id"]: run["fold"] for run in candidate["runs"]}
                groups.append(_assign(db, group_ids, folds, candidate["name"], candidate["n_splits"], origin="reviewed"))
        return {"groups": groups, "updated": sum(len(chosen[candidate_id]["runs"]) for candidate_id in dict.fromkeys(candidate_ids))}
    finally:
        db.close()


def edit_membership(directory, ids, preferred=None):
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            records = checked_runs(db, ids)
            if preferred is None:
                db.executemany("DELETE FROM cv_members WHERE run_id=?", [(run["id"],) for run in records])
            else:
                if len(records) != 1 or not isinstance(preferred, bool):
                    raise ValueError("每次只能指定一条统计记录")
                run = records[0]
                member = db.execute("SELECT * FROM cv_members WHERE run_id=?", (run["id"],)).fetchone()
                if not member:
                    raise ValueError("实验尚未归组")
                if preferred and (run["status"] != "finished" or db.execute("SELECT run_id FROM trash WHERE run_id=?", (run["id"],)).fetchone()):
                    raise ValueError("只能指定已完成且不在回收站中的统计记录")
                if preferred:
                    db.execute("UPDATE cv_members SET preferred=0 WHERE group_id=? AND fold=?", (member["group_id"], member["fold"]))
                db.execute("UPDATE cv_members SET preferred=? WHERE run_id=?", (int(preferred), run["id"]))
        return {"updated": len(records)}
    finally:
        db.close()


def summary(directory, group_ids, metric, reduction="max", trashed=False, *, source="history", dataset=None, evaluation="final"):
    if not isinstance(group_ids, list) or not 1 <= len(group_ids) <= 100 or not all(isinstance(key, str) for key in group_ids):
        raise ValueError("请选择 1 到 100 个 CV 组")
    if source not in ("history", "evaluation"):
        raise ValueError("请选择训练历史或最终评估作为数据来源")
    if not isinstance(metric, str) or not metric or (source == "history" and reduction not in ("max", "min", "last")):
        raise ValueError("请选择指标和统计口径")
    if source == "evaluation":
        if not all(isinstance(value, str) and value.strip() and len(value) <= 500 for value in (dataset, evaluation)):
            raise ValueError("最终评估需要指定测试集和评估版本")
        reduction = "final"
    else:
        dataset = evaluation = None
    db = connect(directory)
    try:
        with db:
            db.execute("BEGIN")
            result = []
            for group_id in dict.fromkeys(group_ids):
                group = db.execute("SELECT * FROM cv_groups WHERE id=?", (group_id,)).fetchone()
                if group is None:
                    raise KeyError(group_id)
                records = [dict(row) for row in db.execute(
                    "SELECT r.id,r.name,r.status,r.created_at,r.finished_at,r.summary,m.fold,m.preferred "
                    "FROM cv_members m JOIN runs r ON r.id=m.run_id LEFT JOIN trash t ON t.run_id=r.id "
                    "WHERE m.group_id=? AND t.run_id IS " + ("NOT NULL" if trashed else "NULL"), (group_id,))]
                folds, values, completed = [], [], 0
                for fold in range(group["n_splits"]):
                    attempts = [run for run in records if run["fold"] == fold]
                    successful = [run for run in attempts if run["status"] == "finished"]
                    preferred = [run for run in successful if run["preferred"]]
                    pool = preferred or successful or attempts
                    chosen = max(pool, key=lambda run: (run["created_at"], run["id"])) if pool else None
                    value, value_source, details = None, None, None
                    missing_reason = "no_finished_attempt"
                    if successful:
                        completed += 1
                        missing_reason = "metric_not_recorded"
                        if source == "evaluation":
                            row = db.execute("SELECT metrics,metadata FROM evaluations WHERE run_id=? AND dataset=? AND name=?",
                                             (chosen["id"], dataset, evaluation)).fetchone()
                            scores = json.loads(row["metrics"]) if row else {}
                            value = scores.get(metric)
                            details = json.loads(row["metadata"]) if row else None
                            value_source = "evaluation"
                            missing_reason = "evaluation_not_recorded" if row is None else "metric_not_recorded" if metric not in scores else "missing_value"
                        elif reduction == "last":
                            row = db.execute("SELECT value FROM metrics WHERE run_id=? AND key=? ORDER BY step DESC LIMIT 1", (chosen["id"], metric)).fetchone()
                            value = row[0] if row else json.loads(chosen["summary"]).get(metric)
                            value_source = "history" if row else "summary"
                        else:
                            value = db.execute("SELECT %s(value) FROM metrics WHERE run_id=? AND key=?" % reduction.upper(), (chosen["id"], metric)).fetchone()[0]
                            value_source = "history"
                        if isinstance(value, numbers.Real) and math.isfinite(value):
                            values.append(value)
                            missing_reason = None
                        else:
                            value = None
                    folds.append({"fold": fold, "attempts": len(attempts), "run_id": chosen["id"] if chosen else None,
                                  "name": chosen["name"] if chosen else None, "status": chosen["status"] if chosen else "missing", "value": value,
                                  "preferred": bool(chosen and chosen["preferred"]), "value_source": value_source if value is not None else None,
                                  "missing_reason": missing_reason, "evaluation_metadata": details})
                result.append({"id": group_id, "name": group["name"], "project": group["project"], "n_splits": group["n_splits"],
                               "completed": completed, "n": len(values), "mean": statistics.mean(values) if values else None,
                               "std": statistics.stdev(values) if len(values) > 1 else None, "min": min(values) if values else None,
                               "max": max(values) if values else None, "folds": folds})
        return {"source": source, "dataset": dataset, "evaluation": evaluation, "metric": metric, "reduction": reduction,
                "groups": result, "std_definition": "sample standard deviation (ddof=1); completed folds with recorded values only"}
    finally:
        db.close()
