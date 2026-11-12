# 将实验结果提供给 AI 分析

MiniWandb 可以将选中的实验导出为 ZIP 分析包，用于分析训练曲线、收敛和过拟合迹象、模型及超参数差异、交叉验证稳定性，以及多个测试集的最终结果。

导出只在本地读取数据，不调用 AI 服务。将下载的文件提供给你选择的 AI 工具后再进行分析。训练脚本无需增加额外调用；已有本地实验和导入的 W&B 标量记录都可以导出。

## 网页操作

1. 在实验列表中勾选需要比较的实验。
2. 点击页面顶部的 **AI 分析包**。单次训练详情页也提供该按钮。
3. 可选填写主指标及其方向、训练 step 的实际含义、任务背景和评估协议。
4. 选择是否附带控制台日志末尾，然后点击 **生成并下载 ZIP**。
5. 解压，将 `analysis_instructions.md`、`report.md` 和 JSON／CSV 一起提供给 AI。

选中 CV 组内任意一条记录，会展开同一视图下该组的所有 folds 和重跑记录。每次展开后最多 100 条实验；较大的集合请分批导出。普通视图不含回收站记录，回收站视图只导出其中的记录。运行中的实验也可导出，内容为生成时的数据库快照。

建议说明：训练和验证 loss 的计算口径、数据集版本及划分方式、checkpoint 的选择方式，以及最终评估是否使用同一个 checkpoint。未填写的信息保留为未知。

## 命令行

先查找实验 ID：

```bash
python -m miniwandb list --dir ./miniwandb_runs
```

导出一条或多条实验，自动展开所属 CV 组：

```bash
python -m miniwandb export-ai RUN_ID_A RUN_ID_B \
  --dir ./miniwandb_runs \
  --output ./reports/comparison.zip \
  --primary-metric valid/mcc --direction max \
  --step-unit epoch \
  --context "比较 baseline 和候选模型；训练预算相同" \
  --evaluation-protocol "按验证集 MCC 选择 checkpoint，再在保留测试集上评估"
```

示例中的背景与协议需要替换为实际情况。`--step-unit epoch` 仅在记录的 step 确实表示 epoch 时使用；若训练 step 为累计 batch，应使用 `batch`。可选值为 `unknown`、`batch`、`optimizer_step`、`epoch`。

其他选项：`--no-output` 不附带日志；`--max-points 300` 设置每条指标曲线的抽样上限（60–1000）；`--trash` 从回收站读取。

## 包内文件

| 文件 | 内容 |
| --- | --- |
| `analysis_instructions.md` | 分析任务、证据要求与解释限制，可直接交给 AI |
| `report.md` | 实验清单、曲线统计、最终评估和缺失信息 |
| `experiments.json` | 结构化原始配置、状态、CV 归属、曲线统计、抽样点、最终评估及代表记录选择依据 |
| `sampled_curves.csv` | 各实验各指标的抽样曲线，含 step、已记录的 epoch、时间和值 |
| `parameter_comparison.csv` | 各实验参数并列表，区分未记录和显式 null |
| `final_scores.csv` | 最终分数宽表，每行一个实验＋测试集＋评估版本，各指标并列成列，标明组名、fold 及代表记录 |
| `final_scores_long.csv` | 同一批结果的逐指标长表，适合程序处理；包含缺失值和每次尝试 |
| `cv_summary.csv` | 按代表 fold 统计的最终评估均值、样本标准差和各折原始值 |
| `output_excerpt/*.log` | 可选，每条实验最后最多 16,384 个字符；映射在 JSON 中 |

JSON 使用 `schema_version: miniwandb.ai.v1`。参数 CSV 的键路径为 JSON 数组，避免嵌套键与包含点号的键混淆。CSV 空数值代表缺失；参数中的 `<not-recorded>` 表示未记录，`null` 表示保存过空值。可能被表格软件解释成公式的文本会加单引号，原文以 JSON 为准。

