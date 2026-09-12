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
 * 局面级证据提取：从 run 目录的 trace + eval 产物中抽出
 * ① 高 blunder 决策点（oracle 认为明显更优，附局面 digest 与推荐动作）
 * ② fallback 局面（无规则命中、兜底执行 declareEnd 的决策点）
 * 供反思 prompt 做局面级诊断（而非只看聚合统计）。
 *
 * evidence = "engine-only"（2026-08-30 无 oracle 自进化臂）：一切 eval 读取
 * 短路——blunder 段消失、全量摘要行降级为引擎侧列（digest + 命中规则 +
 * 计划选择 + threat 读数 + thenMiss/fallback 标记），另产出斩杀威胁点
 * （opp.threat.lethal=true，无 oracle 时防御归因的唯一定量抓手）。
 */

import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { auraNameOf, ELEMENT_NAMES } from "../fields.js"
import { backfillTraceSignatures } from "../sig-backfill.js"
import { formatRuleKey } from "../rule-key.js"
import type { PlanTraceFile, PlanTraceEntry } from "../trace.js"

/** 规则键重建（拼键统一走 rule-key.ts；组合模式条目带层前缀，旧格式逐字节不变） */
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

/** 证据口径：oracle（默认，读 eval 回算）/ engine-only（只读引擎侧 trace） */
export type EvidenceMode = "oracle" | "engine-only"

/**
 * 泄漏通道断言：列出 run 目录（含 game-* 子目录）内全部 oracle 回算产物
 * （plan_eval*.json / plan_eval_summary*.json）。engine-only 臂启动时调用，
 * 返回非空即 fail-fast——不允许依赖"文件恰好不存在"的隐式卫生。
 */
export async function findOracleArtifacts(runDir: string): Promise<string[]> {
  const isEval = (name: string) => name.startsWith("plan_eval") && name.endsWith(".json")
  const hits: string[] = []
  let entries
  try {
    entries = await readdir(runDir, { withFileTypes: true })
  } catch {
    return hits
  }
  for (const e of entries) {
    if (e.isFile() && isEval(e.name)) hits.push(join(runDir, e.name))
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("game-")) continue
    try {
      for (const f of await readdir(join(runDir, e.name))) {
        if (isEval(f)) hits.push(join(runDir, e.name, f))
      }
    } catch { /* 子目录不可读跳过 */ }
  }
  return hits.sort()
}

interface EvalPoint {
  seq: number
  round: number
  visitGap: number | null
  isBlunder: boolean
  isDivergence?: boolean
  alignmentMiss?: boolean
  oracleBest: string
  chosen: PlanTraceEntry["chosen"]
  matchedRule: string | null
}

interface EvalFile {
  points?: EvalPoint[]
}

interface EvidenceOptions {
  maxBlunders?: number
  maxFallbacks?: number
  maxPerGame?: number
  /** engine-only 斩杀威胁点（opp.threat.lethal=true）行数上限（默认 8） */
  maxThreats?: number
  /** oracle 回算产物后缀（如 "nn" → plan_eval.nn.json）；缺省读 ISMCTS 口径 */
  evalSuffix?: string
  /** engine-only：eval 读取整体短路，只产引擎侧证据（默认 oracle） */
  evidence?: EvidenceMode
  /** 交叉对手合并时的组名：行首 game 名前加 "label/" 前缀（单目录不设） */
  label?: string
}

interface PbCharLite {
  id: number
  definitionId: number
  health: number
  maxHealth: number
  energy: number
  maxEnergy: number
  aura: number
  defeated: boolean
}

interface PbStateLite {
  roundNumber: number
  currentTurn: number
  player: Array<{
    activeCharacterId?: number
    character: PbCharLite[]
    dice: number[]
    handCard: { definitionId: number }[]
    summon: unknown[]
    support: unknown[]
    combatStatus: unknown[]
    pileCard: unknown[]
    initiativeSkill: unknown[]
    declaredEnd?: boolean
    legendUsed?: boolean
  }>
}

function nameOf(defId: number | undefined): string {
  if (defId === undefined) return "?"
  return DEFAULT_ASSETS_MANAGER.getNameSync(defId) ?? String(defId)
}

function charLite(p: PbStateLite["player"][number]): PbCharLite | undefined {
  return p.character.find((c) => c.id === p.activeCharacterId)
}

