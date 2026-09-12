# `gi-ml` Roadmap

## 1. Roadmap Goal

本路线图只定义阶段目标、交付物和升级顺序。
不写具体公式，也不预先锁死训练算法细节。

## 2. Phase A: Documentation And Contracts

### Objective

- 建立 `gi-ml` 的独立边界
- 固定概念发现、概念验证、排序训练的数据契约

### Deliverables

- `README.md`
- `docs/architecture.md`
- `docs/data-contracts.md`
- `docs/roadmap.md`
- `schemas/*.schema.json`

### Exit Criteria

- 文档能解释 `gi-ml` 与 `gi-agent` 的职责分工
- 关键对象已有统一命名
- 公式未定也不阻碍后续接口开发

## 3. Phase B: Decision Lake Refactor

### Objective

- 将当前平面 `(state, action, label)` 数据组织升级为 `query-group`

### Deliverables

- 新的数据湖结构
- `query_id` / `candidate_id` 稳定生成规则
- branch-eval 到 pairwise data 的导出器
- combat-window 到 concept hypothesis 的桥接导出器

### Exit Criteria

- 至少一种数据源可稳定导出 query-group 排序数据
- 训练集能够保留证据追踪关系

## 4. Phase C: Ranking Baseline

### Objective

- 先建立不依赖神经 CBM 的排序基线

### Deliverables

- 显式概念特征接口
- pairwise / groupwise ranker baseline
- 与现有 `EvaluatorPolicy` 的离线对比脚本

### Exit Criteria

- 新 ranker 能在离线验证中跑通
- 线上仍可以保留 heuristic fallback

## 5. Phase D: Concept Validation Pipeline

### Objective

- 建立概念候选的自动验证与淘汰机制

### Deliverables

- concept discovery 产物格式
- concept validator
- concept bank 版本化机制
- validation summary 导出

### Exit Criteria

- 至少支持 `draft -> validated -> deprecated` 生命周期
- 概念增益可以被离线评估

## 6. Phase E: Concept Bottleneck Integration

### Objective

- 让概念层进入排序器和在线解释链路

### Deliverables

- concept predictor
- concept-aware ranker
- 在线解释输出格式
- runtime export bridge

### Exit Criteria

- 在线推理能输出概念解释
- 出错时可以安全回退到 baseline

## 7. Phase F: Active Learning And Self-Acceleration

### Objective

- 让系统自动挑选最有价值的验证样本与训练样本

### Deliverables

- 高 regret / 高分歧样本选择器
- workload triage
- concept bank 滚动升级流程
- 自动淘汰低价值概念的规则框架

### Exit Criteria

- 训练数据不再主要依赖人工挑选
- 新概念能够通过闭环自动进入或退出系统

## 8. Parallelization Guidance

后续开发建议按以下并行面切分：

- 文档 / schema
- 数据导出器
- 概念发现
- 概念验证
- 排序训练
- 在线集成

这样可以避免在线系统与离线训练强耦合推进。

## 9. Recommended Rewrite Scope

建议重写的部分：

- 学习数据湖
- 训练脚本
- 排序器
- 概念验证器

不建议重写的部分：

- 模拟器
- runtime action legality
- 现有搜索主链

## 10. Open Decisions

这些问题当前有意留空，等待后续实验再定：

- 概念发现的主算法
- 概念验证的核心指标
- ranker 的最终主模型
- 概念预测器与排序器是否联合训练
- 在线 rerank 的具体分解公式

## 11. Immediate Next Steps

从当前状态继续，优先级建议如下：

1. 补 `src/contracts`
2. 设计 query-group 数据湖
3. 为 branch-eval 增加标准 pairwise 导出
4. 为 combat-window 增加 concept hypothesis 导出
5. 引入第一版排序 baseline

## 12. Candidate Enhancements

以下方向不阻塞当前主线，但值得作为后续增强候选：

- 将静态卡牌 / 技能效果编译为跨牌共享的 meta priors，用于 observation、candidate 和 concept seed

相关方案文档：

- [static-effect-meta-priors.md](<repo-root>/packages/gi-ml/docs/static-effect-meta-priors.md)
