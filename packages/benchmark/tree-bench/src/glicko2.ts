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
 * 纯 Glicko-2 评分算法实现。
 *
 * 参考:Glickman, M.E. (2012). Example of the Glicko-2 system.
 *   http://www.glicko.net/glicko/glicko2.pdf
 *
 * 与官方规范一致的关键参数:SCALE=173.7178、TAU=0.5、EPSILON=1e-6,
 * 初始 µ=1500、φ=350、σ=0.06(与 PTCG-Bench / Glickman 示例相同)。
 *
 * rating period 语义:同一期内所有对局都使用期初快照的对手评分计算,
 * 期内的更新互不级联。见 {@link applyRatingPeriod}。
 */

import type { GameResult } from "./results"

export interface GlickoPlayer {
  /** rating(展示尺度)µ */
  mu: number
  /** rating deviation(展示尺度)φ */
  phi: number
  /** volatility σ */
  sigma: number
}

export const GLICKO_DEFAULTS: Readonly<GlickoPlayer> = Object.freeze({
  mu: 1500,
  phi: 350,
  sigma: 0.06,
})

export type GlickoScore = 1 | 0 | 0.5

export interface GlickoMatch {
  opponent: GlickoPlayer
  /** 1 = 胜, 0 = 负, 0.5 = 平 */
  score: GlickoScore
}

export class Glicko2System {
  /** 系统常数:控制 volatility 变化速度 */
  static readonly TAU = 0.5
  /** 展示尺度与内部尺度的换算因子 */
  static readonly SCALE = 173.7178
  /** Illinois 算法的收敛阈值 */
  static readonly EPSILON = 1e-6

  private static toInternal(mu: number, phi: number): [number, number] {
    return [(mu - 1500) / Glicko2System.SCALE, phi / Glicko2System.SCALE]
  }

  private static toDisplay(muPrime: number, phiPrime: number): [number, number] {
    return [muPrime * Glicko2System.SCALE + 1500, phiPrime * Glicko2System.SCALE]
  }

  /** g(φ):高 RD 对手的权重折减 */
  private static g(phi: number): number {
    return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
  }

  /** 期望得分 E(µ, µ_j, φ_j) */
  private static E(mu: number, muJ: number, phiJ: number): number {
    return 1 / (1 + Math.exp(-Glicko2System.g(phiJ) * (mu - muJ)))
  }

  /**
   * 对一名选手应用一个 rating period 的更新。
   *
   * @param player 选手期初状态(会被读取,不修改)
   * @param results 本期对局列表:(对手期初状态, 得分)
   * @returns 更新后的选手状态
   */
  static update(player: GlickoPlayer, results: GlickoMatch[]): GlickoPlayer {
    const [mu, phi] = Glicko2System.toInternal(player.mu, player.phi)
    const sigma = player.sigma

    if (results.length === 0) {
      // 无对局:仅做 RD 膨胀(第 6 步的简化形式)
      const phiStar = Math.sqrt(phi * phi + sigma * sigma)
      const [nm, np] = Glicko2System.toDisplay(mu, phiStar)
      return { mu: nm, phi: np, sigma }
    }

    // 预计算每个对手的 g_j、E_j
    const opps = results.map(({ opponent, score }) => {
      const [muJ, phiJ] = Glicko2System.toInternal(opponent.mu, opponent.phi)
      return { gJ: Glicko2System.g(phiJ), EJ: Glicko2System.E(mu, muJ, phiJ), score }
    })

    // 第 3 步:v(估计方差)
    const v = 1 / opps.reduce((s, o) => s + o.gJ * o.gJ * o.EJ * (1 - o.EJ), 0)
    // 第 4 步:Δ(估计改进量)
    const delta = v * opps.reduce((s, o) => s + o.gJ * (o.score - o.EJ), 0)
    // 第 5 步:新 volatility(Illinois 迭代求根)
    const sigmaNew = Glicko2System.computeSigma(sigma, phi, v, delta)
    // 第 6 步:期初 RD 膨胀 φ*
    const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew)
    // 第 7 步:新 φ'
    const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
    // 第 8 步:新 µ'
    const muNew = mu + phiNew * phiNew * opps.reduce((s, o) => s + o.gJ * (o.score - o.EJ), 0)
    // 第 9 步:换算回展示尺度
    const [nm, np] = Glicko2System.toDisplay(muNew, phiNew)
    return { mu: nm, phi: np, sigma: sigmaNew }
  }

  /** 第 5 步:用 Illinois 算法求新 volatility(与 Glickman 官方 Java 实现逐行对应)。 */
  private static computeSigma(sigma: number, phi: number, v: number, delta: number): number {
    const tau = Glicko2System.TAU
    const a = Math.log(sigma * sigma)

    const f = (x: number): number => {
      const ex = Math.exp(x)
      const d2 = phi * phi + v + ex
      return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d2 * d2) - (x - a) / (tau * tau)
    }

    let A = a
    let B: number
    if (delta * delta > phi * phi + v) {
      B = Math.log(delta * delta - phi * phi - v)
    } else {
      let k = 1
      while (f(a - k * tau) < 0) {
        k += 1
      }
      B = a - k * tau
    }

    let fA = f(A)
    let fB = f(B)

    while (Math.abs(B - A) > Glicko2System.EPSILON) {
      const C = A + ((A - B) * fA) / (fB - fA)
      const fC = f(C)
      if (fC * fB < 0) {
        A = B
        fA = fB
      } else {
        fA /= 2
      }
      B = C
      fB = fC
    }
    return Math.exp(A / 2)
  }
}

