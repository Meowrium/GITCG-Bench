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

import type {
  CharacterObservationV1,
  PlayerObservationV1,
  ThresholdFeaturesV1,
} from "@gi-tcg/ml/contracts"

export type { ThresholdFeaturesV1 }

// ---------------------------------------------------------------------------
// P2: Threshold Features (§18.3 P2)
// ---------------------------------------------------------------------------
// "价值函数是平滑基线 + 若干阶跃叠加的混合体"
// 这些阈值跳变需要作为二值/多档位特征直接输入模型。
// 类型定义已迁至 @gi-tcg/ml/contracts；此文件仅保留 gi-agent 的计算实现。

// --- Known card/character definition IDs ---
const WOLFS_GRAVESTONE = 311303      // 狼的末路
const SHIMENAWAS_REMINISCENCE = 312014 // 追忆之注连
const YAE_MIKO = 1408                 // 八重神子
// const XINYAN = 1312                // 辛焱 (reserved for archetype configs)
// const DEHYA = 1309                 // 迪希雅

// ---------------------------------------------------------------------------
// Functional Tier Classification (§14.3)
// ---------------------------------------------------------------------------

export type FunctionalTier = "core" | "tactical" | "residual"

/**
 * 基于角色属性的功能层级判定。
 *
 * 简化规则（无 GamePlan 时的启发式）：
 * - core: 出战角色，或能量最高 + HP≥50% 的角色
 * - residual: HP < 30% OR max_energy == 0 的角色
 * - tactical: 其余
 *
 * 当 GamePlan 提供 preferred_active_character_id 时，
 * 该角色强制标记为 core。
 */
export function classifyFunctionalTier(
  character: CharacterObservationV1,
  player: PlayerObservationV1,
  preferredCoreDefId?: number,
): FunctionalTier {
  if (!character.alive) return "residual"

  // GamePlan 指定的核心角色
  if (preferredCoreDefId != null && character.definition_id === preferredCoreDefId) {
    return "core"
  }

  // 出战角色视为核心
  if (character.is_active) return "core"

  // 低血量或无能量上限的角色视为残余
  const hpRatio = character.health / Math.max(character.max_health, 1)
  if (hpRatio < 0.3 || character.max_energy === 0) return "residual"

  // 高能量角色（接近大招）视为核心
  if (character.max_energy > 0 && character.energy >= character.max_energy - 1) {
    return "core"
  }

  return "tactical"
}

// ---------------------------------------------------------------------------
// Compute All Threshold Features
// ---------------------------------------------------------------------------

