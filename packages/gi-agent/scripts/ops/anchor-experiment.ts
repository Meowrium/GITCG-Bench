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
 * anchor-experiment — round19 式 `--anchor` 起草复验（WP5，impl-spec-5）。
 * 零新逻辑：--anchor 两阶段起草与形状闸均为现成代码（run-plan-author.ts:124-301 +
 * prompts/anchor-system.md）；本脚本纯编排与读数。
 *
 * 用法（gi-agent 包目录内）：
 *   pnpm exec gnx scripts/ops/anchor-experiment.ts --config <anchor-exp.json> --out <dir>
 *   （可选 --author-concurrency N / --battle-concurrency N：LLM 单元并发缺省 3、
 *    battle 批进程并发缺省 4——引擎单线程，批间进程级并行才有效，批内恒 1 局在飞）
 *
 * config（示例见 examples/anchor-exp.example.json）：
 * {
 *   "models": ["glm-5.3", "deepseek-v4-pro-0813"],          // 2-3（须都在 models_api）
 *   "models_api": { "<name>": { "baseUrl": "...", "model": "...", "apiKeyEnv": "...",
 *                               "maxTokens": 128000 } },     // 可选；长推理模型输出上限（→ --max-tokens）
 *   "environment": { "label": "v6.3", "gameVersion": "v6.3.0", "decks": ["<2-3 deckCode>"] },
 *   "gamesPerMatch": 20,                                     // 单对抗批局数
 *   "seeds": [42071001, 42071002]                            // 跨 seed 报 SE（同 seed 梯跨臂可比）
 * }
 *
 * 双臂（同模型同 deck 同 seed）：ctrl = plan:author 直起草；anchor = plan:author --anchor
 * （两阶段，产物 <out>.anchor.json sidecar 供核验）。author 对手假设 = --mirror（round19
 * 内战口径），故全部批为同 deck 镜像对抗。
 *
 * 对抗矩阵（每 model × deck × seed，batch seedBase = seed 本身——同 seed 梯跨臂可比）：
 *   ctrl×ctrl / anchor×anchor（同臂基线，控模型自身方差）
 *   ctrl×anchor / anchor×ctrl（臂对臂，关键战绩；双向对坐）
 *
 * 读数（impl-spec-5 §3）：coverage / fallback 率（按臂聚合 plan 侧批）、臂对臂战绩
 * （perGame winner 位 + planSide 换算）、avgRounds；脚本交叉校验读数与 summary 原值。
 * 判定与回写：复现负面 → 主赛 author 一律 ctrl；稳定收益 → 回写主赛 author 默认 --anchor；
 * 混合 → 报告现象不改主赛（summary.md 末尾给出判定提示，人工复核）。
 *
 * 失败隔离：单模型 author/batch 失败记录继续，末尾汇总 exit 1。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Version } from "@gi-tcg/core"
import { parseGameVersion } from "../../src/runtime/plan-oneshot/version.js"
import { deriveSeed, injectedEnvOf, type TournamentModel } from "./tournament-config.js"
import { createSerializedSaver, runPool, spawnPnpmAsync } from "./async-pool.js"

// ── config ───────────────────────────────────────────────────────────────

interface AnchorExpConfig {
  models: string[]
  models_api: Record<string, { baseUrl: string; model: string; apiKeyEnv: string; maxTokens?: number }>
  environment: { label: string; gameVersion: string; decks: string[] }
  gamesPerMatch: number
  seeds: number[]
}

