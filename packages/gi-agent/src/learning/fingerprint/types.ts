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
 * V30 Stage 1 — Entity Fingerprint types.
 *
 * Single source of truth for the structured semantic fingerprint extracted
 * from `@gi-tcg/data` via `Registry.resolve()` + sentinel previews.
 *
 * Design:
 *   - Static fields (cost, tags, kind, references) come from GameData directly.
 *   - Dynamic fields (damage amount, dice gen, draws, heal) are filled by
 *     running `ActionPreviewer.modifyAndPreview` on a sentinel state and
 *     summarising the resulting `PreviewData[]`.
 *   - Schema version is embedded in the artifact so older artifacts can be
 *     rejected at load time.
 */

import type { DamageType, DiceType, Reaction } from "@gi-tcg/typings"

/** Schema version — bump on breaking changes to EntityFingerprint shape. */
export const FINGERPRINT_SCHEMA_VERSION = 1

export type FingerprintKind =
  | "card_event"
  | "card_support"
  | "card_equipment"
  | "card_talent"
  | "card_food"
  | "card_legend"
  | "card_other"
  | "character"
  | "skill_normal"
  | "skill_elemental"
  | "skill_burst"
  | "skill_technique"
  | "skill_passive"
  | "skill_play_card"
  | "summon"
  | "support"
  | "status"
  | "combat_status"

/** Source confidence for each fingerprint field. */
export type FingerprintSource =
  | "static_definition" // 从 GameData 直接读取
  | "sentinel_preview"  // 从 ActionPreviewer mutation 反推
  | "fallback_zero"     // 既无静态字段也跑不出 preview，全零兜底

/** Cost vector. Aligned/Energy/Void encoded explicitly; specific colours map by DamageType. */
export interface FingerprintCost {
  /** 总骰子数（含 aligned + specific + void，不含 energy） */
  total_dice: number
  /** 同色骰费用 */
  aligned: number
  /** 充能费用 */
  energy: number
  /** 万能骰（旅行者卡牌等） */
  void: number
  /** 各元素骰具体费用，仅枚举非零 */
  specific: Partial<Record<number, number>>
  /** 是否快速行动 */
  is_fast: boolean
}

export interface FingerprintDamage {
  /** 静态展开后的 base damage（不含动态 if 分支） */
  amount: number
  /** 主伤害类型；多段伤害取首段 */
  type: number | null // DamageType numeric; null = no damage
  /** 是否对所有敌方角色造成伤害 */
  hits_all_opp: boolean
  /** 是否包含穿透伤害 */
  has_piercing: boolean
  /** 触发的反应（若 sentinel preview 检测到） */
  triggers_reaction: number | null // Reaction numeric
  /** 多段攻击次数 */
  hit_count: number
}

export interface FingerprintHeal {
  amount: number
  /** 是全队 / 单角色 / 出战角色 */
  scope: "active" | "team" | "specific" | null
  hit_count: number
}

export interface FingerprintDiceGen {
  /** 各类型生成的骰子数；DiceType 数值 → count */
  by_type: Partial<Record<number, number>>
  total_count: number
}

export interface FingerprintEntityCreation {
  summons: number[] // definition ids
  supports: number[]
  combat_statuses: number[]
  character_statuses: number[]
}

export interface FingerprintEnergy {
  /** 给自己出战角色的能量增量（普攻/E 通常 +1） */
  self_active: number
  /** 给自己其他角色的能量 */
  self_other: number
  /** 给自己出战角色清空（爆发） */
  self_active_zeroed: boolean
}

export interface EntityFingerprint {
  schema_version: typeof FINGERPRINT_SCHEMA_VERSION

  /** 引擎中的 definition id（cards / skills / summons / supports / statuses 全部独立 ID 空间） */
  definition_id: number
  kind: FingerprintKind
  /** Engine version this fingerprint was extracted under. */
  game_version: string
  /** 字段总体置信度 */
  source: FingerprintSource

  /** 仅静态字段：tags 直接来自 EntityDefinition.tags / CharacterDefinition.tags */
  raw_tags: string[]

  /** 角色 / 技能 / 实体相关元数据（视 kind 而定） */
  meta: {
    /** 仅 character: 元素 tag */
    element?: string
    /** 仅 character: 武器 tag */
    weapon?: string
    /** 仅 skill: 所属角色 id */
    parent_character_id?: number
    /** 仅 skill: 是否为天赋触发 */
    is_talent_trigger?: boolean
    /** 仅 character: maxHealth 初始值 */
    max_health?: number
    /** 仅 character: maxEnergy 初始值 */
    max_energy?: number
    /** 仅 entity: visibleVarName */
    visible_var?: string | null
    /** 仅 entity: variable initial values 摘要 */
    var_initials?: Record<string, number>
  }

  cost: FingerprintCost
  damage: FingerprintDamage
  heal: FingerprintHeal
  dice_gen: FingerprintDiceGen
  energy: FingerprintEnergy

  /** 立即创建的实体（一次施放后） */
  creates: FingerprintEntityCreation

  /** 抽牌张数（含 sentinel 期间触发的抽牌） */
  draws_cards: number
  /** 操控对手手牌（弃牌、洗回） */
  opponent_hand_disturb: number
  /** 切换出战角色 */
  switches_active: boolean
  /** 强制对手切换 */
  forces_opp_switch: boolean

  /** 静态分析阶段已知的关联 definition id（用于 deck synergy） */
  references: number[]

  /** 源代码 hash，用于增量重建 */
  source_hash: string

  /** sentinel 跑失败时填错误说明，便于审计 */
  notes?: string[]
}

/** 完整 artifact 顶层结构 */
export interface FingerprintArtifact {
  schema_version: typeof FINGERPRINT_SCHEMA_VERSION
  game_version: string
  generated_at: string
  /** 各 kind 的 entry 计数，便于 sanity check */
  counts: Record<FingerprintKind, number>
  entries: EntityFingerprint[]
}
