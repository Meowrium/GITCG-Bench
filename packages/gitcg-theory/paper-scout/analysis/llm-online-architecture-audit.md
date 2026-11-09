# LLM 在线对局架构审计：本系统 vs 2024-2026 论文全景

**Date**: 2026-05-26 | **Analyst**: Paper Scout Deep Analysis Agent
**Scope**: `packages/mcp` + `packages/tactic-mcp` + `.opencode/` vs 58 篇 LLM 在线对局论文

---

## 一句话总结

本系统已实现了一条被多篇顶会论文（Vox Deorum、HIMA、PLAP）验证的混合架构路线——LLM 做策略约束、本地 resolver 做动作映射——但论文社区正在向一个更深的方向推进：**LLM 不输出语义偏好，而是输出可执行的局域世界模型（Code World Models）或可微分的策略参数（Mem0/SPIRAL/MEMO）**。当前架构正处于从 v1（JSON 静态分析 + 直接出招）到 v2（碎片化语义决策 + 本地 resolver）的迁移中，v2 完成后将具备与论文前沿对齐的能力。

---

## 一、本系统架构完整画像

### 1.1 物理拓扑

```
┌─────────────────────────────────────────────────┐
│              Game Engine (@gi-tcg/core)          │
│              HTTP Bridge (localhost:3901)         │
└──────┬──────────────────────────┬───────────────┘
       │ /api/mcp/0/*             │ /api/mcp/1/*
       ▼                          ▼
┌──────────────┐          ┌──────────────┐
│  OpenCode P0 │          │  OpenCode P1  │
│  GLM-5       │          │  MiniMax-M2.5│
│  config-p0   │          │  config-p1    │
│  prompt-p0   │          │  prompt-p1    │
└──────┬───────┘          └──────┬────────┘
       │ MCP (stdio)             │ MCP (stdio)
       ▼                         ▼
┌──────────────────────────────────────────────┐
│         MCP Server (standalone-mcp.ts)        │
│  Tool Exposure Mode: fragmented-decision      │
│  ┌─────────────────────────────────────────┐ │
│  │ AI-visible tools:                       │ │
│  │  get_turn_digest_v1                     │ │
│  │  submit_decision_fragment_v1            │ │
│  │  get_execution_feedback_v1              │ │
│  │  create_opening_plan_v2                 │ │
│  │  create_decision_shard_v2               │ │
│  │  critic_evaluate_v1                     │ │
│  │  auto_select_skills                     │ │
│  ├─────────────────────────────────────────┤ │
│  │ Local-only tools (hidden from AI):      │ │
│  │  choose_action, choose_active,           │ │
│  │  reroll_dice, switch_hands, select_card │ │
│  └─────────────────────────────────────────┘ │
│  Resolver: linear scoring → candidate pick   │
└──────────────────────────────────────────────┘
```

### 1.2 决策管道（五层）

```
Layer 0: 开局分析（一次）
  analyze_deck + analyze_matchup → StrategyAnchor JSON
  → strategy_store(key="p0_anchor")

Layer 1: 战略规划（PlanV2）
  create_opening_plan_v2 → {
    global_goal, turn_priorities,
    risk_rules, pivot_rules,
    trigger_rules, fallback_rules
  }
  → 持久化为 PlanV2 artifact

Layer 2: 碎片化决策（DecisionFragmentV1）
  get_turn_digest_v1 → candidate summary
  submit_decision_fragment_v1 → {
    intent, must_do, avoid,
    preference_order, resource_policy,
    fallback_rule,
    // ❌ 禁止 action_index / used_dice
  }

Layer 3: 本地解析执行（Resolver）
  scoring = strategy_match + local_gain
          - risk_penalty - resource_penalty
  → 选最优 candidate → 调用 choose_action

Layer 4: 执行后评估（Critic）
  critic_evaluate_v1 → {
    score, violations, should_replan,
    replan_scope: micro|opening|midgame|full
  }
```

### 1.3 数据契约体系（@gi-tcg/tactic-mcp）

