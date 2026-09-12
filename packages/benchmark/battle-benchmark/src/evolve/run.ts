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

import { spawn } from "node:child_process"
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AssembleError, assembleBattleRecord } from "../record/assemble"
import type { BattleRecord } from "../record/assemble"
import {
  createEmptyKnowledge,
  DEFAULT_KNOWLEDGE_LIMITS,
  loadKnowledge,
  renderKnowledgeForPrompt,
  saveKnowledge,
  SECTION_IDS,
  SECTION_LABELS,
} from "../knowledge/schema"
import type {
  IterationEntry,
  KnowledgeLimits,
  LLMDeckKnowledge,
  MetaInsight,
  SectionId,
} from "../knowledge/schema"
import { buildAlgorithmicContext } from "./context"
import { generatePreGameAnalysis } from "./pre-game"
import { EvolveError } from "./llm-client"
import { compileKnowledgeToRules, renderCompiledRulesForPrompt } from "../knowledge/compile-rules"
import { generateMetaInsight } from "./meta-reflect"
import type { MetaPathway, RoundSummaryStats } from "./meta-reflect"
import { runRoundReflection, summarizeRecords } from "./reflect"
import { makeDefaultCallLlm } from "./reflect"
import type { CallLlm } from "./reflect"

const HELP = `用法: gnx battle-benchmark/src/evolve/run.ts --config <path> [选项]

对某个 matchup 运行 evolve 阶段 1/2：逐轮对局 + LLM 反思（预测/复盘，
以及阶段 2 的 E2 骨干合成与 M4 元反思），把每轮产出的卡组知识沉淀到
outputDir/knowledge/ 下，并输出逐轮报告。

必填:
  --config <path>       evolve 配置 JSON（EvolveConfig）

选项:
  --dry-run             只打印各轮计划（batch-config 与 spawn 命令），不执行任何对局/LLM/文件写入
  --skip-games          跳过对局，直接使用 --games-dir 下已有的 batch summary 结果
  --games-dir <dir>     与 --skip-games 搭配：含 summary.json 的目录（或含 run_* 子目录的父目录），
                        多轮回放支持 {round} 模板（如 work/round{round}/batch-results）
  --resume              断点续跑：扫描各轮已有有效局，达标轮跳过 spawn、不足轮补局；
                        已反思轮跳过反思与 Meta Insight（幂等，可重复执行）
  -h, --help            显示本帮助

环境变量（未在配置中显式给出时兜底）:
  OPENAI_API_BASE       批量对局 API 地址
  OPENAI_API_KEY        LLM 密钥（也用于对局 p0/p1）
`

/** 批量对局配置中单个 matchup 的定义。 */
export interface EvolveMatchup {
  id: string
  deck0: string
  deck1: string
  deck0Name?: string
  deck1Name?: string
}

export interface EvolveConfig {
  runId: string
  matchup: EvolveMatchup
  apiBase?: string
  apiKey?: string
  modelTested: string
  modelOpponent: string
  temperature?: number
  /** 对局 agent 的会话历史上限（成本护栏，双臂一致冻结）；缺省不裁剪 */
  maxHistoryMessages?: number
  /** 备用 API（主 API 配额耗尽时自动切换）；未配置时回退 OPENAI_FALLBACK_* 环境变量 */
  fallbackApi?: { apiBase: string; apiKey: string; model?: string }
  /** 对局 agent 的工具暴露模式；缺省 direct-action。fragmented-decision 需配 systemPromptP0/P1 */
  toolExposureMode?: "direct-action" | "fragmented-decision"
  /** 自定义系统提示词路径（相对仓库根）；缺省用 agent 内置默认 prompt */
  systemPromptP0?: string
  systemPromptP1?: string
  evolution: {
    /** 对局节奏（阶段 2）：ne=每 ne 轮 NE 后触发一次 M4 元反思；me 暂只支持 1（预留多轮元反思节奏） */
    rhythm?: { ne?: number; me?: number }
    /** 参与轮转的反思分节；缺省为全部四节 */
    sections?: SectionId[]
    /** 是否按轮轮转 targetSection；缺省 true */
    sectionRotation?: boolean
    /** 反思算子列表（M4 无建议时的兜底轮换顺序；缺省 ["M1"]） */
    operators?: ("M1" | "E2")[]
    /** E2 来源反思记录条数（最近 K 条，缺省 3） */
    e2K?: number
    /** 是否把当前知识编译为 DSL 规则模板注入（fragmented-decision 模式下使用；缺省 false） */
    compileRules?: boolean
    /** 热启动：round 0 用指定 knowledge JSON 作为起始知识（缺省空知识冷启动） */
    warmStartFrom?: string
    controlArm: "full" | "no-memory" | "warm-start" | "no-meta"
    rounds: number
    gamesPerRound: number
    knowledgeLimit?: { perSection: number; total: number }
  }
  /** 批量对局并发数；缺省 1 */
  concurrency?: number
  /** 批量对局起始端口；缺省 3901 */
  basePort?: number
  outputDir: string
}

/** runEvolve 的可注入选项（主要用于测试与演练）。 */
export interface EvolveRunOptions {
  dryRun?: boolean
  /** 跳过对局，改用既有 batch summary（需配 gamesDir） */
  skipGames?: boolean
  gamesDir?: string
  /** 断点续跑：扫描各轮已有有效局，达标轮跳过、不足轮补局；已反思轮跳过反思 */
  resume?: boolean
  /** 注入 mock LLM 调用器（存在时优先于 apiBase/apiKey/model） */
  callLlm?: CallLlm
}

export interface RoundResult {
  round: number
  gamesPlayed: number
  wins: number
  losses: number
  draws: number
  errors: number
  assembleFailures: number
  knowledgeVersion: number
  reflection: {
    targetSection: SectionId
    predictionAccuracy: "correct" | "partial" | "wrong"
    iteration: IterationEntry
  } | null
}

