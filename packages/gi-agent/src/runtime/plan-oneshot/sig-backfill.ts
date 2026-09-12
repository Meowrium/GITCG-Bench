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
 * sig-backfill — lean trace 的签名回填（决策 trace 签名指针化，impl-spec-1 件 1）。
 *
 * lean 模式（PlanBatchConfig.traceSignatures="lean"）下 trace 条目不带整份
 * stateSignature，只带 16 hex 短哈希（trace.ts sigHashOf）。本模块在消费侧
 * （evidence-extract / modules / plan-replay / eval-game / organize-export）把
 * 整份签名从**同局** game_state_log.json 反查回来：
 *
 * 1. 对 state log 每个暂停点重算玩家视角签名 `planStateSignature(exposeState(side, state))`
 *    ——与 full 模式 trace 内嵌签名同源同口径（与 eval-game.ts loadAlignedGameInput
 *    的对齐基准一致），再取短哈希建 hash → 签名串 索引；
 * 2. 逐条目按 sigHash 匹配（同哈希的重复暂停点按序 FIFO 消费，与 loadAlignedGameInput
 *    的同名队列语义一致），就地填回 `entry.stateSignature`（只改内存对象，不改盘）。
 *
 * 语义等价性：回填产出的签名串与 full 模式内嵌签名逐字节相等（同一确定性对局的
 * 同一决策点、同一 exposeState 口径），故下游（compactStateDigest / 静态回放语料 /
 * eval 对齐）行为与 full 模式一致。信息纪律：state log 虽是全局视角，但消费的只有
 * `exposeState(side, …)` 脱敏结果——与 full 模式 trace 携带的玩家视角签名信息等价，
 * 无对手视角增量信息。
 *
 * 安全性：full / 旧格式 trace（无 lean 指针）恒零开销——不读 state log、不碰对象；
 * state log 缺失或个别条目哈希无匹配 → 该条目保持无签名并计入 missed，消费方按
 * "(无 state)"降级，与旧格式一致。
 *
 * 已知覆盖边界（对齐口径先例）：全部 **action** 决策点可反查（引擎 pause/notify
 * 边界差异 <10%）；opening 类的部分条目（rerollDice / 回合中触发 chooseActive）
 * 的决策中间态**本就不在 state log 快照里**（roll 暂停点先于掷骰 mutation、技能
 * 结算路径 notifyAndPause 不落新快照），full 模式的 eval 对齐（loadAlignedGameInput
 * 只对齐 action 条目）同样不覆盖这些点——这些条目回填 missed 属预期，非回归。
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CURRENT_VERSION, deserializeGameStateLog, exposeState } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { planStateSignature } from "./fields.js"
import { sigHashOf } from "./trace.js"
import type { PlanTraceFile } from "./trace.js"

export interface SigBackfillResult {
  /** 尝试回填的 lean 条目数（0 = 非 lean trace，未做任何事） */
  attempted: number
  /** 成功回填的条目数 */
  restored: number
  /** 无匹配（或 state log 缺失/不可解析）的条目数 */
  missed: number
}

/** 判定 trace 是否为 lean 形态（存在 sigHash 指针且该条目无内嵌签名） */
export function isLeanTrace(trace: PlanTraceFile): boolean {
  return trace.entries.some((e) => e.sigHash !== undefined && e.stateSignature === undefined)
}

/**
 * 单局目录的回填索引缓存（key = `${absDir}::${side}`）：harness 模式下
 * decision_detail / fallback_report 等模块会对同一 game 目录反复读 trace，
 * 缓存避免每次重读重放 state log。只缓存**本 trace 需要的哈希**（按需取数，
 * 防多局缓存撑爆内存）；容量钳制 8（FIFO 淘汰）。
 */
const backfillCache = new Map<string, Map<string, string>>()
const BACKFILL_CACHE_MAX = 8

async function loadSigIndex(gameDir: string, side: 0 | 1, needed: Set<string>): Promise<Map<string, string>> {
  const cacheKey = `${resolve(gameDir)}::${side}`
  const cached = backfillCache.get(cacheKey)
  if (cached) return cached
  const raw = JSON.parse(await readFile(joinLog(gameDir), "utf-8")) as { gv?: string }
  const stateLog = deserializeGameStateLog(
    getData((raw.gv ?? CURRENT_VERSION) as Parameters<typeof getData>[0]),
    raw as Parameters<typeof deserializeGameStateLog>[1],
  )
  const index = new Map<string, string>()
  for (const entry of stateLog) {
    // 不按 canResume 过滤：非 action 决策点（switchHands/selectCard 等）的暂停
    // 以 canResume=false 落盘（core 在 mulligan/技能结算路径 notifyAndPause() 无参），
    // 决策点签名匹配靠哈希相等自证——同哈希 ⇒ 同签名内容。
    const sig = planStateSignature(exposeState(side, entry.state))
    const hash = sigHashOf(sig)
    // 只留需要的哈希（同哈希重复暂停点签名等价，任取其一）
    if (needed.has(hash) && !index.has(hash)) index.set(hash, sig)
  }
  if (backfillCache.size >= BACKFILL_CACHE_MAX) {
    const oldest = backfillCache.keys().next().value
    if (oldest !== undefined) backfillCache.delete(oldest)
  }
  backfillCache.set(cacheKey, index)
  return index
}

function joinLog(gameDir: string): string {
  return `${resolve(gameDir)}/game_state_log.json`
}

/**
 * 就地回填 lean trace 的 stateSignature（full / 旧格式恒 no-op，不读盘）。
 * 任何读取/解析失败都按全部 missed 处理（不抛错）——回填是证据质量的增强，
 * 不应让消费主流程崩溃。
 */
export async function backfillTraceSignatures(gameDir: string, trace: PlanTraceFile): Promise<SigBackfillResult> {
  const leanEntries = trace.entries.filter((e) => e.sigHash !== undefined && e.stateSignature === undefined)
  if (leanEntries.length === 0) {
    return { attempted: 0, restored: 0, missed: 0 }
  }
  const needed = new Set(leanEntries.map((e) => e.sigHash!))
  let index: Map<string, string>
  try {
    index = await loadSigIndex(gameDir, trace.side, needed)
  } catch {
    return { attempted: leanEntries.length, restored: 0, missed: leanEntries.length }
  }
  let restored = 0
  let missed = 0
  for (const e of leanEntries) {
    const sig = index.get(e.sigHash!)
    if (sig === undefined) {
      missed++
      continue
    }
    e.stateSignature = sig
    restored++
  }
  return { attempted: leanEntries.length, restored, missed }
}
