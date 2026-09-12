// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

/**
 * card-face-table — @gi-tcg/data builder-DSL 源文件的静态卡面事实表（纯机械）。
 *
 * 反思期卡面校核（fields-lint 第 4 类）需要「费用 / HP 上限 / 基础伤害」真值，
 * 三者同源于 `@gi-tcg/data` 源码的 builder 链字面量（本表是该校核的唯一数据源，
 * 零网络、零资产接口）。本模块把 `character() / skill() / summon() / status() /
 * combatStatus() / attachment() / card()` 链解析为事实表，并按 `.since` / `.until`
 * 复刻 core `resolveOfficialVersion` 的版本选择
 * （`packages/data/src/old_versions/*.ts` 的旧版数值覆盖因此可解析）。
 *
 * 已知边界：
 * - `.do()` 闭包内的 `c.damage()/c.heal()`、条件 `.increaseDamage()`、非字面量
 *   参数一律标 `dynamic: true`——数值不可静态判定，校核侧跳过；
 * - 数据包目录不可读时返回空表（消费方按「查不到」降级，绝不抛错）；
 * - 反应加成算术不在本表范围（v2 扩展点）。
 */

import { createRequire } from "node:module"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { CURRENT_VERSION, VERSIONS } from "@gi-tcg/core"

export type CardFaceKind =
  | "character"
  | "skill"
  | "summon"
  | "status"
  | "combatStatus"
  | "attachment"
  | "extension"
  | "card"

export interface CardFaceCost {
  /** "cryo" | … | "dendro" | "void" | "same" | "energy" */
  element: string
  count: number
}

export interface CardFaceDamage {
  /** DamageType 名（如 "Electro" / "Physical"） */
  type: string
  value: number
}

export interface CardFaceDef {
  defId: number
  kind: CardFaceKind
  /** 数据包 src 下的相对路径（诊断用） */
  sourceFile: string
  /** `.since("vX")`（缺省 = 自 INIT_VERSION 起） */
  since?: string
  /** `.until("vX")`（旧版覆盖定义，含 vX 版本本身） */
  until?: string
  health?: number
  energy?: number
  usage?: number
  costs: CardFaceCost[]
  /** 字面量伤害（主伤害在前，追加伤害在后；不含 Heal） */
  damage: CardFaceDamage[]
  /** 字面量治疗量 */
  heal: number[]
  /** 伤害/治疗经 `.do()` 闭包、条件增伤或非字面量参数产生 → 数值不可静态判定 */
  dynamic: boolean
  /** 仅 kind=skill：`.type("normal"|"elemental"|"burst"|"passive"|"technique")` */
  skillType?: string
  /** 仅 kind=character：`.skills(...)` 解析出的技能 defId（跨文件句柄尽力解析） */
  skillIds: number[]
}

export interface CardFaceTable {
  /** 解析所用游戏版本（未指定时为 CURRENT_VERSION） */
  readonly gameVersion: string
  /** 该版本下可用的定义数 */
  readonly size: number
  get(defId: number): CardFaceDef | undefined
  skillsOf(charDefId: number): CardFaceDef[]
  skillOfType(charDefId: number, skillType: string): CardFaceDef | undefined
  /** 主伤害字面量；缺失或 dynamic 时 undefined */
  baseDamageOf(defId: number): CardFaceDamage | undefined
}

const COST_ELEMENT_BY_METHOD: Record<string, string> = {
  Void: "void",
  Cryo: "cryo",
  Hydro: "hydro",
  Pyro: "pyro",
  Electro: "electro",
  Anemo: "anemo",
  Geo: "geo",
  Dendro: "dendro",
  Same: "same",
  Energy: "energy",
}

const KIND_BY_BUILDER: Record<string, CardFaceKind> = {
  character: "character",
  skill: "skill",
  summon: "summon",
  status: "status",
  combatStatus: "combatStatus",
  attachment: "attachment",
  extension: "extension",
  card: "card",
}

