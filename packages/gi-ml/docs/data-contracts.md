# `gi-ml` Data Contracts

## 1. Goal

本文件定义 `gi-ml` 的核心数据对象与引用关系。

当前重点是：

- 统一命名
- 固定对象边界
- 为后续 schema、训练器、导出器提供共同契约

具体公式、统计口径和指标字段暂不固化。

## 2. ID Strategy

建议使用以下 ID：

- `query_id`
  - 唯一标识一个决策点
- `candidate_id`
  - 唯一标识一个候选动作
- `concept_id`
  - 唯一标识一个概念
- `annotation_id`
  - 唯一标识一个概念注释
- `dataset_id`
  - 唯一标识一份训练集导出
- `bank_version`
  - 唯一标识一版 concept bank
- `validation_run_id`
  - 唯一标识一次概念验证运行

## 3. Core Entities

### 3.1 Decision Point

表示“一次决策时刻及其候选动作组”。

建议字段：

- `query_id`
- `source`
- `state_ref`
- `matchup_ref`
- `deck_refs`
- `candidate_ids`
- `evidence_refs`
- `context_slots`

说明：

- `context_slots` 用于预留尚未定型的上下文信息
- 不应把所有上游原始 JSON 内联到该对象中

### 3.2 Candidate Action

表示某个决策点下的一个合法动作。

建议字段：

- `candidate_id`
- `query_id`
- `action_case`
- `action_definition_ref`
- `raw_feature_ref`
- `tree_match_ref`
- `branch_eval_ref`
- `runtime_slots`

### 3.3 Pairwise Preference

表示同一决策点下，动作 A 相对动作 B 更优的监督关系。

建议字段：

- `query_id`
- `candidate_a_id`
- `candidate_b_id`
- `preference_label`
- `confidence`
- `evidence_ref`
- `preference_slots`

说明：

- `preference_label` 的具体值域后续再固定
- 当前只要求支持“偏好方向 + 置信度 + 证据来源”

### 3.4 Concept Hypothesis

表示待验证的概念候选。

建议字段：

- `concept_id`
- `name`
- `scope`
- `description`
- `evidence_refs`
- `tags`
- `estimator_slot`
- `validation_slot`
- `ranking_slot`
- `status`

作用域建议：

- `state`
- `state_action`
- `window`

### 3.5 Concept Annotation

表示某个概念在具体目标上的值、标签或解释。

建议字段：

- `annotation_id`
- `concept_id`
- `target_ref`
- `label_slot`
- `confidence`
- `source`
- `annotation_slots`

### 3.6 Concept Validation Run

表示一次对概念候选的离线验证。

建议字段：

- `validation_run_id`
- `concept_id`
- `input_refs`
- `result`
- `summary_slots`
- `created_at`

### 3.7 Concept Bank

表示可用于线上或离线评估的一版概念集合。

建议字段：

- `bank_version`
- `concepts`
- `validation_summary`
- `compatibility`
- `deprecation_rules`
- `created_at`

### 3.8 Ranking Dataset

表示可训练的排序数据导出包。

建议字段：

- `dataset_id`
- `created_at`
- `query_groups`
- `pairwise_preferences`
- `concept_target_refs`
- `metadata`

## 4. Reference Types

为避免大对象复制，建议统一使用 `*_ref` 字段指向外部工件：

- `state_ref`
- `evidence_ref`
- `raw_feature_ref`
- `branch_eval_ref`
- `tree_match_ref`
- `concept_target_ref`

引用目标可以来自：

- 本地 JSON / SQLite / parquet / arrow
- tree-lake 条目
- branch-eval report 条目
- replay 文件片段
- runtime artifact

## 5. Contract Rules

### 5.1 Stability Rules

- `query_id` 在同一数据版本内必须稳定
- `candidate_id` 必须在 `query_id` 范围内可唯一定位
- `concept_id` 一旦发布，不应复用给不同语义

### 5.2 Traceability Rules

- 所有监督信号都应能追溯到 `evidence_ref`
- 所有概念候选都应能追溯到来源窗口或来源样本
- 所有训练集导出都应带版本和生成时间

### 5.3 Compatibility Rules

- `concept bank` 必须声明与 runtime digest 版本的兼容关系
- 排序模型必须声明与特征版本的兼容关系
- 当上游 artifact schema 升级时，允许概念降级或失效

## 6. Placeholder Slots

当前明确保留以下占位位：

- `context_slots`
- `runtime_slots`
- `preference_slots`
- `estimator_slot`
- `validation_slot`
- `ranking_slot`
- `label_slot`
- `annotation_slots`
- `summary_slots`

这些字段存在的目的是：

- 让接口先稳定
- 让公式和指标后补
- 避免第一阶段因为指标未定而阻塞整体架构

## 7. Minimal JSON Examples

### 7.1 Concept Hypothesis

```json
{
  "concept_id": "concept_window_burst_threshold_v1",
  "name": "burst-threshold-window",
  "scope": "state",
  "description": "Placeholder description.",
  "evidence_refs": [
    "tree:tree_123",
    "branch_eval:matchup_x:point_7"
  ],
  "tags": [
    "tempo",
    "window"
  ],
  "estimator_slot": null,
  "validation_slot": null,
  "ranking_slot": null,
  "status": "draft"
}
```

### 7.2 Pairwise Preference

```json
{
  "query_id": "query_00042",
  "candidate_a_id": "query_00042:candidate_1",
  "candidate_b_id": "query_00042:candidate_3",
  "preference_label": 1,
  "confidence": 0.78,
  "evidence_ref": "branch_eval:matchup_x:point_7",
  "preference_slots": null
}
```

## 8. Next Contract Work

下一步建议把本文档落成：

1. JSON Schema
2. TS 类型定义
3. Python dataclass / pydantic 模型
4. 数据导入导出 CLI
