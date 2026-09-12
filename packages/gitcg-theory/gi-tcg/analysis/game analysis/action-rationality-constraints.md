# GI-TCG 动作阶段操作合理性约束

> 源：`temporal-vs-baseline` benchmark (360 局, WR 52.50%) 的对局日志分析。
> 文中 MCTS 指 PUCT 树搜索框架（`packages/gi-agent/src/mcts/`）。

---

## 七大约束条件

GI-TCG 动作阶段的任何操作，其理性受以下 7 个理论维度制约。每个维度都可作为独立验证条件，排查 AI 决策错误时逐一对照。

### ① 骰子预算约束 (Dice Budget)

**原理**：动作阶段是经典的背包问题。每回合骰子总量固定（通常 8），理性要求选出 Pareto 最优的动作组合——不存在另一组动作能用相同或更少骰子产生严格更高的战果。

**对立面**：将骰子视为可透支资源，优先打出所有"可出"的牌，忽视后续动作的骰子需求。

**对局表现**：
```
R1 🎲8 → PLAY(-3) → PLAY(-1) → PLAY(-1) → PLAY(-2) → 仅剩1🎲，零次攻击
```

**例外出没**：雷鹤(4.101) 作为 temporal AI 时，10 局中 7 局以上 R1 将 ≥60% 骰子投向支援/事件牌。

---

### ② 承诺不可逆性约束 (Commitment Irreversibility)

**原理**：GI-TCG 动作按"不可逆程度"分四层。理性要求承诺越重的动作需要越高的期望回报。

| 层级 | 类型 | 可逆性 | 例 |
|:---:|------|------|---|
| I | 切人 | 完全可逆 | A→B 损失仅骰子成本 |
| II | 打支援牌 | 部分可逆（占格子，成本沉没） | 立本 0 费但长期占据支援位 |
| III | 充能/部署技能 | 不可逆但延迟回报 | 雷电 E 回合结束才生效 |
| IV | 伤害技能 | 不可逆即时回报 | HP 永久无法恢复 |

**对立面**：对所有"可打出"动作给统一加分，不区分不可逆程度。

**关键区分**：同一骰子成本的支撑（立本）和事件（送你一程）有完全不同的承诺结构——前者绑定 2 回合的支援位，后者即时生效不占位——但多数评分系统对两者一视同仁。

---

### ③ 信息不完备约束 (Information Partition)

**原理**：动作阶段是不完美信息博弈。对手手牌、下一轮骰子、抽牌顺序均为未知。理性要求在**对手私有信息的期望分布**上动作，而非仅基于当前可见盘面。

**对立面**：将盘面当作完全信息——"我的部署稳妥"的前提是"对手没有解牌"——而对手可能持有速切/秘传/护法之誓。

**对局表现**：水八-vs-水八 镜像 10% WR——双方都认为"我的部署安全"，陷入对称困境。

**特殊性**：这是 7 个约束中唯一**结构性无法通过搜索解决**的（MCTS 搜索树只能展开可见状态，无法对 hidden state 做期望）。需要外部对手模型。

---

### ④ 对抗响应约束 (Adversarial Response)

**原理**：交替回合制零和博弈。AI 的每次动作后，对手在同一回合内可以用满骰子回应（除非是快速动作）。回合初打牌 = 给对手 8 骰报复窗口；回合末打牌 = 对手已交牌/切人，报复力不足。

**这就是 MCTS 最大的优势所在**——tree search 天然在对手节点展开最优反击。

**对立面（贪心策略）**：按"当前最强动作"直接出牌，完全不考虑对手在 5 秒后会用满骰子惩罚你。

---

### ⑤ 斩杀阈值约束 (Kill Threshold)

**原理**：角色 HP=0 等价于删除该角色的整个未来动作权。HP 效用应在 HP=0 处有**悬崖跳变**（离散阶跃），而非平滑曲线。这与一般 HP-advantage 评估有本质差异。

```
正确: HP 价值 = alive × 角色价值表 + 剩余HP的边际防守价值
错误: HP 价值 ∝ Σ(remaining_hp)  ← 平滑曲线，看不到 HP=0 的跳变
```

**对立面（GBDT value model）**：线性模型和 GBDT 的 value 输出是连续函数。对"1 HP → 0 HP"和"10 HP → 9 HP"这两步赋予相似的边际 value，无法捕捉斩杀的特殊性。

