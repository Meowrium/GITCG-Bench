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
 * opp.threat.* 字段：对手回合威胁的玩家视角派生估计。
 *
 * 语义纪律（写进 field-reference 的同一口径）：
 * - 这是**上界/概率估计**，不是 preview 级精确：对手手牌内容（增伤牌/共鸣/速切）
 *   不可见，永远估计不到；骰面隐藏，支付能力按"骰面全部可用"上界
 *   （maxDamage/burstReady/lethal）或骰子分布先验概率（burstP/lethalP，dice-prior.ts）。
 * - 伤害数值来自 @gi-tcg/data 源码的静态解析（character-profiles/source-parser），
 *   成本来自 GameData。钉旧版本开局的对局可能与新版本源码数值有出入——
 *   上界性质不变，但绝对值以引擎 preview 为准。
 * - additionalDamage（技能块内第二段起的 .damage 调用）全部计入上界，
 *   其中可能含对后台/对自己的伤害——高估方向，防御语义下可接受。
 * - 数据不可得（角色不在 GameData、源码目录不可读）时一律返回 undefined
 *   （条件恒假），与 fields.ts 的未知字段惯例一致；绝不抛错。
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { GameData } from "@gi-tcg/core"
import {
  parseSkillDamageFromSource,
  type SourceDamageInfo,
} from "../../knowledge/character-profiles/source-parser.js"
import { binomialTail, P_ELEMENT_OR_OMNI } from "./dice-prior.js"
import type { PbViewState } from "./fields.js"

type PbViewPlayer = PbViewState["player"][number]
type PbViewCharacter = PbViewPlayer["character"][number]

// ── 反应加成表 ─────────────────────────────────────────────────────────

/**
 * 反应对主目标伤害的加成，转写自 core 权威实现：
 * - 反应判定表：packages/core/src/base/reaction.ts 的 REACTION_MAP（getReaction）
 *   （core 未从包导出该函数，故转写；改动 core 反应表时需同步此处）
 * - 加成数值：packages/core/src/base/skill.ts 的 increaseDamageByReaction：
 *   融化/蒸发/超载 +2；超导/感电/冻结/结晶/燃烧/绽放/激化 +1；
 *   扩散主目标 +0（1 点溅射给后台角色，不计入出战威胁）。
 * 月反应默认不启用，不计。
 *
 * 键：aura 枚举值（NONE=0 CRYO=1 HYDRO=2 PYRO=3 ELECTRO=4 DENDRO=7 CRYO_DENDRO=113）
 * → 伤害元素（DamageType 1..7）→ 加成。
 */
const REACTION_BONUS: Record<number, Partial<Record<number, number>>> = {
  1: { 2: 1, 3: 2, 4: 1, 6: 1 }, // cryo 附着：冻结/融化/超导/结晶
  2: { 1: 1, 3: 2, 4: 1, 6: 1, 7: 1 }, // hydro：冻结/蒸发/感电/结晶/绽放
  3: { 1: 2, 2: 2, 4: 2, 6: 1, 7: 1 }, // pyro：融化/蒸发/超载/结晶/燃烧
  4: { 1: 1, 2: 1, 3: 2, 6: 1, 7: 1 }, // electro：超导/感电/超载/结晶/激化
  7: { 2: 1, 3: 1, 4: 1 }, // dendro：绽放/燃烧/激化
  113: { 2: 1, 3: 2, 4: 1, 6: 1 }, // cryo_dendro 复合附着
}

/** 技能伤害打在带 aura 的目标上时，主目标伤害的反应加成（物理/穿透/治疗无反应） */
export function reactionBonusOnMainTarget(aura: number, damageType: number): number {
  if (damageType < 1 || damageType > 7) return 0
  return REACTION_BONUS[aura]?.[damageType] ?? 0
}

// ── 技能威胁表（GameData 成本 × 源码静态伤害） ──────────────────────────

export interface ThreatSkillInfo {
  skillType: "normal" | "elemental" | "burst"
  /** 元素费用（需该元素或万能骰支付的部分） */
  elementDice: number
  /** 骰子总费用（元素 + 同色 + 无色） */
  totalDice: number
  /** 能量费用（爆发） */
  energyCost: number
  /** 主伤害类型（DamageType 值） */
  damageType: number
  /** 主伤害 + additionalDamage 合计（上界：含条件增益与对非主目标段） */
  damage: number
}

// core 内部 cost map 键（typings common_enums 的 DiceType）：
// Void=0、元素 1..7、Aligned(同色)=8、Energy=9、Legend=10（秘传，骰子付不了）
const COST_VOID = 0
const COST_ALIGNED = 8
const COST_ENERGY = 9

