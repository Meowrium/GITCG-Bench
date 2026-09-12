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
 * tournament-archive 离线单测（impl-spec-1 §4.6）：冷判定 / 安全闸 / 链批策略、
 * tar 打包校验与删除、崩溃恢复、幂等重跑、真实 tar round-trip 哈希。
 * 全部离线零 LLM 零引擎；tar 相关用例在系统 tar 不可用时跳过。
 */

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import {
  archiveColdRounds,
  battleKeyOf,
  countArchivedTarballs,
  evolveKeyOf,
  type ArchiveBatchSpec,
  type ArchiveOptions,
} from "./tournament-archive.js"
import { cellDirOf, pairDirOf, playerIdOf } from "./tournament-config.js"

// ── fixture 约定 ──────────────────────────────────────────────────────────

const ENV = "v6.3"
const MODELS = ["alpha", "beta"]
const D = 2 // 每环境卡组数（di/dj ∈ {0,1}）
const ROUNDS = 2
const ALL_CELLS: Array<[number, number]> = [[0, 0], [0, 1], [1, 0], [1, 1]]

/** 复刻 model-tournament enumerateBatches（rounds=2，单环境，2 模型）的全量赛程 */
function allSpecs(): ArchiveBatchSpec[] {
  const specs: ArchiveBatchSpec[] = []
  const specOf = (
    round: number, planModel: string, planRound: number, di: number,
    oppModel: string, oppRound: number, dj: number, isChain: boolean,
  ): ArchiveBatchSpec => ({ round, envLabel: ENV, planModel, planRound, di, oppModel, oppRound, dj, isChain })
  for (let r = 0; r <= ROUNDS; r++) {
    for (const X of MODELS) {
      for (const Y of MODELS) {
        if (X === Y) continue
        for (let di = 0; di < D; di++) {
          for (let dj = 0; dj < D; dj++) specs.push(specOf(r, X, r, di, Y, r, dj, false))
        }
      }
    }
    if (r >= 1) {
      for (const X of MODELS) {
        for (let di = 0; di < D; di++) {
          for (let dj = 0; dj < D; dj++) specs.push(specOf(r, X, r, di, X, r - 1, dj, true))
        }
      }
    }
  }
  return specs
}

const crossPair = (a: string, b: string, r: number): string => pairDirOf(playerIdOf(a, r), playerIdOf(b, r))
const chainPair = (a: string, r: number): string => pairDirOf(playerIdOf(a, r), playerIdOf(a, r - 1))

function pairNameOf(s: ArchiveBatchSpec): string {
  return pairDirOf(playerIdOf(s.planModel, s.planRound), playerIdOf(s.oppModel, s.oppRound))
}

function battleKeysFor(pairName: string, cells: Array<[number, number]> = ALL_CELLS): string[] {
  return allSpecs()
    .filter((s) => pairNameOf(s) === pairName && cells.some(([di, dj]) => s.di === di && s.dj === dj))
    .map(battleKeyOf)
}

function evolveKeys(models: Array<[string, number]>, round: number): string[] {
  return models.map(([m, di]) => evolveKeyOf(m, ENV, di, round))
}

/** 两个跨模型 round-0 pair（互为对手位）的安全闸键：r1 全模型全卡组 */
const R1_GATE_KEYS = evolveKeys([["alpha", 0], ["alpha", 1], ["beta", 0], ["beta", 1]], 1)

