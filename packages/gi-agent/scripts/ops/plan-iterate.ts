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
 * plan-iterate — 单树决策计划的多轮反思迭代编排（锚点实验续跑设施检验）。
 *
 * 用法（gi-agent 包目录内）：
 *   pnpm exec gnx scripts/ops/plan-iterate.ts --config <anchor-exp.json> \
 *     --base-run <anchor 实验 run 目录> --out <迭代产物目录> \
 *     --seed 42071001 --rounds 5 [--reflect-concurrency 3] [--battle-concurrency 4]
 *
 * 口径：
 * - 单元 = (model × deck × arm) 的 r0 单树计划（取自 base-run 的 plans/，拷入 out/plans/）；
 * - 每轮 r=1..rounds：先 reflect（plan:reflect 单树 legacy 模式，--evidence engine-only
 *   --patch --turns 4 harness；证据 = 上一轮该臂作为 side0 的两个批目录：X-X 与 X-对臂，
 *   r=1 时用 base-run 里 --seed 指定的 anchor 实验批），再 batch（4 配对全跑，与
 *   anchor-experiment 同构，产物供下一轮证据 + 本轮读数）；
 * - 幂等续跑：state.json 只记 done；失败隔离（reflect 失败的单元 batch 自动跳过，
 *   末尾汇总 exit 1）；
 * - 版本钉扎 fail-fast（与 anchor-experiment 一致）。
 */

import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Version } from "@gi-tcg/core"
import { parseGameVersion } from "../../src/runtime/plan-oneshot/version.js"
import { deriveSeed, injectedEnvOf, type TournamentModel } from "./tournament-config.js"
import { createSerializedSaver, runPool, spawnPnpmAsync } from "./async-pool.js"

// ── config ───────────────────────────────────────────────────────────────

interface IterateConfig {
  models: string[]
  models_api: Record<string, { baseUrl: string; model: string; apiKeyEnv: string; maxTokens?: number }>
  environment: { label: string; gameVersion: string; decks: string[] }
  gamesPerMatch: number
  seeds: number[]
}