function extractThreatCost(requiredCost: ReadonlyMap<number, number>): {
  elementDice: number
  totalDice: number
  energyCost: number
} {
  let elementDice = 0
  let otherDice = 0
  let energyCost = 0
  for (const [diceType, count] of requiredCost) {
    if (diceType === COST_ENERGY) energyCost += count
    else if (diceType >= 1 && diceType <= 7) elementDice += count
    else if (diceType === COST_VOID || diceType === COST_ALIGNED) otherDice += count
    // Legend 等非常规费用：骰子付不了，不计（此类技能天然进不了上界，属保守方向）
  }
  return { elementDice, totalDice: elementDice + otherDice, energyCost }
}

/** 从 GameData + 源码伤害表构建单个角色的威胁画像；角色不存在时返回 undefined */
export function buildThreatProfile(
  gameData: GameData,
  damageMap: ReadonlyMap<number, SourceDamageInfo>,
  charDefId: number,
): ThreatSkillInfo[] | undefined {
  const charDef = gameData.characters?.get(charDefId)
  if (!charDef) return undefined
  const out: ThreatSkillInfo[] = []
  for (const skillDef of charDef.skills) {
    // 真实 GameData 形状（core base/skill.ts 的 InitiativeSkillDefinition）：
    // skillType 在技能定义顶层，requiredCost 在 initiativeSkillConfig 内。
    const sd = skillDef as unknown as {
      skillType?: string
      initiativeSkillConfig?: { requiredCost: ReadonlyMap<number, number> }
    }
    const cfg = sd.initiativeSkillConfig
    if (!cfg) continue // 被动技能
    const t = sd.skillType
    if (t !== "normal" && t !== "elemental" && t !== "burst") continue // technique 不经 useSkill
    const cost = extractThreatCost(cfg.requiredCost)
    const dmg = damageMap.get(skillDef.id)
    out.push({
      skillType: t,
      ...cost,
      damageType: dmg?.mainDamageType ?? 0,
      damage: (dmg?.mainDamageValue ?? 0) + (dmg?.additionalDamage ?? []).reduce((s, d) => s + d.value, 0),
    })
  }
  return out
}

// ── 源码伤害表懒加载（同步读 @gi-tcg/data 源码，沿用 character-skill-profiles 的先例） ──

const ELEMENT_DIRS = ["anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro"]

let _damageCache: Map<number, SourceDamageInfo> | null = null

/** 懒加载并缓存全技能伤害表；目录不可读（如 dist 环境）时返回空表（威胁字段降级 undefined） */
export function loadSkillDamageMap(): Map<number, SourceDamageInfo> {
  if (_damageCache) return _damageCache
  const map = new Map<number, SourceDamageInfo>()
  try {
    // plan-oneshot/ → runtime → src → gi-agent → packages → data/src/characters
    const charsDir = join(import.meta.dirname, "..", "..", "..", "..", "data", "src", "characters")
    for (const elem of ELEMENT_DIRS) {
      let files: string[]
      try {
        files = readdirSync(join(charsDir, elem)).filter((f) => f.endsWith(".ts"))
      } catch {
        continue
      }
      for (const f of files) {
        try {
          const content = readFileSync(join(charsDir, elem, f), "utf-8")
          for (const [skillId, info] of parseSkillDamageFromSource(content)) {
            map.set(skillId, info)
          }
        } catch { /* 单文件解析失败跳过，不阻断 */ }
      }
    }
  } catch { /* 目录不存在 → 空表 */ }
  _damageCache = map
  return map
}

// GameData → damageMap → (charDefId → profile) 缓存
const _profileCache = new WeakMap<GameData, WeakMap<object, Map<number, ThreatSkillInfo[] | undefined>>>()

function threatProfileOf(
  gameData: GameData,
  damageMap: ReadonlyMap<number, SourceDamageInfo>,
  charDefId: number,
): ThreatSkillInfo[] | undefined {
  let perData = _profileCache.get(gameData)
  if (!perData) {
    perData = new WeakMap()
    _profileCache.set(gameData, perData)
  }
  let perMap = perData.get(damageMap)
  if (!perMap) {
    perMap = new Map()
    perData.set(damageMap, perMap)
  }
  if (!perMap.has(charDefId)) {
    perMap.set(charDefId, buildThreatProfile(gameData, damageMap, charDefId))
  }
  return perMap.get(charDefId)
}

// ── 字段求值 ───────────────────────────────────────────────────────────

