# 静态分析器的局限性与可修复项

> 2026-04-22，基于 v4.7.0 圣骸卡组分析差距讨论整理

## 背景

用 `@gi-tcg/llm-deck-analyzer` 分析圣骸飞蛇-圣骸毒蝎-吞星之鲸卡组（v4.7.0，卡组代码 `GVIDxnMOGUMjW3wXGZKy4KURDEIz9koRFmODBYMSGjMSCrUSDYMzjIYaGqNDDIcSGqIC`），本地基线判定为"水/雷角色借助装备与天赋形成持续站场输出"，但实战是 T2 斩杀卡组（错判核心原因：T1 万家灶火检索天赋→飞蛇战技稳定抽3→T2 能量块充能+仙跳墙→飞蛇大招 (2+3)×2=10 斩杀）。

差距根源分为两类：**信号表覆盖不足**（已修复）和**静态分析架构层面的时序盲区**（本文记录）。

---

## 已修复：信号表覆盖不足

在 `packages/llm-deck-analyzer/src/effect-extractor/chain-detector.ts` 中扩展了 `SIGNAL_TRIGGER_MATCHES` 和相关基础设施：

### 新增信号类型（SignalKind）

| 信号 | 语义 | 对应 EffectKind |
|------|------|-----------------|
| `heal` | 治疗 | `heal` |
| `gain_energy` | 充能 | `gain_energy` |
| `shield` | 护盾 | `shield` |
| `amplify_damage` | 增伤/伤害翻倍 | `increase_damage`, `multiply_damage` |
| `apply_element` | 附着元素 | `apply_element` |

### 新增匹配规则（SIGNAL_TRIGGER_MATCHES）

| 信号 | 触发 | 概率 | 边类型 | 描述 |
|------|------|------|--------|------|
| `heal` | `on_heal` | likely | enables | 治疗触发治疗响应效果 |
| `heal` | `on_damaged` | possible | enables | 治疗触发受击/治疗共享效果 |
| `create_hand_card` | `on_play_card` | likely | enables | 生成手牌可被打出触发打出效果 |
| `amplify_damage` | `on_damage_increase` | likely | amplifies | 增伤效果叠加提升伤害 |
| `amplify_damage` | `on_damage_dealt` | likely | amplifies | 增伤强化伤害输出 |
| `shield` | `on_damaged` | possible | protects | 护盾使角色存活触发受击效果 |
| `apply_element` | `on_reaction` | likely | enables | 附着元素可触发反应效果 |
| `defeat` | `on_defeated` | likely | finishes | 击倒触发击倒效果 |
| `gain_energy` | `on_skill_use` | likely | enables | 充能使角色能够使用技能 |
| `gain_energy` | `on_damage_increase` | possible | amplifies | 充能配合增伤提升爆发 |
| `damage` | `on_damage_dealt` | likely | enables | 造成伤害触发伤害响应效果 |

### 同步修改

- `effectToSignal()`：新增 `heal`、`gain_energy`、`shield`、`amplify_damage`（含 `multiply_damage`）、`apply_element` 分支
- `isScopeCompatible()`：新增 `heal`、`gain_energy`、`shield`、`apply_element`、`amplify_damage` 的作用域兼容判定
- `heuristics.ts` 正则提取器：新增治疗/充能/护盾/伤害翻倍/元素附着效果的正则匹配模式
- `heuristics.ts` 触发模式：新增 `on_heal`、`on_play_card`、`on_enter`、`on_draw`、`on_generate_dice` 触发模式的正则匹配
- `heuristics.ts` 触发作用域推断：玩家级事件（打出/抽牌/生成骰子/弃牌/切人/回合开始结束）自动推断 `samePlayer` 范围

### 修复后的检测效果

| 链路 | 修复前 | 修复后 |
|------|--------|--------|
| 亡雷凝蓄→亡风啸卷（能量块循环） | ❌ 未检测 | ✅ `create_hand_card → on_play_card` |
| 海染砗磲→老兵的容颜（治疗触发） | ❌ 未检测 | ✅ `heal → on_heal` / `heal → on_damaged` |
| 仙跳墙→海染砗磲（增伤→造伤） | ❌ 未检测 | ✅ `amplify_damage → on_damage_dealt` |
| 海染砗磲→逐影猎人（治疗触发） | ❌ 未检测 | ✅ `heal → on_heal` / `heal → on_damaged` |

---

## 未修复：静态分析架构层面的时序盲区

以下4项泛用性较差，不适合在当前静态分析框架中实现，记录于此供后续参考。

### 1. 斩杀速度估算

**现状**：`scoreDeckStrength`（heuristics.ts）是纯加法公式 `5.6 + supportCount×0.12 + talentCount×0.28 + ...`，无法反映卡组的爆发伤害能力。

**差距**：无法区分"站场运营"和"T2斩杀"两种截然不同的制胜模式。圣骸卡组的10点T2爆发在分数上完全不可见。

