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
 * harness 模块注册表（设计文档 2026-08-28-agentic-plan-harness §模块注册表）。
 *
 * author / reflect 共用的"按需复看"通道：LLM 经 request_modules 命令按 kind+id
 * 索取补充资料，本模块把请求解析为内容块。封闭集合——未知 kind/id 返回错误
 * 文案块（不抛异常，让模型看到并修正请求）。
 *
 * 共享模块：fewshot_plan / field_reference / card_detail / character_detail /
 *          character_profile / dice_prior
 * reflect 专属：decision_detail / rule_drilldown / fallback_detail / fallback_report /
 *          game_summary / plan_simulate（规则链静态回放矩阵，patch 修订模式的扰动预演）
 *          （fallback_report = 覆盖率护栏：fallback 决策点的聚类聚合报告，harness 反思默认注入）
 */

import { readFile, readdir } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { GameData } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { AssetsManager } from "@gi-tcg/assets-manager"
import { getCharacterSkillProfile } from "../../../knowledge/character-skill-profiles.js"
import { formatDicePriorMarkdown } from "../dice-prior.js"
import { compactStateDigest, formatChosen, formatOracleBest } from "./evidence-extract.js"
import type { EvidenceMode } from "./evidence-extract.js"
import type { PlanTraceFile, PlanTraceEntry } from "../trace.js"
import { backfillTraceSignatures } from "../sig-backfill.js"
import { formatRuleKey, parseRuleKey } from "../rule-key.js"
import type { ServedModule, ModuleRequest } from "./agent-loop.js"
import type { GamePlanV1 } from "../game-plan-v1.js"
import type { ResolvedPortfolio } from "../portfolio.js"
import {
  loadReplayCorpus,
  replayPlan,
  replayPortfolio,
  formatMatrixSummary,
  type ReplayCorpus,
  type PortfolioReplayResult,
} from "../plan-replay.js"

/** 单个模块内容硬上限（防上下文爆炸） */
export const MAX_MODULE_CHARS = 4000

/** 交叉对手证据合并（2026-08-30 无 oracle 自进化臂 §3）：一个对手组 = 一个 run 目录 */
export interface RunDirGroup {
  /** 组名（run 目录 basename），多组时 decision_detail/game_summary 的 id 需带 "组名/" 前缀 */
  label: string
  dir: string
  /**
   * 本组路由到的 single label（Phase 3a 接口约定，值由 Phase 3b 的 reflect 装载侧
   * 填）：portfolio 模式下本组对局按该 single 路由（组合链）；缺省 = 未知/未路由
   * （general-only）。plan_simulate 分层矩阵与 fallback_report 的 D6 路由建议据此
   * 判定本组形态；trace 文件已带 routing 时以 trace 为准。
   */
  singleLabel?: string
}

export interface ModuleResolverContext {
  /** reflect 侧：批跑输出目录与本侧编号 */
  runDir?: string
  /** 多对手证据包：设置后覆盖 runDir（分组聚合 drilldown/fallback，detail/summary 按组名寻址） */
  runDirs?: RunDirGroup[]
  side?: 0 | 1
  evalSuffix?: string
  /** engine-only：eval 读取分支整体门控（drilldown/detail 只保留 trace 部分，默认 oracle） */
  evidence?: EvidenceMode
  /**
   * 两层组合（portfolio）上下文：设置后 plan_simulate 用 replayPortfolio 产出
   * 分层 × 分组矩阵（每组按路由回放，层化键）；无 portfolio 保持现状全池化。
   * 装载侧（Phase 3b）负责 loadPortfolioWithValidation 并注入。
   */
  portfolio?: ResolvedPortfolio
  /** 当前工作计划（patch 合并后的最新版；缺省 = 原计划）——plan_simulate 的求值对象 */
  currentPlan?: () => GamePlanV1 | null
  /** 原计划（diff 基准） */
  basePlan?: GamePlanV1
  /** 延迟加载语料（run 目录大时避免重复读盘）；缺省时 plan_simulate 按需自建 */
  loadCorpus?: () => Promise<ReplayCorpus>
  /** 静态求值用 GameData（hand.countWithTag 需要卡牌 tag；plan:reflect 注入） */
  gameData?: GameData
  /**
   * 版本化卡面数据（V1 版本钉扎）：card_detail / character_detail 按该版本取数；
   * 缺省 DEFAULT_ASSETS_MANAGER（latest，旧行为）。
   */
  assets?: AssetsManager
  /**
   * decision_detail 的 trace 条目原文里把整条 stateSignature 换成指针文案。
   * 仅 evidencePack 导出路径使用（签名在 stateSignatures.jsonl 有专属整条落盘，
   * digest 不重复携带 10KB 级 JSON）；reflect 路径不设，行为不变。
   */
  sigRedact?: boolean
}

const COST_LABELS: Record<string, string> = {
  GCG_COST_DICE_CRYO: "冰", GCG_COST_DICE_HYDRO: "水", GCG_COST_DICE_PYRO: "火",
  GCG_COST_DICE_ELECTRO: "雷", GCG_COST_DICE_ANEMO: "风", GCG_COST_DICE_GEO: "岩",
  GCG_COST_DICE_DENDRO: "草", GCG_COST_DICE_VOID: "无色", GCG_COST_DICE_OMNI: "万能",
  GCG_COST_DICE_SAME: "同色", GCG_COST_DICE_ALIGNED: "同色",
  GCG_COST_ENERGY: "充能", GCG_COST_LEGEND: "秘传",
  GCG_COST_SPECIAL_ENERGY: "特殊能量", GCG_COST_SKIRK_SPECIAL_ENERGY: "特殊能量",
}

