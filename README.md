# MiniWandb

轻量、离线的 Python 实验记录工具。将训练参数、标量指标和最终评估保存在本地，通过网页查看训练曲线、比较超参数及交叉验证结果。

支持 Python 3.9 及以上版本。核心运行时仅使用 Python 标准库；网页资源随包提供，无需账号、API Key、CDN 或云服务。导入 W&B 二进制日志时需要额外安装 W&B SDK。

## 功能

- 保存实验配置、备注、标签、状态和标量训练指标。
- 对比多条曲线，支持指标分组、平滑、框选缩放和图片导出。
- 按项目、状态、关键词及超参数筛选，使用表格比较参数差异。
- 按 CV 组、fold、重跑记录收纳交叉验证实验。
- 单独保存多个测试集的最终评估，提供箱线图与均值柱状图＋标准差误差棒。
- 导入本地 W&B 日志，支持回收站、恢复及永久删除。
- 使用 SQLite 持久化，训练写入与网页服务可以独立运行。
- 独立的单次训练详情页，支持实时查看控制台日志并下载 `output.log`。
- 导出 AI 分析包，汇总训练曲线、超参数、CV 和多测试集结果，附结构化数据与分析提示词。

训练接入的完整说明见 **[训练使用指南](TRAINING_GUIDE.md)**。

结果解读见 **[AI 分析指南](AI_ANALYSIS_GUIDE.md)**：勾选实验，点击顶部「AI 分析包」，下载后将解压文件交给 AI。支持运行中快照和 CV 组自动展开；不会自动调用外部服务。源码上传步骤见 [GitHub 上传说明](GITHUB_UPLOAD.md)。

## 让 AI 完成接入

向 AI 提供 **[MiniWandb 接入 Skill](skills/miniwandb-integration/SKILL.md)** 和待修改的训练代码即可。该文档自包含 API 签名、生命周期、step 规则、k-fold、最终评估及验收要求，无需让 AI 重新阅读整个库。

可直接使用以下提示词，替换目标文件和数据目录：

```text
请先读取 skills/miniwandb-integration/SKILL.md，按其中的接口契约，
将训练脚本 train.py 接入 MiniWandb，数据目录为 /path/to/miniwandb_runs。
只修改实验记录相关代码，保留模型、训练超参数、数据划分、checkpoint 和 CSV 输出逻辑。
完成语法检查及轻量验证，不启动真实训练。
```

也可以将该文件全文直接交给其他 AI 工具；使用支持 Skill 的工具时，可按该工具的约定安装 `miniwandb-integration` 目录。

## 安装

以下命令在包含 `pyproject.toml` 的项目根目录执行：

```bash
python -m pip install .
```

开发时可使用可编辑安装：

```bash
python -m pip install -e .
```

需要导入 W&B 的 `.wandb` 二进制日志时安装可选依赖：

```bash
python -m pip install '.[wandb]'
```

安装后可使用 `python -m miniwandb` 或 `miniwandb` 命令。

## 快速体验

```bash
python -m miniwandb demo --dir ./demo_runs
python -m miniwandb serve --dir ./demo_runs --port 8080
```

访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)。演示命令每次创建两条新实验，指标为模拟数据，不执行模型训练。

## 最小训练示例

```python
from pathlib import Path
import miniwandb

log_dir = Path("./miniwandb_runs").resolve()

with miniwandb.init(
    project="classification",
    name="baseline",
    config={"learning_rate": 1e-4, "batch_size": 32, "seed": 42},
    notes="Simulated training metrics",
    tags=["baseline"],
    dir=log_dir,
    capture_output=True,
) as run:
    print("Run ID:", run.id)
    print("Data directory:", run.dir)

    for epoch in range(5):
        # 模拟指标；实际使用时替换为训练和验证结果。
        run.log({
            "epoch": epoch,
            "train/loss": 1.0 / (epoch + 1),
            "valid/accuracy": 0.70 + epoch * 0.03,
        }, step=epoch)

    run.log_evaluation(
        "test", {"accuracy": 0.82, "f1": 0.80},
        metadata={"checkpoint": "best"},
    )
```

在另一个终端启动网页，使用相同的数据目录：

```bash
python -m miniwandb serve --dir ./miniwandb_runs --port 8080
```

推荐使用 `with`：正常退出标记为 `finished`，异常退出标记为 `failed`，异常继续向外抛出。模型权重、优化器和数据加载由训练代码管理。

## 保存位置与实时更新

