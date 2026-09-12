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
 * plan:author — one-shot 决策树生成（设计文档 §7 author CLI）。
 *
 * 用法：
 *   pnpm run plan:author -- --deck <code> (--opponent-deck <code> | --mirror | --unknown | --opponent-set <file>) --out <plan.json>
 *
 * 一次性调用 LLM 生成 GamePlanV1，本地校验；不合法则携带错误列表做
 * 修复重试（repair 次数可用 --repair N 调整，默认 2）。
 *
 * --opponent-set <file>（G2，Phase 4，General 起草模式）：文件接受 JSON 数组
 * ["<deckCode>",...] / { "opponents": [...] } / 换行文本（每行一个 deckCode，
 * 空行与 # 注释忽略）；与 --opponent-deck / --mirror / --unknown 互斥；与 --anchor
 * 同用 → 启动报错（MVP 不支持跨对手锚点）。user prompt 注入全部对手牌表详情 +
 * 稳健性写作纪律段落；context.opponent 无论 LLM 输出什么都被强制 unknown_deck
 * （prepareCandidate 归一化覆盖 + 校验保证，D3）。
 *
 * --turns N（N>1）进入 harness 有界 agent 循环模式（2026-08-28 harness 设计文档）：
 * 首轮提示词与 one-shot 完全相同（全量注入），此后 LLM 可经 request_modules
 * 按需索取补充模块、draft 提交草稿校验、final 定稿，至多 N 轮。
 * 效率统计落 <out>.harness.json，逐轮原文落 <out>.transcript.jsonl。
 *
 * --candidates N（2..4，v1 仅 --turns 1）进入 r0 多候选起草模式（决定稿 2026-09-08）：
 * 同一条输入在**同一对话**里分 N 轮依次起草，每轮产出一个自标注 archetype 的路线
 * 候选（第 k 轮可见前 k-1 个候选的完整 JSON，须显式拉开路线距离）；随后同模型
 * +1 次「即时评审」凭锚点层论证择一落地。全部候选落 `<out>.alternates.json`
 * （reflect 换轴素材），评审原文落 `<out>.candidate-review.json`。
 * 与 --anchor 兼容（N 个候选共享同一锚点）；与 --turns>1 互斥（harness 组合为扩展点）。
 */

import { writeFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { DEFAULT_ASSETS_MANAGER, type AssetsManager } from "@gi-tcg/assets-manager"
import getData from "@gi-tcg/data"
import type { GameData, Version } from "@gi-tcg/core"
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer"
import { chatCompletion, extractJson, loadDotEnvFallback } from "./llm.js"
import { ANCHOR_SYSTEM_PROMPT, AUTHOR_SYSTEM_PROMPT, buildAuthorSystemPrompt, buildCandidateReviewSystemPrompt, buildCandidatesSystemPrompt } from "./plan-prompts.js"
import { runAgentLoop } from "./agent-loop.js"
import { createModuleResolver, oneLine } from "./modules.js"
import { renderDeckDetail } from "./deck-detail.js"
import { runCandidateSession } from "./candidate-session.js"
import { buildCardFaceTable } from "../card-face-table.js"
import { buildAnchorAssertionsSidecar, checkAnchorAssertions, type AnchorCheckIssue, type AnchorCheckResult } from "./author-anchor-check.js"
import { validateGamePlan, computePlanId, autoRepairPlan, normalizePlanNumericFields } from "../validate.js"
import type { PlanValidationContext } from "../validate.js"
import type { GamePlanV1 } from "../game-plan-v1.js"
import { buildOpponentSetPromptSections, parseOpponentSetFile } from "./author-opponent-set.js"
import { assetsManagerForVersion, applyAuthorGameVersion, parseGameVersion } from "../version.js"
import { buildAlternatesSidecar } from "../plan-graft.js"

const SYSTEM_PROMPT = AUTHOR_SYSTEM_PROMPT

interface AuthorArgs {
  deck: string
  opponent: { kind: "mirror" } | { kind: "known_deck"; deckCode: string } | { kind: "unknown_deck" }
  /**
   * General 起草模式（--opponent-set <file>，G2）：对手集合文件路径；
   * 设置后 opponent 固定 unknown_deck（D3），prompt 注入全部对手详情 + 稳健性纪律。
   * 与 --opponent-deck/--mirror/--unknown 互斥；与 --anchor 同用 → 启动报错（MVP 不支持跨对手锚点）。
   */
  opponentSetFile?: string
  /** 解析后的对手集合（main() 读文件后填充；供 buildUserPrompt 分支） */
  opponentSetCodes?: string[]
  out: string
  author: string
  repair: number
  /** 开推理（scnet DeepSeek 等推理可靠的通道用） */
  thinking: boolean
  temperature: number
  seed: number | undefined
  /** 覆盖 OPENAI_MODEL（如通道上某模型被限流时切换） */
  model: string | undefined
  /** 两阶段起草：先产出策略锚点 JSON，再携带锚点起草计划（消融臂） */
  anchor: boolean
  /** 输出 token 预算：长推理模型（MiniMax-M3 reasoning 可达 ~10 万字符）需调大 */
  maxTokens: number
  /** SSE 流式接收：大预算长推理请求必须（否则网关 300s 流超时掐断） */
  stream: boolean
  /** harness 模式轮次上限：1 = one-shot（默认，对照臂）；>1 = 有界 agent 循环 */
  turns: number
  /** harness 全程模块送达预算 */
  moduleBudget: number
  /** harness 单轮最多送达模块数 */
  perTurnModules: number
  /**
   * r0 多候选起草（--candidates N，2..4；v1 仅 one-shot --turns 1）：
   * 同一对话 N 轮顺序起草（各带 --repair 预算；重复候选回注重出）→ 同模型即时评审择一 → 全部候选落
   * `<out>.alternates.json`（含被选中者）供 reflect 换轴，评审原文落
   * `<out>.candidate-review.json`。与 --anchor 兼容（候选共享同一锚点）。
   */
  candidates?: number
  /**
   * 游戏版本钉扎（--game-version <v>，V1）：显式指定时 prompt 卡面数据按该版本
   * （versioned AssetsManager，§2.2 实测静态 API 支持引擎版本串），产物写
   * context.gameVersion，校验用该版本数据做存在性检查；缺省不写（未钉版本，
   * 保持旧产物形态，prompt 数据源仍为 latest）。
   */
  gameVersion?: Version
}

function parseArgs(): AuthorArgs {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const deck = get("deck")
  const out = get("out")
  if (!deck || !out) {
    console.error("usage: plan:author -- --deck <code> (--opponent-deck <code> | --mirror | --unknown | --opponent-set <file>) --out <plan.json> [--anchor] [--candidates 3] [--author <name>] [--repair N] [--temperature 0.2] [--seed N] [--model <name>] [--max-tokens 32768] [--stream] [--turns 1] [--module-budget 12] [--per-turn-modules 4] [--game-version v6.6.0] [--no-thinking]")
    process.exit(1)
  }
  // r0 多候选起草：2..4 的整数；v1 仅 one-shot（harness 组合为扩展点）
  const candidatesRaw = get("candidates")
  let candidates: number | undefined
  if (candidatesRaw !== undefined) {
    const n = Number(candidatesRaw)
    if (!Number.isInteger(n) || n < 2 || n > 4) {
      console.error(`--candidates 必须是 2..4 的整数（本次 ${candidatesRaw}）`)
      process.exit(1)
    }
    candidates = n
  }
  const turns = Number(get("turns") ?? 1)
  if (candidates !== undefined && turns > 1) {
    console.error("--candidates 与 --turns>1（agentic harness）暂不兼容：v1 多候选仅支持 one-shot（--turns 1），harness 组合为后续扩展点。请去掉其一。")
    process.exit(1)
  }
  // V1 版本钉扎：--game-version 封闭校验（非法版本串 → 启动报错并列出可用版本）
  let gameVersion: Version | undefined
  try {
    gameVersion = parseGameVersion(get("game-version"))
  } catch (e) {
    console.error(`--game-version 非法：${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const opponentSetFile = get("opponent-set")
  if (opponentSetFile !== undefined) {
    // G2：General 起草模式与单对手参数互斥；MVP 不支持 --anchor 跨对手锚点
    if (args.includes("--opponent-deck") || args.includes("--mirror") || args.includes("--unknown")) {
      console.error("--opponent-set（General）与 --opponent-deck / --mirror / --unknown 互斥（一次起草只有一个对手假设）")
      process.exit(1)
    }
    if (args.includes("--anchor")) {
      console.error("--anchor 与 --opponent-set 同用暂不支持：锚点阶段（赛前策略分析）面向单一对手，跨对手版留待后续版本。请去掉 --anchor 或改用单对手模式。")
      process.exit(1)
    }
    return {
      deck,
      opponent: { kind: "unknown_deck" }, // D3：General 计划声明 unknown_deck（prepareCandidate 强制覆盖）
      opponentSetFile,
      out,
      author: get("author") ?? get("model") ?? process.env.OPENAI_MODEL ?? "unknown",
      repair: Number(get("repair") ?? 2),
      thinking: args.includes("--no-thinking") ? false : true,
      temperature: Number(get("temperature") ?? 0.2),
      seed: get("seed") !== undefined ? Number(get("seed")) : undefined,
      model: get("model"),
      anchor: args.includes("--anchor"),
      maxTokens: Number(get("max-tokens") ?? 32768),
      stream: args.includes("--stream"),
      turns,
      moduleBudget: Number(get("module-budget") ?? 12),
      perTurnModules: Number(get("per-turn-modules") ?? 4),
      ...(gameVersion !== undefined ? { gameVersion } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    }
  }
  let opponent: AuthorArgs["opponent"]
  if (args.includes("--mirror")) opponent = { kind: "mirror" }
  else if (args.includes("--unknown")) opponent = { kind: "unknown_deck" }
  else {
    const oppCode = get("opponent-deck")
    if (!oppCode) {
      console.error("需要 --opponent-deck / --mirror / --unknown / --opponent-set 之一")
      process.exit(1)
    }
    opponent = { kind: "known_deck", deckCode: oppCode }
  }
  return {
    deck,
    opponent,
    out,
    author: get("author") ?? get("model") ?? process.env.OPENAI_MODEL ?? "unknown",
    repair: Number(get("repair") ?? 2),
    thinking: args.includes("--no-thinking") ? false : true,
    temperature: Number(get("temperature") ?? 0.2),
    seed: get("seed") !== undefined ? Number(get("seed")) : undefined,
    model: get("model"),
    anchor: args.includes("--anchor"),
    maxTokens: Number(get("max-tokens") ?? 32768),
    stream: args.includes("--stream"),
    turns,
    moduleBudget: Number(get("module-budget") ?? 12),
    perTurnModules: Number(get("per-turn-modules") ?? 4),
    ...(gameVersion !== undefined ? { gameVersion } : {}),
    ...(candidates !== undefined ? { candidates } : {}),
  }
}

/**
 * 版本化 GameData（tag 渲染真值源）。`getData` 每次调用都会重建整表
 * （core Registry.resolve 无缓存），这里按版本记忆化。
 */
let gameDataCache: { version: Version | undefined; data: GameData } | null = null
function gameDataOf(version: Version | undefined): GameData {
  if (gameDataCache === null || gameDataCache.version !== version) {
    gameDataCache = { version, data: getData(version) }
  }
  return gameDataCache.data
}

/**
 * 资产技能记录 name → skill defId（与 deck-context 的 `skills[].name` 同源，
 * 按名字精确对齐；不做顺序猜测，避免同类型多变体错配）。数据未就绪时返回空表
 * （技能行退化为不带 id，不误配）。
 */
function assetSkillIdsOf(assets: AssetsManager, charDefId: number): ReadonlyMap<string, number> {
  try {
    const data = assets.getDataSync(charDefId) as { skills?: Array<{ id?: unknown; name?: unknown }> }
    const map = new Map<string, number>()
    for (const s of data.skills ?? []) {
      if (typeof s.id === "number" && typeof s.name === "string") map.set(s.name, s.id)
    }
    return map
  } catch {
    return new Map()
  }
}

/** 牌表详情：角色技能（含 `#<skill defId>`，写 then.skill_def_id 的取数来源）+ 卡牌
 * （效果/费用/core 短名 tag）+ 衍生物说明——写规则的数值依据。
 * assets 支持 --game-version 传入版本化实例（缺省 latest）。
 * gameData 提供卡牌 core 实体短名 tag 真值（与 fields.ts hand.countWithTag 运行时比较同源）。 */
async function describeDeckDetail(code: string, assets: AssetsManager, gameData: GameData): Promise<string> {
  const ctx = await createDeckContext(code, assets)
  return renderDeckDetail(ctx, gameData, (charDefId) => assetSkillIdsOf(assets, charDefId))
}

/** 对手信息文本（含已知牌表的详情）；镜像复用己方详情，未知不给数据 */
async function describeOpponent(args: AuthorArgs, assets: AssetsManager): Promise<string> {
  if (args.opponent.kind === "known_deck") {
    return `# Opponent deck (known, ${args.opponent.deckCode})\n\n${await describeDeckDetail(args.opponent.deckCode, assets, gameDataOf(args.gameVersion))}`
  }
  if (args.opponent.kind === "mirror") {
    return "# Opponent deck\n\nMirror match: the opponent runs exactly your deck (details as in your deck section above)."
  }
  return "# Opponent deck\n\nUnknown: write a policy that stays robust against any deck."
}

/** 版本钉扎提示（V1）：显式 --game-version 时告知 LLM 卡面数据版本 */
function gameVersionNote(args: AuthorArgs): string {
  return args.gameVersion !== undefined
    ? `\n\n# Game version\n\nCard-face data version: **${args.gameVersion}**. The deck table and every value above follow that version; numeric assertions in your rules (HP/damage/cost) must match it.`
    : ""
}

async function buildUserPrompt(args: AuthorArgs, anchorJson: string | null, assets: AssetsManager): Promise<string> {
  const parts: string[] = []
  parts.push(`# Your deck (share code ${args.deck})\n\n${await describeDeckDetail(args.deck, assets, gameDataOf(args.gameVersion))}`)
  if (args.opponentSetCodes) {
    // G2-1：General 模式——注入全部对手牌表详情 + 稳健性写作纪律；opponent 强制 unknown_deck
    const detailByCode = new Map<string, string>()
    for (const code of args.opponentSetCodes) {
      detailByCode.set(code, await describeDeckDetail(code, assets, gameDataOf(args.gameVersion)))
    }
    parts.push(...buildOpponentSetPromptSections(args.opponentSetCodes, (code) => detailByCode.get(code) ?? ""))
    parts.push(`Write a GamePlanV1 for the matchups above. Set context.deckCode to "${args.deck}" and context.opponent to ${JSON.stringify(args.opponent)}.

Important: rules/opening may only reference character and card defIds that appear in **your own** deck table above; any id not listed there fails validation. Output JSON only.${gameVersionNote(args)}`)
    return parts.join("\n\n")
  }
  parts.push(await describeOpponent(args, assets))
  if (anchorJson !== null) {
    parts.push(`# Pre-game strategy anchor (pre-game analysis artifact)

Turn the anchor into rules: transcribe comboLines / riskTriggers into concrete when→then rules, take kill-line numbers from killMath, map opening to the three opening sections and prioritySkeleton to the priority ordering. The anchor is not the rules themselves — do not copy its text verbatim.

\`\`\`json
${anchorJson}
\`\`\``)
  }
  parts.push(`Write a GamePlanV1 for this matchup. Set context.deckCode to "${args.deck}" and context.opponent to ${JSON.stringify(args.opponent)}.

Important: rules/opening may only reference character and card defIds that appear in your deck table above; any id not listed there fails validation. Output JSON only.${gameVersionNote(args)}`)
  return parts.join("\n\n")
}

/** 锚点阶段的用户提示：牌表详情 + 对手信息，无计划指令 */
async function buildAnchorUserPrompt(args: AuthorArgs, assets: AssetsManager): Promise<string> {
  const parts: string[] = []
  parts.push(`# Your deck (share code ${args.deck})\n\n${await describeDeckDetail(args.deck, assets, gameDataOf(args.gameVersion))}`)
  parts.push(await describeOpponent(args, assets))
  parts.push(`Produce the strategy-anchor JSON. Every defId and number must come from the deck details above. Output JSON only.${gameVersionNote(args)}`)
  return parts.join("\n\n")
}

/**
 * 第一阶段：策略锚点分析（--anchor）。产出格式化 JSON 文本；解析失败/机检未通过重试一次。
 * 同时记首轮合规账（`attempts` = 总尝试次数，`firstAttemptIssues` = 首轮失败 issue）——
 * 机检失败不做类型转换兜底，纪律问题以可聚合指标落旁档。
 */
async function authorAnchor(
  args: AuthorArgs,
  assets: AssetsManager,
  deck: { characters: readonly number[]; cards: readonly number[] },
): Promise<{ json: string; check: AnchorCheckResult; attempts: number; firstAttemptIssues: AnchorCheckIssue[] }> {
  const user = await buildAnchorUserPrompt(args, assets)
  // 卡面事实表：锚点数值断言（技能费用/基础伤害）的静态真值源（版本按 --game-version）
  const cardFace = buildCardFaceTable({ gameVersion: args.gameVersion })
  let lastErr = "output is not valid JSON"
  let attempts = 0
  let firstAttemptIssues: AnchorCheckIssue[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts += 1
    const prompt = attempt === 0
      ? user
      : `${user}\n\n# The previous output failed the check; fix it and output the anchor JSON only:\n${lastErr}`
    const resp = await chatCompletion({
      system: ANCHOR_SYSTEM_PROMPT,
      user: prompt,
      thinking: args.thinking,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      stream: args.stream,
      // 与计划起草的 seed 错开，避免同 prompt 复现同一份坏输出
      seed: args.seed !== undefined ? args.seed + 100 + attempt : undefined,
      model: args.model,
    })
    try {
      const parsed = extractJson(resp.content || (resp.reasoningContent ?? "")) as Record<string, unknown>
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an anchor object")
      }
      // 形状闸：只解析出片段（如 {"error": ...}）也判失败，防止把退化锚点注入计划起草
      if (typeof parsed.archetype !== "string" || !Array.isArray(parsed.killMath) || !Array.isArray(parsed.riskTriggers)) {
        throw new Error("anchor is missing the required archetype/killMath/riskTriggers fields")
      }
      // 数值闸：killMath/comboLines 的断言 × 牌表存在性 × 卡面事实表（费用/基础伤害）
      const check = checkAnchorAssertions(parsed, deck, cardFace)
      if (check.issues.length > 0) {
        console.log(`anchor 数值校核 ${check.issues.length} 条问题：`)
        for (const issue of check.issues.slice(0, 10)) console.log(`  ${issue.path}: ${issue.message}`)
        if (attempt === 0) firstAttemptIssues = check.issues
        throw new Error(`anchor numeric check failed (${check.issues.length} issues): ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`)
      }
      return { json: JSON.stringify(parsed, null, 2), check, attempts, firstAttemptIssues }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      // 非机检失败（JSON 解析 / 形状闸）无 path：按 path="" 记一条 other，首轮失败不丢样本
      if (attempt === 0 && firstAttemptIssues.length === 0) firstAttemptIssues = [{ path: "", message: lastErr }]
      console.log(`anchor attempt ${attempt}: 未通过（${oneLine(lastErr)}）`)
    }
  }
  throw new Error("anchor 阶段失败：两次输出均未通过解析/校核")
}

/**
 * 候选计划制备（one-shot 修复循环与 harness 校验回调共用）：
 * normalize → 系统字段覆盖 → auto-repair 死规则 → sampling 元数据 → planId。
 * 不抛结构错误以外的异常；校验留给 validateGamePlan。
 */
function prepareCandidate(parsed: unknown, args: AuthorArgs, validCtx: PlanValidationContext): { plan: GamePlanV1; dropped: string[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a plan object")
  }
  const plan = normalizePlanNumericFields(parsed as GamePlanV1)
  // 系统字段覆盖（LLM 可能漏掉 context 等对象，先补壳再覆盖，交给校验兜底）
  plan.createdAt = new Date().toISOString()
  plan.author = args.author
  plan.parentPlanId = plan.parentPlanId ?? null
  plan.context = { ...(plan.context ?? {}), deckCode: args.deck, opponent: args.opponent } as GamePlanV1["context"]
  // V1 版本钉扎：显式 --game-version 才写 context.gameVersion；缺省剥离（契约见 version.ts）
  applyAuthorGameVersion(plan.context, args.gameVersion)
  // 先机械修复死规则（引用非牌表 defId），再走校验
  const repaired = autoRepairPlan(plan, validCtx)
  const out = repaired.plan
  out.sampling = { temperature: args.temperature, ...(args.seed !== undefined ? { seed: args.seed } : {}), ...(args.anchor ? { anchor: true } : {}) }
  out.planId = computePlanId(out)
  return { plan: out, dropped: repaired.dropped }
}

function planStatsNote(plan: GamePlanV1): string {
  const opening = plan.opening
  const openingCount = (opening?.chooseActive?.length ?? 0) + (opening?.mulligan?.length ?? 0) + (opening?.reroll?.length ?? 0)
  return `rules=${plan.rules?.length ?? 0}, phases=${plan.phases?.length ?? 0}, opening=${openingCount}, fallback=${plan.fallback?.policy}, predictions(winRate=${plan.predictions?.winRateEstimate}, rounds=${plan.predictions?.expectedRounds})`
}

async function writeHarnessSidecars(out: string, outcome: { stats: unknown; turns: unknown[] }): Promise<void> {
  await mkdir(dirname(out), { recursive: true })
  await writeFile(`${out}.harness.json`, `${JSON.stringify(outcome.stats, null, 2)}\n`, "utf-8")
  await writeFile(`${out}.transcript.jsonl`, `${outcome.turns.map((t) => JSON.stringify(t)).join("\n")}\n`, "utf-8")
}

// ── r0 多候选起草（--candidates N，2026-09-08 决定稿：自由生成 + 自标注 + 即时评审）──

/** 候选起草产物（index 与评审 choice 同域） */
interface AuthorCandidate {
  index: number
  archetype: string
  plan: GamePlanV1
}

const CANDIDATE_REVIEW_VERSION = "CandidateReviewV1"

/** `<out>.candidate-review.json`（评审原文 + 候选身份映射，自描述） */
interface CandidateReviewSidecar {
  version: typeof CANDIDATE_REVIEW_VERSION
  deckCode: string
  gameVersion?: string
  candidateCount: number
  choice: number
  rationale: string
  notes: string[]
  candidates: Array<{ index: number; archetype: string; planId: string }>
  createdAt: string
}

interface CandidateReviewVerdict {
  choice: number
  rationale: string
  notes: string[]
}

/**
 * 单候选一稿的解析 + 制备 + 校验（单对话会话的 check 回调；每轮调用一次）。
 * 载荷契约：{"archetype": 自标注路线标签, "plan": GamePlanV1}。
 */
async function checkCandidateDraft(
  resp: { content: string; reasoningContent?: string },
  ctx: { index: number; attempt: number },
  args: AuthorArgs,
  validCtx: PlanValidationContext,
): Promise<{ ok: true; candidate: AuthorCandidate } | { ok: false; issues: string[] }> {
  const raw = resp.content || (resp.reasoningContent ?? "")
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch (e) {
    console.log(`[candidate ${ctx.index}] attempt ${ctx.attempt}: 输出无法解析为 JSON`)
    console.log(`  tail: …${raw.slice(-300).replace(/\s+/g, " ")}`)
    if (resp.reasoningContent) {
      const dbgPath = `${args.out}.candidate${ctx.index}.attempt${ctx.attempt}.reasoning.txt`
      await mkdir(dirname(args.out), { recursive: true })
      await writeFile(dbgPath, resp.reasoningContent, "utf-8")
      console.log(`  reasoning dump: ${dbgPath}`)
    }
    return { ok: false, issues: [`output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const wrapped = parsed as Record<string, unknown> | null
  const archetype = typeof wrapped?.archetype === "string" && wrapped.archetype.trim() !== "" ? wrapped.archetype.trim() : null
  if (archetype === null) {
    console.log(`[candidate ${ctx.index}] attempt ${ctx.attempt}: 缺少 archetype 自标注`)
    return { ok: false, issues: ['missing archetype self-label (candidate mode requires {"archetype": "...", "plan": {...}})'] }
  }
  const payload = wrapped?.plan
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.log(`[candidate ${ctx.index}] attempt ${ctx.attempt}: 缺少 plan 载荷`)
    return { ok: false, issues: ['missing plan (candidate mode requires {"archetype": "...", "plan": {...}})'] }
  }
  let plan: GamePlanV1
  let dropped: string[]
  try {
    const prepared = prepareCandidate(payload, args, validCtx)
    plan = prepared.plan
    dropped = prepared.dropped
  } catch (e) {
    const message = `plan is not valid GamePlanV1 JSON: ${e instanceof Error ? e.message : String(e)}`
    console.log(`[candidate ${ctx.index}] attempt ${ctx.attempt}: ${message}`)
    return { ok: false, issues: [message] }
  }
  const validation = validateGamePlan(plan, validCtx)
  if (validation.ok) {
    if (dropped.length > 0) console.log(`[candidate ${ctx.index}] auto-repair 移除 ${dropped.length} 个死规则/条目`)
    console.log(`[candidate ${ctx.index}] ${archetype}：planId=${plan.planId} ${planStatsNote(plan)}`)
    return { ok: true, candidate: { index: ctx.index, archetype, plan } }
  }
  console.log(`[candidate ${ctx.index}] attempt ${ctx.attempt}: ${validation.issues.length} 个校验问题`)
  for (const issue of validation.issues.slice(0, 10)) console.log(`  ${issue.path}: ${issue.message}`)
  return { ok: false, issues: validation.issues.map((i) => `${i.path}: ${i.message}`) }
}

/** 即时评审（同模型 +1 次调用）：凭锚点层论证择一；不合法重试一次后失败 */
async function reviewCandidates(
  args: AuthorArgs,
  anchorJson: string | null,
  candidates: readonly AuthorCandidate[],
): Promise<CandidateReviewVerdict | null> {
  const system = buildCandidateReviewSystemPrompt(candidates.length)
  const parts: string[] = []
  if (anchorJson !== null) {
    parts.push(`# Pre-game strategy anchor (review basis)\n\n\`\`\`json\n${anchorJson}\n\`\`\``)
  }
  parts.push(`# Candidate list (${candidates.length}; the index is in each section heading)\n\n${candidates.map((c) => `## Candidate index=${c.index} | archetype=${c.archetype}\n\n\`\`\`json\n${JSON.stringify(c.plan)}\n\`\`\``).join("\n\n")}`)
  const base = `${parts.join("\n\n")}\n\nOutput the review JSON (choice / rationale / notes). Output JSON only.`
  let lastErr = "output is not valid JSON"
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? base
      : `${base}\n\n# The previous review output failed: ${lastErr}\nFix it and output the review JSON only.`
    const resp = await chatCompletion({
      system,
      user: prompt,
      thinking: args.thinking,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      stream: args.stream,
      // 与起草阶段错开 seed 段位（900+），避免与候选输出相关性
      seed: args.seed !== undefined ? args.seed + 900 + attempt : undefined,
      model: args.model,
    })
    try {
      const parsed = extractJson(resp.content || (resp.reasoningContent ?? "")) as Record<string, unknown>
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      const choice = Number(parsed.choice)
      if (!Number.isInteger(choice) || !candidates.some((c) => c.index === choice)) {
        throw new Error(`choice ${JSON.stringify(parsed.choice)} is not one of the candidate indices (available: ${candidates.map((c) => c.index).join("/")})`)
      }
      const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim() !== "" ? parsed.rationale.trim() : null
      if (rationale === null) throw new Error("missing non-empty rationale")
      if (parsed.notes !== undefined && !Array.isArray(parsed.notes)) throw new Error("notes must be an array of strings")
      const notes = Array.isArray(parsed.notes) ? parsed.notes.map((n) => (typeof n === "string" ? n : "")) : []
      return { choice, rationale, notes }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.log(`review attempt ${attempt}: 未通过（${oneLine(lastErr)}）`)
    }
  }
  console.error("候选评审失败：两次输出均不合法")
  return null
}

/**
 * 多候选起草主流程（--candidates N）：**同一对话**分 N 轮依次起草（第 k 轮可见前
 * k-1 个候选的完整 JSON）→ 即时评审 → 选中者写 `<out>`，全部候选落
 * `<out>.alternates.json`（reflect 换轴素材），评审原文落
 * `<out>.candidate-review.json`。任一候选失败或评审失败 → 整轮失败（exit 1）。
 */
async function mainCandidates(
  args: AuthorArgs,
  validCtx: PlanValidationContext,
  baseUser: string,
  anchorJson: string | null,
): Promise<void> {
  const count = args.candidates!
  const system = buildCandidatesSystemPrompt(count)
  console.log(`[candidates] 多候选起草：${count} 个候选同对话顺序起草（repair 预算 ${args.repair}${args.anchor ? "，共享同一锚点" : ""}）`)
  const outcome = await runCandidateSession<AuthorCandidate>({
    count,
    system,
    baseUser,
    repair: args.repair,
    seedBase: args.seed,
    chat: (req) => chatCompletion({
      messages: req.messages,
      thinking: args.thinking,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      stream: args.stream,
      seed: req.seed,
      model: args.model,
    }),
    check: (resp, ctx) => checkCandidateDraft(resp, ctx, args, validCtx),
    // planId 是内容哈希（computePlanId 剔除 planId/parent/createdAt）——同 planId 即同内容，
    // 等价于「与已收录候选逐字节相同」
    identity: (c) => c.plan.planId,
    log: (msg) => console.log(msg),
  })
  if (!outcome.ok) {
    console.error(`authoring failed: 候选 ${outcome.failedIndex} 未能产出合法计划`)
    process.exitCode = 1
    return
  }
  const candidates = outcome.candidates
  const review = await reviewCandidates(args, anchorJson, candidates)
  if (review === null) {
    process.exitCode = 1
    return
  }
  const chosen = candidates.find((c) => c.index === review.choice)!
  await mkdir(dirname(args.out), { recursive: true })
  await writeFile(args.out, `${JSON.stringify(chosen.plan, null, 2)}\n`, "utf-8")
  const alternates = buildAlternatesSidecar({
    deckCode: args.deck,
    chosenIndex: chosen.index,
    candidates: candidates.map((c) => ({
      index: c.index,
      archetype: c.archetype,
      reviewNote: review.notes[c.index] ?? "",
      adoptedUnits: [],
      plan: c.plan,
    })),
    ...(args.gameVersion !== undefined ? { gameVersion: args.gameVersion } : {}),
  })
  await writeFile(`${args.out}.alternates.json`, `${JSON.stringify(alternates, null, 2)}\n`, "utf-8")
  const reviewSidecar: CandidateReviewSidecar = {
    version: CANDIDATE_REVIEW_VERSION,
    deckCode: args.deck,
    ...(args.gameVersion !== undefined ? { gameVersion: args.gameVersion } : {}),
    candidateCount: count,
    choice: review.choice,
    rationale: review.rationale,
    notes: review.notes,
    candidates: candidates.map((c) => ({ index: c.index, archetype: c.archetype, planId: c.plan.planId })),
    createdAt: new Date().toISOString(),
  }
  await writeFile(`${args.out}.candidate-review.json`, `${JSON.stringify(reviewSidecar, null, 2)}\n`, "utf-8")
  console.log(`OK: plan written to ${args.out}（candidates=${count}，choice=${chosen.index}｜${chosen.archetype}）`)
  console.log(`planId=${chosen.plan.planId} ${planStatsNote(chosen.plan)}`)
  console.log(`评审理由：${oneLine(review.rationale)}`)
  console.log(`alternates written to ${args.out}.alternates.json（${count} 个候选）`)
  console.log(`candidate review written to ${args.out}.candidate-review.json`)
}

/** harness 有界 agent 循环路径（--turns N>1） */
async function mainAgentic(args: AuthorArgs, validCtx: PlanValidationContext, user: string, assets: AssetsManager): Promise<void> {
  const system = buildAuthorSystemPrompt(true, {
    maxTurns: args.turns,
    moduleBudget: args.moduleBudget,
    perTurnModules: args.perTurnModules,
  })
  const outcome = await runAgentLoop<GamePlanV1>({
    label: "author",
    system,
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
    resolveModules: createModuleResolver("author", { assets, gameData: gameDataOf(args.gameVersion) }),
    check: (_action, payload) => {
      try {
        const { plan, dropped } = prepareCandidate(payload, args, validCtx)
        const validation = validateGamePlan(plan, validCtx)
        if (!validation.ok) {
          const issues = validation.issues.map((i) => `${i.path}: ${i.message}`)
          if (dropped.length > 0) {
            issues.unshift(`(auto-repair removed ${dropped.length} dead rule/entry items: ${dropped.join("; ")})`)
          }
          return { ok: false, issues }
        }
        const statsNote = planStatsNote(plan)
          + (dropped.length > 0 ? `; note: auto-repair removed ${dropped.length} dead rules/entries: ${dropped.join("; ")}` : "")
          + (validation.warnings.length > 0 ? `; advisory warnings: ${validation.warnings.map((w) => `${w.path} ${w.message}`).join("; ")}` : "")
        return { ok: true, issues: [], result: plan, statsNote }
      } catch (e) {
        return { ok: false, issues: [`output is not valid GamePlanV1 JSON: ${e instanceof Error ? e.message : String(e)}`] }
      }
    },
  })
  await writeHarnessSidecars(args.out, outcome)
  if (!outcome.result) {
    console.error(`authoring failed (agentic): ${outcome.stats.error ?? outcome.status}`)
    process.exitCode = 1
    return
  }
  const plan = outcome.result
  await writeFile(args.out, `${JSON.stringify(plan, null, 2)}\n`, "utf-8")
  const s = outcome.stats
  console.log(`OK: plan written to ${args.out}（agentic，terminatedBy=${outcome.status}，turns=${s.turns}，modules=${s.moduleRequests.total}，drafts=${s.drafts}，finalAttempts=${s.finalAttempts}）`)
  console.log(`planId=${plan.planId} ${planStatsNote(plan)}`)
  if (outcome.status === "turn_cap_draft") {
    console.log(`注意：轮次耗尽，采用第 ${s.adoptedDraftTurn ?? "?"} 轮通过校验的 draft`)
  }
}

async function main() {
  loadDotEnvFallback()
  const args = parseArgs()

  // G2：General 起草模式——读取并解析对手集合文件（三种格式 + 垃圾输入校验）
  if (args.opponentSetFile !== undefined) {
    let text: string
    try {
      text = await readFile(args.opponentSetFile, "utf-8")
    } catch (e) {
      console.error(`--opponent-set 文件读取失败：${args.opponentSetFile}（${e instanceof Error ? e.message : String(e)}）`)
      process.exitCode = 1
      return
    }
    const parsed = parseOpponentSetFile(text)
    if (!parsed.ok) {
      console.error(`--opponent-set 解析失败：${parsed.error}`)
      process.exitCode = 1
      return
    }
    args.opponentSetCodes = parsed.codes
    console.log(`[General] 对手集合 ${parsed.codes.length} 个（${parsed.codes.map((c) => c.slice(0, 8)).join(", ")}…）；context.opponent 固定 unknown_deck（D3）`)
  }

  const selfDeck = DEFAULT_ASSETS_MANAGER.decode(args.deck)
  const opponentDeck = args.opponent.kind === "mirror"
    ? selfDeck
    : args.opponent.kind === "known_deck"
      ? DEFAULT_ASSETS_MANAGER.decode(args.opponent.deckCode)
      : undefined
  // V1 版本钉扎：显式 --game-version 时校验上下文附带该版本数据（LLM 引用该版本
  // 不存在的卡/角色会在校验/修复循环里被拦下）；缺省不带（现状）
  const validCtx: PlanValidationContext = {
    deck: selfDeck,
    opponentDeck,
    ...(args.gameVersion !== undefined ? { data: gameDataOf(args.gameVersion) } : {}),
  }
  // prompt 数据源版本化：显式版本 → 版本化 AssetsManager（该版本卡面文本）；
  // 缺省 → DEFAULT_ASSETS_MANAGER（"latest"，现状）。deck decode 与版本无关（静态映射）
  const assets = assetsManagerForVersion(args.gameVersion)

  // ③ 消融臂：先产出策略锚点（落 sidecar 供谱系追踪），再携带锚点起草
  let anchorJson: string | null = null
  if (args.anchor) {
    const authored = await authorAnchor(args, assets, selfDeck)
    anchorJson = authored.json
    await mkdir(dirname(args.out), { recursive: true })
    await writeFile(`${args.out}.anchor.json`, `${anchorJson}\n`, "utf-8")
    console.log(`anchor written to ${args.out}.anchor.json (${anchorJson.length} chars)`)
    // 锚点数值断言的机检结果落旁档（reflect 按计划版本重算并注入；plan:batch 随主计划归档）
    const sidecar = buildAnchorAssertionsSidecar({
      check: authored.check,
      deckCode: args.deck,
      attempts: authored.attempts,
      firstAttemptIssues: authored.firstAttemptIssues,
      ...(args.gameVersion !== undefined ? { gameVersion: args.gameVersion } : {}),
    })
    await writeFile(`${args.out}.anchor-assertions.json`, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8")
    console.log(`anchor assertions written to ${args.out}.anchor-assertions.json（attempts=${sidecar.attempts}，firstAttemptIssues=${sidecar.firstAttemptIssues?.length ?? 0}，killMath=${sidecar.killMath.length}，comboLines=${sidecar.comboLines.length}，unchecked=${sidecar.unchecked.length}）`)
  }
  const user = await buildUserPrompt(args, anchorJson, assets)
  const vsNote = args.opponentSetCodes
    ? `General(opponent-set ${args.opponentSetCodes.length})`
    : args.opponent.kind
  console.log(`authoring plan for deck ${args.deck.slice(0, 12)}… vs ${vsNote} (author=${args.author}, anchor=${args.anchor}, candidates=${args.candidates ?? 1}, turns=${args.turns}, gameVersion=${args.gameVersion ?? "latest(默认)"})`)

  // r0 多候选起草（--candidates N）：同一对话顺序起草 N 轮 → 即时评审择一 → 落 alternates sidecar
  if (args.candidates !== undefined) {
    await mainCandidates(args, validCtx, user, anchorJson)
    return
  }

  if (args.turns > 1) {
    await mainAgentic(args, validCtx, user, assets)
    return
  }

  let plan: GamePlanV1 | null = null
  let lastIssues: string[] = []
  for (let attempt = 0; attempt <= args.repair; attempt++) {
    const prompt = attempt === 0
      ? user
      : `${user}\n\n# The previous draft failed validation; fix the issues below and output the full JSON again:\n${lastIssues.map((s) => `- ${s}`).join("\n")}`
    const resp = await chatCompletion({
      system: SYSTEM_PROMPT,
      user: prompt,
      thinking: args.thinking,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      stream: args.stream,
      // 修复重试必须打破采样确定性：同 seed + 同 prompt 会复现同一份坏输出
      seed: args.seed !== undefined ? args.seed + attempt : undefined,
      model: args.model,
    })
    let parsed: unknown
    try {
      parsed = extractJson(resp.content || (resp.reasoningContent ?? ""))
    } catch (e) {
      lastIssues = ["output is not valid JSON"]
      const raw = resp.content || (resp.reasoningContent ?? "")
      console.log(`attempt ${attempt}: 输出无法解析为 JSON（content ${resp.content.length} 字符 / reasoning ${(resp.reasoningContent ?? "").length} 字符）: ${e instanceof Error ? e.message : e}`)
      console.log(`  tail: …${raw.slice(-300).replace(/\s+/g, " ")}`)
      // 推理失控诊断（已知模型 bug：答案落在 reasoning_content 而正文为空）——保存原文供人工/脚本 salvage
      if (resp.reasoningContent) {
        const dbgPath = `${args.out}.attempt${attempt}.reasoning.txt`
        await mkdir(dirname(args.out), { recursive: true })
        await writeFile(dbgPath, resp.reasoningContent, "utf-8")
        console.log(`  reasoning dump: ${dbgPath}`)
      }
      continue
    }
    let dropped: string[] = []
    try {
      const prepared = prepareCandidate(parsed, args, validCtx)
      plan = prepared.plan
      dropped = prepared.dropped
    } catch (e) {
      lastIssues = [`output is not valid GamePlanV1 JSON: ${e instanceof Error ? e.message : String(e)}`]
      console.log(`attempt ${attempt}: ${lastIssues[0]}`)
      continue
    }
    if (dropped.length > 0) {
      console.log(`auto-repair: 移除 ${dropped.length} 个死规则/条目`)
      for (const d of dropped) console.log(`  - ${d}`)
    }

    const validation = validateGamePlan(plan, validCtx)
    if (validation.ok) {
      await mkdir(dirname(args.out), { recursive: true })
      await writeFile(args.out, `${JSON.stringify(plan, null, 2)}\n`, "utf-8")
      console.log(`OK: plan written to ${args.out}`)
      console.log(`planId=${plan.planId} rules=${plan.rules?.length ?? 0} phases=${plan.phases?.length ?? 0} fallback=${plan.fallback?.policy}`)
      console.log(`predictions: winRate=${plan.predictions.winRateEstimate} rounds=${plan.predictions.expectedRounds} confidence=${plan.predictions.confidence}`)
      return
    }
    lastIssues = validation.issues.map((i) => `${i.path}: ${i.message}`)
    console.log(`attempt ${attempt}: ${validation.issues.length} 个校验问题`)
    for (const issue of validation.issues.slice(0, 10)) {
      console.log(`  ${issue.path}: ${issue.message}`)
    }
  }
  console.error("authoring failed: 校验未通过且修复次数用尽")
  process.exitCode = 1
}

await main()
