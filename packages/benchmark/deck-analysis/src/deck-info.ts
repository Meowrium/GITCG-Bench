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
 * 卡组信息解析器 —— 基于共享 JSDoc 扫描器（shared/jsdoc-scan），
 * 从 deck code 解码出的 ID 列表拼出完整的卡组描述，供标注 TUI 对照使用。
 */

import {
  getCharacterSkills,
  scanDataSource,
  type ScannedDef,
} from "../../shared/jsdoc-scan"

// ── 类型 ───────────────────────────────────────────────

export interface DeckInfo {
  version: string
  deckCode: string
  deckName: string
  characters: CharacterInfo[]
  cards: CardInfo[]
}

export interface CharacterInfo {
  definitionId: number
  name: string
  element: string
  weapon: string
  nation: string
  hp: number
  energy: number
  skills: {
    id: number         // 技能 definitionId（charDefId*10+序号，与模拟器寻址一致）
    name: string
    type: string       // "normal" | "elementalSkill" | "elementalBurst" | "passive"
    cost: string       // 如 "3水"、"4任意"
    description: string
  }[]
}

export interface CardInfo {
  definitionId: number
  name: string
  type: string         // "equipment" | "event" | "support"
  subtype: string      // 如 "weapon"、"talent"、"food"、"arcaneLegend"、""
  cost: string         // 如 "3水"、"1同色"、"0"
  tags: string[]
  description: string
}

// ── 元素/武器/国家 中文名（供 TUI 复用） ───────────────────

export const ELEMENT_ZH: Record<string, string> = {
  pyro: "火", hydro: "水", electro: "雷", cryo: "冰",
  anemo: "风", geo: "岩", dendro: "草",
}

export const WEAPON_ZH: Record<string, string> = {
  sword: "单手剑", claymore: "双手剑", pole: "长柄武器",
  bow: "弓", catalyst: "法器", otherWeapon: "其他武器",
}

export const NATION_ZH: Record<string, string> = {
  mondstadt: "蒙德", liyue: "璃月", inazuma: "稻妻",
  sumeru: "须弥", fontaine: "枫丹", natlan: "纳塔",
  nodkrai: "挪德卡莱", fatui: "愚人众", monster: "怪物",
  hilichurl: "丘丘人", eremite: "镀金旅团",
}

// ── 查询表 ──────────────────────────────────────────────

const SKILL_TYPE_MAP: Record<string, string> = {
  normal: "normal", elemental: "elementalSkill", burst: "elementalBurst", passive: "passive",
}

let _lookup: Map<number, ScannedDef> | null = null

function getLookup(): Map<number, ScannedDef> {
  if (_lookup) return _lookup
  _lookup = new Map()
  for (const def of scanDataSource()) {
    if (def.kind !== "skill") {
      _lookup.set(def.definitionId, def)
    }
  }
  return _lookup
}

/** 压平多行描述为单行（TUI 显示用） */
export function flattenDescription(desc: string): string {
  return desc.replace(/\s+/g, " ").trim()
}

// ── 构建 ────────────────────────────────────────────────

/**
 * 构建 DeckInfo：从解码后的 ID 列表 + 扫描结果拼出完整的卡组描述。
 */
export function buildDeckInfo(
  version: string,
  deckCode: string,
  deckName: string,
  characterIds: number[],
  cardIds: number[],
): DeckInfo {
  const lookup = getLookup()

  const characters: CharacterInfo[] = characterIds.map(id => {
    const block = lookup.get(id)
    return {
      definitionId: id,
      name: block?.name ?? `Char-${id}`,
      element: block?.element ?? "?",
      weapon: block?.weapon ?? "?",
      nation: block?.nation ?? "",
      hp: block?.hp ?? 0,
      energy: block?.energy ?? 0,
      skills: getCharacterSkills(id).map(sk => ({
        id: sk.definitionId,
        name: sk.name,
        type: SKILL_TYPE_MAP[sk.skillType ?? ""] ?? sk.skillType ?? "?",
        cost: sk.costDisplay,
        description: flattenDescription(sk.description),
      })),
    }
  })

  // 先统计每张卡牌的出现次数（处理重复卡牌）
  const cardCountMap = new Map<number, number>()
  for (const id of cardIds) {
    if (id === 0) continue
    cardCountMap.set(id, (cardCountMap.get(id) ?? 0) + 1)
  }
  // 用 Set 去重构建 CardInfo
  const seenCardIds = new Set<number>()
  const cards: CardInfo[] = []
  for (const id of cardIds) {
    if (id === 0 || seenCardIds.has(id)) continue
    seenCardIds.add(id)
    const block = lookup.get(id)
    const count = cardCountMap.get(id) ?? 1
    const name = block?.name ?? `Card-${id}`
    cards.push({
      definitionId: id,
      name: count > 1 ? `${name} ×${count}` : name,
      type: block?.cardType ?? "?",
      subtype: block?.subtype ?? "",
      cost: block ? block.costDisplay : "?",
      tags: block?.tags ?? [],
      description: block ? flattenDescription(block.description) : "",
    })
  }

  return { version, deckCode, deckName, characters, cards }
}