数据目录优先级为：**Python 接口的 `dir`／命令行的 `--dir` > 环境变量 `MINIWANDB_DIR` > 当前工作目录下的 `miniwandb_runs`**。

所有实验共用该目录下的 `experiments.sqlite3`。训练、导入和网页服务应使用同一个目录；相对路径按各进程的工作目录解析，跨终端或跨脚本时建议使用绝对路径。

```bash
export MINIWANDB_DIR="$(pwd)/miniwandb_runs"
python train.py
```

```bash
# 在另一个终端中指定同一目录；替换为实际路径。
python -m miniwandb serve --dir /path/to/miniwandb_runs --port 8080
```

每次 `log()` 返回前都会提交数据库事务，不必等到 `finish()`。页面可见且开启自动刷新时，约每 3 秒读取一次更新；实际间隔受请求耗时影响。关闭网页、网页服务或端口转发，不影响仍在运行的训练继续记录。

## 单次训练详情与 output.log

首页用于多实验比较。点击列表条目右侧的 **↗**，或当前实验摘要中的 **单次训练详情**，打开独立的 `/runs/RUN_ID` 页面，查看该次训练的状态、配置、曲线、最终评估和控制台日志。

使用 `init(..., capture_output=True)` 或 `Run(..., capture_output=True)`，将初始化之后的 Python `sys.stdout`／`sys.stderr` 同时写入终端和实验记录。默认关闭；每个进程同时只允许一个实验捕获输出。异常退出时保留已记录文本，并在正常执行失败结束处理时保存 traceback；恢复同一 run 会追加日志。

日志随实验保存在 SQLite 中，不额外创建每次训练的实体 `output.log` 文件。详情页按游标增量读取，支持自动滚动、换行、文本筛选及下载完整 `output.log`。页面只保留最近 262,144 个字符；显示时处理颜色转义和进度条回车，下载保留原始文本。

也可手动写入文本，或补录已有 UTF-8 日志：

```python
# 活动实验中追加文本，不推进训练 step。
run.log_output("epoch 1 completed\n")

# 向已结束的原实验补录文件，不改变训练状态。
miniwandb.attach_output("./output.log", run_id="existing-run-id", dir="./miniwandb_runs")
```

已有日志默认不覆盖；明确更换文件时使用 `replace=True`。不能向运行中或回收站中的记录补录文件。日志会随回收站恢复保留、随永久删除清除，重新导入 W&B 时也会保留。

捕获不追溯初始化之前的输出，也不重定向子进程、C 层文件描述符或 `.buffer` 的二进制写入；初始化前已绑定旧 stream 的日志 handler／进度条可能不会被捕获，可用其原日志文件补录。W&B 导入不会自动读取控制台输出文件。旧实验没有日志时，详情页会明确提示。

## 网页与参数比较

边栏提供常驻搜索，以及可折叠的「筛选实验」「批量操作」工具。实验列表独立滚动，底部显示已选数量和取消选择按钮。

- 勾选多个实验，对比同名指标，也可跨项目比较。
- `train/loss`、`valid/accuracy` 按 `/` 的第一级分组，支持折叠；没有 `/` 的指标放入「其他指标」。
- 横轴支持 Step、运行时间和 Epoch；Epoch 轴需要显式记录 `epoch`。
- 右键拖框同时缩放两轴，双击图表或点击「还原」恢复完整范围。
- 浮窗按 Name / Step / Value 展示所有曲线，支持固定、滚动和展开长名称。
- 参数表每列一个实验、每行一个参数，支持差异高亮、仅显示差异和参数名搜索。
- 超参数筛选支持数值范围、等值、包含及已记录／未记录，支持嵌套键如 `optimizer.lr`。
- 搜索中逗号表示“或”，空格表示“且”；筛选保留已有选择，「仅选筛选结果」可清除筛选外的勾选。

每张曲线及整个指标组可导出带完整图例的 PNG／SVG。详情页可导出原始历史 CSV 和 JSON；JSON 还包含元数据及最终评估。平滑和缩放只影响显示及图片，不修改原始数据。

## 交叉验证与重跑

同一轮 CV 的所有 folds 使用同一个 `cv_id`，每个 fold 是独立实验：

```python
import uuid
import miniwandb

cv_id = uuid.uuid4().hex
for fold in range(5):
    with miniwandb.init(
        project="classification",
        name=f"baseline_fold_{fold}",
        config={
            "cv_id": cv_id,
            "cv_name": "baseline_lr_1e-4",
            "fold": fold,
            "n_splits": 5,
            "learning_rate": 1e-4,
        },
        dir="./miniwandb_runs",
    ) as run:
        # 模拟结果；替换为本折实际训练与评估。
        run.log({"valid/accuracy": 0.80 + fold * 0.01}, step=0)
        run.log_evaluation("test", {"accuracy": 0.78 + fold * 0.01})
```