async function loadConfig(path: string): Promise<{ config: AnchorExpConfig; gameVersion: Version; models: TournamentModel[] }> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as AnchorExpConfig
  const errors: string[] = []
  if (!Array.isArray(raw.models) || raw.models.length < 2 || raw.models.length > 4) {
    errors.push("models 必须 2-4 个")
  }
  if (!raw.models_api || typeof raw.models_api !== "object") {
    errors.push("models_api 必填（name → {baseUrl, model, apiKeyEnv}）")
  }
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
  const names = new Set<string>()
  const keyEnvs = new Set<string>()
  for (const m of models) {
    if (names.has(m.name)) errors.push(`models 重复：${m.name}`)
    names.add(m.name)
    if (keyEnvs.has(m.apiKeyEnv)) errors.push(`apiKeyEnv 重复：${m.apiKeyEnv}`)
    keyEnvs.add(m.apiKeyEnv)
  }
  const gameVersion = parseGameVersion(raw.environment?.gameVersion)
  if (gameVersion === undefined) errors.push("environment.gameVersion 必填（如 v6.3.0）")
  if (!Array.isArray(raw.environment?.decks) || raw.environment.decks.length < 2 || raw.environment.decks.length > 8) {
    errors.push("environment.decks 必须 2-8 个 deckCode")
  }
  if (!Number.isInteger(raw.gamesPerMatch) || raw.gamesPerMatch < 1) {
    errors.push("gamesPerMatch 必须 ≥1 整数")
  }
  if (!Array.isArray(raw.seeds) || raw.seeds.length < 1 || !raw.seeds.every((s) => Number.isInteger(s))) {
    errors.push("seeds 必须是非空整数数组")
  }
  if (errors.length > 0) {
    throw new Error(`anchor-exp config 校验失败：\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  }
  return { config: raw, gameVersion: gameVersion as Version, models }
}

// ── 子进程 ───────────────────────────────────────────────────────────────

function spawnPnpm(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { ok: boolean; output: string; timedOut: boolean } {
  const res = spawnSync("pnpm", args, {
    cwd: opts.cwd,
    // 逐模型凭据注入（impl-spec-0 §4：OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL）——
    // opts.env 必须真正传给子进程，否则 author 全部落在无凭据的父 env 上
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    shell: true,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim()
  const timedOut = res.error !== undefined && "code" in res.error && (res.error as { code?: string }).code === "ETIMEDOUT"
  return { ok: res.status === 0, output, timedOut }
}

function tail(text: string, lines = 10): string {
  return text.trim().split("\n").slice(-lines).join("\n")
}

/** LLM 单元并发度解析（--author-concurrency；缺省 3，钳制 1-8——API 限速友好） */
function clampConcurrency(raw: string | undefined): number {
  const n = Number(raw ?? 3)
  if (!Number.isInteger(n) || n < 1) return 3
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

interface ArmReading {
  coverageSamples: number[]
  fallbackSamples: number[]
  roundsSamples: number[]
}

interface ExpReading {
  perArm: Record<string, ArmReading> // key = `${model}|${arm}`
  armVsArm: Record<string, { win: number; loss: number; draw: number }> // key = `${model}`，anchor 视角
  armVsArmTotal: { win: number; loss: number; draw: number }
  batches: Array<{ key: string; planArm: string; oppArm: string; summaryFile: string; summary: BatchSummaryLite }>
  failures: Array<{ key: string; stage: string; error: string }>
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** 均值的经典 SE（跨 seed/批） */
function se(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length)
}

// ── 主流程 ───────────────────────────────────────────────────────────────

// harness 4 轮 × 长推理模型单轮 20-40 分钟（glm-5.3 实测）：60 分钟必砍在途单元，放宽到 4h
const AUTHOR_TIMEOUT_MS = 4 * 60 * 60 * 1000
const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--")
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const configPath = get("config")
  const outArg = get("out")
  if (!configPath || !outArg) {
    console.error("usage: pnpm exec gnx scripts/ops/anchor-experiment.ts --config <anchor-exp.json> --out <dir>")
    process.exit(1)
  }
  const giRoot = process.cwd()
  const out = resolve(giRoot, outArg)
  const { config, gameVersion, models } = await loadConfig(configPath)
  await mkdir(out, { recursive: true })
  console.log(`anchor-experiment：models=${config.models.join(",")}，decks=${config.environment.decks.length}，seeds=${config.seeds.join(",")}，out=${out}`)

  const statePath = join(out, "state.json")
  const state = await loadState(statePath)
  const reading: ExpReading = { perArm: {}, armVsArm: {}, armVsArmTotal: { win: 0, loss: 0, draw: 0 }, batches: [], failures: [] }

  const decks = config.environment.decks
  // ── 1. 双臂起草（失败隔离：重试 2 次；坏凭据仅影响该模型）──
  // 单元级并发（LLM 生成是墙钟瓶颈）：各单元独立凭据/out/state key，可安全并行；
  // state.json 落盘经串行化互斥（内存对象为真值）。
  const authorConcurrency = clampConcurrency(get("author-concurrency"))
  const saveStateSerialized = createSerializedSaver(() => saveState(statePath, state))
  interface AuthorTask { model: TournamentModel; envInjection: NodeJS.ProcessEnv; di: number; arm: "ctrl" | "anchor" }
  const authorTasks: AuthorTask[] = []
  for (const model of models) {
    let envInjection: NodeJS.ProcessEnv
    try {
      envInjection = injectedEnvOf(model)
    } catch (e) {
      reading.failures.push({ key: model.name, stage: "author", error: e instanceof Error ? e.message : String(e) })
      continue
    }
    for (let di = 0; di < decks.length; di++) {
      for (const arm of ["ctrl", "anchor"] as const) {
        authorTasks.push({ model, envInjection, di, arm })
      }
    }
  }
  await runPool(authorTasks, authorConcurrency, async (t) => {
    const { model, envInjection, di, arm } = t
    const key = `author|${model.name}|d${di}|${arm}`
    const outFile = join(out, "plans", model.name, `${arm}.d${di}.r0.json`)
    if (state.done[key] === true || (existsSync(outFile) && JSON.parse(await readFile(outFile, "utf-8").catch(() => "{}")).planId)) {
      return
    }
    const seed = deriveSeed(config.seeds[0]!, ["anchor-author", model.name, di, arm])
    const args = [
      "--deck", decks[di]!,
      "--mirror",
      "--game-version", gameVersion,
      "--out", outFile,
      "--seed", String(seed),
      "--temperature", "0.2",
      "--model", model.model,
      // harness 有界多轮（--turns 4）：one-shot 对 glm 系推理模型系统性失败——答案
      // 全落 reasoning_content（~100KB 非解析文本）而 content 为空，修复轮同 prompt
      // 复现同行为；执行方案 §7 的 author 口径本就是 harness 模式。对所有模型与
      // 双臂一致加，保证臂间公平。
      "--turns", "4",
      "--stream",
      // 长推理模型输出上限（qwen 侧发 max_completion_tokens，见 llm.ts）；缺省走 CLI 32768
      ...(model.maxTokens !== undefined ? ["--max-tokens", String(model.maxTokens)] : []),
      ...(arm === "anchor" ? ["--anchor"] : []),
    ]
    let ok = false
    let lastOutput = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[author] ${key}（attempt ${attempt}/3）`)
      const r = await spawnPnpmAsync(["run", "plan:author", "--", ...args], { cwd: giRoot, env: envInjection, timeoutMs: AUTHOR_TIMEOUT_MS })
      if (r.ok) {
        ok = true
        break
      }
      lastOutput = r.output
      console.error(`[author] ${key} attempt ${attempt} 失败：\n${tail(r.output)}`)
      if (attempt < 3) await sleep(5000)
    }
    if (ok) state.done[key] = true
    else reading.failures.push({ key, stage: "author", error: tail(lastOutput, 8) })
    await saveStateSerialized()
  })

  // ── 2. 对抗矩阵批跑（零 LLM；幂等）──
  // 批间进程级并行（引擎在单 node 进程内是单线程，批内 concurrency>1 只重叠 I/O
  // 不加速 CPU——冒烟实测批内 4 并发 wall≈引擎串行时间）；批内固定 1 局在飞，
  // 全局并行度 = 批池大小（默认 4，对齐设备核数）。
  const battleConcurrency = clampConcurrency(get("battle-concurrency"))
  const matchups: Array<{ key: string; planArm: "ctrl" | "anchor"; oppArm: "ctrl" | "anchor" }> = [
    { key: "ctrl-ctrl", planArm: "ctrl", oppArm: "ctrl" },
    { key: "anchor-anchor", planArm: "anchor", oppArm: "anchor" },
    { key: "ctrl-anchor", planArm: "ctrl", oppArm: "anchor" },
    { key: "anchor-ctrl", planArm: "anchor", oppArm: "ctrl" },
  ]
  interface BatchTask { model: TournamentModel; di: number; seed: number; m: (typeof matchups)[number] }
  const batchTasks: BatchTask[] = []
  for (const model of models) {
    for (let di = 0; di < decks.length; di++) {
      for (const seed of config.seeds) {
        for (const m of matchups) {
          batchTasks.push({ model, di, seed, m })
        }
      }
    }
  }
  await runPool(batchTasks, battleConcurrency, async (t) => {
    const { model, di, seed, m } = t
    const key = `batch|${model.name}|d${di}|s${seed}|${m.key}`
    const batchDir = join(out, "batches", model.name, `d${di}`, String(seed), m.key)
    const summaryFile = join(batchDir, "summary.json")
    if (state.done[key] === true) {
      if (existsSync(summaryFile)) {
        reading.batches.push({ key, planArm: m.planArm, oppArm: m.oppArm, summaryFile, summary: JSON.parse(await readFile(summaryFile, "utf-8")) as BatchSummaryLite })
      }
      return
    }
    const planFile = join(out, "plans", model.name, `${m.planArm}.d${di}.r0.json`)
    const oppFile = join(out, "plans", model.name, `${m.oppArm}.d${di}.r0.json`)
    if (!existsSync(planFile) || !existsSync(oppFile)) return // 起草未就绪
    // 版本钉扎断言（fail-fast）
    for (const [what, p] of [["plan", planFile], ["opponent", oppFile]] as const) {
      const plan = JSON.parse(await readFile(p, "utf-8")) as { context?: { gameVersion?: string } }
      if (plan.context?.gameVersion !== gameVersion) {
        failFast(`${what}（${p}）版本 ${String(plan.context?.gameVersion)} 与环境版本 ${gameVersion} 不一致——版本错配 fail-fast`)
      }
    }
    const batchConfig = {
      planFile,
      opponent: { type: "plan", planFile: oppFile },
      opponentDeckCode: decks[di]!,
      games: config.gamesPerMatch,
      seedBase: seed, // 同 seed 梯：全部同臂/跨臂批同 seedBase（round19 口径）
      alternateFirstPlayer: true,
      // 批内固定 1：并行度在批间进程池（引擎单线程，进程内多局只重叠 I/O）
      concurrency: 1,
      outDir: batchDir,
      gameVersion,
      // trace 签名 lean 化（impl-spec-1 件 1）：单局产物 1.87MB → ≤0.45MB（签名改
      // 短哈希指针，消费侧经 sig-backfill 从 state log 反查；full 工具链行为不变）
      traceSignatures: "lean",
    }
    const cfgPath = join(out, "configs", `${key.replace(/[^A-Za-z0-9._-]/g, "__")}.json`)
    await writeJson(cfgPath, batchConfig)
    console.log(`[batch] ${key}（${config.gamesPerMatch} 局）`)
    const r = await spawnPnpmAsync(["run", "plan:batch", "--", cfgPath], { cwd: giRoot, timeoutMs: BATCH_TIMEOUT_MS })
    if (!r.ok) {
      reading.failures.push({ key, stage: "batch", error: tail(r.output, 10) })
      await saveStateSerialized()
      return
    }
    state.done[key] = true
    await saveStateSerialized()
    reading.batches.push({ key, planArm: m.planArm, oppArm: m.oppArm, summaryFile, summary: JSON.parse(await readFile(summaryFile, "utf-8")) as BatchSummaryLite })
  })

  // ── 3. 读数（impl-spec-5 §3；交叉校验）──
  for (const b of reading.batches) {
    const model = b.key.split("|")[1]!
    for (const arm of ["ctrl", "anchor"] as const) {
      if (b.planArm !== arm) continue
      const k = `${model}|${arm}`
      reading.perArm[k] ??= { coverageSamples: [], fallbackSamples: [], roundsSamples: [] }
      reading.perArm[k]!.coverageSamples.push(b.summary.avgCoverage)
      reading.perArm[k]!.fallbackSamples.push(b.summary.fallbackRate)
      reading.perArm[k]!.roundsSamples.push(b.summary.avgRounds)
    }
    if (b.planArm !== b.oppArm) {
      // 臂对臂：p1 = plan 侧臂；winner 位 + planSide → 相对胜负 → anchor 视角计数
      const anchorIsP1 = b.planArm === "anchor"
      for (const g of b.summary.perGame) {
        const rel: "p1" | "p2" | "draw" = g.winner === null ? "draw" : g.winner === g.planSide ? "p1" : "p2"
        const anchorWon = rel === "draw" ? null : (rel === "p1") === anchorIsP1
        const bucket = anchorWon === null ? "draw" : anchorWon ? "win" : "loss"
        const perModel = reading.armVsArm[model] ??= { win: 0, loss: 0, draw: 0 }
        perModel[bucket]++
        reading.armVsArmTotal[bucket]++
      }
    }
  }
  // 交叉校验（验收 3）：臂对臂总数 == 各批 games 之和
  const armVsGames = reading.batches
    .filter((b) => b.planArm !== b.oppArm)
    .reduce((acc, b) => acc + b.summary.games, 0)
  const armVsTotal = reading.armVsArmTotal.win + reading.armVsArmTotal.loss + reading.armVsArmTotal.draw
  if (armVsGames !== armVsTotal) {
    reading.failures.push({ key: "cross-check", stage: "read", error: `臂对臂局数不一致：batches 合计 ${armVsGames} vs 计数 ${armVsTotal}` })
  }

  // anchor 臂核验（验收 1）：--anchor 产物含 sidecar
  const anchorSidecars: string[] = []
  for (const model of models) {
    for (let di = 0; di < decks.length; di++) {
      const sidecar = join(out, "plans", model.name, `anchor.d${di}.r0.json.anchor.json`)
      if (existsSync(sidecar)) anchorSidecars.push(sidecar)
    }
  }

  // ── 4. summary.json + summary.md ──
  await writeJson(join(out, "summary.json"), {
    config: { ...config, models_api: "（省略；见 config 文件）" },
    perArm: Object.fromEntries(Object.entries(reading.perArm).map(([k, v]) => [k, {
      coverage: mean(v.coverageSamples),
      coverageSe: se(v.coverageSamples),
      fallbackRate: mean(v.fallbackSamples),
      fallbackRateSe: se(v.fallbackSamples),
      avgRounds: mean(v.roundsSamples),
      batches: v.coverageSamples.length,
    }])),
    armVsArm: reading.armVsArm,
    armVsArmTotal: reading.armVsArmTotal,
    anchorSidecars: anchorSidecars.length,
    failures: reading.failures,
    generatedAt: new Date().toISOString(),
  })
  await writeSummaryMd(out, config, reading, anchorSidecars.length, armVsGames)

  console.log(`\n完成：${out}/summary.json + summary.md（anchor sidecar ${anchorSidecars.length} 个；失败 ${reading.failures.length}）`)
  if (reading.failures.length > 0) {
    for (const f of reading.failures) console.error(`  - [${f.stage}] ${f.key}：${f.error.split("\n")[0]}`)
    process.exit(1)
  }
}

