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
 * model-tournament — 四模型小型锦标赛编排（WP1，impl-spec-1）。八子命令：
 *
 *   author   r0 起草：逐 model × env × di 的 single 逐格 + general（--opponent-set）
 *            + portfolio manifest 组装（plan:author 子进程，逐模型 env 注入，失败隔离）；
 *            manifest 组装内联在每个 (model, env, di) 的 D+1 个调用全部结束时触发
 *   evolve   r ≥ 1 反思：own-generations 证据组装（tournament-evidence.ts）→
 *            plan:reflect --portfolio --patch --evidence engine-only（失败隔离）
 *   battle   引擎批跑（零 LLM）：默认赛程 = 同代跨模型全矩阵 + 同模型相邻代链批；
 *            config.schedule 可加跨模型跨代（vs-previous）与隔代链（chainGap>1）——
 *            枚举纯逻辑在 tournament-schedule.ts；
 *            幂等续跑（state.json 完成位图）；版本钉扎 fail-fast；state log 按抽样率归档
 *   pipeline 「生成即赛」（2026-09-05 追加，§4.7）：LLM producer（r0=author /
 *            r≥1=evolve）与 battle 调度器并发——调度器把「依赖已就绪」的批持续跑掉，
 *            消除 producer 阶段的引擎空转；producer 结束后 drain，仍依赖未就绪的批
 *            如实记失败（不阻塞后续 invocation 重试）。r≥1 前置校验上一代 battle 全 done
 *   export   summary → tree-bench results 双视角（by-model / by-model-deck）+ mirror-only；
 *            winner 映射：引擎玩家位 0|1|null →（按 perGame.planSide 换算）"p1"|"p2"|"draw"
 *   analyze  逐 results 调 tree-bench analyze + matplotlib 五图（uv run）
 *   status   读 state.json 打印完成位图、失败清单、建议的下一步
 *   archive  冷代次压缩归档（核心在 tournament-archive.ts）：r ≤ --through 的 pair 级
 *            game-* 明细打包 archive/round-<r>/<pair>.tar.gz（tar -tzf 条目校验一致
 *            后才删原目录；链批默认保留，--include-chain 才归档；上游 evolve 未 done
 *            的代跳过；不改 state 位图）。恢复 = tar -xzf <tarball> -C battles/<pair>
 *
 * 用法（gi-agent 包目录内）：
 *   pnpm exec gnx scripts/ops/model-tournament.ts <config.json> <子命令> [--round <N>] [--dense-subset <N>]
 *   pnpm exec gnx scripts/ops/model-tournament.ts <config.json> archive --through <N> [--include-chain] [--dry-run]
 *
 * --round <N>：evolve/battle/pipeline 只处理该代（pipeline 缺省自动判定最小未完成代）；
 *   --dense-subset 透传 analyze。
 * config.llmConcurrency：author/evolve 的 LLM 单元并发**全局上限**（可选，默认 3，钳 1-8）；
 *   config.models[].concurrency 可选，按模型分桶——每模型一个独立有界池（上限 = 该字段
 *   ?? 全局 llmConcurrency，同样钳 1-8），各桶并行 drain，慢供应商不队头阻塞其余模型；
 *   不设该字段时行为与全局池逐一致（增量兼容，旧 config 不改）。不设全局总闸。
 * config.concurrency：battle 批进程并发（可选，默认 4，钳 1-8；批内引擎并发恒 1——
 *   引擎在单 node 进程内是单线程，批间进程级并行才有效）。
 *   pipeline 资源预算：LLM 单元（网络等待型，默认全局 3）与 battle 批进程（CPU 型，默认 4）
 *   天然互补，无需联动节流。
 *   单元 = 独立凭据注入/独立 out/独立 state key，state.json 落盘经互斥串行化——
 *   见 scripts/ops/async-pool.ts。
 *
 * 设计纪律（impl-spec-0 §2）：
 * - 只编排子进程（plan:author / plan:batch / plan:reflect / tree-bench analyze / plots），
 *   不重新实现任何批跑/反思逻辑；全部中间产物写 outRoot 下 JSON，不依赖内存状态跨调用；
 * - LLM 失败不中断批任务（记录 + 继续 + 末尾汇总 exit 1）；引擎侧一致性错误
 *   （版本错配、对手对齐）fail-fast；
 * - tournament.json 只写 apiKeyEnv 名，key 值从进程 env 注入子进程；任何文件不落盘 key 值；
 * - pair 目录名 = plan 侧选手在前（见 tournament-config.ts 命名约定）；
 * - 链批（同模型跨代）state log 恒全量保留（organizer 试点需要）；跨模型批按
 *   gameArchive.stateLogSample 以 seed 确定性抽样。
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Version } from "@gi-tcg/core"
import { loadPortfolioWithValidation } from "../../src/runtime/plan-oneshot/portfolio.js"
import { buildPlayerGraph, buildPlayerGraphsByPeriod, formatComponents } from "./results-connectivity.js"
import {
  resolveTournamentConfig,
  playerIdOf,
  pairDirOf,
  cellDirOf,
  deriveSeed,
  injectedEnvOf,
  type ResolvedTournament,
  type TournamentModel,
  type TournamentConfig,
} from "./tournament-config.js"
import {
  loadState,
  saveState,
  isDone,
  markDone,
  recordFailure,
  countDone,
  type TournamentState,
} from "./tournament-state.js"
import { buildEvidenceGroups } from "./tournament-evidence.js"
import { collectResults } from "./tournament-export.js"
import { enumerateSchedule, type BatchSpec } from "./tournament-schedule.js"
import { archiveColdRounds, countArchivedTarballs } from "./tournament-archive.js"
import { createSerializedSaver, resolveBucketConcurrency, runBucketedPool, runPool, spawnPnpmAsync } from "./async-pool.js"
import {
  battleKey,
  installWake,
  runBattleScheduler,
  type WakeSignal,
} from "./tournament-scheduler.js"

// ── 常量 ─────────────────────────────────────────────────────────────────

/** author/reflect 单次子进程超时（harness 4 轮 × 长推理模型单轮 20-40 分钟实测，4h 余量） */
const LLM_TIMEOUT_MS = 4 * 60 * 60 * 1000
/** battle 单批超时（引擎零 LLM；30 局分钟级，留 2h 余量） */
const BATTLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const AUTHOR_ATTEMPTS = 3
const REFLECT_ATTEMPTS = 2
const ANALYZE_BOOTSTRAP = 200

// ── 运行上下文 ───────────────────────────────────────────────────────────

interface Ctx {
  config: TournamentConfig
  resolved: ResolvedTournament
  outRoot: string
  statePath: string
  state: TournamentState
  /** gi-agent 包目录（子进程 cwd） */
  giRoot: string
  benchmarkRoot: string
  treeBenchRoot: string
  roundFilter: number | undefined
  denseSubset: number | undefined
  /** battle 调度器唤醒钩子（pipeline 模式由 battleScheduler 安装；producer markDone 后
   *  经 notifyStateChange 触发重扫；缺省未安装时为 no-op） */
  wakeScheduler?: () => void
}

function fail(message: string): never {
  console.error(`[fatal] ${message}`)
  process.exit(1)
}

/** state.json 落盘互斥：并行 LLM worker 对内存对象 markDone/recordFailure 后排队整体落盘 */
const saveStateSerialized = createSerializedSaver((ctx: Ctx) => saveState(ctx.statePath, ctx.state))

/** producer 状态变更后唤醒 battle 调度器（未安装时 no-op——独立子命令模式） */
function notifyStateChange(ctx: Ctx): void {
  ctx.wakeScheduler?.()
}

/** LLM 单元并发度全局上限（config.llmConcurrency，缺省 3，钳制 1-8——API 限速友好） */
function llmConcurrencyOf(config: TournamentConfig): number {
  return resolveBucketConcurrency(config.llmConcurrency, 3)
}

