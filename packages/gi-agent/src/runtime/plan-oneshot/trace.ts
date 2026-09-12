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
 * plan_trace.json — 计划执行日志（设计文档 §4）。
 * 与 game_state_log.json 并列落盘；stateLogIndex 的对齐由 oracle 回算侧
 * 按 (round, turn, seq) 顺序完成，执行期不填。
 */

import { createHash } from "node:crypto"
import type { Version } from "@gi-tcg/core"
import { formatRuleKey, type RuleLayer } from "./rule-key.js"

/**
 * lean 模式（traceSignatures="lean"）的签名指针算法：整份 stateSignature 的
 * sha256 前 16 hex（64 位）。同 seed 确定性对局下签名内容唯一，碰撞概率可忽略；
 * 反查（sig-backfill.ts）按 state log 暂停点重算签名后以同算法匹配。
 */
export const SIG_HASH_ALGO = "sha256-16hex" as const

/** 整份 stateSignature → 16 hex 短哈希（lean trace 的指针形态） */
export function sigHashOf(sig: string): string {
  return createHash("sha256").update(sig, "utf-8").digest("hex").slice(0, 16)
}

export interface PlanTraceEntry {
  seq: number
  round: number
  turn: number
  method: "action" | "chooseActive" | "switchHands" | "rerollDice" | "selectCard"
  /** 预留：与 game_state_log 暂停点下标的对齐位，执行期恒为 null */
  stateLogIndex: number | null
  /** 决策时刻本玩家视角 state 的 JSON 签名；oracle 侧用 exposeState(side, state) 重算匹配。
   *  lean 模式（traceSignatures="lean"）下省略，改由 sigHash 承载指针。 */
  stateSignature?: string
  /**
   * lean 模式专用：整份 stateSignature 的短哈希（SIG_HASH_ALGO）。
   * 消费侧经 sig-backfill.ts 从同局 game_state_log.json 按签名反查回填；
   * full / 旧格式条目恒无此字段（默认路径逐字节不变）。
   */
  sigHash?: string
  phaseId: string | null
  candidateCount: number
  matchedRule: {
    scope: "phase" | "global" | "opening"
    priority: number
    reason: string
    /**
     * 两层组合模式的层标注（D4）：缺省 = 旧单树模式，汇总键不带层前缀；
     * layer === "single" 时 layerLabel 必设（manifest singles[].label）。
     * 旧 trace 无此字段，消费侧按可选处理（缺省 = 旧行为）。
     */
    layer?: RuleLayer
    layerLabel?: string
  } | null
  fallbackUsed: boolean
  fallbackPolicy?: string
  chosen: {
    actionCase: string
    skillDefId?: number
    cardDefId?: number
    targetDefId?: number
    previewDamage?: number
  } | null
  /**
   * 决策时刻的 opp.threat.* 派生读数（threat.ts，上界/概率口径）。
   * 仅 method === "action" 的条目可能携带；求值失败或无数据时整个省略
   * （对旧 trace 纯增量，消费侧按可选处理）。用途：让反思证据（fullDigest）
   * 能把 blunder 点与"当时对手威胁读数"关联。
   */
  threat?: {
    maxDamage?: number
    lethal?: boolean
    lethalP?: number
    burstReady?: boolean
    burstP?: number
    maxDamageAfterSwitch?: number
  }
  /** 执行期异常等非致命事件 */
  notes: string[]
  /**
   * 本次决策中被扫描到的"when 全真但 then 零命中"的规则键
   * （如 ["global:30","phase:burst:20"]）。与 matchedRule 互补：
   * perRuleHits=0 且 thenMiss 高 = 条件写对了但动作映射错（死规则）。
   */
  thenMiss?: string[]
}

export interface PlanTraceSummary {
  result: "win" | "loss" | "draw" | "unfinished"
  rounds: number
  decisionCounts: { total: number; ruleMatched: number; fallback: number }
  /** ruleMatched / total；方法级细分见 perMethod */
  coverage: number
  perMethod: Record<string, { total: number; ruleMatched: number; fallback: number }>
  /** "global:3" / "phase:burst:1" → 命中次数 */
  perRuleHits: Record<string, number>
  /** "global:3" → when 全真但 then 零命中的次数（死规则探针） */
  perRuleThenMiss: Record<string, number>
}