function failFast(message: string): never {
  console.error(`[fatal] ${message}`)
  process.exit(1)
}

async function loadState(path: string): Promise<{ done: Record<string, true> }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as { done?: Record<string, true> }
    if (raw && typeof raw.done === "object" && raw.done !== null) return { done: raw.done }
  } catch {
    // 首次运行
  }
  return { done: {} }
}

async function saveState(path: string, state: { done: Record<string, true> }): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeJson(path, state)
}

/** round19 历史对照行（08-21 文档 §438-466：DS/M3/GLM-5.2，2026-08-25/26） */
const ROUND19_REFERENCE = "| round19-anchor-ablation（DS/M3/GLM-5.2，2026-08-25/26） | coverage 一致更低 | fallback 一致更高 | 27:43:10（ctrl 占优） |"

async function writeSummaryMd(
  out: string,
  config: AnchorExpConfig,
  reading: ExpReading,
  anchorSidecarCount: number,
  armVsGames: number,
): Promise<void> {
  const lines: string[] = []
  lines.push("# 锚点实验读数（round19 式 `--anchor` 起草复验）", "")
  lines.push(`- 环境：${config.environment.label}（${config.environment.gameVersion}），decks=${config.environment.decks.length}`)
  lines.push(`- 每对抗批 ${config.gamesPerMatch} 局；seeds=${config.seeds.join(", ")}；臂对臂合计 ${armVsGames} 局`)
  lines.push(`- anchor 臂两阶段核验：${anchorSidecarCount} 个 sidecar（plans/**/anchor.d*.r0.json.anchor.json）`, "")
  lines.push("## 按臂读数（plan 侧批聚合；跨批均值 ± SE）", "")
  lines.push("| 模型 | 臂 | coverage | fallback 率 | avgRounds | 批数 |", "|---|---|---|---|---|---|")
  for (const model of config.models) {
    for (const arm of ["ctrl", "anchor"] as const) {
      const k = `${model}|${arm}`
      const v = reading.perArm[k]
      if (!v) {
        lines.push(`| ${model} | ${arm} | —（无批） | — | — | 0 |`)
        continue
      }
      const f = (x: number, s: number): string => `${(x * 100).toFixed(1)}% ± ${(s * 100).toFixed(1)}`
      lines.push(`| ${model} | ${arm} | ${f(mean(v.coverageSamples), se(v.coverageSamples))} | ${f(mean(v.fallbackSamples), se(v.fallbackSamples))} | ${mean(v.roundsSamples).toFixed(1)} | ${v.coverageSamples.length} |`)
    }
  }
  lines.push("", "## 臂对臂战绩（anchor 视角：win/loss/draw；关键战绩）", "")
  lines.push("| 模型 | anchor 胜 | anchor 负 | 平 |", "|---|---|---|---|")
  for (const model of config.models) {
    const v = reading.armVsArm[model]
    lines.push(`| ${model} | ${v?.win ?? 0} | ${v?.loss ?? 0} | ${v?.draw ?? 0} |`)
  }
  const t = reading.armVsArmTotal
  lines.push(`| **合计** | **${t.win}** | **${t.loss}** | **${t.draw}** |`, "")
  lines.push("## 与 round19 对照（同口径）", "")
  lines.push("| 实验 | coverage | fallback | 臂对臂（anchor:ctrl:draw 视角见上文合计） |", "|---|---|---|---|")
  lines.push(ROUND19_REFERENCE)
  lines.push(`| 本次（${config.models.join("/")}） | 见上表 | 见上表 | anchor ${t.win} : ctrl ${t.loss} : draw ${t.draw} |`, "")
  // 判定提示（impl-spec-5 §5；自动判定仅供参考，回写由人工确认）
  const coverageUp = config.models.every((m) => {
    const c = reading.perArm[`${m}|ctrl`]
    const a = reading.perArm[`${m}|anchor`]
    return c && a && mean(a.coverageSamples) > mean(c.coverageSamples)
  })
  const anchorDominant = t.win > t.loss
  let verdict: string
  if (coverageUp && anchorDominant) {
    verdict = "出现稳定收益信号（三模型 anchor coverage > ctrl 且臂对臂 anchor 占优）→ 按规格回写主赛 author 默认 `--anchor`（人工确认后执行）"
  } else if (!coverageUp && !anchorDominant) {
    verdict = "复现负面（anchor coverage ≤ ctrl 且臂对臂 ctrl 占优）→ 主赛 author 一律 ctrl 直起草（不开 --anchor）"
  } else {
    verdict = "混合/不一致 → 报告现象，不修改主赛，留作下轮决定"
  }
  lines.push(`## 判定提示（自动比对，回写需人工确认）`, "", `- ${verdict}`)
  if (reading.failures.length > 0) {
    lines.push("", "## 失败清单", "")
    for (const f of reading.failures) lines.push(`- [${f.stage}] ${f.key}：${f.error.split("\n")[0]}`)
  }
  await writeFile(join(out, "summary.md"), `${lines.join("\n")}\n`, "utf-8")
}

await main()