/** 榜单上的一名选手:评分 + 胜/负/平计数。 */
export interface RatedAgent {
  id: string
  player: GlickoPlayer
  wins: number
  losses: number
  draws: number
}

export function newRatedAgent(id: string): RatedAgent {
  return { id, player: { ...GLICKO_DEFAULTS }, wins: 0, losses: 0, draws: 0 }
}

function pushMatch(map: Map<string, GlickoMatch[]>, id: string, m: GlickoMatch): void {
  let list = map.get(id)
  if (!list) {
    list = []
    map.set(id, list)
  }
  list.push(m)
}

/**
 * 应用一个 Glicko-2 rating period:期初快照所有选手评分,期内全部对局
 * 基于快照计算,再统一更新。缺席选手仅做 RD 膨胀。同时累计 W/L/D。
 */
export function applyRatingPeriod(agents: Map<string, RatedAgent>, games: GameResult[]): void {
  for (const g of games) {
    if (!agents.has(g.p1)) agents.set(g.p1, newRatedAgent(g.p1))
    if (!agents.has(g.p2)) agents.set(g.p2, newRatedAgent(g.p2))
  }

  // 期初快照(更新互不级联的关键)
  const snap = new Map<string, GlickoPlayer>()
  for (const [id, a] of agents) snap.set(id, a.player)

  const matches = new Map<string, GlickoMatch[]>()
  for (const g of games) {
    const p1 = snap.get(g.p1)
    const p2 = snap.get(g.p2)
    if (!p1 || !p2) continue
    const a1 = agents.get(g.p1)
    const a2 = agents.get(g.p2)
    if (!a1 || !a2) continue
    if (g.winner === "draw") {
      pushMatch(matches, g.p1, { opponent: p2, score: 0.5 })
      pushMatch(matches, g.p2, { opponent: p1, score: 0.5 })
      a1.draws += 1
      a2.draws += 1
    } else if (g.winner === "p1") {
      pushMatch(matches, g.p1, { opponent: p2, score: 1 })
      pushMatch(matches, g.p2, { opponent: p1, score: 0 })
      a1.wins += 1
      a2.losses += 1
    } else {
      pushMatch(matches, g.p2, { opponent: p1, score: 1 })
      pushMatch(matches, g.p1, { opponent: p2, score: 0 })
      a2.wins += 1
      a1.losses += 1
    }
  }

  for (const [id, agent] of agents) {
    const snap0 = snap.get(id)
    if (!snap0) continue
    agent.player = Glicko2System.update(snap0, matches.get(id) ?? [])
  }
}

/** 按 µ 降序返回榜单。 */
export function rankedAgents(agents: Map<string, RatedAgent>): RatedAgent[] {
  return [...agents.values()].sort((x, y) => y.player.mu - x.player.mu)
}
