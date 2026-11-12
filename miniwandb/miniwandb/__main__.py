import argparse
import math
from pathlib import Path

from .server import serve
from .storage import Reader, connect, resolve_dir, set_trashed
from .tracker import Run


def main():
    parser = argparse.ArgumentParser(description="本地实验记录与训练曲线，无需账号或网络")
    commands = parser.add_subparsers(dest="command", required=True)
    web = commands.add_parser("serve", help="启动实验网页")
    web.add_argument("--dir", help="实验数据目录，默认 MINIWANDB_DIR 或 ./miniwandb_runs")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8080)
    demo = commands.add_parser("demo", help="生成两组演示实验，不运行模型")
    demo.add_argument("--dir", help="实验数据目录")
    importing = commands.add_parser("import-wandb", help="离线导入旧 W&B 目录、.wandb、JSONL 或 CSV 文件")
    importing.add_argument("sources", nargs="+", help="一个或多个源目录或文件")
    importing.add_argument("--dir", help="导入目标数据目录，与 serve --dir 保持一致")
    importing.add_argument("--project", help="将导入的实验放入指定项目，默认保留原项目")
    importing.add_argument("--replace", action="store_true", help="重新导入并替换已有的同一 W&B 实验")
    importing.add_argument("--limit", type=int, help="最多处理多少个源文件")
    listing = commands.add_parser("list", help="列出实验 ID 和名称")
    listing.add_argument("--dir", help="实验数据目录")
    listing.add_argument("--trash", action="store_true", help="查看回收站")
    listing.add_argument("--project", help="按项目筛选")
    for command, description in (("trash", "将指定实验移入回收站"), ("restore", "从回收站恢复指定实验")):
        action = commands.add_parser(command, help=description)
        action.add_argument("ids", nargs="+", help="要操作的实验 ID，可用 list 命令查看")
        action.add_argument("--dir", help="实验数据目录")
    purging = commands.add_parser("purge", help="预览或永久删除回收站实验")
    purging.add_argument("ids", nargs="*", help="回收站实验 ID")
    purging.add_argument("--all-trash", action="store_true", help="选择整个回收站")
    purging.add_argument("--delete-sources", action="store_true", help="同时删除预览中的原始 W&B 日志目录/历史文件")
    purging.add_argument("--yes", action="store_true", help="确认执行永久删除；不加此选项仅预览")
    purging.add_argument("--dir", help="实验数据目录")
    compaction = commands.add_parser("compact", help="训练结束后回收数据库空闲空间")
    compaction.add_argument("--dir", help="实验数据目录")
    analysis = commands.add_parser("export-ai", help="导出训练曲线、超参数、CV 和最终评估的 AI 分析包")
    analysis.add_argument("ids", nargs="+", help="选择 1 到 100 条实验 ID，自动展开所属 CV 组")
    analysis.add_argument("--dir", help="实验数据目录")
    analysis.add_argument("--output", type=Path, default=Path("miniwandb_ai_analysis.zip"))
    analysis.add_argument("--primary-metric")
    analysis.add_argument("--direction", choices=("min", "max"))
    analysis.add_argument("--step-unit", choices=("unknown", "batch", "optimizer_step", "epoch"), default="unknown")
    analysis.add_argument("--context", default="", help="任务与数据背景")
    analysis.add_argument("--evaluation-protocol", default="", help="验证、测试集与 checkpoint 选择说明")
    analysis.add_argument("--no-output", action="store_true", help="不附带控制台日志末尾")
    analysis.add_argument("--max-points", type=int, default=300, help="每条指标曲线的抽样上限")
    analysis.add_argument("--trash", action="store_true")
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.dir, args.host, args.port)
    elif args.command == "export-ai":
        from .analysis_report import build_analysis_bundle
        try:
            bundle = build_analysis_bundle(args.dir, args.ids, primary_metric=args.primary_metric, direction=args.direction,
                step_unit=args.step_unit, context=args.context, evaluation_protocol=args.evaluation_protocol,
                include_output=not args.no_output, max_points=args.max_points, trashed=args.trash)
            output = args.output.expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True); output.write_bytes(bundle)
            print("AI analysis bundle: %s" % output)
        except (OSError, ValueError, KeyError) as error:
            parser.exit(1, str(error) + "\n")
    elif args.command == "list":
        db = connect(args.dir)
        db.close()
        reader = Reader(args.dir)
        try:
            print("ID\tPROJECT\tSTATUS\tNAME")
            for run in reader.runs(trashed=args.trash):
                if args.project is None or run["project"] == args.project:
                    print("\t".join(str(run[key]).replace("\n", " ").replace("\t", " ")
                                    for key in ("id", "project", "status", "name")))
        finally:
            reader.close()
    elif args.command in ("trash", "restore"):
        try:
            count = set_trashed(args.dir, args.ids, trashed=args.command == "trash")
        except (KeyError, ValueError) as error:
            parser.exit(1, "No records changed: %s\n" % error)
        print("%s: %d experiments" % (args.command, count))
    elif args.command in ("purge", "compact"):
        from .cleanup import compact, preview_purge, purge_runs
        try:
            if args.command == "compact":
                result = compact(args.dir)
                print("Database size: {before_bytes} -> {after_bytes} bytes".format(**result))
            else:
                if bool(args.ids) == args.all_trash:
                    raise ValueError("请指定实验 ID 或 --all-trash，两者选一")
                ids = args.ids
                if args.all_trash:
                    db = connect(args.dir)
                    db.close()
                    reader = Reader(args.dir)
                    try:
                        ids = [run["id"] for run in reader.runs(trashed=True)]
                    finally:
                        reader.close()
                if not ids:
                    print("Trash is empty")
                    return
                plan = preview_purge(args.dir, ids)
                for entry in plan["experiments"]:
                    print("%s / %s (%d metrics)" % (entry["id"], entry["name"], entry["metrics"]))
                    if args.delete_sources:
                        print("  Source: %s" % (entry["target"] or entry["source_error"] or "No source files"))
                if args.yes:
                    result = purge_runs(args.dir, ids, args.delete_sources)
                    print("Permanently deleted: {deleted}; metrics: {metrics}".format(**result))
                else:
                    print("Preview only. Add --yes to permanently delete these experiments.")
        except (KeyError, ValueError, OSError) as error:
            parser.exit(1, str(error) + "\n")
    elif args.command == "import-wandb":
        from .importer import import_sources
        try:
            counts = import_sources(args.sources, args.dir, args.project, args.replace, args.limit,
                                    report=lambda message: print(message, flush=True))
        except (OSError, ValueError) as error:
            parser.exit(1, str(error) + "\n")
        print("Imported: {imported}; skipped: {skipped}; failed: {failed}".format(**counts))
        print("Data: %s" % resolve_dir(args.dir))
        if counts["failed"]:
            parser.exit(1)
    else:
        for index, lr in enumerate((0.001, 0.0005)):
            with Run(project="demo", name="baseline" if index == 0 else "smaller-lr",
                     config={"learning_rate": lr, "batch_size": 32, "seed": 42},
                     notes="演示数据；非真实训练结果", tags=["demo"], dir=args.dir) as run:
                for epoch in range(60):
                    loss = math.exp(-epoch / (14 + index * 5)) + 0.03 * math.sin(epoch * 0.8) + 0.06
                    run.log({"epoch": epoch, "train/loss": loss,
                             "valid/loss": loss + 0.08 + epoch * 0.0008,
                             "valid/auroc": 0.55 + 0.4 * (1 - math.exp(-epoch / (12 + index * 3))),
                             "train/lr": lr * (1 + math.cos(epoch / 60 * math.pi)) / 2}, step=epoch)
        print("Demo saved: %s" % resolve_dir(args.dir))


if __name__ == "__main__":
    main()
