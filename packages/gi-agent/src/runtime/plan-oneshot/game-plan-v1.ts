// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * GamePlanV1 — one-shot 赛前决策树（政策函数）的 schema。
 *
 * 设计文档：docs/plans/2026-08-21-one-shot-gameplan-benchmark.md §2。
 * 规则链语义与 MCP 侧 DecisionFragmentV1（packages/mcp/src/scoring/types.ts）
 * 同构，但 when 字段作用于玩家视角 state 而非 digest。
 */

/** when 子句的比较算子 */
export type PlanConditionOp = "<=" | ">=" | "==" | "!=" | "<" | ">"

/** 单条 when 条件。field 取值见 fields.ts 的封闭白名单。 */
export interface WhenConditionV1 {
  /** 字段路径，如 "self.active.hp"、"dice.pyro"、"hand.hasCard.321006" */
  field: string
  op: PlanConditionOp
  /** 期望比较值；"$field.path" 前缀表示动态引用另一字段 */
  value: number | string | boolean
}

/** then 子句的动作规格（对合法动作列表的匹配约束） */
export interface ActionSpecV1 {
  action_case: "useSkill" | "playCard" | "switchActive" | "declareEnd" | "elementalTuning"
  /** 仅 useSkill：技能类型 */
  skill_type?: "normal_attack" | "elemental_skill" | "burst"
  /**
   * 仅 useSkill：精确技能 definition id（与 core `skillDefinitionId` 同域；
   * 牌表详情里 `#<id>` 即此值）。同类型多战技角色（如纳西妲两个元素战技
   * 17032 3草 / 17033 5草）用它指名具体技能；缺省时按 skill_type 匹配。
   * 与 skill_type 同时给出时两个过滤都生效。
   */
  skill_def_id?: number
  /**
   * 目标限定。字符串枚举："opponent.active" | "opponent.benched"；
   * 数字 = **角色 definition id**（实体 id 是对局运行时才产生的，LLM 赛前
   * 不可能知道，执行侧会做 defId → 实体 id 的映射）。
   */
  target?: string | number
  /** 软偏好：preview 中出现这些反应时优先（不作为硬过滤） */
  prefer_reaction?: string[]
  /** 硬过滤：preview 总伤害不低于该值 */
  damage_min?: number
  /** 硬过滤：preview 含 causeDefeated */
  kills?: boolean
  /** 仅 playCard：按卡牌定义 tag 匹配 */
  card_tag?: string
  /** 仅 playCard：按 definition id 精确匹配 */
  card_def_id?: number
  /** 按动作目标/来源定义的 tag 匹配（当前仅对 playCard 生效） */
  require_tag?: string
}

/** 一条决策规则。priority 数字小者优先。when 省略或为空 = 恒真。 */
export interface DecisionRuleV1 {
  priority: number
  when?: WhenConditionV1[]
  then: ActionSpecV1
  /** 人类可读理由；进入 trace 与反思归因 */
  reason: string
}

/** 开局出战角色规则：首条 when 全真者生效 */
export interface OpeningChooseActiveRuleV1 {
  when?: WhenConditionV1[]
  /** 角色 definition id（如 1302） */
  characterDefId: number
  reason: string
}

/** 换牌规则：keep / toss 二选一，按 defId 或 tag 匹配手牌 */
export interface MulliganRuleV1 {
  keep?: { cardDefId?: number; cardTag?: string }
  toss?: { cardDefId?: number; cardTag?: string }
  reason: string
}

/** 重掷规则：首条 when 全真者生效；保留列出的元素骰与万能骰 */
export interface RerollRuleV1 {
  when?: WhenConditionV1[]
  /** 保留的骰子元素名（cryo/hydro/pyro/electro/anemo/geo/dendro/omni） */
  keepElements: string[]
  /** 若按元素保留不足该数，按骰序补足 */
  minKeep?: number
  reason: string
}

/** 阶段：when 全真时其 rules 前置到全局 rules 之前 */
export interface GamePlanPhaseV1 {
  phaseId: string
  when: WhenConditionV1[]
  rules: DecisionRuleV1[]
}

export type PlanFallbackPolicyKind = "baseline" | "conservative" | "declare_end"

export interface GamePlanV1 {
  version: "GamePlanV1"
  /** 内容 hash（sha256 前 12 位，见 validate.ts computePlanId） */
  planId: string
  /** 反思修订链：上一版 planId */
  parentPlanId: string | null
  createdAt: string
  /** 作者模型标识，如 "deepseek-v4-flash"；"manual" 表示手写 */
  author: string
  /** LLM 采样参数（可复现性记录；引擎侧确定性只覆盖执行，不覆盖生成） */
  sampling?: { temperature: number; seed?: number; anchor?: boolean }

  context: {
    deckCode: string
    opponent:
      | { kind: "mirror" }
      | { kind: "known_deck"; deckCode: string }
      | { kind: "unknown_deck" }
    gameVersion?: string
  }

  /** 赛前预测——校准数据源，全部强制 */
  predictions: {
    winRateEstimate: number
    expectedRounds: number
    confidence: number
    keyThreats: string[]
  }

  opening: {
    chooseActive: OpeningChooseActiveRuleV1[]
    mulligan: MulliganRuleV1[]
    reroll: RerollRuleV1[]
  }

  /** 阶段列表；运行时取首个 when 全真的阶段 */
  phases: GamePlanPhaseV1[]

  /** 全局规则链——主政策 */
  rules: DecisionRuleV1[]

  /** 全部未命中时的兜底（强制） */
  fallback: { policy: PlanFallbackPolicyKind }
}