### 最终分数的组织方式

`final_scores.csv` 按测试集 → 评估版本 → 项目 → 模型／CV 组 → fold → 尝试时间排序。列先描述结果归属和记录身份，再列 checkpoint、各指标和原始评估元数据：

```text
dataset, evaluation, project, group_name, group_kind, cv_group_id,
fold, n_splits, run_name, run_id, status, is_representative,
selection_reason, checkpoint, metric/mcc, metric/sp, ..., metadata
```

指标列根据实际记录生成，统一添加 `metric/` 前缀，避免与 `fold`、`status` 等身份列重名。`experiments.json` 的 `export_formats` 保存列名与原始指标名的对应关系。宽表的空格可能表示该指标未记录或显式为空，精确区别可查看 JSON，或长表是否存在对应指标行。

- `is_representative=True`：该实验是本次组汇总采用的记录。
- `selection_reason=manual_preferred`：手动指定的代表记录。
- `selection_reason=latest_finished`：默认选取的最近成功记录。
- `selection_reason=superseded_attempt`：已完成但未用于本次统计的旧尝试。
- `selection_reason=not_finished`：CV 中未成功完成的尝试，如运行中、失败或状态未知的记录。

独立实验标记为 `group_kind=single_run`，CV 标记为 `cv`。所有尝试仍保留；分析组结果时，应按代表标记取值，或直接使用 `cv_summary.csv`。长表与宽表是同一批结果的两种排版，不能合并后重复计数。

网页的「交叉验证组对比」也可选择 **最终测试集评估 → 测试集 → 评估版本 → 指标**，核对包内采用的分数；选择组内任意记录即可比较完整组。

## 统计范围与解释

- 所有文件从同一个只读数据库快照生成。导出不更改训练状态或实验数据。
- 曲线的计数、首末值、最小／最大值、最佳值和尾窗统计来自完整历史。长曲线按观测数分桶，保留每桶端点、极值及首末缺失点，再输出有界抽样。
- 尾窗最多使用最后 50 个有限观测，前一窗最多 50 个；趋势斜率按记录 step 计算，不自动换算为 epoch。缺失不补零。
- 主指标方向可显式指定，其他常见指标根据名称推断并标明来源；未知方向不计算最佳值。学习率、epoch、阈值不自动当作成绩。
- epoch 来自同一步或此前最近一次显式记录的 `epoch`；没有记录就保留为空。
- CV 每折使用手动指定、或创建时间最近且成功完成的记录。不会因为某次得分更高而选择它。运行中、失败、未知状态不会参与成功折汇总；其历史仍保留供诊断。
- 最终结果按测试集、评估版本与指标分别汇总，使用样本标准差 `ddof=1`。仅一个分数时标准差为空。代表记录缺少评估时不回退到旧尝试。
- 训练历史中不同指标的最佳值可能来自不同 checkpoints。最终模型的联合指标应以独立最终评估为准。

抽样曲线不能代替全部原始历史。需要分析精确的尖峰、每一步的震荡或更早的报错时，可再从单次训练详情页下载原始历史和完整 `output.log`。

## 可直接使用的提示词

```text
先读取 analysis_instructions.md，再结合 report.md 和 experiments.json，
核对 CSV 中的原始分数及曲线证据。

请分析训练趋势、收敛与过拟合迹象、模型和超参数差异、CV 稳定性、
以及不同测试集上的最终结果。每个判断给出 run ID、指标、step/epoch 和数值。
区分观测事实、可能解释及建议验证；缺失信息明确列出，不编造数据。
不要将不同 checkpoint 的各指标最佳值拼成一个模型结果，
不要用最终测试集选择超参数，也不要将误差棒差异直接解释为统计显著。
```

分析包描述已有记录，不自动证明数据无泄漏、训练已经收敛或某个超参数具有因果作用。是否具备这些结论的证据，需要结合数据划分和评估协议判断。