- `fold` 从 0 开始，`n_splits` 为总折数。
- 另一种模型、超参数配置或独立的一轮 CV 使用新的 `cv_id`。
- 只重跑某折时复用原 `cv_id`，创建新的 run ID。
- 同一项目、同一 `cv_id` 的总折数必须一致；不同项目的分组相互独立。
- 只记录 `fold` 不会自动归组；旧实验可在「批量操作」中手动归组或预览候选，确认后保存。

网页按 CV 组 → fold → 重跑记录展示。每折默认使用创建时间最近、成功完成的记录，也可点击「用于统计」指定。失败、运行中和状态未知的记录不参与组统计。

「交叉验证组对比」支持两种数据来源，默认自动选择，已有最终评估时优先展示：

- **最终测试集评估**：选择测试集、评估版本（如 `final`、`best`、`last`）与指标，直接汇总每折保存的最终分数。不同测试集、版本分别统计；代表记录缺少结果时显示缺失，不回退到旧重跑。
- **训练 / 验证历史**：选择历史指标，按每折最大值、最小值或最后值汇总。各指标的极值可能来自不同训练时刻；比较同一 checkpoint 时应保存独立最终评估。

两种来源均计算均值与样本标准差，支持展开各 fold 的取值和所用记录，并导出包含数据来源、测试集及版本的汇总 CSV。训练结束后补录最终评估也会随网页自动刷新显示。

组间参数表会标出组内变化，各 fold 的原始配置也可单独查看。组均值曲线与标准差阴影暂未实现。

## 多测试集最终评估

最终评估与训练历史独立保存，不推进 step，也不覆盖训练摘要。测试集名称单独传入，指标无需重复添加测试集前缀：

```python
# 在活动实验结束前调用；分数来自对应测试集的评估结果。
run.log_evaluation("test_a", {"accuracy": 0.86, "f1": 0.84})
run.log_evaluation("test_b", {"accuracy": 0.81, "f1": 0.79})
```

在「最终评估 · 测试集对比」中选择指标，各测试集分别成图。每个模型／配置对应一个 CV 组，每个点对应一个 fold：

- 支持箱线图，以及均值柱状图＋样本标准差误差棒。
- 箱体为 Q1–Q3，中线为中位数，须为 1.5×IQR 内最远观测值；原始点全部显示。
- 标准差使用 `ddof=1`；缺失不补零，只有一个值时不计算标准差。
- 默认版本为 `name="final"`，可用 `name="best"`、`name="last"` 区分 checkpoint，版本间不混算。
- 相同实验＋测试集＋版本重复保存同内容不会增加记录；修正结果需显式 `replace=True`。
- 支持 PNG／SVG 和包含各折分数、统计量、run ID、元数据的 CSV 导出。

勾选组内任一记录后，汇总完整组的代表 folds。代表记录缺少最终评估时不会回退到旧重跑；未归组的独立实验也可单独查看。

训练结束后可以向原实验补录，无需重新打开训练状态：

```python
import miniwandb

miniwandb.log_evaluation(
    "test_a", {"accuracy": 0.86},
    run_id="existing-run-id",
    dir="./miniwandb_runs",
    metadata={"checkpoint": "best.pt"},
)
```

`metadata` 只保存元数据，不复制模型文件。完整接入方式与评估 CSV 补录见 [训练使用指南](TRAINING_GUIDE.md)。

## 导入本地 W&B 数据

```bash
python -m miniwandb import-wandb /path/to/wandb --dir ./miniwandb_runs
```

支持扫描日志目录、单个 `.wandb` 文件及标量历史 JSONL／CSV。二进制日志需要可选 W&B SDK；导入只读本地文件，不登录、不访问 W&B 云端。图片、视频、模型附件等非标量内容不会作为曲线导入。

同一来源再次导入默认跳过。源数据变化后，使用 `--replace` 重新读取对应的已导入实验：

```bash
python -m miniwandb import-wandb /path/to/wandb --dir ./miniwandb_runs --replace
```

导入是手动快照，不会持续监听原日志。替换保留 MiniWandb 的回收站状态、CV 分组和另存的最终评估。普通测试结果 CSV 应按训练指南补录最终评估。

## 回收站与数据清理