**对局表现**：
```
R4 🎲8, OPP: 一斗(1HP) → AI 选择 🃏 PLAY card(-1🎲) 而不是收头
```
AI 认为"对方只剩 1 血，我已经大优，不需要急"——而实际上对手活着就能反杀。

---

### ⑥ 战略-战术折现约束 (Strategy-Tactics Tradeoff)

**原理**：GI-TCG 动作沿谱系分布：

```
纯战术 ←―――――――――――――――――――→ 纯战略
(伤害/切人/回复)                    (部署/充能/反应铺垫)
 即时回报                             延迟回报
```

战略动作严格受战术机会成本约束。折现率取决于：
- **预期对局长度**（越短，战术越占优——红牛 100% WR 的合理解释）
- **对手当前压迫强度**（越强，延迟回报越不值钱）
- **牌的 ROI**（立本 3→2 骰+2牌，100% ROI。卯师傅 1→1 骰 + 食品联动，条件性 ROI）

**对立面**：对所有可打出战略牌给统一加分，不区分 ROI 高低、当前回合的压迫强度、牌的最佳部署窗口。

**窗口化结构**：每张支援/召唤牌有隐含的"最佳部署回合窗口"。R1 立本 ≈ 必打（100% ROI，2 回合缓冲），R5 立本 ≈ 废牌（游戏在 R6-7 结束，回报来不及）。但大多数评分系统对 R1 和 R5 的同一张牌给相同分数。

---

### ⑦ 对称打破约束 (Symmetry Breaking)

**原理**：镜像对局中双方工具有完全一致。若双方使用完全相同的评估函数，游戏变为抛硬币。理性要求在对称位置找到不对称优势——要么利用先手优先权，要么评估对手策略偏差。

**镜像 benchmark 数据**：

| 镜像 | WR | 机制 |
|------|:---:|------|
| 水八-vs-水八 | 10% | 双方"部署→部署→部署"，游戏拖死 |
| 水债-vs-水债 | 40% | 同上 |
| 神宵-vs-神宵 | 40% | 同上 |
| 雷鹤-vs-雷鹤 | 30% | 同上 |
| **红牛-vs-红牛** | **100%** | AI的"自然倾向"恰好是红牛的最优策略（猛攻） |
| **水凝-vs-水凝** | **70%** | AI的"自然倾向"是拖延，与 deck 的节奏一致 |

**诊断信号**：如果 deck 的自然风格恰好与 AI 的偏差方向一致，镜像 WR 高（红牛、水凝）。反例（水八、水债、雷鹤）则是 AI 部署倾向与 deck 需要的压制节奏相悖——双方都被"你应该部署"的信号牵制。

---

## MCTS 下的可学性/可计算性

以下按 "MCTS 能否自主学到" × "是否可直接精算" 的交叉矩阵评估每个约束。

| # | 约束 | MCTS 能学？ | 可直接计算？ | 辅助方案 | 成本 |
|:--:|------|:---:|:---:|------|:---:|
| ① | 骰子预算 | ✅ 天然 | — | 无需辅助 | 0 |
| ② | 承诺不可逆 | ⚠️ 需深度≥5 | ✅ | 回合-回报映射表注入 leaf eval | 低 |
| ③ | 信息不完备 | ❌ 结构性 | ❌ | 对手手牌采样 / 规则对手模型 | 高 |
| ④ | 对抗响应 | ✅ 天然 | ✅ | 对手 deck 特征偏置 eval | 低 |
| ⑤ | 斩杀阈值 | ❌ 平滑曲线盲区 | ✅ | `damage ≥ hp → bonus` 硬编码 | 极低 |
| ⑥ | 战略/战术 | ⚠️ 需深搜 | ✅ | 牌价值衰减 + 压迫强度 | 中 |
| ⑦ | 对称打破 | ⚠️ 镜像塌缩 | ✅ | 先手偏置 + archetype 不对称注入 | 低 |

### 详细说明

#### ① 骰子预算 — 天然解决
MCTS 的 `simulateAction()` 每次从骰子向量减去成本，不可支付的动作不展开。不需辅助。

**前提条件**：candidate generation 必须完整。若 `candidateToEngineAction()` 漏掉高价值动作，MCTS 无从选择。

---

#### ② 承诺不可逆 — 深度受限可补
MCTS 展开树时，支援牌部署后状态变更。若 depth≥5 可看到完整 lifecycle（部署→等待→触发），当前 depth=3 不够。

