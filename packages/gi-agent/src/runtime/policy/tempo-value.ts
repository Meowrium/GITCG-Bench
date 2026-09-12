// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// ---------------------------------------------------------------------------
// Tempo Value Computation — State-Driven (Not Search-Based)
// ---------------------------------------------------------------------------
// §18.4: 时序价值是状态属性，不是搜索结果。
// 抢先/后、速切抢轮次/慢切拖轮次的博弈适用于所有卡组。
// 计算方式：从 GameState 直接提取节奏特征，O(1) 求解，无需 sim.step。
//
// 五层时序模型：
//   L1: 快速行动链 (Fast Action Chain)
//   L2: 回合结束博弈 (declareEnd Game)
//   L3: 召唤/状态跨回合压力 (Round-Boundary Pressure)
//   L4: 元素持久化利用 (Element Persistence)
//   L5: 骰子/手牌非对称消耗 (Resource Asymmetry)
//
// 与搜索方案的本质区别：
//   - 搜索: 模拟对手动作 → 计算路径价值 → 36s/局
//   - 状态估值: 从 state 计算特征 → O(1) → 0s 额外开销
// ---------------------------------------------------------------------------

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  CharacterObservationV1,
  EntityObservationV1,
  PlayerObservationV1,
} from "@gi-tcg/ml/contracts"

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

export interface TempoValueResult {
  /** 总的时序价值 (正值 = 应该抢节奏，负值 = 应该让节奏) */
  total: number
  /** 各分量分解 */
  components: {
    /** L3: 召唤跨回合压力差 (我方 - 对手) */
    summonPressureDelta: number
    /** L1: 快速行动能力优势 */
    fastActionAdvantage: number
    /** L4: 元素附着 + 反应潜力 */
    elementPersistenceValue: number
    /** L5: 骰子消耗差的博弈价值 */
    resourceBluffValue: number
    /** L2: 斩杀风险 (负值 = 危险) */
    lethalRisk: number
    /** L2: 对手已结束的抢先手奖励 */
    initiativeStealBonus: number
  }
  reason: string
}

export interface TempoWeightConfig {
  /** 召唤压力权重 (default: 0.5) */
  summonPressureWeight: number
  /** 快速行动优势权重 (default: 1.5) */
  fastActionWeight: number
  /** 元素持久化权重 (default: 1.0) */
  elementPersistenceWeight: number
  /** 资源博弈权重 (default: 0.6) */
  resourceBluffWeight: number
  /** 斩杀风险惩罚权重 (default: 5.0) */
  lethalRiskWeight: number
  /** 抢先手奖励基数 (default: 2.0) */
  initiativeStealBase: number
}

export const DEFAULT_TEMPO_WEIGHTS: TempoWeightConfig = {
  summonPressureWeight: 0.5,
  fastActionWeight: 1.5,
  elementPersistenceWeight: 1.0,
  resourceBluffWeight: 0.6,
  lethalRiskWeight: 5.0,
  initiativeStealBase: 2.0,
}

/**
 * 计算 declareEnd 的时序价值。
 *
 * 调用时机：candidate.action_case === "declareEnd" 时。
 *
 * 返回正值 = declareEnd 有节奏优势 (应优先结束)
 * 返回负值 = declareEnd 有风险 (应继续行动)
 */
