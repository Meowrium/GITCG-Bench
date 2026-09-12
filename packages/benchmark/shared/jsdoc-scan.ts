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
 * 共享 JSDoc 扫描器 —— 从 @gi-tcg/data 源文件提取卡牌/角色/技能定义。
 *
 * 供 gi-knowledge（题目生成）与 deck-analysis（标注 TUI 卡组信息）共用。
 *
 * 解析策略：逐个匹配 JSDoc 块，再检查紧随其后的是否为
 * `export const ... = builderFn(...)` 声明；不满足则跳过该块。
 * 这样无 export 的声明（如 `const X = combatStatus(...)`）不会把
 * 下一个 JSDoc 块"吞噬"掉（旧实现的 bug，曾导致整牌丢失）。
 *
 * 扫描范围：cards/、characters/、commons.ts；排除 old_versions/。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// ── 类型 ────────────────────────────────────────────────

export type DefKind =
  | "character" | "card" | "skill" | "summon"
  | "status" | "combatStatus" | "extension" | "entity"

export interface CostPart {
  /** builder 调用名（去掉 "cost" 前缀），如 "Same" | "Void" | "Hydro" | "Energy" */
  type: string
  n: number
}

export interface ScannedDef {
  definitionId: number
  name: string
  /** 保留换行的描述文本（JSDoc @description 到注释结尾） */
  description: string
  tags: string[]
  kind: DefKind
  /** 相对 data/src 的路径（POSIX 分隔符） */
  relPath: string
  // card
  cardType?: "equipment" | "event" | "support"
  subtype?: string
  // character
  element?: string
  weapon?: string
  nation?: string
  hp?: number
  energy?: number
  specialEnergy?: number
  // skill
  skillType?: string
  // 费用（结构化）
  costParts: CostPart[]
  /** 全部 .costXxx(n) 的 n 求和（含 Energy），与 gi-knowledge 语义一致 */
  costTotal: number
  /** 显示用费用串，如 "3水+2能"、"3任意"；无费用调用时卡牌为 "0"、其他为 "" */
  costDisplay: string
  since: string | null
}

// ── 常量 ────────────────────────────────────────────────

const BUILDER_KIND: Record<string, DefKind> = {
  character: "character",
  card: "card",
  skill: "skill",
  summon: "summon",
  status: "status",
  combatStatus: "combatStatus",
  extension: "extension",
  entity: "entity",
}

const ELEMENT_ZH: Record<string, string> = {
  pyro: "火", hydro: "水", electro: "雷", cryo: "冰",
  anemo: "风", geo: "岩", dendro: "草",
}

const WEAPON_TAGS = ["sword", "claymore", "pole", "bow", "catalyst", "otherWeapon"]
const NATION_TAGS = [
  "mondstadt", "liyue", "inazuma", "sumeru", "fontaine",
  "natlan", "nodkrai", "fatui", "monster", "hilichurl", "eremite",
]

// ── 数据源根目录 ─────────────────────────────────────────

/** 向上查找 @gi-tcg/benchmark 包根，再定位 ../data/src */
export function resolveDataSourceRoot(): string {
  let cursor = path.dirname(new URL(import.meta.url).pathname)
  // Windows 下 pathname 形如 /D:/...，去掉前导斜杠
  if (/^\/[A-Za-z]:\//.test(cursor)) cursor = cursor.slice(1)
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(cursor, "package.json")
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf-8"))
        if (json.name === "@gi-tcg/benchmark") {
          return path.resolve(cursor, "../data/src")
        }
      } catch { /* 继续向上 */ }
    }
    cursor = path.resolve(cursor, "..")
  }
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../data/src")
}

// ── 单文件解析 ───────────────────────────────────────────

