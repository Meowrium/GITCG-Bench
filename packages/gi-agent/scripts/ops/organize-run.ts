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
 * WP4 件 2：organizer 三任务编排（mentions / practice / misalign）。
 * 件 3 的类型/条目级校验/report.md 渲染在 organize-report.ts（纯函数层，可单测）。
 *
 * 设计依据：docs/plans/2026-09-03-llm-evidence-organizer-eval.md（B 案，全篇契约）
 * 与 docs/plans/2026-09-05-impl-spec-4-organizer.md §3/§4。
 * organizer 定位 = 证据整理者：只做证据的组织、对齐与归因，**不打分**；每条结论
 * 强制附引用；人工终审。
 *
 * 用法（gi-agent 包目录内）：
 *   gnx scripts/ops/organize-run.ts --evidence <evidencePack目录> --out <报告目录>
 *       [--tasks mentions,practice,misalign] [--model deepseek-v4-flash-vision-exp]
 *       [--max-prompt-chars 120000] [--max-tokens 16384]
 *
 * LLM 凭据：**注入式双 env**（先例 benchmark/battle-benchmark/src/evolve/llm-client.ts
 * 的凭据注入形态）——ORGANIZER_API_KEY / ORGANIZER_BASE_URL / ORGANIZER_MODEL，
 * 默认模型 deepseek-v4-flash-vision-exp。**不读 OPENAI_***，不依赖
 * src/runtime/plan-oneshot/cli/llm.ts 的单 env 契约（该文件只复用 extractJson 纯函数）。
 *
 * 隔离红线：本脚本只写 --out 目录，绝不写 --evidence（evidencePack / run 目录）内
 * 任何路径——organizer 产物不回流 reflect 输入（oracle-free 臂语义，B 案 §6-6）。
 *
 * 失败隔离（spec-0 共享约定 5）：单任务 LLM 调用失败重试 2 次（共 3 次尝试）后隔离，
 * 其余任务照常；坏条目条目级剔除进 invalidEntries，不整报作废。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { extractJson } from "../../src/runtime/plan-oneshot/cli/llm.js"
import {
  ALL_TASKS,
  compileWhitelist,
  DIMENSION_OF_TASK,
  renderMarkdown,
  validateEntry,
  type OrganizerEntry,
  type OrganizerReport,
  type TaskName,
} from "./organize-report.js"

/** organizer 默认模型（2026-09-05 拍板：deepseek-v4-flash-vision-exp） */
const DEFAULT_ORGANIZER_MODEL = "deepseek-v4-flash-vision-exp"

// ── args ─────────────────────────────────────────────────────────────

interface Args {
  evidence: string
  out: string
  tasks: TaskName[]
  model: string
  maxPromptChars: number
  maxTokens: number
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)
  if (has("help")) {
    console.error("usage: gnx scripts/ops/organize-run.ts --evidence <pack> --out <报告目录> [--tasks mentions,practice,misalign] [--model deepseek-v4-flash-vision-exp] [--max-prompt-chars 120000] [--max-tokens 16384]")
    process.exit(0)
  }
  const evidence = get("evidence")
  const out = get("out")
  const tasksRaw = get("tasks") ?? ALL_TASKS.join(",")
  const tasks = tasksRaw.split(",").map((s) => s.trim()).filter(Boolean) as TaskName[]
  for (const t of tasks) {
    if (!ALL_TASKS.includes(t)) {
      console.error(`未知任务 "${t}"（可用：${ALL_TASKS.join(",")}）`)
      process.exit(1)
    }
  }
  if (!evidence || !out || tasks.length === 0) {
    console.error("usage: gnx scripts/ops/organize-run.ts --evidence <pack> --out <报告目录> [--tasks mentions,practice,misalign] [--model ...] [--max-prompt-chars 120000] [--max-tokens 16384]")
    process.exit(1)
  }
  return {
    evidence: resolve(evidence),
    out: resolve(out),
    tasks: [...new Set(tasks)],
    model: get("model") ?? process.env.ORGANIZER_MODEL ?? DEFAULT_ORGANIZER_MODEL,
    maxPromptChars: Number(get("max-prompt-chars") ?? 120_000),
    maxTokens: Number(get("max-tokens") ?? 16_384),
  }
}

// ── LLM 调用（注入式双 env；evolve/llm-client.ts 先例形态）────────────

interface OrganizerCreds {
  apiKey: string
  baseUrl: string
  model: string
}