| Artifact | 角色 | 关键字段 |
|----------|------|---------|
| `PlanV2` | 长期战略 | global_goal, turn_priorities, risk_rules, pivot_rules, trigger_rules, fallback_rules |
| `DecisionShard` | 战术窗口 | tactical_goal, candidate_policies, execution_constraints, fallback_chain, exit_conditions, combat_window_plan |
| `TurnDigestV1` | 本地→LLM 的压缩状态 | self_summary, opponent_summary, resource_summary, candidate_actions, hard_constraints |
| `DecisionFragmentV1` | LLM→本地的语义约束 | intent, must_do, avoid, preference_order, resource_policy, local_eval_requests, evidence_policy |
| `ExecutionFeedbackV1` | 执行结果反馈 | selected_candidate_id, executed_tool, execution_ok, score_breakdown, fallback_used |
| `CriticResultV1` | 事后评估 | score, violations, should_replan, replan_scope, suggested_adjustments |

---

## 二、与本系统的论文级映射

### 2.1 直接对应（架构同构）

| 本系统组件 | 对应论文 | 论文做了什么 | 相似度 |
|-----------|---------|-------------|--------|
| **Layer 0: StrategyAnchor + PlanV2** | **Vox Deorum** `2512.18564` (Civ V, Dec 2025) | LLM 做宏观战略推理（科技树/外交/军事），子系统做战术执行。玩了 2,327 局 | ⭐⭐⭐⭐⭐ 完全同构 |
| **Layer 2-3: DecisionFragment → Resolver** | **HIMA** `2508.06042` (SC2, COLM 2025) | Hierarchical multi-agent: Strategic Planner meta-controller + specialized imitation agents | ⭐⭐⭐⭐⭐ 同构 |
| **Layer 3: Local Resolver scoring** | **PLAP** `2509.13127` (MicroRTS, Sep 2025) | LLM 产出 skill plan，本地 skill library + executor 落地。GPT-4o 零样本击败 80% baseline | ⭐⭐⭐⭐⭐ 同构 |
| **Tool boundary 权限隔离** | **MASMP** `2510.18395` (SC2, Oct 2025) | State machine + memory 强制 tactical coherence，60% 胜率 vs 最难内置 AI | ⭐⭐⭐⭐ 思路一致 |

### 2.2 思路一致（启发源或并行发现）

| 本系统设计 | 对应论文 | 相似点 |
|-----------|---------|--------|
| **Critic replan** (score<0.4 → replan) | **SAG-Agent** `2510.15259` (Civ V / Slay the Spire) | State-Action Graph 回溯机制，score 不足时回退重建分支 |
| **artifact 落盘 + 独立会话** | **MEMO** `2603.09022` (text games, Mar 2026) | Memory-augmented context optimization，self-play 将 win rate 从 25%→49.5% |
| **DecisionShard 作为短时程战术窗口** | **SpinGPT** `2509.22387` (扑克, Sep 2025) | SFT 320k expert decisions + RL，将短时程决策片段化为 policy |
| **视角隔离（P0/P1 独立 MCP session）** | **Suspicion-Agent** `2309.17277` (扑克/Leduc) | GPT-4 用 ToM 在不完备信息下做决策，天然视角隔离 |
| **LLM 不接触底层动作工具** | **ToolPoker** `2602.00528` (扑克, Jan 2026) | 外部 solver 做 GTO 一致性检查，LLM 不直接操控牌桌 |
| **evidence_policy: require_local_eval_first** | **Diplomacy harness** `2508.07485` (Aug 2025) | Critical State Analysis——要求 LLM 在关键节点做结构化评估而非臆测 |

### 2.3 前瞻对齐（本系统下一步可能方向）

| 论文 | 对应本系统缺口 | 论文的解法 |
|------|--------------|-----------|
| **Code World Models** `2510.04542` | Layer 0 的 StrategyAnchor 是静态 JSON，不能做 state→value | LLM 输出 `evaluate(state)→float` 可执行函数，MCTS 在生成的 world model 上做规划 |
| **SPIRAL** `2506.24119` (Kuhn Poker, Jun 2025) | DecisionFragment 是固定的语义模板，不随时间进化 | Self-play RL for LLMs——LLM policy 参数在零和博弈中通过 self-play 持续优化 |
| **MEMO** `2603.09022` | Critic 只在 score 低时 replan，不是持续优化 context | Memory-augmented MCO——动态优化 LLM context 窗口内容，25%→49.5% |
| **PokeLLMon** `2402.01118` | 本系统目前是 AI vs AI 内部对战 | LLM 打在线天梯，49% ladder，56% invited。in-context RL + knowledge retrieval |
| **SEMA** `2603.23875` (SC2, Mar 2026) | 本系统的两个 OpenCode 实例是独立的 | Multi-agent self-evolving——agent 之间信息共享、协同进化 |
| **Implicit Strategic Optimization** `2602.08041` (德州/宝可梦) | PlanV2/StrategyAnchor 是开局一次生成，不动态更新 | Strategic Reward Model 做 long-horizon value 在线更新 |

