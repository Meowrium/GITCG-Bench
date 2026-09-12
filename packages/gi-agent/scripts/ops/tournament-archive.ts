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
 * tournament-archive — 冷代次压缩归档（model-tournament `archive` 子命令核心，
 * impl-spec-1 §4.6）。把不再会被后续代次消费的早期对局明细（battles/<pair>/<env>/
 * <cell>/game-NNNN/ 下的 plan_trace / plan_trace.side1 / game_state_log）压档到
 * `<outRoot>/archive/round-<r>/<pairName>.tar.gz` 并删除原 game-* 目录，为正赛
 * 多代跑批控制磁盘占用（lean 单局 ≈0.4MB，每代 ~40GB → 冷归档后热数据 ~60-80GB）。
 *
 * 冷判定（pair 粒度——pair 目录名内含两选手 @rN 代数，pair 内所有 cell 同代）：
 * - spec 全量枚举（model-tournament enumerateBatches 无 roundFilter）按 pairName
 *   分组；pair 的代数取 BatchSpec.round（不从目录名反解）；
 * - round > --through → 热代，不动；
 * - 链批 pair（isChain；ownChain=keep 纪律：链批 state log organizer 试点要用）
 *   默认保留，--include-chain 才归档；
 * - pair 内任一 cell 未 battle done → 跳过（battle 会续跑该批，删明细破坏续跑）；
 * - 安全闸（上游 evolve 未 done ⇒ 第 r 代 games 仍可能被 own-generations 证据消费；
 *   闸键 = model-tournament cmdEvolve 的 `evolve|<model>|<env>|<di>|r<r>`）：
 *   - plan 侧（跨模型与链批同）：r+1 ≤ rounds 且 evolve|planModel|env|di|r(r+1) 未
 *     done → 跳过；r == rounds（末代）无此闸；
 *   - opponent 侧跨模型：r+1 ≤ rounds 且 evolve|oppModel|env|dj|r(r+1) 未 done → 跳过；
 *   - opponent 侧链批（X@(r-1) 持 dj 的 side1 视角同样消费同批 games，喂 evolve r）：
 *     evolve|oppModel|env|dj|r(r) 未 done → 跳过（oppRound+1 = r ≤ rounds 恒成立）；
 * - 磁盘一致性：pair 下出现赛程外 (env, cell) → 整 pair 跳过（只归档赛程内产物）；
 * - evidence 交互（tournament-evidence.ts linkOrCopy 三级 fallback）：
 *   hardlink / copyFile 下删 battles 原文件不破坏 evidence（数据仍被组内链接持有，
 *   tarball 内是完整内容、解包产生独立新文件）；**symlink**（绝对路径指向 battles
 *   原文件）下删除会打断链接 → 归档前扫描 evidence 全树符号链接，凡指向本 pair 的
 *   → 整 pair 跳过并如实报告（不静默物化）。evidence.fingerprint.json 只记批级
 *   relDir（批目录与 summary 恒保留）→ 指纹复核仍一致，组已建则 evolve 重跑走幂等
 *   跳过；若组目录被删需重建，须先 tar 恢复再跑 evolve。
 *
 * 安全流程（每 pair）：
 * 1. tarball 不存在 → 打包到 `<tarball>.pack`（临时名）→ `tar -tzf` 列条目，与打包前
 *    逐文件清点做**集合相等**校验 → 不一致即删 .pack 抛错（不删任何原目录）→ rename
 *    为正式 tarball（正式名即 marker；写盘次序保证：存在正式 tarball ⇒ 它通过过校验）；
 * 2. tarball 已存在（崩溃恢复路径）→ `tar -tzf` 列条目，要求**现存**每个 game 明细
 *    文件都在条目中 → 逐 game-* 目录删除；有现存文件不在条目中 → 抛错不删；
 * 3. 删除只删 cell 下的 game-NNNN 目录；summary.json / summary.side1.json /
 *    plan.side0.json / portfolio.side0.json 等批级 JSON 恒保留（export 重跑、指纹
 *    复核、status、审计都还工作）；
 * 4. 归档不改 state.json（battle done 位图不变）：battle 重跑对 done 批 isDone 跳过、
 *    不会重跑已归档批（无 game 缺失冲突）；export 重跑只读 summary 也无冲突；
 * 5. 全程幂等：重跑为 no-op（已归档 pair 无 game 明细 → 跳过 no-games）或只补删；
 *    --dry-run 只打印将归档 pair 清单与预估体积，不写不删。
 *
 * 恢复口径：`tar -xzf <outRoot>/archive/round-<r>/<pairName>.tar.gz
 * -C <outRoot>/battles/<pairName>` 即可复原（打包含 pair 下全部文件原样）。
 *
 * 消费面核实（2026-09-05）：battles game-* 的程序内消费者仅 tournament-evidence
 * （evolve 证据组装，安全闸覆盖）与 tournament-export / evidence 指纹复核（只读
 * summary，恒保留）；aggregate-generations / organizer 消费的是各自 run 目录的
 * summary 侧产物，不读 battles game-*。plan:organize-export / plan:eval 等用户指路
 * 工具若指向已归档批目录，需先按恢复口径 tar 恢复。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import type { Dirent } from "node:fs"
