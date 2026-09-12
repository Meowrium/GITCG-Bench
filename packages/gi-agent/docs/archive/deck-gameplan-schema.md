# DeckGamePlan — 回合级战略计划 JSON Schema

> **⚠️ 状态：部分过时** — DeckGamePlan TypeScript 接口定义，后续被 StrategicPlanLayer 继承和修改。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

## 设计原则

1. **LLM 负责战略推理**（"为什么这么做"），不负责数值计算（"伤害多少"）
2. **辅助程序负责数值验证**（骰子可行性、伤害预测、能量周期）
3. **运行时策略用 `preferredActions`/`avoidActions` 中的动作标签匹配候选动作**

## 顶层结构

```typescript
interface DeckGamePlan {
  /** 卡组原型的标准分类 */
  archetype: Archetype;

  /** 回合级计划，按 round 排序 */
  turnPlans: TurnPlan[];

  /** 两套斩杀链（最少骰子 / 最大伤害），含精确伤害和骰子预算 */
  winConditions: WinConditionSequence[];

  /** 对战特定对手类型的调整说明（供 LLM 生成，运行时由 match 匹配） */
  matchupAdjustments?: MatchupAdjustment[];

  /** 卡组的关键手牌和它们的优先级排序 */
  keyCards: KeyCardPriority[];

  /** 开局选角色逻辑 */
  openingActive: OpeningActiveRule;
}
```

---

## Archetype

```typescript
type Archetype =
  | "freeze_control"       // 冻结控制：挂水 → 扩散 → 冻结锁
  | "swirl_aggro"          // 扩散快攻：挂元素 → 速切风 → 扩散AOE
  | "summon_value"         // 召唤物价值：铺场 → 持续伤害 → 人数优势
  | "burst_otk"            // 爆发OTK：蓄力 → 能量转移 → 单回合碾压
  | "overload_tempo"       // 超载节奏：火雷反应 → 强制切人 → 节奏压制
  | "midrange_reaction"    // 中速反应：均衡前中后期，靠元素反应取胜
  | "control_stall"        // 控制拖延：治疗/护盾 → 消耗资源 → 持久战
  | "aggro_rush"           // 纯快攻：T1开始压血线 → T2-T3收尾
  | "dual_element_combo"   // 双色连招：精确的两元素反应链
  | "phys_hypercarry"      // 物理单核：buff堆叠 → 物理穿透输出
```

---

## TurnPlan

```typescript
interface TurnPlan {
  /** 回合编号（1-based） */
  turn: number;

  /** 本回合的战略目标，一句话描述 */
  goal: string;

  /**
   * 优先动作列表（按优先级排序）。
   * 每个元素可以是一个动作标签字符串或一个结构化动作描述。
   *
   * 动作标签命名规范：
   *   {character_name}_{skill_type}     — 角色技能
   *   play_{card_name}                   — 打出手牌
   *   switch_to_{character_name}         — 切人
   *   fast_switch_to_{character_name}    — 快速切人（利用莫娜被动等）
   *   end_turn                           — 结束回合
   *   elemental_tune                     — 元素调和
   *   reroll_dice_for_{element}          — 重投找特定元素骰
   */
  preferredActions: string[];

  /** 应避免的动作（如果候选列表中有这些，降低评分） */
  avoidActions: string[];

  /** 本回合骰子预算（理想情况下需要的骰子数） */
  diceBudget: {
    min: number;
    ideal: number;
    /** 关键元素骰需求 */
    criticalElements: { element: string; count: number }[];
  };

  /**
   * 本回合结束条件。
   * 满足条件时，即使骰子还有剩余，也应该考虑结束回合。
   */
  endCondition?: string;

  /**
   * 如果对手做出意外行为，本回合的备选方案。
   * key = 对手行为描述，value = 调整后的动作优先级。
   */
  contingencies?: Record<string, string[]>;
}
```

---

## WinConditionSequence

```typescript
interface WinConditionSequence {
  /** 斩杀链名称 */
  name: string;

  /** 触发条件（什么局面下应尝试此斩杀链） */
  trigger: string;

  /** 动作序列 */
  steps: WinConditionStep[];

  /** 总计（辅助程序可验证） */
  totals: {
    diceRequired: number;
    damageDealt: number;
    energyRequired: number;
  };
}

interface WinConditionStep {
  /** 动作标签 */
  action: string;
  /** 此步造成的预估伤害 */
  expectedDamage: number;
  /** 此步消耗的骰子 */
  diceCost: number;
  /** 此步需要的能量 */
  energyCost?: number;
}
```

---

## MatchupAdjustment

```typescript
interface MatchupAdjustment {
  /** 对手卡组特征（用于匹配） */
  opponentArchetype: Archetype;

  /** 调整后的回合计划 */
  turnOverrides: Partial<TurnPlan>[];
}
```

---

## KeyCardPriority

```typescript
interface KeyCardPriority {
  cardName: string;
  /** 优先级 1-10，10 为最高 */
  priority: number;
  /** 此牌在什么时候最有用 */
  bestTiming: "mulligan_keep" | "early" | "mid" | "late" | "combo_piece";
  /** 说明 */
  reason: string;
}
```

---

## OpeningActiveRule

```typescript
interface OpeningActiveRule {
  /** 首选出战角色 */
  default: string;

  /** 根据对手卡组调整出战选择 */
  byOpponent?: Record<string, string>;
}
```