const SKILL_TYPE_LABELS: Record<string, string> = {
  normal_attack: "普通攻击",
  elemental_skill: "元素战技",
  burst: "元素爆发",
}

/**
 * 资产标签枚举 → core 实体短名（`hand.countWithTag.<tag>` 的运行时比较值，
 * 见 fields.ts）。权威来源是 GameData 实体 tags（@gi-tcg/data builder 的
 * `.tags("weapon")` 短名）；本表只在调用方未注入 gameData 时兜底。
 * 无 core 对应的资产标签（GCG_TAG_SLOWLY / GCG_TAG_NON_DISCOVERABLE /
 * GCG_TAG_QUICKLY 等）不映射——渲染出来会诱导 LLM 写出运行时恒假的条件。
 */
const CORE_TAGS_BY_ASSET_TAG: Record<string, readonly string[]> = {
  GCG_TAG_TALENT: ["talent"],
  GCG_TAG_ARTIFACT: ["artifact"],
  GCG_TAG_WEAPON: ["weapon"],
  GCG_TAG_WEAPON_SWORD: ["sword"],
  GCG_TAG_WEAPON_CLAYMORE: ["claymore"],
  GCG_TAG_WEAPON_POLE: ["pole"],
  GCG_TAG_WEAPON_BOW: ["bow"],
  GCG_TAG_WEAPON_CATALYST: ["catalyst"],
  GCG_TAG_FOOD: ["food"],
  GCG_TAG_RESONANCE: ["resonance"],
  GCG_TAG_LEGEND: ["legend"],
  GCG_TAG_ALLY: ["ally"],
  GCG_TAG_PLACE: ["place"],
  GCG_TAG_ITEM: ["item"],
  GCG_TAG_CARD_BLESSING: ["blessing"],
  GCG_TAG_ADVENTURE_PLACE: ["adventureSpot", "place"],
}

/**
 * 卡牌 core 实体短名 tag：GameData 实体 tags 优先（与 fields.ts 的运行时
 * 比较同源），资产枚举经 CORE_TAGS_BY_ASSET_TAG 兜底；查不到的标签丢弃。
 */
export function coreTagsOf(defId: number, assetTags: readonly string[], gameData?: GameData): string[] {
  const fromData = gameData?.entities.get(defId)?.tags
  if (fromData !== undefined) {
    return [...new Set(fromData.map((t) => String(t).toLowerCase()))]
  }
  const out: string[] = []
  for (const t of assetTags) {
    for (const core of CORE_TAGS_BY_ASSET_TAG[t] ?? []) {
      if (!out.includes(core)) out.push(core)
    }
  }
  return out
}

export function formatCost(costs: ReadonlyArray<{ type: string; count: number }>): string {
  if (costs.length === 0) return "0费"
  return costs.map((c) => `${c.count}${COST_LABELS[c.type] ?? c.type}`).join("+")
}

/** 多行效果文本压成单行，保持每个条目一行 */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, "；").trim()
}

function promptFile(rel: string): string {
  return fileURLToPath(new URL(`../prompts/${rel}`, import.meta.url))
}

function truncate(content: string, maxChars: number = MAX_MODULE_CHARS): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n…（截断，原文共 ${content.length} 字符）`
}

function notFound(kind: string, id: string | number | undefined, detail: string): ServedModule {
  return { key: `${kind}:${id ?? ""}`, content: `（${kind} ${id ?? ""} 未找到：${detail}）` }
}

// ── 共享模块 ─────────────────────────────────────────────────────────

function serveFewshotPlan(): ServedModule {
  const raw = readFileSync(promptFile("examples/fewshot-plan.json"), "utf-8")
  const plan = JSON.parse(raw) as { planId?: string; author?: string }
  const header = `一份形态健康的完整 GamePlanV1 实战示例（来源 planId=${plan.planId ?? "?"}，author=${plan.author ?? "?"}）。`
    + `注意：这是**别的卡组**的计划，只学习它的形态（阶段划分、骰子条件写法、reason 的数值依据、优先级排布），严禁照抄其中的角色/卡牌 defId——那些 id 不在你的牌表里。`
  return { key: "fewshot_plan", content: `${header}\n\n\`\`\`json\n${raw.trim()}\n\`\`\`` }
}

function serveFieldReference(): ServedModule {
  return { key: "field_reference", content: readFileSync(promptFile("field-reference.md"), "utf-8") }
}

function serveDicePrior(): ServedModule {
  return { key: "dice_prior", content: formatDicePriorMarkdown() }
}

async function ensureCardData(assets: AssetsManager): Promise<void> {
  // 与 createDeckContext 同源：同步数据需经 prepareForSync 预热（60s 超时由调用环境兜底）
  await assets.prepareForSync()
}

async function serveCardDetail(ctx: ModuleResolverContext, id: number): Promise<ServedModule> {
  const assets = ctx.assets ?? DEFAULT_ASSETS_MANAGER
  await ensureCardData(assets)
  const data = assets.getDataSync(id) as unknown as Record<string, unknown>
  if (Array.isArray(data.skills)) {
    return notFound("card_detail", id, "该 id 是角色而不是行动牌，请改用 character_detail")
  }
  const name = String(data.name ?? id)
  const costs = Array.isArray(data.playCost) ? (data.playCost as Array<{ type: string; count: number }>) : []
  const assetTags = Array.isArray(data.tags) ? (data.tags as string[]) : []
  const tags = coreTagsOf(id, assetTags, ctx.gameData).join("/")
  const lines = [
    `${id} ${name}｜费用 ${formatCost(costs)}｜tags: ${tags || "无"}`,
    `效果：${oneLine(String(data.description ?? ""))}`,
  ]
  if (typeof data.playingDescription === "string" && data.playingDescription) {
    lines.push(`打出时：${oneLine(data.playingDescription)}`)
  }
  return { key: `card_detail:${id}`, content: lines.join("\n") }
}

