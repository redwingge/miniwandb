# MiniWandb 训练使用指南

本指南介绍如何在 Python 训练代码中保存实验参数、训练曲线、交叉验证结果和多测试集最终评估。示例不依赖特定模型、数据集或服务器目录。

安装和网页功能概览见 [README](README.md)。命令默认在包含 `pyproject.toml` 的项目根目录运行；示例数值均为模拟数据。

## 1. 安装与数据目录

```bash
python -m pip install -e .
```

在训练入口中选定一次目录，并打印其绝对路径：

```python
import os
from pathlib import Path

LOG_DIR = Path(os.environ.get("MINIWANDB_DIR", "./miniwandb_runs")).expanduser().resolve()
print("Experiment directory:", LOG_DIR)
```

目录优先级为：显式 `dir`／`--dir` > 环境变量 `MINIWANDB_DIR` > 当前工作目录下的 `miniwandb_runs`。显式传入 `dir` 后，修改环境变量不会改变已经创建的实验目录。

训练、导入和网页服务需要使用同一个目录。`serve --dir` 只决定网页读取位置，不修改训练保存位置，也不会自动搬迁数据。

## 2. 最小可运行入口

将下面内容保存为 `train.py`。它只生成模拟指标，用于检查记录流程，不执行实际模型训练：

```python
import math
import os
from pathlib import Path

import miniwandb

LOG_DIR = Path(os.environ.get("MINIWANDB_DIR", "./miniwandb_runs")).expanduser().resolve()

def main():
    with miniwandb.init(
        project="classification",
        name="baseline",
        config={
            "learning_rate": 1e-4,
            "batch_size": 32,
            "epochs": 5,
            "seed": 42,
            "optimizer": {"name": "adam", "weight_decay": 0.01},
        },
        notes="Simulated training metrics",
        tags=["baseline", "demo"],
        dir=LOG_DIR,
        capture_output=True,
    ) as run:
        print("Run ID:", run.id)
        print("Data directory:", run.dir)

        for epoch in range(5):
            # 实际使用时替换为训练和验证结果。
            run.log({
                "epoch": epoch,
                "train/loss": math.exp(-epoch / 2),
                "valid/accuracy": 0.70 + epoch * 0.03,
            }, step=epoch)

        # 实际使用时加载选定 checkpoint，在评估后记录。
        run.log_evaluation(
            "test", {"accuracy": 0.82, "f1": 0.80},
            metadata={"checkpoint": "best"},
        )

if __name__ == "__main__":
    main()
```

```bash
python train.py
python -m miniwandb serve --dir ./miniwandb_runs --port 8080
```

