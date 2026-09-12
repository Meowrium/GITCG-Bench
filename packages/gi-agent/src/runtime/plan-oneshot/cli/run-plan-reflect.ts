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
 * plan:reflect — 赛后（元）反思（设计文档组件 E 最小实现）。
 *
 * 用法：pnpm run plan:reflect -- --run-dir <batch输出目录>[,<目录2>...] --side 0 --out <修订计划路径>
 *
 * 输入：plan.side<N>.json + summary.json + 本侧的 plan_eval_summary（可选；side1 为 plan_eval_summary.side1.json）
 * 输出：修订后的 GamePlanV1（--out）与反思记录（<out>.reflection.json）。
 * 统计数字全部由本地计算注入（权威统计，LLM 不做口算——findings §10.7.2）。
 *
 * --evidence engine-only（2026-08-30 无 oracle 自进化臂）：NN/oracle 产物不进反思环路——
 * 启动时断言各 run 目录无 plan_eval*.json（含 game-* 子目录，存在即 fail-fast）；
 * evidence-extract / modules / plan-replay 的 eval 读取整体门控；prompt 用 oracle-free
 * 变体；新增 thenMiss/fallback/威胁读数/零命中告警等机械指标锚点。--eval-suffix 与该模式互斥。
 * --run-dir 接受逗号分隔多目录（交叉对手证据包，§3）：各目录计划必须同 planId，
 * 统计与证据按对手组（目录 basename）分节注入，避免多数派对手稀释少数派信号。
 *
 * --turns N（N>1）进入 harness 有界 agent 循环模式（2026-08-28 harness 设计文档）：
 * 首轮证据包与 one-shot 完全相同，此后 LLM 可经 request_modules 钻取原始决策点
 * （decision_detail / rule_drilldown / fallback_detail / game_summary / plan_simulate）、
 * draft 提交修订稿校验、final 定稿。效率统计落 <out>.harness.json。
 *
 * 口径注记（2026-09 确认）：one-shot 修复循环（--turns 1）刻意不做 harness 路径的
 * lintPlan（死规则/遮蔽链 lint）与 ruleRefWarnings（ruleRef 封闭集合劝告）两道检查——
 * 对照臂保持最小干预，与 harness 臂的辅助强度对等比较；代价是修订稿可能带遮蔽链/
 * 幻觉 ruleRef 通过验收。后续若调整实验方案想给对照臂补齐，在下方 attempt 修复循环
 * 加调 lintPlan / ruleRefWarnings 即可。
 *
 * --patch（2026-08-29 patch 修订模式）：在 harness 模式上启用受限补丁协议——
 * LLM 提交 ops 由服务端合并进当前决策树（plan-patch.ts，未触及规则默认 keep），
 * 每次合并后以静态回放核验（plan-replay.ts：命中矩阵 diff + 逐 op 断言）回注；
 * 裸 final 以累计 patch 为产出。授权边界：ops 只作用于本侧当前决策树，语料
 * 只读本侧 trace/eval 文件，对手计划内容不可达。全量 draft/final 会整体覆盖
 * 已合并的 patch 成果：存在累计 patch 时要求产物携带 "overwritePatches": true
 * 显式确认（防静默丢弃 patch 成果），确认后允许直接覆盖，覆盖后 patch 计数归零。
 *
 * 替代路线参考 + switch_route（2026-09-08 多候选换轴）：run 目录存在
 * plan.side<N>.alternates.json（plan:author --candidates 旁档）时，首轮 user 消息
 * 注入「替代路线参考」段（候选 index/archetype/评审短评/已嫁接单元 + 形状摘要，
 * 不注入整棵树）；--patch harness 模式下 LLM 可用 switch_route 命令做单元级嫁接
 * （opening / fallback / rules / phase:<phaseId>，单次 ≤2 个、本 run 累计 ≤2 个，
 * 来源限 alternates 候选、不得选已落地候选；plan-graft.ts 纯函数）。嫁接后
 * finalizeMerged → validate → lint → 静态回放 diff（基准 = 嫁接前工作树）→
 * 合成 ruleVerdicts（ruleRef = 链锚点，接消融臂）→ 换轴审计记录落
 * `<out>.reflection.json` 的 routeSwitches（run 目录只读，不就地改写旁档）。
 *
 * --portfolio <manifest>（Phase 3b，两层组合 G5）：装载 PlanPortfolioV1 manifest
 * 并以 portfolio 模式反思——workingPlan 换为 workingPortfolio（general + singles
 * 分层树），applyPlanPatch 走 portfolio 重载（ops 带层前缀 general:… /
 * single:<label>:…）；逐组 run 目录读 portfolio.side0.json 做 portfolioId 组间
 * 一致性断言（组↔manifest 重算值不符即拒绝，防旧代 run 修订新 portfolio）；
 * 各组按 trace.deckCodes 判定路由 single 填 RunDirGroup.singleLabel；stats 文本
 * 追加 D6 层路由建议（buildLayerRoutingAdvice）；finalGate 零修订判断改比
 * computePortfolioId；产物 --out 解释为目录（plans/general.<tag>.json +
 * plans/single.<label>.<tag>.json + 更新 portfolio.json，--round N → tag r<N>，
 * 缺省沿用 manifest 的 generalPlan 文件名 tag；sidecar 落 out 目录根部）。
 * legacy 回退：未传 --portfolio 且组内无 portfolio.side0.json → 维持单树流程，
 * 旧 roundS 行为逐字节不变。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { type Version } from "@gi-tcg/core"
import type { GameData } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { chatCompletion, extractJson, loadDotEnvFallback } from "./llm.js"
import { REFLECT_SYSTEM_PROMPT, REFLECT_SYSTEM_PROMPT_ENGINE_ONLY, buildReflectSystemPrompt } from "./plan-prompts.js"
import { extractDecisionEvidence, extractFullDigest, findOracleArtifacts } from "./evidence-extract.js"
import type { EvidenceMode } from "./evidence-extract.js"
import { runAgentLoop } from "./agent-loop.js"
import type { RouteSwitchCommand } from "./agent-loop.js"
import { createModuleResolver, loadMergedCorpus } from "./modules.js"
import { validateGamePlan, computePlanId, normalizePlanNumericFields, autoRepairPlan } from "../validate.js"
import type { PlanValidationContext } from "../validate.js"
import type { GamePlanV1 } from "../game-plan-v1.js"
import { parsePlanPatchCommand, applyPlanPatch, isSyntheticPatchRef } from "../plan-patch.js"
import type { PatchVerdict } from "../plan-patch.js"
import { collectRuleKeys } from "../rule-key.js"
import { replayPlan, replayPortfolio, verifyPatchAssertions, verifyPortfolioPatchAssertions, formatPatchVerification, loadReplayCorpus } from "../plan-replay.js"
import type { ReplayCorpus, PlanReplayResult, PortfolioReplayGroupInput, PortfolioReplayResult } from "../plan-replay.js"
import { lintPlan } from "../fields-lint.js"
import type { PlanLintContext, PlanLintFinding } from "../fields-lint.js"
import { buildCardFaceTable } from "../card-face-table.js"
import type { CardFaceTable } from "../card-face-table.js"
import {
  checkAnchorAssertions,
  type AnchorAssertionsSidecar,
  type AnchorCheckResult,
  type AnchorComboLineAssertion,
  type AnchorKillMathAssertion,
} from "./author-anchor-check.js"
import { loadPortfolioWithValidation, computePortfolioId, type ResolvedPortfolio } from "../portfolio.js"
import { adoptedUnitMap, applyRouteGraft, checkGraftUnits, planShapeSummary, type PlanAlternatesSidecar } from "../plan-graft.js"
import { assetsManagerForVersion, checkRunDirVersions, resolveDeclaredPlanVersion } from "../version.js"
import { createReplayReport, recordPatchReplay, writeReplayReport, type ReplayReport } from "./replay-report.js"
import {
  assertPortfolioGroupIds,
  buildLayerRoutingAdvice,
  formatPortfolioPatchVerification,
  portfolioTagOf,
  readPortfolioRunArchive,
  resolveGroupSingleLabel,
  writePortfolioOutputs,
  type WorkingPortfolio,
} from "./reflect-portfolio.js"

interface ReflectArgs {
  /** 证据 run 目录列表（逗号分隔多目录 = 交叉对手证据包，同 planId 断言） */
  runDirs: string[]
  side: 0 | 1
  out: string
  thinking: boolean
  temperature: number
  seed: number | undefined
  /** 覆盖 OPENAI_MODEL（如通道上某模型被限流时切换） */
  model: string | undefined
  /** oracle 回算产物后缀（如 "nn" → plan_eval_summary.nn.json / plan_eval.nn.json）；缺省读 ISMCTS 口径 */
  evalSuffix: string | undefined
  /** 证据口径：oracle（默认，既有行为）/ engine-only（无 oracle 自进化臂，eval 全门控） */
  evidence: EvidenceMode
  /** harness 模式轮次上限：1 = one-shot（默认）；>1 = 有界 agent 循环 */
  turns: number
  moduleBudget: number
  perTurnModules: number
  /** patch 修订模式（受限 ops + 服务端合并 + 静态回放核验） */
  patch: boolean
  /** 单条 patch 命令 op 上限 */
  maxPatchOps: number
  /** SSE 流式接收（GLM 等慢推理模型防网关 300s 流超时掐断；llm.ts LlmCallOptions） */
  stream: boolean
  /** 单次 LLM 调用 max_tokens 上限（默认 32768；GLM 长推理建议调大） */
  maxTokens: number
  /** 两层组合（portfolio）模式：PlanPortfolioV1 manifest 路径；设置即 portfolio 模式（Phase 3b） */
  portfolio: string | undefined
  /** 产物轮次 tag（--round N → `r<N>`）；缺省沿用 manifest generalPlan 文件名 tag（原位修订） */
  round: number | undefined
  /** 版本错配放行：run 目录版本断言失败降级 warning（V1 版本钉扎） */
  force: boolean
}