/** 写一个批 cell：game 明细 + 批级 JSON（恒保留物） */
async function writeBatch(battlesRoot: string, pairName: string, cell: string, games = 2): Promise<string> {
  const dir = join(battlesRoot, pairName, ENV, cell)
  for (let i = 1; i <= games; i++) {
    const g = `game-${String(i).padStart(4, "0")}`
    await mkdir(join(dir, g), { recursive: true })
    await writeFile(join(dir, g, "plan_trace.json"), JSON.stringify({ pair: pairName, cell, game: g, kind: "trace" }), "utf-8")
    await writeFile(join(dir, g, "game_state_log.json"), JSON.stringify({ pair: pairName, cell, game: g, kind: "log" }), "utf-8")
    await writeFile(join(dir, g, "plan_trace.side1.json"), JSON.stringify({ pair: pairName, cell, game: g, kind: "side1" }), "utf-8")
  }
  await writeFile(join(dir, "summary.json"), JSON.stringify({ games, perGame: [] }), "utf-8")
  await writeFile(join(dir, "summary.side1.json"), JSON.stringify({ games, perGame: [] }), "utf-8")
  await writeFile(join(dir, "plan.side0.json"), "{}\n", "utf-8")
  await writeFile(join(dir, "portfolio.side0.json"), "{}\n", "utf-8")
  return dir
}

async function seedPair(
  battlesRoot: string,
  pairName: string,
  opts: { cells?: Array<[number, number]>; games?: number } = {},
): Promise<void> {
  for (const [di, dj] of opts.cells ?? ALL_CELLS) {
    await writeBatch(battlesRoot, pairName, cellDirOf(di, dj), opts.games)
  }
}

function makeOpts(
  outRoot: string,
  done: string[],
  over: Partial<ArchiveOptions> = {},
): ArchiveOptions {
  const set = new Set(done)
  return {
    outRoot,
    rounds: ROUNDS,
    specs: allSpecs(),
    isBattleDone: (k) => set.has(k),
    isEvolveDone: (k) => set.has(k),
    through: 1,
    includeChain: false,
    dryRun: true,
    ...over,
  }
}