export interface EvolveReportRound {
  round: number
  winRate: number | null
  wins: number
  losses: number
  draws: number
  errors: number
  knowledgeVersion: number
  targetSection: SectionId | null
  metaGenerated: boolean
}

export interface EvolveReport {
  runId: string
  matchup: EvolveMatchup
  modelTested: string
  modelOpponent: string
  controlArm: "full" | "no-memory" | "warm-start" | "no-meta"
  rhythm?: { ne?: number; me?: number }
  operators?: ("M1" | "E2")[]
  rounds: EvolveReportRound[]
  knowledgeVersions: number[]
  generatedAt: string
}

interface BatchSummaryEntry {
  matchupId?: unknown
  gameIndex?: unknown
  firstPlayer?: unknown
  winner?: unknown
  error?: unknown
  outputDir?: unknown
}

function take(name: string, args: string[], i: number): [string, number] {
  const value = args[i + 1]
  if (value === undefined) {
    fail(`缺少 ${name} 的参数值`)
  }
  return [value, i + 1]
}

function fail(msg: string): never {
  console.error(`[evolve] 错误: ${msg}`)
  process.exit(1)
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value)
}

/** 校验配置的形状；不合法时 fail。 */
function validateConfig(config: unknown): EvolveConfig {
  if (typeof config !== "object" || config === null) {
    fail("配置必须是 JSON 对象")
  }
  const c = config as Record<string, unknown>
  if (typeof c.runId !== "string" || c.runId.length === 0) {
    fail("配置缺少非空字符串 runId")
  }
  const matchup = c.matchup as Record<string, unknown> | undefined
  if (typeof matchup !== "object" || matchup === null) {
    fail("配置缺少 matchup")
  }
  if (typeof matchup.deck0 !== "string" || matchup.deck0.length === 0) {
    fail("matchup.deck0 必须是非空字符串")
  }
  if (typeof matchup.deck1 !== "string" || matchup.deck1.length === 0) {
    fail("matchup.deck1 必须是非空字符串")
  }
  if (typeof matchup.id !== "string" || matchup.id.length === 0) {
    fail("matchup.id 必须是非空字符串")
  }
  if (typeof c.modelTested !== "string" || typeof c.modelOpponent !== "string") {
    fail("modelTested / modelOpponent 必须是字符串")
  }
  const evo = c.evolution as Record<string, unknown> | undefined
  if (typeof evo !== "object" || evo === null) {
    fail("配置缺少 evolution")
  }
  const controlArm = evo.controlArm
  if (
    controlArm !== "full" &&
    controlArm !== "no-memory" &&
    controlArm !== "warm-start" &&
    controlArm !== "no-meta"
  ) {
    fail("evolution.controlArm 必须是 full / no-memory / warm-start / no-meta 之一")
  }
  if (evo.rhythm !== undefined) {
    if (typeof evo.rhythm !== "object" || evo.rhythm === null) {
      fail("evolution.rhythm 必须是对象")
    }
    const r = evo.rhythm as Record<string, unknown>
    if (r.ne !== undefined && (typeof r.ne !== "number" || !Number.isInteger(r.ne) || r.ne < 1)) {
      fail("evolution.rhythm.ne 必须是正整数")
    }
    if (r.me !== undefined && (typeof r.me !== "number" || !Number.isInteger(r.me) || r.me < 1)) {
      fail("evolution.rhythm.me 必须是正整数")
    }
    if (typeof r.me === "number" && r.me > 1) {
      fail("evolution.rhythm.me 只能为 1（当前仅支持每 ne 轮 NE 后触发一次 M4）")
    }
  }
  if (evo.operators !== undefined) {
    if (!Array.isArray(evo.operators) || evo.operators.length === 0) {
      fail("evolution.operators 必须是非空数组")
    }
    for (const op of evo.operators) {
      if (op === "E1") {
        fail("evolution.operators 含 E1：E1 算子尚未实现")
      }
      if (op !== "M1" && op !== "E2") {
        fail(`evolution.operators 含非法算子: ${String(op)}`)
      }
    }
  }
  if (evo.e2K !== undefined && (typeof evo.e2K !== "number" || !Number.isInteger(evo.e2K) || evo.e2K < 1)) {
    fail("evolution.e2K 必须是正整数")
  }
  if (typeof evo.rounds !== "number" || !Number.isInteger(evo.rounds) || evo.rounds < 1) {
    fail("evolution.rounds 必须是正整数")
  }
  if (
    typeof evo.gamesPerRound !== "number" ||
    !Number.isInteger(evo.gamesPerRound) ||
    evo.gamesPerRound < 1
  ) {
    fail("evolution.gamesPerRound 必须是正整数")
  }
  if (evo.sections !== undefined) {
    if (!Array.isArray(evo.sections) || evo.sections.length === 0) {
      fail("evolution.sections 必须是非空数组")
    }
    for (const s of evo.sections) {
      if (!isSectionId(s)) {
        fail(`evolution.sections 含非法分节: ${String(s)}`)
      }
    }
  }
  if (typeof c.outputDir !== "string" || c.outputDir.length === 0) {
    fail("outputDir 必须是非空字符串")
  }
  if (c.fallbackApi !== undefined) {
    const fb = c.fallbackApi as Record<string, unknown>
    if (fb === null || typeof fb !== "object" || typeof fb.apiBase !== "string" || typeof fb.apiKey !== "string") {
      fail("fallbackApi 必须是含 apiBase/apiKey 字符串的对象（model 可选）")
    }
  }
  if (
    c.toolExposureMode !== undefined &&
    c.toolExposureMode !== "direct-action" &&
    c.toolExposureMode !== "fragmented-decision"
  ) {
    fail("toolExposureMode 必须是 direct-action / fragmented-decision 之一")
  }
  return c as unknown as EvolveConfig
}