/** DiceType 1..7 对应元素中文名（与 fields.ts ELEMENT_NAMES 下标对齐：1=cryo…7=dendro） */
const ELEMENT_CN: Record<string, string> = {
  cryo: "冰", hydro: "水", pyro: "火", electro: "雷", anemo: "风", geo: "岩", dendro: "草",
}

/** 骰子色面统计：只聚合元素色与万能，点数信息是决策可行动性的核心（技能费按元素色计） */
function diceColorSummary(dice: number[] | undefined): string {
  if (!dice || dice.length === 0) return "0"
  const counts = new Map<string, number>()
  let omni = 0
  for (const d of dice) {
    if (d === 8) { omni++; continue }
    const el = ELEMENT_NAMES[d - 1]
    if (el) counts.set(el, (counts.get(el) ?? 0) + 1)
  }
  const colors = ELEMENT_NAMES.filter((el) => counts.has(el))
    .map((el) => `${ELEMENT_CN[el]}${counts.get(el)}`)
    .join("")
  return `${colors || "无元素"}${omni > 0 ? `+万${omni}` : ""}/共${dice.length}`
}

/** 非出战存活角色 → "香菱(E0/3) 重云(E0/2)"（阵亡由存活数表达，不重复列出） */
function benchChars(p: PbStateLite["player"][number]): string {
  return p.character
    .filter((c) => c.id !== p.activeCharacterId && !c.defeated)
    .map((c) => `${nameOf(c.definitionId)}(E${c.energy}/${c.maxEnergy})`)
    .join(" ")
}

/** 召唤/支援/战斗状态实体 → "烟绯,香菱"（单类上限 4 个名字，超出省略计数；空返回空串） */
function entityList(items: unknown[] | undefined, label: string): string {
  if (!items || items.length === 0) return ""
  const names = items
    .slice(0, 4)
    .map((x) => nameOf((x as { definitionId?: number }).definitionId))
    .join(",")
  return `${label}[${names}${items.length > 4 ? `…共${items.length}` : ""}]`
}

/**
 * 决策时刻玩家视角 state → 单行紧凑 digest。
 * 信息口径（2026-09 修订）：可行动性（骰色）、节奏（非出战角色充能）、
 * 公开信息（对手手牌数）、持续收益/状态（召唤/支援/战斗状态，非空才追加）。
 * 仍剪裁：双方手牌内容（我方数量、对手物理不可见）、牌堆、骰点以外的细节。
 */
export function compactStateDigest(sigJson: string, side: 0 | 1): string {
  try {
    const s = JSON.parse(sigJson) as PbStateLite
    const me = s.player[side]
    const opp = s.player[side === 0 ? 1 : 0]
    const myActive = me ? charLite(me) : undefined
    const oppActive = opp ? charLite(opp) : undefined
    const myAlive = me?.character.filter((c) => !c.defeated).length ?? "?"
    const oppAlive = opp?.character.filter((c) => !c.defeated).length ?? "?"
    const fmt = (c: PbCharLite | undefined) =>
      c ? `${nameOf(c.definitionId)}(${c.definitionId}) HP${c.health}/${c.maxHealth} E${c.energy}/${c.maxEnergy}` : "?"
    const aura = oppActive ? auraNameOf(oppActive.aura) : "?"
    const parts = [
      `round${s.roundNumber}`,
      `我方出战 ${fmt(myActive)}${me ? ` ${benchChars(me)}` : ""}`.trim(),
      `对手出战 ${fmt(oppActive)} aura=${aura}${opp ? ` ${benchChars(opp)}` : ""}`.trim(),
      `骰[${diceColorSummary(me?.dice)}]`,
      `手牌 ${me?.handCard.length ?? "?"}`,
      `对手手牌 ${opp?.handCard.length ?? "?"}`,
      `存活 ${myAlive}v${oppAlive}`,
    ]
    if (me) {
      const extra = [
        entityList(me.summon, "召唤"),
        entityList(me.support, "支援"),
        entityList(me.combatStatus, "状态"),
        entityList(opp?.summon, "敌召唤"),
        entityList(opp?.support, "敌支援"),
        entityList(opp?.combatStatus, "敌状态"),
      ].filter(Boolean).join(" ")
      if (extra) parts.push(extra)
    }
    return parts.join(" | ")
  } catch {
    return "(state 解析失败)"
  }
}