export function computeInitiativeValue(
  observation: ObservationV1,
  selfWho: 0 | 1,
  weights: Partial<TempoWeightConfig> = {},
): TempoValueResult {
  const w = { ...DEFAULT_TEMPO_WEIGHTS, ...weights }
  const self = selfWho === 0 ? observation.self : observation.opponent
  const opp = selfWho === 0 ? observation.opponent : observation.self

  // ── L3: 召唤跨回合压力 ──
  const summonPressureDelta = computeSummonPressureDelta(self, opp)
  const summonScore = summonPressureDelta * w.summonPressureWeight

  // ── L1: 快速行动能力优势 ──
  const fastActionAdv = computeFastActionAdvantage(self, opp)
  const fastScore = fastActionAdv * w.fastActionWeight

  // ── L4: 元素持久化利用价值 ──
  const elementValue = computeElementPersistenceValue(self, opp)
  const elementScore = elementValue * w.elementPersistenceWeight

  // ── L5: 资源博弈价值 ──
  const bluffValue = computeResourceBluffValue(self, opp)
  const bluffScore = bluffValue * w.resourceBluffWeight

  // ── L2: 斩杀风险 ──
  const lethal = computeLethalRisk(self, opp, observation)
  const lethalScore = lethal * w.lethalRiskWeight

  // ── L2: 抢先手奖励 ──
  const initiativeBonus = computeInitiativeStealBonus(opp, self, observation)
  const initiativeScore = initiativeBonus * w.initiativeStealBase

  const total = summonScore + fastScore + elementScore + bluffScore + lethalScore + initiativeScore

  const reasonParts: string[] = []
  if (Math.abs(summonScore) > 0.01) reasonParts.push(`summon=${summonScore.toFixed(2)}`)
  if (Math.abs(fastScore) > 0.01) reasonParts.push(`fast=${fastScore.toFixed(2)}`)
  if (Math.abs(elementScore) > 0.01) reasonParts.push(`elem=${elementScore.toFixed(2)}`)
  if (Math.abs(bluffScore) > 0.01) reasonParts.push(`bluff=${bluffScore.toFixed(2)}`)
  if (Math.abs(lethalScore) > 0.01) reasonParts.push(`lethal=${lethalScore.toFixed(2)}`)
  if (Math.abs(initiativeScore) > 0.01) reasonParts.push(`initiative=${initiativeScore.toFixed(2)}`)

  return {
    total,
    components: {
      summonPressureDelta,
      fastActionAdvantage: fastActionAdv,
      elementPersistenceValue: elementValue,
      resourceBluffValue: bluffValue,
      lethalRisk: lethal,
      initiativeStealBonus: initiativeBonus,
    },
    reason: reasonParts.length > 0 ? `tempo_initiative(${reasonParts.join(",")})=${total.toFixed(2)}` : "",
  }
}

/**
 * 计算单个快速行动的节奏价值。
 *
 * 调用时机：candidate 是 fast action 时（例如快速切换、快速技能）。
 * 快速行动 = 不消耗回合交替权，因此有节奏优势。
 */
export function computeFastActionTempoValue(
  observation: ObservationV1,
  selfWho: 0 | 1,
  _fastActionDesc?: { type: string; tags?: string[] },
  weights: Partial<TempoWeightConfig> = {},
): TempoValueResult {
  const w = { ...DEFAULT_TEMPO_WEIGHTS, ...weights }
  const self = selfWho === 0 ? observation.self : observation.opponent
  const opp = selfWho === 0 ? observation.opponent : observation.self

  // 快速行动在回合末的节奏价值：
  // 1. 基础价值：每个快速行动可以压缩对手反应窗口
  // 2. 反应链价值：如果快速行动是技能且能触发反应，额外加分

  const baseTempoValue = 0.3 // 基础节奏价值

  // 检查是否有元素附着可以触发反应
  const oppActive = getActiveCharacter(opp)
  const hasReactionPotential = oppActive && oppActive.aura != null && oppActive.aura > 0

  const reactionBonus = hasReactionPotential ? 0.5 : 0

  // 对手是否已结束？如果对手已结束，我们的快速行动是"白嫖"窗口
  const oppDeclaredEnd = opp.declared_end
  const freeWindowBonus = oppDeclaredEnd ? 1.0 : 0

  const total = baseTempoValue + reactionBonus + freeWindowBonus

  const reasonParts: string[] = []
  if (baseTempoValue > 0) reasonParts.push(`base=+${baseTempoValue.toFixed(2)}`)
  if (reactionBonus > 0) reasonParts.push(`reaction=+${reactionBonus.toFixed(2)}`)
  if (freeWindowBonus > 0) reasonParts.push(`free_window=+${freeWindowBonus.toFixed(2)}`)

  return {
    total,
    components: {
      summonPressureDelta: 0,
      fastActionAdvantage: baseTempoValue + freeWindowBonus,
      elementPersistenceValue: reactionBonus,
      resourceBluffValue: 0,
      lethalRisk: 0,
      initiativeStealBonus: 0,
    },
    reason: `tempo_fast(${reasonParts.join(",")})=${total.toFixed(2)}`,
  }
}