export function computeThresholdFeatures(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
  preferredCoreDefId?: number,
  oppPreferredCoreDefId?: number,
): ThresholdFeaturesV1 {
  const selfActive = self.characters.find((ch) => ch.is_active && ch.alive)
  const oppActive = opponent.characters.find((ch) => ch.is_active && ch.alive)
  const selfAlive = self.characters.filter((ch) => ch.alive)
  const oppAlive = opponent.characters.filter((ch) => ch.alive)

  // Energy thresholds
  const selfAnyEnergyNearFull = selfAlive.some(
    (ch) => ch.max_energy > 0 && ch.energy >= ch.max_energy - 1,
  ) ? 1 : 0
  const oppAnyEnergyNearFull = oppAlive.some(
    (ch) => ch.max_energy > 0 && ch.energy >= ch.max_energy - 1,
  ) ? 1 : 0
  const selfAnyEnergyGe2 = selfAlive.some((ch) => ch.energy >= 2) ? 1 : 0
  const oppAnyEnergyGe2 = oppAlive.some((ch) => ch.energy >= 2) ? 1 : 0

  // HP thresholds
  const oppActiveHpLe6 = oppActive && oppActive.health <= 6 ? 1 : 0
  const selfActiveHpLe6 = selfActive && selfActive.health <= 6 ? 1 : 0

  // Kill range estimation (simplified: burst online + summon count * 2)
  const selfBurstCount = selfAlive.filter(
    (ch) => ch.max_energy > 0 && ch.energy >= ch.max_energy,
  ).length
  const selfEstDamage = Math.max(3, selfBurstCount * 4 + self.summons.length * 2)
  const oppBurstCount = oppAlive.filter(
    (ch) => ch.max_energy > 0 && ch.energy >= ch.max_energy,
  ).length
  const oppEstDamage = Math.max(3, oppBurstCount * 4 + opponent.summons.length * 2)

  const oppAnyInKillRange = oppAlive.some((ch) => ch.health <= selfEstDamage) ? 1 : 0
  const selfAnyInKillRange = selfAlive.some((ch) => ch.health <= oppEstDamage) ? 1 : 0

  // Equipment thresholds
  const selfHasWolfs = selfAlive.some((ch) =>
    ch.equipment_ids.includes(WOLFS_GRAVESTONE),
  ) ? 1 : 0
  const selfHasShimenawas = selfAlive.some((ch) =>
    ch.equipment_ids.includes(SHIMENAWAS_REMINISCENCE),
  ) ? 1 : 0

  const selfShimenawasActive =
    selfHasShimenawas && selfAnyEnergyGe2 ? 1 : 0
  const selfWolfsActive =
    selfHasWolfs && oppActiveHpLe6 ? 1 : 0

  // Summon usages
  const selfSummonUsages = summonTotalUsages(self)
  const oppSummonUsages = summonTotalUsages(opponent)

  const selfHasYaeMiko = selfAlive.some(
    (ch) => ch.definition_id === YAE_MIKO,
  ) ? 1 : 0
  const selfYaeMikoExtra =
    selfHasYaeMiko && selfSummonUsages > 3 ? 1 : 0

  // Functional tier counts
  const selfTiers = countTiers(self, preferredCoreDefId)
  const oppTiers = countTiers(opponent, oppPreferredCoreDefId)

  // Dice alignment
  const selfDiceAlignment = computeDiceAlignment(self)
  const oppDiceAlignment = computeDiceAlignment(opponent)

  return {
    self_any_energy_near_full: selfAnyEnergyNearFull,
    opp_any_energy_near_full: oppAnyEnergyNearFull,
    self_any_energy_ge_2: selfAnyEnergyGe2,
    opp_any_energy_ge_2: oppAnyEnergyGe2,
    opp_active_hp_le_6: oppActiveHpLe6,
    self_active_hp_le_6: selfActiveHpLe6,
    opp_any_in_kill_range: oppAnyInKillRange,
    self_any_in_kill_range: selfAnyInKillRange,
    self_has_wolfs_gravestone: selfHasWolfs,
    self_has_shimenawas: selfHasShimenawas,
    self_shimenawas_active: selfShimenawasActive,
    self_wolfs_gravestone_active: selfWolfsActive,
    self_summon_total_usages: selfSummonUsages,
    opp_summon_total_usages: oppSummonUsages,
    self_has_yae_miko: selfHasYaeMiko,
    self_yae_miko_extra_trigger: selfYaeMikoExtra,
    self_core_alive_count: selfTiers.core,
    self_tactical_alive_count: selfTiers.tactical,
    self_residual_alive_count: selfTiers.residual,
    opp_core_alive_count: oppTiers.core,
    opp_tactical_alive_count: oppTiers.tactical,
    opp_residual_alive_count: oppTiers.residual,
    self_dice_alignment: selfDiceAlignment,
    opp_dice_alignment: oppDiceAlignment,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summonTotalUsages(player: PlayerObservationV1): number {
  return player.summons.reduce((sum, s) => {
    const usage = s.variable_value ?? 0
    return sum + Math.max(0, usage)
  }, 0)
}

function countTiers(
  player: PlayerObservationV1,
  preferredCoreDefId?: number,
): { core: number; tactical: number; residual: number } {
  const result = { core: 0, tactical: 0, residual: 0 }
  for (const ch of player.characters) {
    const tier = classifyFunctionalTier(ch, player, preferredCoreDefId)
    result[tier]++
  }
  return result
}

/**
 * 骰子对齐度：与出战角色元素匹配的骰子 + 万能骰
 * 占总骰子的比例。
 *
 * 注意：此处简化处理，使用 dice.counts_by_type。
 * 出战角色的元素标签 (character.tags) 需要映射到骰子类型。
 */
function computeDiceAlignment(player: PlayerObservationV1): number {
  if (player.dice.total_count === 0) return 0

  // 万能骰在任何情况下都是对齐的
  const aligned = player.dice.omni_count

  // 出战角色的元素类型（从 tags 或 aura 推断较复杂，
  // 这里使用 counts_by_type 中最大的非 omni/unspecified 类型作为近似）
  const activeChar = player.characters.find((ch) => ch.is_active && ch.alive)
  if (!activeChar) {
    return aligned / Math.max(1, player.dice.total_count)
  }

  // 使用角色的元素标签映射到骰子类型
  // tags 编码：粗略地按 definition_id 前两位判断元素系列
  // 1-cryo, 2-hydro, 3-pyro, 4-electro, 5-anemo, 6-geo, 7-dendro
  const elementPrefix = Math.floor(activeChar.definition_id / 100) % 10
  const ELEMENT_TO_DICE_KEY: Record<number, string> = {
    1: "1", // cryo
    2: "2", // hydro
    3: "3", // pyro
    4: "4", // electro
    5: "5", // anemo
    6: "6", // geo
    7: "7", // dendro
  }
  const diceKey = ELEMENT_TO_DICE_KEY[elementPrefix]
  const matchingDice = diceKey
    ? Number(player.dice.counts_by_type[diceKey] ?? 0)
    : 0

  return (aligned + matchingDice) / Math.max(1, player.dice.total_count)
}