/**
 * 在 batch 生成的 summary.json 所在目录中定位它：
 * 优先 <dir>/summary.json，否则在 <dir> 下的 run_* 子目录中找——
 * 同一 batch-results 目录可能累积多次运行的 run_*（重跑/续跑），
 * run_<ISO> 目录名按时间戳字典序递增，取**最后一个**（最新一次运行）。
 */
function findSummaryJson(dir: string): string {
  const direct = join(dir, "summary.json")
  if (existsSync(direct)) {
    return direct
  }
  const runDirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map((entry) => entry.name)
    .sort()
  for (const name of runDirs.reverse()) {
    const candidate = join(dir, name, "summary.json")
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new EvolveError(`找不到 batch summary.json: ${dir}`)
}

/**
 * 汇总一个 batch-results 目录下**所有** run_*（及直挂 summary.json）的 entries，
 * 按时间顺序排列（resume 合并多次运行/补局的产物）。
 */
function collectSummaryEntries(
  dir: string,
): { entry: BatchSummaryEntry; summaryPath: string }[] {
  if (!existsSync(dir)) {
    return []
  }
  const out: { entry: BatchSummaryEntry; summaryPath: string }[] = []
  const direct = join(dir, "summary.json")
  if (existsSync(direct)) {
    for (const entry of readSummaryEntries(direct)) {
      out.push({ entry, summaryPath: direct })
    }
  }
  const runDirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("run_"))
    .map((d) => d.name)
    .sort()
  for (const name of runDirs) {
    const candidate = join(dir, name, "summary.json")
    if (existsSync(candidate)) {
      for (const entry of readSummaryEntries(candidate)) {
        out.push({ entry, summaryPath: candidate })
      }
    }
  }
  return out
}

/** 从 summaryPath 提取其 run_<ISO> 目录名（无则空串），用于 resume 下 recordId/文件名去重。 */
function runSuffixOf(summaryPath: string): string {
  const parent = basename(dirname(summaryPath))
  return parent.startsWith("run_") ? `_${parent.slice(4)}` : ""
}

/** 读取 batch summary，返回 entries（形状宽松，字段逐项防御）。 */
function readSummaryEntries(summaryPath: string): BatchSummaryEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(summaryPath, "utf-8"))
  } catch (err) {
    throw new EvolveError(`无法解析 batch summary ${summaryPath}: ${String(err)}`)
  }
  const summary = parsed as { results?: unknown } | null
  if (typeof summary !== "object" || summary === null || !Array.isArray(summary.results)) {
    throw new EvolveError(`batch summary ${summaryPath} 缺少 results 数组`)
  }
  return summary.results as BatchSummaryEntry[]
}

/** 空知识也恒带四节标题的注入文件内容。 */
function renderInjection(knowledge: LLMDeckKnowledge): string {
  let text = renderKnowledgeForPrompt(knowledge)
  for (const id of SECTION_IDS) {
    if (!text.includes(`### ${SECTION_LABELS[id]}`)) {
      text += `\n### ${SECTION_LABELS[id]}`
    }
  }
  return `${text}\n`
}

/** 构造 batch 子进程参数（dry-run 也用它打印命令；apiKey 单独成参以便掩码）。 */
function buildBatchArgs(opts: {
  config: EvolveConfig
  batchConfigPath: string
  batchResultsDir: string
  apiBase: string
  apiKey: string
}): string[] {
  const { config, batchConfigPath, batchResultsDir, apiBase, apiKey } = opts
  const concurrency = config.concurrency ?? 1
  const basePort = config.basePort ?? 3901
  const scriptPath = resolve(process.cwd(), "packages/mcp/src/headless/run-batch-llm.ts")
  return [
    "exec",
    "gnx",
    scriptPath,
    "--config",
    batchConfigPath,
    "--api-base",
    apiBase,
    "--api-key",
    apiKey,
    "--model-p0",
    config.modelTested,
    "--model-p1",
    config.modelOpponent,
    "--concurrency",
    String(concurrency),
    "--base-port",
    String(basePort),
    "--output-dir",
    batchResultsDir,
    ...(config.fallbackApi?.apiBase && config.fallbackApi?.apiKey
      ? [
          "--fallback-api-base",
          config.fallbackApi.apiBase,
          "--fallback-api-key",
          config.fallbackApi.apiKey,
          ...(config.fallbackApi.model ? ["--fallback-model", config.fallbackApi.model] : []),
        ]
      : []),
    ...(config.toolExposureMode !== undefined
      ? ["--tool-exposure-mode", config.toolExposureMode]
      : []),
    ...(config.systemPromptP0 !== undefined
      ? ["--system-prompt-p0", resolve(process.cwd(), config.systemPromptP0)]
      : []),
    ...(config.systemPromptP1 !== undefined
      ? ["--system-prompt-p1", resolve(process.cwd(), config.systemPromptP1)]
      : []),
  ]
}

async function spawnBatchGames(opts: {
  config: EvolveConfig
  batchConfigPath: string
  batchResultsDir: string
  batchLogPath: string
  apiBase: string
  apiKey: string
}): Promise<void> {
  const { batchLogPath, apiKey } = opts
  const args = buildBatchArgs(opts)
  const secrets = new Set([apiKey, opts.config.fallbackApi?.apiKey ?? ""].filter((s) => s !== ""))
  console.log(
    `[evolve]   spawn: pnpm ${args
      .map((a) => (secrets.has(a) ? "***" : a))
      .join(" ")}`,
  )
  writeFileSync(batchLogPath, "", "utf-8")
  const outStream = createWriteStream(batchLogPath, { flags: "a" })
  const chunks: Buffer[] = []
  const tail = (max: number) => Buffer.concat(chunks).toString("utf-8").slice(-max)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const forward = (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.length > 16) {
        chunks.shift()
      }
      outStream.write(chunk)
    }
    child.stdout?.on("data", forward)
    child.stderr?.on("data", forward)
    child.on("error", (err) => {
      rejectPromise(new EvolveError(`批量对局进程启动失败: ${String(err)}`))
    })
    child.on("close", (code) => {
      outStream.end()
      if (code !== 0) {
        rejectPromise(
          new EvolveError(
            `批量对局进程退出码 ${String(code)}\n--- 日志尾部 ---\n${tail(2000)}`,
          ),
        )
      } else {
        resolvePromise()
      }
    })
  })
}

