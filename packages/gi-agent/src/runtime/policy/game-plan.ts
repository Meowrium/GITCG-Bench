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

import type { ObservationV1 } from "@gi-tcg/ml/contracts"

// ---------------------------------------------------------------------------
// GamePlan — Archetype-level strategy template (P0: §18.3)
// ---------------------------------------------------------------------------

/**
 * 胜利路径类型：描述卡组如何赢得对局。
 */
export type VictoryPathKind =
  | "early_burst"       // T2-T3 爆发击穿
  | "midrange_tempo"    // 中期节奏压制
  | "resource_grind"    // 资源消耗 + 伺机点杀
  | "combo_otk"         // 组合技一波带走
  | "flexible"          // 根据对手阵营动态选择

/**
 * 阶段类型：不是回合数，而是组件就位状态驱动。
 */
export type GamePhaseKind =
  | "setup"             // 展开期：铺装备/支援/召唤
  | "transition"        // 过渡期：组件基本就位，准备进入执行
  | "execution"         // 执行期：输出伤害 / 执行核心策略
  | "closing"           // 收尾期：对手残血，追求斩杀

/**
 * 关键组件：展开前提条件中的单个组件。
 */
export interface KeyComponent {
  /** 组件描述名称（用于调试） */
  name: string
  /** 对应的 card/entity definition_id 列表（满足任一即可） */
  definition_ids: number[]
  /** 组件类型 */
  kind: "equipment" | "support" | "summon" | "status" | "energy_full" | "hand_card"
  /** 优先级权重（归一化用） */
  weight: number
}

/**
 * 条件路径分支（P3 预留，P0 先支持静态选择）。
 */
export interface ConditionalPathBranch {
  /** 触发条件描述 */
  condition: string
  /** 对手角色 definition_id 匹配（看到对方阵营即触发） */
  opponent_character_ids?: number[]
  /** 对手 archetype 关键字匹配 */
  opponent_archetype_hint?: string
  /** 该分支的胜利路径覆盖 */
  victory_path_override?: VictoryPathKind
  /** 该分支的首发角色偏好覆盖（definition_id） */
  preferred_active_override?: number
  /** 展开期偏好标签覆盖 */
  setup_prefer_tags_override?: string[]
}

/**
 * GamePlan 结构：每套卡组的 archetype 级别策略模板。
 */
export interface GamePlan {
  /** 卡组标识（archetype 名称） */
  archetype_id: string
  /** 胜利路径描述 */
  victory_path: VictoryPathKind
  /** 关键组件清单 */
  key_components: KeyComponent[]
  /** 理想首发角色 definition_id */
  preferred_active_character_id?: number
  /** 展开期偏好标签 */
  setup_prefer_tags: string[]
  /** 执行期偏好标签 */
  execution_prefer_tags: string[]
  /** 条件路径分支 */
  conditional_branches: ConditionalPathBranch[]
}

// ---------------------------------------------------------------------------
// GamePlan Runtime State — 运行时追踪
// ---------------------------------------------------------------------------

export interface GamePlanRuntimeState {
  /** 当前绑定的 GamePlan */
  plan: GamePlan
  /** 当前阶段 */
  current_phase: GamePhaseKind
  /** 展开完成度（0~1） */
  setup_completion: number
  /** 主胜利路径是否仍可行 */
  primary_path_viable: boolean
  /** 当前激活的条件分支（null = 使用默认路径）*/
  active_branch: ConditionalPathBranch | null
  /** 有效胜利路径（考虑条件分支覆盖后） */
  effective_victory_path: VictoryPathKind
}

// ---------------------------------------------------------------------------
// GamePlan 展开完成度计算
// ---------------------------------------------------------------------------

/**
 * 计算关键组件就位百分比。
 * 检查场上已存在的 entity definition_id 和角色能量状态。
 */
export function computeSetupCompletion(
  plan: GamePlan,
  observation: ObservationV1,
): number {
  if (plan.key_components.length === 0) return 1

  let totalWeight = 0
  let completedWeight = 0

  for (const component of plan.key_components) {
    totalWeight += component.weight
    if (isComponentPresent(component, observation)) {
      completedWeight += component.weight
    }
  }

  return totalWeight > 0 ? completedWeight / totalWeight : 1
}

