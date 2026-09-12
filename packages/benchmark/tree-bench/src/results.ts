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
 * 对局结果的数据模型与解析。
 *
 * 输入 JSON 格式(数组):
 *   [
 *     { "p1": "agent-a", "p2": "agent-b", "winner": "p1" | "p2" | "draw",
 *       "period": 0 },   // period 可选:同一期内的对局合并为一个 Glicko-2 rating period
 *     ...
 *   ]
 *
 * winner 也可写 "result": "win" | "loss" | "draw"(相对 p1)。
 */

export interface GameResult {
  /** 选手 1(对局输入侧,先手与否由外部决定,对称赛程下无影响) */
  p1: string
  p2: string
  /** 胜负:p1 / p2 / draw */
  winner: "p1" | "p2" | "draw"
  /** 可选:Glicko-2 rating period 分组号(缺省时全部视为同一期) */
  period?: number
}

export interface PairStats {
  a: string
  b: string
  games: number
  aWins: number
  bWins: number
  draws: number
  /** a 对 b 的胜率(平局计 0.5) */
  aWinRate: number
}

/** 解析并校验一条原始记录(JSON 反序列化后的任意值)。 */
export function parseGameResult(raw: unknown, index: number): GameResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`第 ${index} 条对局不是对象`)
  }
  const r = raw as Record<string, unknown>
  const p1 = r.p1
  const p2 = r.p2
  if (typeof p1 !== "string" || typeof p2 !== "string" || p1.length === 0 || p2.length === 0) {
    throw new Error(`第 ${index} 条对局缺少 p1/p2 字符串`)
  }
  if (p1 === p2) {
    throw new Error(`第 ${index} 条对局 p1 === p2(不允许自对局): ${p1}`)
  }
  let winner: GameResult["winner"]
  const w = r.winner
  const res = r.result
  if (w === "p1" || w === "p2" || w === "draw") {
    winner = w
  } else if (res === "win") {
    winner = "p1"
  } else if (res === "loss") {
    winner = "p2"
  } else if (res === "draw") {
    winner = "draw"
  } else {
    throw new Error(
      `第 ${index} 条对局 winner 非法: ${JSON.stringify(w)} ` +
        `(应为 "p1" | "p2" | "draw",或 result 为 "win" | "loss" | "draw")`,
    )
  }
  const period = r.period
  return {
    p1,
    p2,
    winner,
    ...(typeof period === "number" && Number.isFinite(period) ? { period } : {}),
  }
}

/** 按出现顺序收集去重后的选手 id 列表。 */
export function collectAgentIds(results: GameResult[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const g of results) {
    for (const id of [g.p1, g.p2]) {
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

/** 按无序对聚合统计(胜/负/平/对局数)。 */
export function collectPairs(results: GameResult[]): Map<string, PairStats> {
  const map = new Map<string, PairStats>()
  const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  for (const g of results) {
    const k = key(g.p1, g.p2)
    let s = map.get(k)
    if (!s) {
      s = { a: g.p1 < g.p2 ? g.p1 : g.p2, b: g.p1 < g.p2 ? g.p2 : g.p1, games: 0, aWins: 0, bWins: 0, draws: 0, aWinRate: 0.5 }
      map.set(k, s)
    }
    s.games += 1
    if (g.winner === "draw") {
      s.draws += 1
    } else if (g.winner === "p1") {
      if (g.p1 === s.a) s.aWins += 1
      else s.bWins += 1
    } else {
      if (g.p2 === s.a) s.aWins += 1
      else s.bWins += 1
    }
  }
  for (const s of map.values()) {
    s.aWinRate = (s.aWins + 0.5 * s.draws) / s.games
  }
  return map
}

/**
 * 构建胜率矩阵 A:A[i][j] = P(选手 i 胜 选手 j),对角线 0.5。
 * 平局按 0.5 折半计入;某对无对局时按 0.5 处理。
 */
export function buildWinProbMatrix(agentIds: string[], results: GameResult[]): number[][] {
  const n = agentIds.length
  const idx = new Map(agentIds.map((id, i) => [id, i]))
  const count: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const total: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (const g of results) {
    const i = idx.get(g.p1)
    const j = idx.get(g.p2)
    if (i === undefined || j === undefined) continue
    total[i][j] += 1
    total[j][i] += 1
    if (g.winner === "draw") {
      count[i][j] += 0.5
      count[j][i] += 0.5
    } else if (g.winner === "p1") {
      count[i][j] += 1
    } else {
      count[j][i] += 1
    }
  }
  const A: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0.5 : total[i][j] > 0 ? count[i][j] / total[i][j] : 0.5)),
  )
  return A
}

/** 每对选手的对局总数矩阵 counts[i][j](i≠j 时 = i 与 j 的对局数,对角线 0)。 */
export function buildPairCounts(agentIds: string[], results: GameResult[]): number[][] {
  const n = agentIds.length
  const idx = new Map(agentIds.map((id, i) => [id, i]))
  const counts: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (const g of results) {
    const i = idx.get(g.p1)
    const j = idx.get(g.p2)
    if (i === undefined || j === undefined) continue
    counts[i]![j]! += 1
    counts[j]![i]! += 1
  }
  return counts
}
