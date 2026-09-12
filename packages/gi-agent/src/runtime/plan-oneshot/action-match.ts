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
 * ActionSpecV1 → RpcAction（proto Action）匹配。
 *
 * 硬过滤：action_case / skill_type / skill_def_id / target / damage_min / kills /
 * card_tag / card_def_id / require_tag；软偏好：prefer_reaction（只影响同规则多候选的
 * tie-break，不过滤）。伤害与斩杀信息来自候选自带的 preview。
 */

import type { GameData } from "@gi-tcg/core"
import type { RpcRequest } from "@gi-tcg/typings"
import type { ActionSpecV1 } from "./game-plan-v1.js"

export type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number]

export interface ActionMatchContext {
  gameData: GameData
  /** 对手全部角色的实体 id 集合（preview target 归属判定用） */
  opponentCharacterIds: ReadonlySet<number>
  /** 对手当前出战角色实体 id */
  opponentActiveId: number | undefined
  /** 全场（双方）实体 id → 角色 definition id 映射（数字 target 按 defId 匹配用） */
  defIdByEntityId: ReadonlyMap<number, number>
}

// ── 技能类型解析（skillDefinitionId → normal_attack/elemental_skill/burst）──

const SKILL_TYPE_NAME: Record<string, "normal_attack" | "elemental_skill" | "burst" | undefined> = {
  normal: "normal_attack",
  elemental: "elemental_skill",
  burst: "burst",
  technique: undefined,
}

export function buildSkillTypeIndex(gameData: GameData): Map<number, "normal_attack" | "elemental_skill" | "burst"> {
  const index = new Map<number, "normal_attack" | "elemental_skill" | "burst">()
  for (const character of gameData.characters.values()) {
    for (const skill of character.skills) {
      const name = skill.skillType ? SKILL_TYPE_NAME[skill.skillType] : undefined
      if (name) index.set(skill.id, name)
    }
  }
  return index
}

// ── preview 摘要 ───────────────────────────────────────────────────────

interface DamagePreview {
  value: number
  targetId: number
  causeDefeated: boolean
  reactionType: number
}

function damagePreviewsOf(action: RpcAction): DamagePreview[] {
  const out: DamagePreview[] = []
  for (const p of action.preview) {
    if (p.mutation?.$case === "damage") {
      const d = p.mutation.value
      out.push({
        value: d.value,
        targetId: d.targetId,
        causeDefeated: d.causeDefeated,
        reactionType: d.reactionType as number,
      })
    }
  }
  return damagesFilterZero(out)
}

function damagesFilterZero(list: DamagePreview[]): DamagePreview[] {
  return list.filter((d) => d.value > 0 || d.causeDefeated)
}

/** 对对手角色的 preview 总伤害 */
export function previewDamageVsOpponent(action: RpcAction, ctx: ActionMatchContext): number {
  return damagePreviewsOf(action)
    .filter((d) => ctx.opponentCharacterIds.has(d.targetId))
    .reduce((s, d) => s + d.value, 0)
}

/** preview 是否斩杀对手角色 */
export function previewKillsOpponent(action: RpcAction, ctx: ActionMatchContext): boolean {
  return damagePreviewsOf(action)
    .some((d) => d.causeDefeated && ctx.opponentCharacterIds.has(d.targetId))
}

/** preview 中出现的反应名集合（小写，如 "melt"/"swirl_pyro"） */
const REACTION_NAMES: Record<number, string> = {
  101: "melt", 102: "vaporize", 103: "overloaded", 104: "superconduct",
  105: "electro_charged", 106: "frozen",
  107: "swirl_cryo", 108: "swirl_hydro", 109: "swirl_pyro", 110: "swirl_electro",
  111: "crystallize_cryo", 112: "crystallize_hydro", 113: "crystallize_pyro",
  114: "crystallize_electro",
  115: "burning", 116: "bloom", 117: "quicken",
  3001: "lunar_electro_charged", 3002: "lunar_bloom",
}

export function previewReactionNames(action: RpcAction): Set<string> {
  const names = new Set<string>()
  for (const d of damagePreviewsOf(action)) {
    const name = REACTION_NAMES[d.reactionType]
    if (name) names.add(name)
  }
  return names
}

// ── spec 匹配 ──────────────────────────────────────────────────────────