function isComponentPresent(
  component: KeyComponent,
  obs: ObservationV1,
): boolean {
  switch (component.kind) {
    case "equipment":
      return obs.self.characters.some((ch) =>
        ch.alive && ch.equipment_ids.some((eid) => component.definition_ids.includes(eid)),
      )
    case "support":
      return obs.self.supports.some((s) =>
        component.definition_ids.includes(s.definition_id),
      )
    case "summon":
      return obs.self.summons.some((s) =>
        component.definition_ids.includes(s.definition_id),
      )
    case "status":
      return obs.self.characters.some((ch) =>
        ch.alive && ch.status_ids.some((sid) => component.definition_ids.includes(sid)),
      ) || obs.self.combat_statuses.some((cs) =>
        component.definition_ids.includes(cs.definition_id),
      )
    case "energy_full":
      return obs.self.characters.some((ch) =>
        ch.alive &&
        component.definition_ids.includes(ch.definition_id) &&
        ch.max_energy > 0 &&
        ch.energy >= ch.max_energy,
      )
    case "hand_card":
      return obs.self.hand.visible_cards.some((card) =>
        card.definition_id != null && component.definition_ids.includes(card.definition_id),
      )
  }
}

// ---------------------------------------------------------------------------
// 阶段检测：基于组件就位状态（deck-specific）
// ---------------------------------------------------------------------------

export function detectGamePhase(
  plan: GamePlan,
  observation: ObservationV1,
  setupCompletion: number,
): GamePhaseKind {
  // 收尾期：对手存活角色全部低血
  const oppAlive = observation.opponent.characters.filter((ch) => ch.alive)
  const oppAllLow = oppAlive.length > 0 && oppAlive.every((ch) =>
    ch.health <= ch.max_health * 0.35,
  )
  if (oppAllLow) return "closing"

  // HC-10: 动态阈值 — 对手威胁越高或自身血线越低，越早进入 execution
  const oppThreat =
    observation.derived.opp_damage_capacity_now +
    observation.derived.opp_ko_pressure_now * 2
  const selfAvgHpRatio = avgAliveHpRatio(observation.self)
  const urgencyShift = Math.min(0.2, oppThreat * 0.02 + (1 - selfAvgHpRatio) * 0.15)

  const executionThreshold = Math.max(0.4, 0.8 - urgencyShift)
  const transitionThreshold = Math.max(0.2, 0.5 - urgencyShift)

  if (setupCompletion >= executionThreshold) return "execution"
  if (setupCompletion >= transitionThreshold) return "transition"

  // Enhanced phase triggers: first KO forces early execution
  const firstKo = observation.opponent.characters.some((ch) => !ch.alive) ||
    observation.self.characters.some((ch) => !ch.alive)

  // If a key character has been KO'd → force execution even if setup incomplete
  if (firstKo && setupCompletion < 0.5) {
    return "execution"
  }

  // Burst online trigger: if a character has full energy and setup is partially complete
  const selfBurstOnline = observation.self.characters.some(
    (ch) => ch.alive && ch.energy >= ch.max_energy && ch.max_energy > 0,
  )
  if (selfBurstOnline && setupCompletion >= 0.3) {
    return "execution"
  }

  return "setup"
}

// ---------------------------------------------------------------------------
// V31 F2: 连续进度量（取代离散 game_phase_estimate / P5 反过早分类）
// 这两个量只依赖公开状态，不需要 GamePlan，因此始终可计算。
// ---------------------------------------------------------------------------

/**
 * 执行就位度 ∈ [0,1]：当前我方"能打出关键输出"的连续就位程度。
 * 综合：能量就绪比（接近爆发）+ 我方场上压力资源（召唤物 / 战斗状态）。
 * 取代旧 game_phase_estimate 的 "execution" 离散判定，让 V 自己处理混合局面。
 */
export function computeExecutionReadiness(observation: ObservationV1): number {
  const alive = observation.self.characters.filter((ch) => ch.alive)
  if (alive.length === 0) return 0

  // 能量就绪：每个角色 energy/maxEnergy 的均值（maxEnergy=0 视作已就绪）。
  const energyReady =
    alive.reduce((acc, ch) => {
      if (ch.max_energy <= 0) return acc + 1
      return acc + Math.min(1, ch.energy / ch.max_energy)
    }, 0) / alive.length

  // 场面压力：召唤物 + 战斗状态数量（每件 0.25，封顶 1）。
  const boardPressure = Math.min(
    1,
    (observation.self.summons.length + observation.self.combat_statuses.length) * 0.25,
  )

  // 执行就位 = 0.7·能量就绪 + 0.3·场面压力。
  return clamp01(0.7 * energyReady + 0.3 * boardPressure)
}

/**
 * 收尾压力 ∈ [0,1]：当前局面"逼近终结"的连续程度。
 * max(对方最低血占斩杀线比, 回合进度)。取代旧 game_phase_estimate 的 "closing" 判定。
 */