**辅助方案**：`leaf_eval()` 检查当前回合是否达到了已部署支援的 `payoff_round`：
```typescript
function computeDeferredPayoff(snap: ActionPhaseSnapshot, round: number): number {
  let payoff = 0;
  for (const s of snap.supports) {
    const profile = getProfile(s.definitionId);
    if (profile && round >= profile.lifecycle.payoff_earliest_round) {
      payoff += profile.payoff.estimated_value;
    }
  }
  return payoff;
}
```
**数据来源**：`packages/gi-agent/src/knowledge/temporal-profiles/profile-registry.ts`，DSL parser 已提取 `lifecycle` 和 `payoff` 字段。

---

#### ③ 信息不完备 — 结构性盲区，最昂贵
MCTS 只能展开可见状态，对方手牌是 hidden。这是 tree search 的结构性限制，无辅助则过信"安全部署"。

**辅助方案 A（规则对手模型）**：
```typescript
function opponentHasAnswer(oppSnap, actionType): boolean {
  // 对方 deck 含解牌时加 risk penalty
  const deckCards = getOpponentDeckCards(oppSnap);
  const hasRemoval = deckCards.some(c => 
    ["送你一程", "护法之誓", "速切"].includes(c.name)
  );
  return hasRemoval ? 0.3 : 0;
}
```

**辅助方案 B（手牌采样，昂贵但精确）**：从对手 deck 随机抽 N 种手牌组合，每种跑一次 MCTS 子树，取多数投票。N 倍计算量。

**取舍**：规则对手模型（A）成本低但精度有限，手牌采样（B）精确但 3-5× 计算量。建议先用 A 搭框架，效果不够再上 B。

---

#### ④ 对抗响应 — 天然解决
MCTS 的最大提升。对手节点使用相同 evaluator 找最优反击，天然编码了"我打牌→你打我→我受伤"的链条。

**辅助微调**：对手 evaluator 应按对手 deck 特征偏置：
```typescript
function getOpponentBias(deckArchetype: string): EvalBias {
  // aggressive deck 应该偏向攻击，control 偏向防守
  return DECK_BIAS[deckArchetype] ?? { attack: 0, defend: 0 };
}
```
**数据来源**：`packages/llm-deck-analyzer` 的 deck archetype 输出，或 `eval-char-comb` 的角色进攻倾向。

---

#### ⑤ 斩杀阈值 — 最易辅助，不应靠学习
平滑 value 函数是斩杀盲区的根本原因。这是**纯确定性计算**，不应浪费 MCTS 迭代去"发现"1 HP 可以斩杀。

**方案**：在 MCTS 节点展开前，对每个 `useSkill` 动作标注是否 lethal：
```typescript
function tagLethalActions(actions: MctsAction[], oppSnap: ActionPhaseSnapshot): void {
  const oppHp = oppSnap.chars[oppSnap.activeIdx].hp;
  for (const a of actions) {
    if (a.type === "useSkill" && (a.estimatedDamage ?? 0) >= oppHp) {
      a.priority = "lethal";  // 提升 prior + 降低 exploration
    }
  }
}
```
或更简洁：在 leaf eval 中加阶跃信号：
```typescript
if (oppSnap.chars[oppSnap.activeIdx].hp <= 0) return 1.0; // 已斩杀
```

---

#### ⑥ 战略-战术折现 — 价值衰减 + 压迫强度
核心是"何时打牌比攻击好"。由两个可计算子问题组成：

**a) 牌的最佳部署窗口**：
```typescript
function getCardTimelinessBonus(defId: number, round: number): number {
  const profile = getProfile(defId);
  if (!profile) return 0;
  const ideal = profile.lifecycle.ideal_deploy_round;
  return TIMELINESS_TABLE[round - ideal];  // {0: +0.15, 1: 0, 2: -0.1, 3: -0.3}
}
```
R1 打立本 +0.15，R5 打立本 -0.3。数据来源：DSL parser 的 `lifecycle` 字段。

**b) 对手压迫强度**：
```typescript
function computeOppPressure(oppSnap: ActionPhaseSnapshot): number {
  const active = oppSnap.chars[oppSnap.activeIdx];
  const hasMatchingDice = oppSnap.dice[active.aura] >= 3;
  const diceRatio = diceTotal(oppSnap.dice) / 8;
  return (hasMatchingDice ? 1 : 0.5) * diceRatio * OPP_PRESSURE_WEIGHT;
}
```
对手骰子充裕且元素匹配时，压迫强，打牌惩罚大。