import { mkdir, readdir, readlink, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { cellDirOf, pairDirOf, parseCellDir, playerIdOf } from "./tournament-config.js"

// ── 契约（与 model-tournament.ts 对齐）────────────────────────────────────

/** BatchSpec 结构子集（与 model-tournament.ts enumerateBatches 产物逐字段兼容） */
export interface ArchiveBatchSpec {
  round: number
  envLabel: string
  planModel: string
  planRound: number
  di: number
  oppModel: string
  oppRound: number
  dj: number
  isChain: boolean
}

/** battle state key——与 model-tournament.ts battleKey 逐字符同式（state v1 契约） */
export function battleKeyOf(spec: ArchiveBatchSpec): string {
  const pairName = pairDirOf(playerIdOf(spec.planModel, spec.planRound), playerIdOf(spec.oppModel, spec.oppRound))
  return `battle|r${spec.round}|${spec.envLabel}|${pairName}|${cellDirOf(spec.di, spec.dj)}`
}

/** evolve state key——与 model-tournament.ts cmdEvolve 的 key 逐字符同式 */
export function evolveKeyOf(model: string, envLabel: string, di: number, round: number): string {
  return `evolve|${model}|${envLabel}|${di}|r${round}`
}

export interface ArchiveOptions {
  /** outRoot（abs） */
  outRoot: string
  /** 代数上限（config.rounds）——安全闸判定 r+1 是否在赛程内 */
  rounds: number
  /** 全量赛程（所有代；由 model-tournament enumerateBatches(无 roundFilter) 提供） */
  specs: ReadonlyArray<ArchiveBatchSpec>
  isBattleDone: (key: string) => boolean
  isEvolveDone: (key: string) => boolean
  /** 归档截止代（--through N；含） */
  through: number
  /** 链批是否一并归档（--include-chain） */
  includeChain: boolean
  /** 只读演练：只打印清单与体积，不写不删 */
  dryRun: boolean
}

export interface ArchivePairCandidate {
  pairName: string
  round: number
  isChain: boolean
  /** pair 根目录（abs） */
  dir: string
  envLabels: string[]
  cells: Array<{ envLabel: string; di: number; dj: number }>
  /** game-NNNN 目录数（将删除） */
  gameDirs: number
  /** game 明细文件数（将删除） */
  gameFiles: number
  /** game 明细字节数（将删除） */
  gameBytes: number
  /** 打包内容（pair 下全部文件） */
  totalFiles: number
  totalBytes: number
  tarballPath: string
  /** tarball 已存在（true = 执行走崩溃恢复路径） */
  tarballExists: boolean
}

export type ArchiveSkipReason =
  | { kind: "chain-keep"; detail: string }
  | { kind: "battle-undone"; detail: string }
  | { kind: "evolve-pending"; detail: string }
  | { kind: "no-games"; detail: string }
  | { kind: "out-of-schedule"; detail: string }
  | { kind: "evidence-symlink"; detail: string }

export interface ArchiveSkipEntry {
  pairName: string
  round: number
  isChain: boolean
  reason: ArchiveSkipReason
  /** 跳过时该 pair 的 game 明细体积（0 = 未扫盘） */
  gameBytes: number
}

export interface ArchiveReport {
  dryRun: boolean
  through: number
  includeChain: boolean
  /** dry-run = 将归档清单；real = 已归档清单 */
  candidates: ArchivePairCandidate[]
  skips: ArchiveSkipEntry[]
  /** 热代 pair 数（round > through，不计入 skips） */
  hotPairs: number
  /** 实际释放字节（dry-run 恒 0） */
  freedBytes: number
  freedGameDirs: number
  /** tarball 总字节（dry-run 恒 0） */
  tarballBytes: number
}

// ── tar 工具（系统 tar；GNU tar / bsdtar 朴素用法两者兼容）───────────────

let tarAvailable = false

/** 首次调用校验 `tar --version` 可用；不可用抛错（调用方 fail-fast） */
function ensureTar(): void {
  if (tarAvailable) return
  const r = spawnSync("tar --version", { shell: true, encoding: "utf-8" })
  if (r.status !== 0 || r.error) {
    throw new Error("archive：系统 tar 不可用（`tar --version` 失败）——冷归档需要 tar 打包")
  }
  tarAvailable = true
}

/** tar 参数路径：反斜杠 → 正斜杠（Windows 下两种 tar 都接受），双引号包裹 */
function q(p: string): string {
  return `"${p.replace(/\\/g, "/")}"`
}

interface TarResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * tar 一律以 cwd（outRoot）+ 相对路径调用：GNU tar 对含盘符冒号（C:/…）的 -f 操作数
 * 会按远端 tape（host:file / user@host:file）解析而直接失败——相对路径无冒号，
 * GNU tar / bsdtar 行为一致。
 */
function runTar(args: string, cwd?: string): TarResult {
  const res = spawnSync(`tar ${args}`, {
    shell: true,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...(cwd !== undefined ? { cwd } : {}),
  })
  return { ok: res.status === 0 && !res.error, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

/** tar -t 条目 → 相对路径集合（剔目录项（尾部 /）、剥 "./" 前缀；GNU/bsdtar 一致） */
export function parseTarListing(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith("/"))
    .map((l) => (l.startsWith("./") ? l.slice(2) : l))
}

async function listTar(archivePath: string, what: string, cwd: string): Promise<string[]> {
  const t = runTar(`-tzf ${q(relTo(cwd, archivePath))}`, cwd)
  if (!t.ok) {
    throw new Error(
      `archive：tar 条目列表失败（${what}，${basename(archivePath)}）——tarball 可能损坏，请人工检查或删除后重跑：\n${tailLines(`${t.stderr}\n${t.stdout}`, 8)}`,
    )
  }
  return parseTarListing(t.stdout)
}

function tailLines(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n")
}

/** tar 子进程 cwd（outRoot）下的相对路径（"/" 分隔；避免盘符冒号触发 GNU tar 远端解析） */
function relTo(base: string, p: string): string {
  return relative(base, p).replace(/\\/g, "/")
}

// ── 文件系统扫描 ──────────────────────────────────────────────────────────

interface WalkedFile {
  /** pair 内相对路径（"/" 分隔——与 tar 条目口径一致） */
  rel: string
  size: number
}

/** 递归清点 regular 文件（symlink 等：battles 下预期不存在，不打包不删除） */
async function walkFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  async function rec(dir: string, rel: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        await rec(join(dir, e.name), childRel)
      } else if (e.isFile()) {
        let size = 0
        try {
          size = (await stat(join(dir, e.name))).size
        } catch {
          // 并发消失：按 0 计
        }
        out.push({ rel: childRel, size })
      }
    }
  }
  await rec(root, "")
  return out
}