export function computeClosingPressure(
  observation: ObservationV1,
  maxRounds = 15,
): number {
  const oppAlive = observation.opponent.characters.filter((ch) => ch.alive)
  // 斩杀接近度：对方最低血量越低 → 越接近收尾。用 1 - (minHpRatio) 表示。
  let killProximity = 0
  if (oppAlive.length > 0) {
    const minHpRatio = Math.min(
      ...oppAlive.map((ch) => ch.health / Math.max(1, ch.max_health)),
    )
    killProximity = 1 - minHpRatio
  }
  // 回合压力：越接近最大回合 → 越需要收尾。
  const roundPressure = clamp01(
    (observation.point.round_number ?? 0) / Math.max(1, maxRounds),
  )
  return clamp01(Math.max(killProximity, roundPressure))
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

export function matchConditionalBranch(
  plan: GamePlan,
  observation: ObservationV1,
): ConditionalPathBranch | null {
  for (const branch of plan.conditional_branches) {
    if (branch.opponent_character_ids && branch.opponent_character_ids.length > 0) {
      const oppDefIds = observation.opponent.characters.map((ch) => ch.definition_id)
      const hasMatch = branch.opponent_character_ids.some((id) => oppDefIds.includes(id))
      if (hasMatch) return branch
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 构建运行时状态
// ---------------------------------------------------------------------------

export function buildGamePlanRuntimeState(
  plan: GamePlan,
  observation: ObservationV1,
): GamePlanRuntimeState {
  const setupCompletion = computeSetupCompletion(plan, observation)
  const currentPhase = detectGamePhase(plan, observation, setupCompletion)
  const activeBranch = matchConditionalBranch(plan, observation)
  const effectiveVictoryPath =
    activeBranch?.victory_path_override ?? plan.victory_path
  const primaryPathViable = assessPrimaryPathViable(plan, observation, setupCompletion)

  return {
    plan,
    current_phase: currentPhase,
    setup_completion: setupCompletion,
    primary_path_viable: primaryPathViable,
    active_branch: activeBranch,
    effective_victory_path: effectiveVictoryPath,
  }
}

function avgAliveHpRatio(player: ObservationV1["self"]): number {
  const alive = player.characters.filter((ch) => ch.alive)
  if (alive.length === 0) return 0
  const sum = alive.reduce(
    (acc, ch) => acc + ch.health / Math.max(1, ch.max_health),
    0,
  )
  return sum / alive.length
}

function assessPrimaryPathViable(
  plan: GamePlan,
  observation: ObservationV1,
  setupCompletion: number,
): boolean {
  // 如果关键角色已死亡，主路径可能不可行
  if (plan.preferred_active_character_id) {
    const preferred = observation.self.characters.find(
      (ch) => ch.definition_id === plan.preferred_active_character_id,
    )
    if (preferred && !preferred.alive) return false
  }

  // 如果展开完成度太低且已经在中后期回合，路径可能不可行
  if (observation.point.round_number >= 4 && setupCompletion < 0.3) return false

  return true
}

// ---------------------------------------------------------------------------
// GamePlan → 当前阶段推荐标签
// ---------------------------------------------------------------------------

export function getPhasePreferTags(
  state: GamePlanRuntimeState,
): string[] {
  const branch = state.active_branch
  switch (state.current_phase) {
    case "setup":
      return branch?.setup_prefer_tags_override ?? state.plan.setup_prefer_tags
    case "transition":
      return [
        ...state.plan.setup_prefer_tags.slice(0, 2),
        ...state.plan.execution_prefer_tags.slice(0, 2),
      ]
    case "execution":
      return state.plan.execution_prefer_tags
    case "closing":
      return ["direct_damage", "burst_enable", "skill_type:burst", "ko_finish"]
  }
}

// ---------------------------------------------------------------------------
// GamePlan 与 MacroPlan 桥接
// ---------------------------------------------------------------------------

export function gamePlanToMacroPlanKind(
  state: GamePlanRuntimeState,
): import("./types.js").RuntimeMacroPlanKind {
  switch (state.current_phase) {
    case "setup":
      return "board_setup"
    case "transition":
      return state.effective_victory_path === "early_burst" ? "burst_convert" : "tempo_pressure"
    case "execution":
      switch (state.effective_victory_path) {
        case "early_burst":
        case "combo_otk":
          return "burst_convert"
        case "resource_grind":
          return "stabilize"
        default:
          return "tempo_pressure"
      }
    case "closing":
      return "tempo_pressure"
  }
}
