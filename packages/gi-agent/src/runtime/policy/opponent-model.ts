// Copyright (C) 2024-2025 Guyutongxue
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

// ---------------------------------------------------------------------------
// P3: Opponent Modeling — Archetype Prior + Bayesian Posterior
// ---------------------------------------------------------------------------
// §18.3 P3: "用对手 archetype 先验（从阵营推断）初始化对手模型"
//            "对手行为随对局进行逐步更新（贝叶斯后验）"

/**
 * 对手卡组原型 — 从角色阵容推测对手的打法风格。
 */
export type OpponentArchetype =
  | "aggro"          // 快攻：高倍技能、低费曲线、重伤害
  | "midrange"       // 中速节奏：均衡型、重反应
  | "control"        // 控制：重治疗/护盾、堆支援物
  | "combo"          // 连招/OTK：重能量积累、关键连携
  | "unknown"

/**
 * 对手先验概率分布。
 */
export interface OpponentPrior {
  aggro: number
  midrange: number
  control: number
  combo: number
}

/**
 * 对手行为观测类别 — 用于贝叶斯更新。
 */
export type OpponentBehaviorEvent =
  | "high_damage_skill"      // 使用了高伤技能
  | "healing_action"         // 使用了治疗
  | "support_deploy"         // 部署了支援物
  | "energy_charge"          // 大招充能行为
  | "swap_aggressive"        // 积极切人（快攻特征）
  | "swap_defensive"         // 防御切人（控制特征）
  | "declare_end_early"      // 提前宣布结束
  | "elemental_tuning"       // 调和（通常意味着手牌冗余）
  | "combo_sequence"         // 连续快速行动
/**
 * 对手模型运行时状态。
 */
export interface OpponentModelState {
  /** 当前后验概率 */
  posterior: OpponentPrior
  /** 最可能的原型 */
  mostLikely: OpponentArchetype
  /** 已观测到的行为事件计数 */
  observedEvents: Record<OpponentBehaviorEvent, number>
  /** 总观测轮次 */
  roundsObserved: number
  /** 推断置信度 [0, 1] */
  confidence: number
  /** P1-2: 对手攻击倾向分 (0~1) */
  oppAggressionScore: number
  /** P1-2: 对手切人频率 (次/回合) */
  oppSwitchFrequency: number
  /** P1-2: 对手爆发技能使用率 (0~1) */
  oppBurstUsageRate: number
  /** P1-2: 每回合行为统计 */
  roundBehaviorSummary: OpponentRoundBehaviorSummary
}

export interface OpponentRoundBehaviorSummary {
  attackActions: number
  healActions: number
  switchActions: number
  burstActions: number
  totalActions: number
}

// ---------------------------------------------------------------------------
// 元素 → 原型先验映射
// ---------------------------------------------------------------------------
// 基于 TCG 元阵容经验：
//   Pyro heavy → aggro/midrange
//   Cryo/Hydro → midrange/control
//   Electro → midrange/combo
//   Dendro → combo/control
//   Anemo/Geo → varies (flexible)

const ELEMENT_ARCHETYPE_BIAS: Record<string, Partial<OpponentPrior>> = {
  pyro:    { aggro: 0.35, midrange: 0.30, control: 0.10, combo: 0.25 },
  hydro:   { aggro: 0.15, midrange: 0.30, control: 0.35, combo: 0.20 },
  cryo:    { aggro: 0.20, midrange: 0.35, control: 0.30, combo: 0.15 },
  electro: { aggro: 0.20, midrange: 0.30, control: 0.15, combo: 0.35 },
  dendro:  { aggro: 0.10, midrange: 0.25, control: 0.30, combo: 0.35 },
  anemo:   { aggro: 0.25, midrange: 0.30, control: 0.20, combo: 0.25 },
  geo:     { aggro: 0.15, midrange: 0.30, control: 0.35, combo: 0.20 },
}

// 行为事件的似然比 P(event | archetype)
const BEHAVIOR_LIKELIHOOD: Record<OpponentBehaviorEvent, OpponentPrior> = {
  high_damage_skill:  { aggro: 0.40, midrange: 0.30, control: 0.10, combo: 0.20 },
  healing_action:     { aggro: 0.05, midrange: 0.20, control: 0.55, combo: 0.20 },
  support_deploy:     { aggro: 0.10, midrange: 0.25, control: 0.45, combo: 0.20 },
  energy_charge:      { aggro: 0.15, midrange: 0.20, control: 0.15, combo: 0.50 },
  swap_aggressive:    { aggro: 0.45, midrange: 0.25, control: 0.10, combo: 0.20 },
  swap_defensive:     { aggro: 0.10, midrange: 0.25, control: 0.45, combo: 0.20 },
  declare_end_early:  { aggro: 0.15, midrange: 0.25, control: 0.40, combo: 0.20 },
  elemental_tuning:   { aggro: 0.25, midrange: 0.30, control: 0.20, combo: 0.25 },
  combo_sequence:     { aggro: 0.20, midrange: 0.20, control: 0.10, combo: 0.50 },
}