async function serveCharacterDetail(ctx: ModuleResolverContext, id: number): Promise<ServedModule> {
  const assets = ctx.assets ?? DEFAULT_ASSETS_MANAGER
  await ensureCardData(assets)
  const data = assets.getDataSync(id) as unknown as Record<string, unknown>
  if (!Array.isArray(data.skills)) {
    return notFound("character_detail", id, "该 id 不是角色（角色 defId 通常为 4 位，行动牌为 6 位）")
  }
  const name = String(data.name ?? id)
  const lines = [`${id} ${name}｜HP${data.hp ?? "?"}｜能量上限${data.maxEnergy ?? "?"}`]
  for (const s of data.skills as Array<Record<string, unknown>>) {
    if (s.hidden === true) continue
    const costs = Array.isArray(s.playCost) ? (s.playCost as Array<{ type: string; count: number }>) : []
    const type = SKILL_TYPE_LABELS[String(s.type)] ?? String(s.type ?? "?")
    lines.push(`  - ${type}「${String(s.name ?? "?")}」费用 ${formatCost(costs)}：${oneLine(String(s.description ?? s.rawDescription ?? ""))}`)
  }
  return { key: `character_detail:${id}`, content: lines.join("\n") }
}

function serveCharacterProfile(id: number): ServedModule {
  const p = getCharacterSkillProfile(id)
  if (!p) return notFound("character_profile", id, "无该角色的聚合画像")
  const name = DEFAULT_ASSETS_MANAGER.getNameSync(id) ?? String(id)
  const lines = [
    `${id} ${name} 的战技画像（从卡牌定义源码静态分析）：`,
    `- 战技产出召唤物（持续收益，宜早出）：${p.hasSummon ? "是" : "否"}`,
    `- 战技附带自身状态（增益，可当回合用）：${p.hasSelfStatus ? "是" : "否"}`,
    `- 战技附带团队战斗状态：${p.hasCombatStatus ? "是" : "否"}`,
    `- 开局出战优先级 openingPriority=${p.openingPriority}（0–4，越高越适合首发）`,
  ]
  return { key: `character_profile:${id}`, content: lines.join("\n") }
}

// ── reflect 专属模块 ─────────────────────────────────────────────────

interface EvalPointLite {
  seq: number
  visitGap?: number | null
  isBlunder?: boolean
  isDivergence?: boolean
  alignmentMiss?: boolean
  oracleBest?: string
  matchedRule?: string | null
  valueBefore?: number
  valueAfter?: number
  valueDelta?: number | null
}

function reflectFileNames(ctx: ModuleResolverContext): { traceName: string; evalName: string } {
  const side = ctx.side ?? 0
  const suffix = ctx.evalSuffix ? `.${ctx.evalSuffix}` : ""
  return {
    traceName: side === 0 ? "plan_trace.json" : "plan_trace.side1.json",
    evalName: side === 0 ? `plan_eval${suffix}.json` : `plan_eval${suffix}.side1.json`,
  }
}