打开 [http://127.0.0.1:8080](http://127.0.0.1:8080)。从其他工作目录启动服务时，将 `--dir` 改成训练打印的绝对路径。

## 3. 接入已有训练循环

### 生命周期

每个独立实验调用一次 `init()`，训练、验证和最终测试共用该实验，全部完成后再 `finish()`。不要在每轮验证、加载最优 checkpoint 或每个测试集开始时再次 `init()`。

推荐让 `with miniwandb.init(...) as run:` 包住完整流程。正常退出标记为 `finished`，异常或 `Ctrl+C` 标记为 `failed`，异常继续向外抛出。

也可以使用模块级接口：

```python
import miniwandb as wandb

wandb.init(project="classification", name="baseline", dir="./miniwandb_runs")
try:
    # 在这里执行训练和评估；以下为模拟记录。
    wandb.log({"train/loss": 0.4}, step=0)
    wandb.log({"valid/accuracy": 0.8}, step=0)
    wandb.log_evaluation("test", {"accuracy": 0.79})
except BaseException:
    wandb.finish(exit_code=1)
    raise
else:
    wandb.finish()
```

模块级 `init()` 会先结束已有活动实验，再创建新实验。`import miniwandb as wandb` 只提供常用标量记录接口；已有代码使用其他 W&B 功能时需要单独调整。

### step 和 epoch

| 记录方式 | 推荐 step | 说明 |
| --- | --- | --- |
| 每个 epoch 一次汇总 | `step=epoch` | 每轮平均 loss、验证准确率等 |
| 按 batch 记录 | `step=global_step` | 使用累计 batch 数，验证可与最后一个 batch 对齐 |
| 按优化器更新记录 | `step=optimizer_step` | 梯度累积时与 batch 计数区分 |
| 自动计数 | 不传 step | 从 0 开始，每次 `log()` 自动加 1 |

同一实验建议保持一种 step 口径。step 不能倒退；同一 step 的不同指标合并，相同指标重复记录则覆盖。不要在同一 epoch 的所有 batches 中都使用 `step=epoch`，否则 batch 指标会相互覆盖。

需要 Epoch 横轴时显式记录 `"epoch": epoch`。一个 epoch 有多个 batches 时，Epoch 轴上也可能有多个点；想每轮只显示一个点，应记录每轮汇总值。

`train/loss`、`train/lr` 放入 `train` 组，`valid/accuracy` 放入 `valid` 组。多级名称如 `valid/subset_a/f1` 仍按第一级收纳。

### 最优指标与配置更新

`run.summary` 是各指标最后值，不会自动选择最优模型。可以在保存最优 checkpoint 时额外记录 `best/accuracy` 和 `best/epoch`。

`run.config` 是副本，修改返回的字典不会持久化。更新阈值等配置时使用：

```python
# run 为当前活动实验；step 应替换为当前训练计数。
run.update_config({"threshold": 0.42})
run.log({"best/accuracy": 0.86, "best/epoch": 4}, step=4)
```

模型权重和优化器等训练状态仍需由训练代码自行保存。

## 4. k-fold 与重复实验

一个模型／超参数配置的一轮 CV 使用一个共享 `cv_id`，每个 fold 创建自己的实验。以下示例可独立运行：

```python
import os
import uuid
from pathlib import Path

import miniwandb

LOG_DIR = Path(os.environ.get("MINIWANDB_DIR", "./miniwandb_runs")).expanduser().resolve()
N_SPLITS = 5

for model_name, learning_rate in (("baseline", 1e-4), ("alternative", 5e-5)):
    # 每个配置、每轮 CV 各一个 ID，不要在 fold 循环内部重新生成。
    cv_id = uuid.uuid4().hex
    print("CV ID:", cv_id)

    for fold in range(N_SPLITS):
        with miniwandb.init(
            project="classification",
            name=f"{model_name}_fold_{fold}",
            config={
                "cv_id": cv_id,
                "cv_name": f"{model_name}_lr_{learning_rate}",
                "fold": fold,
                "n_splits": N_SPLITS,
                "model": model_name,
                "learning_rate": learning_rate,
                "seed": 42,
            },
            dir=LOG_DIR,
        ) as run:
            # 模拟数据；实际使用时在本折训练并加载选定 checkpoint。
            score = 0.75 + fold * 0.01 + (0.02 if model_name == "alternative" else 0)
            run.log({"epoch": 0, "valid/accuracy": score}, step=0)
            run.log_evaluation("test_a", {"accuracy": score - 0.01})
            run.log_evaluation("test_b", {"accuracy": score - 0.04})
```

`fold` 从 0 开始，`n_splits` 为完整 CV 的总折数。即使只运行其中几折，也应保留真实总折数；只写 `fold` 不会自动归组。

### 重跑与继续同一轮 CV

- 新的一整轮 CV：生成新的 `cv_id`。
- 继续未完成的 folds：使用原 `cv_id`，为对应折创建新实验。
- 只重跑某折：复用原 `cv_id` 和 fold 编号，创建新的 run ID。
- 恢复同一条训练记录：保留原 run ID，使用 `resume=True`，见第 7 节。

`cv_id` 是普通配置值，不会自动读取环境变量。需要通过环境变量传递时，由入口显式读取，例如 `cv_id = os.environ.get("CV_ID") or uuid.uuid4().hex`，再写入 config。

每折默认以创建时间最近、成功完成的尝试作为代表，也可通过「用于统计」指定。失败、运行中和状态未知的导入实验不参与组统计。旧实验可在「批量操作」中手动归组，或预览候选后确认；导入时不会直接猜测并合并。

## 5. 多测试集最终评估

训练过程的验证曲线使用 `log()`。选定 checkpoint 后，各测试集的指标使用 `log_evaluation()` 单独保存：

```python
# run 为当前活动实验；将得分替换为对应测试集的实际结果。
run.log_evaluation(
    "test_a", {"accuracy": 0.86, "f1": 0.84, "loss": 0.31},
    name="final",
    metadata={"checkpoint": "best.pt", "threshold": 0.5},
)
run.log_evaluation(
    "test_b", {"accuracy": 0.81, "f1": 0.79, "loss": 0.38},
    name="final",
    metadata={"checkpoint": "best.pt", "threshold": 0.5},
)
```

每个测试集评估完成后立即保存，避免局部变量被下一次评估覆盖。数据集名称单独传入，指标只写 `accuracy`，不需要写 `test_a/accuracy`；网页展示为 `test_a / accuracy`。所有模型应统一名称和大小写。

这些结果独立于 step 历史，不推进 step，不改变训练摘要或实验状态。`metadata` 可保存 checkpoint 路径、阈值、样本数等信息，不会复制模型文件。

### 唯一性与评估版本

实验 ID、测试集名称和 `name` 共同确定一份结果：

- 默认 `name="final"`，同内容重传不会重复计数。
- 更正已有结果需 `replace=True`，修改的是原记录。
- 评估另一个 checkpoint 时使用新版本名，例如 `"best"`、`"last"`。

网页按版本分别比较，不应把同一 fold 的多个 checkpoints 当成额外 folds 混合统计。

### 已结束实验的补录

`Run.log_evaluation()` 用于活动实验。实验结束后或评估位于独立进程时，使用模块接口指定 run ID 和目录：

```python
import miniwandb

miniwandb.log_evaluation(
    "test_a", {"accuracy": 0.86, "f1": 0.84},
    run_id="existing-run-id",
    dir="./miniwandb_runs",
    metadata={"checkpoint": "best.pt"},
)
```

原实验必须存在且不在回收站。无需 `init()` 或 `resume=True`，不会把已完成实验重新标记为运行中。ID 可从网页详情或 `python -m miniwandb list --dir ./miniwandb_runs` 获取。

### 从评估 CSV 补录

普通测试结果 CSV 与训练历史 CSV 不同。明确映射列名，再将该行关联到对应模型和 fold 的实验：

```python
import csv
import miniwandb

csv_path = "./results/test_a.csv"
with open(csv_path, newline="", encoding="utf-8-sig") as file:
    rows = list(csv.DictReader(file))
if not rows:
    raise ValueError("Evaluation CSV is empty")

row = rows[-1]  # 明确选择一行，核对其模型、seed、fold 是否属于目标实验。
column_map = {"Accuracy": "accuracy", "F1": "f1", "Loss": "loss"}
metrics = {
    target: float(row[source])
    for source, target in column_map.items()
    if row.get(source) is not None and row[source].strip()
}
miniwandb.log_evaluation(
    "test_a", metrics,
    run_id="existing-run-id",
    dir="./miniwandb_runs",
    metadata={"source_csv": csv_path},
)
```

各 fold 对应自己的 run ID，各测试集使用各自的名称，不要把同一行得分复制到多个 folds。

## 6. 网页中比较结果

```bash
python -m miniwandb serve --dir ./miniwandb_runs --port 8080
```

左侧搜索常驻，筛选和批量操作可展开／收起。支持全选、反选、仅选筛选结果。筛选不自动取消已有勾选，底部提示筛选外的已选数量。

勾选多个实验即可比较同名训练指标。参数表按实验分列、参数分行，支持仅显示差异、跨项目比较和按超参数筛选。

CV 汇总可选择每折最大、最小或最后值。各指标的极值可能来自不同训练时刻，最终模型的多指标比较应使用独立最终评估。「组间参数」模式每个 CV 组一列，组内变化会单独标识。

在「最终评估 · 测试集对比」中选择版本、指标和测试集。每个测试集独立成图，可折叠；每个模型／配置一个 CV 组，每个点一个 fold，也支持独立实验的单点比较。

- 箱线图用线性插值计算 Q1、Q3 和中位数，须延伸到 1.5×IQR 内的最远观测值，原始点全部显示。
- 柱高为均值，误差棒为样本标准差 `ddof=1`。
- 缺失不补零，只有一折有值时显示单点，标准差为「—」。
- 勾选组内任一记录会汇总完整组的代表 folds；代表折没有该评估时不回退到旧重跑。
- 组统计只使用成功完成的记录；未归组实验有明确保存的最终评估时可单独查看。

可导出带完整项目、组名和 ID 图例的 PNG／SVG，以及含各折原始分数、统计量、实验 ID、元数据的 CSV。标准差用于描述离散程度，不是标准误或置信区间。

## 7. 断点续记与模型恢复

记录恢复与模型恢复分开进行。保存 run ID，重启后恢复同一个实验：

```python
import miniwandb

with miniwandb.init(
    id="existing-run-id",
    resume=True,
    dir="./miniwandb_runs",
) as run:
    print("Next automatic step:", run.step)
    # 实际训练前自行恢复模型、优化器、调度器等状态。
    run.log({"train/loss": 0.3}, step=run.step)
```

恢复保留原项目、名称、备注、标签、配置、历史和 CV 分组。需要修改配置时调用 `update_config()`。自动 step 接续已有最大 step，显式 step 仍不能倒退。

`resume=True` 要求 ID 已存在。继续同一轮 CV 的另一折，应使用同一 `cv_id` 创建新实验，而不是复用已有 fold 的 run ID。

## 8. 落盘、同步与性能

每次 `log()` 和 `log_evaluation()` 都提交数据库事务，训练写入不依赖网页服务在线。页面可见且开启自动刷新时约每 3 秒检查一次；进入后台暂停，返回时重新读取。查看浮窗和缩放时可能暂缓曲线重绘。

进程异常退出前已提交的记录通常会保留。`with` 或显式异常处理可以标记失败；`kill -9`、断电等情况无法执行 `finish()`，状态可能仍显示运行中。目前状态字段不是进程心跳检测。

记录频率决定数据库体积和网页加载成本。可按若干 batches 或每个 epoch 记录一次；不应将大数组、完整预测向量或媒体对象作为标量指标。只选择需要比较的实验，可以减少历史下载量。

多进程／分布式训练由主进程或 rank 0 负责同一实验的记录。不要跨进程共享 `Run`，也不要让多个进程同时恢复并写入同一个 run ID。不同实验可以共用数据目录。

### 备份数据库

运行时可能存在数据库及 `-wal`、`-shm` 文件。可使用 SQLite 在线备份：

```python
from pathlib import Path
import sqlite3

source_path = Path("./miniwandb_runs/experiments.sqlite3").resolve()
backup_path = Path("./backup/experiments.sqlite3").resolve()
backup_path.parent.mkdir(parents=True, exist_ok=True)

with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source:
    with sqlite3.connect(backup_path) as destination:
        source.backup(destination)
```

或者停止所有写入和网页服务后复制整个数据目录。不要在运行中单独移动、删除或只备份主数据库文件而遗漏 WAL 中的数据。

## 9. 导入已有 W&B 实验

```bash
python -m pip install '.[wandb]'
python -m miniwandb import-wandb /path/to/wandb --dir ./miniwandb_runs
```

导入器读取本地 `.wandb`、标量历史 JSONL／CSV，不登录账号、不请求云端 API。目录可递归扫描；二进制日志依赖 W&B SDK，文本历史读取不需要 SDK。

同一实验再次导入默认跳过，更新快照时使用：

```bash
python -m miniwandb import-wandb /path/to/wandb --dir ./miniwandb_runs --replace
```

原 W&B 实验后续写入不会自动同步进来。导入保留标量历史和可解析元数据，不把图片、模型附件等内容当作曲线；重新导入保留回收站状态、CV 分组及另存的最终评估。

只有运行状态明确为成功完成的导入记录才参与 CV 组统计。普通测试评估表按第 5 节补录，不应把每行评估得分误当作训练 step。

## 10. 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 网页没有新实验 | 比较训练的 `run.dir` 与服务的 `--dir`，确认是同一绝对路径 |
| 换工作目录后数据消失 | 相对路径解析位置变化，数据可能仍在原工作目录下 |
| 一个 fold 出现多条记录 | 检查是否在验证或加载 checkpoint 时重新 `init()`；有意重跑则正常 |
| 每轮只保留最后一个 batch | 同一 epoch 的 batches 使用了相同 step，同名指标被覆盖 |
| 最终评估未进入组统计 | 检查 fold 是否已完成、代表记录及版本／测试集／指标名称是否一致 |
| 最终评估提示已存在 | 修正已有记录用 `replace=True`，另一 checkpoint 用新版本名 |
| 修改 config 后网页不变 | 使用 `run.update_config()`，不要只修改配置副本 |
| 导入后不持续更新 | 导入是快照，源日志变化后重新执行并加 `--replace` |
| 进程退出却仍显示运行中 | 强制终止可能未执行结束处理，状态不代表心跳 |
| 页面打开失败 | 检查服务、端口转发，并使用包含 `http://` 的本地地址 |

更多命令、远程端口转发和回收站操作见 [README](README.md)。

## 11. 单次训练详情与控制台日志

首页用于多实验比较。实验条目右侧 **↗** 或摘要区的 **单次训练详情** 会打开独立页面，集中查看当前一次训练的参数、指标曲线、最终评估和 `output.log`。

创建实验时设置 `capture_output=True`，会在保留终端输出的同时记录初始化之后的 Python 标准输出和标准错误：

```python
import miniwandb

with miniwandb.init(project="demo", dir="./miniwandb_runs", capture_output=True) as run:
    print("training started")
    for epoch in range(3):
        print(f"epoch {epoch}: simulated loss={1 / (epoch + 1):.4f}")
        run.log({"epoch": epoch, "train/loss": 1 / (epoch + 1)}, step=epoch)
    print("training finished")
```

应在加载／训练模型前创建实验，才能记录这些阶段的输出。若使用模块级别名 `wandb`，同样给 `wandb.init()` 增加该参数。每个进程同时只能有一个捕获输出的实验，fold 结束后再创建下一个；分布式训练仍只在主进程或 rank 0 捕获。

`print`、动态读取标准错误的进度条等通常可以记录；初始化前绑定到旧 stream 的 logger／进度条、子进程输出、C 层直接写文件描述符及二进制 `.buffer` 写入不保证捕获。需要记录这些输出时可使用原有日志文件，再显式补录：

```python
import miniwandb

miniwandb.attach_output(
    "./logs/output.log",
    run_id="existing-run-id",
    dir="./miniwandb_runs",
)
```

补录要求原实验已结束且不在回收站，已有内容时默认报错；显式 `replace=True` 才替换。活动实验也可使用 `run.log_output(text)` 或模块级 `miniwandb.log_output(text)` 追加自定义文本，不影响训练 step、summary 或参数。

捕获内容随实验写入数据库，详情页增量刷新并提供完整 `output.log` 下载，不额外生成实体日志文件。页面最多保留最新 262,144 个字符；关闭自动滚动可向上阅读，自动更新可单独关闭。恢复 run 时追加日志，永久删除该实验时一并删除。历史实验的旧输出不会自动补回。