---

## 三、论文全景 vs 本系统定位

### 3.1 LLM 在线对局论文集群（58 篇，2024-2026）

```
                    ┌─────────────────────────┐
                    │   Social Deduction (15)  │ ← Werewolf/Avalon
                    │   LLM 天然适合语言博弈   │    与 TCG 无直接关系
                    └─────────────────────────┘

  ┌─────────────────────────┐     ┌─────────────────────────┐
  │  Poker / Card Games (11)│     │  RTS / Strategy (10)    │
  │  SpinGPT, PokerBench,   │     │  Vox Deorum, HIMA, PLAP │
  │  Suspicion-Agent        │     │  SEMA, SwarmBrain       │
  └───────────┬─────────────┘     └───────────┬─────────────┘
              │                               │
              │     ┌─────────────────┐       │
              └─────┤ 本系统定位      ├───────┘
                    │ 卡牌游戏 TCG    │
                    │ Hybrid: LLM     │
                    │ strategy +      │
                    │ local resolver  │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
  ┌───────────┴───────────┐   ┌───────────┴───────────┐
  │  Diplomacy (4)        │   │  General Bench (6)    │
  │  DipLLM, Richelieu    │   │  TextArena, Orak,     │
  │  战略+谈判混合        │   │  ZeroSumEval          │
  └───────────────────────┘   └───────────────────────┘
```

### 3.2 本系统的独特优势（论文中少见的）

1. **工具权限物理隔离**（`MCP_TOOL_EXPOSURE_MODE=fragmented-decision`）
   - 大多数论文靠 prompt 约束 LLM 不输出非法动作，你直接让 LLM 看不到 `choose_action`
   - 这比 ToolPoker 的 "外部 solver 验证" 更彻底——不是事后检查，而是事前阻断
   - 论文社区知道这是方向，但极少见到工程化实现

2. **五层 artifact 管道**（PlanV2 → DecisionShard → TurnDigest → Fragment → Feedback → Critic）
   - 大部分论文只有 2-3 层（strategy → action 或 state → action）
   - 你的 DecisionShard 作为战术窗口的概念，介于 PlanV2（多回合）和 Fragment（单步）之间，这层抽象很精准

3. **Schema-contracted MCP tools**（`@gi-tcg/tactic-mcp` 的 JSON Schema 验证层）
   - 论文社区很少见到运行时 schema 验证——LLM 输出通常只靠 prompt 约束
   - `TacticToolContractValidator` 对 request/response 做运行时校验，降低了 LLM 幻觉潜入执行链的风险

### 3.3 本系统与论文前沿的差距

| 维度 | 论文前沿 (2026) | 本系统现状 | 差距评级 |
|------|----------------|-----------|---------|
| **LLM 输出形式** | 可执行代码 (CWM) / 可训练策略 (SPIRAL) | 语义 JSON (DecisionFragment) | 🟡 中等——JSON 够用但天花板低 |
| **策略进化** | Self-play RL 持续优化 LLM policy (SPIRAL, MEMO) | PlanV2 是静态开局分析 | 🔴 关键——当前策略不学习 |
| **Context 管理** | Dynamic context optimization (MEMO) | 固定 prompt + strategy_store 查锚点 | 🟡 中等——可以工作但未验证最优 |
| **对手建模** | infer_hidden 函数 (CWM), ToM (Suspicion-Agent) | 无——完全不推断对手手牌/策略 | 🔴 关键——完全缺失 |
| **实时性** | PokeLLMon 在线天梯对战人类 | AI vs AI 内部测试 | 🟢 设计使然——不是差距 |
| **评估严谨性** | Pair seed + bootstrap CI (2605.06066) | 未知——无公开 benchmark 协议 | 🟡 中等——需补齐 |

---

## 四、可落地动作

### ⚡ Today（零成本）

1. **确认 v2 迁移进度**
   - 对照 `docs/fragmented-decision/05-migration-plan.md` 的 5 个阶段，逐一确认当前完成度
   - 如果 Resolver 还未真正落地（阶段 3），这是最大瓶颈——"LLM 给语义但没人接" = 系统退化回 direct-action