// ---------------------------------------------------------------------------
// 核心函数
// ---------------------------------------------------------------------------

/**
 * 从对手角色元素组合推断先验概率。
 */
export function inferArchetypePrior(
  opponentCharacterElements: string[],
): OpponentPrior {
  const prior: OpponentPrior = { aggro: 0.25, midrange: 0.25, control: 0.25, combo: 0.25 }
  if (opponentCharacterElements.length === 0) {
    return prior
  }

  // 累加每个角色元素的先验偏好
  const counts: OpponentPrior = { aggro: 0, midrange: 0, control: 0, combo: 0 }
  for (const elem of opponentCharacterElements) {
    const bias = ELEMENT_ARCHETYPE_BIAS[elem.toLowerCase()]
    if (bias) {
      counts.aggro += bias.aggro ?? 0.25
      counts.midrange += bias.midrange ?? 0.25
      counts.control += bias.control ?? 0.25
      counts.combo += bias.combo ?? 0.25
    } else {
      // 未知元素使用均匀分布
      counts.aggro += 0.25
      counts.midrange += 0.25
      counts.control += 0.25
      counts.combo += 0.25
    }
  }

  return normalizePrior(counts)
}

/**
 * 初始化对手模型状态。
 */
export function initOpponentModel(
  opponentCharacterElements: string[],
): OpponentModelState {
  const posterior = inferArchetypePrior(opponentCharacterElements)
  return {
    posterior,
    mostLikely: argmax(posterior),
    observedEvents: createEmptyEventCounts(),
    roundsObserved: 0,
    confidence: 0,
    oppAggressionScore: 0.5,
    oppSwitchFrequency: 0,
    oppBurstUsageRate: 0,
    roundBehaviorSummary: createEmptyRoundBehaviorSummary(),
  }
}

/**
 * 贝叶斯后验更新：观测到对手行为事件后更新概率。
 *
 * P(A|B) ∝ P(B|A) × P(A)
 *
 * @returns 新的对手模型状态（不修改输入）
 */
export function updateOpponentModel(
  state: OpponentModelState,
  events: OpponentBehaviorEvent[],
  roundBehavior?: OpponentRoundBehaviorSummary,
): OpponentModelState {
  const newCounts = { ...state.observedEvents }
  let posterior = { ...state.posterior }
  const newRoundBehavior = roundBehavior ?? state.roundBehaviorSummary

  for (const event of events) {
    newCounts[event] = (newCounts[event] ?? 0) + 1
    const likelihood = BEHAVIOR_LIKELIHOOD[event]
    if (likelihood) {
      posterior = {
        aggro: posterior.aggro * likelihood.aggro,
        midrange: posterior.midrange * likelihood.midrange,
        control: posterior.control * likelihood.control,
        combo: posterior.combo * likelihood.combo,
      }
      posterior = normalizePrior(posterior)
    }
  }

  const roundsObserved = state.roundsObserved + 1
  const totalAttackEvents = newCounts.high_damage_skill + newCounts.swap_aggressive
  const totalEvents = Object.values(newCounts).reduce((s, v) => s + v, 0)
  const oppAggressionScore = totalEvents > 0
    ? Math.min(1, (totalAttackEvents / totalEvents) * 2)
    : state.oppAggressionScore * 0.9 + 0.5 * 0.1
  const oppSwitchFrequency = roundsObserved > 0
    ? (newCounts.swap_aggressive + newCounts.swap_defensive) / roundsObserved
    : 0
  const oppBurstUsageRate = roundsObserved > 0
    ? newCounts.energy_charge / roundsObserved
    : 0

  return {
    posterior,
    mostLikely: argmax(posterior),
    observedEvents: newCounts,
    roundsObserved,
    confidence: computeConfidence(posterior, roundsObserved),
    oppAggressionScore,
    oppSwitchFrequency,
    oppBurstUsageRate,
    roundBehaviorSummary: newRoundBehavior,
  }
}

/**
 * 从对手模型推断他们可能的下一步风格偏好。
 */
