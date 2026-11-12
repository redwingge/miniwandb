---
name: miniwandb-integration
description: 将 Python 训练脚本接入 MiniWandb，或迁移常用 W&B 标量记录调用。适用于训练指标、实验配置、k-fold 分组、多测试集最终评估与断点续记的接入；不负责修改训练算法或实现 MiniWandb 网页功能。
---

# MiniWandb 接入规范

面向 MiniWandb 0.1.0 的自包含 API 契约。读取本文件和待接入的训练代码即可生成接入修改，默认无需遍历 MiniWandb 源码。只有安装环境的 API 与本契约不一致，或用户要求修改库本身时，才针对相关实现核对。

## 工作范围

目标是在用户指定的代码中增加可靠的本地实验记录。保留模型、数据划分、损失、优化器、调度器、随机种子、早停、checkpoint 选择及原 CSV 输出逻辑；只修改必要的日志导入、初始化、指标记录、最终评估和结束处理。

先在目标代码中定位：训练入口、配置对象、fold／重复实验循环、现有日志调用、全局 step、验证调用、模型加载及各测试集评估返回值。根据真实变量和控制流接入，不把下方模拟值、目录或折数直接写进真实训练。

优先采用用户指定的数据目录；未指定时保留已有目录约定，或提供可配置的 `./miniwandb_runs`。只有无法从上下文判断且会改变实验语义的问题才需澄清，例如多个 checkpoint 中哪一个是最终比较对象。

## 1. 环境与存储契约

- 导入名为 `miniwandb`，项目发行名为 `miniwandb-local`，需要 Python 3.9+。
- 核心记录无第三方依赖；W&B SDK 只用于导入旧二进制日志，原生训练记录不需要它。
- 已安装时直接 `import miniwandb`。源码安装在包含 `pyproject.toml` 的目录执行 `python -m pip install -e .`；不要假设该源码位于目标训练脚本的固定父目录，也不要把个人路径写进通用代码。
- 数据目录优先级：显式 `dir`／`--dir` > 环境变量 `MINIWANDB_DIR` > 当前工作目录下的 `miniwandb_runs`。显式参数优先于环境变量。
- 推荐在训练入口解析一次绝对路径，传给 `init()`，打印 `run.id` 和 `run.dir`。网页服务必须读取同一路径；切换网页目录不会改变训练写入位置。
- 所有实验写入该目录的 `experiments.sqlite3`，每次日志调用提交事务。训练不依赖网页在线；不需要额外调用 `flush()` 或通过 HTTP 上传。
- 网页启动命令为 `python -m miniwandb serve --dir /path/to/miniwandb_runs --port 8080`。端口属于网页服务，不是训练接口参数。

推荐目录写法：

```python
import os
from pathlib import Path

LOG_DIR = Path(os.environ.get("MINIWANDB_DIR", "./miniwandb_runs")).expanduser().resolve()
```

## 2. 公开 API：按这些签名生成代码

```text
miniwandb.init(project="default", name=None, config=None, notes="", tags=None,
              dir=None, id=None, resume=False, capture_output=False) -> Run
miniwandb.Run(...)  # 构造参数与 init 相同，直接创建独立对象，不设置模块级 run

run.log(data, step=None)
run.update_config(values)
run.log_evaluation(dataset, metrics, *, name="final", metadata=None, replace=False)
run.log_output(text)
run.finish(exit_code=0)

miniwandb.log(data, step=None)
miniwandb.log_evaluation(dataset, metrics, *, name="final", metadata=None,
                        replace=False, run_id=None, dir=None)
miniwandb.finish(exit_code=0)
miniwandb.log_output(text)
miniwandb.attach_output(path, *, run_id, dir=None, replace=False)

run.id       # 字符串；自动生成，或由 init(id=...) 指定
run.dir      # 解析后的数据目录，Path 对象
run.step     # 下次自动记录使用的 step，即已有最大 step + 1；初始为 0
run.config   # 配置副本；持久化修改用 update_config()
run.summary  # 各训练指标最后值的副本，不是最优指标
miniwandb.run  # 模块级活动 Run，结束后为 None
```

配置可传字典、`argparse.Namespace` 或 dataclass；支持嵌套字典、列表、基本 JSON 值及 Path。附加 fold／分组参数时复制原配置，不为日志修改训练配置的含义。建议记录模型、数据版本、seed、优化器及适配器等实际超参数，以便网页比较。

训练指标 `data` 必须是非空扁平映射，键为非空字符串，值为数值标量或 `None`。支持能用 `.item()` 转为标量的对象；多元素 tensor／数组、预测向量、字符串、图片不能作为指标。非有限数保存为缺失值。最终评估遵循同样的标量约定，并且不接受布尔分数。

不生成不存在的接口：没有 `run.save()`、`run.flush()`、`run.log_table()`、`run.log_artifact()`；`run.summary[...] = ...` 不持久化。不要假设支持 W&B 的 `watch`、artifacts、sweep、`commit=False`、`mode`、`entity`、`group` 或配置对象的完整行为。只使用本节签名；CV 分组字段放入 `config`。

