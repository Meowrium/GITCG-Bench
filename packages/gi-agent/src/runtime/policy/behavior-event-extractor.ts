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
// P3: 从 Notification mutations 中提取对手行为事件
// ---------------------------------------------------------------------------

import type { Notification } from "@gi-tcg/typings"
import type { OpponentBehaviorEvent } from "./opponent-model.js"

type ExposedMutation = NonNullable<Notification["mutation"]>[number]

/**
 * 从一批 mutation 中提取对手行为事件。
 *
 * @param mutations  本次 notification 携带的 mutation 列表
 * @param opponentWho  对手的 who 值（0 或 1）
 */
export function extractOpponentBehaviorEvents(
  mutations: readonly ExposedMutation[],
  opponentWho: 0 | 1,
): OpponentBehaviorEvent[] {
  const events: OpponentBehaviorEvent[] = []
  let fastActionCount = 0

  for (const m of mutations) {
    const mut = m.mutation
    if (!mut) continue

    switch (mut.$case) {
      // 对手使用了技能
      case "skillUsed": {
        // skillUsed 本身不含 who，但可以根据上下文（接下来的 damage）推断
        // 暂时记录技能使用事件，后续通过 damage 补充
        break
      }

      // 伤害事件 — 如果来源属于对手，且伤害高则标记
      case "damage": {
        const dmg = mut.value
        if (dmg.healKind) {
          // 治疗事件
          events.push("healing_action")
        } else if (dmg.value >= 4 && dmg.isSkillMainDamage) {
          // 高伤技能（≥4伤害的主技能伤害）
          events.push("high_damage_skill")
        }
        break
      }

      // 切人事件 — 区分攻击性切人和防御性切人
      case "switchActive": {
        const sw = mut.value
        if (sw.who === opponentWho) {
          // from_action: 0=NONE, 1=SLOW, 2=FAST
          if (sw.fromAction === 2) {
            // 快速切人 → 通常是连招中的快速切人
            events.push("swap_aggressive")
          } else if (sw.fromAction === 1) {
            // 慢速切人 → 通常是防御性切人（挡伤/换位）
            events.push("swap_defensive")
          }
        }
        break
      }

      // 创建实体 — 支援/召唤
      case "createEntity": {
        const ce = mut.value
        if (ce.who === opponentWho) {
          // where: 3=SUMMON, 4=SUPPORT
          if (ce.where === 4) {
            events.push("support_deploy")
          }
        }
        break
      }

      // 移除实体 — 调和
      case "removeEntity": {
        const re = mut.value
        if (re.who === opponentWho && re.reason === 2) {
          // reason 2 = ELEMENTAL_TUNING
          events.push("elemental_tuning")
        }
        break
      }

      // 充能变化 — 能量增加
      case "modifyEntityVar": {
        const mv = mut.value
        if (
          mv.variableName === "energy" &&
          mv.direction === 1 // INCREASE
        ) {
          events.push("energy_charge")
        }
        break
      }

      // 阶段变化 — 对手提前结束
      case "playerStatusChange": {
        // 如果对手状态变为非 ACTING，可能是宣布结束
        break
      }

      // 设置玩家标志 — declared_end
      case "setPlayerFlag": {
        const sf = mut.value
        if (sf.who === opponentWho && sf.flagName === 1 && sf.flagValue) {
          // flagName 1 = PLAYER_FLAG_DECLARED_END
          events.push("declare_end_early")
        }
        break
      }
    }

    // 检测连续快速行动（combo_sequence）
    if (mut.$case === "skillUsed") {
      fastActionCount++
      if (fastActionCount >= 3) {
        events.push("combo_sequence")
        fastActionCount = 0 // 重置计数
      }
    } else if (mut.$case === "switchTurn") {
      fastActionCount = 0 // 回合切换重置
    }
  }

  return events
}

/**
 * 从对手角色列表中提取元素类型。
 */
export function extractOpponentCharacterElements(
  opponentPlayer: {
    character: Array<{
      definition_id: number
      aura?: number
    }>
  },
  characterElementMap: Map<number, string>,
): string[] {
  return opponentPlayer.character
    .map((ch) => characterElementMap.get(ch.definition_id) ?? "unknown")
    .filter((elem) => elem !== "unknown")
}