---

#### ⑦ 对称打破 — 镜像对局专治
镜像对局双方 evaluator 相同 → 选不出优劣。两个低成本打破手段：

**a) 先手偏置**：
```typescript
if (snap.who === 0) value += FIRST_MOVE_BONUS; // P0 有 +0.05 的自然优势
```

**b) Deck archetype 不对称注入**：
```typescript
const AGGRESSIVE_DECKS = ["红牛", "雷狼", "神宵"];
const CONTROL_DECKS = ["水凝", "水八"];

function getArchetypeBias(deckId: string): EvalBias {
  if (AGGRESSIVE_DECKS.includes(deckId)) 
    return { attackWeight: 1.3, defendWeight: 0.8 };
  if (CONTROL_DECKS.includes(deckId))
    return { attackWeight: 0.8, defendWeight: 1.2 };
  return { attackWeight: 1.0, defendWeight: 1.0 };
}
```
在 MCTS 的 leaf eval 中，HP advantage 的 attack/defend 分量按 bias 加权。这样即使镜像，双方的 evaluator 也不完全相同。

**注**：这是对单个 deck 的硬编码偏置——不是对特定对局的偏置。原则仍是"不在策略中引用具体角色 ID"，而是在 archetype 级别做区分。

---

## 辅助计算的输入来源

所有辅助计算所需的数据均可从现有模块获取：

| 数据 | 来源 | 格式 |
|------|------|------|
| 牌的最佳部署回合/ROI | `temporal-profiles/profile-registry.ts` | `Map<defId, TemporalCardProfile>` |
| Deck archetype | `llm-deck-analyzer` 输出 / `eval-char-comb` | 进攻/控制/中速标签 |
| 角色元素 | `state-snapshot.ts` → `snap.chars[i].aura` | int (1-8) |
| 骰子向量 | `state-snapshot.ts` → `snap.dice` | [8]int |
| 手牌 ID | `state-snapshot.ts` → `snap.handDefIds` | int[] |
| 角色 HP/能量 | `state-snapshot.ts` → `snap.chars[i].hp/energy` | int |

**关键**：所有输入均在 `ActionPhaseSnapshot` 中。辅助函数只需读取 snapshot 字段 + 查询 profile registry——不需额外的引擎调用。

---

## 实现优先级建议

按成本/收益排序：

| 优先级 | 约束 | 改动 | 预计效果 |
|:---:|------|------|------|
| P0 | ⑤ 斩杀阈值 | `leaf_eval` 加 `oppHp≤0 → win` 判断 | 消除对 1HP 不补刀 |
| P1 | ⑥a 牌衰减 | `leaf_eval` 注入 `timeliness_bonus` | 减少 R4+ 打低 ROI 牌 |
| P2 | ② 承诺不可逆 | `leaf_eval` 注入 `deferred_payoff` | 让 depth=3 的树能看到延迟回报 |
| P3 | ④ 对手偏置 | 对手叶子节点按 deck 特征加权 | 改善异质对局 |
| P4 | ⑦ 对称打破 | `first_move_bonus` + archetype 偏置 | 改善镜像 |
| P5 | ③ 信息不完备 | 规则对手模型（含解牌检测） | 减少过信部署 |
| ∞ | — | 对手手牌采样（MCTS×N） | 高精度但昂贵，P5 不够再用 |

**预计总代码量**：集中在 `state-snapshot.ts` 的 `simulateAction()` 之后、`heuristicValueFn()` 附近的 ~100 行增强。不需要新增模块文件。

---

## 对局诊断速查

用以下 checklist 快速定位一盘对局中的主要约束违反：

- [ ] R1 骰子 **>60% 打牌** → 约束①（骰子预算）
- [ ] **循环切人** A→B→A → 约束②（承诺不可逆，浪费 2 骰子零收益）
- [ ] 打出支援后**被秒解** → 约束③（信息不完备，未检测对方解牌）
- [ ] **开局打牌而非攻击**，对手满骰子回应 → 约束④（对抗响应）
- [ ] 对手 **≤2 HP 不补刀**，打牌/切人 → 约束⑤（斩杀阈值）
- [ ] R4+ 仍打**低价值支援**而非收尾 → 约束⑥（战略折现过弱）
- [ ] **镜像对局** WR 远低于 50% → 约束⑦（对称打破失败）