## 3. 生命周期与最小修改规则

推荐 `with miniwandb.init(...) as run:` 包住一次完整实验：训练 → 验证 → 按原逻辑加载选定 checkpoint → 所有最终测试集 → 结束。不要为验证、加载模型或每个测试集重新初始化实验。

`with` 正常退出标记 `finished`，异常退出标记 `failed` 并继续抛出。普通 `init()` 是模块级接口，再次调用会先结束原活动实验；不能当成无副作用的重复初始化。

已有代码若在模型初始化函数里同时初始化日志，而该函数会在测试阶段再次调用，应将日志初始化移到实验边界，或在确定仍属于同一个实验时复用活动 run。各 folds 之间必须正确结束，不能用一个全局 run 混装所有 folds。

若保留模块调用形式，可使用别名并处理异常：

```python
import miniwandb as wandb

wandb.init(project="example", config={"learning_rate": 1e-4}, dir=LOG_DIR)
try:
    # 替换为原训练和评估流程；以下仅演示记录接口。
    wandb.log({"train/loss": 0.4}, step=0)
    wandb.log({"valid/accuracy": 0.8}, step=0)
    wandb.log_evaluation("test", {"accuracy": 0.79})
except BaseException:
    wandb.finish(exit_code=1)
    raise
else:
    wandb.finish()
```

保留已有记录开关及分布式 rank 条件；关闭记录时不调用未初始化的 run。多进程／DDP 中只让主进程或 rank 0 记录同一个实验，不能跨进程共享 `Run`，也不让多个进程同时写同一 run ID。原有跨设备指标聚合方式保持不变。

`kill -9`、断电等无法执行结束处理，记录可能仍显示 running；不要承诺自动进程心跳或自动恢复训练。

## 4. step、epoch、最优结果

- 首选复用原有累计 batch 数或 optimizer 更新计数作为 step，训练与验证使用同一口径。
- 每轮只记录一次汇总时可以 `step=epoch`；按 batch 记录时不能所有 batches 都使用同一个 epoch 作为 step。
- 显式 step 为非负整数，不能倒退；同一 step 不同指标合并，同名指标后写覆盖前写。
- 自动 step 从 0 开始，每次 `log()` 增加一次。不要随意混用自动和显式计数。
- 显式记录 `"epoch": epoch` 才能使用 Epoch 横轴。保留原指标含义，名称可沿用 `train/loss`、`valid/sp` 等 `/` 前缀。
- `summary` 是最后值。最优指标需要在原 checkpoint 更新分支调用 `log({"best/metric": value, "best/epoch": epoch}, step=...)`。
- 动态阈值等需要持久保存时调用 `run.update_config(...)`。不要改变原阈值选择逻辑、模型选择指标或 checkpoint 保存方式。

## 5. k-fold 与重跑契约

向每折的 config 增加以下字段，不改原数据划分和循环范围：

| 字段 | 含义 |
| --- | --- |
| `cv_id` | 非空字符串，一种配置的一整轮 CV 共享；在 fold 循环外生成 |
| `cv_name` | 组显示名称，可包含模型／关键超参数，建议显式提供 |
| `fold` | 当前折编号，0 起始，满足 `0 <= fold < n_splits` |
| `n_splits` | 真实总折数，2～100 的整数，不是当前折号或本次执行次数 |

同一项目、同一 `cv_id` 的总折数必须一致。不同模型配置或新的一轮重复实验生成新 `cv_id`。只重跑某折时复用原 `cv_id` 和折号，创建新的 run ID。只有 `fold` 不会自动归组；`cv_name` 相同也不代表同一组。

`cv_id` 没有隐式环境变量机制。需要跨进程／重新启动复用时，由训练入口显式读取或接收它，并将值传入 config。不要把 `cv_id` 当作每折的 run ID。

运行中或失败的 folds 不参与组统计。每折默认取创建时间最近、成功完成的尝试，可通过网页「用于统计」指定；不会按重跑得分选最高值。部分 folds 未执行时保留真实 `n_splits`，网页显示不完整进度，不擅自调整训练折数。

下面是可运行的模拟模板。实际接入时替换模拟训练与分数，保留用户的真实模型流程及折数：

```python
import os
import uuid
from pathlib import Path
import miniwandb

LOG_DIR = Path(os.environ.get("MINIWANDB_DIR", "./miniwandb_runs")).expanduser().resolve()

def main():
    cv_id = os.environ.get("CV_ID") or uuid.uuid4().hex
    n_splits = 2
    print("CV ID:", cv_id)
    for fold in range(n_splits):
        with miniwandb.init(
            project="example", name=f"baseline_fold_{fold}", dir=LOG_DIR,
            config={"cv_id": cv_id, "cv_name": "baseline_lr_1e-4", "fold": fold,
                    "n_splits": n_splits, "learning_rate": 1e-4, "seed": 42},
        ) as run:
            print("Run ID:", run.id, "Data directory:", run.dir)
            for epoch in range(3):
                run.log({"epoch": epoch, "train/loss": 1 / (epoch + 1),
                         "valid/accuracy": 0.75 + epoch * 0.02}, step=epoch)
            # 实际使用时，在原代码选定的模型上分别评估并记录。
            run.log_evaluation("test_a", {"accuracy": 0.78 + fold * 0.01},
                               metadata={"checkpoint": "best"})
            run.log_evaluation("test_b", {"accuracy": 0.72 + fold * 0.01},
                               metadata={"checkpoint": "best"})

if __name__ == "__main__":
    main()
```

