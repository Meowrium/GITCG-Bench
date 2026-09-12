# Paper Scout Deep Analysis — 2026-W22 Summary

**Date**: 2026-05-25 | **Analyst**: Paper Scout Deep Analysis Agent
**Papers analyzed**: 5 (2 ⭐⭐⭐⭐⭐, 3 ⭐⭐⭐⭐)

---

## Executive Summary

本周 2026-W22 是 paper-scout 系统的**首次运行**，14 篇新论文入库。我们对其中的 5 篇高分论文做了架构级深度分析。核心发现：

- **最高优先级落地项**来自一篇"胜率没有提升"的论文——2605.06066（MTG Causal RL）的**统计评估协议**可以今天加入 benchmark pipeline，零算法改动。
- **最关键的原型假设**来自 2510.04542（Code World Models）——LLM 能否为 GI TCG 状态产生有用的 deck-conditioned heuristic？回答这个问题决定了 LLM deck prior 的技术路线。
- **最直接的瓶颈解决方案**来自 2206.12700（Action Spaces）——Action embedding 是减少 MCTS per-iteration 开销的最直接思路，但需要从设计文档开始。
- **最大规模参照系**来自 2210.17087（DanZero）——160 CPU × 30 天训练提供了一个量化的 scaling 目标，但当前阶段不需要立即行动。

---

## Action Priority Matrix

| #   | Action                                                                                 | Source Paper  | Priority     | Effort   | Impact      | Note                                                                   |
| --- | --------                                                                               | ------------- | ----------   | -------- | --------    | ------                                                                 |
| 1   | 采纳 pair seed + bootstrap CI + Holm-Bonferroni 协议                                   | 2605.06066    | ⚡ Today     | Low      | High        | 纯工程改进                                                             |
| 2   | **测量 LLM deck 分析的预测效度**（correlation: predicted strength vs actual win rate） | 2510.04542    | ⚠️ This Week  | Low      | 🔑 Critical | llm-deck-analyzer 已有数据，只需统计分析；结果决定 LLM deck prior 路线 |
| 3   | 设计 GI TCG SCM / 因果图                                                               | 2605.06066    | ⚠️ This Week  | Low      | Medium      | 为 CGT 分析提供因果框架                                                |
| 4   | 测量 MCTS vs DeepMC 效率 tradeoff                                                      | 2210.17087    | ⚠️ This Week  | Low      | Medium      | 利用现有 branch-eval                                                   |
| 5   | **原型：LLM 输出升级为 Runtime State→Value 函数**（CWM-style executable code）         | 2510.04542    | 📅 Next Week | Medium   | 🔑 Critical | 取决于 action #2 结果——如果 JSON 预测效度低则优先做                    |
| 6   | 原型：LLM opponent hand inference                                                      | 2510.04542    | 📅 Next Week | Medium   | High        | 完全新能力，llm-deck-analyzer 未覆盖                                   |
| 7   | 设计 Action Embedding schema                                                           | 2206.12700    | 📅 Next Week | Low      | High        |                                                                        |
| 8   | 原型：Top-k MCTS expansion with action embedding                                       | 2206.12700    | 📅 Next Week | Medium   | High        |                                                                        |
| 9   | Factor-level GBDT interpretability (Shapley)                                           | 2605.06066    | 📅 Next Week | Medium   | Medium      |                                                                        |
| 10  | 原型：MCTS action pruning with value model                                             | 2407.10279    | 📅 Next Week | Low      | Medium      |                                                                        |
| 11  | 设计分布式 Self-Play 架构                                                              | 2210.17087    | 📅 Archive   | Medium   | Low         |                                                                        |
| 12  | 设计 Human Evaluation Protocol                                                         | 2210.17087    | 📅 Archive   | Medium   | Medium      |                                                                        |
| 13  | 原型：Deck Selection 纳入 training loop                                                | 2407.10279    | 📅 Archive   | High     | Low         |                                                                        |

---

## Paper-by-Paper Verdict

### [2510.04542] Code World Models — ⚠️ THIS WEEK (recalibrated)

**Verdict**: 经过检查 `@gi-tcg/llm-deck-analyzer` 代码后发现，我们的 LLM deck prior 原型已经存在且相当成熟——4 层分析管线（数据提取 → P0-P2 启发式 → V2 特征 → LLM 增强），产出 `DeckAnalysis` / `DeckFeaturesV2` 并通过 `LlmDeckPriorProvider` 注入 MCTS policy。**CWM 不是替代品，而是指明了下个进化方向**：从 LLM 产出静态 JSON 分析 → 产出运行时 `evaluate(state) → float` 函数。本周最关键的动作是测量现有 LLM JSON 分析的预测效度（strength vs 实际胜率 correlation），结果决定下一步是继续优化 JSON 路线还是转向 CWM 式可执行代码。另外 CWM 的 `infer_hidden` 模式提示我们对手手牌推理是完全缺失的能力。

### [2605.06066] MTG Causal RL — ⚡ TODAY