function parseArgs(): ReflectArgs {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const runDirs = (get("run-dir") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  const out = get("out")
  const side = Number(get("side") ?? "0")
  const evidenceRaw = get("evidence") ?? "oracle"
  const portfolio = get("portfolio")
  const roundRaw = get("round")
  if (runDirs.length === 0 || !out || (side !== 0 && side !== 1) || (evidenceRaw !== "oracle" && evidenceRaw !== "engine-only")) {
    console.error("usage: plan:reflect -- --run-dir <dir>[,<dir2>...] --side <0|1> --out <revised-plan.json|portfolio-out-dir> [--portfolio <portfolio.json>] [--round <N>] [--evidence oracle|engine-only] [--temperature 0.2] [--seed N] [--model <name>] [--eval-suffix nn] [--turns 1] [--module-budget 12] [--per-turn-modules 4] [--patch] [--max-patch-ops 8] [--stream] [--max-tokens 32768] [--force] [--no-thinking]")
    process.exit(1)
  }
  if (roundRaw !== undefined && (Number.isNaN(Number(roundRaw)) || !Number.isInteger(Number(roundRaw)) || Number(roundRaw) < 0)) {
    console.error("--round 必须是 ≥0 的整数")
    process.exit(1)
  }
  const evidence = evidenceRaw as EvidenceMode
  if (evidence === "engine-only" && get("eval-suffix") !== undefined) {
    console.error("--evidence engine-only 与 --eval-suffix 互斥（engine-only 不读任何 eval 产物）")
    process.exit(1)
  }
  return {
    runDirs,
    out,
    side: side as 0 | 1,
    thinking: args.includes("--no-thinking") ? false : true,
    temperature: Number(get("temperature") ?? 0.2),
    seed: get("seed") !== undefined ? Number(get("seed")) : undefined,
    model: get("model"),
    evalSuffix: get("eval-suffix"),
    evidence,
    turns: Number(get("turns") ?? 1),
    moduleBudget: Number(get("module-budget") ?? 12),
    perTurnModules: Number(get("per-turn-modules") ?? 4),
    patch: args.includes("--patch"),
    maxPatchOps: Number(get("max-patch-ops") ?? 8),
    stream: args.includes("--stream"),
    maxTokens: Number(get("max-tokens") ?? 32768),
    portfolio,
    round: roundRaw !== undefined ? Number(roundRaw) : undefined,
    force: args.includes("--force"),
  }
}

/** one-shot 路径的系统提示词按证据口径选取（harness 路径走 buildReflectSystemPrompt） */
function oneShotSystemPrompt(evidence: EvidenceMode): string {
  return evidence === "engine-only" ? REFLECT_SYSTEM_PROMPT_ENGINE_ONLY : REFLECT_SYSTEM_PROMPT
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T
  } catch {
    return null
  }
}

interface ReflectResult {
  basePlanId?: string
  predictionPostmortem?: string
  ruleVerdicts?: Array<{ ruleRef?: string; verdict?: string; justification?: string; falsifiableClaim?: string | null }>
  revisedPlan?: GamePlanV1
  revisedPredictions?: GamePlanV1["predictions"]
  /** patch 模式下全量稿覆盖已合并 patch 的显式确认（存在累计 patch 时缺省会被打回一次） */
  overwritePatches?: boolean
}

export interface ReflectCandidate {
  result: ReflectResult
  revised: GamePlanV1
  /** 劝告性警告（ruleRef 不在原计划等；不阻断验收，与 one-shot 口径一致） */
  warnings: string[]
  /** portfolio 模式：合并后的分层工作计划（general + singles；legacy 缺省） */
  workingPortfolio?: WorkingPortfolio
}

/** 从 base plan 收集全部合法 ruleRef（global + phases + opening；拼键统一走 rule-key.ts） */
function collectRuleRefs(plan: GamePlanV1): Set<string> {
  return collectRuleKeys(plan)
}

/** 合并产物收尾（one-shot 修复循环 / harness draft / patch 合并共用）：
 *  谱系与系统字段接管 → auto-repair 死规则 → sampling → planId。 */
function finalizeMerged(
  raw: GamePlanV1,
  basePlan: GamePlanV1,
  args: ReflectArgs,
  validCtx: PlanValidationContext,
  predictionsOverride?: GamePlanV1["predictions"],
): { plan: GamePlanV1; dropped: string[] } {
  const candidate = normalizePlanNumericFields(raw)
  if (predictionsOverride) candidate.predictions = predictionsOverride
  candidate.parentPlanId = basePlan.planId
  candidate.createdAt = new Date().toISOString()
  // 授权边界（纵深防御）：context 永远接管自原计划——即便上游解析漏了越界键也写不进来
  candidate.context = basePlan.context
  const repaired = autoRepairPlan(candidate, validCtx)
  repaired.plan.sampling = { temperature: args.temperature, ...(args.seed !== undefined ? { seed: args.seed } : {}) }
  repaired.plan.planId = computePlanId(repaired.plan)
  return repaired
}

function validCtxOf(plan: GamePlanV1): PlanValidationContext {
  const deck = DEFAULT_ASSETS_MANAGER.decode(plan.context.deckCode)
  const opp = plan.context.opponent
  const opponentDeck = opp.kind === "mirror" ? deck
    : opp.kind === "known_deck" ? DEFAULT_ASSETS_MANAGER.decode(opp.deckCode)
    : undefined
  return { deck, opponentDeck }
}

/**
 * 修订计划制备（one-shot 修复循环与 harness 校验回调共用）。
 * 返回 null 表示 revisedPlan 缺失/非对象。
 */
function prepareRevised(
  result: ReflectResult,
  basePlan: GamePlanV1,
  args: ReflectArgs,
  validCtx: PlanValidationContext,
): { revised: GamePlanV1; dropped: string[] } | null {
  if (!result.revisedPlan || typeof result.revisedPlan !== "object" || Array.isArray(result.revisedPlan)) {
    return null
  }
  const repaired = finalizeMerged(result.revisedPlan, basePlan, args, validCtx, result.revisedPredictions)
  return { revised: repaired.plan, dropped: repaired.dropped }
}

/** 劝告性检查：ruleVerdicts 的 ruleRef 必须存在于 basePlan（封闭集合，设计文档 §6）；
 *  patch 模式放行合成 ref（add:* / fallback）。
 *  portfolio 模式（portfolio 参数非空）：合法键 = 各层树按层展开的并集
 *  （general 层无前缀→general:*，singles 带 single:<label>: 前缀）。 */
function ruleRefWarnings(result: ReflectResult, basePlan: GamePlanV1, patchMode: boolean, portfolio?: ResolvedPortfolio): string[] {
  const valid = new Set<string>()
  if (portfolio) {
    for (const k of collectRuleKeys(portfolio.general, { kind: "general" })) valid.add(k)
    for (const s of portfolio.singles) {
      for (const k of collectRuleKeys(s.plan, { kind: "single", label: s.label })) valid.add(k)
    }
  } else {
    for (const k of collectRuleRefs(basePlan)) valid.add(k)
  }
  const warnings: string[] = []
  for (const [i, v] of (result.ruleVerdicts ?? []).entries()) {
    const ref = v?.ruleRef
    if (typeof ref !== "string" || ref.length === 0) {
      warnings.push(`ruleVerdicts[${i}]: missing ruleRef`)
    } else if (patchMode && isSyntheticPatchRef(ref)) {
      continue
    } else if (!valid.has(ref)) {
      warnings.push(`ruleVerdicts[${i}]: ruleRef "${ref}" is not in the base plan (legal values look like ${[...valid].slice(0, 3).join(" / ")} …)`)
    }
  }
  return warnings
}

/** run 目录分组（交叉对手证据包）：label = 目录 basename */
interface RunGroup {
  dir: string
  label: string
  plan: GamePlanV1
  summary: Record<string, unknown>
  /** engine-only 恒 null（eval 读取门控） */
  evalSummary: Record<string, unknown> | null
  opponentNote: string
}

/** 对手组标注：尽量解码对手牌表角色名（对侧计划 > context.opponent > 镜像兜底） */
async function opponentNoteOf(dir: string, side: 0 | 1, plan: GamePlanV1): Promise<string> {
  const charsOf = (code: string): string | null => {
    try {
      const d = DEFAULT_ASSETS_MANAGER.decode(code)
      return d.characters.map((c) => DEFAULT_ASSETS_MANAGER.getNameSync(c) ?? String(c)).join("/")
    } catch {
      return null
    }
  }
  const oppPlan = await readJson<GamePlanV1>(join(dir, `plan.side${side === 0 ? 1 : 0}.json`))
  if (oppPlan) {
    const chars = charsOf(oppPlan.context.deckCode)
    if (chars) return `(opponent plan ${oppPlan.planId}: ${chars})`
  }
  const opp = plan.context.opponent
  if (opp.kind === "mirror") return "(mirror)"
  if (opp.kind === "known_deck") {
    const chars = charsOf(opp.deckCode)
    if (chars) return `(opponent deck ${chars})`
  }
  return ""
}

/** portfolio 回放的聚合 fallback 率（totalFallback / totalPoints；空语料为 0） */
function portfolioFallbackRate(r: PortfolioReplayResult): number {
  return r.totalPoints > 0 ? r.totalFallback / r.totalPoints : 0
}

/** 卡面校核段（进首轮 user 消息；不占模块预算、不落模块 kind） */
function formatCardFaceSection(lines: readonly string[], version: string): string {
  const header = `# Card-face checks (pure mechanical static comparison; source: @gi-tcg/data source fact table, local static scan, no network; version ${version})`
  if (lines.length === 0) {
    return `${header}\n\nNo cost / HP-cap / base-damage inconsistencies found.`
  }
  const shown = lines.slice(0, 20)
  const omitted = lines.length - shown.length
  return [
    header,
    "",
    ...shown.map((l) => `- ${l}`),
    ...(omitted > 0 ? [`- …${omitted} more findings of the same kind omitted by the line limit`] : []),
    "",
    "Note: a dice gate below the card cost means the rule's then cannot fire when the dice just meet the gate (suspected cost mistake); above the cost it may be a mistake or dice reserved for follow-up actions (heuristic). Dynamic damage, reaction-bonus arithmetic and effect semantics are out of scope.",
  ].join("\n")
}

/** 锚点断言旁档路径（author 产物 <out>.anchor-assertions.json 随主计划归档到 run 目录） */
function anchorSidecarPath(dir: string, side: 0 | 1): string {
  return join(dir, `plan.side${side}.anchor-assertions.json`)
}

const ANCHOR_STATUS_LABELS: Record<string, string> = { ok: "ok", issue: "issue", unchecked: "unchecked" }

function anchorStatusLabel(status: string): string {
  return ANCHOR_STATUS_LABELS[status] ?? status
}

function describeKillMathAssertion(a: AnchorKillMathAssertion): string {
  const parts: string[] = []
  if (a.characterDefId !== null) parts.push(`character ${a.characterDefId}`)
  if (a.source !== null) parts.push(`"${a.source}"`)
  parts.push(a.damage !== null ? `damage=${a.damage}` : "damage missing")
  if (a.skillType !== null) parts.push(`skillType=${a.skillType}`)
  if (a.costAssertion !== null) parts.push(`costAssertion="${a.costAssertion}"`)
  if (a.reactionPrereq !== null) parts.push(`reaction prerequisite "${a.reactionPrereq}"`)
  return parts.join(" ")
}

function describeComboLineAssertion(a: AnchorComboLineAssertion): string {
  const parts = [`"${a.name}"`, `requiredCardDefIds=[${a.requiredCardDefIds.join(", ")}]`]
  if (a.earliestRound !== null) parts.push(`earliest round ${a.earliestRound}`)
  if (a.diceNeeded !== null) parts.push(`diceNeeded="${a.diceNeeded}"`)
  return parts.join(" ")
}

/** 断言 × author 时检查 × 当前版本重算（逐条一行） */
function anchorAssertionLines(
  sidecar: AnchorAssertionsSidecar,
  recomputed: AnchorCheckResult,
  prefix: string,
): { lines: string[]; unchecked: string[] } {
  const line = (storedStatus: string, now: { status: string; detail: string } | undefined): string => {
    const nowText = now === undefined
      ? "missing"
      : `${anchorStatusLabel(now.status)}${now.detail !== "" ? `: ${now.detail}` : ""}`
    return `at author time ${anchorStatusLabel(storedStatus)}; recomputed at current version ${nowText}`
  }
  const lines: string[] = []
  sidecar.killMath.forEach((stored, i) => {
    lines.push(`${prefix}killMath[${i}] ${describeKillMathAssertion(stored)} —— ${line(stored.status, recomputed.killMath[i])}`)
  })
  sidecar.comboLines.forEach((stored, i) => {
    lines.push(`${prefix}comboLines[${i}] ${describeComboLineAssertion(stored)} —— ${line(stored.status, recomputed.comboLines[i])}`)
  })
  return { lines, unchecked: recomputed.unchecked.map((u) => `${prefix}${u}`) }
}