const JSDOC_RE = /\/\*\*([\s\S]*?)\*\//g
/** 紧随 JSDoc 的 export 声明：`export const [A, B] = card(` / `export const X: SkillHandle = skill(` */
const DECL_RE = /^\s*export\s+const\s+(?:\[[^\]]*\]|\{[^}]*\}|[A-Za-z_]\w*)(?:\s*:\s*[^=]+)?\s*=\s*([A-Za-z_]\w*)\s*\(/
/** 费用调用：大写字母开头的 .costXxx(n)（与 gi-knowledge 旧实现语义一致） */
const COST_RE = /\.cost([A-Z][a-zA-Z]*)\s*\(\s*(\d+)\s*\)/g

function parseDescription(comment: string): string {
  const m = comment.match(/@description\s*([\s\S]*?)$/)
  return (m?.[1] ?? "")
    .split("\n")
    .map(l => l.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim()
}

function formatCostDisplay(parts: CostPart[], kind: DefKind): string {
  if (parts.length === 0) return kind === "card" ? "0" : ""
  const segs: string[] = []
  for (const p of parts) {
    if (p.type === "Same" || p.type === "Void" || p.type === "Has") {
      segs.push(`${p.n}任意`)
    } else if (p.type === "Energy") {
      segs.push(`${p.n}能`)
    } else {
      const el = ELEMENT_ZH[p.type.toLowerCase()]
      segs.push(el ? `${p.n}${el}` : `${p.n}`)
    }
  }
  const dice = segs.filter(s => !s.endsWith("能"))
  const energy = segs.filter(s => s.endsWith("能"))
  return dice.join("+") + (energy.length > 0 ? "+" + energy.join("+") : "")
}

function parseBlock(comment: string, expr: string, relPath: string, kind: DefKind): ScannedDef | null {
  const idMatch = comment.match(/@id\s+(\d+)/)
  const nameMatch = comment.match(/@name\s+(.+)/)
  if (!idMatch || !nameMatch) return null

  const tags = [...expr.matchAll(/\.tags\(([^)]*)\)/g)]
    .flatMap(m => m[1]?.split(",") ?? [])
    .map(s => s.replace(/["'`]/g, "").trim())
    .filter(Boolean)

  const costParts: CostPart[] = [...expr.matchAll(COST_RE)]
    .map(m => ({ type: m[1]!, n: parseInt(m[2]!, 10) }))
  const costTotal = costParts.reduce((s, p) => s + p.n, 0)

  const def: ScannedDef = {
    definitionId: parseInt(idMatch[1]!, 10),
    name: nameMatch[1]!.trim(),
    description: parseDescription(comment),
    tags,
    kind,
    relPath,
    costParts,
    costTotal,
    costDisplay: formatCostDisplay(costParts, kind),
    since: expr.match(/\.since\("([^"]+)"\)/)?.[1] ?? null,
  }

  if (relPath.startsWith("cards/equipment/")) def.cardType = "equipment"
  else if (relPath.startsWith("cards/event/")) def.cardType = "event"
  else if (relPath.startsWith("cards/support/")) def.cardType = "support"
  else if (kind === "card" && relPath.startsWith("characters/")) def.cardType = "equipment" // 角色文件内的天赋牌

  if (kind === "card") {
    // subtype：builder 方法与 tags 双信号
    if (/\.talent\(/.test(expr) || tags.includes("talent")) def.subtype = "talent"
    else if (/\.weapon\(/.test(expr) || tags.includes("weapon")) def.subtype = "weapon"
    else if (/\.artifact\(/.test(expr) || tags.includes("artifact")) def.subtype = "artifact"
    else if (/\.food\(/.test(expr) || tags.includes("food")) def.subtype = "food"
    else if (/\.legend\(/.test(expr) || tags.includes("arcaneLegend")) def.subtype = "arcaneLegend"
    else def.subtype = ""
  }

  if (kind === "character") {
    const parts = relPath.split("/")
    if (parts[0] === "characters") def.element = parts[1]
    const hp = expr.match(/\.health\(\s*(\d+)\s*\)/)
    if (hp) def.hp = parseInt(hp[1]!, 10)
    const en = expr.match(/\.energy\(\s*(\d+)\s*\)/)
    if (en) def.energy = parseInt(en[1]!, 10)
    const sp = expr.match(/\.specialEnergy\(\s*"[^"]*"\s*,\s*(\d+)\s*\)/)
    if (sp) def.specialEnergy = parseInt(sp[1]!, 10)
    def.weapon = tags.find(t => WEAPON_TAGS.includes(t))
    def.nation = tags.find(t => NATION_TAGS.includes(t))
  }

  if (kind === "skill") {
    def.skillType = expr.match(/\.type\("(\w+)"\)/)?.[1]
  }

  return def
}

export function parseDataFile(relPath: string, content: string): ScannedDef[] {
  const defs: ScannedDef[] = []
  JSDOC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = JSDOC_RE.exec(content)) !== null) {
    const blockEnd = m.index + m[0].length
    const after = content.slice(blockEnd, blockEnd + 500)
    const decl = DECL_RE.exec(after)
    if (!decl) continue // 非 export builder 声明（如无 export 的 combatStatus）：跳过，不吞噬
    const kind = BUILDER_KIND[decl[1]!]
    if (!kind) continue

    // builder 链区域：从 JSDoc 结束到 .done() / .reserve()（先到者为准）
    const window = content.slice(blockEnd, blockEnd + 8000)
    const doneIdx = window.indexOf(".done()")
    const reserveIdx = window.indexOf(".reserve()")
    let end = window.length
    if (doneIdx >= 0) end = doneIdx
    if (reserveIdx >= 0 && reserveIdx < end) end = reserveIdx
    const expr = window.slice(0, end)

    const def = parseBlock(m[1] ?? "", expr, relPath, kind)
    if (def) defs.push(def)
  }
  return defs
}

// ── 全量扫描（带缓存） ───────────────────────────────────

function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full)
      }
    }
  }
  walk(path.join(root, "cards"))
  walk(path.join(root, "characters"))
  const commons = path.join(root, "commons.ts")
  if (existsSync(commons)) out.push(commons)
  return out
}

let _cache: { root: string; defs: ScannedDef[] } | null = null

/** 扫描 data/src 下全部定义（cards/ + characters/ + commons.ts，排除 old_versions/） */
export function scanDataSource(sourceRoot?: string): ScannedDef[] {
  const root = sourceRoot ?? resolveDataSourceRoot()
  if (_cache && _cache.root === root) return _cache.defs
  const defs: ScannedDef[] = []
  for (const abs of collectFiles(root)) {
    const rel = path.relative(root, abs).replace(/\\/g, "/")
    defs.push(...parseDataFile(rel, readFileSync(abs, "utf-8")))
  }
  _cache = { root, defs }
  return defs
}

/** 测试/调试用途：清空缓存 */
export function clearScanCache(): void {
  _cache = null
}

/**
 * 角色的技能列表。技能 ID 约定：charDefId * 10 + 序号(1-9)。
 * 同名+同类型去重。
 */
export function getCharacterSkills(charDefId: number, defs?: ScannedDef[]): ScannedDef[] {
  const all = defs ?? scanDataSource()
  const lo = charDefId * 10 + 1
  const hi = charDefId * 10 + 9
  const seen = new Set<string>()
  return all
    .filter(d => d.kind === "skill" && d.definitionId >= lo && d.definitionId <= hi)
    .filter(s => {
      const key = `${s.name}|${s.skillType ?? ""}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