async function loadConfig(path: string): Promise<{ config: IterateConfig; gameVersion: Version; models: TournamentModel[] }> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as IterateConfig
  const errors: string[] = []
  const models: TournamentModel[] = []
  for (const name of raw.models ?? []) {
    const api = raw.models_api?.[name]
    if (!api?.baseUrl || !api?.model || !api?.apiKeyEnv) {
      errors.push(`models_api 缺少 ${name} 的 baseUrl/model/apiKeyEnv`)
      continue
    }
    models.push({
      name, baseUrl: api.baseUrl, model: api.model, apiKeyEnv: api.apiKeyEnv,
      ...(typeof api.maxTokens === "number" && Number.isInteger(api.maxTokens) && api.maxTokens >= 1
        ? { maxTokens: api.maxTokens } : {}),
    })
  }
  const gameVersion = parseGameVersion(raw.environment?.gameVersion)
  if (gameVersion === undefined) errors.push("environment.gameVersion 必填")
  if (!Array.isArray(raw.environment?.decks) || raw.environment.decks.length < 1) errors.push("environment.decks 必填")
  if (!Number.isInteger(raw.gamesPerMatch) || raw.gamesPerMatch < 1) errors.push("gamesPerMatch 必须 ≥1 整数")
  if (errors.length > 0) throw new Error(`iterate config 校验失败：\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  return { config: raw, gameVersion: gameVersion as Version, models }
}

// ── 工具 ─────────────────────────────────────────────────────────────────

function tail(text: string, lines = 10): string {
  return text.trim().split("\n").slice(-lines).join("\n")
}

function clampConcurrency(raw: string | undefined, dflt: number): number {
  const n = Number(raw ?? dflt)
  if (!Number.isInteger(n) || n < 1) return dflt
  return Math.min(n, 8)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, "utf-8")
  try {
    await rename(tmp, path)
  } catch {
    await writeFile(path, text, "utf-8")
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function loadState(path: string): Promise<{ done: Record<string, true> }> {
  if (!existsSync(path)) return { done: {} }
  return JSON.parse(await readFile(path, "utf-8")) as { done: Record<string, true> }
}

async function saveState(path: string, state: { done: Record<string, true> }): Promise<void> {
  await writeJson(path, state)
}

// ── 读数结构 ─────────────────────────────────────────────────────────────

interface BatchSummaryLite {
  planId: string
  gameVersion: string
  games: number
  seedBase: number
  wins: number
  losses: number
  draws: number
  avgRounds: number
  avgCoverage: number
  fallbackRate: number
  perGame: Array<{ gameDir: string; seed: number; planSide: 0 | 1; winner: 0 | 1 | null; rounds: number }>
}

// ── 常量 ─────────────────────────────────────────────────────────────────

/** reflect 单次子进程超时（harness 4 轮 × 长推理模型单轮 20-40 分钟实测，4h 余量） */
const REFLECT_TIMEOUT_MS = 4 * 60 * 60 * 1000
const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000
const REFLECT_ATTEMPTS = 3

const MATCHUPS = [
  { key: "ctrl-ctrl", planArm: "ctrl", oppArm: "ctrl" },
  { key: "anchor-anchor", planArm: "anchor", oppArm: "anchor" },
  { key: "ctrl-anchor", planArm: "ctrl", oppArm: "anchor" },
  { key: "anchor-ctrl", planArm: "anchor", oppArm: "ctrl" },
] as const
type Arm = "ctrl" | "anchor"

/** arm 作为 side0（plan 侧）的配对 key 列表——reflect 证据目录 */
const side0Pairings = (arm: Arm): string[] => MATCHUPS.filter((m) => m.planArm === arm).map((m) => m.key)

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const configPath = get("config")
  const baseRunArg = get("base-run")
  const outArg = get("out")
  const seedRaw = get("seed")
  const roundsRaw = get("rounds")
  if (!configPath || !baseRunArg || !outArg || !seedRaw || !roundsRaw) {
    console.error("usage: plan-iterate -- --config <anchor-exp.json> --base-run <dir> --out <dir> --seed N --rounds N [--reflect-concurrency 3] [--battle-concurrency 4]")
    process.exit(1)
  }
  const seed = Number(seedRaw)
  const rounds = Number(roundsRaw)
  if (!Number.isInteger(seed) || !Number.isInteger(rounds) || rounds < 1) {
    console.error("--seed/--rounds 必须是整数（rounds ≥1）")
    process.exit(1)
  }
  const giRoot = process.cwd()
  const out = resolve(giRoot, outArg)
  const baseRun = resolve(giRoot, baseRunArg)
  const { config, gameVersion, models } = await loadConfig(configPath)
  await mkdir(out, { recursive: true })
  console.log(`plan-iterate：models=${config.models.join(",")}，decks=${config.environment.decks.length}，seed=${seed}，rounds=${rounds}，out=${out}`)

  const decks = config.environment.decks
  const statePath = join(out, "state.json")
  const state = await loadState(statePath)
  const saveStateSerialized = createSerializedSaver(() => saveState(statePath, state))
  const failures: Array<{ key: string; stage: string; error: string }> = []
  const reflectConcurrency = clampConcurrency(get("reflect-concurrency"), 3)
  const battleConcurrency = clampConcurrency(get("battle-concurrency"), 4)

  const planPath = (model: string, arm: Arm, di: number, r: number): string =>
    join(out, "plans", model, `${arm}.d${di}.r${r}.json`)

  // ── 0. r0 计划落位（从 base-run 拷入 out/plans，幂等）──
  for (const model of models) {
    for (let di = 0; di < decks.length; di++) {
      for (const arm of ["ctrl", "anchor"] as const) {
        const src = join(baseRun, "plans", model.name, `${arm}.d${di}.r0.json`)
        const dst = planPath(model.name, arm, di, 0)
        if (!existsSync(dst)) {
          if (!existsSync(src)) {
            failures.push({ key: `r0|${model.name}|d${di}|${arm}`, stage: "r0", error: `base-run 缺 r0 计划：${src}` })
            continue
          }
          const plan = JSON.parse(await readFile(src, "utf-8")) as { context?: { gameVersion?: string } }
          if (plan.context?.gameVersion !== gameVersion) {
            console.error(`r0 计划（${src}）版本 ${String(plan.context?.gameVersion)} 与环境版本 ${gameVersion} 不一致——版本错配 fail-fast`)
            process.exit(1)
          }
          await writeJson(dst, plan)
        }
      }
    }
  }

  // 证据目录：r=1 → base-run 的 seed 批；r≥2 → 本目录上一轮批
  const evidenceDirs = (model: string, di: number, arm: Arm, r: number): string[] => {
    const pairings = side0Pairings(arm)
    if (r === 1) return pairings.map((p) => join(baseRun, "batches", model, `d${di}`, String(seed), p))
    return pairings.map((p) => join(out, "batches", model, `d${di}`, `r${r - 1}`, p))
  }

  for (let r = 1; r <= rounds; r++) {
    // ── reflect（LLM；幂等、失败隔离）──
    interface ReflectTask { model: TournamentModel; di: number; arm: Arm }
    const reflectTasks: ReflectTask[] = []
    for (const model of models) {
      for (let di = 0; di < decks.length; di++) {
        for (const arm of ["ctrl", "anchor"] as const) reflectTasks.push({ model, di, arm })
      }
    }
    await runPool(reflectTasks, reflectConcurrency, async (t) => {
      const { model, di, arm } = t
      const key = `reflect|${model.name}|d${di}|${arm}|r${r}`
      const outFile = planPath(model.name, arm, di, r)
      if (state.done[key] === true) return
      if (existsSync(outFile) && JSON.parse(await readFile(outFile, "utf-8").catch(() => "{}")).planId) {
        state.done[key] = true
        await saveStateSerialized()
        return
      }
      const prevPlan = planPath(model.name, arm, di, r - 1)
      if (!existsSync(prevPlan)) return // 上一代缺失（reflect 曾失败）——跳过
      const dirs = evidenceDirs(model.name, di, arm, r)
      if (dirs.some((d) => !existsSync(join(d, "summary.json")))) return // 证据批未就绪
      let envInjection: NodeJS.ProcessEnv
      try {
        envInjection = injectedEnvOf(model)
      } catch (e) {
        failures.push({ key, stage: "reflect", error: e instanceof Error ? e.message : String(e) })
        await saveStateSerialized()
        return
      }
      const seedR = deriveSeed(seed, ["iterate-reflect", model.name, di, arm, r])
      const args = [
        "--run-dir", dirs.join(","),
        "--side", "0",
        "--out", outFile,
        "--evidence", "engine-only",
        // patch 修订协议（harness 多轮限定）：修订走受限 ops 合并而非整树重写，改动面可控
        "--patch",
        "--turns", "4",
        "--seed", String(seedR),
        "--temperature", "0.2",
        "--model", model.model,
        "--stream",
        ...(model.maxTokens !== undefined ? ["--max-tokens", String(model.maxTokens)] : []),
      ]
      let ok = false
      let lastOutput = ""
      for (let attempt = 1; attempt <= REFLECT_ATTEMPTS; attempt++) {
        console.log(`[reflect] ${key}（attempt ${attempt}/${REFLECT_ATTEMPTS}）`)
        const r2 = await spawnPnpmAsync(["run", "plan:reflect", "--", ...args], { cwd: giRoot, env: envInjection, timeoutMs: REFLECT_TIMEOUT_MS })
        if (r2.ok) { ok = true; break }
        lastOutput = r2.output
        console.error(`[reflect] ${key} attempt ${attempt} 失败：\n${tail(r2.output)}`)
        if (attempt < REFLECT_ATTEMPTS) await sleep(5000)
      }
      if (ok) state.done[key] = true
      else failures.push({ key, stage: "reflect", error: tail(lastOutput, 8) })
      await saveStateSerialized()
    })

    // ── batch（零 LLM；4 配对同构 anchor-experiment；幂等）──
    interface BatchTask { model: TournamentModel; di: number; m: (typeof MATCHUPS)[number] }
    const batchTasks: BatchTask[] = []
    for (const model of models) {
      for (let di = 0; di < decks.length; di++) {
        for (const m of MATCHUPS) batchTasks.push({ model, di, m })
      }
    }
    await runPool(batchTasks, battleConcurrency, async (t) => {
      const { model, di, m } = t
      const key = `batch|${model.name}|d${di}|r${r}|${m.key}`
      const batchDir = join(out, "batches", model.name, `d${di}`, `r${r}`, m.key)
      const summaryFile = join(batchDir, "summary.json")
      if (state.done[key] === true) return
      const planFile = planPath(model.name, m.planArm, di, r)
      const oppFile = planPath(model.name, m.oppArm, di, r)
      if (!existsSync(planFile) || !existsSync(oppFile)) return // reflect 未就绪
      // 版本钉扎断言（fail-fast）
      for (const [what, p] of [["plan", planFile], ["opponent", oppFile]] as const) {
        const plan = JSON.parse(await readFile(p, "utf-8")) as { context?: { gameVersion?: string } }
        if (plan.context?.gameVersion !== gameVersion) {
          console.error(`${what}（${p}）版本 ${String(plan.context?.gameVersion)} 与环境版本 ${gameVersion} 不一致——版本错配 fail-fast`)
          process.exit(1)
        }
      }
      const batchConfig = {
        planFile,
        opponent: { type: "plan", planFile: oppFile },
        opponentDeckCode: decks[di]!,
        games: config.gamesPerMatch,
        seedBase: seed, // 同 seed 梯：全部轮次同 seedBase（与 anchor-experiment 口径一致）
        alternateFirstPlayer: true,
        concurrency: 1,
        outDir: batchDir,
        gameVersion,
        traceSignatures: "lean",
      }
      const cfgPath = join(out, "configs", `${key.replace(/[^A-Za-z0-9._-]/g, "__")}.json`)
      await writeJson(cfgPath, batchConfig)
      console.log(`[batch] ${key}（${config.gamesPerMatch} 局）`)
      const r2 = await spawnPnpmAsync(["run", "plan:batch", "--", cfgPath], { cwd: giRoot, timeoutMs: BATCH_TIMEOUT_MS })
      if (!r2.ok) {
        failures.push({ key, stage: "batch", error: tail(r2.output, 10) })
        await saveStateSerialized()
        return
      }
      state.done[key] = true
      await saveStateSerialized()
    })

    console.log(`[round ${r}] 完成（state done=${Object.keys(state.done).length}，累计失败 ${failures.length}）`)
  }

  // ── 读数：逐轮 per-arm coverage/fallback/rounds + 臂对臂（anchor 视角）──
  interface RoundReading {
    perArm: Record<string, { coverage: number[]; fallback: number[]; rounds: number[] }>
    armVsArm: Record<string, { win: number; loss: number; draw: number }> // model → anchor 视角
  }
  const readRound = (r: number): RoundReading => {
    const reading: RoundReading = { perArm: {}, armVsArm: {} }
    for (const model of models) {
      for (let di = 0; di < decks.length; di++) {
        for (const m of MATCHUPS) {
          const summaryFile = join(out, "batches", model.name, `d${di}`, `r${r}`, m.key, "summary.json")
          if (!existsSync(summaryFile)) continue
          const s = JSON.parse(requireRead(summaryFile)) as BatchSummaryLite
          const k = `${model.name}|${m.planArm}`
          reading.perArm[k] ??= { coverage: [], fallback: [], rounds: [] }
          reading.perArm[k]!.coverage.push(s.avgCoverage)
          reading.perArm[k]!.fallback.push(s.fallbackRate)
          reading.perArm[k]!.rounds.push(s.avgRounds)
          if (m.planArm !== m.oppArm) {
            const anchorIsP1 = m.planArm === "anchor"
            for (const g of s.perGame) {
              const rel = g.winner === null ? "draw" : g.winner === g.planSide ? "p1" : "p2"
              const anchorWon = rel === "draw" ? null : (rel === "p1") === anchorIsP1
              const bucket = anchorWon === null ? "draw" : anchorWon ? "win" : "loss"
              const cell = reading.armVsArm[model.name] ??= { win: 0, loss: 0, draw: 0 }
              cell[bucket]++
            }
          }
        }
      }
    }
    return reading
  }
  const requireRead = (p: string): string => readFileSync(p, "utf-8")
  const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

  const lines: string[] = []
  lines.push(`# 单树迭代读数（plan-iterate；base-run=${baseRunArg}，seed=${seed}，rounds=${rounds}）`, "")
  lines.push("## 逐轮臂对臂战绩（anchor 视角 胜-负-平；每格 = 8 卡组 × 2 对向 × games）", "")
  lines.push("| 轮 | 模型 | anchor 胜 | 负 | 平 | anchor 胜率(不含平) |", "|---|---|---|---|---|---|")
  const summaryRounds: unknown[] = []
  for (let r = 0; r <= rounds; r++) {
    // r=0 读 base-run 的 seed 批
    const reading = r === 0 ? readBaseRound() : readRound(r)
    summaryRounds.push({ round: r, perArm: Object.fromEntries(Object.entries(reading.perArm).map(([k, v]) => [k, {
      coverage: mean(v.coverage), fallbackRate: mean(v.fallback), avgRounds: mean(v.rounds), batches: v.coverage.length,
    }])), armVsArm: reading.armVsArm })
    for (const model of models) {
      const v = reading.armVsArm[model.name]
      if (!v) continue
      const wr = v.win + v.loss > 0 ? (100 * v.win / (v.win + v.loss)).toFixed(1) + "%" : "—"
      lines.push(`| r${r} | ${model.name} | ${v.win} | ${v.loss} | ${v.draw} | ${wr} |`)
    }
  }
  lines.push("", "## 逐轮 per-arm 口径（coverage / fallback / avgRounds 跨批均值）", "")
  lines.push("| 轮 | 模型 | 臂 | coverage | fallback | avgRounds | 批数 |", "|---|---|---|---|---|---|---|")
  for (let r = 0; r <= rounds; r++) {
    const sr = summaryRounds[r] as { perArm: Record<string, { coverage: number; fallbackRate: number; avgRounds: number; batches: number }> }
    for (const [k, v] of Object.entries(sr.perArm)) {
      const [model, arm] = k.split("|")
      lines.push(`| r${r} | ${model} | ${arm} | ${(v.coverage * 100).toFixed(1)}% | ${(v.fallbackRate * 100).toFixed(1)}% | ${v.avgRounds.toFixed(1)} | ${v.batches} |`)
    }
  }
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "summary.md"), lines.join("\n") + "\n", "utf-8")

  // base-run 的 r0 读数（与 readRound 同口径，目录形态不同：d<di>/<seed>/<pairing>）
  function readBaseRound(): RoundReading {
    const reading: RoundReading = { perArm: {}, armVsArm: {} }
    for (const model of models) {
      for (let di = 0; di < decks.length; di++) {
        for (const m of MATCHUPS) {
          const summaryFile = join(baseRun, "batches", model.name, `d${di}`, String(seed), m.key, "summary.json")
          if (!existsSync(summaryFile)) continue
          const s = JSON.parse(requireRead(summaryFile)) as BatchSummaryLite
          const k = `${model.name}|${m.planArm}`
          reading.perArm[k] ??= { coverage: [], fallback: [], rounds: [] }
          reading.perArm[k]!.coverage.push(s.avgCoverage)
          reading.perArm[k]!.fallback.push(s.fallbackRate)
          reading.perArm[k]!.rounds.push(s.avgRounds)
          if (m.planArm !== m.oppArm) {
            const anchorIsP1 = m.planArm === "anchor"
            for (const g of s.perGame) {
              const rel = g.winner === null ? "draw" : g.winner === g.planSide ? "p1" : "p2"
              const anchorWon = rel === "draw" ? null : (rel === "p1") === anchorIsP1
              const bucket = anchorWon === null ? "draw" : anchorWon ? "win" : "loss"
              const cell = reading.armVsArm[model.name] ??= { win: 0, loss: 0, draw: 0 }
              cell[bucket]++
            }
          }
        }
      }
    }
    return reading
  }

  await writeJson(join(out, "summary.json"), {
    config: { ...config, models_api: "（省略；见 config 文件）" },
    seed,
    rounds,
    baseRun: baseRunArg,
    rounds_reading: summaryRounds,
    failures,
    generatedAt: new Date().toISOString(),
  })

  console.log(`\n完成：${out}/summary.json + summary.md（失败 ${failures.length}）`)
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - [${f.stage}] ${f.key}：${f.error.split("\n")[0]}`)
    process.exit(1)
  }
}

await main()
