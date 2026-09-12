# Self-Consistency 决策投票：消除 LLM 消极决策

> **设计提案** — 待对战流程跑通后评估实施。
> 来源论文：[PokeLLMon (2402.01118)](https://arxiv.org/abs/2402.01118)，发布于 EMNLP 2024。

---

## 问题定义

PokeLLMon 论文发现：LLM 在面临强大对手时产生 **panic switching**（恐慌切换）——连续多回合切换宝可梦而不进攻，给对手免费回合。根源是 Chain-of-Thought 推理导致的 **overthinking**：越想越怕，不敢 commit 进攻。

**Self-Consistency (SC, k=3)** 的解决方案：
1. 同一状态下采样 k=3 个独立动作（temperature > 0）
2. 多数投票选出最终动作
3. 本质是"投票剔除离群值"——2/3 样本选进攻时，1/3 的防御倾向被否决

**定量结果**（Pokémon Showdown 天梯）：

| 方法 | 胜率 | 切换率 | 连续切换率↓ |
|------|------|--------|------------|
| 直接生成 | 58.00% | 17.05% | 6.21% |
| CoT | 54.00% | 26.15% | 10.77% |
| **SC (k=3)** | **64.00%** | **16.00%** | **1.99%** |
| ToT (k=3) | 60.00% | 19.70% | 5.88% |
| 人类玩家 | 59.84% | — | — |

**关键发现**：CoT 反而恶化问题（`+9%` 切换率），SC 是唯一同时提升胜率且降低恐慌的方案。

---

## GI-TCG 等价问题

在 fragmented-decision 管道中，panic switching 的等价表现：

| `DecisionFragmentV1` 字段 | 消极模式 | 积极模式 |
|---------------------------|---------|---------|
| `intent` | 频繁 `defend` / `conserve` | `aggressive_push` / `pressure` / `burst_finish` |
| `resource_policy` | 倾向 `strict`（保守用骰） | `balanced` / `aggressive` |
| `must_do` | 含 `declare_end` / `switch_active` | 含 `useSkill` / `burst` / 斩杀 tag |
| `avoid` | 过度含 `useSkill`（怕反击） | 空，或仅含明确不利动作 |
| `preference_order` | 切换优先于技能 | 技能/斩杀优先 |
| `target_policy` | 分散攻击 | 集火低 HP 目标 |

**决策语义字段天然适合投票聚合**——不需要改底层数据结构。

---

## 方案对比

### 方案 A：Hermes 编排器 + delegate_task（推荐 ✅）

**架构**：

```
Hermes Agent（game loop 主循环）
  │
  ├─ ① get_turn_digest_v1          ← MCP tool（获取结构化局面）
  │
  ├─ ② delegate_task × 3（并行）    ← 3 个 subagent 独立推理
  │    sub-1 ──→ DecisionFragment {intent: "aggressive_push", ...}
  │    sub-2 ──→ DecisionFragment {intent: "pressure", ...}
  │    sub-3 ──→ DecisionFragment {intent: "aggressive_push", ...}
  │
  ├─ ③ sc_vote() 聚合投票          ← 本地逻辑（纯 Python，无 LLM 调用）
  │    intent: "aggressive_push" (2/3)
  │    resource_policy: "aggressive" (2/3)
  │    must_do: [tags present in ≥2/3]
  │
  └─ ④ submit_decision_fragment_v1 ← MCP tool（执行 consensus）
       ↓
     get_execution_feedback_v1      ← 反馈 → 下一回合
```

**Subagent 自包含设计**：TurnDigest 已包含全部决策需要的数据（`character_definitions` + `card_definitions` + `lethal_info` + `candidate_actions`），subagent 不需要任何 MCP tool，只需要纯推理能力。

| 维度 | 评估 |
|------|------|
| GI-TCG 代码侵入性 | **零**（不改 prompt、不改 MCP server、不改 OpenCode config） |
| 决策质量 | ⭐⭐⭐ 真 SC（3 次独立 LLM 调用） |
| 子代理隔离 | ✅ 独立上下文，temperature 多样性 |
| Token 成本 | ×3（每回合 3 次子代理调用 × 双方 = 6 次/回合） |
| 固定性 | skill + cron（长期运行自动化） |
| 调试 | 3 份 fragment + 聚合结果全部可审计 |
| 实施时间 | ~1 天 |

---

### 方案 B：Prompt 内嵌多路径（轻量折中）

不新增子代理，在 prompt 中要求 LLM 在单次调用中输出 3 条独立推理路径 + 自投票：

```markdown
### 2.3 Self-Consistency 决策

请独立思考 3 条策略路径，每条路径给出完整的 DecisionFragment：

**路径 1（第一直觉）**：你看到局面后最先想到的策略
**路径 2（替代方案）**：考虑另一种完全不同的思路
**路径 3（最坏应对）**：假设对手做了最优应对，你的最优策略

基于 3 条路径的多数共识，输出 final DecisionFragment。
```

| 维度 | 评估 |
|------|------|
| 决策质量 | ⭐⭐ 伪 SC（共享 hidden state，多样性弱於独立调用） |
| Token 成本 | +50%（单次调用输出更长，但不 ×3） |
| 实施时间 | ~30 分钟（只改 prompt） |

**适用场景**：快速实验、成本敏感、不想架构变动。论文 Table 5 中 SC 和 ToT 也都是单次调用内的多路径推理（不是真正的 3 次独立调用），所以**伪 SC 也有显著提升**。

---

### 方案 C：MCP Server 内建 SC（工具层封装）

新增 MCP 工具 `submit_decision_fragment_sc_v1`：

```
OpenCode Agent（不改 prompt）
  └─ submit_decision_fragment_sc_v1
       ├─ MCP server 内部调 LLM × 3
       ├─ 聚合投票
       └─ 调用原有 submit_decision_fragment_v1
```

| 维度 | 评估 |
|------|------|
| 决策质量 | ⭐⭐⭐ 真 SC |
| GI-TCG 代码侵入性 | **中**（新增 MCP tool + LLM 调用能力） |
| 架构污染 | ❌ MCP server 是桥接层，不应有推理逻辑 |
| API key 管理 | 散落两处（OpenCode + MCP server） |

**不推荐**：MCP server 职责是协议桥接和 resolver 评分，不应内嵌 LLM 推理。

---

## 聚合逻辑 `sc_vote()` 详细设计

输入：k 个 `DecisionFragmentV1` JSON  
输出：1 个 consensus `DecisionFragmentV1` JSON

### 投票规则

```python
from collections import Counter

def sc_vote(fragments: list[dict]) -> dict:
    k = len(fragments)

    # ① intent（8 选 1）：多数投票
    intent_votes = Counter(f["intent"] for f in fragments)
    intent = intent_votes.most_common(1)[0][0]  # 自动 tie-break（Counter 稳定）

    # ② resource_policy（3 选 1）：多数投票
    policy_votes = Counter(f["resource_policy"] for f in fragments)
    resource_policy = policy_votes.most_common(1)[0][0]

    # ③ must_do（tag 集合）：保留 >= 2/3 样本含有的 tag
    all_must = [t for f in fragments for t in f.get("must_do", [])]
    must_counts = Counter(all_must)
    must_do = [t for t, c in must_counts.items() if c >= k // 2 + 1]

    # ④ avoid（tag 集合）：同上
    all_avoid = [t for f in fragments for t in f.get("avoid", [])]
    avoid_counts = Counter(all_avoid)
    avoid = [t for t, c in avoid_counts.items() if c >= k // 2 + 1]

    # ⑤ target_policy：取最频繁文本（完全匹配）
    target_votes = Counter(f.get("target_policy", "") for f in fragments)
    target_policy = target_votes.most_common(1)[0][0]

    # ⑥ preference_order / fallback：取 intent 多数方的 fragment
    winner = next(f for f in fragments if f["intent"] == intent)

    return {
        "version": "DecisionFragmentV1",
        "session_id": fragments[0].get("session_id", ""),
        "digest_ref": fragments[0].get("digest_ref", ""),
        "intent": intent,
        "must_do": must_do,
        "avoid": avoid,
        "preference_order": winner.get("preference_order", []),
        "resource_policy": resource_policy,
        "target_policy": target_policy,
        "fallback_rule": winner.get("fallback_rule", ""),
        "explanation": (
            f"SC(k={k}) consensus: intent={intent} ({intent_votes[intent]}/{k}), "
            f"policy={resource_policy} ({policy_votes[resource_policy]}/{k}), "
            f"must_do={must_do}, avoid={avoid}"
        ),
    }
```

### k 值的选取

| k | 胜率 (Pokémon) | GI-TCG 推测 |
|----|---------------|------------|
| 1 | 58.00% (baseline) | 当前 |
| 3 | 64.00% | **推荐**（论文最优，性价比最高） |
| 5 | — | 边际收益递减，3→5 提升有限但成本 +67% |

**结论**：k=3 是 sweet spot。更多样本的多数投票更稳定但 Token 成本线性增长。

### 多样性保证

三个子代理使用**略有不同的决策视角**来促进多样性：

| Sample | 视角 | Prompt hint |
|--------|------|-------------|
| 1 | 第一直觉 | "Give your first-instinct decision based on the game state." |
| 2 | 替代策略 | "Consider a completely different alternative strategy." |
| 3 | 最坏应对 | "Assume the opponent makes their optimal move. What's your best response?" |

这跟论文的 k=3 采样策略一致：不同视角产生不同推理路径，多数投票自然淘汰 outlier。

---

## Goal：触发条件 —— 只在关键锚点启用 SC

SC 的 Token 成本是 ×3，不需要每个回合都用。只在**关键决策锚点**（跟现有 prompt 中的锚点检测一致）：

- ⚠️ `lethal_info.my_kill_threats[].likely_kill === true`
- ⚠️ `lethal_info.opponent_kill_threats[].likely_kill === true`
- ⚠️ 某角色 HP ≤ 3（进入斩杀线）
- ⚠️ 关键 combo 组件到齐（`strategy_store` keyCards + `card_definitions[].in_hand`）
- ⚠️ 对手 aura 变化预示 combo 准备完成

**非锚点回合**：单次快速决策（现有流程），节省成本。

**锚点回合**：启用 SC ×3 投票。

这跟论文的核心洞察一致：**panic 发生在压力情境下**，非压力回合不需要 SC。

---

## 实施路径

```
Phase 0 (当前)         文档就位，等待对战流程跑通
Phase 1 (1-2h)         Prompt 内嵌多路径（方案 B），快速验证 SC 在 GI-TCG 中是否有效
Phase 2 (1-2d)         Hermes delegate_task 编排器（方案 A），固定自动化
Phase 3 (后续)         benchmark 对比：SC on/off 胜率差异，确定 k 最优值
```

### Phase 1 快速验证 Checkpoint

在不改架构的前提下，4 个文件改动：

1. `.opencode/prompts/p0-start.md` — 在 2.3 节改为 SC 多路径决策
2. `.opencode/prompts/p1-start.md` — 同上
3. 跑 10 局 SC vs baseline，统计：
   - `intent: "defend"/"conserve"` 出现频率 ↓
   - `resource_policy: "strict"` 出现频率 ↓
   - 胜率变化

如果 Phase 1 显示负面或无效果 → 放弃 SC，不必投入 Phase 2。

---

## 参考文献

- Hu S, et al. "PokeLLMon: A Human-Parity Agent for Pokémon Battles with Large Language Models." EMNLP 2024. [arXiv:2402.01118](https://arxiv.org/abs/2402.01118)
- Wang X, et al. "Self-Consistency Improves Chain of Thought Reasoning in Language Models." ICLR 2023. [arXiv:2203.11171](https://arxiv.org/abs/2203.11171)（原始 SC 方法）
- Yao S, et al. "Tree of Thoughts: Deliberate Problem Solving with Large Language Models." NeurIPS 2023. [arXiv:2305.10601](https://arxiv.org/abs/2305.10601)（对比方法）