/** 锚点断言校核段（进首轮 user 消息；与卡面校核同通道，不占模块预算） */
function formatAnchorAssertionsSection(
  lines: readonly string[],
  unchecked: readonly string[],
  meta: { authorVersion: string | undefined; version: string },
): string {
  const header = `# Anchor assertion checks (author anchor numeric assertions × current-version card-face ground truth recomputation; sources: author anchor sidecar + @gi-tcg/data source fact table; author version ${meta.authorVersion ?? "unpinned"} / current version ${meta.version})`
  const shown = lines.slice(0, 20)
  const omitted = lines.length - shown.length
  const shownUnchecked = unchecked.slice(0, 8)
  const omittedUnchecked = unchecked.length - shownUnchecked.length
  return [
    header,
    "",
    ...(shown.length > 0 ? shown.map((l) => `- ${l}`) : ["- (the sidecar has no killMath/comboLines assertion entries)"]),
    ...(omitted > 0 ? [`- …${omitted} more assertions omitted by the line limit`] : []),
    ...(shownUnchecked.length > 0
      ? ["", `Unchecked (current-version recomputation; ${unchecked.length} total):`, ...shownUnchecked.map((u) => `  - ${u}`), ...(omittedUnchecked > 0 ? [`  - …${omittedUnchecked} more omitted`] : [])]
      : []),
    "",
    "Note: costAssertion is compared against the skill's card-face cost in the deck-detail cost format (e.g. \"3雷+2充能\"): dice total / energy / element composition; damage is compared against the skill's literal base damage + 2 (reaction/buff allowance) and anything above it is flagged for review; dynamic damage and effect semantics are out of scope. These assertions produce no engine-side mechanical signal (thenMiss/fallback cannot see them), so check them first when revising. The \"live match\" leg is a v1 extension point (perRuleHits on kills rules already implies a kill count).",
  ].join("\n")
}

/**
 * 逐组读锚点断言旁档并按当前版本（planVersion）重算——纯机械、无 LLM。
 * portfolio 模式不适用（锚点树为单树产物，分层 portfolio 无锚点旁档）。
 */
async function buildAnchorAssertionsSection(
  groups: readonly RunGroup[],
  side: 0 | 1,
  plan: GamePlanV1,
  table: CardFaceTable,
  version: string,
): Promise<string> {
  const loaded: Array<{ label: string; sidecar: AnchorAssertionsSidecar }> = []
  for (const g of groups) {
    const sidecar = await readJson<AnchorAssertionsSidecar>(anchorSidecarPath(g.dir, side))
    if (sidecar) loaded.push({ label: g.label, sidecar })
  }
  if (loaded.length === 0) {
    return plan.sampling?.anchor === true
      ? `# Anchor assertion checks\n\nNo anchor-assertion sidecar (this plan was authored with --anchor, but the run directory did not archive plan.side${side}.anchor-assertions.json — old artifact or missing sidecar; anchor numeric assertions cannot be checked this time).`
      : ""
  }
  const deck = DEFAULT_ASSETS_MANAGER.decode(plan.context.deckCode)
  const lines: string[] = []
  const unchecked: string[] = []
  let authorVersion: string | undefined
  for (const { label, sidecar } of loaded) {
    const recomputed = checkAnchorAssertions(sidecar, deck, table)
    if (authorVersion === undefined) authorVersion = sidecar.gameVersion
    const prefix = groups.length > 1 ? `[${label}] ` : ""
    const r = anchorAssertionLines(sidecar, recomputed, prefix)
    lines.push(...r.lines)
    unchecked.push(...r.unchecked)
  }
  return formatAnchorAssertionsSection(lines, unchecked, { authorVersion, version })
}

// ── 替代路线参考（--candidates 旁档；reflect 换轴素材）──────────────────────

/** alternates 旁档路径（author 产物 <out>.alternates.json 随主计划归档到 run 目录） */
function alternatesSidecarPath(dir: string, side: 0 | 1): string {
  return join(dir, `plan.side${side}.alternates.json`)
}

interface LoadedAlternates {
  /** 旁档来源组 label（多对手组时标注） */
  groupLabel: string
  sidecar: PlanAlternatesSidecar
}

/** 逐组读 alternates 旁档；取首个命中，多组候选集不一致时告警并以首个为准 */
async function loadAlternatesForRun(groups: readonly RunGroup[], side: 0 | 1): Promise<LoadedAlternates | null> {
  let found: LoadedAlternates | null = null
  for (const g of groups) {
    const sidecar = await readJson<PlanAlternatesSidecar>(alternatesSidecarPath(g.dir, side))
    if (sidecar === null || !Array.isArray(sidecar.candidates)) continue
    if (found === null) {
      found = { groupLabel: g.label, sidecar }
      continue
    }
    const a = found.sidecar.candidates.map((c) => `${c.index}:${c.plan?.planId}`).join(",")
    const b = sidecar.candidates.map((c) => `${c.index}:${c.plan?.planId}`).join(",")
    if (a !== b || found.sidecar.chosenIndex !== sidecar.chosenIndex) {
      console.warn(`[alternates] 组 ${g.label} 的候选集与 ${found.groupLabel} 不一致——换轴以 ${found.groupLabel} 为准`)
    }
  }
  return found
}

/** 替代路线参考段（进首轮 user 消息；只给形状摘要与评审短评，不注入整棵树） */
function formatAlternatesSection(loaded: LoadedAlternates, multi: boolean): string {
  const { sidecar } = loaded
  const header = `# Alternative routes (r0 multi-candidate artifacts${multi ? `; source group ${loaded.groupLabel}` : ""})`
  const lines = sidecar.candidates.map((c) => {
    const chosen = c.index === sidecar.chosenIndex ? " | **adopted in this run**" : ""
    const note = c.reviewNote !== "" ? ` | review: ${c.reviewNote}` : ""
    const adopted = c.adoptedUnits.length > 0 ? ` | grafted: ${c.adoptedUnits.join("+")}` : ""
    return `- candidate ${c.index} | archetype=${c.archetype}${chosen}${note}${adopted}\n  ${planShapeSummary(c.plan)}`
  })
  return [
    header,
    "",
    ...lines,
    "",
    `Note: candidate ${sidecar.chosenIndex} is the source of the current plan; the other candidates are only referenceable at the route level. Switching routes must go through the \`switch_route\` command, which performs **unit-level grafting** (opening / fallback / rules / phase:<phaseId>; at most 2 units per call and 2 per run) and is only available in \`--patch\` harness mode; a graft is re-checked by validate + static lint + static replay and must state a falsifiableClaim that the ablation pipeline can verify.`,
  ].join("\n")
}

