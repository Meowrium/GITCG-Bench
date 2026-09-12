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
 * BattleRecord 组装器（DESIGN.md §7.1）。
 *
 * 输入：gi-agent 对战日志目录，含 `p{who}_llm.jsonl`（llm_response / tool_result /
 * final_result 三类行）与可选的 `headless.log`（胜负兜底）。
 *
 * 日志行结构（已验证样本）：
 *   - llm_response: { ts, type, request_id, content, tool_calls: [{id, name, arguments}],
 *                     finish_reason, usage: {total_tokens}, elapsed_ms }
 *   - tool_result:  { ts, type, tool, result }（tool = 被调用的工具名，
 *                   与最近的 llm_response 中的 tool_call 按 FIFO 配对）
 *   - final_result: { ts, type, round, game_result: { winner, ... } }
 *
 * 配对语义：llm_response 先入队其全部 tool_call，后续 tool_result 逐个消费
 * （FIFO，与 gi-agent 实际写入顺序一致；首条 llm_response 可能携带 2 个
 * tool_call，此时先出现 2 条 tool_result 再轮到下一条 llm_response）。
 */

import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { GiTcgError } from "@gi-tcg/core"

export class AssembleError extends GiTcgError {}

export type DecisionKind =
  | "choose_action"
  | "switch_hands"
  | "choose_active"
  | "reroll_dice"
  | "elemental_tuning"
  | "select_card"

export const DECISION_KIND_BY_TOOL: Record<string, DecisionKind> = {
  choose_action: "choose_action",
  switch_hands: "switch_hands",
  choose_active: "choose_active",
  reroll_dice: "reroll_dice",
  elemental_tuning: "elemental_tuning",
  select_card: "select_card",
}

/**
 * 结构型 TurnDigestV1 —— 与 gi-agent 的 turn digest 字段对齐；
 * benchmark 包不依赖 gi-agent / mcp，仅按结构消费快照。
 */
export interface TurnDigestV1 {
  version: string
  digest_ref: string
  session_id: string
  round: number
  turn: number
  pending_method: string
  strategic_profile_ref: string
  self_summary: Record<string, unknown>
  opponent_summary: Record<string, unknown>
  resource_summary: Record<string, unknown>
  candidate_actions: Array<Record<string, unknown>>
  hard_constraints: string[]
  character_definitions: Record<string, unknown>
  card_definitions: Record<string, unknown>
  generated_at: string
  [key: string]: unknown
}

/** 单次 LLM 决策（一次工具调用）的审计记录。 */
export interface DecisionRecord {
  /** 决策发生时最近一次 digest 的回合号；无 digest 时为 null。 */
  round: number | null
  /** digest_<seq>，按 digest 出现顺序编号；无 digest 时为 null。 */
  digestRef: string | null
  decisionKind: DecisionKind
  /** 原始 tool_call 对象（含 id/name/arguments 字符串）。 */
  rawRequest: unknown
  /** 决策上下文 = 最近一次 digest 的完整解析快照；无 digest 时为 null。 */
  digestSnapshot: unknown
  /** 工具返回（已尝试 JSON 解析，失败保留原始字符串）。 */
  chosenAction: unknown
  latencyMs: number | null
  tokenUsage: number | null
  /** 预留：后续接入一致性校验（如 digest 上下文复用检测）。 */
  auditFlags: string[]
}

export interface BattleRecord {
  recordId: string
  /** v0.5 默认不填 —— 日志不记录随机种子；runner 侧具备时由 CLI 传入。 */
  seed?: { randomSeed: number; shuffleSeed: number }
  /** 先手（相对被测侧）；日志无此信息，默认 null。 */
  firstPlayer: 0 | 1 | null
  myDeckCode: string | null
  oppDeckCode: string | null
  dataVersion: string
  opponentPolicy: { kind: "mcts" | "giml" | "llm"; checkpoint: string }
  /** LLMDeckKnowledge 文件引用；默认 = myDeckCode。 */
  knowledgeRef: string | null
  decisions: DecisionRecord[]
  /** 与决策对齐的 mutation 链引用；目录中无 game_state_log.json / game_replay.json 时为 null。 */
  mutationLogRef: string | null
  result: { winner: "me" | "opponent"; totalRounds: number | null }
}