export function formatChosen(chosen: PlanTraceEntry["chosen"]): string {
  if (!chosen) return "(无)"
  switch (chosen.actionCase) {
    case "useSkill": return `useSkill ${nameOf(chosen.skillDefId)}${chosen.previewDamage ? `(预览伤害${chosen.previewDamage})` : ""}`
    case "playCard": return `playCard ${nameOf(chosen.cardDefId)}`
    case "switchActive": return `switchActive → ${nameOf(chosen.targetDefId)}`
    default: return chosen.actionCase
  }
}

/**
 * trace 条目的 opp.threat 读数 → 紧凑串（无数据返回空串，旧 trace 行为不变）。
 * 口径见 threat.ts 头注释：上界（maxDamage/lethal）/概率估计（burstP/lethalP）而非精确值。
 * lethalP（2026-08-31 新语汇）：概率化致死，主防御触发信号（§10.6）。
 */
export function formatThreat(threat: PlanTraceEntry["threat"]): string {
  if (!threat) return ""
  const parts: string[] = []
  if (threat.maxDamage !== undefined) parts.push(`dmg${threat.maxDamage}`)
  if (threat.lethal) parts.push("斩杀!")
  if (threat.lethalP !== undefined) parts.push(`斩杀P${threat.lethalP}`)
  if (threat.burstReady) parts.push("爆发就绪")
  if (threat.burstP !== undefined) parts.push(`爆发P${threat.burstP}`)
  if (threat.maxDamageAfterSwitch !== undefined) parts.push(`切后dmg${threat.maxDamageAfterSwitch}`)
  return parts.length > 0 ? ` | 威胁:${parts.join("/")}` : ""
}

export function formatOracleBest(oracleBest: string): string {
  try {
    const o = JSON.parse(oracleBest) as { actionCase: string; skillDefId?: number; cardDefId?: number; targetDefId?: number }
    switch (o.actionCase) {
      case "useSkill": return `useSkill ${nameOf(o.skillDefId)}`
      case "playCard": return `playCard ${nameOf(o.cardDefId)}`
      case "switchActive": return `switchActive → ${nameOf(o.targetDefId)}`
      default: return o.actionCase
    }
  } catch {
    return oracleBest
  }
}

/** 从 run 目录提取局面级证据（按侧读文件）。engine-only 模式下 blunderLines 恒为空，
 *  另产 threatLines（斩杀威胁点，引擎派生）；label 用于多对手组合并时的行前缀。 */