async function hashTree(rootDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  async function rec(dir: string, rel: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`
      const p = join(dir, e.name)
      if (e.isDirectory()) await rec(p, childRel)
      else out.set(childRel, createHash("sha256").update(await readFile(p)).digest("hex"))
    }
  }
  await rec(rootDir, "")
  return out
}

function q(p: string): string {
  return `"${p.replace(/\\/g, "/")}"`
}

/** 与被测模块同口径：tar 以 cwd + 相对路径调用（避免盘符冒号触发 GNU tar 远端解析） */
function runTar(args: string, cwd: string): number {
  const r = spawnSync(`tar ${args}`, { shell: true, encoding: "utf-8", cwd })
  return r.status
}

function relTo(base: string, p: string): string {
  return relative(base, p).replace(/\\/g, "/")
}

async function countGameDirs(pairDir: string): Promise<number> {
  let n = 0
  for (const env of await readdir(pairDir, { withFileTypes: true })) {
    if (!env.isDirectory()) continue
    for (const cell of await readdir(join(pairDir, env.name), { withFileTypes: true })) {
      if (!cell.isDirectory()) continue
      n += (await readdir(join(pairDir, env.name, cell.name), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith("game-")).length
    }
  }
  return n
}

/** 系统是否可用符号链接（Windows 无开发者模式时 symlink EPERM） */
const symlinkSupported = await (async (): Promise<boolean> => {
  try {
    const d = await mkdtemp(join(tmpdir(), "symprobe-"))
    await symlink(join(d, "target"), join(d, "link"))
    await rm(d, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
})()

const tarSupported = runTar("--version", process.cwd()) === 0

// ── 用例 ──────────────────────────────────────────────────────────────────

describe("tournament-archive key 契约", () => {
  it("battleKeyOf 与 model-tournament battleKey/state v1 格式逐字符一致", () => {
    expect(
      battleKeyOf({ round: 1, envLabel: "v6.3", planModel: "alpha", planRound: 1, di: 0, oppModel: "beta", oppRound: 1, dj: 1, isChain: false }),
    ).toBe("battle|r1|v6.3|alpha@r1__vs__beta@r1|0-vs-1")
    expect(
      battleKeyOf({ round: 1, envLabel: "v6.3", planModel: "alpha", planRound: 1, di: 0, oppModel: "alpha", oppRound: 0, dj: 1, isChain: true }),
    ).toBe("battle|r1|v6.3|alpha@r1__vs__alpha@r0|0-vs-1")
  })

  it("evolveKeyOf 与 cmdEvolve 的 key 格式一致", () => {
    expect(evolveKeyOf("alpha", "v6.3", 0, 2)).toBe("evolve|alpha|v6.3|0|r2")
  })
})

describe("tournament-archive 冷判定（dry-run）", () => {
  it("候选/跳过分类：跨模型 done 入候选，链批/未 done/闸未过/热代各归各类；dry-run 零写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-plan-"))
    const battles = join(root, "battles")
    await seedPair(battles, crossPair("alpha", "beta", 0)) // P1 候选
    await seedPair(battles, crossPair("beta", "alpha", 0)) // P2 候选
    await seedPair(battles, chainPair("alpha", 1)) // P3 链批 → chain-keep
    // P4 链批（无目录）→ chain-keep（策略判定先于磁盘）
    // P5 round-1 跨模型，缺 0-vs-0 批 → battle-undone
    await seedPair(battles, crossPair("alpha", "beta", 1), { cells: [[0, 1], [1, 0], [1, 1]] })
    // P6 round-1 跨模型（无目录、battle 全 done）→ evolve-pending（beta|0|r2 未 done）
    // P7 round-2 pair（有目录）→ 热代
    await seedPair(battles, crossPair("alpha", "beta", 2))

    const done = [
      ...battleKeysFor(crossPair("alpha", "beta", 0)),
      ...battleKeysFor(crossPair("beta", "alpha", 0)),
      ...battleKeysFor(chainPair("alpha", 1)),
      ...battleKeysFor(crossPair("alpha", "beta", 1), [[0, 1], [1, 0], [1, 1]]),
      ...battleKeysFor(crossPair("beta", "alpha", 1)),
      ...battleKeysFor(crossPair("alpha", "beta", 2)),
      ...R1_GATE_KEYS,
      ...evolveKeys([["alpha", 0], ["alpha", 1]], 2),
    ]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: true }))

    expect(report.candidates.map((c) => c.pairName).sort())
      .toEqual([crossPair("alpha", "beta", 0), crossPair("beta", "alpha", 0)].sort())
    const reasonOf = (p: string): string => report.skips.find((s) => s.pairName === p)?.reason.kind ?? "missing"
    expect(reasonOf(chainPair("alpha", 1))).toBe("chain-keep")
    expect(reasonOf(chainPair("beta", 1))).toBe("chain-keep")
    expect(reasonOf(crossPair("alpha", "beta", 1))).toBe("battle-undone")
    expect(reasonOf(crossPair("beta", "alpha", 1))).toBe("evolve-pending")
    expect(report.hotPairs).toBe(4) // round-2：2 跨模型 + 2 链批
    expect(report.candidates.every((c) => c.gameDirs === 8 && c.gameFiles === 24)).toBe(true) // 4 cell × 2 game × 3 文件
    // dry-run 零写入
    expect(existsSync(join(root, "archive"))).toBe(false)
    expect(await countGameDirs(join(battles, crossPair("alpha", "beta", 0)))).toBe(8)
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  it("赛程外 cell → 整 pair 跳过（out-of-schedule）", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-stray-"))
    const battles = join(root, "battles")
    await seedPair(battles, crossPair("alpha", "beta", 0))
    await mkdir(join(battles, crossPair("alpha", "beta", 0), ENV, "5-vs-5", "game-0001"), { recursive: true })
    const done = [...battleKeysFor(crossPair("alpha", "beta", 0)), ...R1_GATE_KEYS]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    expect(report.candidates).toHaveLength(0)
    expect(report.skips[0]?.reason.kind).toBe("out-of-schedule")
    expect(existsSync(join(root, "archive"))).toBe(false)
    // 8 个赛程内 game 目录 + 1 个赛程外 stray game 目录，全部原样
    expect(await countGameDirs(join(battles, crossPair("alpha", "beta", 0)))).toBe(9)
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  it.runIf(symlinkSupported)("evidence 符号链接守卫：指向本 pair 的 symlink → 跳过不删", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-symlink-"))
    const battles = join(root, "battles")
    const pairName = crossPair("alpha", "beta", 0)
    await seedPair(battles, pairName)
    await mkdir(join(root, "evidence", "alpha", "v6.3", "0", "r1", "vs-1"), { recursive: true })
    await symlink(
      join(battles, pairName, ENV, "0-vs-1", "game-0001", "plan_trace.json"),
      join(root, "evidence", "alpha", "v6.3", "0", "r1", "vs-1", "plan_trace.json"),
    )
    const done = [...battleKeysFor(pairName), ...R1_GATE_KEYS]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    expect(report.candidates).toHaveLength(0)
    expect(report.skips[0]?.reason.kind).toBe("evidence-symlink")
    expect(await countGameDirs(join(battles, pairName))).toBe(8)
    await rm(root, { recursive: true, force: true })
  }, 30_000)
})

describe.runIf(tarSupported)("tournament-archive 执行（真实 tar）", () => {
  it("真跑：tarball 生成、game-* 删除、批级 JSON 恒保留、未候选 pair 不动", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-run-"))
    const battles = join(root, "battles")
    await seedPair(battles, crossPair("alpha", "beta", 0))
    await seedPair(battles, crossPair("beta", "alpha", 0))
    await seedPair(battles, chainPair("alpha", 1))
    await seedPair(battles, crossPair("alpha", "beta", 1), { cells: [[0, 1], [1, 0], [1, 1]] })
    const done = [
      ...battleKeysFor(crossPair("alpha", "beta", 0)),
      ...battleKeysFor(crossPair("beta", "alpha", 0)),
      ...battleKeysFor(chainPair("alpha", 1)),
      ...battleKeysFor(crossPair("alpha", "beta", 1), [[0, 1], [1, 0], [1, 1]]),
      ...R1_GATE_KEYS,
    ]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false }))

    expect(report.candidates).toHaveLength(2)
    expect(report.freedGameDirs).toBe(16)
    expect(report.freedBytes).toBeGreaterThan(0)
    for (const p of [crossPair("alpha", "beta", 0), crossPair("beta", "alpha", 0)]) {
      const pairDir = join(battles, p)
      const tarball = join(root, "archive", "round-0", `${p}.tar.gz`)
      expect(existsSync(tarball)).toBe(true)
      expect(existsSync(`${tarball}.pack`)).toBe(false) // 临时名不残留
      expect(await countGameDirs(pairDir)).toBe(0)
      // 批级 JSON 恒保留
      for (const cell of ALL_CELLS) {
        const cellDir = join(pairDir, ENV, cellDirOf(cell[0], cell[1]))
        for (const f of ["summary.json", "summary.side1.json", "plan.side0.json", "portfolio.side0.json"]) {
          await expect(readFile(join(cellDir, f), "utf-8")).resolves.toBeDefined()
        }
      }
    }
    // 未候选 pair 不动
    expect(await countGameDirs(join(battles, chainPair("alpha", 1)))).toBe(8)
    expect(await countGameDirs(join(battles, crossPair("alpha", "beta", 1)))).toBe(6)
    const archived = await countArchivedTarballs(root)
    expect(archived.total).toBe(2)
    expect(archived.byRound).toEqual([{ round: 0, count: 2 }])
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  it("round-trip：tarball 解包与打包前逐文件 sha256 一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-hash-"))
    const battles = join(root, "battles")
    const pairName = crossPair("alpha", "beta", 0)
    const pairDir = join(battles, pairName)
    await seedPair(battles, pairName)
    const before = await hashTree(pairDir)
    const done = [...battleKeysFor(pairName), ...R1_GATE_KEYS]
    await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    const tarball = join(root, "archive", "round-0", `${pairName}.tar.gz`)
    expect(existsSync(tarball)).toBe(true)
    // tarball 条目数 = 打包前文件数
    const listing = spawnSync(`tar -tzf ${q(relTo(root, tarball))}`, { shell: true, encoding: "utf-8", cwd: root })
    expect(listing.status).toBe(0)
    const fileEntries = listing.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().endsWith("/"))
    expect(fileEntries.length).toBe(before.size)
    // 解包后逐文件哈希一致
    const ext = join(root, "restore-test")
    await mkdir(ext, { recursive: true })
    expect(runTar(`-xzf ${q(relTo(root, tarball))} -C ${q(relTo(root, ext))}`, root)).toBe(0)
    const after = await hashTree(ext)
    expect(after.size).toBe(before.size)
    for (const [rel, hash] of before) {
      expect(after.get(rel)).toBe(hash)
    }
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  it("幂等重跑：no-op（无新归档、tarball 不变、无异常）", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-rerun-"))
    const battles = join(root, "battles")
    const pairName = crossPair("alpha", "beta", 0)
    await seedPair(battles, pairName)
    const done = [...battleKeysFor(pairName), ...R1_GATE_KEYS]
    await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    const tarball = join(root, "archive", "round-0", `${pairName}.tar.gz`)
    const sizeBefore = (await stat(tarball)).size
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    expect(report.candidates).toHaveLength(0)
    expect(report.skips.find((s) => s.pairName === pairName)?.reason.kind).toBe("no-games")
    expect(report.freedGameDirs).toBe(0)
    expect((await stat(tarball)).size).toBe(sizeBefore)
    expect(await countGameDirs(join(battles, pairName))).toBe(0)
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  it("--include-chain：闸全过的链批归档，闸未过的链批仍跳过；缺省链批恒保留", async () => {
    // alpha 链批闸全过（alpha r2 evolve done）；beta 链批 plan 侧 beta|0|r2 未 done
    const root = await mkdtemp(join(tmpdir(), "archive-chain-"))
    const battles = join(root, "battles")
    const chainAlpha = chainPair("alpha", 1)
    const chainBeta = chainPair("beta", 1)
    await seedPair(battles, chainAlpha)
    await seedPair(battles, chainBeta)
    const done = [
      ...battleKeysFor(chainAlpha),
      ...battleKeysFor(chainBeta),
      ...evolveKeys([["alpha", 0], ["alpha", 1], ["beta", 0], ["beta", 1]], 1), // 链批 opponent 侧闸（r1）
      ...evolveKeys([["alpha", 0], ["alpha", 1]], 2), // alpha 链批 plan 侧闸（r2）
    ]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false, includeChain: true, through: 1 }))
    expect(report.candidates.map((c) => c.pairName)).toEqual([chainAlpha])
    expect(report.skips.find((s) => s.pairName === chainBeta)?.reason.kind).toBe("evolve-pending")
    expect(existsSync(join(root, "archive", "round-1", `${chainAlpha}.tar.gz`))).toBe(true)
    expect(await countGameDirs(join(battles, chainAlpha))).toBe(0)
    expect(await countGameDirs(join(battles, chainBeta))).toBe(8)
    await rm(root, { recursive: true, force: true })

    // 缺省（includeChain=false）：同 fixture 链批恒保留
    const root2 = await mkdtemp(join(tmpdir(), "archive-chain2-"))
    const battles2 = join(root2, "battles")
    await seedPair(battles2, chainAlpha)
    const done2 = [...battleKeysFor(chainAlpha), ...evolveKeys([["alpha", 0], ["alpha", 1]], 1), ...evolveKeys([["alpha", 0], ["alpha", 1]], 2)]
    const report2 = await archiveColdRounds(makeOpts(root2, done2, { dryRun: false }))
    expect(report2.candidates).toHaveLength(0)
    expect(report2.skips.find((s) => s.pairName === chainAlpha)?.reason.kind).toBe("chain-keep")
    expect(existsSync(join(root2, "archive"))).toBe(false)
    expect(await countGameDirs(join(battles2, chainAlpha))).toBe(8)
    await rm(root2, { recursive: true, force: true })
  }, 60_000)

  it("安全闸解锁：evolve 补 done 后重跑即归档", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-gate-"))
    const battles = join(root, "battles")
    const pairName = crossPair("beta", "alpha", 1)
    await seedPair(battles, pairName)
    const battleDone = battleKeysFor(pairName)
    // 首跑：beta|0|r2 / beta|1|r2 未 done → evolve-pending
    const donePartial = [...battleDone, ...evolveKeys([["alpha", 0], ["alpha", 1]], 2)]
    const report1 = await archiveColdRounds(makeOpts(root, donePartial, { dryRun: false, through: 1 }))
    expect(report1.candidates).toHaveLength(0)
    expect(report1.skips.find((s) => s.pairName === pairName)?.reason.kind).toBe("evolve-pending")
    expect(existsSync(join(root, "archive"))).toBe(false)
    // 解锁：补 beta r2 evolve done → 归档
    const doneFull = [...donePartial, ...evolveKeys([["beta", 0], ["beta", 1]], 2)]
    const report2 = await archiveColdRounds(makeOpts(root, doneFull, { dryRun: false, through: 1 }))
    expect(report2.candidates.map((c) => c.pairName)).toEqual([pairName])
    expect(await countGameDirs(join(battles, pairName))).toBe(0)
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  it("崩溃恢复：tarball 已存在且覆盖现存明细 → 补删剩余；垃圾 tarball → 中止不删", async () => {
    // a) 中途崩溃：手工造 tarball（全量）→ 删 1 个 game 目录 → 重跑补删其余
    const root = await mkdtemp(join(tmpdir(), "archive-crash-"))
    const battles = join(root, "battles")
    const pairName = crossPair("alpha", "beta", 0)
    const pairDir = join(battles, pairName)
    await seedPair(battles, pairName)
    const tarball = join(root, "archive", "round-0", `${pairName}.tar.gz`)
    await mkdir(join(root, "archive", "round-0"), { recursive: true })
    expect(runTar(`-czf ${q(relTo(root, tarball))} -C ${q(relTo(root, pairDir))} .`, root)).toBe(0)
    await rm(join(pairDir, ENV, "0-vs-0", "game-0001"), { recursive: true, force: true })
    const done = [...battleKeysFor(pairName), ...R1_GATE_KEYS]
    const report = await archiveColdRounds(makeOpts(root, done, { dryRun: false }))
    expect(report.candidates).toHaveLength(1)
    expect(report.freedGameDirs).toBe(7) // 剩余 7 个补删
    expect(await countGameDirs(pairDir)).toBe(0)
    expect(existsSync(tarball)).toBe(true)
    await rm(root, { recursive: true, force: true })

    // b) 垃圾 tarball：校验失败 → 抛错、原目录一个不删
    const root2 = await mkdtemp(join(tmpdir(), "archive-bad-"))
    const battles2 = join(root2, "battles")
    await seedPair(battles2, pairName)
    const tarball2 = join(root2, "archive", "round-0", `${pairName}.tar.gz`)
    await mkdir(join(root2, "archive", "round-0"), { recursive: true })
    await writeFile(tarball2, "this-is-not-a-tarball", "utf-8")
    const done2 = [...battleKeysFor(pairName), ...R1_GATE_KEYS]
    await expect(archiveColdRounds(makeOpts(root2, done2, { dryRun: false }))).rejects.toThrow(/tar 条目列表失败/)
    expect(await countGameDirs(join(battles2, pairName))).toBe(8)
    await rm(root2, { recursive: true, force: true })
  }, 60_000)
})