**修复思路**：增加"爆发斩杀计算器"模块——
1. 统计所有可用伤害源（角色大招+增伤牌+反应）
2. 检查充能来源能否在T2前充满（需结合第3项"充能速率估算"）
3. 若最高单回合爆发伤害≥8，归类为"快杀"而非"站场运营"
4. 在 `inferArchetype` 中增加 "快杀" 原型分支

**为何泛用性差**：此逻辑高度依赖具体卡牌效果的组合计算（哪些增伤可叠加、充能来源何时到账），不同卡组的斩杀路径差异极大，难以抽象为通用规则。对圣骸卡组有效的"能量块充能速率"计算对其他卡组无意义。

---

### 2. 起手保证资源识别

**现状**：`inferArchetype` 只看卡牌类型计数，不区分"秘传牌必在起手"与"普通事件牌需抽到"。

**差距**：万家灶火是秘传牌（必定在起始手牌、只能第1回合打出），它检索天赋的命中率是100%。分析器将其与普通事件牌等同处理，无法识别"T1必能装备天赋"这一确定性启动路径。

**修复思路**：
1. 给秘传牌打 `guaranteed_t1` 标记（基于 `GCG_TAG_LEGEND` tag）
2. 若卡组含秘传+2+不同天赋牌，计算"秘传检索天赋命中率=100%"
3. 在 `inferArchetype` 的 `earlyGame` 描述中加入"起手保证"信息

**为何泛用性差**：秘传牌种类有限（每版本1-2张），每张秘传的检索目标不同（天赋/武器/圣遗物/事件），为每种检索写专门规则ROI很低。且"检索后是否真的有用"仍取决于后续链路分析——如果不做第1项的斩杀估算，单知道"起手有天赋"不足以改变原型判定。

---

### 3. 充能速率估算

**现状**：`characterFullInfo` 记录了 `maxEnergy` 但从不用它估算爆发时机。

**差距**：圣骸飞蛇需要2点充能，被动每回合生成2张能量块入牌库、天赋入场再生成1张入手中——分析器完全无法推算"T2可充能满"，因此无法识别T2大招斩杀的可行性。

**修复思路**：
1. 追踪所有充能来源：被动技能的周期性充能、天赋/装备的入场充能、事件牌的即时充能
2. 估算"第N回合充能几成满"（需结合牌库抽牌概率，粗估即可）
3. 将充能速率作为 `tempoProfile` 的一个新维度（如 `burstReadiness`：T1=0.3, T2=0.8, T3=1.0）
4. 与第1项"斩杀速度"联动：若 burstReadiness(T2) ≥ 0.8 且爆发伤害 ≥ 8，判定为快杀

**为何泛用性差**：充能来源的多样性使通用估算极难——圣骸卡组靠能量块充能（特殊的生成手牌机制），其他卡组靠事件牌/被动充能/元素骰颜色匹配充能。每种充能路径都需要不同的估算逻辑，无法统一抽象。此外，能量块充能是 v4.7 特有机制（后续版本已削弱），为此写专门规则毫无长期价值。

---

### 4. 原型分类增加"组合快杀"

**现状**：`inferArchetype` 只有3-4个模式——
- `hasReactionPackage`：反应雪球
- `hasSupportEngine`：支援运营
- `hasTalentPackage` / `hasEquipmentPackage`：装备天赋站场

没有"组合快杀"类型。

**差距**：圣骸卡组的制胜方式是"T1铺垫→T2一回合斩杀"，不属于以上任何原型，被默认归入"站场输出"。

**修复思路**：增加一条规则——
```
if (burstAmplifier >= 1 && burstReadiness(T2) >= 0.8 && hasGuaranteedSetup) {
  archetype = "组合快杀"
  winCondition = "快速铺开组合组件后一回合爆发斩杀"
}
```
其中 `burstAmplifier` = 仙跳墙/温妮莎传奇等增伤牌数量，`burstReadiness` = 充能速率，`hasGuaranteedSetup` = 秘传/T1确定资源。

**为何泛用性差**：此规则的3个前置条件全部依赖第1-3项的实现，而那3项本身泛用性差。此外"组合快杀"原型的判定阈值（爆发≥8? 充能≥0.8?）需要大量卡组样本校准，当前无数据支撑。对单个卡组做针对性的原型调整很容易，但做成通用规则需要更多测试用例。

---

## 不可修复项（超出静态分析边界）

| 局限 | 原因 | 所需能力 |
|------|------|----------|
| 真实行动序列生成 | 需游戏状态机枚举合法操作 | `@gi-tcg/core` Game 类 |
| 骰子可行性验证 | 需蒙特卡洛模拟骰子分布 | 概率模拟引擎 |
| 对手干扰鲁棒性 | 需博弈树搜索 | `@gi-tcg/gi-agent` AI 对局 |

这3项从根本上超出静态分析（无游戏状态、无对手模型、无随机模拟）的边界，属于运行时引擎或AI对局的范畴。