export async function extractDecisionEvidence(
  runDir: string,
  side: 0 | 1,
  opts?: EvidenceOptions,
): Promise<{ blunderLines: string[]; fallbackLines: string[]; threatLines: string[] }> {
  const traceName = side === 0 ? "plan_trace.json" : "plan_trace.side1.json"
  const engineOnly = opts?.evidence === "engine-only"
  const evalSuffix = opts?.evalSuffix ? `.${opts.evalSuffix}` : ""
  const evalName = side === 0 ? `plan_eval${evalSuffix}.json` : `plan_eval${evalSuffix}.side1.json`
  const maxBlunders = opts?.maxBlunders ?? 8
  const maxFallbacks = opts?.maxFallbacks ?? 8
  const maxThreats = opts?.maxThreats ?? 8
  const maxPerGame = opts?.maxPerGame ?? 3
  const tag = (g: string) => (opts?.label ? `${opts.label}/${g}` : g)

  const gameDirs = (await readdir(runDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    .map((e) => e.name)
    .sort()

  const blunderCandidates: Array<{ gap: number; line: string }> = []
  const fallbackLines: string[] = []
  const threatLines: string[] = []
  let fallbackBudget = maxFallbacks
  let threatBudget = maxThreats

  for (const g of gameDirs) {
    const dir = join(runDir, g)
    let trace: PlanTraceFile
    try {
      trace = JSON.parse(await readFile(join(dir, traceName), "utf-8")) as PlanTraceFile
    } catch {
      continue
    }
    // lean trace：从同局 state log 反查回填签名（full / 旧格式恒 no-op）
    await backfillTraceSignatures(dir, trace)
    const entryBySeq = new Map(trace.entries.map((e) => [e.seq, e]))

    // ① 高 blunder 决策点（engine-only 模式不读 eval——泄漏通道短路）
    let evalFile: EvalFile | null = null
    if (!engineOnly) {
      try {
        evalFile = JSON.parse(await readFile(join(dir, evalName), "utf-8")) as EvalFile
      } catch {
        evalFile = null
      }
    }
    if (evalFile?.points) {
      const perGame = evalFile.points
        .filter((p) => p.isBlunder)
        .sort((a, b) => (b.visitGap ?? 0) - (a.visitGap ?? 0))
        .slice(0, maxPerGame)
      for (const p of perGame) {
        const entry = entryBySeq.get(p.seq)
        const digest = entry?.stateSignature ? compactStateDigest(entry.stateSignature, side) : "(无 state)"
        const rule = p.matchedRule ?? "<fallback>"
        blunderCandidates.push({
          gap: p.visitGap ?? 0,
          line: `[${tag(g)} seq${p.seq}] ${digest} | 命中规则 ${rule} | 计划选择 ${formatChosen(p.chosen)} | oracle 推荐 ${formatOracleBest(p.oracleBest)} | visitGap=${p.visitGap?.toFixed(2) ?? "?"}`,
        })
      }
    }

    // ② fallback 局面
    if (fallbackBudget > 0) {
      const fbs = trace.entries
        .filter((e) => e.method === "action" && e.fallbackUsed)
        .slice(0, maxPerGame)
      for (const e of fbs) {
        const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
        const policy = e.fallbackPolicy ? `（${e.fallbackPolicy}）` : ""
        fallbackLines.push(`[${tag(g)} seq${e.seq}] ${digest} | 兜底执行${policy} ${formatChosen(e.chosen)}`)
        fallbackBudget--
        if (fallbackBudget <= 0) break
      }
    }

    // ③ 斩杀威胁点（engine-only：无 oracle 时防御归因的唯一定量抓手，round23 §10）
    // lethal=上界/安全网，lethalP=概率/主防御触发（§10.6：建议阈值 ≥0.5）
    if (engineOnly && threatBudget > 0) {
      const ths = trace.entries
        .filter((e) => e.method === "action" && (e.threat?.lethal === true || (e.threat?.lethalP ?? 0) >= 0.5))
        .slice(0, maxPerGame)
      for (const e of ths) {
        const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
        const rule = ruleKeyOf(e) ?? "<fallback>"
        threatLines.push(`[${tag(g)} seq${e.seq} t${e.turn}] ${digest} | 命中规则 ${rule} | 计划选择 ${formatChosen(e.chosen)}${formatThreat(e.threat)}`)
        threatBudget--
        if (threatBudget <= 0) break
      }
    }
  }

  blunderCandidates.sort((a, b) => b.gap - a.gap)
  return {
    blunderLines: blunderCandidates.slice(0, maxBlunders).map((c) => c.line),
    fallbackLines,
    threatLines,
  }
}

export interface FullDigestResult {
  lines: string[]
  totalPoints: number
  blunders: number
  divergences: number
  fallbacks: number
  /** when 全真但 then 零命中的决策点数（两口径都统计；engine-only 的主要信号） */
  thenMissPoints: number
  /** declareEnd 决策数（龟缩化代际监控，round3 护栏） */
  declareEnds: number
  /** 因行数上限被省略的"与 oracle 一致"决策点数（✗/~ 行永远全量保留） */
  omittedAligned: number
}

/**
 * 全量决策点摘要：trace 里每个 action 决策点一行（含 oracle 对照，如有回算）。
 * 与 extractDecisionEvidence 的 top-N 抽样互补——全量流水让 LLM 能发现
 * "同一条规则反复失误但每次 visitGap 不大"的模式（按 gap 排序的 top-N 会漏掉）。
 * 行数超上限时均匀抽样省略 ✓（与 oracle 一致且非分歧）的行，✗/~ 行全量保留。
 * engine-only 模式：不读 eval，行降级为引擎侧列（digest + 命中规则 + 计划选择 +
 * threat 读数 + thenMiss/fallback 标记）；省略策略改为只保护 thenMiss/fallback 行。
 */
export async function extractFullDigest(
  runDir: string,
  side: 0 | 1,
  opts?: { maxLines?: number; evalSuffix?: string; evidence?: EvidenceMode; label?: string },
): Promise<FullDigestResult> {
  const traceName = side === 0 ? "plan_trace.json" : "plan_trace.side1.json"
  const engineOnly = opts?.evidence === "engine-only"
  const evalSuffix = opts?.evalSuffix ? `.${opts.evalSuffix}` : ""
  const evalName = side === 0 ? `plan_eval${evalSuffix}.json` : `plan_eval${evalSuffix}.side1.json`
  const maxLines = opts?.maxLines ?? 420
  const tag = (g: string) => (opts?.label ? `${opts.label}/${g}` : g)

  const gameDirs = (await readdir(runDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    .map((e) => e.name)
    .sort()

  const rows: Array<{ aligned: boolean; line: string }> = []
  let totalPoints = 0, blunders = 0, divergences = 0, fallbacks = 0, thenMissPoints = 0, declareEnds = 0

  for (const g of gameDirs) {
    const dir = join(runDir, g)
    let trace: PlanTraceFile
    try {
      trace = JSON.parse(await readFile(join(dir, traceName), "utf-8")) as PlanTraceFile
    } catch {
      continue
    }
    // lean trace：从同局 state log 反查回填签名（full / 旧格式恒 no-op）
    await backfillTraceSignatures(dir, trace)
    let evalBySeq: Map<number, EvalPoint> | null = null
    if (!engineOnly) {
      try {
        const ev = JSON.parse(await readFile(join(dir, evalName), "utf-8")) as EvalFile
        if (ev.points) evalBySeq = new Map(ev.points.map((p) => [p.seq, p]))
      } catch {
        // 未跑 oracle：行里不含 oracle 对照
      }
    }

    for (const e of trace.entries) {
      if (e.method !== "action") continue
      totalPoints++
      const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
      const rule = ruleKeyOf(e) ?? "<fallback>"
      if (e.fallbackUsed) fallbacks++
      const thenMiss = e.thenMiss ?? []
      if (thenMiss.length > 0) thenMissPoints++
      if (e.chosen?.actionCase === "declareEnd") declareEnds++
      let line = `[${tag(g)} seq${e.seq} t${e.turn}] ${digest} | ${rule} | 选 ${formatChosen(e.chosen)}${formatThreat(e.threat)}`
      let aligned = true
      if (engineOnly) {
        // 引擎侧降级行：fallback 档 + thenMiss 标记（这两类行是主要信号，省略时保护）
        if (e.fallbackUsed) line += ` | <fallback:${e.fallbackPolicy ?? "?"}>`
        if (thenMiss.length > 0) line += ` | thenMiss:${thenMiss.join("+")}`
        aligned = !e.fallbackUsed && thenMiss.length === 0
      } else {
        const p = evalBySeq?.get(e.seq)
        if (p) {
          if (p.isBlunder) blunders++
          if (p.isDivergence) divergences++
          if (p.alignmentMiss) {
            line += " | oracle 对不齐（已排除）"
          } else {
            const gap = p.visitGap != null ? ` gap=${p.visitGap.toFixed(2)}` : ""
            const marker = p.isBlunder ? " ✗" : p.isDivergence ? " ~" : " ✓"
            line += ` | oracle ${formatOracleBest(p.oracleBest)}${gap}${marker}`
            aligned = !p.isBlunder && !p.isDivergence
          }
        }
      }
      rows.push({ aligned, line })
    }
  }

  let omittedAligned = 0
  let lines: string[]
  if (rows.length > maxLines) {
    const alignedIdx = rows.map((r, i) => (r.aligned ? i : -1)).filter((i) => i >= 0)
    const room = Math.max(0, maxLines - (rows.length - alignedIdx.length))
    const keepAligned = new Set<number>()
    const take = Math.min(room, alignedIdx.length)
    if (take > 0) {
      const stride = alignedIdx.length / take
      for (let k = 0; k < take; k++) keepAligned.add(alignedIdx[Math.floor(k * stride)])
    }
    omittedAligned = alignedIdx.length - keepAligned.size
    lines = rows.filter((r, i) => !r.aligned || keepAligned.has(i)).map((r) => r.line)
  } else {
    lines = rows.map((r) => r.line)
  }
  return { lines, totalPoints, blunders, divergences, fallbacks, thenMissPoints, declareEnds, omittedAligned }
}
