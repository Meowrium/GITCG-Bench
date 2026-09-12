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

/**
 * DSL 源码提取器：从 @gi-tcg/data 的 TypeScript 源码中，
 * 按 @id JSDoc 锚点提取每张卡牌/技能/角色的 builder DSL 定义块。
 *
 * 提取的是源码文本（非运行时执行），用于在 prompt 中为 LLM 提供
 * 精确、无歧义的效果定义，与官方中文描述形成"双通道"对照。
 *
 * 源码只在首次调用时扫描一次，后续走模块级缓存。
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, extname } from "node:path"
import { fileURLToPath } from "node:url"

/** 本文件所在目录（兜底多个候选，适配不同运行环境） */
const THIS_DIR = fileURLToPath(new URL(".", import.meta.url))

/** data 包源码根目录：从多个候选路径中探测 */
function resolveDataSrc(): string | null {
  const candidates = [
    join(THIS_DIR, "../../data/src"),   // 模块在 src/ 下，src→包根→packages→data/src（两层）
    join(THIS_DIR, "../../../data/src"), // 兜底：某些环境 import.meta.url 指向包根
    join(THIS_DIR, "../data/src"),       // 兜底：bun -e 时 THIS_DIR 可能在包根
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

let DATA_SRC: string | null = null

/** 单个 DSL 块的最大长度（超出则跳过，防异常） */
const MAX_BLOCK_LENGTH = 3000

/** id → 精简后的 DSL 源码块（去除 JSDoc 注释） */
const idToSource = new Map<number, string>()

/** 常量名 → 精简后的 DSL 源码块（用于从 .skills(A,B,C) 反查技能定义） */
const nameToSource = new Map<string, string>()

/** 是否已完成扫描 */
let indexed = false

/** 扫描中进行的 Promise（防止并发重复扫描） */
let indexingPromise: Promise<void> | null = null

async function walk(d: string): Promise<string[]> {
  const out: string[] = []
  let entries: string[]
  try {
    entries = await readdir(d)
  } catch {
    return out
  }
  for (const name of entries) {
    const f = join(d, name)
    let isDir: boolean
    try {
      isDir = (await stat(f)).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      out.push(...(await walk(f)))
    } else if (extname(name) === ".ts") {
      out.push(f)
    }
  }
  return out
}

/** 去掉 JSDoc 注释块（中文描述区块已有，避免冗余） */
function stripJSDoc(src: string): string {
  return src.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "").trim()
}

/** 扫描 data/src，建立 id→源码 和 name→源码 索引 */
async function ensureIndexed(): Promise<void> {
  if (indexed) return
  if (indexingPromise) return indexingPromise
  indexingPromise = (async () => {
    if (DATA_SRC === null) {
      DATA_SRC = resolveDataSrc()
    }
    if (DATA_SRC === null) {
      // data/src 不可达（如发布到 npm 后），静默跳过
      indexed = true
      return
    }
    const files = await walk(DATA_SRC)
    for (const fp of files) {
      const src = await readFile(fp, "utf-8")
      // 按 /** JSDoc 注释切块
      const blocks = src.split(/(?=^\/\*\*)/m)
      for (const block of blocks) {
        const idMatch = block.match(/@id\s+(\d+)/)
        const nameMatch = block.match(/export const (\w+)\s*[:=]/)
        const cleaned = stripJSDoc(block)
        if (cleaned.length === 0 || cleaned.length > MAX_BLOCK_LENGTH) continue
        if (idMatch) {
          idToSource.set(parseInt(idMatch[1], 10), cleaned)
        }
        if (nameMatch) {
          nameToSource.set(nameMatch[1], cleaned)
        }
      }
    }
    indexed = true
  })()
  return indexingPromise
}

/**
 * 按 id 获取 DSL 源码块（已去 JSDoc）。
 * 首次调用会触发 data/src 全量扫描（异步，约 50-100ms）。
 */
export async function getDslSourceById(id: number): Promise<string | undefined> {
  await ensureIndexed()
  return idToSource.get(id)
}

/**
 * 按常量名获取 DSL 源码块（用于从 .skills(A,B,C) 反查技能定义）。
 */
export async function getDslSourceByName(name: string): Promise<string | undefined> {
  await ensureIndexed()
  return nameToSource.get(name)
}

/**
 * 批量获取多个 id 的 DSL 源码，返回 Map。
 */
export async function getDslSourcesByIds(ids: Iterable<number>): Promise<Map<number, string>> {
  await ensureIndexed()
  const result = new Map<number, string>()
  for (const id of ids) {
    const src = idToSource.get(id)
    if (src) result.set(id, src)
  }
  return result
}

/**
 * 从角色定义的 .skills(A, B, C) 中解析技能常量名，
 * 并返回每个技能的 DSL 源码块（按出现顺序）。
 */
export async function getCharacterSkillSources(
  characterId: number,
): Promise<string[]> {
  await ensureIndexed()
  const charSrc = idToSource.get(characterId)
  if (!charSrc) return []
  const skillsMatch = charSrc.match(/\.skills\(([^)]+)\)/)
  if (!skillsMatch) return []
  const skillNames = skillsMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const result: string[] = []
  for (const sn of skillNames) {
    const src = nameToSource.get(sn)
    if (src) result.push(src)
  }
  return result
}

/** 仅供测试：重置缓存 */
export function _resetDslSourceCache(): void {
  idToSource.clear()
  nameToSource.clear()
  indexed = false
  indexingPromise = null
}