function resolveCreds(model: string): OrganizerCreds {
  const apiKey = process.env.ORGANIZER_API_KEY ?? ""
  const baseUrl = (process.env.ORGANIZER_BASE_URL ?? "").replace(/\/+$/, "")
  if (!apiKey || !baseUrl || !model) {
    throw new Error("需要 ORGANIZER_API_KEY / ORGANIZER_BASE_URL（ORGANIZER_MODEL 可用 --model 覆盖）——注入式双 env，不读 OPENAI_*")
  }
  return { apiKey, baseUrl, model }
}

async function callOrganizerChat(
  creds: OrganizerCreds,
  opts: { system: string; user: string; maxTokens: number },
): Promise<string> {
  const timeoutMs = Number(process.env.ORGANIZER_TIMEOUT_MS) || 600_000
  const res = await fetch(`${creds.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({
      model: creds.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: 0.2,
      max_tokens: opts.maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? ""
  if (!content) throw new Error("LLM 返回空内容")
  return content
}

/** 单任务执行：失败重试 2 次（共 3 次）后隔离 */
async function runTask(
  task: TaskName,
  creds: OrganizerCreds,
  prompt: { system: string; user: string },
  maxTokens: number,
): Promise<{ ok: true; rawEntries: unknown[] } | { ok: false; error: string }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await callOrganizerChat(creds, { ...prompt, maxTokens })
      const parsed = extractJson(content) as { entries?: unknown } | null
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
        throw new Error("输出 JSON 缺 entries 数组")
      }
      return { ok: true, rawEntries: parsed.entries }
    } catch (e) {
      lastError = e
      console.warn(`[organize-run] 任务 ${task} 第 ${attempt + 1} 次尝试失败: ${e instanceof Error ? e.message : String(e)}`)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  return { ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) }
}

// ── 提示词（任务定义/信息源映射按 B案 §3）────────────────────────────

function systemPrompt(task: TaskName): string {
  return [
    "你是七圣召唤对战 AI 实验的 organizer（证据整理者）。职责边界：只做证据的组织、对齐与归因——说清「提及了什么、实践了什么、哪里对不上」；**不打分、不判优劣**，「哪个更好」由人工终审判断。",
    "",
    "硬性纪律：",
    "1. 每条结论必须附至少一条引用（citations）；file 只能取输入材料中「=== FILE: … ===」标注的证据包相对路径；引用尽量精确到 game/seq（决策点）或 ruleKey（规则）。",
    "2. 不打分：不输出任何评分/排名/优劣判断；结论只描述事实与证据链。",
    "3. 不口算：骰子支付、伤害结算、能量账等只引用材料中已给出的数字，不得自行推算。",
    "4. 视角纪律：判「决策时合理性」只用玩家视角信息（fullDigest 局面摘要 / stateSignatures）；判「路线与结局」才可用上帝视角信息（draw-sequence / outliers）。",
    "5. 证据缺口如实标注：材料未覆盖的信息写进 notes，不得虚构引用。",
    "6. 置信定义：high=有直接机械锚点支撑；medium=证据链完整但需解读；low=跨局推断/样本少。",
    "",
    "输出：仅一个 JSON 对象 {\"entries\":[…]}，无任何多余文本。每条条目形状：",
    `{"id":"<任务内唯一id>","dimension":"${DIMENSION_OF_TASK[task]}","conclusion":"<结论>","citations":[{"file":"<pack相对路径>","game":"game-0001","seq":0,"turn":1,"ruleKey":"global:3"}],"mechanicalAnchor":{"kind":"perRuleHitsZero|thenMiss|declareEndRatio|perMethodOpening|predictionMismatch|fallbackCluster|other","ruleKey":"…","detail":"…"},"confidence":"high|medium|low","notes":"<备注，可省>"}`,
    "",
    `[organizer-task: ${task}]`,
  ].join("\n")
}

/** 文件节选（带标注头；超限截断并注明） */
function fileSection(packDir: string, rel: string, maxChars: number): string {
  const raw = readFileSync(join(packDir, rel), "utf-8")
  const head = `=== FILE: ${rel} ===\n`
  if (raw.length <= maxChars) return `${head}${raw}`
  return `${head}${raw.slice(0, maxChars)}\n…（截断，原文共 ${raw.length} 字符；其余内容请人工或后续调用按行查看 ${rel}）\n`
}

function userPrompt(
  task: TaskName,
  packDir: string,
  available: Set<string>,
  maxPromptChars: number,
): string {
  const sections: string[] = []
  const add = (rel: string, maxChars: number): void => {
    if (!available.has(rel)) return
    sections.push(fileSection(packDir, rel, maxChars))
  }
  let body: string
  if (task === "mentions") {
    body = [
      "# 任务：整理「计划提及了哪些策略」（B案 §3.1）",
      "信息源（本 evidence pack）：",
      "- plan.side0.json：计划文本本体（规则 when/then/reason、phaseId、fallback.policy、predictions）。predictions 是模型赛前对自己路线的明文断言，天然待检验。",
      "- outliers.json 的 runAggregates.perRuleHits / perRuleThenMiss / perMethod：「提及是否进入执行」的机械证实。",
      "要求：每条提及的策略点一条条目（dimension=route）：结论 = 提及内容概括；引用 = plan.side0.json（带 ruleKey 或说明字段）；可用 outliers.json 交叉引用证实/证伪进入执行（notes 标注）。",
      "已知证据缺口：author 侧 transcript/harness/reflection 不在本 pack（本轮未采集），不得引用或虚构这些来源。",
      "",
    ].join("\n")
    add("plan.side0.json", 40_000)
    add("outliers.json", 20_000)
  } else if (task === "practice") {
    body = [
      "# 任务：整理「实际执行采用了哪些策略」（B案 §3.2）",
      "信息源（本 evidence pack）：",
      "- fullDigest.txt：逐局决策证据（opening 类 + action 决策点 + 异常点 drilldown；行内局面摘要为玩家视角）",
      "- stateSignatures.jsonl：每决策点整条 stateSignature（按 game+seq 索引；玩家视角：自己手牌明文，对手仅手牌数）",
      "- draw-sequence.md：各局抽牌序列（initialPile/pile 差分重建）",
      "- outliers.json：perGame 结局背景（seed/winner/rounds/coverage）与离群局 + run 级机械聚合",
      "- side1/…：对手侧 trace + summary（plan-vs-plan 交互叙事：我方策略何时被对方反制）",
      "要求：逐局重构实际展开路线（dimension=execution）：决策点序列 + 每步「规则命中 / 兜底（何种 policy）」标注 + 决策时局面 + 结局背景。引用用 fullDigest.txt/stateSignatures.jsonl 的 game+seq。",
      "",
    ].join("\n")
    add("fullDigest.txt", Math.max(30_000, maxPromptChars - 60_000))
    add("outliers.json", 20_000)
    add("draw-sequence.md", 30_000)
    if (available.has("stateSignatures.jsonl")) {
      const raw = readFileSync(join(packDir, "stateSignatures.jsonl"), "utf-8")
      const lines = raw.split("\n").filter((l) => l.length > 0)
      sections.push(`=== FILE: stateSignatures.jsonl（整条签名文件共 ${lines.length} 行，此处仅前 40 行样例；引用时按 game+seq 指向该文件） ===\n${lines.slice(0, 40).join("\n")}\n`)
    }
    for (const rel of [...available].filter((f) => f.startsWith("side1/")).slice(0, 2)) {
      sections.push(`=== FILE: ${rel}（对手侧；仅存在性提示，内容较大不注入） ===\n（该文件在 evidence pack 中可按路径查证）\n`)
    }
  } else {
    body = [
      "# 任务：整理「提及 ≠ 实践」的错位证据表（B案 §3.3）",
      "机械锚点（全部现成计数，organizer 只做语义归因，逐条给出 mechanicalAnchor）：",
      "- perRuleHits=0 的规则（写了从未打过，「改没了」检测）→ outliers.json runAggregates.perRuleHits 对照 plan.side0.json 的规则键",
      "- perRuleThenMiss（when 全真但 then 零命中，死规则探针）→ outliers.json runAggregates.perRuleThenMiss + fullDigest 的 thenMiss 行",
      "- declareEnd 占比（龟缩化信号）→ fullDigest 头部 declareEnd 行 + outliers.json runAggregates.declareEnd",
      "- opening 类决策计数（chooseActive/switchHands/rerollDice，反思证据不覆盖块）→ outliers.json runAggregates.perMethod",
      "- plan.predictions vs 实战统计（winRateEstimate / expectedRounds / keyThreats）→ plan.side0.json + outliers.json runAggregates",
      "要求：每条错位证据（dimension=misalign）必须带 mechanicalAnchor（kind ∈ perRuleHitsZero|thenMiss|declareEndRatio|perMethodOpening|predictionMismatch|fallbackCluster|other + detail 给出锚点读数）；结论 = 哪里对不上的语义归因，不打分。",
      "",
    ].join("\n")
    add("outliers.json", 30_000)
    add("plan.side0.json", 40_000)
    add("fullDigest.txt", Math.max(30_000, maxPromptChars - 80_000))
  }
  const user = `${body}${sections.join("\n")}`
  // 总预算兜底：超限从尾部截断（文件节选已各自限额，此处防御性兜底）
  if (user.length <= maxPromptChars) return user
  return `${user.slice(0, maxPromptChars)}\n…（prompt 总预算 ${maxPromptChars} 字符截断）`
}

// ── 主流程 ───────────────────────────────────────────────────────────

function packAvailableFiles(packDir: string): Set<string> {
  const available = new Set<string>()
  const walk = (rel: string): void => {
    const abs = join(packDir, rel)
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) walk(rel === "" ? name : `${rel}/${name}`)
    } else {
      available.add(rel)
    }
  }
  walk("")
  return available
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const packDir = args.evidence
  if (!existsSync(join(packDir, "manifest.json"))) {
    console.error(`[organize-run] ${packDir} 缺 manifest.json——不是 plan:organize-export 产物？先跑 pnpm run plan:organize-export`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf-8")) as { runDir?: string }
  const available = packAvailableFiles(packDir)

  // 引用白名单：schema 的 x-evidenceFileWhitelist（单一事实来源）∩ pack 实际文件
  const schemaPath = join(import.meta.dirname, "organizer-report.schema.json")
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as { "x-evidenceFileWhitelist"?: string[] }
  const matchers = compileWhitelist(schema["x-evidenceFileWhitelist"] ?? [])

  const creds = resolveCreds(args.model)
  console.log(`[organize-run] evidence=${packDir} out=${args.out} tasks=${args.tasks.join(",")} model=${creds.model} baseUrl=${creds.baseUrl}`)

  // 三任务并行（三任务各一次 LLM 调用）
  const results = await Promise.all(
    args.tasks.map(async (task) => {
      const user = userPrompt(task, packDir, available, args.maxPromptChars)
      console.log(`[organize-run] 任务 ${task} prompt ${user.length} 字符，调用中…`)
      const res = await runTask(task, creds, { system: systemPrompt(task), user }, args.maxTokens)
      return { task, res }
    }),
  )

  const report: OrganizerReport = {
    runDir: manifest.runDir ?? packDir,
    model: creds.model,
    generatedAt: new Date().toISOString(),
    tasks: {},
    invalidEntries: [],
    taskFailures: [],
  }
  for (const { task, res } of results) {
    if (!res.ok) {
      report.taskFailures!.push({ task, error: res.error })
      continue
    }
    const valid: OrganizerEntry[] = []
    res.rawEntries.forEach((raw, index) => {
      const v = validateEntry(raw, { matchers, packDir })
      if (v.ok) valid.push(v.entry)
      else {
        console.warn(`[organize-run] 任务 ${task} 条目 ${index} 剔除: ${v.reason}`)
        report.invalidEntries!.push({ task, index, reason: v.reason, entry: raw })
      }
    })
    report.tasks[task] = valid
  }
  if ((report.invalidEntries?.length ?? 0) === 0) delete report.invalidEntries
  if ((report.taskFailures?.length ?? 0) === 0) delete report.taskFailures

  // 产物：report.json + report.md（只写 --out 目录——隔离红线）
  mkdirSync(args.out, { recursive: true })
  const reportJsonPath = join(args.out, "report.json")
  const reportMdPath = join(args.out, "report.md")
  writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
  writeFileSync(reportMdPath, renderMarkdown(report, packDir, args.out, args.tasks), "utf-8")

  const taskSummary = args.tasks.map((t) => `${t}=${report.tasks[t]?.length ?? "隔离"}`).join(" ")
  console.log(`[organize-run] 完成：${taskSummary} ｜ invalidEntries=${report.invalidEntries?.length ?? 0} ｜ taskFailures=${report.taskFailures?.length ?? 0}`)
  console.log(`[organize-run] 产物: ${reportJsonPath} + ${reportMdPath}`)
  // 全部任务失败视为运行失败（部分失败已隔离不阻断）
  if (Object.keys(report.tasks).length === 0) {
    console.error("[organize-run] 全部任务失败（已写入 taskFailures）")
    process.exitCode = 1
  }
}

await main()