export interface PlanTraceFile {
  version: "PlanTraceV1"
  planId: string
  parentPlanId: string | null
  seed: number | null
  deckCodes: [string, string] | null
  side: 0 | 1
  opponentPolicy: string
  /** 两层组合模式的本 run 路由形态（batch-runner 注入）；缺省 = 旧单树 */
  routing?: "general-only" | `single:${string}`
  /** 组合模式的 portfolio 内容哈希（computePortfolioId） */
  portfolioId?: string
  /** 对局实际使用的数据版本（batch-runner 注入，与 state log gv 一致；对旧 trace 纯增量） */
  gameVersion?: Version
  /** lean 签名模式标记：省略 = full / 旧格式（内嵌整份签名） */
  traceSignatures?: "lean"
  /** lean 模式的指针算法（与 SIG_HASH_ALGO 一致；仅在 traceSignatures="lean" 时携带） */
  sigHashAlgo?: typeof SIG_HASH_ALGO
  entries: PlanTraceEntry[]
  summary: PlanTraceSummary
}

export interface PlanTraceMeta {
  planId: string
  parentPlanId: string | null
  side: 0 | 1
  opponentPolicy: string
  seed?: number | null
  deckCodes?: [string, string] | null
  /** 两层组合模式的本 run 路由形态；缺省 = 旧单树（trace 文件不写该字段） */
  routing?: "general-only" | `single:${string}`
  portfolioId?: string
  gameVersion?: Version
  /** "lean" = 条目不内嵌整份签名（sigHash 指针）；缺省 = full（逐字节不变） */
  traceSignatures?: "full" | "lean"
}

export class PlanTraceCollector {
  private seq = 0
  private readonly entries: PlanTraceEntry[] = []

  constructor(private readonly meta: PlanTraceMeta) {}

  add(entry: Omit<PlanTraceEntry, "seq" | "stateLogIndex" | "notes" | "thenMiss"> & { notes?: string[]; thenMiss?: string[] }): void {
    this.entries.push({
      seq: this.seq++,
      stateLogIndex: null,
      notes: entry.notes ?? [],
      thenMiss: entry.thenMiss ?? [],
      ...entry,
    })
  }

  get size(): number {
    return this.entries.length
  }

  finalize(result: PlanTraceSummary["result"], rounds: number): PlanTraceFile {
    const perMethod: Record<string, { total: number; ruleMatched: number; fallback: number }> = {}
    const perRuleHits: Record<string, number> = {}
    const perRuleThenMiss: Record<string, number> = {}
    let ruleMatched = 0
    let fallback = 0
    for (const e of this.entries) {
      const bucket = (perMethod[e.method] ??= { total: 0, ruleMatched: 0, fallback: 0 })
      bucket.total++
      if (e.matchedRule) {
        ruleMatched++
        bucket.ruleMatched++
        // 阶段规则键含 phaseId，避免跨阶段同 priority 碰撞（与反思 ruleRef 格式一致）；
        // 组合模式条目带 layer 时键带层前缀（拼键统一走 rule-key.ts，旧格式逐字节不变）
        const key = formatRuleKey({
          scope: e.matchedRule.scope,
          priority: e.matchedRule.priority,
          phaseId: e.phaseId,
          layer: e.matchedRule.layer,
          layerLabel: e.matchedRule.layerLabel,
        })
        perRuleHits[key] = (perRuleHits[key] ?? 0) + 1
      }
      for (const key of e.thenMiss ?? []) {
        perRuleThenMiss[key] = (perRuleThenMiss[key] ?? 0) + 1
      }
      if (e.fallbackUsed) {
        fallback++
        bucket.fallback++
      }
    }
    const total = this.entries.length
    return {
      version: "PlanTraceV1",
      planId: this.meta.planId,
      parentPlanId: this.meta.parentPlanId,
      seed: this.meta.seed ?? null,
      deckCodes: this.meta.deckCodes ?? null,
      side: this.meta.side,
      opponentPolicy: this.meta.opponentPolicy,
      // 组合模式路由元信息（旧单树模式缺省，JSON 落盘不携带）
      ...(this.meta.routing !== undefined ? { routing: this.meta.routing } : {}),
      ...(this.meta.portfolioId !== undefined ? { portfolioId: this.meta.portfolioId } : {}),
      ...(this.meta.gameVersion !== undefined ? { gameVersion: this.meta.gameVersion } : {}),
      // lean 签名模式（锦标赛产物瘦身）：缺省 full 不落任何新字段（旧格式逐字节不变）
      ...(this.meta.traceSignatures === "lean" ? { traceSignatures: "lean" as const, sigHashAlgo: SIG_HASH_ALGO } : {}),
      entries: this.entries,
      summary: {
        result,
        rounds,
        decisionCounts: { total, ruleMatched, fallback },
        coverage: total > 0 ? ruleMatched / total : 0,
        perMethod,
        perRuleHits,
        perRuleThenMiss,
      },
    }
  }
}