**Verdict**: 算法贡献有限（CGFA-PPO 未在胜率上超越 baseline），但**评估方法论可以直接采纳**。Pair seed + bootstrap CI + Holm-Bonferroni 是纯粹工程改进，不改变任何算法。另外 SCM 设计可以今天开始写，作为 CGT 冷热分析的理论配套。

### [2407.10279] AlphaDou — 📅 NEXT WEEK

**Verdict**: 有趣但 priority 不高。双头架构（win rate + expectation）和动作剪枝模式值得借鉴，但 DMC（无搜索）与我们的 MCTS 有根本性差异，移植成本较高。Deck selection ↔ bidding 的类比有价值但 premature——在 deck prior 原型未验证前，不应扩展到 deck selection 训练。

### [2206.12700] Action Spaces — 📅 NEXT WEEK

**Verdict**: 解决 GI TCG MCTS 性能瓶颈的最直接思路，但 paper 细节太少（industry paper on proprietary game），需要从设计文档开始。先写 embedding schema，再考虑原型。本周做 MCTS vs DeepMC tradeoff 测量作为前置——如果测量显示 MCTS 在 200 iterations 已经 sufficient，action embedding 的紧迫性就降低。

### [2210.17087] DanZero — 📅 ARCHIVE

**Verdict**: 重要的规模参照系，但当前阶段不需要行动。160 CPU × 30 天的训练规模在我们验证完 CGT 优化和 deck prior 之前是 premature optimization。本周可以低成本测量 MCTS vs DeepMC tradeoff（利用现有 branch-eval），其他 action items 存档。

---

## Cross-Paper Patterns

### Pattern 1: Evaluation crisis
四篇论文（MTG Causal RL, DanZero, CWM, AlphaDou）都不同程度地质疑或超越了 "纯胜率评估"——MTG Causal RL 提出因子级 causal evaluation，DanZero 做 human evaluation，CWM 强调跨游戏多样性和可验证性。**我们的 benchmark 仅报告胜率，处于这个方法论光谱的最原始端**。这是本周最需要修复的短板。

### Pattern 2: LLM in game AI convergence
CWM (2025) 和 CSRO (2026-03) 来自同一个 DeepMind 团队，展示了从 "LLM writes game model" 到 "LLM writes RL oracle" 的研究脉络。我们的 LLM deck prior 处于这个脉络中——不再是"LLM 直接下棋"的 naive prompt 时代，而是 "LLM 作为代码生成器 / 知识编码器 / 训练信号源" 的新范式。

### Pattern 3: The MCTS vs DeepMC question
DanZero 和 AlphaDou 都用 Deep MC（无搜索），且在各自游戏中达到 SOTA/human-level。我们用的是 MCTS（有搜索）。关键问题是：**在 GI TCG 的具体条件下（~15 rounds, 高方差骰子, ~30-80 actions per decision），tree search 提供的方差减少是否值它们的算力成本？** 本周的 tradeoff 测量实验将回答这个问题。

### Pattern 4: Action space as universal bottleneck
五篇论文都直接或间接提到 large action spaces 是复杂卡牌游戏 AI 的核心瓶颈——Axie Infinity 的 embedding approach、MTG 的 masked action space、CWM 的 `legal_actions()` 组件、Doudizhu/GuanDan 的动作剪枝。**GI TCG 的动作空间（30-80 per decision，含复杂约束如骰子匹配、元素反应链、装备前置条件）在复杂度上属于第一梯队**。Action embedding 是这个瓶颈的最自然解决方案，但需要 domain-specific 的设计。

---

## Next Week's Focus (2026-W23)

1. **Monday-Tuesday**: Complete the evaluation protocol upgrade (pair seed + bootstrap CI + Holm-Bonferroni)
2. **Tuesday-Wednesday**: Run LLM heuristic value function prototype — does the LLM produce useful deck-conditioned evaluations?
3. **Thursday**: Measure MCTS vs DeepMC tradeoff on branch-eval
4. **Friday**: Write GI TCG SCM / causal model design doc → feed into CGT analysis
5. **Ongoing**: Monitor paper-scout for next batch of new papers

---

## File Manifest

```
paper-scout/
├── 2026-W22.md                        # Original weekly digest
├── seen.txt                           # Dedup list (14 entries)
├── papers/
│   ├── 2510.04542.md                  # CWM summary
│   ├── 2605.06066.md                  # MTG Causal RL summary
│   ├── 2407.10279.md                  # AlphaDou summary
│   ├── 2206.12700.md                  # Action Spaces summary
│   └── 2210.17087.md                  # DanZero summary
└── analysis/
    ├── 2510.04542-deep.md             # ✨ NEW: CWM deep analysis
    ├── 2605.06066-deep.md             # ✨ NEW: MTG Causal RL deep analysis
    ├── 2407.10279-deep.md             # ✨ NEW: AlphaDou deep analysis
    ├── 2206.12700-deep.md             # ✨ NEW: Action Spaces deep analysis
    ├── 2210.17087-deep.md             # ✨ NEW: DanZero deep analysis
    └── 2026-W22-deep-summary.md       # ✨ NEW: This file
```
