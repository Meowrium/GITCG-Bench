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
 * gi-knowledge 的卡牌定义提取 —— 共享 JSDoc 扫描器（shared/jsdoc-scan）的
 * 薄适配层。保持原有函数签名与 CardDef 字段语义不变。
 */

import {
  resolveDataSourceRoot as resolveRoot,
  scanDataSource,
  type ScannedDef,
} from "../../shared/jsdoc-scan"
import type { CardDef } from "./types"

// ── 适配 ────────────────────────────────────────────────

/** 与旧实现一致：type 完全由相对路径决定（与 kind 无关） */
function detectTypeByRelPath(rel: string): string {
  if (rel.startsWith("characters/")) {
    const el = rel.split("/")[1] ?? "unknown"
    return `character:${el}`
  }
  if (rel.startsWith("cards/equipment/")) return "equipment"
  if (rel.startsWith("cards/event/")) return "event"
  if (rel.startsWith("cards/support/")) return "support"
  return "unknown"
}

function toCardDef(d: ScannedDef): CardDef {
  return {
    definitionId: d.definitionId,
    name: d.name,
    description: d.description,
    type: detectTypeByRelPath(d.relPath),
    tags: d.tags,
    kind: d.kind,
    cost: d.costTotal,
    since: d.since,
    sourcePath: d.relPath,
    health: d.hp,
    energy: d.energy,
    specialEnergy: d.specialEnergy,
  }
}

// ── 对外 API（签名不变） ─────────────────────────────────

/** Resolve the data source root directory */
export function resolveDataSourceRoot(): string {
  return resolveRoot()
}

/**
 * Parse all card/character/skill definitions from the data source.
 * Skips `old_versions/` and non-card/character files.
 */
export async function extractAllCardDefs(
  sourceRoot?: string,
): Promise<CardDef[]> {
  const defs = scanDataSource(sourceRoot).map(toCardDef)
  const seen = new Map<number, CardDef>()
  for (const def of defs) {
    seen.set(def.definitionId, def)
  }
  return [...seen.values()]
}

/** Filter to obtainable cards (card or character kinds only) */
export function getObtainableCards(defs: CardDef[]): CardDef[] {
  return defs.filter(
    (d) => d.kind === "card" || d.kind === "character",
  )
}

/** Filter to characters only */
export function getCharacters(defs: CardDef[]): CardDef[] {
  return defs
    .filter((d) => d.kind === "character")
    .sort((a, b) => a.definitionId - b.definitionId)
}

/** Filter to playable cards only (not characters) */
export function getPlayableCards(defs: CardDef[]): CardDef[] {
  return defs
    .filter((d) => d.kind === "card")
    .sort((a, b) => a.definitionId - b.definitionId)
}

/** Get all skill definitions */
export function getSkills(defs: CardDef[]): CardDef[] {
  return defs
    .filter((d) => d.kind === "skill")
    .sort((a, b) => a.definitionId - b.definitionId)
}