function matchTarget(
  specTarget: string | number,
  targetIds: readonly number[],
  mainTargetId: number | undefined,
  ctx: ActionMatchContext,
): boolean {
  if (specTarget === "opponent.active") {
    const ids = mainTargetId !== undefined ? [mainTargetId, ...targetIds] : targetIds
    return ctx.opponentActiveId !== undefined && ids.includes(ctx.opponentActiveId)
  }
  if (specTarget === "opponent.benched") {
    const ids = mainTargetId !== undefined ? [mainTargetId, ...targetIds] : targetIds
    return ids.some((id) => ctx.opponentCharacterIds.has(id) && id !== ctx.opponentActiveId)
  }
  if (typeof specTarget !== "number") return false
  // 数字 target = 角色 definition id（LLM 赛前可知的稳定标识）。
  // 实体 id 是运行时产生的，这里经 defIdByEntityId 映射后比较，
  // 保证"写 defId 的规则"能命中真实候选。
  const ids = mainTargetId !== undefined ? [mainTargetId, ...targetIds] : targetIds
  return ids.some((id) => ctx.defIdByEntityId.get(id) === specTarget)
}

/**
 * 判断候选动作是否满足 ActionSpec 的全部硬过滤条件。
 * prefer_reaction 不参与过滤（见文件头注释）。
 */
export function candidateMatchesSpec(
  spec: ActionSpecV1,
  action: RpcAction,
  ctx: ActionMatchContext,
  skillTypeIndex: ReadonlyMap<number, "normal_attack" | "elemental_skill" | "burst">,
): boolean {
  const inner = action.action
  if (!inner || inner.$case !== spec.action_case) return false

  if (spec.skill_type !== undefined) {
    if (inner.$case !== "useSkill") return false
    if (skillTypeIndex.get(inner.value.skillDefinitionId) !== spec.skill_type) return false
  }

  if (spec.skill_def_id !== undefined) {
    if (inner.$case !== "useSkill" || inner.value.skillDefinitionId !== spec.skill_def_id) return false
  }

  if (spec.target !== undefined) {
    if (inner.$case === "useSkill") {
      if (!matchTarget(spec.target, inner.value.targetIds, inner.value.mainDamageTargetId, ctx)) return false
    } else if (inner.$case === "playCard") {
      if (!matchTarget(spec.target, inner.value.targetIds, undefined, ctx)) return false
    } else if (inner.$case === "switchActive") {
      // spec.target 为 defId；switchActive 候选自带 characterDefinitionId，直接比较
      if (typeof spec.target !== "number" || inner.value.characterDefinitionId !== spec.target) return false
    } else {
      return false
    }
  }

  if (spec.damage_min !== undefined) {
    if (previewDamageVsOpponent(action, ctx) < spec.damage_min) return false
  }

  if (spec.kills === true) {
    if (!previewKillsOpponent(action, ctx)) return false
  }

  if (spec.card_def_id !== undefined) {
    if (inner.$case !== "playCard" || inner.value.cardDefinitionId !== spec.card_def_id) return false
  }

  if (spec.card_tag !== undefined || spec.require_tag !== undefined) {
    if (inner.$case !== "playCard") return false
    const tags = (ctx.gameData.entities.get(inner.value.cardDefinitionId)?.tags ?? [])
      .map((t) => String(t).toLowerCase())
    if (spec.card_tag !== undefined && !tags.includes(spec.card_tag.toLowerCase())) return false
    if (spec.require_tag !== undefined && !tags.includes(spec.require_tag.toLowerCase())) return false
  }

  return true
}

/** 同规则多候选的确定性 tie-break 分数：preview 伤害优先，其次偏好反应 */
export function candidateTieBreakScore(
  spec: ActionSpecV1,
  action: RpcAction,
  ctx: ActionMatchContext,
): number {
  let score = previewDamageVsOpponent(action, ctx)
  if (spec.prefer_reaction && spec.prefer_reaction.length > 0) {
    const reactions = previewReactionNames(action)
    if (spec.prefer_reaction.some((r) => reactions.has(r.toLowerCase()))) {
      score += 0.5
    }
  }
  return score
}

/** trace 用的动作摘要 */
export function summarizeAction(action: RpcAction, ctx: ActionMatchContext): {
  actionCase: string
  skillDefId?: number
  cardDefId?: number
  targetDefId?: number
  previewDamage?: number
} {
  const inner = action.action
  const damage = previewDamageVsOpponent(action, ctx)
  const base = { actionCase: inner?.$case ?? "unknown", ...(damage > 0 ? { previewDamage: damage } : {}) }
  switch (inner?.$case) {
    case "useSkill": {
      const targetId = inner.value.mainDamageTargetId ?? inner.value.targetIds[0]
      return {
        ...base,
        skillDefId: inner.value.skillDefinitionId,
        ...(targetId !== undefined ? { targetDefId: targetId } : {}),
      }
    }
    case "playCard":
      return { ...base, cardDefId: inner.value.cardDefinitionId }
    case "switchActive":
      return { ...base, targetDefId: inner.value.characterDefinitionId }
    default:
      return base
  }
}