const CELL_DIR_RE = /^\d+-vs-\d+$/
const GAME_DIR_RE = /^game-/

interface CellScan {
  envLabel: string
  di: number
  dj: number
  /** cell 目录（abs） */
  dir: string
  /** cell 下 game-* 目录名 */
  gameDirNames: string[]
}

interface PairScan {
  cells: CellScan[]
  /** pair 下全部文件（打包内容口径） */
  allFiles: WalkedFile[]
  /** game-* 目录下的文件（将删除口径） */
  gameFiles: WalkedFile[]
  gameDirs: number
}

async function scanPair(pairDir: string): Promise<PairScan> {
  const allFiles = await walkFiles(pairDir)
  const cells: CellScan[] = []
  let envEntries: Dirent[] = []
  try {
    envEntries = await readdir(pairDir, { withFileTypes: true })
  } catch {
    return { cells, allFiles, gameFiles: [], gameDirs: 0 }
  }
  for (const env of envEntries) {
    if (!env.isDirectory()) continue
    let cellEntries: Dirent[] = []
    try {
      cellEntries = await readdir(join(pairDir, env.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const cellEntry of cellEntries) {
      if (!cellEntry.isDirectory() || !CELL_DIR_RE.test(cellEntry.name)) continue
      const cell = parseCellDir(cellEntry.name)
      if (!cell) continue
      const cellDir = join(pairDir, env.name, cellEntry.name)
      let gameDirNames: string[] = []
      try {
        gameDirNames = (await readdir(cellDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && GAME_DIR_RE.test(e.name))
          .map((e) => e.name)
      } catch {
        continue
      }
      cells.push({ envLabel: env.name, di: cell.di, dj: cell.dj, dir: cellDir, gameDirNames })
    }
  }
  const gamePrefixes = new Set(
    cells.flatMap((c) => c.gameDirNames.map((g) => `${c.envLabel}/${cellDirOf(c.di, c.dj)}/${g}/`)),
  )
  const gameFiles = allFiles.filter((f) => {
    for (const p of gamePrefixes) {
      if (f.rel.startsWith(p)) return true
    }
    return false
  })
  return { cells, allFiles, gameFiles, gameDirs: cells.reduce((a, c) => a + c.gameDirNames.length, 0) }
}

// ── 冷判定 ────────────────────────────────────────────────────────────────

function groupSpecsByPair(specs: ReadonlyArray<ArchiveBatchSpec>): Map<string, ArchiveBatchSpec[]> {
  const byPair = new Map<string, ArchiveBatchSpec[]>()
  for (const s of specs) {
    const pairName = pairDirOf(playerIdOf(s.planModel, s.planRound), playerIdOf(s.oppModel, s.oppRound))
    const list = byPair.get(pairName)
    if (list) list.push(s)
    else byPair.set(pairName, [s])
  }
  return byPair
}

/**
 * 单批安全闸：返回未满足的 evolve 键描述（null = 通过）。
 * 消费关系（tournament-evidence.collectXBatches 的收集面）：evolve r+1 收集
 * X@r 持 di 的全部批——plan 侧（X@r__vs__*）与 opponent 侧（*__vs__X@r）双向；
 * 链批 X@r__vs__X@(r-1) 的同批 games 双向都收：X@r 持 di（喂 evolve r+1）、
 * X@(r-1) 持 dj 的 side1 视角（喂 evolve r）。
 */
function gateFailure(spec: ArchiveBatchSpec, isEvolveDone: (k: string) => boolean, rounds: number): string | null {
  if (spec.round + 1 <= rounds && !isEvolveDone(evolveKeyOf(spec.planModel, spec.envLabel, spec.di, spec.round + 1))) {
    return `evolve|${spec.planModel}|${spec.envLabel}|${spec.di}|r${spec.round + 1} 未 done（plan 侧证据仍会消费）`
  }
  if (spec.isChain) {
    if (!isEvolveDone(evolveKeyOf(spec.oppModel, spec.envLabel, spec.dj, spec.round))) {
      return `evolve|${spec.oppModel}|${spec.envLabel}|${spec.dj}|r${spec.round} 未 done（链批 opponent 侧证据仍会消费）`
    }
  } else if (
    spec.round + 1 <= rounds
    && !isEvolveDone(evolveKeyOf(spec.oppModel, spec.envLabel, spec.dj, spec.round + 1))
  ) {
    return `evolve|${spec.oppModel}|${spec.envLabel}|${spec.dj}|r${spec.round + 1} 未 done（opponent 侧证据仍会消费）`
  }
  return null
}

/**
 * evidence 全树符号链接扫描：返回解析后落在 battles/ 下的绝对目标路径列表。
 * linkOrCopy 在有符号链接特权（如 Windows 开发者模式 / Linux）的环境会优先落
 * symlink——其目标是 battles 原文件的绝对路径，删除原文件会打断链接。
 */
async function collectEvidenceSymlinksIntoBattles(outRoot: string): Promise<string[]> {
  const evidenceRoot = join(outRoot, "evidence")
  if (!existsSync(evidenceRoot)) return []
  const targets: string[] = []
  async function rec(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        try {
          targets.push(resolve(dir, await readlink(p)))
        } catch {
          // 读取失败：保守忽略（后续逐 pair 判定不覆盖它）
        }
      } else if (e.isDirectory()) {
        await rec(p)
      }
    }
  }
  await rec(evidenceRoot)
  const battlesRoot = join(outRoot, "battles")
  // 统一分隔符到 "\\" 再比前缀（Windows resolve/join 产 "\\"；Linux 恒 "/" → "\\" 无害）
  const norm = (p: string): string => `${p.replace(/\//g, "\\").replace(/\\+$/, "")}\\`
  const battlesPrefix = norm(battlesRoot)
  return targets.filter((t) => norm(t).startsWith(battlesPrefix))
}

function humanizeBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

// ── 执行（打包 → 校验 → 删除）────────────────────────────────────────────

interface ArchivePairResult {
  freedBytes: number
  freedGameDirs: number
  tarballBytes: number
  /** true = 走崩溃恢复路径（tarball 已存在） */
  recovered: boolean
}

async function archiveOnePair(c: ArchivePairCandidate, outRoot: string): Promise<ArchivePairResult> {
  ensureTar()
  const finalPath = c.tarballPath
  const tmpPath = `${finalPath}.pack`
  const scan = await scanPair(c.dir) // 执行时重扫（以执行时磁盘为准）
  let recovered = false
  if (existsSync(finalPath)) {
    // 崩溃恢复：正式 tarball 创建时已过全量校验；这里只要求"现存 game 明细 ⊆ 条目"
    recovered = true
    const listed = new Set(await listTar(finalPath, c.pairName, outRoot))
    const missing = scan.gameFiles.filter((f) => !listed.has(f.rel))
    if (missing.length > 0) {
      throw new Error(
        `archive：tarball 缺少现存 game 明细（${c.pairName}）：${missing[0]!.rel} 等 ${missing.length} 个——中止，未删除任何目录`,
      )
    }
  } else {
    if (scan.gameFiles.length === 0) {
      return { freedBytes: 0, freedGameDirs: 0, tarballBytes: 0, recovered: false } // planning 与执行之间被并发清理：no-op
    }
    await mkdir(dirname(finalPath), { recursive: true })
    await rm(tmpPath, { force: true })
    const t = runTar(`-czf ${q(relTo(outRoot, tmpPath))} -C ${q(relTo(outRoot, c.dir))} .`, outRoot)
    if (!t.ok) {
      await rm(tmpPath, { force: true })
      throw new Error(`archive：tar 打包失败（${c.pairName}）：\n${tailLines(`${t.stderr}\n${t.stdout}`, 8)}`)
    }
    // 集合相等校验：打包前逐文件清点 vs tar 实际条目（-tzf 另列一次；不一致即中止，绝不删除）
    const listed = await listTar(tmpPath, c.pairName, outRoot)
    const expected = scan.allFiles.map((f) => f.rel)
    const listedSet = new Set(listed)
    const expectedSet = new Set(expected)
    const lost = expected.filter((r) => !listedSet.has(r))
    const extra = listed.filter((r) => !expectedSet.has(r))
    if (lost.length > 0 || extra.length > 0 || listed.length !== expected.length) {
      await rm(tmpPath, { force: true })
      throw new Error(
        `archive：tarball 条目校验不一致（${c.pairName}）：打包前 ${expected.length} 文件，tar 列出 ${listed.length} 条`
        + `（缺失例 ${lost.slice(0, 3).join(", ") || "无"}；多余例 ${extra.slice(0, 3).join(", ") || "无"}）——已中止，未删除任何原目录`,
      )
    }
    await rename(tmpPath, finalPath)
  }
  // 删除：只删 cell 下 game-NNNN 目录（summary/plan/portfolio 等批级 JSON 恒保留）
  let freedBytes = 0
  let freedGameDirs = 0
  for (const cell of scan.cells) {
    for (const g of cell.gameDirNames) {
      await rm(join(cell.dir, g), { recursive: true, force: true })
      freedGameDirs++
    }
  }
  freedBytes = scan.gameFiles.reduce((a, f) => a + f.size, 0)
  const tarballBytes = (await stat(finalPath)).size
  console.log(
    `[archive] ${c.pairName}：${recovered ? "tarball 已存在（恢复路径，覆盖校验通过）" : "打包校验通过"} → 删除 ${freedGameDirs} 个 game 目录（${humanizeBytes(freedBytes)}）`,
  )
  return { freedBytes, freedGameDirs, tarballBytes, recovered }
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export async function archiveColdRounds(opts: ArchiveOptions): Promise<ArchiveReport> {
  console.log(
    `[archive] through=r${opts.through}（includeChain=${opts.includeChain}，${opts.dryRun ? "dry-run" : "执行"}；rounds=${opts.rounds}）`,
  )
  const byPair = groupSpecsByPair(opts.specs)
  const symlinkTargets = await collectEvidenceSymlinksIntoBattles(opts.outRoot)
  const candidates: ArchivePairCandidate[] = []
  const skips: ArchiveSkipEntry[] = []
  let hotPairs = 0

  const pairNames = [...byPair.keys()].sort()
  for (const pairName of pairNames) {
    const specs = byPair.get(pairName)!
    const round = specs[0]!.round
    const isChain = specs.some((s) => s.isChain)
    if (round > opts.through) {
      hotPairs++
      continue
    }
    if (isChain && !opts.includeChain) {
      skips.push({
        pairName, round, isChain,
        reason: { kind: "chain-keep", detail: "链批默认保留（ownChain=keep；--include-chain 才归档）" },
        gameBytes: 0,
      })
      continue
    }
    // battle 完成判定（pair 内任一 cell 未 done → 整 pair 跳过）
    const undone = specs.filter((s) => !opts.isBattleDone(battleKeyOf(s)))
    if (undone.length > 0) {
      skips.push({
        pairName, round, isChain,
        reason: { kind: "battle-undone", detail: `${undone.length}/${specs.length} 批未完成（如 ${battleKeyOf(undone[0]!)}）` },
        gameBytes: 0,
      })
      continue
    }
    // 安全闸：上游 evolve 未 done → 第 r 代 games 仍可能被消费
    const gated = specs.map((s) => gateFailure(s, opts.isEvolveDone, opts.rounds)).find((x) => x !== null)
    if (gated !== undefined && gated !== null) {
      skips.push({ pairName, round, isChain, reason: { kind: "evolve-pending", detail: gated }, gameBytes: 0 })
      continue
    }
    // 磁盘扫描
    const pairDir = join(opts.outRoot, "battles", pairName)
    if (!existsSync(pairDir)) {
      skips.push({
        pairName, round, isChain,
        reason: { kind: "no-games", detail: "battles 下无此 pair 目录" },
        gameBytes: 0,
      })
      continue
    }
    const scan = await scanPair(pairDir)
    const scheduledCells = new Set(specs.map((s) => `${s.envLabel}/${cellDirOf(s.di, s.dj)}`))
    const stray = scan.cells
      .map((c) => `${c.envLabel}/${cellDirOf(c.di, c.dj)}`)
      .filter((k) => !scheduledCells.has(k))
    if (stray.length > 0) {
      skips.push({
        pairName, round, isChain,
        reason: { kind: "out-of-schedule", detail: `赛程外 cell：${stray.slice(0, 3).join("、")}` },
        gameBytes: 0,
      })
      continue
    }
    const gameBytes = scan.gameFiles.reduce((a, f) => a + f.size, 0)
    if (scan.gameFiles.length === 0) {
      skips.push({
        pairName, round, isChain,
        reason: { kind: "no-games", detail: "无 game-* 明细（已归档或无产物）" },
        gameBytes: 0,
      })
      continue
    }
    if (symlinkTargets.length > 0) {
      const pairPrefix = pairDir.replace(/[\\/]+$/, "")
      const hit = symlinkTargets.find((t) => t.startsWith(pairPrefix + "\\") || t.startsWith(pairPrefix + "/"))
      if (hit !== undefined) {
        skips.push({
          pairName, round, isChain,
          reason: { kind: "evidence-symlink", detail: `evidence 存在符号链接指向本 pair（${hit}）——删除原文件会打断链接` },
          gameBytes,
        })
        continue
      }
    }
    candidates.push({
      pairName,
      round,
      isChain,
      dir: pairDir,
      envLabels: [...new Set(scan.cells.map((c) => c.envLabel))].sort(),
      cells: scan.cells.map((c) => ({ envLabel: c.envLabel, di: c.di, dj: c.dj })),
      gameDirs: scan.gameDirs,
      gameFiles: scan.gameFiles.length,
      gameBytes,
      totalFiles: scan.allFiles.length,
      totalBytes: scan.allFiles.reduce((a, f) => a + f.size, 0),
      tarballPath: join(opts.outRoot, "archive", `round-${round}`, `${pairName}.tar.gz`),
      tarballExists: existsSync(join(opts.outRoot, "archive", `round-${round}`, `${pairName}.tar.gz`)),
    })
  }

  const report: ArchiveReport = {
    dryRun: opts.dryRun,
    through: opts.through,
    includeChain: opts.includeChain,
    candidates,
    skips,
    hotPairs,
    freedBytes: 0,
    freedGameDirs: 0,
    tarballBytes: 0,
  }

  if (opts.dryRun) {
    for (const c of candidates) {
      const tailNote = c.tarballExists ? "（tarball 已存在——恢复路径：校验后补删）" : ""
      console.log(
        `[archive] 将归档 ${c.pairName}（r${c.round}，${c.cells.length} cell / ${c.gameDirs} game 明细 ${humanizeBytes(c.gameBytes)}；打包 ${c.totalFiles} 文件 ${humanizeBytes(c.totalBytes)}）→ ${c.tarballPath}${tailNote}`,
      )
    }
    console.log("[archive] dry-run：未写入未删除")
  } else if (candidates.length > 0) {
    ensureTar()
    for (const c of candidates) {
      const r = await archiveOnePair(c, opts.outRoot)
      report.freedBytes += r.freedBytes
      report.freedGameDirs += r.freedGameDirs
      report.tarballBytes += r.tarballBytes
    }
  }

  const reasonCount = (kind: ArchiveSkipReason["kind"]): number => skips.filter((s) => s.reason.kind === kind).length
  for (const s of skips) {
    console.log(`[archive] 跳过 ${s.pairName}（r${s.round}${s.isChain ? "，链批" : ""}）：[${s.reason.kind}] ${s.reason.detail}`)
  }
  if (opts.dryRun) {
    console.log(
      `[archive] dry-run 汇总：将归档 ${candidates.length} pair（${humanizeBytes(candidates.reduce((a, c) => a + c.gameBytes, 0))} game 明细）；`
      + `跳过 ${skips.length}（链批 ${reasonCount("chain-keep")} / evolve 未 done ${reasonCount("evolve-pending")} / battle 未完成 ${reasonCount("battle-undone")}`
      + ` / 无明细 ${reasonCount("no-games")} / 赛程外 ${reasonCount("out-of-schedule")} / evidence 符号链接 ${reasonCount("evidence-symlink")}）；热代 pair ${hotPairs} 个`,
    )
  } else {
    console.log(
      `[archive] 完成：归档 ${candidates.length} pair（释放 ${humanizeBytes(report.freedBytes)}，tarball ${humanizeBytes(report.tarballBytes)}）；`
      + `跳过 ${skips.length}（链批 ${reasonCount("chain-keep")} / evolve 未 done ${reasonCount("evolve-pending")} / battle 未完成 ${reasonCount("battle-undone")}`
      + ` / 无明细 ${reasonCount("no-games")} / 赛程外 ${reasonCount("out-of-schedule")} / evidence 符号链接 ${reasonCount("evidence-symlink")}）；热代 pair ${hotPairs} 个`,
    )
    if (candidates.length > 0) {
      console.log("[archive] 恢复口径：tar -xzf <outRoot>/archive/round-<r>/<pairName>.tar.gz -C <outRoot>/battles/<pairName>")
    }
  }
  return report
}

// ── status 辅助 ───────────────────────────────────────────────────────────

/** 统计已归档 pair tarball 数（archive/round-N/ 下 .tar.gz 文件；.pack 临时文件不计） */
export async function countArchivedTarballs(
  outRoot: string,
): Promise<{ total: number; byRound: Array<{ round: number; count: number }> }> {
  const archiveRoot = join(outRoot, "archive")
  if (!existsSync(archiveRoot)) return { total: 0, byRound: [] }
  let total = 0
  const byRound: Array<{ round: number; count: number }> = []
  let entries: Dirent[] = []
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true })
  } catch {
    return { total: 0, byRound: [] }
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^round-\d+$/.test(e.name)) continue
    let files: string[] = []
    try {
      files = await readdir(join(archiveRoot, e.name))
    } catch {
      continue
    }
    const count = files.filter((f) => f.endsWith(".tar.gz")).length
    if (count > 0) byRound.push({ round: Number(e.name.slice("round-".length)), count })
    total += count
  }
  byRound.sort((a, b) => a.round - b.round)
  return { total, byRound }
}