/** `get(defId)` 的类别优先级（同 id 跨类别复现时取前者） */
const KIND_PRIORITY: readonly CardFaceKind[] = [
  "character",
  "card",
  "skill",
  "summon",
  "status",
  "combatStatus",
  "attachment",
  "extension",
]

// 链起点锚定行首（数据包的 builder 定义一律 `const X = builder(id)` 形态）；
// extension 一并识别只为保持块边界配对（其字段无校核价值）。
const START_RE =
  /^[ \t]*(?:export\s+)?(?:const|let)\s+(\[[^\]]*\]|\w+)\s*(?::[^=]*)?=\s*(character|skill|summon|status|combatStatus|attachment|extension|card)\((\d+)/gm
const END_RE = /^[ \t]*\.(?:done|reserve)\(\)/gm
// 链级伤害/治疗调用：排除 `c.damage(...)` 一类闭包内调用（前缀为标识符）
const DAMAGE_RE = /(?<![\w$.])\.(?:damage|endPhaseDamage)\(\s*DamageType\.(\w+)\s*,\s*(\d+)\s*[,)]/g
const DAMAGE_CALL_RE = /(?<![\w$.])\.(?:damage|endPhaseDamage)\(/g
const HEAL_RE = /(?<![\w$.])\.heal\((\d+)/g
const HEAL_CALL_RE = /(?<![\w$.])\.heal\(/g

interface RawEntry {
  name: string
  kind: CardFaceKind
  defId: number
  block: string
}

function intField(block: string, re: RegExp): number | undefined {
  const m = re.exec(block)
  return m ? Number(m[1]) : undefined
}

function strField(block: string, re: RegExp): string | undefined {
  return re.exec(block)?.[1]
}

function costsOf(block: string): CardFaceCost[] {
  const out: CardFaceCost[] = []
  for (const m of block.matchAll(/\.cost([A-Z]\w*)\((\d+)\)/g)) {
    const element = COST_ELEMENT_BY_METHOD[m[1]]
    if (element !== undefined) out.push({ element, count: Number(m[2]) })
  }
  return out
}

function damageAndHealOf(block: string): { damage: CardFaceDamage[]; heal: number[] } {
  const damage: CardFaceDamage[] = []
  const heal: number[] = []
  for (const m of block.matchAll(DAMAGE_RE)) {
    if (m[1] === "Heal") heal.push(Number(m[2]))
    else damage.push({ type: m[1], value: Number(m[2]) })
  }
  for (const m of block.matchAll(HEAL_RE)) heal.push(Number(m[1]))
  return { damage, heal }
}

function isDynamic(block: string, literalDamage: number, literalHeal: number): boolean {
  if (/\bc\.(?:damage|heal|increaseDamage|modifyDamage|multiplyDamage|divideDamage)\(/.test(block)) return true
  if (/\.increaseDamage\(/.test(block)) return true
  const calls = (block.match(DAMAGE_CALL_RE) ?? []).length + (block.match(HEAL_CALL_RE) ?? []).length
  return calls > literalDamage + literalHeal
}

function skillNamesOf(block: string): string[] {
  const m = /\.skills\(([^)]*)\)/s.exec(block)
  if (!m) return []
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\w+$/.test(s))
}

function parseFile(source: string): RawEntry[] {
  const starts = [...source.matchAll(START_RE)]
  const ends = [...source.matchAll(END_RE)]
  const entries: RawEntry[] = []
  let ei = 0
  for (const m of starts) {
    const kind = KIND_BY_BUILDER[m[2]]
    if (kind === undefined) continue
    const startIdx = m.index!
    while (ei < ends.length && ends[ei].index! < startIdx) ei++
    const endIdx = ei < ends.length ? ends[ei].index! : source.length
    const rawName = m[1]
    const name = rawName.startsWith("[") ? (/\w+/.exec(rawName)?.[0] ?? "") : rawName
    entries.push({ name, kind, defId: Number(m[3]), block: source.slice(startIdx, endIdx) })
    if (ei < ends.length) ei++
  }
  return entries
}

function toDef(
  entry: RawEntry,
  fileVars: ReadonlyMap<string, number>,
  globalVars: ReadonlyMap<string, number>,
  sourceFile: string,
): CardFaceDef {
  const b = entry.block
  const { damage, heal } = damageAndHealOf(b)
  const def: CardFaceDef = {
    defId: entry.defId,
    kind: entry.kind,
    sourceFile,
    since: strField(b, /\.since\("([^"]+)"\)/),
    until: strField(b, /\.until\("([^"]+)"\)/),
    health: intField(b, /\.health\((\d+)\)/),
    energy: intField(b, /\.energy\((\d+)\)/),
    usage: intField(b, /\.usage\((\d+)/),
    costs: costsOf(b),
    damage,
    heal,
    dynamic: isDynamic(b, damage.length, heal.length),
    skillType: entry.kind === "skill" ? strField(b, /\.type\("([^"]+)"\)/) : undefined,
    skillIds: [],
  }
  if (entry.kind === "character") {
    def.skillIds = skillNamesOf(b)
      .map((n) => fileVars.get(n) ?? globalVars.get(n))
      .filter((id): id is number => id !== undefined)
  }
  return def
}

function versionIndex(version: string | undefined): number {
  if (version === undefined) return 0
  return (VERSIONS as readonly string[]).indexOf(version)
}

/**
 * 复刻 core `resolveOfficialVersion`：`.since` 门先判（版本早于 since → 不存在），
 * 再取 `until >= 目标版本` 中 until 最小者（旧版覆盖），否则取 since 定义。
 */
function resolveActive(defs: readonly CardFaceDef[], version: string): CardFaceDef | undefined {
  const sinceDef = defs.find((d) => d.until === undefined)
  if (sinceDef === undefined) return undefined
  const sinceIdx = sinceDef.since === undefined ? 0 : versionIndex(sinceDef.since)
  if (sinceIdx >= 0 && versionIndex(version) < sinceIdx) return undefined
  const untilCands = defs
    .filter((d) => d.until !== undefined && versionIndex(d.until) >= versionIndex(version))
    .sort((a, b) => versionIndex(a.until) - versionIndex(b.until))
  return untilCands[0] ?? sinceDef
}

function hasCharactersDir(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * 数据包 src 目录解析：`@gi-tcg/data` 的 exports 未开放 ./package.json，
 * 依次尝试 package.json 子路径、`internal/*` 源码子路径，最后按 monorepo 相对布局
 * （与 threat.ts 的源码定位同口径）；均不可得时返回 null（空表降级）。
 */
function dataSrcDirOf(): string | null {
  const require = createRequire(import.meta.url)
  for (const specifier of ["@gi-tcg/data/package.json", "@gi-tcg/data/internal/index.ts"]) {
    try {
      const resolved = require.resolve(specifier)
      const srcDir = join(dirname(resolved), specifier.endsWith("package.json") ? "src" : "")
      if (hasCharactersDir(join(srcDir, "characters"))) return srcDir
    } catch { /* 该解析路径不可用 */ }
  }
  const relative = join(import.meta.dirname, "..", "..", "..", "..", "data", "src")
  return hasCharactersDir(join(relative, "characters")) ? relative : null
}

function collectSourceFiles(srcDir: string): string[] {
  const files: string[] = []
  const charsDir = join(srcDir, "characters")
  try {
    for (const elem of readdirSync(charsDir, { withFileTypes: true })) {
      if (!elem.isDirectory()) continue
      const elemDir = join(charsDir, elem.name)
      for (const f of readdirSync(elemDir)) {
        if (f.endsWith(".ts")) files.push(join(elemDir, f))
      }
    }
  } catch { /* 目录不可读 → 空表 */ }
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".ts")) files.push(p)
    }
  }
  walk(join(srcDir, "cards"))
  try {
    for (const f of readdirSync(join(srcDir, "old_versions"))) {
      if (f.endsWith(".ts")) files.push(join(srcDir, "old_versions", f))
    }
  } catch { /* 旧版目录可选 */ }
  files.push(join(srcDir, "commons.ts"))
  return files
}

const TABLE_CACHE = new Map<string, CardFaceTable>()

export function buildCardFaceTable(opts: { dataSrcDir?: string; gameVersion?: string } = {}): CardFaceTable {
  const srcDir = opts.dataSrcDir ?? dataSrcDirOf()
  const gameVersion = opts.gameVersion !== undefined && versionIndex(opts.gameVersion) >= 0
    ? opts.gameVersion
    : CURRENT_VERSION
  if (srcDir === null) return emptyTable(gameVersion)
  const cacheKey = `${srcDir}\u0000${gameVersion}`
  const cached = TABLE_CACHE.get(cacheKey)
  if (cached) return cached

  const perFile: Array<{ file: string; entries: RawEntry[] }> = []
  const globalVars = new Map<string, number | null>()
  for (const file of collectSourceFiles(srcDir)) {
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    const entries = parseFile(source)
    if (entries.length === 0) continue
    perFile.push({ file, entries })
    for (const e of entries) {
      if (e.name === "") continue
      const prev = globalVars.get(e.name)
      if (prev === undefined) globalVars.set(e.name, e.defId)
      else if (prev !== e.defId) globalVars.set(e.name, null)
    }
  }
  const globalUnique = new Map<string, number>()
  for (const [name, id] of globalVars) if (id !== null) globalUnique.set(name, id)

  // defId 在不同 builder 类别中可复现（如 2602 同时是 extension 与若陀龙王）：
  // 先按类别分别做版本选择，再按优先级取 get(defId) 的返回类别。
  const byKind = new Map<CardFaceKind, Map<number, CardFaceDef[]>>()
  for (const { file, entries } of perFile) {
    const fileVars = new Map<string, number>()
    for (const e of entries) if (e.name !== "") fileVars.set(e.name, e.defId)
    const rel = file.startsWith(srcDir) ? file.slice(srcDir.length + 1).replace(/\\/g, "/") : file
    for (const e of entries) {
      const def = toDef(e, fileVars, globalUnique, rel)
      const store = byKind.get(def.kind) ?? new Map<number, CardFaceDef[]>()
      store.set(def.defId, [...(store.get(def.defId) ?? []), def])
      byKind.set(def.kind, store)
    }
  }
  const activeByKind = new Map<CardFaceKind, Map<number, CardFaceDef>>()
  for (const [kind, store] of byKind) {
    const active = new Map<number, CardFaceDef>()
    for (const [id, defs] of store) {
      const chosen = resolveActive(defs, gameVersion)
      if (chosen) active.set(id, chosen)
    }
    activeByKind.set(kind, active)
  }
  const defOfKind = (kind: CardFaceKind, defId: number): CardFaceDef | undefined =>
    activeByKind.get(kind)?.get(defId)
  const get = (defId: number): CardFaceDef | undefined => {
    for (const kind of KIND_PRIORITY) {
      const d = defOfKind(kind, defId)
      if (d) return d
    }
    return undefined
  }
  const skillsOf = (charDefId: number): CardFaceDef[] => {
    const ch = defOfKind("character", charDefId)
    if (!ch) return []
    return ch.skillIds
      .map((id) => defOfKind("skill", id))
      .filter((d): d is CardFaceDef => d !== undefined)
  }
  const table: CardFaceTable = {
    gameVersion,
    size: KIND_PRIORITY.reduce((s, kind) => s + (activeByKind.get(kind)?.size ?? 0), 0),
    get,
    skillsOf,
    skillOfType: (charDefId, skillType) => skillsOf(charDefId).find((d) => d.skillType === skillType),
    baseDamageOf: (defId) => {
      const d = get(defId)
      if (!d || d.dynamic) return undefined
      return d.damage[0]
    },
  }
  TABLE_CACHE.set(cacheKey, table)
  return table
}

function emptyTable(gameVersion: string): CardFaceTable {
  return {
    gameVersion,
    size: 0,
    get: () => undefined,
    skillsOf: () => [],
    skillOfType: () => undefined,
    baseDamageOf: () => undefined,
  }
}