async function gameDirs(runDir: string): Promise<string[]> {
  return (await readdir(runDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    .map((e) => e.name)
    .sort()
}

/** 证据目录分组：runDirs 优先，单目录退化为匿名组（label=""，行格式与旧版一致） */
function dirGroupsOf(ctx: ModuleResolverContext): RunDirGroup[] {
  if (ctx.runDirs && ctx.runDirs.length > 0) return ctx.runDirs
  return ctx.runDir ? [{ label: "", dir: ctx.runDir }] : []
}

/** 多组模式下 decision_detail/game_summary 的 id 寻址："组名/game-003[:42]"；单组兼容裸 id */
function parseGroupQualifiedId(
  ctx: ModuleResolverContext,
  id: string,
): { group: RunDirGroup; rest: string } | { error: string } {
  const groups = dirGroupsOf(ctx)
  if (groups.length === 0) return { error: "无 run 目录（reflect 上下文缺失）" }
  if (groups.length === 1) return { group: groups[0], rest: id }
  const m = /^([^/\s]+)\/(.+)$/.exec(id)
  if (!m) {
    return { error: `多对手证据包模式下 id 需带组名前缀（如 ${groups[0].label}/${id}）；可用组名：${groups.map((g) => g.label).join(", ")}` }
  }
  const group = groups.find((g) => g.label === m[1])
  if (!group) return { error: `未知组名 "${m[1]}"；可用组名：${groups.map((g) => g.label).join(", ")}` }
  return { group, rest: m[2] }
}

/** 行内 game 名前缀（多组时 "组名/"，单组空串） */
function gameTagOf(groups: RunDirGroup[], group: RunDirGroup, game: string): string {
  return groups.length > 1 ? `${group.label}/${game}` : game
}

async function readGameFiles(ctx: ModuleResolverContext, groupDir: string, game: string): Promise<{
  trace: PlanTraceFile | null
  evalBySeq: Map<number, EvalPointLite> | null
}> {
  const { traceName, evalName } = reflectFileNames(ctx)
  const dir = join(groupDir, game)
  let trace: PlanTraceFile | null = null
  let evalBySeq: Map<number, EvalPointLite> | null = null
  try {
    trace = JSON.parse(await readFile(join(dir, traceName), "utf-8")) as PlanTraceFile
  } catch { /* 缺 trace 视为无数据 */ }
  // lean trace：从同局 state log 反查回填签名（full / 旧格式恒 no-op；
  // sig-backfill 内部按 game 目录缓存，重复模块请求不重读 state log）
  if (trace) await backfillTraceSignatures(dir, trace)
  // engine-only：eval 读取分支整体门控（泄漏通道 §1.3）
  if (ctx.evidence !== "engine-only") {
    try {
      const ev = JSON.parse(await readFile(join(dir, evalName), "utf-8")) as { points?: EvalPointLite[] }
      if (ev.points) evalBySeq = new Map(ev.points.map((p) => [p.seq, p]))
    } catch { /* 未跑 oracle 时无 eval */ }
  }
  return { trace, evalBySeq }
}

/** 规则键重建（拼键统一走 rule-key.ts）：phase:<phaseId>:<priority> / global:<priority> / opening:<priority>；组合模式条目带层前缀 */
function ruleKeyOf(e: PlanTraceEntry): string | null {
  if (!e.matchedRule) return null
  return formatRuleKey({
    scope: e.matchedRule.scope,
    priority: e.matchedRule.priority,
    phaseId: e.phaseId,
    layer: e.matchedRule.layer,
    layerLabel: e.matchedRule.layerLabel,
  })
}

function evalMarker(p: EvalPointLite | undefined): string {
  if (!p) return ""
  if (p.alignmentMiss) return " | oracle 对不齐"
  const gap = p.visitGap != null ? ` gap=${p.visitGap.toFixed(2)}` : ""
  const mark = p.isBlunder ? " ✗" : p.isDivergence ? " ~" : " ✓"
  return ` | oracle ${p.oracleBest ? formatOracleBest(p.oracleBest) : "?"}${gap}${mark}`
}

async function serveDecisionDetail(ctx: ModuleResolverContext, id: string): Promise<ServedModule> {
  const qualified = parseGroupQualifiedId(ctx, id)
  if ("error" in qualified) return notFound("decision_detail", id, qualified.error)
  const m = /^(game-[^:\s]+):(\d+)$/.exec(qualified.rest)
  if (!m) return notFound("decision_detail", id, "id 格式应为 game-N:seq（如 game-003:42）")
  const [, game, seqStr] = m
  const seq = Number(seqStr)
  const { trace, evalBySeq } = await readGameFiles(ctx, qualified.group.dir, game)
  if (!trace) return notFound("decision_detail", id, "该局无 trace 文件")
  const idx = trace.entries.findIndex((e) => e.seq === seq)
  if (idx < 0) return notFound("decision_detail", id, "无此 seq")
  const side = ctx.side ?? 0
  const entry = trace.entries[idx]
  // sigRedact（仅导出路径）：整条签名在 stateSignatures.jsonl 落盘，digest 行以指针代替
  const entryJson = ctx.sigRedact === true
    ? JSON.stringify({ ...entry, stateSignature: `<已省略，整条见 stateSignatures.jsonl seq=${entry.seq}>` })
    : JSON.stringify(entry)
  const lines: string[] = [
    `决策点 ${id}（round${entry.round}）：`,
    entry.stateSignature ? `局面：${compactStateDigest(entry.stateSignature, side)}` : "局面：（无 state 签名）",
    ``,
    `trace 条目原文：`,
    entryJson,
  ]
  const p = evalBySeq?.get(seq)
  if (p) lines.push(``, `oracle 回算原文：`, JSON.stringify(p))
  const neighbors = [trace.entries[idx - 1], trace.entries[idx + 1]].filter(Boolean) as PlanTraceEntry[]
  if (neighbors.length > 0) {
    lines.push(``, `相邻决策点：`)
    for (const nb of neighbors) {
      lines.push(`- [seq${nb.seq} ${nb.method}] ${ruleKeyOf(nb) ?? (nb.fallbackUsed ? "<fallback>" : "-")} → ${formatChosen(nb.chosen)}`)
    }
  }
  return { key: `decision_detail:${id}`, content: lines.join("\n") }
}

async function serveRuleDrilldown(ctx: ModuleResolverContext, ruleRef: string): Promise<ServedModule> {
  const side = ctx.side ?? 0
  const groups = dirGroupsOf(ctx)
  // 层标注（层化键自带层信息：general:… / single:<label>:…；旧单树无前缀）
  const parsed = parseRuleKey(ruleRef)
  const layerNote = parsed?.layer
    ? parsed.layer.kind === "general"
      ? "（General 层）"
      : `（Single 层：${parsed.layer.label}）`
    : parsed
      ? "（旧单树格式，无层）"
      : "（非法 ruleRef）"
  const hitLines: string[] = []
  const missLines: string[] = []
  const sections: string[] = []
  for (const group of groups) {
    const groupHits: string[] = []
    const groupMisses: string[] = []
    for (const g of await gameDirs(group.dir)) {
      const { trace, evalBySeq } = await readGameFiles(ctx, group.dir, g)
      if (!trace) continue
      for (const e of trace.entries) {
        if (e.method !== "action") continue
        const key = ruleKeyOf(e)
        const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
        const tag = gameTagOf(groups, group, g)
        if (key === ruleRef) {
          groupHits.push(`[${tag} seq${e.seq}] ${digest} | 选 ${formatChosen(e.chosen)}${evalMarker(evalBySeq?.get(e.seq) ?? undefined)}`)
        } else if ((e.thenMiss ?? []).includes(ruleRef)) {
          groupMisses.push(`[${tag} seq${e.seq}] ${digest} | thenMiss（when 全真但 then 零命中）`)
        }
      }
    }
    hitLines.push(...groupHits)
    missLines.push(...groupMisses)
    if (groups.length > 1 && (groupHits.length > 0 || groupMisses.length > 0)) {
      sections.push(`## 对手组 ${group.label}（命中 ${groupHits.length} / thenMiss ${groupMisses.length}）`, ...groupHits, ...(groupMisses.length > 0 ? [`thenMiss 记录：`, ...groupMisses] : []))
    }
  }
  if (hitLines.length === 0 && missLines.length === 0) {
    return notFound("rule_drilldown", ruleRef, `该规则在全部对局中既未命中也未出现在 thenMiss 中（ruleRef 形如 global:3 / phase:burst:20；两层模式带层前缀 general:global:3 / single:<label>:global:3）`)
  }
  const lines = [
    `规则 ${ruleRef} ${layerNote}全量钻取：命中 ${hitLines.length} 次，thenMiss ${missLines.length} 次`,
    ``,
  ]
  if (sections.length > 0) {
    lines.push(...sections)
  } else {
    lines.push(...hitLines)
    if (missLines.length > 0) lines.push(``, `thenMiss 记录：`, ...missLines)
  }
  return { key: `rule_drilldown:${ruleRef}`, content: lines.join("\n") }
}

/** fallback 决策点行格式（fallback_detail 全量列表与 fallback_report 代表行共用） */
function formatFallbackLine(
  ctx: ModuleResolverContext,
  groups: RunDirGroup[],
  group: RunDirGroup,
  game: string,
  e: PlanTraceEntry,
  side: 0 | 1,
  evalBySeq: Map<number, EvalPointLite> | null,
): string {
  const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
  const policy = e.fallbackPolicy ? `（${e.fallbackPolicy}）` : ""
  return `[${gameTagOf(groups, group, game)} seq${e.seq}] ${digest} | 兜底${policy} ${formatChosen(e.chosen)}${evalMarker(evalBySeq?.get(e.seq) ?? undefined)}`
}

async function serveFallbackDetail(ctx: ModuleResolverContext): Promise<ServedModule> {
  const side = ctx.side ?? 0
  const groups = dirGroupsOf(ctx)
  const lines: string[] = []
  const sections: string[] = []
  for (const group of groups) {
    const groupLines: string[] = []
    for (const g of await gameDirs(group.dir)) {
      const { trace, evalBySeq } = await readGameFiles(ctx, group.dir, g)
      if (!trace) continue
      for (const e of trace.entries) {
        if (e.method !== "action" || !e.fallbackUsed) continue
        groupLines.push(formatFallbackLine(ctx, groups, group, g, e, side, evalBySeq))
      }
    }
    lines.push(...groupLines)
    if (groups.length > 1) sections.push(`## 对手组 ${group.label}（${groupLines.length} 个）`, ...groupLines)
  }
  if (lines.length === 0) return { key: "fallback_detail", content: "（全部对局无 fallback 决策点——规则覆盖完整）" }
  const body = sections.length > 0 ? sections : lines
  return { key: "fallback_detail", content: [`全部 fallback 决策点（共 ${lines.length} 个）：`, ...body].join("\n") }
}

// ── fallback 覆盖率聚合报告（覆盖率护栏）──────────────────────────────
// fallback_detail 是全量平铺、one-shot 证据包只有 top-N，两者都回答不了
// "缺口集中在哪类局面"。本报告把 fallback 决策点按（我方出战角色 × 回合）
// 聚类，类内给手牌/骰面/威胁态分布与代表行，由 LLM 判断是否针对性修正。
// 默认注入反思环路（harness turns>1，oracle / engine-only 双臂同注入）。

/** stateSignature 中本报告需要的字段（解析失败一律缺省，不抛错） */
interface FallbackSigLite {
  myActiveDefId?: number
  hand?: number
  dice?: number
  omni?: number
}

function parseFallbackSig(sigJson: string | undefined, side: number): FallbackSigLite {
  if (!sigJson) return {}
  try {
    const s = JSON.parse(sigJson) as {
      player?: Array<{
        activeCharacterId?: number
        character?: Array<{ id?: number; definitionId?: number }>
        dice?: number[]
        handCard?: unknown[]
      }>
    }
    const me = s.player?.[side]
    const active = me?.character?.find((c) => c.id === me.activeCharacterId)
    return {
      myActiveDefId: active?.definitionId,
      hand: me?.handCard?.length,
      dice: me?.dice?.length,
      omni: me?.dice?.filter((d) => d === 8).length,
    }
  } catch {
    return {}
  }
}

/** 威胁读数分桶：fallback 发生时对手是否已构成斩杀/爆发信号（高威胁下的 fallback 优先补防御规则） */
function threatBucketOf(t: PlanTraceEntry["threat"]): string {
  if (!t) return "无读数"
  if (t.lethal) return "斩杀!"
  if (t.lethalP !== undefined && t.lethalP >= 0.5) return "lethalP≥0.5"
  if (t.burstReady || (t.burstP !== undefined && t.burstP >= 0.5)) return "爆发就绪"
  return "低"
}

interface FallbackCluster {
  key: string
  myActiveDefId?: number
  round: number
  count: number
  perGroup: Map<string, number>
  handMin?: number
  handMax?: number
  diceMin?: number
  diceMax?: number
  omniMax?: number
  threatBuckets: Map<string, number>
  representative: string
}

/** 聚合报告最多展示的聚类数（超出合并为一行省略说明，防 prompt 膨胀） */
const MAX_FALLBACK_REPORT_CLUSTERS = 12

async function serveFallbackReport(ctx: ModuleResolverContext): Promise<ServedModule> {
  const side = ctx.side ?? 0
  const groups = dirGroupsOf(ctx)
  const clusters = new Map<string, FallbackCluster>()
  const perGroupTotal = new Map<string, { action: number; fallback: number }>()
  let totalAction = 0
  for (const group of groups) {
    for (const g of await gameDirs(group.dir)) {
      const { trace, evalBySeq } = await readGameFiles(ctx, group.dir, g)
      if (!trace) continue
      for (const e of trace.entries) {
        if (e.method !== "action") continue
        totalAction++
        const gt = perGroupTotal.get(group.label) ?? { action: 0, fallback: 0 }
        gt.action++
        perGroupTotal.set(group.label, gt)
        if (!e.fallbackUsed) continue
        gt.fallback++
        const sig = parseFallbackSig(e.stateSignature, side)
        const key = `${sig.myActiveDefId ?? "?"}|r${e.round}`
        const c: FallbackCluster = clusters.get(key) ?? {
          key,
          myActiveDefId: sig.myActiveDefId,
          round: e.round,
          count: 0,
          perGroup: new Map(),
          threatBuckets: new Map(),
          representative: formatFallbackLine(ctx, groups, group, g, e, side, evalBySeq),
        }
        c.count++
        c.perGroup.set(group.label, (c.perGroup.get(group.label) ?? 0) + 1)
        if (sig.hand !== undefined) {
          c.handMin = Math.min(c.handMin ?? sig.hand, sig.hand)
          c.handMax = Math.max(c.handMax ?? sig.hand, sig.hand)
        }
        if (sig.dice !== undefined) {
          c.diceMin = Math.min(c.diceMin ?? sig.dice, sig.dice)
          c.diceMax = Math.max(c.diceMax ?? sig.dice, sig.dice)
        }
        if (sig.omni !== undefined) c.omniMax = Math.max(c.omniMax ?? sig.omni, sig.omni)
        const tb = threatBucketOf(e.threat)
        c.threatBuckets.set(tb, (c.threatBuckets.get(tb) ?? 0) + 1)
        clusters.set(key, c)
      }
    }
  }
  const totalFallback = [...clusters.values()].reduce((s, c) => s + c.count, 0)
  if (totalFallback === 0) {
    return { key: "fallback_report", content: "（全部对局无 fallback 决策点——规则覆盖完整，覆盖率护栏无需动作）" }
  }
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "0%")
  const sorted = [...clusters.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  const shown = sorted.slice(0, MAX_FALLBACK_REPORT_CLUSTERS)
  const omitted = sorted.slice(MAX_FALLBACK_REPORT_CLUSTERS)

  const header: string[] = [
    `全部 action 决策点 ${totalAction} 个，其中 fallback（无规则命中走兜底）${totalFallback} 个（${pct(totalFallback, totalAction)}），聚为 ${sorted.length} 类（我方出战角色 × 回合）。`,
  ]
  if (groups.length > 1) {
    header.push(`分对手组：${groups.map((g) => {
      const t = perGroupTotal.get(g.label) ?? { action: 0, fallback: 0 }
      return `${g.label} ${t.fallback}/${t.action}（${pct(t.fallback, t.action)}）`
    }).join("；")}`)
  }
  header.push(`判定提示：占比显著（≥5 次或 ≥20%）的聚类 = 规则覆盖缺口集中区，优先考虑为该局面簇新增规则或放宽既有规则的 when；零散单发聚类（1-2 次）多为长尾，可暂不处理。威胁列标出 fallback 发生时对手已构成斩杀/爆发信号的次数——高威胁下的 fallback 优先补防御规则。需要原文级逐条列表再索取 fallback_detail。`)

  const range = (min: number | undefined, max: number | undefined) =>
    min === undefined ? "?" : min === max ? `${min}` : `${min}-${max}`
  // D6 路由建议（Phase 3a）：perGroup 覆盖 ≥2 组 → General（跨组共性）；恰 1 组且该组
  // 路由到 single → Single(<label>)；1 组无 singleLabel → General（仅本组，注意过拟合）
  const d6Suggestion = (c: FallbackCluster): string => {
    const labels = [...c.perGroup.keys()]
    if (labels.length >= 2) return "建议修 General（跨组共性）"
    const only = labels[0]
    const singleLabel = groups.find((g) => g.label === only)?.singleLabel
    if (singleLabel) return `建议修 Single(${singleLabel})`
    return "建议修 General（仅本组出现，注意过拟合）"
  }
  const body = shown.map((c) => {
    const who = c.myActiveDefId !== undefined
      ? `${DEFAULT_ASSETS_MANAGER.getNameSync(c.myActiveDefId) ?? c.myActiveDefId}(${c.myActiveDefId})`
      : "?"
    const threat = [...c.threatBuckets.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ")
    const groupPart = groups.length > 1
      ? `｜分组: ${[...c.perGroup.entries()].map(([k, n]) => `${k}×${n}`).join(" / ")}`
      : ""
    return [
      `- [${c.count} 次 / ${pct(c.count, totalFallback)}] 出战 ${who} × round${c.round}｜手牌 ${range(c.handMin, c.handMax)}｜骰 ${range(c.diceMin, c.diceMax)}（万能 ≤${c.omniMax ?? "?"}）｜威胁: ${threat}${groupPart}｜D6 路由: ${d6Suggestion(c)}`,
      `  代表：${c.representative}`,
    ].join("\n")
  })
  if (omitted.length > 0) {
    body.push(`- …另 ${omitted.length} 个小聚类（共 ${omitted.reduce((s, c) => s + c.count, 0)} 次）因行数上限省略`)
  }
  return { key: "fallback_report", content: [...header, "", ...body].join("\n") }
}

async function serveGameSummary(ctx: ModuleResolverContext, game: string): Promise<ServedModule> {
  const qualified = parseGroupQualifiedId(ctx, game)
  if ("error" in qualified) return notFound("game_summary", game, qualified.error)
  const { trace, evalBySeq } = await readGameFiles(ctx, qualified.group.dir, qualified.rest)
  if (!trace) return notFound("game_summary", game, "该局无 trace 文件")
  const side = ctx.side ?? 0
  const s = trace.summary
  const lines = [
    `${game}：结果 ${s.result}，回合数 ${s.rounds}，决策点 ${s.decisionCounts.total}（规则命中 ${s.decisionCounts.ruleMatched}，fallback ${s.decisionCounts.fallback}），coverage=${(s.coverage * 100).toFixed(1)}%`,
    ``,
    `逐决策点：`,
  ]
  for (const e of trace.entries) {
    if (e.method !== "action") continue
    const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
    const rule = ruleKeyOf(e) ?? "<fallback>"
    lines.push(`[seq${e.seq}] ${digest} | ${rule} | 选 ${formatChosen(e.chosen)}${evalMarker(evalBySeq?.get(e.seq) ?? undefined)}`)
  }
  return { key: `game_summary:${game}`, content: lines.join("\n") }
}

/**
 * plan_simulate：对当前工作计划做规则链静态回放（历史决策点命中矩阵），
 * 并与原计划 diff。修订扰动预演——把执行期才知道的 coverage/fallback 统计
 * 前移到修订时刻。语料只读本侧文件（plan-replay.ts 授权边界）。
 * 多对手证据包：语料为各组并集（game 名带组名前缀）。
 */
export async function loadMergedCorpus(ctx: ModuleResolverContext): Promise<ReplayCorpus> {
  const groups = dirGroupsOf(ctx)
  const side = ctx.side ?? 0
  if (groups.length <= 1) {
    return loadReplayCorpus(groups[0]?.dir ?? "", side, { evalSuffix: ctx.evalSuffix, evidence: ctx.evidence })
  }
  const parts = await Promise.all(
    groups.map((g) => loadReplayCorpus(g.dir, side, { evalSuffix: ctx.evalSuffix, evidence: ctx.evidence })),
  )
  return {
    side,
    gameCount: parts.reduce((s, c) => s + c.gameCount, 0),
    points: parts.flatMap((c, i) => c.points.map((p) => ({ ...p, game: `${groups[i].label}/${p.game}` }))),
    hasEval: parts.some((c) => c.hasEval),
  }
}

/** 分层 × 分组矩阵渲染（plan_simulate 的 portfolio 分支；行 = 组，列 = 层化规则键） */
function formatPortfolioMatrix(result: PortfolioReplayResult): string {
  const lines: string[] = [
    `# 当前 portfolio 的分层静态回放（矩阵：行 = 对手组，列 = 层化规则键）`,
  ]
  for (const label of result.groupOrder) {
    const group = result.perGroup[label]
    lines.push(``, `## 对手组 ${label}（routing=${group.routing}）`)
    const corpus = group.corpus ?? { side: 0, gameCount: 0, points: [], hasEval: false }
    lines.push(formatMatrixSummary(group.replay, corpus))
    lines.push(`  命中键样例：${Object.entries(group.replay.perRule).sort((a, b) => b[1].hits - a[1].hits).slice(0, 20).map(([k, v]) => `${k} ${v.hits}/${v.shadowed}`).join("；")}`)
  }
  lines.push(``, `# 汇总：${result.groupOrder.length} 组 / ${result.totalPoints} 个决策点 / fallback ${result.totalFallback}（${((result.totalFallback / Math.max(1, result.totalPoints)) * 100).toFixed(1)}%）`)
  return lines.join("\n")
}

async function servePlanSimulate(ctx: ModuleResolverContext): Promise<ServedModule> {
  const groups = dirGroupsOf(ctx)
  if (groups.length === 0) return notFound("plan_simulate", "", "需要 run 目录（reflect 模式）")
  const gameData = ctx.gameData
  if (!gameData) return notFound("plan_simulate", "", "缺少 GameData（plan:reflect 注入）")

  // portfolio 上下文：分层 × 分组矩阵（每组按路由回放；组 label = run 目录名）
  if (ctx.portfolio) {
    const groupInputs = await Promise.all(groups.map(async (g) => ({
      label: g.label,
      singleLabel: g.singleLabel,
      corpus: await loadReplayCorpus(g.dir, ctx.side ?? 0, { evalSuffix: ctx.evalSuffix, evidence: ctx.evidence }),
    })))
    if (groupInputs.every((g) => g.corpus.points.length === 0)) {
      return { key: "plan_simulate", content: "（run 目录无可回放决策点——缺少 trace 文件或全部对局无 action 记录）" }
    }
    const result = replayPortfolio(ctx.portfolio, groupInputs, gameData)
    // 把 corpus 带回渲染（groupOrder 的每行需要 corpus.gameCount/hasEval）
    for (const gi of groupInputs) {
      result.perGroup[gi.label]!.corpus = gi.corpus
    }
    return { key: "plan_simulate", content: formatPortfolioMatrix(result) }
  }

  const current = ctx.currentPlan?.() ?? ctx.basePlan
  if (!current) return notFound("plan_simulate", "", "无当前计划（reflect 上下文缺失）")
  const corpus = ctx.loadCorpus
    ? await ctx.loadCorpus()
    : await loadMergedCorpus(ctx)
  if (corpus.points.length === 0) {
    return { key: "plan_simulate", content: "（run 目录无可回放决策点——缺少 trace 文件或全部对局无 action 记录）" }
  }
  const replay = replayPlan(current, corpus, gameData)
  const lines = [`# 当前计划（planId=${current.planId}）的静态回放`, formatMatrixSummary(replay, corpus)]
  const base = ctx.basePlan
  if (base && base.planId !== current.planId) {
    const baseReplay = replayPlan(base, corpus, gameData)
    const fb0 = (baseReplay.fallbackRate * 100).toFixed(1)
    const fb1 = (replay.fallbackRate * 100).toFixed(1)
    lines.push(``, `# 与原计划（planId=${base.planId}）的 diff`, `fallback 率 ${fb0}% → ${fb1}%`)
    const allRules = new Set([...Object.keys(baseReplay.perRule), ...Object.keys(replay.perRule)])
    const deltas = [...allRules]
      .map((r) => ({ r, before: baseReplay.perRule[r]?.hits ?? 0, after: replay.perRule[r]?.hits ?? 0 }))
      .filter((d) => d.before !== d.after)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    lines.push(deltas.length > 0
      ? `命中面变化：${deltas.slice(0, 12).map((d) => `${d.r} ${d.before}→${d.after}`).join("；")}${deltas.length > 12 ? `（另 ${deltas.length - 12} 条）` : ""}`
      : "各规则命中面与原计划一致（改动只影响 then 映射或未被语料触及）")
    const transitions: string[] = []
    for (let i = 0; i < baseReplay.pointKeys.length && transitions.length < 6; i++) {
      if (baseReplay.pointKeys[i] !== replay.pointKeys[i]) {
        transitions.push(`${baseReplay.pointKeys[i] ?? "<fallback>"} → ${replay.pointKeys[i] ?? "<fallback>"}`)
      }
    }
    if (transitions.length > 0) lines.push(`命中迁移样例：${transitions.join("；")}`)
  }
  return { key: "plan_simulate", content: lines.join("\n") }
}

// ── 注册表 ───────────────────────────────────────────────────────────

const SHARED_KINDS = ["fewshot_plan", "field_reference", "card_detail", "character_detail", "character_profile", "dice_prior"] as const
const REFLECT_KINDS = ["decision_detail", "rule_drilldown", "fallback_detail", "fallback_report", "game_summary", "plan_simulate"] as const

export function availableModuleKinds(mode: "author" | "reflect"): readonly string[] {
  return mode === "author" ? SHARED_KINDS : [...SHARED_KINDS, ...REFLECT_KINDS]
}

/** 创建模块解析器。mode 决定可用模块集合（author 侧无 run 目录数据）。
 *  opts.maxModuleChars：单模块字符上限（缺省 MAX_MODULE_CHARS，reflect/author 现状不变）；
 *  证据导出器（plan:organize-export）传大上限以放宽截断口径——环内 prompt 预算不随之改变。 */
export function createModuleResolver(
  mode: "author" | "reflect",
  ctx: ModuleResolverContext = {},
  opts?: { maxModuleChars?: number },
): (requests: ModuleRequest[]) => Promise<ServedModule[]> {
  const maxChars = opts?.maxModuleChars ?? MAX_MODULE_CHARS
  return async (requests) => {
    const out: ServedModule[] = []
    const allowed = new Set(availableModuleKinds(mode))
    for (const req of requests) {
      try {
        if (!allowed.has(req.kind)) {
          out.push({ key: req.kind, content: `（未知模块 kind：${req.kind}。${mode} 模式可用：${[...allowed].join(", ")}）` })
          continue
        }
        switch (req.kind) {
          case "fewshot_plan": out.push(serveFewshotPlan()); break
          case "field_reference": out.push(serveFieldReference()); break
          case "dice_prior": out.push(serveDicePrior()); break
          case "card_detail": {
            const id = Number(req.id)
            if (!Number.isFinite(id)) { out.push(notFound("card_detail", req.id, "id 必须是数字 defId")); break }
            out.push(await serveCardDetail(ctx, id))
            break
          }
          case "character_detail": {
            const id = Number(req.id)
            if (!Number.isFinite(id)) { out.push(notFound("character_detail", req.id, "id 必须是数字 defId")); break }
            out.push(await serveCharacterDetail(ctx, id))
            break
          }
          case "character_profile": {
            const id = Number(req.id)
            if (!Number.isFinite(id)) { out.push(notFound("character_profile", req.id, "id 必须是数字 defId")); break }
            out.push(serveCharacterProfile(id))
            break
          }
          case "decision_detail": out.push(await serveDecisionDetail(ctx, String(req.id ?? ""))); break
          case "rule_drilldown": out.push(await serveRuleDrilldown(ctx, String(req.id ?? ""))); break
          case "fallback_detail": out.push(await serveFallbackDetail(ctx)); break
          case "fallback_report": out.push(await serveFallbackReport(ctx)); break
          case "game_summary": out.push(await serveGameSummary(ctx, String(req.id ?? ""))); break
          case "plan_simulate": out.push(await servePlanSimulate(ctx)); break
        }
      } catch (e) {
        out.push(notFound(req.kind, req.id, e instanceof Error ? e.message : String(e)))
      }
    }
    // 统一大小闸
    return out.map((m) => ({ key: m.key, content: truncate(m.content, maxChars) }))
  }
}