### ⚠️ This Week

2. **补齐 Critic 的 experimental validation**（借鉴 2605.06066 评估协议）
   - 拿 10 局 fragmented-decision vs direct-action 的对局日志
   - 比较：avg turn duration, illegal action rate, token consumption, resolver fallback rate, critic replan frequency
   - 目标：验证 fragmented-decision 模式确实比 direct-action 有可测提升

3. **原型：LLM → evaluator 函数**（CWM 式最小实验）
   - 在 DecisionFragment 的 `local_eval_requests` 中要求 LLM 输出简单的 `evaluate_win_prob(state)` 伪代码
   - 对比 LLM 的 win_prob 估计 vs Resolver 的实际结果 vs 对局终局
   - 这是判断 "JSON → Code" 路线是否值得投入的最便宜探针

### 📅 Next Week

4. **设计对手手牌推理接口**（`infer_hidden` 等价物）
   - 参照 CWM 的 Inference 层 + Suspicion-Agent 的 ToM 方法
   - 定义 `TurnDigestV1` 的 opponent 侧需要哪些字段（当前只有 known_aura_snapshot + threat_flags）
   - 设计 `local_eval_requests` 的新 metric：`opponent_damage_upper_bound`, `opponent_buff_probability_upper_bound`

5. **探索 StrategyAnchor 的动态更新**（SPIRAL/MEMO 方向）
   - 当前 PlanV2 是开局一次生成，全场不变
   - 研究：在 Critic 触发 `replan_scope: midgame` 时，是否应重新调用一次 LLM 做 mid-game strategy shift
   - 对比：开局固定 PlanV2 vs PlanV2 + midgame update 的胜率差异

---

## 五、风险与质疑

1. **DecisionFragment→Resolver 的语义歧义**
   - `intent: "pressure"` 和 `preference_order: ["aggression > value trade > pass"]` 可以被本地 resolver 解释出完全不同的动作
   - 论文里没有好的解法（这也是 PLAP 用 skill library、HIMA 用 specialized agents 的原因）
   - **建议**：先不做语义推理，而是让 DecisionFragment 的 `must_do`/`avoid` 尽量用 action_case 枚举（`useSkill`, `switchActive`, `declareEnd`）——可操作性强于自然语言

2. **fragmented-decision 是否真的降低了 token 消耗？**
   - `get_turn_digest_v1` 替代 `get_game_state` 确实压缩了状态，但 `submit_decision_fragment_v1` 的 JSON schema 本身有 ~30 个字段
   - 如果没有实测数据，"碎片化决策更省 token" 的假设未经验证

3. **GLM-5 vs MiniMax-M2.5 异质性**
   - 两个模型由不同厂商训练，对 JSON schema 的遵守程度、对 TCG 的理解水平可能差异很大
   - 如果发现 P0/P1 胜率偏差 >10 个百分点，不一定是策略差异——可能是模型能力的系统偏差

4. **本系统 vs 论文的"相似"可能是表面相似**
   - Vox Deorum 的 macro reasoning 是基于科技树/外交/军事的语义空间（有限离散动作），GI TCG 的候选动作空间更连续（骰子组合爆炸）
   - HIMA 的分层是 meta-controller 选 agent，本系统的分层是 LLM 选 intent→resolver 选 action——信息压缩比不同
   - 论文里的"LLM does strategy"和本系统的"LLM does intent"在压缩率上可能差一个数量级

---

## 六、结论

**本系统在工程上已经走了一条正确的路**——工具权限物理隔离 + 五层 artifact 管道 + schema 验证——这三者在论文社区中属于前沿实践。论文趋势不是否定了这条路线，而是给它指明了下一步：

1. **v2 完工**（fragmented-decision 全链路跑通）→ 对标 Vox Deorum / HIMA / PLAP
2. **v3 探索**（LLM 输出可执行 evaluator，取代静态 JSON）→ 对标 CWM
3. **v4 探索**（PlanV2 动态更新 + 对手手牌推理）→ 对标 SPIRAL / Suspicion-Agent

当前最大瓶颈不是算法缺位，而是 **v2 管道是否真的在线上跑通了**——如果 Resolver 还是 stubbed、Critic 的 replan 还只是文档里的一句话，那本系统的论文级竞争力还没有兑现。