export function predictOpponentStyle(state: OpponentModelState): {
  /** 对手偏好高伤害行动的概率 */
  aggressionLevel: number
  /** 对手偏好防御/治疗的概率 */
  defensivenessLevel: number
  /** 对手可能尝试 combo/大招的概率 */
  comboLikelihood: number
  /** 对手攻击倾向分 (0~1) */
  aggressionScore: number
  /** 对手切人频率 (次/回合) */
  switchFrequency: number
  /** 对手爆发技能使用率 (0~1) */
  burstUsageRate: number
} {
  const baseAggro = state.posterior.aggro * 0.6 + state.posterior.combo * 0.3 + state.posterior.midrange * 0.1
  const baseDefensive = state.posterior.control * 0.6 + state.posterior.midrange * 0.3 + state.posterior.combo * 0.1
  const baseCombo = state.posterior.combo * 0.7 + state.posterior.aggro * 0.15 + state.posterior.midrange * 0.15
  const blendFactor = state.confidence * 0.5
  return {
    aggressionLevel: baseAggro * (1 - blendFactor) + state.oppAggressionScore * blendFactor,
    defensivenessLevel: baseDefensive,
    comboLikelihood: baseCombo * (1 - blendFactor) + state.oppBurstUsageRate * blendFactor,
    aggressionScore: state.oppAggressionScore,
    switchFrequency: state.oppSwitchFrequency,
    burstUsageRate: state.oppBurstUsageRate,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePrior(p: OpponentPrior): OpponentPrior {
  const total = p.aggro + p.midrange + p.control + p.combo
  if (total <= 0) {
    return { aggro: 0.25, midrange: 0.25, control: 0.25, combo: 0.25 }
  }
  return {
    aggro: p.aggro / total,
    midrange: p.midrange / total,
    control: p.control / total,
    combo: p.combo / total,
  }
}

function argmax(p: OpponentPrior): OpponentArchetype {
  const entries: [OpponentArchetype, number][] = [
    ["aggro", p.aggro],
    ["midrange", p.midrange],
    ["control", p.control],
    ["combo", p.combo],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

function computeConfidence(posterior: OpponentPrior, roundsObserved: number): number {
  // 置信度基于: (1) 后验分布的集中程度 (2) 观测轮次
  const maxProb = Math.max(posterior.aggro, posterior.midrange, posterior.control, posterior.combo)
  const entropy = -[posterior.aggro, posterior.midrange, posterior.control, posterior.combo]
    .filter((p) => p > 0)
    .reduce((sum, p) => sum + p * Math.log2(p), 0)
  const maxEntropy = Math.log2(4) // 2 bits for 4 categories
  const concentration = 1 - entropy / maxEntropy
  const observationFactor = Math.min(1, roundsObserved / 4) // 4 轮后饱和
  return Math.min(1, concentration * 0.7 + observationFactor * 0.3)
}

function createEmptyEventCounts(): Record<OpponentBehaviorEvent, number> {
  return {
    high_damage_skill: 0,
    healing_action: 0,
    support_deploy: 0,
    energy_charge: 0,
    swap_aggressive: 0,
    swap_defensive: 0,
    declare_end_early: 0,
    elemental_tuning: 0,
    combo_sequence: 0,
  }
}

function createEmptyRoundBehaviorSummary(): OpponentRoundBehaviorSummary {
  return {
    attackActions: 0,
    healActions: 0,
    switchActions: 0,
    burstActions: 0,
    totalActions: 0,
  }
}

export function extractOpponentBehaviorFromActions(
  actions: ReadonlyArray<{ action_case?: string; tags?: unknown }>,
): OpponentBehaviorEvent[] {
  const events: OpponentBehaviorEvent[] = []
  for (const action of actions) {
    const actionCase = String(action.action_case ?? "")
    const tags = Array.isArray(action.tags) ? action.tags.map(String) : []
    switch (actionCase) {
      case "useSkill":
        events.push("high_damage_skill")
        if (tags.some((t) => t.includes("burst") || t.includes("skill_type:burst"))) {
          events.push("energy_charge")
        }
        break
      case "playCard":
        if (tags.some((t) => t === "heal" || t === "heal_now" || t === "tag:food")) {
          events.push("healing_action")
        }
        if (tags.some((t) => t.includes("support_create") || t.includes("support_card"))) {
          events.push("support_deploy")
        }
        break
      case "switchActive":
        events.push("swap_aggressive")
        break
      case "elementalTuning":
        events.push("elemental_tuning")
        break
      case "declareEnd":
        events.push("declare_end_early")
        break
    }
    if (tags.some((t) => t.includes("fast")) && events.length > 0) {
      events.push("combo_sequence")
    }
  }
  return events
}