// ---------------------------------------------------------------------------
// 各分量计算
// ---------------------------------------------------------------------------

/**
 * L3: 计算召唤物跨回合压力差。
 *
 * 回合开始时双方召唤物同时触发。压力差 = 我方能造成的伤害 - 对手能造成的伤害。
 * 注意：这里估算的是回合开始时触发的效果，不包括后续回合中的使用。
 */
function computeSummonPressureDelta(
  self: PlayerObservationV1,
  opp: PlayerObservationV1,
): number {
  const selfPressure = estimateSummonPressure(self)
  const oppPressure = estimateSummonPressure(opp)
  return selfPressure - oppPressure
}

function estimateSummonPressure(player: PlayerObservationV1): number {
  let pressure = 0

  // 召唤物：每个 usage 代表一次触发
  for (const summon of player.summons) {
    const usage = summon.variable_value ?? 1
    // 估算召唤物每次触发的伤害。
    // 常见模式：definition_id 可以查表，但为通用性，从 variable 推断。
    // 大多数召唤物 variable_name 是 "usage"，variable_value 是剩余使用次数。
    // 伤害通常在 1-3 范围，保守估计 1.5 每触发。
    const dmgPerTrigger = 1.5
    pressure += dmgPerTrigger * usage
  }

  // 战斗状态 (combat_statuses)：如激化领域、冻结领域等
  for (const status of player.combat_statuses) {
    // Entities with usage > 0 that trigger at round start
    const usage = status.variable_value ?? 0
    if (usage > 0) {
      // 战场状态通常造成 1-2 伤害或施加元素
      pressure += 1.0 * usage
    }
  }

  return pressure
}

/**
 * L1: 计算快速行动能力优势。
 *
 * 快速切换能力来自角色被动（如莫娜）或装备（如风鹰剑）。
 * 通过检查角色 tags 中的 "fast_switch" 标记。
 *
 * 优势 = (我方快速行动角色数 - 对手快速行动角色数) × 单位价值
 */
function computeFastActionAdvantage(
  self: PlayerObservationV1,
  opp: PlayerObservationV1,
): number {
  const selfFastCount = countFastSwitchCapableCharacters(self)
  const oppFastCount = countFastSwitchCapableCharacters(opp)

  return (selfFastCount - oppFastCount) * 0.8
}

function countFastSwitchCapableCharacters(player: PlayerObservationV1): number {
  let count = 0
  for (const char of player.characters) {
    if (!char.alive) continue
    // 检查是否有 fast_switch 标记
    // 这些标记来自角色的 status entities 或 equipment
    for (const entity of char.entities) {
      // 常见的快速切换实体定义 ID 范围或标签
      // 莫娜被动: 快速切换状态
      // 刻晴天赋: 快速切换效果
      // 通用方法：检查 entity 是否为 status 类型且有 "fast" 相关内容
      if (entity.variable_name?.toLowerCase().includes("fast") ||
          entity.variable_name?.toLowerCase().includes("quick")) {
        count++
        break
      }
    }
    // 也检查角色的 status_ids（状态列表）
    // 快速切换相关状态通常有特定的 definition_id 范围
    // 由于没有直接查表，使用启发式：检查 tags
    if (char.tags != null && (char.tags & 0x1) !== 0) { // heuristic bit flag
      // Not used directly; the entity check above is primary
    }
  }
  return count
}

/**
 * L4: 计算元素持久化利用价值。
 *
 * 回合结束后角色身上的元素附着不清除。如果我方 bench 角色有对应元素可以触发反应，
 * 则先手方可以在召唤伤害后立即衔接反应。
 */
function computeElementPersistenceValue(
  self: PlayerObservationV1,
  opp: PlayerObservationV1,
): number {
  const oppActive = getActiveCharacter(opp)
  if (!oppActive || oppActive.aura == null || oppActive.aura <= 0) {
    return 0
  }

  // 对手活跃角色身上有元素
  const oppAura = oppActive.aura

  // 检查我方 bench 角色是否有可以触发反应的技能
  let maxReactionValue = 0
  for (const char of self.characters) {
    if (!char.alive || char.is_active) continue
    // CharacterObservationV1 没有直接的 element 字段
    // 但 definition_id 可以通过查表获得元素类型
    // 简化：假设同阵营 bench 角色可以触发某种反应
    // 更完善的实现应查表
    const reactionPotential = estimateReactionPotential(char.definition_id, oppAura)
    maxReactionValue = Math.max(maxReactionValue, reactionPotential)
  }

  return maxReactionValue * 0.5
}

