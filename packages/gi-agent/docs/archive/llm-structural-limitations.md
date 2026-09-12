# LLM 结构化输出的局限与对策

> 为 llm-deck-analyzer 策略图功能设计而整理，也可作为 LLM Benchmark 设计参考。

## 1. 问题域

在 GI TCG AI 系统中，LLM 承担了"将人类可读的卡组信息转化为机器可用的策略数据"的角色。核心挑战：如何让 LLM 输出**结构化、可验证、引用完整性正确**的非线形数据。

## 2. LLM 结构化生成的核心局限

### 2.1 引用完整性问题 (Referential Integrity)

LLM 在生成包含 ID 引用关系的数据（如 node → edge 的 from/to 指向）时，容易产生：

| 问题 | 表现 | 频率估计 |
|------|------|----------|
| **Dangling reference** | edge.from 或 edge.to 指向不存在的 node id | ~15-30% |
| **ID drift** | 两轮生成之间 node ID 不一致（拼写变化、重命名） | ~10-20% |
| **Duplicate ID** | 同一次生成中重复使用同一个 ID | ~5% |
| **Self-loop** | edge.from === edge.to（无意义的自环） | ~3-8% |

**根因**：LLM 的 token-by-token 自回归解码没有全局约束求解能力。它无法在生成 edge 时"回顾"node 列表确保 ID 存在——它只是在概率空间中选择下一个 token。

### 2.2 结构化深度与质量的 Trade-off

| 输出复杂度 | 成功率 | 内容质量 | 适用场景 |
|-----------|:------:|:------:|---------|
| 线性文字描述 | ~98% | 良好 | 单线策略分析 |
| 单层结构化 (带 Zod schema 约束) | ~90% | 良好 | DeckAnalysis JSON |
| 多层嵌套结构化 (嵌套数组) | ~75% | 中等 | actionPlan |
| 跨对象引用结构化 (图) | ~55-70% | 中等偏下 | StrategyGraph |

**根因**：随着结构深度增加，LLM 需要在更多 token 上维持一致性。每多一层嵌套或引用，错误概率乘性增长。

### 2.3 策略表达的非线性 vs LLM 的线性输出

TCG 策略本质上是**分支网络**（condition tree / strategy graph），但 LLM 的输出本质上是**线性序列**。

强制 LLM 在单轮中输出完整图结构会导致：
- 节点列表趋向单一路线（忽略分支）
- 边的条件描述模糊（"视情况而定"）
- 遗漏关键备选路线

## 3. 对策体系

### 3.1 多轮分解 (Multi-Round Decomposition) ← 当前采用

将图生成分解为独立的 LLM 调用：

```
Round 1: 生成节点列表（纯列表，无跨引用）
    → 输出: [{id, type, label, ...}]
    
Round 2: 基于 Round 1 的节点列表，生成边
    → 输入: Round 1 的完整 JSON
    → 输出: [{from, to, type, condition, weight}]
```

**优势**：
- 每轮任务认知负载低
- Round 2 可以直接引用 Round 1 的实际 ID
- 减少 70-80% 的 dangling reference

**代价**：
- 双倍 API 调用（成本 ×2）
- 两轮延迟（~60-120s 额外等待）
- 仍无法 100% 消除引用错误

### 3.2 后验验证 (Post-Hoc Validation) ← 当前采用

无论采用何种生成策略，**必须**做后验验证：

```typescript
validateStrategyGraph(graph):
  1. 检查 node ID 唯一性
  2. 检查所有 edge.from / edge.to 指向存在的 node
  3. 检查无自环
  4. 检查至少有一个入口节点（无入边的节点）
```

验证失败时的策略：
- 重试 Round 2（仅重新生成 edges）
- 自动修复：删除 dangling edge
- 降级：使用 heuristic 规则图（模块已有 `buildDeckGraph`）

### 3.3 ID 模板约束 (Constrained ID Format)

强制 node ID 使用 `snake_case` 格式：

```
正则约束: /^[a-z][a-z0-9_]*$/
示例: shenhe_opener, ayaka_burst, freeze_stall
```

**优势**：
- 减少 LLM 的命名自由度 → 减少 ID drift
- 符合代码规范，下游可直接使用

### 3.4 Schema-Driven Generation (未来方向)

使用结构化输出 API（如 OpenAI `response_format`、Anthropic `tool_use`）强制 JSON 输出，而非依赖 prompt 中的 "只返回 JSON" 指令。

**预期改善**：
- JSON 格式正确率从 ~90% → ~99%
- 引用完整性改善有限（API 不做跨字段约束验证）

## 4. 策略图 vs 线性计划：适用性矩阵

| 卡组特征 | 线性计划可用？ | 策略图需要？ |
|----------|:---:|:---:|
| 单核心路线，无分支 | ✅ 充分 | ❌ 冗余 |
| 有主路线 + 1条备选 | ✅ 勉强 | ✅ 更准确 |
| 2+ 条同等重要路线 | ❌ 不足 | ✅ 必要 |
| 高度对局依赖（if opponent X → plan A） | ❌ 不足 | ✅ 必要 |
| Combo 依赖卡牌顺序 | ✅ 充分 | ❌ 冗余 |

## 5. Benchmark 设计建议

### 5.1 结构化输出质量指标

| 指标 | 测量方法 | 目标值 |
|------|---------|:----:|
| JSON 格式正确率 | 解析成功率 | >95% |
| 引用完整性 | dangling reference 比例 | <5% |
| Node 覆盖率 | 人工标注 vs LLM 输出节点比 | >80% |
| Edge 合理性 | 人工评分 (1-5) | >3.5 |
| 分支充分性 | 条件边的比例 | >20% |

### 5.2 建议的 Benchmark 数据集

1. **10 套核心卡组**（已在 benchmark.10-deck-core.json 中定义）
2. **每套卡组人工标注**：
   - 预期策略节点列表（4-10 个）
   - 预期关键边（transitions + branches）
   - 预期分支条件类型
3. **跨模型对比**：deepseek-v4-flash vs minimax-m2.5 vs claude-sonnet-4

### 5.3 已知 Failure Mode 清单

| Failure Mode | 示例 | 检测手段 |
|-------------|------|---------|
| 单线思维 | 10 个节点都是同一路线的不同描述 | 检查节点 type 多样性 |
| 幻觉卡牌 | 编造不存在的天赋卡效果 | 卡牌名白名单验证 |
| 模糊触发条件 | "视情况而定" | 正则匹配 |
| ID 复制粘贴 | node_1, node_2, node_3 无实际区分 | 检查 label/description 唯一性 |
| 边权重两极 | 所有权重 = 1.0 或 0.0 | 统计分布检查 |

## 6. 实现位置

- 类型定义：`packages/llm-deck-analyzer/src/types.ts` (StrategyGraph)
- Prompt 构建：`packages/llm-deck-analyzer/src/analyzer.ts` (buildStrategyNodesPrompt / buildStrategyEdgesPrompt)
- 两轮分析：`packages/llm-deck-analyzer/src/llm/llm-deck-analyzer.ts` (analyzeDeckGraph)
- 验证逻辑：`packages/llm-deck-analyzer/src/analyzer.ts` (validateStrategyGraph)

## 7. 后续工作

- [ ] 策略图 → deck-prior-provider 集成（将图结构输入到 RL 策略中）
- [ ] 图结构在多卡组 matchup 中的应用（对手策略节点 → 对策节点）
- [ ] Schema-driven generation 接入（zod → JSON schema → API structured output）
- [ ] 图可视化工具（策略图的 Web UI 展示）