/**
 * 运行 evolve 阶段 1（M3 + M5）。
 *
 * 逐轮：把当前知识渲染进 batch 配置 -> 批量对局（或复用既有 summary）-> 组装
 * battle records -> LLM 反思（预测/复盘）-> 保存新知识。full 臂逐轮轮转
 * targetSection；no-memory / warm-start 不反思，知识始终为空。
 */
export async function runEvolve(
  config: EvolveConfig,
  opts: EvolveRunOptions = {},
): Promise<EvolveReport> {
  const dryRun = opts.dryRun === true
  const skipGames = opts.skipGames === true
  if (skipGames && !opts.gamesDir) {
    throw new EvolveError("skipGames 需要提供 gamesDir")
  }
  // gamesDir 支持 {round} 模板：多轮回放时按轮替换（如 work/round{round}/batch-results）
  const resolveGamesDir = (round: number): string =>
    resolve(process.cwd(), opts.gamesDir!.replaceAll("{round}", String(round)))
  if (!dryRun && skipGames && !existsSync(resolveGamesDir(0))) {
    throw new EvolveError(`gamesDir 不存在（round 0）: ${resolveGamesDir(0)}`)
  }

  const controlArm = config.evolution.controlArm
  // full 与 no-meta 都保留反思与知识注入；仅 full 触发 M4 元反思。
  const fullArm = controlArm === "full" || controlArm === "no-meta"
  const metaArm = controlArm === "full"
  const outputDir = resolve(process.cwd(), config.outputDir)
  const workDir = join(outputDir, "work")
  const roundsDir = join(outputDir, "rounds")
  const knowledgeDir = join(outputDir, "knowledge")

  const apiBase = (config.apiBase ?? process.env.OPENAI_API_BASE ?? "").trim()
  const apiKey = (config.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim()
  // 备用 API：config.fallbackApi 优先，OPENAI_FALLBACK_* 环境变量兜底；base/key 缺一不启用
  const fallbackApi = (() => {
    // 注意用 || 而非 ??：配置文件里写空字符串视为未填，继续回退环境变量
    const fbBase = (config.fallbackApi?.apiBase || process.env.OPENAI_FALLBACK_API_BASE || "").trim()
    const fbKey = (config.fallbackApi?.apiKey || process.env.OPENAI_FALLBACK_API_KEY || "").trim()
    if (fbBase === "" || fbKey === "") {
      return undefined
    }
    const fbModel = (config.fallbackApi?.model || process.env.OPENAI_FALLBACK_MODEL || "").trim()
    return {
      apiBase: fbBase,
      apiKey: fbKey,
      ...(fbModel !== "" ? { model: fbModel } : {}),
    }
  })()
  if (fallbackApi) {
    // 解析结果统一写回 config（含"配置写空串、env 兜底"的情形），供下游 buildBatchArgs/deps 使用
    config = { ...config, fallbackApi }
  }
  // 跳过对局时不需要 apiBase/apiKey（游戏侧不跑）；full 臂仍需 LLM 反思（用 callLlm 或 api 配置）。
  const needsLlm = !skipGames || fullArm
  if (!dryRun && needsLlm && (apiBase === "" || apiKey === "")) {
    if (fullArm && !opts.callLlm) {
      throw new EvolveError("缺少 LLM 配置：需提供 apiBase/apiKey（或注入 callLlm）")
    }
    if (!fullArm && skipGames) {
      throw new EvolveError("缺少 LLM 配置：apiBase/apiKey 不能为空")
    }
  }

  const limits: KnowledgeLimits =
    config.evolution.knowledgeLimit ?? DEFAULT_KNOWLEDGE_LIMITS
  const sections: SectionId[] =
    config.evolution.sections !== undefined && config.evolution.sections.length > 0
      ? [...config.evolution.sections]
      : [...SECTION_IDS]
  const rotation = config.evolution.sectionRotation !== false

  const ne = config.evolution.rhythm?.ne ?? 2
  const operators: ("M1" | "E2")[] = config.evolution.operators ?? ["M1"]
  const e2K = config.evolution.e2K ?? 3
  const algorithmicContext = controlArm !== "no-memory" ? buildAlgorithmicContext() : ""
  const roundSummaries: RoundSummaryStats[] = []
  let currentMeta: MetaInsight | null = null
  let pendingPathway: MetaPathway | null = null

  const reportRounds: EvolveReportRound[] = []
  const knowledgeVersions: number[] = []
  const lineageMap = new Map<SectionId, string>()

  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    mkdirSync(roundsDir, { recursive: true })
  }

  for (let i = 0; i < config.evolution.rounds; i++) {
    const roundOutDir = join(roundsDir, `round${i}`)
    const roundWorkDir = join(workDir, `round${i}`)
    if (!dryRun) {
      mkdirSync(roundOutDir, { recursive: true })
      mkdirSync(roundWorkDir, { recursive: true })
    }

    // 1. 知识：full 臂从上一轮文件加载（首轮/干跑/非 full 用空知识）。
    let knowledge: LLMDeckKnowledge
    if (fullArm && !dryRun && i > 0) {
      const prevPath = join(knowledgeDir, `round${i - 1}.json`)
      try {
        knowledge = loadKnowledge(prevPath)
      } catch (err) {
        throw new EvolveError(`加载上一轮知识失败 ${prevPath}: ${String(err)}`)
      }
    } else if (fullArm && !dryRun && i === 0 && typeof config.evolution.warmStartFrom === "string") {
      // 热启动：round 0 直接加载既有知识（如另一条臂的终点知识），跳过冷启动。
      const warmPath = resolve(process.cwd(), config.evolution.warmStartFrom)
      try {
        knowledge = loadKnowledge(warmPath)
        console.log(`[evolve] round 0: 热启动知识 v${knowledge.version} ← ${warmPath}`)
      } catch (err) {
        throw new EvolveError(`加载热启动知识失败 ${warmPath}: ${String(err)}`)
      }
    } else {
      knowledge = createEmptyKnowledge(config.matchup.deck0)
    }
    // 1.5 Round 0 战前分析（full/no-meta/warm-start；resume 复用 knowledge/init.json）。
    // 被测侧冻结原则（DESIGN §7.2）要求战前分析产自 knowledge 生产线，
    // 不能走 llm-agent 的 legacy analyze 路径（那会形成双注入）。
    if (controlArm !== "no-memory" && i === 0 && knowledge.preGameAnalysis.damageMode === "") {
      const initPath = join(knowledgeDir, "init.json")
      if (dryRun) {
        console.log("[evolve] round 0: 将生成战前分析（dry-run 不落盘）")
      } else if (existsSync(initPath)) {
        // 只复用战前分析字段，不能整体替换 knowledge——否则 warmStartFrom
        // 热启动的 refinedKnowledge 会被空占位 init.json 冲掉。
        knowledge.preGameAnalysis = loadKnowledge(initPath).preGameAnalysis
        console.log("[evolve] round 0: 复用既有战前分析（knowledge/init.json）")
      } else {
        const deps = opts.callLlm
          ? { callLlm: opts.callLlm }
          : {
              apiBase,
              apiKey,
              model: config.modelTested,
              ...(config.fallbackApi?.apiBase && config.fallbackApi?.apiKey
                ? {
                    fallback: {
                      apiBase: config.fallbackApi.apiBase,
                      apiKey: config.fallbackApi.apiKey,
                      model: config.fallbackApi.model ?? config.modelTested,
                    },
                  }
                : {}),
            }
        const preGame = await generatePreGameAnalysis({
          deckCode: config.matchup.deck0,
          deckName: config.matchup.deck0Name ?? config.matchup.deck0,
          context: algorithmicContext,
          deps,
        })
        knowledge.preGameAnalysis = preGame
        saveKnowledge(knowledge, initPath)
        console.log(
          `[evolve] round 0: 生成战前分析（${preGame.openingSequences.length} 个开局分支 / ${preGame.keyCards.length} 张关键卡）→ knowledge/init.json`,
        )
      }
    }

    // resume 恢复时按 iterationLog 重建各分节 lineage（进程内 lineageMap 不持久化）
    if (fullArm) {
      lineageMap.clear()
      for (const log of knowledge.iterationLog) {
        if (log.targetSection !== undefined && typeof log.lineageId === "string") {
          lineageMap.set(log.targetSection, log.lineageId)
        }
      }
    }
    const knowledgeVersion = fullArm ? knowledge.version : 0
    const knowledgeRef = `${config.matchup.deck0}@v${knowledgeVersion}`
    let targetSection: SectionId | null = null
    let operator: "M1" | "E2" = "M1"
    if (fullArm) {
      const suggestedSection = pendingPathway?.suggestedSection
      targetSection =
        pendingPathway !== null &&
        suggestedSection !== undefined &&
        (SECTION_IDS as readonly string[]).includes(suggestedSection)
          ? suggestedSection
          : rotation
            ? sections[i % sections.length]
            : sections[0]
      const suggestedOperator = pendingPathway?.suggestedOperator
      operator =
        pendingPathway !== null &&
        suggestedOperator !== undefined &&
        (operators as readonly string[]).includes(suggestedOperator)
          ? suggestedOperator
          : (operators[0] ?? "M1")
      pendingPathway = null // 消费后清空
    }

    // 2. 注入文件（非 full 臂不注入知识；dry-run 只计算路径、不落盘）。
    let injectPath = ""
    if (controlArm !== "no-memory") {
      injectPath = join(roundWorkDir, "knowledge-inject.md")
      if (!dryRun) {
        let injectText = renderInjection(knowledge)
        // compileRules：把当前知识编译为 DSL 规则模板随注入文件进入 prompt
        // （fragmented-decision 模式下由对局 LLM 在决策点实例化）。
        // 编译失败只告警不中断——它是注入增强，不是核心管线。
        if (config.evolution.compileRules === true) {
          try {
            const callLlm: CallLlm =
              opts.callLlm ??
              makeDefaultCallLlm({
                apiBase,
                apiKey,
                model: config.modelTested,
                ...(config.fallbackApi?.apiBase && config.fallbackApi?.apiKey
                  ? {
                      fallback: {
                        apiBase: config.fallbackApi.apiBase,
                        apiKey: config.fallbackApi.apiKey,
                        model: config.fallbackApi.model ?? config.modelTested,
                      },
                    }
                  : {}),
              })
            const compiled = await compileKnowledgeToRules({ knowledge, callLlm })
            writeJson(join(knowledgeDir, `compiled-rules-round${i}.json`), {
              knowledgeVersion: knowledge.version,
              rules: compiled.rules,
              dropped: compiled.dropped,
              generatedAt: new Date().toISOString(),
            })
            injectText += renderCompiledRulesForPrompt(compiled.rules, knowledge.version)
            console.log(
              `[evolve] round ${i}: 编译规则 ${compiled.rules.length} 条` +
                (compiled.dropped.length > 0 ? `（丢弃 ${compiled.dropped.length} 条非法规则）` : ""),
            )
          } catch (err) {
            console.log(`[evolve] round ${i}: 规则编译失败（跳过注入）: ${String(err)}`)
          }
        }
        writeFileSync(injectPath, injectText, "utf-8")
      }
    }

    // 3. batch 配置。knowledgeFile 必须是相对 process.cwd() 的路径
    //    （batch 端 resolve(projectDir, knowledgeFile)，projectDir = spawn cwd）。
    const matchup = config.matchup
    const batchConfig = {
      matchups: [
        {
          id: matchup.id,
          deck0: matchup.deck0,
          deck1: matchup.deck1,
          ...(matchup.deck0Name !== undefined ? { deck0Name: matchup.deck0Name } : {}),
          ...(matchup.deck1Name !== undefined ? { deck1Name: matchup.deck1Name } : {}),
          games: config.evolution.gamesPerRound,
          alternateFirstPlayer: true,
          p0: {
            // 隐藏：记忆工具（实验要求）、ping（空转）、冗余状态查询
            // （局面已由 choose_action/wait_for_my_turn 返回的 digest 覆盖，
            //   实测这三项每局白耗 ~21 万字符返回体 + ~17 次 LLM 请求）
            hiddenTools: [
              "strategy_store",
              "standalone_ping",
              "get_screen_state",
              "get_game_state",
              "get_available_commands",
            ],
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.maxHistoryMessages !== undefined
              ? { maxHistoryMessages: config.maxHistoryMessages }
              : {}),
            ...(controlArm !== "no-memory"
              ? {
                  knowledgeFile: relative(process.cwd(), injectPath).replace(/\\/g, "/"),
                }
              : {}),
          },
          p1: {
            hiddenTools: [
              "strategy_store",
              "standalone_ping",
              "get_screen_state",
              "get_game_state",
              "get_available_commands",
            ],
            ...(config.maxHistoryMessages !== undefined
              ? { maxHistoryMessages: config.maxHistoryMessages }
              : {}),
          },
        },
      ],
    }
    const batchConfigPath = join(roundWorkDir, "batch-config.json")
    const batchResultsDir = join(roundWorkDir, "batch-results")
    const batchLogPath = join(roundWorkDir, "batch.log")

    if (!dryRun) {
      writeJson(batchConfigPath, batchConfig)
    } else {
      console.log(
        `[evolve] round ${i}: knowledge v${knowledgeVersion}（inject: ${injectPath || "（不注入）"}）`,
      )
      console.log(`[evolve]   targetSection: ${targetSection ?? "（无反思）"}`)
      console.log(
        `[evolve]   operator: ${operator}${operator === "E2" ? `（e2K=${e2K}）` : ""}`,
      )
      const args = buildBatchArgs({
        config,
        batchConfigPath,
        batchResultsDir,
        apiBase,
        apiKey,
      })
      const secrets = new Set([apiKey, config.fallbackApi?.apiKey ?? ""].filter((s) => s !== ""))
      console.log(
        `[evolve]   spawn: pnpm ${args
          .map((a) => (secrets.has(a) ? "***" : a))
          .join(" ")}`,
      )
      console.log(`[evolve]   batch-config: ${JSON.stringify(batchConfig)}`)
    }

    // 4. 对局（或复用既有 summary / resume 断点续跑）。
    const resume = opts.resume === true
    let taggedEntries: { entry: BatchSummaryEntry; summaryPath: string }[] = []
    if (!dryRun) {
      if (resume) {
        // 断点续跑：合并该轮所有 run_* 的 entries；达标轮跳过 spawn，不足轮补 deficit 局。
        // 有效 = 正常完赛（分胜负或平局，与战报统计口径一致）；仅 error 非空（崩溃/超时/配额中断）才算无效。
        taggedEntries = collectSummaryEntries(batchResultsDir)
        const validCount = taggedEntries.filter(
          (t) =>
            t.entry.error === null || t.entry.error === undefined || t.entry.error === "",
        ).length
        const deficit = config.evolution.gamesPerRound - validCount
        if (deficit <= 0) {
          console.log(
            `[evolve] round ${i}: resume——已达标（${validCount}/${config.evolution.gamesPerRound} 局有效），跳过 spawn`,
          )
        } else if (skipGames) {
          console.log(
            `[evolve] round ${i}: resume——有效 ${validCount}/${config.evolution.gamesPerRound}，skip-games 模式不补局`,
          )
        } else {
          console.log(`[evolve] round ${i}: resume——补 ${deficit} 局（已有 ${validCount} 局有效）`)
          batchConfig.matchups[0].games = deficit
          writeJson(batchConfigPath, batchConfig)
          await spawnBatchGames({
            config,
            batchConfigPath,
            batchResultsDir,
            batchLogPath,
            apiBase,
            apiKey,
          })
          taggedEntries = collectSummaryEntries(batchResultsDir)
        }
      } else {
        let summaryPath = ""
        if (skipGames) {
          summaryPath = findSummaryJson(resolveGamesDir(i))
        } else {
          await spawnBatchGames({
            config,
            batchConfigPath,
            batchResultsDir,
            batchLogPath,
            apiBase,
            apiKey,
          })
          // batch 的实际产物在 run_<ISO>/ 子目录下，与 --skip-games 路径同一定位逻辑
          summaryPath = findSummaryJson(batchResultsDir)
        }
        taggedEntries = readSummaryEntries(summaryPath).map((entry) => ({
          entry,
          summaryPath,
        }))
      }
    }

    // 5. 汇总结果 + 组装 battle records。
    const records: BattleRecord[] = []
    let wins = 0
    let losses = 0
    let draws = 0
    let errors = 0
    let assembleFailures = 0
    if (!dryRun) {
      for (const tagged of taggedEntries) {
        const entry = tagged.entry
        const errorText = typeof entry.error === "string" ? entry.error : ""
        const winner = typeof entry.winner === "number" ? entry.winner : null
        if (errorText !== "") {
          errors++
          continue
        }
        // 被测侧槽位：firstPlayer=1（奇数局交换）时被测侧在 slot1（config 随卡组走）。
        // 胜负统计与 BattleRecord 组装都必须按被测侧槽位取，不能写死 slot0。
        const testedSlot: 0 | 1 = entry.firstPlayer === 1 ? 1 : 0
        if (winner === null) {
          draws++
        } else if (winner === testedSlot) {
          wins++
        } else if (winner === 1 - testedSlot) {
          losses++
        } else {
          errors++
          continue
        }
        let gameDir = resolve(process.cwd(), String(entry.outputDir ?? ""))
        const gameIndex = typeof entry.gameIndex === "number" ? entry.gameIndex : 0
        if (!existsSync(gameDir)) {
          gameDir = join(dirname(tagged.summaryPath), `${matchup.id}_game${gameIndex + 1}`)
        }
        try {
          // resume 下不同 run_* 的 gameIndex 会撞名：recordId 与输出文件名都带 run 时间戳后缀
          const runSuffix = resume ? runSuffixOf(tagged.summaryPath) : ""
          const record = assembleBattleRecord({
            gameDir,
            who: testedSlot,
            recordId: `${config.runId}_r${i}_g${gameIndex + 1}${runSuffix}`,
            myDeckCode: matchup.deck0,
            oppDeckCode: matchup.deck1,
            dataVersion: "unknown",
            firstPlayer:
              entry.firstPlayer === 0 || entry.firstPlayer === 1 ? entry.firstPlayer : undefined,
            opponentPolicy: { kind: "llm", checkpoint: "unknown" },
            knowledgeRef,
          })
          writeJson(join(roundOutDir, `game${gameIndex + 1}${runSuffix}.json`), record)
          records.push(record)
        } catch (err) {
          if (err instanceof AssembleError) {
            console.error(
              `[evolve]   警告: 组装 game${gameIndex + 1} 失败: ${err.message}`,
            )
            assembleFailures++
          } else {
            throw err
          }
        }
      }
    }

    // 6. 反思（仅 full 臂且非干跑）。resume 下本轮已反思过且样本未扩充则跳过；
    //    若续算补局使样本扩充（findings-consolidated §10.2 的截断反思问题），
    //    旧反思条目作废，基于全量样本重新反思并覆盖写（不会向 iterationLog 追加重复条目，
    //    因为重反思以本轮前的知识为基座，产物覆盖同一路径 round${i}.json）。
    const roundAvgRounds =
      records.length > 0
        ? records.reduce((a, r) => a + (r.result.totalRounds ?? 0), 0) / records.length
        : 0
    let reflection: RoundResult["reflection"] = null
    const existingKnowledgePath = join(knowledgeDir, `round${i}.json`)
    let existingKnowledge: LLMDeckKnowledge | null = null
    let reflectionStale = false
    let prevSampleGames = 0
    if (resume && fullArm && !dryRun && existsSync(existingKnowledgePath)) {
      existingKnowledge = loadKnowledge(existingKnowledgePath)
      const prevEntry = [...existingKnowledge.iterationLog]
        .reverse()
        .find((e) => e.iteration === i)
      prevSampleGames = prevEntry?.sampleGames ?? 0
      reflectionStale = records.length > prevSampleGames
    }
    if (existingKnowledge !== null && !reflectionStale) {
      knowledge = existingKnowledge
      console.log(
        `[evolve] round ${i}: resume——knowledge/round${i}.json 已存在且样本未扩充（${records.length} 局），跳过反思（v${knowledge.version}）`,
      )
    } else if (fullArm && !dryRun) {
      if (reflectionStale) {
        console.log(
          `[evolve] round ${i}: resume——样本已扩充（${prevSampleGames}→${records.length} 局），旧反思作废，基于全量样本重新反思`,
        )
      }
      const roundSummary = summarizeRecords(records)
      const deps = opts.callLlm
        ? { callLlm: opts.callLlm }
        : {
            apiBase,
            apiKey,
            model: config.modelTested,
            ...(config.fallbackApi?.apiBase && config.fallbackApi?.apiKey
              ? {
                  fallback: {
                    apiBase: config.fallbackApi.apiBase,
                    apiKey: config.fallbackApi.apiKey,
                    model: config.fallbackApi.model ?? config.modelTested,
                  },
                }
              : {}),
          }
      const { knowledge: nextKnowledge, entry } = await runRoundReflection({
        knowledge,
        round: i,
        roundSummary,
        records,
        section: targetSection!,
        operator,
        e2K,
        meta: currentMeta ?? undefined,
        context: algorithmicContext,
        opponentDeckCode: matchup.deck1,
        opponentDeckName: matchup.deck1Name ?? matchup.deck1,
        parentLineageId: lineageMap.get(targetSection!),
        historyRounds: [...roundSummaries],
        limits,
        deps,
      })
      lineageMap.set(targetSection!, entry.lineageId)
      saveKnowledge(nextKnowledge, join(knowledgeDir, `round${i}.json`))
      knowledge = nextKnowledge
      reflection = {
        targetSection: targetSection!,
        predictionAccuracy: entry.postGameReflection.predictionAccuracy,
        iteration: entry,
      }
    }
    roundSummaries.push({ round: i, wins, losses, draws, errors, assembleFailures, avgRounds: roundAvgRounds })

    // 6.5 M4 元反思（full 臂，每 ne 轮 NE 后触发一次；no-meta 臂不触发）。
    // 触发发生在当前轮反思完成后，为下一轮生成 targetSection/operator 建议。
    let metaScheduled = false
    if (metaArm && i > 0 && i % ne === 0) {
      metaScheduled = true
      if (dryRun) {
        console.log(`[evolve]   meta-reflection: round ${i} 后将触发（rhythm ne=${ne}）`)
      } else {
        const metaPath = join(knowledgeDir, "meta", `round${i}.json`)
        if (resume && existsSync(metaPath)) {
          // 本轮 Meta Insight 已生成过（重复 resume）：复用，不重复调 LLM
          const existing = JSON.parse(readFileSync(metaPath, "utf-8")) as {
            metaInsight?: MetaInsight
            pathway?: MetaPathway
          }
          currentMeta = existing.metaInsight ?? null
          pendingPathway = existing.pathway ?? null
          console.log(`[evolve]   meta-reflection: round ${i} 已有 Meta Insight，复用`)
        } else {
          const metaDeps = opts.callLlm
            ? { callLlm: opts.callLlm }
            : {
                apiBase,
                apiKey,
                model: config.modelTested,
                ...(config.fallbackApi?.apiBase && config.fallbackApi?.apiKey
                  ? {
                      fallback: {
                        apiBase: config.fallbackApi.apiBase,
                        apiKey: config.fallbackApi.apiKey,
                        model: config.fallbackApi.model ?? config.modelTested,
                      },
                    }
                  : {}),
              }
          const metaResult = await generateMetaInsight({
            round: i,
            roundSummaries,
            iterationLog: knowledge.iterationLog,
            violationRate: null,
            context: algorithmicContext,
            deps: metaDeps,
          })
          currentMeta = metaResult.insight
          pendingPathway = metaResult.pathway
          writeJson(
            join(knowledgeDir, "meta", `round${i}.json`),
            {
              round: i,
              metaInsight: metaResult.insight,
              pathway: metaResult.pathway,
              stats: { roundSummaries: [...roundSummaries], violationRate: null },
            },
          )
          console.log(
            `[evolve]   meta-reflection: round ${i} 后生成 Meta Insight（收敛诊断=${metaResult.insight.convergenceDiagnosis}）`,
          )
        }
      }
    }

    // 7. 落盘本轮结果。
    const roundResult: RoundResult = {
      round: i,
      gamesPlayed: wins + losses + draws + errors,
      wins,
      losses,
      draws,
      errors,
      assembleFailures,
      knowledgeVersion: fullArm ? knowledge.version : 0,
      reflection,
    }
    if (!dryRun) {
      writeJson(join(roundWorkDir, "round-result.json"), roundResult)
    }

    const winRate = wins + losses > 0 ? wins / (wins + losses) : null
    reportRounds.push({
      round: i,
      winRate,
      wins,
      losses,
      draws,
      errors,
      knowledgeVersion: roundResult.knowledgeVersion,
      targetSection,
      metaGenerated: metaScheduled,
    })
    knowledgeVersions.push(roundResult.knowledgeVersion)
  }

  const report: EvolveReport = {
    runId: config.runId,
    matchup: config.matchup,
    modelTested: config.modelTested,
    modelOpponent: config.modelOpponent,
    controlArm,
    ...(config.evolution.rhythm !== undefined ? { rhythm: config.evolution.rhythm } : {}),
    ...(config.evolution.operators !== undefined
      ? { operators: config.evolution.operators }
      : {}),
    rounds: reportRounds,
    knowledgeVersions,
    generatedAt: new Date().toISOString(),
  }
  if (!dryRun) {
    writeJson(join(outputDir, "report.json"), report)
  }
  return report
}