/** 单角色在 diceBudget 上限内（假设骰面全可用）一动对主目标的最大伤害（含反应加成） */
function maxSkillDamage(
  skills: readonly ThreatSkillInfo[],
  energy: number,
  diceBudget: number,
  aura: number,
): number {
  let max = 0
  for (const s of skills) {
    if (s.totalDice > diceBudget) continue
    if (s.energyCost > energy) continue
    max = Math.max(max, s.damage + reactionBonusOnMainTarget(aura, s.damageType))
  }
  return max
}

/** 可见护盾合计：出战角色实体 + 玩家战斗状态中带 shield 变量的实体（减伤类状态不计） */
function shieldTotal(self: PbViewPlayer, selfActive: PbViewCharacter): number {
  let sum = 0
  for (const e of selfActive.entity ?? []) sum += e.shield ?? 0
  for (const e of self.combatStatus ?? []) sum += e.shield ?? 0
  return sum
}

/**
 * 求值 opp.threat.* 字段（名字不带前缀，如 "maxDamage"）。
 * 未知名字或引用对象不存在时返回 undefined（条件恒假）。
 * damageMap 缺省为懒加载的源码伤害表；测试可注入假表。
 */
export function resolveThreatField(
  name: string,
  self: PbViewPlayer,
  opponent: PbViewPlayer,
  gameData: GameData,
  damageMap: ReadonlyMap<number, SourceDamageInfo> = loadSkillDamageMap(),
): number | boolean | undefined {
  const oppActive = opponent.character.find((c) => c.id === opponent.activeCharacterId)
  const selfActive = self.character.find((c) => c.id === self.activeCharacterId)
  if (!oppActive || !selfActive) return undefined
  const profile = threatProfileOf(gameData, damageMap, oppActive.definitionId)
  if (!profile) return undefined
  const diceTotal = opponent.dice.length
  const aura = selfActive.aura
  const hasDamageData = damageMap.size > 0

  switch (name) {
    case "maxDamage":
      return hasDamageData
        ? maxSkillDamage(profile, oppActive.energy, diceTotal, aura)
        : undefined
    case "lethal": {
      if (!hasDamageData) return undefined
      return maxSkillDamage(profile, oppActive.energy, diceTotal, aura)
        >= selfActive.health + shieldTotal(self, selfActive)
    }
    case "lethalP": {
      // 斩杀概率：逐个技能判"伤害+反应加成 ≥ 当前有效生命（HP+可见护盾）"，
      // 达标技能的支付概率（同 burstP 口径的二项尾；elementDice=0 时恒 1）取最大。
      // 无达标技能返回 0（而非 undefined）——"估不出来"才 undefined（伤害表空）。
      if (!hasDamageData) return undefined
      const need = selfActive.health + shieldTotal(self, selfActive)
      let max = 0
      for (const s of profile) {
        if (s.damage + reactionBonusOnMainTarget(aura, s.damageType) < need) continue
        if (s.energyCost > oppActive.energy) continue
        if (s.totalDice > diceTotal) continue
        max = Math.max(max, binomialTail(diceTotal, P_ELEMENT_OR_OMNI, s.elementDice))
      }
      return Math.round(max * 1000) / 1000
    }
    case "burstReady": {
      const burst = profile.find((s) => s.skillType === "burst")
      if (!burst) return undefined
      return oppActive.energy >= burst.energyCost && diceTotal >= burst.totalDice
    }
    case "burstP": {
      // 对手骰面隐藏：按"剩余 n 骰中元素+万能 ≥ 元素费"的二项尾概率估计。
      // 简化口径（文档注明）：剩余骰视为独立均匀（不条件于已消耗骰面的信息）；
      // 同色/无色费只计入 totalDice 门槛，不按同色概率细估。
      const burst = profile.find((s) => s.skillType === "burst")
      if (!burst) return undefined
      if (oppActive.energy < burst.energyCost || diceTotal < burst.totalDice) return 0
      const p = binomialTail(diceTotal, P_ELEMENT_OR_OMNI, burst.elementDice)
      return Math.round(p * 1000) / 1000
    }
    case "maxDamageAfterSwitch": {
      // 切人（1 骰慢速行动）+ 技能的两动上界；无存活后台角色时为 0
      if (!hasDamageData) return undefined
      const budget = diceTotal - 1
      let max = 0
      for (const c of opponent.character) {
        if (c.defeated || c.id === oppActive.id) continue
        const p = threatProfileOf(gameData, damageMap, c.definitionId)
        if (!p) continue
        max = Math.max(max, maxSkillDamage(p, c.energy, budget, aura))
      }
      return max
    }
    default:
      return undefined
  }
}