export interface AssembleOptions {
  gameDir: string
  who: 0 | 1
  recordId?: string
  myDeckCode?: string
  oppDeckCode?: string
  dataVersion?: string
  firstPlayer?: 0 | 1
  opponentPolicy?: { kind: "mcts" | "giml" | "llm"; checkpoint: string }
  knowledgeRef?: string
  mutationLogRef?: string
}

interface PendingCall {
  toolCall: Record<string, unknown>
  response: Record<string, unknown>
}

/** 尝试 JSON 解析；非字符串或解析失败时原样返回。 */
function tryParseJson(text: unknown): unknown {
  if (typeof text !== "string") {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 从 headless.log 兜底提取胜负（"Game over! Winner: Player <n>"）。 */
function winnerFromHeadlessLog(gameDir: string): "me" | "opponent" | null {
  const logPath = join(gameDir, "headless.log")
  if (!existsSync(logPath)) {
    return null
  }
  const text = readFileSync(logPath, "utf-8")
  const match = /Game over! Winner: Player (\d+)/.exec(text)
  if (!match) {
    return null
  }
  const player = Number(match[1])
  if (!Number.isInteger(player)) {
    return null
  }
  return player === 0 ? "me" : "opponent"
}

export function assembleBattleRecord(options: AssembleOptions): BattleRecord {
  const { gameDir, who } = options

  const logPath = join(gameDir, `p${who}_llm.jsonl`)
  if (!existsSync(logPath)) {
    throw new AssembleError(`找不到对战日志: ${logPath}`)
  }
  const raw = readFileSync(logPath, "utf-8")

  const pendingCalls: PendingCall[] = []
  let digestSeq = 0
  let latestDigest: { seq: number; snapshot: unknown; round: number | null } | null = null
  let lastDigestRound: number | null = null
  const decisions: DecisionRecord[] = []
  let myDeckCode: string | null = options.myDeckCode ?? null
  let oppDeckCode: string | null = options.oppDeckCode ?? null
  let finalResult: Record<string, unknown> | null = null

  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue
    }
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(row)
    if (!record || typeof record.type !== "string") {
      continue
    }

    if (record.type === "llm_response") {
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const call = asRecord(tc)
          if (call && typeof call.name === "string") {
            pendingCalls.push({ toolCall: call, response: record })
          }
        }
      }
      continue
    }

    if (record.type === "tool_result" || record.type === "harness_tool_call") {
      // harness_tool_call：开局阶段等 harness 侧工具调用（llm-agent 现行版本）。
      // 它不与任何 llm_response tool_call 配对——绝不能消耗 pendingCalls，
      // 否则会错位后续 LLM 决策的 FIFO 配对。
      const isHarness = record.type === "harness_tool_call"
      const call = isHarness ? null : (pendingCalls.shift() ?? null)
      const toolName = call ? String(call.toolCall.name) : String(record.tool ?? "")
      // 名称不一致视为日志顺序异常，跳过该行（真实数据不触发）。
      if (call && toolName !== String(record.tool ?? "")) {
        continue
      }

      if (toolName === "get_turn_digest_v1") {
        const parsed = tryParseJson(record.result)
        const digest = asRecord(asRecord(parsed)?.digest)
        const round = asNumber(digest?.round)
        digestSeq += 1
        latestDigest = { seq: digestSeq, snapshot: parsed, round }
        if (round !== null) {
          lastDigestRound = round
        }
        continue
      }

      if (toolName === "get_player0_deck" || toolName === "get_player1_deck") {
        const parsed = asRecord(tryParseJson(record.result))
        const deckWho = typeof parsed?.who === "number" ? parsed.who : (toolName.endsWith("0") ? 0 : 1)
        const code = typeof parsed?.deck_code === "string" ? parsed.deck_code : null
        if (code !== null) {
          if (deckWho === who) {
            myDeckCode ??= code
          } else {
            oppDeckCode ??= code
          }
        }
        continue
      }

      const kind = DECISION_KIND_BY_TOOL[toolName]
      if (kind) {
        const usage = asRecord(call?.response.usage)
        decisions.push({
          round: latestDigest?.round ?? null,
          digestRef: latestDigest ? `digest_${latestDigest.seq}` : null,
          decisionKind: kind,
          // harness 侧决策没有 LLM tool_call 原文（LLM 答案在前一条 llm_response
          // 的 content 里，由 harness 解析后提交），用 {harness, tool, args} 代替；
          // 它同样是引擎实际收到的请求，满足 Tier 1 非法动作审计口径。
          rawRequest: isHarness
            ? { harness: true, tool: toolName, args: record.args ?? {} }
            : (call?.toolCall ?? null),
          digestSnapshot: latestDigest?.snapshot ?? null,
          chosenAction: tryParseJson(record.result),
          latencyMs: isHarness
            ? asNumber(record.elapsed_ms)
            : (call && typeof call.response.elapsed_ms === "number" ? call.response.elapsed_ms : null),
          tokenUsage: isHarness
            ? null
            : (typeof usage?.total_tokens === "number" ? usage.total_tokens : null),
          auditFlags: [],
        })
      }
      continue
    }

    if (record.type === "final_result") {
      finalResult = record
    }
  }

  // 卡组 code 兜底：现行 llm-agent 的开局阶段由 harness 自动拉取卡组（不经 LLM），
  // 日志中可能没有 get_player{who}_deck 的 tool_result——此时从 game_replay.json
  // 的 meta（deck0Code/deck1Code 为槽位 code）按 who 映射补齐。
  if ((myDeckCode === null || oppDeckCode === null)) {
    const replayPath = join(gameDir, "game_replay.json")
    if (existsSync(replayPath)) {
      try {
        const replay = asRecord(JSON.parse(readFileSync(replayPath, "utf-8")))
        const meta = asRecord(replay?.meta) ?? replay
        const slot0 = typeof meta?.deck0Code === "string" ? meta.deck0Code : null
        const slot1 = typeof meta?.deck1Code === "string" ? meta.deck1Code : null
        myDeckCode ??= who === 0 ? slot0 : slot1
        oppDeckCode ??= who === 0 ? slot1 : slot0
      } catch {
        // 保留 null——replay 缺失或损坏时不阻断组装
      }
    }
  }

  const gameResult = asRecord(finalResult?.game_result)
  let winner: "me" | "opponent"
  const rawWinner = asNumber(gameResult?.winner)
  if (rawWinner !== null) {
    winner = rawWinner === who ? "me" : "opponent"
  } else {
    const fallback = winnerFromHeadlessLog(gameDir)
    if (fallback !== null) {
      winner = fallback
    } else {
      throw new AssembleError(
        `无法从 ${logPath} 或 ${join(gameDir, "headless.log")} 确定胜负（winner 字段缺失）`,
      )
    }
  }

  return {
    recordId: options.recordId ?? `${basename(gameDir)}_p${who}`,
    firstPlayer: options.firstPlayer ?? null,
    myDeckCode,
    oppDeckCode,
    dataVersion: options.dataVersion ?? "unknown",
    opponentPolicy: options.opponentPolicy ?? { kind: "llm", checkpoint: "unknown" },
    knowledgeRef: options.knowledgeRef ?? myDeckCode,
    decisions,
    mutationLogRef:
      options.mutationLogRef ??
      // 2026-08-20 起真正的 seed+mutation log 落在 game_state_log.json；
      // 旧局只有 game_replay.json（无 seed/mutation，仅作兜底）。
      (existsSync(join(gameDir, "game_state_log.json"))
        ? join(gameDir, "game_state_log.json")
        : existsSync(join(gameDir, "game_replay.json"))
          ? join(gameDir, "game_replay.json")
          : null),
    // totalRounds 优先取 final_result.round（对局权威总回合数）；
    // 日志缺失 final_result 时才回退到最后一次 digest 的 round。
    result: { winner, totalRounds: asNumber(finalResult?.round) ?? lastDigestRound },
  }
}