interface ParsedArgs {
  configPath: string | null
  dryRun: boolean
  skipGames: boolean
  gamesDir: string | null
  resume: boolean
}

function main(): void {
  const args = process.argv.slice(2)
  const parsed: ParsedArgs = {
    configPath: null,
    dryRun: false,
    skipGames: false,
    gamesDir: null,
    resume: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "-h":
      case "--help":
        console.log(HELP)
        return
      case "--config": {
        const [value, next] = take("--config", args, i)
        parsed.configPath = value
        i = next
        break
      }
      case "--dry-run":
        parsed.dryRun = true
        break
      case "--skip-games":
        parsed.skipGames = true
        break
      case "--resume":
        parsed.resume = true
        break
      case "--games-dir": {
        const [value, next] = take("--games-dir", args, i)
        parsed.gamesDir = value
        i = next
        break
      }
      default:
        fail(`未知参数: ${arg}`)
    }
  }
  if (parsed.configPath === null) {
    fail("缺少 --config <path>")
  }
  const configPath = resolve(process.cwd(), parsed.configPath)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"))
  } catch (err) {
    fail(`无法读取配置 ${configPath}: ${String(err)}`)
  }
  const config = validateConfig(raw)

  runEvolve(config, {
    dryRun: parsed.dryRun,
    skipGames: parsed.skipGames,
    resume: parsed.resume,
    ...(parsed.gamesDir !== null ? { gamesDir: parsed.gamesDir } : {}),
  })
    .then((report) => {
      console.log(`[evolve] 完成: ${report.runId}（controlArm=${report.controlArm}）`)
      for (const r of report.rounds) {
        const winRate =
          r.winRate === null ? "n/a" : `${(r.winRate * 100).toFixed(1)}%`
        console.log(
          `[evolve]   round ${r.round}: winRate=${winRate}（${r.wins}胜/${r.losses}负/${r.draws}平/${r.errors}错）knowledge=v${r.knowledgeVersion}`,
        )
      }
    })
    .catch((err) => {
      fail(err instanceof Error ? err.message : String(err))
    })
}

// 入口守卫：仅当作为脚本直接执行时运行 main（被 import 时不执行）。
if (
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