## 6. 多测试集最终评估契约

训练中验证曲线用 `log()`；选定模型的最终测试结果用 `log_evaluation()`，独立于训练 step 和 summary。不要把一次测试集评估伪装成训练序列。

每个测试集评估返回后立即调用 `run.log_evaluation(dataset_name, scalar_metrics, ...)`，保持变量与真实返回顺序一致。测试集名称单独传入，指标键用 `accuracy`、`sp` 等，不重复写 `test_a/accuracy`。所有模型间统一指标名称、大小写和测试集名称；不要改变指标本身。

同一 `(run_id, dataset, name)` 唯一，默认 `name="final"`。相同 metrics 和 metadata 重传不会重复计数；不同内容默认报错，更正需显式 `replace=True`。不要为绕过冲突自动添加覆盖参数；另一个 checkpoint 使用 `name="best"`／`"last"` 等不同版本。

metadata 可保存 checkpoint 路径、阈值、epoch、seed、样本数等；只保存元数据，不上传或复制权重。训练日志所在 run 结束后，不能再用该对象的 `log_evaluation()`；独立补录用：

```python
import miniwandb

miniwandb.log_evaluation(
    "test_a", {"accuracy": 0.86},
    run_id="existing-run-id", dir="./miniwandb_runs",
    metadata={"checkpoint": "best.pt"},
)
```

原实验必须存在且不在回收站。显式 run ID 的补录无需 `init()` 或 `resume=True`，不改变实验状态。未指定 run ID 时，模块接口写入活动 run，不能再传 `dir`；目录由初始化确定。

箱线图每点是一个 fold 的最终得分，柱状图显示均值和样本标准差 `ddof=1`。缺失不补零，单点不计算标准差；代表 fold 没有评估时不会用旧重跑补齐。不要为产生箱体复制分数，也不要将逐样本预测值混作 fold 分数。

## 7. 断点续记

恢复同一实验使用 `init(id=原run_id, resume=True, dir=原目录)`。run ID 必须已存在；恢复保留原配置、名称、历史和 CV 分组，不会因为传了新 config 自动覆盖。

恢复模型、优化器、调度器、epoch／global step 仍是训练代码的职责。自动计数可从 `run.step` 接续；显式 step 不得小于已保存最大值。继续别的 fold 或创建一次重跑，应创建新 run，不复用旧 fold 的 run ID。

## 8. 验收与交付

用户需要单次训练的控制台日志时，在 `init()`／`Run()` 中显式设置 `capture_output=True`，尽量放在模型加载前。终端输出仍保留，初始化之后的 Python `sys.stdout`／`sys.stderr` 会镜像到实验数据库，详情页 `/runs/RUN_ID` 可增量查看并下载完整 `output.log`。默认关闭，每个进程同时只允许一个捕获输出的实验，结束时恢复原 streams；resume 追加日志。

`run.log_output(text)` 和模块级 `log_output(text)` 向活动实验追加字符串，不推进 step。结束后补录 UTF-8 文件使用 `attach_output(path, run_id=..., dir=..., replace=False)`，原实验必须非运行中且不在回收站，已有日志时需显式 `replace=True` 才覆盖。日志保存在数据库中，不生成独立实体文件；不通过浏览器向服务传入任意服务器路径。

捕获不覆盖初始化前输出、子进程、C 层文件描述符、二进制 buffer，以及初始化前已绑定旧 stream 的部分日志 handler／进度条；必要时保留原日志文件并补录。不要承诺历史日志自动恢复。失败结束处理可保存 traceback，强制终止仍无法执行收尾。

完成修改后检查可观察行为，而不是只替换导入名：

- 一个独立实验／fold 只创建一条记录；训练与最终测试确实共用该记录。
- 训练和验证的 step 一致且不倒退，原 metric、CSV 和 checkpoint 行为保留。
- 各测试集最终结果对应正确返回值，CV ID 生成位置和真实总折数正确。
- 正常结束为 finished，普通异常结束为 failed；记录开关和 rank 条件正确。
- 训练目录与给出的网页启动命令一致，说明实际 run ID／CV ID 的获取方式。

优先做语法检查和临时目录中的轻量模拟。目标脚本可能在模块顶层加载模型／初始化 GPU，不要为验证日志而直接 import 或启动完整训练；可提取记录函数并模拟训练依赖。只在用户要求时启动实际训练，不向真实记录目录写入演示数据。

交付实际修改及简洁说明：改了哪些接入点、保存目录、启动网页命令、验证方式及尚未验证的部分。若包未安装或 API 版本不匹配，明确给出所需环境步骤，不用伪造接口或静默丢弃日志来掩盖问题。