在「批量操作」中选择实验，可移入回收站；切换到回收站后可恢复或永久删除。移入回收站保留数据，不释放磁盘空间，也不会停止训练。运行中的实验不能永久删除。

```bash
python -m miniwandb list --dir ./miniwandb_runs
python -m miniwandb trash RUN_ID --dir ./miniwandb_runs
python -m miniwandb restore RUN_ID --dir ./miniwandb_runs

# 先预览，再显式确认永久删除。
python -m miniwandb purge RUN_ID --dir ./miniwandb_runs
python -m miniwandb purge RUN_ID --dir ./miniwandb_runs --yes
```

永久删除会移除参数、历史、最终评估及相关记录。原始 W&B 来源文件默认保留；网页需勾选来源删除选项，命令行需显式传入 `--delete-sources`。只处理导入时记录的来源路径，不根据配置中的模型或数据集路径删除文件。

数据库空闲空间可供后续写入复用。需要缩小数据库文件时，先结束训练，再执行：

```bash
python -m miniwandb compact --dir ./miniwandb_runs
```

运行时可能存在 `experiments.sqlite3-wal`、`experiments.sqlite3-shm`。备份请使用 SQLite 在线备份，或停止所有写入后复制整个数据目录，不要在运行中单独移动／删除这些文件。

## 远程服务器访问

在服务器上启动服务：

```bash
python -m miniwandb serve --dir /path/to/miniwandb_runs --host 127.0.0.1 --port 8080
```

在本机终端建立 SSH 转发：

```bash
ssh -N -L 18080:127.0.0.1:8080 user@server
```

本机访问 [http://127.0.0.1:18080](http://127.0.0.1:18080)。8080 是服务器服务端口，18080 是本机访问端口，可以不同。

VS Code Remote SSH 用户也可在「端口」面板转发服务器的 8080，使用面板显示的本地地址；支持通过 Simple Browser 打开。服务用于本地或 SSH 转发访问，目前不提供登录认证。

## API 与兼容范围

| 接口 | 用途 |
| --- | --- |
| `init(project, name, config, notes, tags, dir, id, resume, capture_output)` | 创建或恢复实验，可选捕获控制台输出 |
| `Run.log(data, step=None)` / `log(data, step=None)` | 保存标量训练指标 |
| `Run.update_config(values)` | 持久化更新配置 |
| `Run.log_evaluation(dataset, metrics, ...)` / `log_evaluation(...)` | 保存独立最终评估 |
| `Run.log_output(text)` / `log_output(text)` | 追加控制台文本 |
| `attach_output(path, *, run_id, dir=None, replace=False)` | 向已结束实验补录日志文件 |
| `Run.finish(exit_code=0)` / `finish(exit_code=0)` | 结束实验并记录状态 |
| `Run.id` / `Run.dir` / `Run.step` | 实验 ID、实际目录、下次自动 step |
| `Run.config` / `Run.summary` | 配置副本、各指标最后值 |

`config` 支持字典、`argparse.Namespace` 和 dataclass。指标支持数值标量和 `None`；多元素数组／tensor、字符串和媒体不能作为指标。标量对象可通过 `.item()` 转换，非有限数保存为缺失值。

不传 `step` 时从 0 自动递增；显式 step 必须是非负整数且不能倒退。同一 step 的不同指标合并，相同指标后写覆盖前写。`summary` 不自动追踪最优模型。

可用 `import miniwandb as wandb` 接入常用标量调用，但不兼容完整 W&B API；不支持 `watch`、artifacts、sweep、`commit=False` 或云同步。多进程训练应由主进程／rank 0 写入同一实验，不能跨进程共享 `Run` 对象。

## 示例与开发验证

```text
.
├── miniwandb/             # Python 包与离线网页资源
├── examples/              # 无需 GPU 的模拟示例
├── tests/                 # Python 与 JavaScript 验证
├── pyproject.toml
├── README.md
├── TRAINING_GUIDE.md
├── AI_ANALYSIS_GUIDE.md
└── GITHUB_UPLOAD.md
```

```bash
python examples/train.py
python examples/final_evaluation.py
python -m unittest discover -s tests -v
```

前端交互检查使用 Node.js，无需安装 npm 依赖：

```bash
node tests/test_selection.js
node tests/test_parameters.js
node tests/test_charts.js
node tests/test_cv.js
node tests/test_evaluations.js
node tests/test_run.js
node tests/test_reports.js
```

示例中的分数均为模拟数据。实验数据库、模型权重和本地构建产物应与项目源码分别管理。