/**
 * 估算 bench 角色对目标元素附着的反应潜力。
 *
 * 简化实现：假设角色可以使用技能并造成元素伤害。
 * 完整实现应查 GAME_DATA 获取元素的 definition_id → element 映射。
 */
function estimateReactionPotential(
  _characterDefId: number,
  _targetAura: number,
): number {
  // 简化：假设大多数角色可以触发 2 伤害的反应
  // 完整实现应：查元素表 → 判断反应类型 → 估算伤害
  return 2.0
}

/**
 * L5: 计算骰子差值博弈价值。
 *
 * 一方消耗少骰子就 declareEnd 时，对方如果未结束则面临：
 * 1. 继续消耗骰子（浪费资源）
 * 2. 也 declareEnd（失去先手）
 *
 * 这种两难处境有价值。
 */
function computeResourceBluffValue(
  self: PlayerObservationV1,
  opp: PlayerObservationV1,
): number {
  // 对手已结束 → 无博弈
  if (opp.declared_end) return 0

  const myDice = self.dice.total_count
  const oppDice = opp.dice.total_count

  // 我还有少量骰子，对手有很多骰子 → 逼对手浪费
  if (myDice <= 2 && oppDice >= 5) return 1.0
  if (myDice <= 3 && oppDice >= 3) return 0.5

  // 双方骰子都很少 → declareEnd 是自然选择，无博弈
  if (myDice <= 2 && oppDice <= 2) return 0.1

  return 0
}

/**
 * L2: 计算斩杀风险。
 *
 * 如果 declareEnd 后对手下回合第一动可能斩杀我方活跃角色，
 * 则 declareEnd 有巨大风险。
 *
 * 使用 observation.derived 中的伤害容量和 KO 压力来估算。
 */
function computeLethalRisk(
  self: PlayerObservationV1,
  _opp: PlayerObservationV1,
  observation: ObservationV1,
): number {
  const selfActive = getActiveCharacter(self)
  if (!selfActive) return 0

  const hpRemaining = selfActive.health

  // 对手伤害容量 (从 derived features 获取)
  const oppDamage = observation.derived.opp_damage_capacity_now
  const oppKoPressure = observation.derived.opp_ko_pressure_now

  // 有元素附着 → 反应增伤因子 1.5
  const hasAura = selfActive.aura != null && selfActive.aura > 0
  const auraMultiplier = hasAura ? 1.5 : 1.0

  const threatDamage = (oppDamage + oppKoPressure) * auraMultiplier

  // 威胁伤害 ≥ 剩余HP → 可能被斩杀
  if (threatDamage >= hpRemaining) return -2.0

  // 威胁伤害 ≥ 70% HP → 重伤风险
  if (threatDamage >= hpRemaining * 0.7) return -0.8

  return 0
}

/**
 * L2: 计算抢先手奖励。
 *
 * 对手已 declareEnd 时，我还没结束 → 我可以通过快速行动获得额外价值。
 * 或者：我已经有召唤物在场，下回合我先动可以立即跟进输出。
 */
function computeInitiativeStealBonus(
  opp: PlayerObservationV1,
  self: PlayerObservationV1,
  _observation: ObservationV1,
): number {
  // 对手已结束 → 我肯定先手
  if (opp.declared_end) {
    // 如果我有快速行动角色 → 可以先手打出组合
    const hasFast = countFastSwitchCapableCharacters(self) > 0
    return hasFast ? 1.5 : 0.5
  }

  // 对手未结束，但我有召唤物 → 先手有优势
  const hasSummons = self.summons.length > 0
  return hasSummons ? 0.3 : 0
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function getActiveCharacter(
  player: PlayerObservationV1,
): CharacterObservationV1 | null {
  if (player.active_character_index == null) return null
  return player.characters[player.active_character_index] ?? null
}