/**
 * 逐模型分桶上限：model.concurrency ?? 全局 llmConcurrency（两者同口径钳 1-8）。
 * 缺省（旧 config 无该字段）→ 每模型上限 = 全局值（等价于全局池行为，增量兼容）。
 */
function modelLimitsOf(config: TournamentConfig): Map<string, number> {
  const global = llmConcurrencyOf(config)
  return new Map(config.models.map((m) => [m.name, resolveBucketConcurrency(m.concurrency, global)]))
}

/** 分桶日志（中文简洁）：`name=上限` 列表 */
function formatModelLimits(limits: Map<string, number>): string {
  return [...limits].map(([name, n]) => `${name}=${n}`).join("，")
}

/** battle 批进程并发度（config.concurrency，缺省 4，钳制 1-8——对齐设备核数） */
function battleConcurrencyOf(config: TournamentConfig): number {
  const n = config.concurrency
  if (!Number.isInteger(n) || (n as number) < 1) return 4
  return Math.min(n as number, 8)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** 原子 JSON 写盘（临时文件 + rename，失败兜底直写） */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, text, "utf-8")
    await rename(tmp, path)
  } catch {
    await writeFile(path, text, "utf-8")
  }
}

/** 子进程统一封装（Windows 下 pnpm 是 .cmd——shell: true） */
function spawnPnpm(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { ok: boolean; output: string; timedOut: boolean } {
  const res = spawnSync("pnpm", args, {
    cwd: opts.cwd,
    // 逐模型凭据注入（impl-spec-1 §4.1）：opts.env 必须真正传给子进程——
    // 否则 author/reflect 子进程永远拿不到 OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL
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

/** 引擎侧一致性错误（版本错配/对手对齐）检测——命中即 fail-fast（impl-spec-0 §2.5） */
function isEngineConsistencyError(output: string): boolean {
  return output.includes("对手错位") || (output.includes("gameVersion") && output.includes("冲突"))
}

// ── 路径约定（outRoot 下；impl-spec-1 §3）────────────────────────────────

const plansDir = (ctx: Ctx, model: string, env: string): string => join(ctx.outRoot, "plans", model, env)
const portfolioDir = (ctx: Ctx, model: string, env: string, di: number): string =>
  join(ctx.outRoot, "portfolios", model, env, String(di))
const portfolioManifestPath = (ctx: Ctx, model: string, env: string, di: number): string =>
  join(portfolioDir(ctx, model, env, di), "portfolio.json")
const battlesCellDir = (ctx: Ctx, pairName: string, env: string, di: number, dj: number): string =>
  join(ctx.outRoot, "battles", pairName, env, cellDirOf(di, dj))

/** 对手侧格树：r0 = plans/<model>/<env>/single.<hold>-vs-<opp>.r0.json；
 *  r ≥ 1 = portfolios/<model>/<env>/<hold>/plans/single.<opp>.r<r>.json */
function singleTreePath(ctx: Ctx, model: string, env: string, round: number, holdIdx: number, oppIdx: number): string {
  return round === 0
    ? join(plansDir(ctx, model, env), `single.${holdIdx}-vs-${oppIdx}.r0.json`)
    : join(portfolioDir(ctx, model, env, holdIdx), "plans", `single.${oppIdx}.r${round}.json`)
}

/** 环境元素（label → resolved envs 条目） */
function envOf(ctx: Ctx, envLabel: string): ResolvedTournament["envs"][number] {
  const e = ctx.resolved.envs.find((x) => x.label === envLabel)
  if (!e) fail(`环境 ${envLabel} 不在 config 中`)
  return e
}

// ── 初始化 ───────────────────────────────────────────────────────────────

async function initCtx(configPath: string, roundFilter?: number, denseSubset?: number): Promise<Ctx> {
  const raw = JSON.parse(await readFile(configPath, "utf-8")) as unknown
  const resolved = resolveConfigOrDie(raw)
  const giRoot = process.cwd()
  const outRoot = resolve(giRoot, resolved.config.outRoot)
  await mkdir(outRoot, { recursive: true })
  // tournament.resolved.json：展开后的运行时 config（含解析 deck 摘要；无 key）
  await writeJson(join(outRoot, "tournament.resolved.json"), {
    resolvedAt: new Date().toISOString(),
    configPath,
    models: resolved.config.models,
    environments: resolved.envs.map((e) => ({
      label: e.label,
      gameVersion: e.gameVersion,
      decks: e.deckSummaries,
    })),
    gamesPerCell: resolved.config.gamesPerCell,
    rounds: resolved.config.rounds,
    evidenceScope: resolved.config.evidenceScope,
    seedBase: resolved.config.seedBase,
    gameArchive: resolved.config.gameArchive,
    concurrency: resolved.config.concurrency ?? 4,
  })
  const statePath = join(outRoot, "state.json")
  const state = await loadState(statePath, configPath)
  return {
    config: resolved.config,
    resolved,
    outRoot,
    statePath,
    state,
    giRoot,
    benchmarkRoot: resolve(giRoot, "../benchmark"),
    treeBenchRoot: resolve(giRoot, "../benchmark/tree-bench"),
    roundFilter,
    denseSubset,
  }
}

function resolveConfigOrDie(raw: unknown): ResolvedTournament {
  try {
    return resolveTournamentConfig(raw)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

// ── 通用 LLM 子进程（author / reflect；失败隔离 + 重试）──────────────────

async function runLlmSubprocess(
  ctx: Ctx,
  model: TournamentModel,
  envInjection: NodeJS.ProcessEnv,
  key: string,
  script: "plan:author" | "plan:reflect",
  args: string[],
  attempts: number,
): Promise<boolean> {
  let lastOutput = ""
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`[${script}] ${key}（attempt ${attempt}/${attempts}）`)
    const r = await spawnPnpmAsync(["run", script, "--", ...args], {
      cwd: ctx.giRoot,
      env: envInjection,
      timeoutMs: LLM_TIMEOUT_MS,
    })
    if (r.ok) {
      markDone(ctx.state, key)
      await saveStateSerialized(ctx)
      notifyStateChange(ctx)
      return true
    }
    lastOutput = r.output
    console.error(`[${script}] ${key} attempt ${attempt} 失败${r.timedOut ? "（超时）" : ""}：\n${tail(r.output)}`)
    if (attempt < attempts) await sleep(5000)
  }
  recordFailure(ctx.state, key, script === "plan:author" ? "author" : "evolve", lastOutput || "未知错误（无输出）")
  await saveStateSerialized(ctx)
  notifyStateChange(ctx)
  return false
}

async function finishWithFailureCheck(ctx: Ctx, subcommand: string): Promise<void> {
  await saveState(ctx.statePath, ctx.state)
  const failures = ctx.state.failures.filter((f) => f.subcommand === subcommand)
  if (failures.length > 0) {
    console.error(`\n[${subcommand}] ${failures.length} 个失败（可重跑本子命令只补缺）：`)
    for (const f of failures) console.error(`  - ${f.key}：${f.error.split("\n")[0]?.slice(0, 200)}`)
    process.exit(1)
  }
}

// ── author（r0；唯一大 LLM 阶段；impl-spec-1 §4.1）────────────────────────

async function cmdAuthor(ctx: Ctx): Promise<void> {
  await authorProducer(ctx)
  await finishWithFailureCheck(ctx, "author")
}

/**
 * author 生产者（cmdAuthor 的工件部分；pipeline 模式与 battleScheduler 并发跑）：
 * 全部起草调用 + 逐 di 内联 manifest 组装。起草调用按模型分桶（每模型一个独立有界池，
 * 上限 = model.concurrency ?? 全局 llmConcurrency）——慢供应商不队头阻塞其余模型。
 *
 * manifest 组装不再集中到最后：每个 (model, env, di) 有 D+1 个 callTask（D 个 single
 * + 1 个 general），经 per-di 计数器在全部结束时立即触发组装（fire-and-forget + 末尾
 * await 全部）——pipeline 模式下 battle 调度器因此能在 producer 仍在推进其余 di 时
 * 就拿到就绪 manifest。调用失败的 di 在 producer 收尾时仍会尝试组装并如实记录
 * 「计划缺失」失败（含凭据失败模型——无任何 callTask，收尾兜底触发）。
 */
async function authorProducer(ctx: Ctx): Promise<void> {
  const { config } = ctx
  const concurrency = llmConcurrencyOf(config)
  const modelLimits = modelLimitsOf(config)
  // 阶段 A 任务收集：一次起草调用 = 一个任务（single 逐格 + general），相互独立
  // （独立凭据注入 / 独立 --out / 独立 state key）→ 有界工作池并行；
  // 凭据检查与目录/opponent-set 准备（失败隔离）仍在收集阶段串行完成。
  interface AuthorCallTask {
    model: TournamentModel
    env: ResolvedTournament["envs"][number]
    envInjection: NodeJS.ProcessEnv
    kind: "single" | "general"
    di: number
    dj: number
  }
  const callTasks: AuthorCallTask[] = []
  for (const env of ctx.resolved.envs) {
    const { label: envLabel } = env
    for (const model of config.models) {
      // 凭据存在性逐模型检查（失败隔离——无效 apiKeyEnv 不拖垮其余模型；只列名不打印值）
      let envInjection: NodeJS.ProcessEnv
      try {
        envInjection = injectedEnvOf(model)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        recordFailure(ctx.state, `author|${model.name}|${envLabel}|credentials`, "author", reason)
        console.error(`[author] 模型 ${model.name}（${envLabel}）全部跳过：${reason}`)
        continue
      }
      const mPlans = plansDir(ctx, model.name, envLabel)
      await mkdir(mPlans, { recursive: true })
      // opponent-set 文件（General 起草；全部环境卡组，一行一个）
      const opponentSetPath = join(mPlans, "opponent-set.txt")
      if (!(await pathExists(opponentSetPath))) {
        await writeFile(opponentSetPath, `${env.decks.join("\n")}\n`, "utf-8")
      }
      for (let di = 0; di < env.decks.length; di++) {
        for (let dj = 0; dj < env.decks.length; dj++) {
          callTasks.push({ model, env, envInjection, kind: "single", di, dj })
        }
        callTasks.push({ model, env, envInjection, kind: "general", di, dj: -1 })
      }
    }
  }
  // per-di 计数器：D+1 个 callTask 全结束（成功或失败）即触发该 di 的 manifest 组装
  const remaining = new Map<string, number>()
  const fired = new Set<string>()
  const assemblies: Array<Promise<void>> = []
  const fireAssembly = (model: TournamentModel, env: ResolvedTournament["envs"][number], di: number): void => {
    const k = `${model.name}|${env.label}|${di}`
    if (fired.has(k)) return
    fired.add(k)
    const manifestKey = `author|${model.name}|${env.label}|manifest|${di}`
    assemblies.push((async () => {
      if (!isDone(ctx.state, manifestKey)) {
        try {
          await assembleR0Manifest(ctx, model.name, env.label, env, di)
          markDone(ctx.state, manifestKey)
        } catch (e) {
          recordFailure(ctx.state, manifestKey, "author", e instanceof Error ? e.message : String(e))
        }
        await saveStateSerialized(ctx)
        notifyStateChange(ctx)
      }
    })())
  }
  const onCallTaskDone = (t: AuthorCallTask): void => {
    const k = `${t.model.name}|${t.env.label}|${t.di}`
    // Map 读改写间无 await（JS 单线程，原子）；初值 = D 个 single + 1 个 general
    const left = (remaining.get(k) ?? t.env.decks.length + 1) - 1
    remaining.set(k, left)
    if (left <= 0) fireAssembly(t.model, t.env, t.di)
  }
  const activeLimits = new Map<string, number>()
  for (const t of callTasks) activeLimits.set(t.model.name, modelLimits.get(t.model.name) ?? concurrency)
  console.log(`[author] 起草 LLM 调用共 ${callTasks.length} 个（逐模型分桶并发：${formatModelLimits(activeLimits)}）`)
  await runBucketedPool(callTasks, (t) => t.model.name, (name) => modelLimits.get(name) ?? concurrency, async (t) => {
    try {
      const { model, env, envInjection, kind, di, dj } = t
      const { label: envLabel, gameVersion } = env
      const mPlans = plansDir(ctx, model.name, envLabel)
      if (kind === "single") {
        // 1) single 逐格（含 dj=di 镜像格）
        const key = `author|${model.name}|${envLabel}|single|${di}-vs-${dj}`
        const outFile = join(mPlans, `single.${di}-vs-${dj}.r0.json`)
        if (await adoptExistingPlan(ctx, key, outFile)) return
        const seed = deriveSeed(config.seedBase, ["author", model.name, envLabel, di, dj])
        const args = [
          "--deck", env.decks[di]!,
          "--opponent-deck", env.decks[dj]!,
          "--game-version", gameVersion,
          "--out", outFile,
          "--seed", String(seed),
          "--temperature", "0.2",
          "--model", model.model,
          // harness 有界多轮（--turns 4）：同 anchor-experiment.ts authorTasks 的注释——
          // one-shot 对 glm 系推理模型系统性失败，执行方案 author 口径本就是 harness 模式。
          "--turns", "4",
          "--stream",
          // 长推理模型输出上限（qwen 侧发 max_completion_tokens，见 llm.ts）；缺省走 CLI 32768
          ...(model.maxTokens !== undefined ? ["--max-tokens", String(model.maxTokens)] : []),
        ]
        await runLlmSubprocess(ctx, model, envInjection, key, "plan:author", args, AUTHOR_ATTEMPTS)
        return
      }
      // 2) general（--opponent-set；unknown_deck，G2/D3）
      const key = `author|${model.name}|${envLabel}|general|${di}`
      const outFile = join(mPlans, `general.${di}.r0.json`)
      if (await adoptExistingPlan(ctx, key, outFile)) return
      const seed = deriveSeed(config.seedBase, ["author", model.name, envLabel, di, "general"])
      const args = [
        "--deck", env.decks[di]!,
        "--opponent-set", join(mPlans, "opponent-set.txt"),
        "--game-version", gameVersion,
        "--out", outFile,
        "--seed", String(seed),
        "--temperature", "0.2",
        "--model", model.model,
        // harness 有界多轮（--turns 4）：同 anchor-experiment.ts authorTasks 的注释——
        // one-shot 对 glm 系推理模型系统性失败，执行方案 author 口径本就是 harness 模式。
        "--turns", "4",
        "--stream",
        // 长推理模型输出上限（qwen 侧发 max_completion_tokens，见 llm.ts）；缺省走 CLI 32768
        ...(model.maxTokens !== undefined ? ["--max-tokens", String(model.maxTokens)] : []),
      ]
      await runLlmSubprocess(ctx, model, envInjection, key, "plan:author", args, AUTHOR_ATTEMPTS)
    } finally {
      onCallTaskDone(t)
    }
  })
  // producer 收尾：凡未触发组装的 (model, env, di)（凭据失败模型无任何 callTask 等）
  // 仍尝试组装并如实记录失败——「所有 manifest 要么 done 要么 recorded failure」不变
  for (const env of ctx.resolved.envs) {
    for (const model of config.models) {
      for (let di = 0; di < env.decks.length; di++) {
        fireAssembly(model, env, di)
      }
    }
  }
  await Promise.all(assemblies)
  await saveState(ctx.statePath, ctx.state)
  console.log(`[author] producer 完成（manifest 组装 ${fired.size} 个）`)
}

/** 产物已存在且可解析（有 planId）→ 补位标记 done（崩溃/中断后补缺不重跑 LLM） */
async function adoptExistingPlan(ctx: Ctx, key: string, outFile: string): Promise<boolean> {
  if (isDone(ctx.state, key)) return true
  if (await pathExists(outFile)) {
    try {
      const plan = JSON.parse(await readFile(outFile, "utf-8")) as { planId?: unknown }
      if (typeof plan.planId === "string" && plan.planId.length > 0) {
        markDone(ctx.state, key)
        await saveStateSerialized(ctx)
        notifyStateChange(ctx)
        console.log(`[adopt] ${key}：产物已存在（planId=${plan.planId}），跳过起草`)
        return true
      }
    } catch {
      // 损坏产物 → 重跑
    }
  }
  return false
}

/** 读计划文件：缺失或非法 JSON 都抛「计划缺失（或损坏）」——manifest 失败语义统一 */
async function readPlanFileStrict(path: string, what: string): Promise<{ planId?: string }> {
  if (!(await pathExists(path))) throw new Error(`${what}计划缺失：${path}（先补齐 author 调用）`)
  try {
    return JSON.parse(await readFile(path, "utf-8")) as { planId?: string }
  } catch (e) {
    throw new Error(`${what}计划缺失或损坏：${path}（${e instanceof Error ? e.message : String(e)}）`)
  }
}

/** r0 manifest 组装：plans 产物拷入 portfolios/<model>/<env>/<di>/plans/ 并写 portfolio.json
 *  （自校验一次 loadPortfolioWithValidation；G8 不通过即抛错） */
async function assembleR0Manifest(
  ctx: Ctx,
  modelName: string,
  envLabel: string,
  env: ResolvedTournament["envs"][number],
  di: number,
): Promise<void> {
  const mPlans = plansDir(ctx, modelName, envLabel)
  const pDir = portfolioDir(ctx, modelName, envLabel, di)
  const pPlans = join(pDir, "plans")
  await mkdir(pPlans, { recursive: true })
  const generalSrc = join(mPlans, `general.${di}.r0.json`)
  const general = await readPlanFileStrict(generalSrc, "general")
  await writeFile(join(pPlans, "general.r0.json"), `${JSON.stringify(general, null, 2)}\n`, "utf-8")
  const singles: Array<{ opponentDeckCode: string; label: string; planRef: string }> = []
  const singleIds: Record<string, string> = {}
  for (let dj = 0; dj < env.decks.length; dj++) {
    const src = join(mPlans, `single.${di}-vs-${dj}.r0.json`)
    const plan = await readPlanFileStrict(src, "single")
    await writeFile(join(pPlans, `single.${dj}.r0.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf-8")
    singles.push({ opponentDeckCode: env.decks[dj]!, label: String(dj), planRef: `plans/single.${dj}.r0.json` })
    singleIds[String(dj)] = plan.planId ?? ""
  }
  const manifest = {
    version: "PlanPortfolioV1",
    generalPlan: "plans/general.r0.json",
    singles,
    lineage: { generalId: general.planId ?? "", singles: singleIds },
  }
  const manifestPath = portfolioManifestPath(ctx, modelName, envLabel, di)
  await writeJson(manifestPath, manifest)
  await loadPortfolioWithValidation(manifestPath) // 自校验（G8 不通过抛错）
  console.log(`[author] manifest ${modelName}/${envLabel}/${di} OK（singles=${singles.length}）`)
}

// ── evolve（r ≥ 1；impl-spec-1 §4.2）─────────────────────────────────────

async function cmdEvolve(ctx: Ctx): Promise<void> {
  await evolveProducer(ctx)
  await finishWithFailureCheck(ctx, "evolve")
}

/** evolve 生产者（cmdEvolve 的工件部分；pipeline 模式与 battleScheduler 并发跑） */
async function evolveProducer(ctx: Ctx): Promise<void> {
  const { config } = ctx
  const concurrency = llmConcurrencyOf(config)
  const modelLimits = modelLimitsOf(config)
  console.log(`[evolve] LLM 单元逐模型分桶并发：${formatModelLimits(modelLimits)}`)
  const rounds = ctx.roundFilter !== undefined ? [ctx.roundFilter] : range(1, config.rounds)
  for (const r of rounds) {
    for (const env of ctx.resolved.envs) {
      const { label: envLabel, gameVersion } = env
      // 同代同环境内各 portfolio（model × 本方卡组）相互独立 → 逐模型分桶的有界池并行
      // （每模型一个独立池，上限 = model.concurrency ?? 全局值；桶间不共享槽位）；
      // 跨代严格串行（r 的 manifest tag 必须停在 r-1，r-1 反思完成后才轮到 r）。
      interface EvolveTask { model: TournamentModel; di: number }
      const tasks: EvolveTask[] = []
      for (const model of config.models) {
        for (let di = 0; di < env.decks.length; di++) {
          tasks.push({ model, di })
        }
      }
      await runBucketedPool(tasks, (t) => t.model.name, (name) => modelLimits.get(name) ?? concurrency, async (t) => {
        const { model, di } = t
        const manifestPath = portfolioManifestPath(ctx, model.name, envLabel, di)
        if (!(await pathExists(manifestPath))) return // r0 尚未起草
        const currentTag = manifestRoundTag(manifestPath)
        if (currentTag === null || currentTag !== r - 1) return // 不在该代（已进化或未到）
        const key = `evolve|${model.name}|${envLabel}|${di}|r${r}`
        if (isDone(ctx.state, key)) return
        // 凭据检查（失败隔离）
        let envInjection: NodeJS.ProcessEnv
        try {
          envInjection = injectedEnvOf(model)
        } catch (e) {
          recordFailure(ctx.state, key, "evolve", e instanceof Error ? e.message : String(e))
          notifyStateChange(ctx)
          return
        }
        console.log(`[evolve] ${model.name}/${envLabel}/${di} r${r - 1} → r${r}`)
        // own-generations 证据组装（引擎侧一致性错误 fail-fast——buildEvidenceGroups 抛错即中断）
        const evidence = await buildEvidenceGroups({
          outRoot: ctx.outRoot,
          envLabel,
          gameVersion,
          deckCodes: env.decks,
          model: model.name,
          holdIndex: di,
          round: r,
          manifestPath,
        }).catch((e: unknown) => fail(`evolve 证据组装失败（${model.name}/${envLabel}/${di}/r${r}）：${e instanceof Error ? e.message : String(e)}`))
        if (evidence.groups.length === 0) {
          console.warn(`[evolve] ${key}：无 r${r - 1} 对局证据（先跑 battle）——跳过`)
          return
        }
        console.log(`[evolve] ${key}：证据 ${evidence.groups.length} 组 / ${evidence.totalGames} 局（跳过重建 ${evidence.groups.filter((g) => g.skipped).length} 组）`)
        const seed = deriveSeed(config.seedBase, ["reflect", model.name, envLabel, di, r])
        const args = [
          "--run-dir", evidence.groups.map((g) => g.dir).join(","),
          "--side", "0",
          "--portfolio", manifestPath,
          "--round", String(r),
          "--evidence", "engine-only",
          "--patch",
          // patch 修订协议只存在于 harness 多轮模式（run-plan-reflect.ts：--patch
          // 在 harness 模式上启用；turns=1 的 one-shot 路径整体忽略 --patch，且
          // one-shot portfolio 模式 singles 恒原样保留——singles 层将无法被修订）。
          // turns=4 = patch 命令 + final（finalGate 打回一次也有余量）。
          "--turns", "4",
          "--out", portfolioDir(ctx, model.name, envLabel, di),
          "--seed", String(seed),
          "--temperature", "0.2",
          "--model", model.model,
          "--stream",
          // 长推理模型输出上限（qwen 侧发 max_completion_tokens，见 llm.ts）；缺省走 CLI 32768
          ...(model.maxTokens !== undefined ? ["--max-tokens", String(model.maxTokens)] : []),
        ]
        await runLlmSubprocess(ctx, model, envInjection, key, "plan:reflect", args, REFLECT_ATTEMPTS)
        await saveStateSerialized(ctx)
      })
    }
  }
  await saveState(ctx.statePath, ctx.state)
  console.log(`[evolve] producer 完成（rounds=${rounds.join(",")}）`)
}

/** manifest 当代号（generalPlan 文件名 tag plans/general.r<N>.json → N）；解析失败 null。
 *  同步读（小 JSON）：供 batchReady 的就绪判定使用（扫描路径上每批一次）。 */
function manifestRoundTag(manifestPath: string): number | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as { generalPlan?: string }
    const match = /general\.r(\d+)\.json$/.exec(m.generalPlan ?? "")
    return match ? Number(match[1]!) : null
  } catch {
    return null
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

// ── battle（引擎批跑，零 LLM；impl-spec-1 §4.3）──────────────────────────

/** 赛程枚举（纯逻辑在 tournament-schedule.ts；此处只做 Ctx → 入参映射） */
function enumerateBatches(ctx: Ctx): BatchSpec[] {
  return enumerateSchedule({
    models: ctx.config.models.map((m) => m.name),
    envs: ctx.resolved.envs.map((e) => ({ label: e.label, deckCount: e.decks.length })),
    rounds: ctx.config.rounds,
    ...(ctx.roundFilter !== undefined ? { roundFilter: ctx.roundFilter } : {}),
    ...(ctx.config.schedule !== undefined ? { schedule: ctx.config.schedule } : {}),
  })
}

function batchReady(ctx: Ctx, spec: BatchSpec): boolean {
  const manifestPath = portfolioManifestPath(ctx, spec.planModel, spec.envLabel, spec.di)
  if (!existsSync(manifestPath)) return false
  // plan 侧 manifest 的代 tag 必须已推进到 planRound（r0 manifest 天然 tag=0 恒过；
  // r≥1 防止 evolve 尚未把 tag 推到 r 时，链批拿 r-1 的树冒充 r 代开跑——pipeline
  // 调度器与 evolve producer 并发，battle 子命令单独跑 r≥1 同样受此闸保护）
  if (manifestRoundTag(manifestPath) !== spec.planRound) return false
  // 跨代批（链批 X@r vs X@(r-k)、跨模型跨代 X@r vs Y@s）：对手侧格树取自对手 portfolio
  // 的第 oppRound 代，故要求对手侧 manifest 已推进到该代（tag 单调递增；不取等号——
  // 同一 portfolio 更新代后仍保留并引用旧代格树文件（文件名含代 tag，内容不被覆盖），
  // 且 di==dj 的链批 plan/对手侧是同一个 manifest，等号判定会恒不成立）。
  if (spec.planRound !== spec.oppRound) {
    const oppManifestPath = portfolioManifestPath(ctx, spec.oppModel, spec.envLabel, spec.dj)
    if (!existsSync(oppManifestPath)) return false
    const oppTag = manifestRoundTag(oppManifestPath)
    if (oppTag === null || oppTag < spec.oppRound) return false
  }
  return existsSync(singleTreePath(ctx, spec.oppModel, spec.envLabel, spec.oppRound, spec.dj, spec.di))
}

/** 单批执行（cmdBattle 与 battleScheduler 共用）：版本钉扎断言 → batchConfig 写盘 →
 *  plan:batch 子进程 → 失败隔离（引擎一致性错误 fail-fast）→ state log 抽样归档 */
async function runBattleBatch(
  ctx: Ctx,
  spec: BatchSpec,
  env: ResolvedTournament["envs"][number],
  configsDir: string,
): Promise<void> {
  const key = battleKey(spec)
  // 版本钉扎断言（fail-fast，报错含两版本名；不放行 --force）
  // 注意：plan 侧断言目标是 portfolio 的 **general 计划树**（manifest 本身无
  // context.gameVersion——直接对 manifest 断言会在首个批恒 fail-fast）。
  // 树文件损坏（非法 JSON）≠ 版本错配：隔离记失败继续其余批（版本错配仍 fail-fast）
  try {
    await assertTreeVersion(await portfolioGeneralTreePath(portfolioManifestPath(ctx, spec.planModel, spec.envLabel, spec.di)), "plan 侧 portfolio general", env.gameVersion)
    await assertTreeVersion(singleTreePath(ctx, spec.oppModel, spec.envLabel, spec.oppRound, spec.dj, spec.di), "opponent 格树", env.gameVersion)
  } catch (e) {
    // assertTreeVersion 的版本错配路径走 fail()（进程即刻退出，不会到这里）——
    // 能被 catch 的只有文件缺失/损坏（ENOENT、非法 JSON）→ 隔离记失败继续其余批
    recordFailure(ctx.state, key, "battle", `树断言失败：${e instanceof Error ? e.message : String(e)}`)
    await saveStateSerialized(ctx)
    console.error(`[battle] ${key} 树断言失败（已记录，继续其余批）`)
    return
  }
  const pairName = pairDirOf(playerIdOf(spec.planModel, spec.planRound), playerIdOf(spec.oppModel, spec.oppRound))
  const seedBase = deriveSeed(ctx.config.seedBase, ["battle", pairName, spec.envLabel, spec.di, spec.dj, spec.round])
  const outDir = battlesCellDir(ctx, pairName, spec.envLabel, spec.di, spec.dj)
  const batchConfig = {
    portfolio: portfolioManifestPath(ctx, spec.planModel, spec.envLabel, spec.di),
    opponent: { type: "plan", planFile: singleTreePath(ctx, spec.oppModel, spec.envLabel, spec.oppRound, spec.dj, spec.di) },
    opponentDeckCode: env.decks[spec.dj]!,
    games: 2 * ctx.config.gamesPerCell,
    seedBase,
    alternateFirstPlayer: true,
    // 批内固定 1：引擎在单 node 进程内是单线程（批内 >1 只重叠 I/O，冒烟实测
    // wall≈引擎串行时间）；并行度来自批间进程池（config.concurrency，默认 4 核对齐）
    concurrency: 1,
    outDir,
    gameVersion: env.gameVersion,
    // trace 签名 lean 化（impl-spec-1 件 1）：单局产物 1.87MB → ≤0.45MB（签名改
    // 短哈希指针，消费侧从 state log 反查）。tournament.json traceSignatures 可覆盖。
    traceSignatures: ctx.config.traceSignatures ?? "lean",
  }
  const configPath = join(configsDir, `${sanitizeKey(key)}.json`)
  await writeJson(configPath, batchConfig)
  console.log(`[battle] ${key}（${batchConfig.games} 局，seedBase=${seedBase}${spec.isChain ? "，链批" : ""}）`)
  const r = await spawnPnpmAsync(["run", "plan:batch", "--", configPath], { cwd: ctx.giRoot, timeoutMs: BATTLE_TIMEOUT_MS })
  if (!r.ok) {
    if (isEngineConsistencyError(r.output)) {
      fail(`battle 引擎一致性断言失败（${key}）——fail-fast：\n${tail(r.output, 20)}`)
    }
    recordFailure(ctx.state, key, "battle", `${r.timedOut ? "超时；" : ""}${tail(r.output, 14)}`)
    await saveStateSerialized(ctx)
    console.error(`[battle] ${key} 失败（已记录，继续其余批）`)
    return
  }
  markDone(ctx.state, key)
  await saveStateSerialized(ctx)
  // state log 归档：链批恒全量（organizer 试点）；跨模型批按 seed 确定性抽样
  const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf-8")) as { perGame?: Array<{ gameDir: string; seed: number }> }
  await sampleStateLogs(ctx, outDir, summary.perGame ?? [], spec.isChain)
}

async function cmdBattle(ctx: Ctx): Promise<void> {
  const configsDir = join(ctx.outRoot, "configs")
  await mkdir(configsDir, { recursive: true })
  const battleConcurrency = battleConcurrencyOf(ctx.config) // 批进程并发（默认 4，对齐设备核数）
  const specs = enumerateBatches(ctx).filter((s) => ctx.roundFilter === undefined || s.round === ctx.roundFilter)
  interface BattleTask { spec: BatchSpec; env: ResolvedTournament["envs"][number] }
  const tasks: BattleTask[] = []
  for (const spec of specs) {
    if (isDone(ctx.state, battleKey(spec))) continue
    if (!(await batchReady(ctx, spec))) continue // 依赖未就绪（author/evolve 未完成），下次再跑
    tasks.push({ spec, env: envOf(ctx, spec.envLabel) })
  }
  let attempted = 0
  console.log(`[battle] 待跑批 ${tasks.length}（批进程并发 ${battleConcurrency}，批内 1 局在飞）`)
  await runPool(tasks, battleConcurrency, async (t) => {
    attempted++
    await runBattleBatch(ctx, t.spec, t.env, configsDir)
  })
  await saveState(ctx.statePath, ctx.state)
  if (attempted === 0) console.log("[battle] 无待跑批（全部完成或依赖未就绪）")
  await finishWithFailureCheck(ctx, "battle")
}

// ── battle 调度器（pipeline「生成即赛」；impl-spec-1 §4.7）────────────────

/**
 * battle 调度器：与 LLM producer 并发，持续把「依赖已就绪」的批跑掉。
 * - 生产者 markDone 后经 ctx.wakeScheduler 唤醒（事件驱动）+ 10s 重扫兜底；
 * - producer 结束后 drain：把仍就绪的批跑完；仍 not-ready 的批 recordFailure
 *   「依赖未就绪」（不写 done 位图——后续 invocation 重试不受阻）；
 * - 同一 invocation 内已尝试（含失败）的批不重试（runBattleScheduler 内 attempted 集）。
 */
async function battleScheduler(ctx: Ctx, round: number, producerDone: Promise<void>, wakeup?: WakeSignal): Promise<void> {
  const configsDir = join(ctx.outRoot, "configs")
  await mkdir(configsDir, { recursive: true })
  const signal = wakeup ?? installWake(ctx)
  const specs = enumerateBatches({ ...ctx, roundFilter: round })
  const battleConcurrency = battleConcurrencyOf(ctx.config)
  console.log(`[battle] 调度器启动（round ${round}，赛程 ${specs.length} 批，批进程并发 ${battleConcurrency}；producer 结束前每 10s 重扫兜底）`)
  const result = await runBattleScheduler<BatchSpec>({
    specs,
    keyOf: battleKey,
    isDone: (key) => isDone(ctx.state, key),
    isReady: (spec) => batchReady(ctx, spec),
    runBatch: (spec) => runBattleBatch(ctx, spec, envOf(ctx, spec.envLabel), configsDir),
    onNotReady: (spec, key) => {
      recordFailure(ctx.state, key, "battle", `依赖未就绪（上游 author/evolve 失败或未生成）：${missingDepDesc(ctx, spec)}`)
    },
    producerDone,
    wakeup: signal,
    concurrency: battleConcurrency,
  })
  await saveStateSerialized(ctx)
  console.log(`[battle] 调度器结束：派发 ${result.dispatched} 批，依赖未就绪 ${result.notReady} 批${result.notReady > 0 ? "（已记录失败；recordFailure 不写 done 位图，后续 invocation 重试不受阻）" : ""}`)
}

/** 依赖未就绪的具体缺口（plan manifest / opponent manifest / 对手格树）——失败信息可操作性 */
function missingDepDesc(ctx: Ctx, spec: BatchSpec): string {
  const manifestMissing = !existsSync(portfolioManifestPath(ctx, spec.planModel, spec.envLabel, spec.di))
  if (manifestMissing) return `缺 plan 侧 manifest（${spec.planModel}/${spec.envLabel}/${spec.di}）`
  if (spec.planRound !== spec.oppRound) {
    const oppManifestPath = portfolioManifestPath(ctx, spec.oppModel, spec.envLabel, spec.dj)
    if (!existsSync(oppManifestPath)) return `缺 opponent 侧 manifest（${spec.oppModel}/${spec.envLabel}/${spec.dj}）`
    const oppTag = manifestRoundTag(oppManifestPath)
    if (oppTag === null || oppTag < spec.oppRound) {
      return `opponent 侧 manifest 未推进到 r${spec.oppRound}（当前 tag=${oppTag ?? "不可解析"}，${spec.oppModel}/${spec.envLabel}/${spec.dj}）`
    }
  }
  return `缺 opponent 格树（${spec.oppModel}@r${spec.oppRound} 持 ${spec.dj}-vs-${spec.di}）`
}

// ── pipeline（「生成即赛」；impl-spec-1 §4.7）────────────────────────────

/**
 * 最小未完成代自动判定：
 * - 存在未 done 的 r0 battle 批 → 0；
 * - 否则最小 r（1..rounds）使该代有 evolve 或 battle 未 done；
 * - 全部完成 → null（无事可做）。
 */
function decidePipelineRound(ctx: Ctx): number | null {
  if (enumerateBatches({ ...ctx, roundFilter: 0 }).some((s) => !isDone(ctx.state, battleKey(s)))) return 0
  for (let r = 1; r <= ctx.config.rounds; r++) {
    const evolveUndone = ctx.config.models.some((m) =>
      ctx.resolved.envs.some((e) => e.decks.some((_, di) => !isDone(ctx.state, `evolve|${m.name}|${e.label}|${di}|r${r}`))))
    if (evolveUndone) return r
    if (enumerateBatches({ ...ctx, roundFilter: r }).some((s) => !isDone(ctx.state, battleKey(s)))) return r
  }
  return null
}

/** pipeline 末尾失败汇总（与 finishWithFailureCheck 同语义：重跑补缺成功后不残留） */
async function finishPipeline(ctx: Ctx, subcommands: string[]): Promise<void> {
  await saveState(ctx.statePath, ctx.state)
  const failures = ctx.state.failures.filter((f) => subcommands.includes(f.subcommand))
  if (failures.length > 0) {
    console.error(`\n[pipeline] ${failures.length} 个失败（可重跑 pipeline / battle 只补缺）：`)
    for (const f of failures) console.error(`  - [${f.subcommand}] ${f.key}：${f.error.split("\n")[0]?.slice(0, 200)}`)
    process.exit(1)
  }
}

/**
 * pipeline「生成即赛」：LLM producer（r0=author / r≥1=evolve）与 battle 调度器并发。
 * - 无 --round：自动判定最小未完成代（decidePipelineRound）；
 * - r≥1 前置校验：第 r-1 代全部 battle done（own-generations 证据依赖），否则报错退出；
 * - r≥1 各代之间仍串行（own-generations：evolve r+1 消费 r 的全部对局）——单次
 *   pipeline 只推进一代，多代由多次调用或外层循环衔接；
 * - 资源预算：LLM 单元（逐模型分桶，上限 = model.concurrency ?? llmConcurrencyOf，默认 3）
 *   是网络等待型、battle 批进程（battleConcurrencyOf，默认 4）是 CPU 型，二者天然互补，
 *   无需联动节流；
 * - 不自动跑 export/analyze（饱和判定是人肉环节）。
 */
async function cmdPipeline(ctx: Ctx): Promise<void> {
  const round = ctx.roundFilter ?? decidePipelineRound(ctx)
  if (round === null) {
    console.log("[pipeline] 全部代的 battle/evolve 单元已完成——无事可做（export/analyze 仍需手动跑）")
    return
  }
  if (round > ctx.config.rounds) {
    fail(`--round ${round} 超出 config.rounds=${ctx.config.rounds}`)
  }
  console.log(`[pipeline] 本轮目标：round ${round}（LLM producer 逐模型分桶并发〔全局上限 ${llmConcurrencyOf(ctx.config)}；网络等待型〕与 battle ${battleConcurrencyOf(ctx.config)} 批进程〔CPU 型〕并发，天然互补无需联动节流）`)
  if (round >= 1) {
    // 前置校验：第 r-1 代全部 battle done（evolve r 的 own-generations 证据依赖它）
    const prev = enumerateBatches({ ...ctx, roundFilter: round - 1 })
    const undone = prev.filter((s) => !isDone(ctx.state, battleKey(s)))
    if (undone.length > 0) {
      fail(
        `pipeline r${round} 前置校验失败：第 ${round - 1} 代还有 ${undone.length} 个 battle 批未完成`
        + `（own-generations 证据依赖上一代全量对局——先跑 pipeline / battle --round ${round - 1} 补齐再回来）`,
      )
    }
  }
  const wakeup = installWake(ctx)
  const producer = round === 0 ? authorProducer(ctx) : evolveProducer({ ...ctx, roundFilter: round })
  const scheduler = battleScheduler(ctx, round, producer, wakeup)
  await Promise.all([producer, scheduler])
  await finishPipeline(ctx, round === 0 ? ["author", "battle"] : ["evolve", "battle"])
}

/** manifest → 其 general 计划树路径（manifest JSON 本身无 context.gameVersion，不能直接断言） */
async function portfolioGeneralTreePath(manifestPath: string): Promise<string> {
  const m = JSON.parse(await readFile(manifestPath, "utf-8")) as { generalPlan?: string }
  return join(dirname(manifestPath), m.generalPlan ?? "plans/general.r0.json")
}

/** 树的 context.gameVersion 断言：缺失或不等 → fail-fast（报错含两版本名） */
async function assertTreeVersion(planPath: string, what: string, expected: Version): Promise<void> {  const plan = JSON.parse(await readFile(planPath, "utf-8")) as { context?: { gameVersion?: string } }
  const actual = plan.context?.gameVersion
  if (actual === undefined) {
    fail(`${what}（${planPath}）未声明 context.gameVersion（期望 ${expected}）——树必须按环境版本起草`)
  }
  if (actual !== expected) {
    fail(`${what}（${planPath}）版本 ${actual} 与环境版本 ${expected} 不一致——版本错配 fail-fast`)
  }
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "__")
}

/** state log 抽样归档（seed 确定性）：keep = (seed % 10000)/10000 < rate；链批/率 ≥1 全量保留 */
async function sampleStateLogs(
  ctx: Ctx,
  batchDir: string,
  perGame: Array<{ gameDir: string; seed: number }>,
  isChain: boolean,
): Promise<void> {
  const rate = ctx.config.gameArchive.stateLogSample
  if (isChain || rate >= 1) return
  for (const g of perGame) {
    const logPath = join(batchDir, g.gameDir, "game_state_log.json")
    if (!existsSync(logPath)) continue
    if ((g.seed % 10000) / 10000 < rate) continue
    try {
      await unlink(logPath)
    } catch {
      // 抽样删除失败不阻断（幂等重跑会再试）
    }
  }
}

// ── archive（冷代次压缩归档；impl-spec-1 §4.6，核心在 tournament-archive.ts）──

async function cmdArchive(ctx: Ctx, through: number, includeChain: boolean, dryRun: boolean): Promise<void> {
  // 全量赛程（无视 --round：冷判定需要跨代完整视图——pair 代数取自 BatchSpec，
  // 赛程外 cell 识别需要全部代的 spec；archive 不接受 --round）
  const specs = enumerateBatches({ ...ctx, roundFilter: undefined })
  try {
    await archiveColdRounds({
      outRoot: ctx.outRoot,
      rounds: ctx.config.rounds,
      specs,
      isBattleDone: (key) => isDone(ctx.state, key),
      isEvolveDone: (key) => isDone(ctx.state, key),
      through,
      includeChain,
      dryRun,
    })
  } catch (e) {
    // 打包/校验任何不过 → fail-fast 退出码非 0（已归档 pair 保持幂等，重跑续补）
    fail(e instanceof Error ? e.message : String(e))
  }
}

// ── export（impl-spec-1 §4.4；行收集纯函数在 tournament-export.ts）───────

async function cmdExport(ctx: Ctx): Promise<void> {
  const views = await collectResults(join(ctx.outRoot, "battles"), ctx.resolved.envs.map((e) => e.label))
  const resultsDir = join(ctx.outRoot, "results")
  await mkdir(resultsDir, { recursive: true })
  await writeJson(join(resultsDir, "results.by-model.json"), views.byModel)
  await writeJson(join(resultsDir, "results.by-model-deck.json"), views.byModelDeck)
  if (views.byModelMirror.length > 0) {
    await writeJson(join(resultsDir, "results.by-model.mirror.json"), views.byModelMirror)
    await writeJson(join(resultsDir, "results.by-model-deck.mirror.json"), views.byModelDeckMirror)
  }
  console.log(`[export] by-model=${views.byModel.length} 局（mirror=${views.byModelMirror.length}）；by-model-deck=${views.byModelDeck.length} 局 → ${resultsDir}`)
}

// ── analyze / status（impl-spec-1 §4.5）──────────────────────────────────

async function cmdAnalyze(ctx: Ctx): Promise<void> {
  const resultsDir = join(ctx.outRoot, "results")
  const views: Array<{ file: string; view: string }> = [
    { file: "results.by-model.json", view: "by-model" },
    { file: "results.by-model.mirror.json", view: "by-model-mirror" },
    { file: "results.by-model-deck.json", view: "by-model-deck" },
    { file: "results.by-model-deck.mirror.json", view: "by-model-deck-mirror" },
  ]
  for (const { file, view } of views) {
    const input = join(resultsDir, file)
    if (!(await pathExists(input))) continue
    await warnDisconnectedPool(view, input)
    const outDir = join(ctx.outRoot, "ratings", view)
    await mkdir(outDir, { recursive: true })
    const args = ["analyze", "--input", input, "--out", outDir, "--bootstrap", String(ANALYZE_BOOTSTRAP), "--seed", String(ctx.config.seedBase)]
    if (ctx.denseSubset !== undefined && ctx.denseSubset > 0) args.push("--dense-subset", String(ctx.denseSubset))
    console.log(`[analyze] ${view}（tree-bench）`)
    const r = spawnPnpm(args, { cwd: ctx.benchmarkRoot, timeoutMs: 30 * 60 * 1000 })
    if (!r.ok) {
      fail(`tree-bench analyze 失败（${view}）：\n${tail(r.output, 20)}`)
    }
    markDone(ctx.state, `analyze|${view}`)
    await saveState(ctx.statePath, ctx.state)
  }
  await runPlots(ctx)
  console.log(`[analyze] 完成：ratings/<视角>/ + plots/ → ${ctx.outRoot}`)
}

/**
 * Glicko-2 池连通性预检（results-connectivity.ts）：断连分量各自结算、分数互不可比
 * （heatmap 对无对局格填 0.5、spin-top 自动缩稠密子块，都不显式暴露池裂开）。
 * 只告警不阻断——tree-bench 仍照跑，读数由调用方按分量注记。
 * 两层：整体图（全代累积池）+ 逐 period 当期图（每期更新是否可比）。
 */
async function warnDisconnectedPool(view: string, input: string): Promise<void> {
  let rows: unknown
  try {
    rows = JSON.parse(await readFile(input, "utf-8"))
  } catch (e) {
    console.warn(`[analyze] ${view}：results 解析失败，跳过连通性预检（${e instanceof Error ? e.message : String(e)}）`)
    return
  }
  if (!Array.isArray(rows)) {
    console.warn(`[analyze] ${view}：results 不是数组，跳过连通性预检`)
    return
  }
  const games = rows as Array<{ p1: string; p2: string; winner?: string; period?: number }>
  const overall = buildPlayerGraph(games)
  const playerCount = overall.components.reduce((a, c) => a + c.length, 0)
  console.log(
    `[analyze] ${view}：连通分量 ${overall.componentCount}（选手 ${playerCount}`
    + `，已交手对 ${overall.pairsPlayed}/${overall.pairsTotal}`
    + `${overall.isolatedPlayers.length > 0 ? `，孤立选手 ${overall.isolatedPlayers.join(",")}` : ""}）`,
  )
  if (overall.componentCount > 1) {
    console.warn(`[analyze] ${view} WARNING：Glicko-2 池不连通（${overall.componentCount} 个分量，分量间评分不可比）：`)
    for (const comp of overall.components) console.warn(`  - {${comp.join(", ")}}`)
  }
  const disconnectedPeriods = buildPlayerGraphsByPeriod(games).filter((g) => g.componentCount > 1)
  if (disconnectedPeriods.length > 0) {
    console.warn(`[analyze] ${view} WARNING：以下 rating period 的当期对局图不连通（期内分量间不可比）：`)
    for (const g of disconnectedPeriods) {
      console.warn(`  - r${g.period}（${g.componentCount} 个分量）：${formatComponents(g.components)}`)
    }
  }
}

/** matplotlib 五图（WP3 交付的 plots/plot_*.py；uv run；缺 uv 打警告跳过） */
async function runPlots(ctx: Ctx): Promise<void> {
  const uvCheck = spawnSync("uv", ["--version"], { shell: true, encoding: "utf-8" })
  if (uvCheck.status !== 0) {
    console.warn("[plots] 未检测到 uv（`uv --version` 失败）——跳过绘图；请安装 uv 后重跑 analyze")
    return
  }
  const ratingsDir = join(ctx.outRoot, "ratings")
  const resultsDir = join(ctx.outRoot, "results")
  const plotsDir = join(ctx.outRoot, "plots")
  await mkdir(plotsDir, { recursive: true })
  const jobs: Array<{ script: string; args: string[] }> = [
    { script: "plot_trajectory.py", args: ["--data", join(ratingsDir, "by-model", "ratings-history.json"), "--out", plotsDir] },
    {
      script: "plot_improvement.py",
      args: ["--data", join(resultsDir, "results.by-model.json"), "--ratings-history", join(ratingsDir, "by-model", "ratings-history.json"), "--out", plotsDir],
    },
    { script: "plot_heatmap.py", args: ["--data", join(ratingsDir, "by-model", "heatmap.json"), "--out", plotsDir] },
    { script: "plot_heatmap_deck.py", args: ["--data", join(ratingsDir, "by-model-deck", "heatmap.json"), "--out", plotsDir] },
    { script: "plot_spintop.py", args: ["--data", join(ratingsDir, "by-model", "spin-top.json"), "--out", plotsDir] },
  ]
  for (const job of jobs) {
    const dataPath = job.args[job.args.indexOf("--data") + 1] ?? ""
    if (!(await pathExists(dataPath))) {
      console.warn(`[plots] 缺输入 ${dataPath}——跳过 ${job.script}`)
      continue
    }
    const r = spawnSync("uv", ["run", join(ctx.treeBenchRoot, "plots", job.script), ...job.args], {
      cwd: ctx.treeBenchRoot,
      shell: true,
      encoding: "utf-8",
      timeout: 10 * 60 * 1000,
    })
    if (r.status !== 0) {
      console.warn(`[plots] ${job.script} 失败：\n${tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, 8)}`)
    } else {
      console.log(`[plots] ${job.script} OK`)
    }
  }
}

async function cmdStatus(ctx: Ctx): Promise<void> {
  const s = ctx.state
  console.log(`状态（${ctx.statePath}）`)
  const authorTotal = countDone(s, "author|")
  const evolveTotal = countDone(s, "evolve|")
  const battleTotal = countDone(s, "battle|")
  const analyzeTotal = countDone(s, "analyze|")
  console.log(`  author 完成 ${authorTotal} 单元；evolve 完成 ${evolveTotal}；battle 完成 ${battleTotal} 批；analyze 完成 ${analyzeTotal} 视角`)
  const battlePending = enumerateBatches(ctx).filter((spec) => !isDone(s, battleKey(spec)) && batchReady(ctx, spec)).length
  console.log(`  battle 可跑未跑批：${battlePending}`)
  const archived = await countArchivedTarballs(ctx.outRoot)
  console.log(
    `  已归档 pair：${archived.total}${archived.byRound.length > 0 ? `（${archived.byRound.map((x) => `r${x.round}×${x.count}`).join("，")}）` : ""}`,
  )
  if (s.failures.length > 0) {
    console.log(`  失败清单（${s.failures.length}）：`)
    for (const f of s.failures.slice(-20)) {
      console.log(`    - [${f.subcommand}] ${f.key}（${f.at}）：${f.error.split("\n")[0]?.slice(0, 160)}`)
    }
  } else {
    console.log("  失败清单：无")
  }
  const suggestion = !allAuthorDone(ctx)
    ? "author"
    : battlePending > 0
      ? "battle"
      : countDone(s, "evolve|") < estimateEvolveTotal(ctx)
        ? "evolve（跑完 battle 后）"
        : "export → analyze"
  console.log(`  建议下一步：${suggestion}`)
}

function allAuthorDone(ctx: Ctx): boolean {
  for (const env of ctx.resolved.envs) {
    for (const model of ctx.config.models) {
      for (let di = 0; di < env.decks.length; di++) {
        for (let dj = 0; dj < env.decks.length; dj++) {
          if (!isDone(ctx.state, `author|${model.name}|${env.label}|single|${di}-vs-${dj}`)) return false
        }
        if (!isDone(ctx.state, `author|${model.name}|${env.label}|general|${di}`)) return false
        if (!isDone(ctx.state, `author|${model.name}|${env.label}|manifest|${di}`)) return false
      }
    }
  }
  return true
}

function estimateEvolveTotal(ctx: Ctx): number {
  const D = ctx.resolved.envs.reduce((acc, e) => acc + e.decks.length, 0)
  return ctx.config.models.length * D * ctx.config.rounds
}

// ── 主入口 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--")
  const valueFlags = new Set(["--round", "--dense-subset", "--through"])
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (valueFlags.has(a)) {
      i++
      continue
    }
    if (a.startsWith("--")) continue
    positional.push(a)
  }
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const configPath = positional[0]
  const subcommand = positional[1]
  const validSubcommands = ["author", "evolve", "battle", "pipeline", "export", "analyze", "status", "archive"]
  if (!configPath || !subcommand || !validSubcommands.includes(subcommand)) {
    console.error(`usage: pnpm exec gnx scripts/ops/model-tournament.ts <config.json> <${validSubcommands.join("|")}> [--round <N>] [--dense-subset <N>]`)
    console.error("  archive：--through <N>（必填，归档截止代含）[--include-chain] [--dry-run]")
    console.error("  pipeline：[--round <N>]（缺省自动判定最小未完成代；「生成即赛」LLM producer 与 battle 调度器并发）")
    process.exit(1)
  }
  const roundRaw = get("round")
  const roundFilter = roundRaw !== undefined ? Number(roundRaw) : undefined
  if (roundFilter !== undefined && (!Number.isInteger(roundFilter) || roundFilter < 0)) {
    fail("--round 必须是 ≥0 的整数")
  }
  const denseRaw = get("dense-subset")
  const denseSubset = denseRaw !== undefined ? Number(denseRaw) : undefined
  if (denseSubset !== undefined && (!Number.isInteger(denseSubset) || denseSubset < 0)) {
    fail("--dense-subset 必须是 ≥0 的整数")
  }
  let archiveThrough: number | undefined
  if (subcommand === "archive") {
    const t = get("through")
    if (t === undefined) fail("archive 需要 --through <N>（归档截止代，含；如 --through 2 归档 r0-r2）")
    archiveThrough = Number(t)
    if (!Number.isInteger(archiveThrough) || archiveThrough < 0) {
      fail("--through 必须是 ≥0 的整数")
    }
  }
  const includeChain = argv.includes("--include-chain")
  const dryRun = argv.includes("--dry-run")
  const ctx = await initCtx(configPath, roundFilter, denseSubset)
  console.log(`model-tournament ${subcommand}：outRoot=${ctx.outRoot}，models=${ctx.config.models.length}，envs=${ctx.resolved.envs.map((e) => e.label).join(",")}`)
  switch (subcommand) {
    case "author": await cmdAuthor(ctx); break
    case "evolve": await cmdEvolve(ctx); break
    case "battle": await cmdBattle(ctx); break
    case "pipeline": await cmdPipeline(ctx); break
    case "export": await cmdExport(ctx); break
    case "analyze": await cmdAnalyze(ctx); break
    case "status": await cmdStatus(ctx); break
    case "archive": await cmdArchive(ctx, archiveThrough!, includeChain, dryRun); break
  }
}

await main()
