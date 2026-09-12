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
 * BattleRecord 组装 CLI。
 *
 * 用法（在 packages/benchmark 下）：
 *   pnpm assemble-record --game-dir <dir> --who <0|1> [--out <path>] [...]
 *
 * 生成的文件 = <game-dir>/battle_record_p{who}.json（可用 --out 覆盖）。
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { assembleBattleRecord } from "../record/assemble"

const HELP = `assemble-record — 从对战日志组装 BattleRecord

必填:
  --game-dir <dir>   对战日志目录（含 p{who}_llm.jsonl；胜负兜底读 headless.log）
  --who <0|1>        被测侧（0 = player0，1 = player1）

可选:
  --out <path>             输出文件（默认 <game-dir>/battle_record_p{who}.json）
  --record-id <id>         记录 id（默认 <game-dir 名>_p{who}）
  --my-deck-code <code>    覆盖我的卡组码（默认从日志 get_player{0,1}_deck 提取）
  --opp-deck-code <code>   覆盖对手卡组码
  --data-version <ver>     游戏/数据版本（默认 "unknown"）
  --first-player <0|1>     先手（相对被测侧；日志无此信息，默认 null）
  --opponent-kind <kind>   对手策略 kind: mcts|giml|llm（默认 "llm"）
  --opponent-checkpoint <ck> 对手冻结标识（默认 "unknown"）
  --knowledge-ref <ref>    卡组知识文件引用（默认 = myDeckCode）
  --mutation-log-ref <ref> mutation 链引用（默认 <game-dir>/game_replay.json，
                           文件存在才填）
  -h, --help               显示本帮助`

interface ParsedArgs {
  help: boolean
  gameDir: string | null
  who: number | null
  out: string | null
  recordId: string | null
  myDeckCode: string | null
  oppDeckCode: string | null
  dataVersion: string | null
  firstPlayer: number | null
  opponentKind: string | null
  opponentCheckpoint: string | null
  knowledgeRef: string | null
  mutationLogRef: string | null
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: false,
    gameDir: null,
    who: null,
    out: null,
    recordId: null,
    myDeckCode: null,
    oppDeckCode: null,
    dataVersion: null,
    firstPlayer: null,
    opponentKind: null,
    opponentCheckpoint: null,
    knowledgeRef: null,
    mutationLogRef: null,
  }
  const take = (name: string, i: number): [string | null, number] => {
    const value = argv[i + 1] ?? null
    return [value, i + (value === null ? 0 : 1)]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--game-dir": {
        const [v, next] = take("--game-dir", i)
        args.gameDir = v
        i = next
        break
      }
      case "--who": {
        const [v, next] = take("--who", i)
        args.who = v === null ? null : Number(v)
        i = next
        break
      }
      case "--out": {
        const [v, next] = take("--out", i)
        args.out = v
        i = next
        break
      }
      case "--record-id": {
        const [v, next] = take("--record-id", i)
        args.recordId = v
        i = next
        break
      }
      case "--my-deck-code": {
        const [v, next] = take("--my-deck-code", i)
        args.myDeckCode = v
        i = next
        break
      }
      case "--opp-deck-code": {
        const [v, next] = take("--opp-deck-code", i)
        args.oppDeckCode = v
        i = next
        break
      }
      case "--data-version": {
        const [v, next] = take("--data-version", i)
        args.dataVersion = v
        i = next
        break
      }
      case "--first-player": {
        const [v, next] = take("--first-player", i)
        args.firstPlayer = v === null ? null : Number(v)
        i = next
        break
      }
      case "--opponent-kind": {
        const [v, next] = take("--opponent-kind", i)
        args.opponentKind = v
        i = next
        break
      }
      case "--opponent-checkpoint": {
        const [v, next] = take("--opponent-checkpoint", i)
        args.opponentCheckpoint = v
        i = next
        break
      }
      case "--knowledge-ref": {
        const [v, next] = take("--knowledge-ref", i)
        args.knowledgeRef = v
        i = next
        break
      }
      case "--mutation-log-ref": {
        const [v, next] = take("--mutation-log-ref", i)
        args.mutationLogRef = v
        i = next
        break
      }
      default:
        break
    }
  }
  return args
}

function fail(msg: string): never {
  console.error(`assemble-record: ${msg}`)
  process.exit(1)
}

function main(): void {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  if (args.help) {
    console.log(HELP)
    return
  }
  if (!args.gameDir) {
    fail("缺少必填参数 --game-dir <dir>")
  }
  if (args.who !== 0 && args.who !== 1) {
    fail("--who 必须为 0 或 1")
  }
  if (args.firstPlayer !== null && args.firstPlayer !== 0 && args.firstPlayer !== 1) {
    fail("--first-player 必须为 0 或 1")
  }
  if (
    args.opponentKind !== null &&
    args.opponentKind !== "mcts" &&
    args.opponentKind !== "giml" &&
    args.opponentKind !== "llm"
  ) {
    fail("--opponent-kind 必须为 mcts | giml | llm")
  }

  const who = args.who as 0 | 1
  const options: Parameters<typeof assembleBattleRecord>[0] = {
    gameDir: args.gameDir,
    who,
    ...(args.recordId !== null ? { recordId: args.recordId } : {}),
    ...(args.myDeckCode !== null ? { myDeckCode: args.myDeckCode } : {}),
    ...(args.oppDeckCode !== null ? { oppDeckCode: args.oppDeckCode } : {}),
    ...(args.dataVersion !== null ? { dataVersion: args.dataVersion } : {}),
    ...(args.firstPlayer !== null ? { firstPlayer: args.firstPlayer as 0 | 1 } : {}),
    ...(args.opponentKind !== null || args.opponentCheckpoint !== null
      ? {
          opponentPolicy: {
            kind: (args.opponentKind ?? "llm") as "mcts" | "giml" | "llm",
            checkpoint: args.opponentCheckpoint ?? "unknown",
          },
        }
      : {}),
    ...(args.knowledgeRef !== null ? { knowledgeRef: args.knowledgeRef } : {}),
    ...(args.mutationLogRef !== null ? { mutationLogRef: args.mutationLogRef } : {}),
  }

  const record = assembleBattleRecord(options)
  const out = args.out ?? join(args.gameDir, `battle_record_p${who}.json`)
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, "utf-8")

  console.log(`recordId: ${record.recordId}`)
  console.log(
    `decisions: ${record.decisions.length} (winner=${record.result.winner}, ` +
      `totalRounds=${record.result.totalRounds ?? "null"})`,
  )
  console.log(`myDeckCode: ${record.myDeckCode ?? "null"}`)
  console.log(`written: ${out}`)
}

try {
  main()
} catch (err) {
  console.error(`assemble-record: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