async function main() {
  loadDotEnvFallback()
  const args = parseArgs()
  const engineOnly = args.evidence === "engine-only"

  // ── 载入各 run 目录（engine-only 先做泄漏断言：不允许依赖"文件恰好不存在"的隐式卫生）──
  const groups: RunGroup[] = []
  for (const dir of args.runDirs) {
    if (engineOnly) {
      const leaks = await findOracleArtifacts(dir)
      if (leaks.length > 0) {
        console.error(`--evidence engine-only 泄漏断言失败：${dir} 内存在 oracle 回算产物（${leaks.length} 个）：`)
        for (const l of leaks.slice(0, 10)) console.error(`  ${l}`)
        console.error("先移除这些文件（或换干净 run 目录）再反思——reflect 必须物理不可见 oracle 产物。")
        process.exitCode = 1
        return
      }
    }
    const planPath = join(dir, `plan.side${args.side}.json`)
    const gPlan = await readJson<GamePlanV1>(planPath)
    if (!gPlan) {
      console.error(`找不到计划文件：${planPath}`)
      process.exitCode = 1
      return
    }
    // 批跑 summary 与 oracle 汇总都按侧读取（修复后的批跑按计划聚合：side0 →
    // summary.json / plan_eval_summary.json，side1 → summary.side1.json /
    // plan_eval_summary.side1.json，均为该计划口径，无需胜率反转）
    const summaryName = args.side === 0 ? "summary.json" : "summary.side1.json"
    const summary = await readJson<Record<string, unknown>>(join(dir, summaryName))
    if (!summary) {
      console.error(`找不到本侧批跑 summary：${join(dir, summaryName)}（旧版批跑只有 side0 口径 summary.json——请用修复后的 plan:batch 重跑基线）`)
      process.exitCode = 1
      return
    }
    const evalSuffix = args.evalSuffix ? `.${args.evalSuffix}` : ""
    const evalSummaryName = args.side === 0 ? `plan_eval_summary${evalSuffix}.json` : `plan_eval_summary${evalSuffix}.side1.json`
    const evalSummary = engineOnly ? null : await readJson<Record<string, unknown>>(join(dir, evalSummaryName))
    groups.push({ dir, label: basename(dir), plan: gPlan, summary, evalSummary, opponentNote: await opponentNoteOf(dir, args.side, gPlan) })
  }

  // ── portfolio 模式（Phase 3b）：装载 manifest + 逐组 portfolio.side0.json 断言 ──
  let portfolio: ResolvedPortfolio | null = null
  if (args.portfolio) {
    const loaded = await loadPortfolioWithValidation(args.portfolio)
    portfolio = loaded.portfolio
    for (const w of loaded.warnings) console.warn(`[portfolio warn] ${w}`)
    console.log(`[portfolio] id=${portfolio.portfolioId} general=${portfolio.generalId} singles=[${portfolio.singles.map((s) => `${s.label}:${s.planId}`).join(", ") || "（空）"}]`)
  }
  // 本侧主计划：portfolio 模式 = manifest 的 general（组内 plan.sideN.json 仍各自读，用于 legacy 断言/告警）
  const plan = portfolio ? portfolio.general : groups[0].plan

  // 产物 tag（--round N → r<N>，缺省沿用 manifest generalPlan 文件名 tag）。
  // 提前计算：replay-report 文件名（P0-3）在失败路径也要落盘，不能等 finalGate 之后。
  const portfolioTag = portfolio !== null
    ? portfolioTagOf({ round: args.round, portfolioPath: args.portfolio! }, portfolio.manifest)
    : null

  // 版本钉扎（V1）：反思版本 = portfolio 各层共同版本 ?? 计划声明 ?? CURRENT_VERSION；
  // 证据 run 目录的 summary gameVersion 与之断言（旧产物未标注 → warning；错配 → 中断，--force 降级）
  let planVersion: Version
  try {
    planVersion = portfolio?.commonGameVersion ?? resolveDeclaredPlanVersion(plan)
  } catch (e) {
    console.error(`[version] ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    return
  }
  {
    const check = checkRunDirVersions(
      groups.map((g) => ({ dir: g.dir, version: (g.summary as { gameVersion?: string }).gameVersion })),
      planVersion,
      { force: args.force },
    )
    for (const w of check.warnings) console.warn(`[version warn] ${w}`)
    if (check.errors.length > 0) {
      for (const e of check.errors) console.error(`[version] ${e}`)
      console.error("run 目录与计划版本错配——请统一版本后重试，或加 --force 放行（降级 warning）。")
      process.exitCode = 1
      return
    }
    console.log(`[version] reflect gameVersion=${planVersion}（静态求值/回放数据按此版本；--force=${args.force}）`)
  }

  // ── 卡面校核（2026-09-08）：一次构建、run 内复用 ──
  // 真值全部来自 @gi-tcg/data 源码事实表（纯本地静态扫描、零网络；费用/HP/基础伤害
  // 同源，含 `.since`/`.until` 版本变体）。校核结果注入首轮 user 消息（不占模块预算）
  // 并进 lint。
  const cardFace = buildCardFaceTable({ gameVersion: planVersion })
  // assets 仅供 harness 模块取数（card_detail/character_detail）——第 4 类校核已不消费资产数据
  const assets = assetsManagerForVersion(planVersion)
  // deck 供 then.skill_def_id 存在性校核（decode 为静态映射，零网络）
  const lintCtx: PlanLintContext = { cardFace, deck: DEFAULT_ASSETS_MANAGER.decode(plan.context.deckCode) }

  const cardFaceLinesOf = (p: GamePlanV1, prefix = ""): string[] =>
    lintPlan(p, lintCtx)
      .filter((f) => f.kind === "card-face")
      .map((f) => `${prefix}${f.path} ${f.message}`)
  const cardFaceLines: string[] = portfolio !== null
    ? [
        ...cardFaceLinesOf(portfolio.general),
        ...portfolio.singles.flatMap((s) => cardFaceLinesOf(s.plan, `single:${s.label} `)),
      ]
    : cardFaceLinesOf(plan)

  if (portfolio) {
    // 组断言：全部组必须有 portfolio.side0.json 且 portfolioId 组间相等 + 与 manifest 重算值一致
    const groupArchives = []
    for (const g of groups) {
      groupArchives.push({ label: g.label, archive: await readPortfolioRunArchive(g.dir) })
    }
    const errors = assertPortfolioGroupIds(groupArchives, portfolio.portfolioId)
    if (errors.length > 0) {
      for (const e of errors) console.error(e)
      process.exitCode = 1
      return
    }
  } else {
    // legacy：维持 planId 断言（旧 roundS 流程逐行不变）
    for (const g of groups.slice(1)) {
      if (g.plan.planId !== plan.planId) {
        console.error(`交叉对手证据包要求同一计划：${groups[0].label} planId=${plan.planId}，但 ${g.label} planId=${g.plan.planId}`)
        process.exitCode = 1
        return
      }
    }
  }

  // ── 组 → Single 路由判定（D6 素材与 plan_simulate 分层矩阵的组形态）──
  const singleLabelByGroup = new Map<string, string>()
  if (portfolio) {
    for (const g of groups) {
      const label = await resolveGroupSingleLabel(g.dir, args.side, portfolio)
      if (label) singleLabelByGroup.set(g.label, label)
    }
  }

  // ── 逐组证据提取（先于统计文本：engine-only 的 declareEnd 监控要用 digest 计数）──
  const multi = groups.length > 1
  // 多对手合并时全量摘要按组均分行数预算（防 prompt 体量随组数膨胀）
  const digestBudget = Math.max(80, Math.floor(420 / groups.length))
  const evidences = await Promise.all(groups.map((g) => extractDecisionEvidence(g.dir, args.side, {
    evalSuffix: args.evalSuffix,
    evidence: args.evidence,
    label: multi ? g.label : undefined,
  })))
  const digests = await Promise.all(groups.map((g) => extractFullDigest(g.dir, args.side, {
    evalSuffix: args.evalSuffix,
    evidence: args.evidence,
    label: multi ? g.label : undefined,
    maxLines: multi ? digestBudget : undefined,
  })))

  // ── 权威统计文本（单目录 oracle 口径与历史版逐字节一致）──
  const statsParts: string[] = []
  if (multi) {
    const totalN = groups.reduce((s, g) => s + ((g.summary.games as number) ?? 0), 0)
    statsParts.push(`Total sample N=${totalN} games across ${groups.length} opponent groups (per-group stats below; read them per group and do not merge away minority signals):`)
  }
  groups.forEach((g, i) => {
    const summary = g.summary
    const n = (summary.games as number) ?? 0
    const thenMiss = summary.perRuleThenMiss as Record<string, number> | undefined
    const block: string[] = []
    if (multi) block.push(`### Opponent group ${g.label}${g.opponentNote}`)
    block.push(
      `Sample N=${n} games`,
      `Win rate ${((summary.winRate as number) * 100).toFixed(1)}% (${summary.wins}W/${summary.losses}L/${summary.draws}D)`,
      `Average rounds ${(summary.avgRounds as number).toFixed(1)}`,
      `Rule coverage avgCoverage=${((summary.avgCoverage as number) * 100).toFixed(1)}%, fallback rate=${((summary.fallbackRate as number) * 100).toFixed(1)}%`,
      `Rule-hit heatmap: ${JSON.stringify(summary.perRuleHits)}`,
      `when matched but then zero-hit (dead-rule probe: the conditions were right but the action mapping was wrong): ${JSON.stringify(thenMiss ?? {})}`,
      `Per game: ${JSON.stringify(summary.perGame)}`,
    )
    // evalSummary 注入在 engine-only 模式整体跳过（泄漏通道 §1.1）
    if (!engineOnly) {
      block.push(g.evalSummary
        ? `oracle re-evaluation (${args.evalSuffix ? args.evalSuffix.toUpperCase() : "ISMCTS"}): blunderRate=${((g.evalSummary.blunderRate as number) * 100).toFixed(1)}% (${g.evalSummary.totalAlignmentMisses ?? 0} alignment-miss points excluded), per-rule attribution: ${JSON.stringify(g.evalSummary.perRule)}`
        : "oracle re-evaluation: not run")
    }
    if (engineOnly) {
      // 护栏（§4）：perRuleHits=0 告警（"改没了"检测）+ declareEnd 占比（龟缩化代际监控）
      // portfolio 模式：组内 perRuleHits 键带层前缀（batch-runner 层化），零命中检测用
      // 本组 general 层的层化键（general:*），legacy 无层键照旧
      const refs = portfolio !== null
        ? [...collectRuleKeys(g.plan, { kind: "general" })]
        : [...collectRuleRefs(g.plan)]
      const zeroHits = refs
        .filter((ref) => ((summary.perRuleHits as Record<string, number> | undefined)?.[ref] ?? 0) === 0)
      block.push(`Zero-hit rule warning (perRuleHits=0 — when was never true; "removed by revision" or never effective): ${JSON.stringify(zeroHits)}`)
      const dg = digests[i]
      if (dg.totalPoints > 0) {
        block.push(`declareEnd decision share=${((dg.declareEnds / dg.totalPoints) * 100).toFixed(1)}% (${dg.declareEnds}/${dg.totalPoints}; rising across generations = turtling signal)`)
      }
    }
    statsParts.push(block.join("\n"))
  })
  statsParts.push(`Pre-game predictions: ${JSON.stringify(plan.predictions)}`)
  // ── D6 层路由建议（portfolio 模式；k=2：证据键跨组共性 → General，单组 → 该组 Single）──
  if (portfolio) {
    const advice = buildLayerRoutingAdvice(groups.map((g) => ({
      label: g.label,
      singleLabel: singleLabelByGroup.get(g.label),
      perRuleThenMiss: g.summary.perRuleThenMiss as Record<string, unknown> | undefined,
      perRuleHits: g.summary.perRuleHits as Record<string, unknown> | undefined,
      perRuleEval: (g.evalSummary?.perRule as Record<string, unknown> | undefined) ?? undefined,
    })))
    if (advice.length > 0) {
      statsParts.push(`# D6 layer-routing advice (evidence keys across groups, k=2 rule: ≥2 groups → revise General; exactly 1 group → revise that group's Single; Single known-dead rules excepted). Hint only, not binding:\n${advice.join("\n")}`)
    }
  }
  const statsText = statsParts.join(multi ? "\n\n" : "\n")

  // ── 局面级证据文本（engine-only：无 blunder 段，另产斩杀威胁点；行格式降级为引擎侧列）──
  const evidenceParts: string[] = []
  groups.forEach((g, i) => {
    const evidence = evidences[i]
    const fullDigest = digests[i]
    const hdr = multi ? ` (opponent group ${g.label})` : ""
    if (!engineOnly && evidence.blunderLines.length > 0) {
      evidenceParts.push(`## High-blunder decision points (oracle clearly prefers another action)${hdr}\n${evidence.blunderLines.map((l) => `- ${l}`).join("\n")}`)
    }
    if (evidence.fallbackLines.length > 0) {
      evidenceParts.push(`## fallback (no rule matched) positions${hdr}\n${evidence.fallbackLines.map((l) => `- ${l}`).join("\n")}`)
    }
    if (engineOnly && evidence.threatLines.length > 0) {
      evidenceParts.push(`## Lethal-threat points (opp.threat.lethal=true or lethalP≥0.5; high threat left undefended = direct evidence of a defensive gap)${hdr}\n${evidence.threatLines.map((l) => `- ${l}`).join("\n")}`)
    }
    if (fullDigest.lines.length > 0) {
      const legend = engineOnly
        ? `<fallback>=no rule matched, engine fallback used; thenMiss=when all true but then zero-hit${fullDigest.omittedAligned > 0 ? `; ${fullDigest.omittedAligned} more regular lines omitted by the line limit` : ""}`
        : `✗ blunder=${fullDigest.blunders}, ~ divergence=${fullDigest.divergences}, ✓=matches oracle, <fallback>=no rule matched, engine fallback used${fullDigest.omittedAligned > 0 ? `; ${fullDigest.omittedAligned} more ✓ points omitted by the line limit` : ""}`
      evidenceParts.push(`## Full decision-point digest${hdr} (${fullDigest.totalPoints} points: ${legend})\n${fullDigest.lines.join("\n")}`)
    }
  })
  const evidenceText = evidenceParts.join("\n\n")

  // ── S-M3：engine-only 臂默认注入 fallback_detail 模块全文（round23 §5 C 级遗留项；
  //  one-shot 证据包已有 fallback top-N 摘要，默认注入只在 harness 模式追加）──
  // ── 覆盖率护栏（2026-09-03）：双臂默认注入 fallback_report 聚类聚合报告，
  //  把 fallback 缺口按（出战角色 × 回合）聚类呈现，供 LLM 判断是否针对性修正 ──
  const moduleCtxBase = () => ({
    runDir: groups[0].dir,
    // portfolio 模式：即使单组也带 runDirs（组 label + singleLabel 供分层矩阵/fallback_report 用）
    runDirs: (multi || portfolio !== null)
      ? groups.map((g) => ({ label: g.label, dir: g.dir, singleLabel: singleLabelByGroup.get(g.label) }))
      : undefined,
    side: args.side,
    evalSuffix: args.evalSuffix,
    evidence: args.evidence,
    assets,
    ...(portfolio !== null ? { portfolio } : {}),
  })
  let defaultModulesText = ""
  if (args.turns > 1) {
    const kinds = engineOnly
      ? [{ kind: "fallback_report" }, { kind: "fallback_detail" }]
      : [{ kind: "fallback_report" }]
    const served = await createModuleResolver("reflect", moduleCtxBase())(kinds)
    defaultModulesText = `# Default injected modules\n\n${served.map((m) => `## ${m.key}\n${m.content}`).join("\n\n")}\n\n`
  }

  const patchIntro = args.patch
    ? portfolio !== null
      ? `\n\n# Revision mode\n\nThis round enables **patch revision mode (two-layer portfolio)**: do not resend the full plan — in the restricted ops, revise/remove ruleRefs must carry the layer prefix (\`general:…\` / \`single:<label>:…\`), and add/set_fallback must carry the \`layer\` key (see the system prompt's patch revision protocol and two-layer discipline). The harness merges per layer server-side and feeds back static-replay verification. Untouched rules are kept by default.`
      : `\n\n# Revision mode\n\nThis round enables **patch revision mode**: do not resend the full plan — submit restricted ops (see the system prompt's patch revision protocol); the harness merges them server-side and feeds back static-replay verification. Untouched rules are kept by default.`
    : ""
  // 计划 JSON 用紧凑格式（缩减 prompt 体量，长推理请求对 token 数敏感）
  // portfolio 模式：原计划 = 两层结构（general + singles 各层树，LLM 需看到全部层才能写层化 ruleRef）
  const planSection = portfolio !== null
    ? `# Two-layer portfolio (portfolioId=${portfolio.portfolioId})\n\n## General (planId=${portfolio.general.planId})\n\n\`\`\`json\n${JSON.stringify(portfolio.general)}\n\`\`\`\n\n${portfolio.singles.map((s) => `## Single: ${s.label} (opponent ${s.opponentDeckCode}, planId=${s.planId})\n\n\`\`\`json\n${JSON.stringify(s.plan)}\n\`\`\``).join("\n\n")}`
    : `# Base plan\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``
  const cardFaceSection = formatCardFaceSection(cardFaceLines, planVersion)
  // ── 锚点断言校核（2026-09-08）：author 锚点旁档 × 当前版本重算（同通道注入）──
  let anchorAssertionSection = ""
  if (portfolio !== null) {
    console.log("[anchor-assertions] portfolio 模式：跳过锚点断言校核（锚点树为单树产物，分层 portfolio 无锚点旁档）")
  } else {
    anchorAssertionSection = await buildAnchorAssertionsSection(groups, args.side, plan, cardFace, planVersion)
    if (anchorAssertionSection !== "") console.log(`[anchor-assertions] 注入锚点断言校核段（${anchorAssertionSection.length} 字符）`)
  }
  // ── 替代路线参考（--candidates 旁档；switch_route 换轴素材）──
  const alternates = await loadAlternatesForRun(groups, args.side)
  let alternatesSection = ""
  if (portfolio !== null) {
    if (alternates !== null) console.log("[alternates] portfolio 模式：跳过替代路线参考段与 switch_route（单树产物）")
  } else if (alternates !== null) {
    alternatesSection = formatAlternatesSection(alternates, groups.length > 1)
    console.log(`[alternates] 注入替代路线参考段（${alternates.sidecar.candidates.length} 个候选，来源组 ${alternates.groupLabel}）`)
  }
  const user = `${planSection}\n\n# Battle stats (authoritative; treat these as ground truth)\n\n${statsText}\n\n${evidenceText ? `# Decision-point evidence (position-level diagnostic material)\n\n${evidenceText}\n\n` : ""}${cardFaceSection}\n\n${anchorAssertionSection !== "" ? `${anchorAssertionSection}\n\n` : ""}${alternatesSection !== "" ? `${alternatesSection}\n\n` : ""}${defaultModulesText}${patchIntro ? `${patchIntro}\n\n` : ""}Output ${args.patch ? `the first JSON command (patch / request_modules${alternatesSection !== "" ? " / switch_route" : ""})` : "the ReflectPlanResultV1 JSON"}.`

  const totalN = groups.reduce((s, g) => s + ((g.summary.games as number) ?? 0), 0)
  const totalBlunders = evidences.reduce((s, e) => s + e.blunderLines.length, 0)
  const totalFallbacks = evidences.reduce((s, e) => s + e.fallbackLines.length, 0)
  const digestLines = digests.reduce((s, d) => s + d.lines.length, 0)
  const digestPoints = digests.reduce((s, d) => s + d.totalPoints, 0)
  console.log(`reflecting on ${groups.map((g) => join(g.dir, `plan.side${args.side}.json`)).join(",")} (evidence=${args.evidence}, N=${totalN}, eval=${groups.some((g) => g.evalSummary) ? "yes" : "no"}, evidence: blunders=${totalBlunders} fallbacks=${totalFallbacks} threats=${evidences.reduce((s, e) => s + e.threatLines.length, 0)}, fullDigest=${digestLines}/${digestPoints}, cardFace=${cardFaceLines.length}, turns=${args.turns}${args.patch ? ", patch" : ""})…`)

  const validCtx = validCtxOf(plan)

  // harness 有界 agent 循环路径（--turns N>1）
  if (args.turns > 1) {
    // ── 惰性资源：GameData（静态求值用）与本侧回放语料（授权边界：plan-replay.ts）──
    // 版本按被修订计划解析（V1 版本钉扎）；plan_simulate / verifyPatchAssertions 等
    // 回放数据注入点全部经 ensureGameData 同口径取数
    let gameDataPromise: Promise<GameData> | null = null
    const ensureGameData = (): Promise<GameData> => (gameDataPromise ??= Promise.resolve(getData(planVersion)))
    let corpusPromise: Promise<ReplayCorpus> | null = null
    // 多对手证据包：语料为各组并集（loadMergedCorpus 内部给 game 名加组名前缀）
    const ensureCorpus = (): Promise<ReplayCorpus> => (corpusPromise ??= loadMergedCorpus(moduleCtxBase()))
    // portfolio 模式：逐组语料（分层矩阵 / 跨组断言需要 per-group corpus）
    let groupCorporaPromise: Promise<Map<string, ReplayCorpus>> | null = null
    const ensureGroupCorpora = (): Promise<Map<string, ReplayCorpus>> =>
      (groupCorporaPromise ??= Promise.all(groups.map(async (g) => [
        g.label,
        await loadReplayCorpus(g.dir, args.side, { evalSuffix: args.evalSuffix, evidence: args.evidence }),
      ] as const)).then((es) => new Map(es)))
    let baseReplayPromise: Promise<PlanReplayResult> | null = null
    const ensureBaseReplay = async (corpus: ReplayCorpus, gd: GameData): Promise<PlanReplayResult> =>
      (baseReplayPromise ??= Promise.resolve(replayPlan(plan, corpus, gd)))

    // ── 修订状态（闭包持有；模型永不重发完整树）──
    let workingPlan: GamePlanV1 = plan
    // portfolio 模式：分层工作闭包（初始 = 装载的 ResolvedPortfolio 结构；legacy 恒 null）
    let workingPortfolio: WorkingPortfolio | null = portfolio !== null
      ? { general: portfolio.general, singles: portfolio.singles.map((s) => ({ label: s.label, opponentDeckCode: s.opponentDeckCode, plan: s.plan })) }
      : null
    // portfolio 模式的初始快照（patch 前的原 tree——diff/断言基准恒为它，blame 键来自原 run）
    const initialPortfolio: WorkingPortfolio | null = workingPortfolio
    const initialPortfolioId = portfolio !== null ? portfolio.portfolioId : undefined
    let patchVerdicts: PatchVerdict[] = []
    let postmortem: string | undefined
    let predictionsOverride: GamePlanV1["predictions"] | undefined
    let lastPatchNote: string | undefined
    let appliedPatchOps = 0
    // ── switch_route 换轴状态（2026-09-08；仅 --patch harness + alternates 旁档）──
    // routeVerdicts：换轴合成的 ruleVerdicts（进最终 reflection 与消融臂）；
    // graftedThisRun：本 run 已嫁接单元（run 级 ≤2 上限，与候选无关，防路线横跳）；
    // adoptedByCandidate：逐候选已采纳单元（初值取旁档 adoptedUnits）；
    // routeSwitchRecords：换轴审计记录（落 <out>.reflection.json 的 routeSwitches）。
    let routeVerdicts: PatchVerdict[] = []
    const graftedThisRun = new Set<string>()
    const adoptedByCandidate = alternates !== null ? adoptedUnitMap(alternates.sidecar) : new Map<number, Set<string>>()
    const routeSwitchRecords: Array<{ candidateIndex: number; units: string[]; reason: string; falsifiableClaim: string; planId: string; adoptedUnits: string[] }> = []
    // P0-3：replay-report 累计器——patch 合并处的静态回放核验（逐 op 断言 + fallback 率）
    // 由 transcript 文本升级为结构化落盘；--patch 关闭时恒 null（不落盘）
    const replayReport: ReplayReport | null = args.patch
      ? createReplayReport(plan.planId, portfolio !== null ? portfolio.portfolioId : undefined)
      : null

    const buildSystem = buildReflectSystemPrompt(true, {
      maxTurns: args.turns,
      moduleBudget: args.moduleBudget,
      perTurnModules: args.perTurnModules,
      maxPatchOps: args.maxPatchOps,
    }, args.patch, args.evidence)

    // prompt 落盘：泄漏审计可机检（S-M1 验收：engine-only 全程无 oracle 字样进入 prompt）
    const promptOut = portfolio !== null ? join(args.out, "reflect.prompt.txt") : `${args.out}.prompt.txt`
    await mkdir(portfolio !== null ? args.out : dirname(args.out), { recursive: true })
    await writeFile(promptOut, `# SYSTEM\n\n${buildSystem}\n\n# USER（首轮）\n\n${user}\n`, "utf-8")

    const applyPatchCmd = async (cmd: unknown): Promise<{ ok: boolean; issues: string[]; statsNote?: string; lintFindings?: PlanLintFinding[] }> => {
      const parsed = parsePlanPatchCommand(cmd, { maxOps: args.maxPatchOps })
      if (!parsed.ok) return { ok: false, issues: parsed.errors }
      if (workingPortfolio !== null) {
        // ── portfolio 目标：分层合并（plan-patch.ts 新重载；ops 带层前缀 general:… / single:<label>:…）──
        const applied = applyPlanPatch(workingPortfolio, parsed.cmd)
        if (!applied.ok) return { ok: false, issues: applied.errors }
        // 逐层 finalize：context 接管 + 死规则 auto-repair + sampling + planId（每层各自的 base/validCtx；
        // predictions 同 legacy：合并进 predictionsOverride 闭包，裸 final 时经 revisedPredictions 应用）
        const genFinal = finalizeMerged(applied.portfolio.general, workingPortfolio.general, args, validCtxOf(workingPortfolio.general))
        const singlesByLabel = new Map(workingPortfolio.singles.map((s) => [s.label, s]))
        const nextSingles: WorkingPortfolio["singles"] = []
        const issues: string[] = []
        const droppedAll: string[] = []
        for (const s of applied.portfolio.singles) {
          const old = singlesByLabel.get(s.label)
          if (!old) {
            issues.push(`merged result contains an unknown single layer: ${s.label}`)
            continue
          }
          const fin = finalizeMerged(s.plan, old.plan, args, validCtxOf(old.plan))
          nextSingles.push({ label: s.label, opponentDeckCode: old.opponentDeckCode, plan: fin.plan })
          droppedAll.push(...fin.dropped)
          const v = validateGamePlan(fin.plan, validCtxOf(fin.plan))
          if (!v.ok) issues.push(...v.issues.map((i) => `single:${s.label} ${i.path}: ${i.message}`))
        }
        const gv = validateGamePlan(genFinal.plan, validCtxOf(genFinal.plan))
        if (!gv.ok) issues.push(...gv.issues.map((i) => `general ${i.path}: ${i.message}`))
        if (issues.length > 0) return { ok: false, issues }
        const lint = [
          ...lintPlan(genFinal.plan, lintCtx),
          ...nextSingles.flatMap((s) => lintPlan(s.plan, lintCtx).map((f) => ({ ...f, path: `single:${s.label} ${f.path}` }))),
        ]
        // 静态回放核验：分层矩阵（base = 初始 portfolio，blame 键来自原 run 的 eval 归因）
        const corpora = await ensureGroupCorpora()
        const gd = await ensureGameData()
        const groupInputs: PortfolioReplayGroupInput[] = groups.map((g) => ({
          label: g.label,
          singleLabel: singleLabelByGroup.get(g.label),
          corpus: corpora.get(g.label)!,
        }))
        const nextPortfolio: WorkingPortfolio = { general: genFinal.plan, singles: nextSingles }
        const baseReplay = replayPortfolio(initialPortfolio!, groupInputs, gd)
        const nextReplay = replayPortfolio(nextPortfolio, groupInputs, gd)
        const assertions = verifyPortfolioPatchAssertions(applied.appliedOps, groupInputs, initialPortfolio!, nextPortfolio, gd)
        // P0-3：本条 patch 命令的核验记录进 replay-report（聚合 + 逐对手组 fallback 率）
        replayReport && recordPatchReplay(replayReport, {
          opsCount: applied.appliedOps.length,
          assertions,
          fallbackRate: { base: portfolioFallbackRate(baseReplay), next: portfolioFallbackRate(nextReplay) },
          groups: groups.map((g) => ({
            label: g.label,
            fallbackRate: {
              base: baseReplay.perGroup[g.label]?.replay.fallbackRate ?? 0,
              next: nextReplay.perGroup[g.label]?.replay.fallbackRate ?? 0,
            },
          })),
        })
        lastPatchNote = formatPortfolioPatchVerification({ opsCount: applied.appliedOps.length, assertions, base: baseReplay, next: nextReplay, lintFindings: lint })
        workingPortfolio = nextPortfolio
        patchVerdicts.push(...applied.verdicts)
        appliedPatchOps += applied.appliedOps.length
        if (parsed.cmd.predictionPostmortem) postmortem = parsed.cmd.predictionPostmortem
        if (parsed.cmd.predictions) predictionsOverride = { ...plan.predictions, ...parsed.cmd.predictions }
        const droppedNote = droppedAll.length > 0
          ? `note: auto-repair removed ${droppedAll.length} dead rules/entries (${droppedAll.join("; ")})`
          : ""
        return {
          ok: true,
          issues: [],
          lintFindings: lint,
          statsNote: `merged general rules=${genFinal.plan.rules?.length ?? 0}, phases=${genFinal.plan.phases?.length ?? 0}, fallback=${genFinal.plan.fallback?.policy}, planId=${genFinal.plan.planId}; singles=${nextSingles.map((s) => `${s.label}:${s.plan.planId}`).join(",") || "(empty)"}${droppedNote ? `; ${droppedNote}` : ""}\n\n${lastPatchNote}`,
        }
      }
      // legacy 单树路径（逐字节不变）
      const applied = applyPlanPatch(workingPlan, parsed.cmd)
      if (!applied.ok) return { ok: false, issues: applied.errors }
      // 授权边界收尾：parent/createdAt/context 强制接管 + 死规则 auto-repair + planId
      const finalized = finalizeMerged(applied.plan, plan, args, validCtx)
      const validation = validateGamePlan(finalized.plan, validCtx)
      if (!validation.ok) {
        return { ok: false, issues: validation.issues.map((i) => `${i.path}: ${i.message}`) }
      }
      const lint = lintPlan(finalized.plan, lintCtx)
      // 静态回放核验：diff 基准恒为原计划（blame 键来自原 run 的 eval 归因）
      const corpus = await ensureCorpus()
      const gd = await ensureGameData()
      const baseReplay = await ensureBaseReplay(corpus, gd)
      const nextReplay = replayPlan(finalized.plan, corpus, gd)
      const assertions = verifyPatchAssertions(applied.appliedOps, corpus, plan, finalized.plan, gd)
      // P0-3：本条 patch 命令的核验记录进 replay-report（schema 见 cli/replay-report.ts）
      replayReport && recordPatchReplay(replayReport, {
        opsCount: applied.appliedOps.length,
        assertions,
        fallbackRate: { base: baseReplay.fallbackRate, next: nextReplay.fallbackRate },
      })
      lastPatchNote = formatPatchVerification({ opsCount: applied.appliedOps.length, assertions, base: baseReplay, next: nextReplay, lintFindings: lint })
      workingPlan = finalized.plan
      patchVerdicts.push(...applied.verdicts)
      appliedPatchOps += applied.appliedOps.length
      if (parsed.cmd.predictionPostmortem) postmortem = parsed.cmd.predictionPostmortem
      if (parsed.cmd.predictions) predictionsOverride = { ...plan.predictions, ...parsed.cmd.predictions }
      const droppedNote = finalized.dropped.length > 0
        ? `note: auto-repair removed ${finalized.dropped.length} dead rules/entries (${finalized.dropped.join("; ")})`
        : ""
      const warnNote = validation.warnings.length > 0
        ? `; advisory warnings: ${validation.warnings.map((w) => `${w.path} ${w.message}`).join("; ")}`
        : ""
      return {
        ok: true,
        issues: [],
        lintFindings: lint,
        statsNote: `merged rules=${workingPlan.rules?.length ?? 0}, phases=${workingPlan.phases?.length ?? 0}, fallback=${workingPlan.fallback?.policy}, planId=${workingPlan.planId}${droppedNote ? `; ${droppedNote}` : ""}${warnNote}\n\n${lastPatchNote}`,
      }
    }

    // ── switch_route：换轴单元级嫁接（决定稿 2026-09-08；仅 legacy 单树 + alternates 旁档）──
    const applyRouteSwitchCmd = async (cmd: RouteSwitchCommand): Promise<{ ok: boolean; issues: string[]; statsNote?: string; lintFindings?: PlanLintFinding[] }> => {
      if (alternates === null) {
        return { ok: false, issues: ["this run has no alternates sidecar (plan.side<N>.alternates.json); switch_route is unavailable"] }
      }
      const sidecar = alternates.sidecar
      const candidateIndex = Number(cmd.candidateIndex)
      const candidate = sidecar.candidates.find((c) => c.index === candidateIndex)
      if (!Number.isInteger(candidateIndex) || candidate === undefined) {
        return { ok: false, issues: [`candidateIndex ${JSON.stringify(cmd.candidateIndex)} is not a valid candidate (available: ${sidecar.candidates.map((c) => c.index).join("/")})`] }
      }
      if (candidateIndex === sidecar.chosenIndex) {
        return { ok: false, issues: [`candidateIndex=${candidateIndex} is the tree already adopted by this run (chosenIndex) — pick another candidate to switch routes`] }
      }
      const reason = typeof cmd.reason === "string" ? cmd.reason.trim() : ""
      if (reason === "") return { ok: false, issues: ["switch_route is missing reason (must cite concrete evidence / route argument)"] }
      const claim = typeof cmd.falsifiableClaim === "string" ? cmd.falsifiableClaim.trim() : ""
      if (claim === "") return { ok: false, issues: ["switch_route is missing falsifiableClaim (a route switch is a single-variable arm; the ablation pipeline must be able to verify it)"] }
      const guard = checkGraftUnits(candidate.plan, cmd.units, {
        adopted: adoptedByCandidate.get(candidateIndex),
        graftedThisRun,
        maxUnits: 2,
      })
      if (!guard.ok) return { ok: false, issues: guard.errors }
      const { plan: grafted, applied } = applyRouteGraft(workingPlan, candidate.plan, guard.units)
      if (applied.length === 0) {
        return { ok: false, issues: ["units produced no graft (check the unit syntax and the phaseIds in the candidate tree)"] }
      }
      // 收尾：context/谱系接管 + 死规则 auto-repair + sampling + planId
      const finalized = finalizeMerged(grafted, plan, args, validCtx)
      const validation = validateGamePlan(finalized.plan, validCtx)
      if (!validation.ok) {
        return { ok: false, issues: validation.issues.map((i) => `${i.path}: ${i.message}`) }
      }
      const lint = lintPlan(finalized.plan, lintCtx)
      // 静态回放：diff 基准 = 嫁接前工作树（连续嫁接时逐次可比，而非恒对原始 plan）
      const corpus = await ensureCorpus()
      const gd = await ensureGameData()
      const baseReplay = replayPlan(workingPlan, corpus, gd)
      const nextReplay = replayPlan(finalized.plan, corpus, gd)
      if (replayReport) {
        recordPatchReplay(replayReport, {
          opsCount: applied.length,
          assertions: [],
          fallbackRate: { base: baseReplay.fallbackRate, next: nextReplay.fallbackRate },
        })
      }
      const verification = formatPatchVerification({ opsCount: applied.length, assertions: [], base: baseReplay, next: nextReplay, lintFindings: lint })
      // verdict 合成：换轴进 ruleVerdicts（ruleRef = 链锚点；opening/fallback 的消融臂为扩展点）
      for (const unit of applied) {
        const ruleRef = unit === "opening" ? "opening" : unit === "fallback" ? "fallback" : unit === "rules" ? "global" : unit
        routeVerdicts.push({
          ruleRef,
          verdict: "revise",
          justification: `route switch (candidate ${candidateIndex} | ${candidate.archetype}): ${reason}`,
          falsifiableClaim: claim,
          source: "patch",
        })
      }
      workingPlan = finalized.plan
      for (const unit of applied) {
        graftedThisRun.add(unit)
        const adopted = adoptedByCandidate.get(candidateIndex) ?? new Set<string>()
        adopted.add(unit)
        adoptedByCandidate.set(candidateIndex, adopted)
      }
      routeSwitchRecords.push({
        candidateIndex,
        units: [...applied],
        reason,
        falsifiableClaim: claim,
        planId: finalized.plan.planId,
        adoptedUnits: [...(adoptedByCandidate.get(candidateIndex) ?? [])],
      })
      const graftNote = `route graft: candidate ${candidateIndex} (${candidate.archetype}) units [${applied.join(" / ")}] → planId=${finalized.plan.planId} (parent=${plan.planId}; ${graftedThisRun.size}/2 units used this run)`
      const droppedNote = finalized.dropped.length > 0
        ? `note: auto-repair removed ${finalized.dropped.length} dead rules/entries (${finalized.dropped.join("; ")})`
        : ""
      lastPatchNote = `${graftNote}${droppedNote ? `\n${droppedNote}` : ""}\n\n${verification}`
      return { ok: true, issues: [], lintFindings: lint, statsNote: lastPatchNote }
    }

    const outcome = await runAgentLoop<ReflectCandidate>({
      label: "reflect",
      system: buildSystem,
      initialUser: user,
      maxTurns: args.turns,
      moduleBudget: args.moduleBudget,
      perTurnModuleLimit: args.perTurnModules,
      llm: {
        model: args.model ?? process.env.OPENAI_MODEL,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        seed: args.seed,
        thinking: args.thinking,
        stream: args.stream,
      },
      resolveModules: async (requests) => {
        // plan_simulate 需要 GameData（静态求值）；card_detail 亦复用数据管理器——统一惰性预取
        const gd = await ensureGameData()
        // portfolio 模式：plan_simulate 分层矩阵应预览**当前工作闭包**（patch 合并后）而非初始装载——
        // 构造当前 ResolvedPortfolio 形状（manifest/planRef 沿用，general/singles 取 workingPortfolio）
        const currentCtxPortfolio: ResolvedPortfolio | undefined = workingPortfolio !== null && portfolio !== null
          ? {
              manifest: portfolio.manifest,
              general: workingPortfolio.general,
              generalId: workingPortfolio.general.planId,
              singles: workingPortfolio.singles.map((s) => ({
                label: s.label,
                opponentDeckCode: s.opponentDeckCode,
                planRef: portfolio.singles.find((x) => x.label === s.label)?.planRef ?? s.label,
                plan: s.plan,
                planId: s.plan.planId,
              })),
              portfolioId: computePortfolioId({
                generalId: workingPortfolio.general.planId,
                singles: workingPortfolio.singles.map((s) => ({ label: s.label, opponentDeckCode: s.opponentDeckCode, planId: s.plan.planId })),
              }),
            }
          : undefined
        return createModuleResolver("reflect", {
          ...moduleCtxBase(),
          ...(currentCtxPortfolio !== undefined ? { portfolio: currentCtxPortfolio } : {}),
          currentPlan: () => (workingPortfolio !== null ? workingPortfolio.general : workingPlan),
          basePlan: plan,
          loadCorpus: () => ensureCorpus(),
          gameData: gd,
        })(requests)
      },
      applyPatch: args.patch ? applyPatchCmd : undefined,
      applySwitchRoute: args.patch && alternates !== null && portfolio === null ? applyRouteSwitchCmd : undefined,
      check: async (_action, payload) => {
        let result = payload as ReflectResult | null
        let barePatchFinal = false
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          // patch 模式裸 final：以累计 patch / switch_route 合并结果为产出（不经 draft 覆盖确认闸）
          if (patchVerdicts.length > 0 || appliedPatchOps > 0 || routeVerdicts.length > 0) {
            barePatchFinal = true
            if (!postmortem) {
              return { ok: false, issues: ["bare final is missing predictionPostmortem (in patch mode provide it with any patch, or let the final carry a full result)"] }
            }
            // portfolio 模式：revisedPlan = 分层闭包的 general 树（singles 经 workingPortfolio 携带）
            result = {
              basePlanId: plan.planId,
              predictionPostmortem: postmortem,
              ruleVerdicts: [...patchVerdicts, ...routeVerdicts],
              revisedPlan: workingPortfolio !== null ? workingPortfolio.general : workingPlan,
              revisedPredictions: predictionsOverride,
            }
          } else {
            return { ok: false, issues: [args.patch
              ? "the output is not a ReflectPlanResultV1 object and this round has no accumulated patch/switch_route to serve as the artifact (submit a patch first, or let the final carry a full result)"
              : "the output is not a ReflectPlanResultV1 object"] }
          }
        }
        // 全量稿将整体覆盖已合并的 patch/换轴成果：要求显式确认（确认后允许直接覆盖）；
        // 裸 patch final 以累计修订为产出，不经此闸
        if (!barePatchFinal && args.patch && (appliedPatchOps > 0 || routeVerdicts.length > 0) && result.overwritePatches !== true) {
          const covered = [
            ...(appliedPatchOps > 0 ? [`${appliedPatchOps} patch ops`] : []),
            ...(routeVerdicts.length > 0 ? [`${routeVerdicts.length} route-switch units`] : []),
          ].join(" and ")
          return { ok: false, issues: [
            `this draft is a full draft/final: adopting it overwrites the previously merged ${covered} (revisions not folded into this draft are lost).`
            + ` To confirm the overwrite, resubmit with "overwritePatches": true at the top level of result; otherwise continue revising the current merged plan with patch / switch_route commands`,
          ] }
        }
        if (workingPortfolio !== null) {
          // ── portfolio 模式：全量稿 = general 层修订（revisedPlan 单树表达不了分层；singles 走 patch）──
          const base = workingPortfolio.general
          const ctx = validCtxOf(base)
          const prepared = prepareRevised(result, base, args, ctx)
          if (!prepared) {
            return { ok: false, issues: ["missing revisedPlan (in portfolio mode submit layered revisions via patch, or let the final carry a full general draft)"] }
          }
          const warnings = ruleRefWarnings(result, base, args.patch, portfolio ?? undefined)
          const lint = lintPlan(prepared.revised, lintCtx)
          const validation = validateGamePlan(prepared.revised, ctx)
          if (!validation.ok) {
            const issues = validation.issues.map((i) => `${i.path}: ${i.message}`)
            if (prepared.dropped.length > 0) {
              issues.unshift(`(auto-repair removed ${prepared.dropped.length} dead rule/entry items: ${prepared.dropped.join("; ")})`)
            }
            issues.push(...warnings)
            return { ok: false, issues, lintFindings: lint }
          }
          // 全量稿被采纳：general 层替换，singles 保持（后续 patch 继续基于该稿）
          const nextPortfolio: WorkingPortfolio = { general: prepared.revised, singles: workingPortfolio.singles }
          workingPortfolio = nextPortfolio
          appliedPatchOps = 0 // patch 成果已被全量稿接管/覆盖：计数归零（与产出口径一致，后续全量稿不再需确认）
          patchVerdicts = (result.ruleVerdicts ?? []).map((v) => ({
            ruleRef: String(v?.ruleRef ?? "?"),
            verdict: (v?.verdict === "remove" ? "remove" : v?.verdict === "revise" ? "revise" : "keep") as PatchVerdict["verdict"],
            justification: String(v?.justification ?? ""),
            falsifiableClaim: v?.falsifiableClaim ?? undefined,
            source: "draft" as const,
          }))
          if (result.predictionPostmortem) postmortem = result.predictionPostmortem
          if (result.revisedPredictions) predictionsOverride = result.revisedPredictions
          const lintNote = lint.length > 0 ? `; static lint ${lint.length} findings: ${lint.slice(0, 4).map((f) => `${f.path} ${f.message}`).join("; ")}` : ""
          const statsNote = `general rules=${prepared.revised.rules?.length ?? 0}, phases=${prepared.revised.phases?.length ?? 0}, fallback=${prepared.revised.fallback?.policy}, planId=${prepared.revised.planId}; singles=${workingPortfolio.singles.map((s) => `${s.label}:${s.plan.planId}`).join(",") || "(empty)"}, verdicts=${result.ruleVerdicts?.length ?? 0}`
            + (prepared.dropped.length > 0 ? `; auto-repair removed ${prepared.dropped.length} dead rules/entries: ${prepared.dropped.join("; ")}` : "")
            + (warnings.length > 0 ? `; advisory warnings: ${warnings.join("; ")}` : "")
            + (validation.warnings.length > 0 ? `; validation warnings: ${validation.warnings.map((w) => `${w.path} ${w.message}`).join("; ")}` : "")
            + lintNote
          return { ok: true, issues: [], result: { result, revised: prepared.revised, warnings, workingPortfolio: nextPortfolio }, statsNote, lintFindings: lint }
        }
        const prepared = prepareRevised(result, plan, args, validCtx)
        if (!prepared) {
          return { ok: false, issues: ["missing revisedPlan"] }
        }
        const warnings = ruleRefWarnings(result, plan, args.patch)
        const lint = lintPlan(prepared.revised, lintCtx)
        const validation = validateGamePlan(prepared.revised, validCtx)
        if (!validation.ok) {
          const issues = validation.issues.map((i) => `${i.path}: ${i.message}`)
          if (prepared.dropped.length > 0) {
            issues.unshift(`(auto-repair removed ${prepared.dropped.length} dead rule/entry items: ${prepared.dropped.join("; ")})`)
          }
          issues.push(...warnings)
          return { ok: false, issues, lintFindings: lint }
        }
        // 全量稿被采纳：接管修订状态（后续 patch 基于该稿继续）
        workingPlan = prepared.revised
        appliedPatchOps = 0 // patch 成果已被全量稿接管/覆盖：计数归零（与产出口径一致，后续全量稿不再需确认）
        // 换轴成果同样被全量稿覆盖：verdict 与 run 级已嫁接集合归零（审计记录 routeSwitchRecords 保留）
        routeVerdicts = []
        graftedThisRun.clear()
        patchVerdicts = (result.ruleVerdicts ?? []).map((v) => ({
          ruleRef: String(v?.ruleRef ?? "?"),
          verdict: (v?.verdict === "remove" ? "remove" : v?.verdict === "revise" ? "revise" : "keep") as PatchVerdict["verdict"],
          justification: String(v?.justification ?? ""),
          falsifiableClaim: v?.falsifiableClaim ?? undefined,
          source: "draft" as const,
        }))
        if (result.predictionPostmortem) postmortem = result.predictionPostmortem
        if (result.revisedPredictions) predictionsOverride = result.revisedPredictions
        const lintNote = lint.length > 0 ? `; static lint ${lint.length} findings: ${lint.slice(0, 4).map((f) => `${f.path} ${f.message}`).join("; ")}` : ""
        const statsNote = `revisedPlan rules=${prepared.revised.rules?.length ?? 0}, phases=${prepared.revised.phases?.length ?? 0}, fallback=${prepared.revised.fallback?.policy}, verdicts=${result.ruleVerdicts?.length ?? 0}`
          + (prepared.dropped.length > 0 ? `; auto-repair removed ${prepared.dropped.length} dead rules/entries: ${prepared.dropped.join("; ")}` : "")
          + (warnings.length > 0 ? `; advisory warnings: ${warnings.join("; ")}` : "")
          + (validation.warnings.length > 0 ? `; validation warnings: ${validation.warnings.map((w) => `${w.path} ${w.message}`).join("; ")}` : "")
          + lintNote
        return { ok: true, issues: [], result: { result, revised: prepared.revised, warnings }, statsNote, lintFindings: lint }
      },
      finalGate: args.patch
        ? async (candidate) => {
            if (workingPortfolio !== null) {
              // portfolio 模式零修订判断：workingPortfolio 重算 portfolioId vs 初始
              const current = candidate.workingPortfolio ?? workingPortfolio
              const currentId = computePortfolioId({
                generalId: current.general.planId,
                singles: current.singles.map((s) => ({ label: s.label, opponentDeckCode: s.opponentDeckCode, planId: s.plan.planId })),
              })
              if (currentId === initialPortfolioId) {
                return {
                  passed: false,
                  report: `the merged portfolio is identical to the original manifest (portfolioId=${initialPortfolioId}) — this round produced no revision. If this keep-all is intentional, final again to force it through.`,
                }
              }
              const corpora = await ensureGroupCorpora()
              const gd = await ensureGameData()
              const groupInputs: PortfolioReplayGroupInput[] = groups.map((g) => ({
                label: g.label,
                singleLabel: singleLabelByGroup.get(g.label),
                corpus: corpora.get(g.label)!,
              }))
              const baseReplay = replayPortfolio(initialPortfolio!, groupInputs, gd)
              const nextReplay = replayPortfolio(current, groupInputs, gd)
              const report = [
                lastPatchNote ?? "(full draft; no patch-level verification)",
                formatPortfolioPatchVerification({ opsCount: appliedPatchOps, assertions: [], base: baseReplay, next: nextReplay }),
              ].join("\n")
              return { passed: true, report }
            }
            const noRevision = candidate.revised.planId === plan.planId
            if (noRevision) {
              return {
                passed: false,
                report: `the merged plan is identical to the base plan (planId=${plan.planId}) — this round produced no revision. If this keep-all is intentional, final again to force it through.`,
              }
            }
            const corpus = await ensureCorpus()
            const gd = await ensureGameData()
            const baseReplay = await ensureBaseReplay(corpus, gd)
            const nextReplay = replayPlan(candidate.revised, corpus, gd)
            const report = [
              lastPatchNote ?? "(full draft; no patch-level verification)",
              `Final verification: fallback rate ${(baseReplay.fallbackRate * 100).toFixed(1)}% → ${(nextReplay.fallbackRate * 100).toFixed(1)}% (static replay).`,
            ].join("\n")
            return { passed: true, report }
          }
        : undefined,
    })

    // patch 模式轮次耗尽（或有 patch/换轴后被 turn_cap 回退到旧 draft）：以当前合并结果兜底产出
    let finalResult = outcome.result
    if (args.patch && outcome.status !== "final" && (appliedPatchOps > 0 || patchVerdicts.length > 0 || routeVerdicts.length > 0)) {
      const synthesized: ReflectResult = {
        basePlanId: plan.planId,
        predictionPostmortem: postmortem ?? "(turn cap reached; no postmortem provided)",
        ruleVerdicts: [...patchVerdicts, ...routeVerdicts],
        revisedPlan: workingPortfolio !== null ? workingPortfolio.general : workingPlan,
        revisedPredictions: predictionsOverride,
      }
      if (workingPortfolio !== null) {
        // portfolio 模式：以分层闭包整体兜底（分层树已逐层 finalize，无需再 prepareRevised）
        finalResult = { result: synthesized, revised: workingPortfolio.general, warnings: [], workingPortfolio }
        outcome.stats.error = undefined
        outcome.stats.terminatedBy = "turn_cap_draft"
        outcome.stats.adoptedDraftTurn = outcome.stats.turns
      } else {
        const prepared = prepareRevised(synthesized, plan, args, validCtx)
        const validation = prepared ? validateGamePlan(prepared.revised, validCtx) : { ok: false, issues: [] }
        if (prepared && validation.ok) {
          finalResult = { result: synthesized, revised: prepared.revised, warnings: [] }
          outcome.stats.error = undefined
          outcome.stats.terminatedBy = "turn_cap_draft"
          outcome.stats.adoptedDraftTurn = outcome.stats.turns
        }
      }
    }

    // ── 产物写出：portfolio 模式 --out 为目录（plans/*.json + portfolio.json + sidecar 落根部）；legacy 单文件 ──
    if (portfolio !== null) {
      // portfolio 模式：sidecar（reflect.harness.json / reflect.transcript.jsonl）恒落 out 目录根部
      await mkdir(args.out, { recursive: true })
      await writeFile(join(args.out, "reflect.harness.json"), `${JSON.stringify(outcome.stats, null, 2)}\n`, "utf-8")
      await writeFile(join(args.out, "reflect.transcript.jsonl"), `${outcome.turns.map((t) => JSON.stringify(t)).join("\n")}\n`, "utf-8")
      // P0-3：replay-report 每代一份，文件名带产物 tag（r<N>）——失败路径同样落盘（累计的 patch 核验可审计）
      if (replayReport) {
        await writeReplayReport(join(args.out, `reflect.replay-report.${portfolioTag}.json`), replayReport)
      }
      if (!finalResult?.workingPortfolio) {
        console.error(`reflect failed (agentic): ${outcome.stats.error ?? outcome.status}`)
        process.exitCode = 1
        return
      }
      const tag = portfolioTag!
      const { planFiles } = await writePortfolioOutputs({ outDir: args.out, tag, working: finalResult.workingPortfolio })
      await writeFile(join(args.out, "reflect.reflection.json"), `${JSON.stringify(finalResult.result, null, 2)}\n`, "utf-8")
      const s = outcome.stats
      console.log(`OK: portfolio → ${args.out}（agentic${args.patch ? "+patch" : ""}，terminatedBy=${outcome.status}，turns=${s.turns}，modules=${s.moduleRequests.total}，drafts=${s.drafts}，patches=${s.patches}，salvaged=${s.salvaged}）`)
      console.log(`portfolioId=${portfolio.portfolioId} → ${planFiles.join(", ")}；general planId=${finalResult.workingPortfolio.general.planId}；singles=${finalResult.workingPortfolio.singles.map((x) => `${x.label}:${x.plan.planId}`).join(",") || "（空）"}`)
      return
    }
    await mkdir(dirname(args.out), { recursive: true })
    await writeFile(`${args.out}.harness.json`, `${JSON.stringify(outcome.stats, null, 2)}\n`, "utf-8")
    await writeFile(`${args.out}.transcript.jsonl`, `${outcome.turns.map((t) => JSON.stringify(t)).join("\n")}\n`, "utf-8")
    // P0-3：legacy 单树的 replay-report（失败路径同样落盘，累计 patch 核验可审计）
    if (replayReport) {
      await writeReplayReport(`${args.out}.replay-report.json`, replayReport)
    }
    if (!finalResult) {
      console.error(`reflect failed (agentic): ${outcome.stats.error ?? outcome.status}`)
      process.exitCode = 1
      return
    }
    const { result, revised } = finalResult
    await writeFile(args.out, `${JSON.stringify(revised, null, 2)}\n`, "utf-8")
    // 换轴审计记录随反思 sidecar 落盘（run 目录为只读证据，不就地改写 alternates 旁档）
    const reflectionOut = routeSwitchRecords.length > 0 ? { ...result, routeSwitches: routeSwitchRecords } : result
    await writeFile(`${args.out}.reflection.json`, `${JSON.stringify(reflectionOut, null, 2)}\n`, "utf-8")
    const s = outcome.stats
    console.log(`OK: revised plan → ${args.out}（agentic${args.patch ? "+patch" : ""}，terminatedBy=${outcome.status}，turns=${s.turns}，modules=${s.moduleRequests.total}，drafts=${s.drafts}，patches=${s.patches}，routeSwitches=${s.routeSwitches}，salvaged=${s.salvaged}）`)
    console.log(`planId=${revised.planId} (parent=${plan.planId}) rules=${revised.rules?.length ?? 0} verdicts=${result.ruleVerdicts?.length ?? 0}${routeSwitchRecords.length > 0 ? `（含换轴合成 ${routeSwitchRecords.length} 条）` : ""}`)
    return
  }

  // 一次 LLM 反思 + 至多一次携校验错误的修复重试（与 author 同策略）
  // prompt 落盘：泄漏审计可机检（S-M1 验收：engine-only 全程无 oracle 字样进入 prompt）
  const oneShotSystem = oneShotSystemPrompt(args.evidence)
  const oneShotPromptOut = portfolio !== null ? join(args.out, "reflect.prompt.txt") : `${args.out}.prompt.txt`
  await mkdir(portfolio !== null ? args.out : dirname(args.out), { recursive: true })
  await writeFile(oneShotPromptOut, `# SYSTEM\n\n${oneShotSystem}\n\n# USER（首轮）\n\n${user}\n`, "utf-8")
  let result: ReflectResult | null = null
  let revised: GamePlanV1 | null = null
  let lastIssues: string[] = []
  for (let attempt = 0; attempt <= 1; attempt++) {
    const attemptUser = attempt === 0
      ? user
      : `${user}\n\n# The previous revised plan failed validation; fix the issues below and output the full ReflectPlanResultV1 JSON again:\n${lastIssues.map((s) => `- ${s}`).join("\n")}`
    const resp = await chatCompletion({
      system: oneShotSystem,
      user: attemptUser,
      thinking: args.thinking,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      stream: args.stream,
      // 修复重试必须打破采样确定性：同 seed + 同 prompt 会复现同一份坏输出
      seed: args.seed !== undefined ? args.seed + attempt : undefined,
      model: args.model,
    })
    try {
      result = extractJson(resp.content || (resp.reasoningContent ?? "")) as ReflectResult
    } catch {
      lastIssues = ["output is not valid JSON"]
      const raw = resp.content || (resp.reasoningContent ?? "")
      console.log(`attempt ${attempt}: 输出无法解析为 JSON（content ${resp.content.length} 字符 / reasoning ${(resp.reasoningContent ?? "").length} 字符）`)
      console.log(`  tail: …${raw.slice(-300).replace(/\s+/g, " ")}`)
      continue
    }
    const prepared = prepareRevised(result, plan, args, validCtx)
    if (!prepared) {
      lastIssues = ["missing revisedPlan"]
      console.log(`attempt ${attempt}: 输出缺少 revisedPlan`)
      continue
    }
    if (prepared.dropped.length > 0) {
      console.log(`auto-repair: 移除 ${prepared.dropped.length} 个死规则/条目`)
      for (const d of prepared.dropped) console.log(`  - ${d}`)
    }

    const validation = validateGamePlan(prepared.revised, validCtx)
    if (validation.ok) {
      revised = prepared.revised
      break
    }
    lastIssues = validation.issues.map((i) => `${i.path}: ${i.message}`)
    console.log(`attempt ${attempt}: 修订计划 ${validation.issues.length} 个校验问题`)
    for (const issue of validation.issues.slice(0, 10)) {
      console.log(`  ${issue.path}: ${issue.message}`)
    }
  }
  if (!revised || !result) {
    console.error("reflect failed: 校验未通过且修复次数用尽")
    process.exitCode = 1
    return
  }

  if (portfolio !== null) {
    // one-shot portfolio 模式：LLM 的 revisedPlan = 新 general 层，singles 保留原样；产物目录式
    const working: WorkingPortfolio = {
      general: revised,
      singles: portfolio.singles.map((s) => ({ label: s.label, opponentDeckCode: s.opponentDeckCode, plan: s.plan })),
    }
    const tag = portfolioTag!
    await mkdir(args.out, { recursive: true })
    const { planFiles } = await writePortfolioOutputs({ outDir: args.out, tag, working })
    await writeFile(join(args.out, "reflect.reflection.json"), `${JSON.stringify(result, null, 2)}\n`, "utf-8")
    console.log(`OK: portfolio → ${args.out}（one-shot，general planId=${revised.planId} parent=${plan.planId}；plans: ${planFiles.join(", ")}）`)
    console.log(`portfolioId=${portfolio.portfolioId} → singles=${working.singles.map((s) => `${s.label}:${s.plan.planId}`).join(",") || "（空）"}`)
    return
  }
  await mkdir(dirname(args.out), { recursive: true })
  await writeFile(args.out, `${JSON.stringify(revised, null, 2)}\n`, "utf-8")
  await writeFile(`${args.out}.reflection.json`, `${JSON.stringify(result, null, 2)}\n`, "utf-8")
  console.log(`OK: revised plan → ${args.out}`)
  console.log(`planId=${revised.planId} (parent=${plan.planId}) rules=${revised.rules?.length ?? 0} verdicts=${result.ruleVerdicts?.length ?? 0}`)
}

await main()
