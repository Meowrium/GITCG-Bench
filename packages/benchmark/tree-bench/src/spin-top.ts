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
 * Spinning-top 结构诊断:传递/循环分解 + Nash averaging + 响应图聚类。
 *
 * 参考:
 * - Balduzzi et al. 2019, "Open-ended Learning in Symmetric Zero-sum Games" (ICML)
 *   https://arxiv.org/abs/1901.08106  —— 传递/循环分解定理与响应图
 * - Czarnecki et al. 2020, "Real World Games Look Like Spinning Tops" (NeurIPS)
 *   https://arxiv.org/abs/2004.09468  —— 现实博弈呈"陀螺"结构(底部循环团块 + 顶部传递尖塔)
 * - Bertrand et al. 2023, "On the Limitations of the Elo..." (ICML)
 *   https://arxiv.org/abs/2305.15234  —— 警示:有限样本会把噪声误判为循环,务必配合 bootstrap
 *
 * 核心定理(任意对称零和博弈唯一分解):
 *   skew(A) = A_trans + A_cyc
 *   A_trans[i][j] = v_i - v_j,  v_i = mean_j skew(A)[i][j]   (传递强度向量)
 *   A_cyc 为行和为零的循环分量
 * 传递占比 = ||A_trans||² / ||skew(A)||²。
 */

import type { GameResult } from "./results"
import { buildWinProbMatrix } from "./results"

/** 可复现的伪随机数生成器(mulberry32)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 斜对称部分:S = (A - Aᵀ)/2。去掉平局常数分量后,竞争结构全部在 S 里。 */
export function skewPart(A: number[][]): number[][] {
  const n = A.length
  return A.map((row, i) => row.map((v, j) => (v - A[j]![i]!) / 2))
}

export interface Decomposition {
  /** 传递强度向量 v_i = mean_j skew(A)[i][j] */
  strength: number[]
  /** 传递分量 A_trans[i][j] = v_i - v_j */
  trans: number[][]
  /** 循环分量 A_cyc = skew(A) - A_trans(行和为零) */
  cyc: number[][]
  /** 传递占比 = ||A_trans||² / ||skew(A)||² ∈ [0,1] */
  transitiveShare: number
  /** 循环占比 = 1 - transitiveShare */
  cyclicShare: number
}

/** 传递/循环分解(输入为胜率矩阵 A,内部取斜对称部分)。 */
export function decompose(A: number[][]): Decomposition {
  const n = A.length
  const S = skewPart(A)
  const strength = S.map((row) => row.reduce((s, v) => s + v, 0) / n)
  const trans = Array.from({ length: n }, (_, i) => strength.map((vj) => strength[i]! - vj))
  const cyc = S.map((row, i) => row.map((v, j) => v - trans[i]![j]!))
  const norm = (M: number[][]) => M.reduce((s, row) => s + row.reduce((t, v) => t + v * v, 0), 0)
  const nS = norm(S)
  const transitiveShare = nS === 0 ? 0 : norm(trans) / nS
  return {
    strength,
    trans,
    cyc,
    transitiveShare,
    cyclicShare: 1 - transitiveShare,
  }
}

export interface NashResult {
  /** 均衡混合策略 p*(对行玩家) */
  mixture: number[]
  /** Nash rating:每个选手面对均衡混合对手时的期望胜率 = (A @ p*)_i */
  ratings: number[]
  /** 博弈值:行混合对列混合的期望胜率(对称博弈下 ≈ 0.5) */
  value: number
}

/**
 * Nash averaging:fictitious play 迭代求解对称零和博弈的均衡。
 * 对 2 人零和博弈理论收敛;n ≤ 100、迭代 2e4 内足够稳定。
 */
export function nashAveraging(A: number[][], iterations = 20000): NashResult {
  const n = A.length
  const S = skewPart(A)
  const pCount = new Array<number>(n).fill(1)
  const qCount = new Array<number>(n).fill(1)

  for (let t = 0; t < iterations; t++) {
    const p = pCount.map((c) => c / (n + t))
    const q = qCount.map((c) => c / (n + t))
    // 行玩家对列混合 q 的最优应对:argmax_i (S @ q)_i
    let br = 0
    let best = -Infinity
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let j = 0; j < n; j++) s += S[i]![j]! * q[j]!
      if (s > best) {
        best = s
        br = i
      }
    }
    // 列玩家对行混合 p 的最优应对:argmin_j (p @ S)_j
    let bc = 0
    let worst = Infinity
    for (let j = 0; j < n; j++) {
      let s = 0
      for (let i = 0; i < n; i++) s += p[i]! * S[i]![j]!
      if (s < worst) {
        worst = s
        bc = j
      }
    }
    pCount[br]! += 1
    qCount[bc]! += 1
  }

  const tot = n + iterations
  const p = pCount.map((c) => c / tot)
  const q = qCount.map((c) => c / tot)
  const ratings = A.map((row) => row.reduce((s, v, j) => s + v * p[j]!, 0))
  const value = p.reduce((s, pi, i) => s + pi * A[i]!.reduce((t, v, j) => t + v * q[j]!, 0), 0)
  return { mixture: p, ratings, value }
}

export interface Cluster {
  /** 团块成员(按响应图 SCC) */
  members: string[]
  /** 成员平均传递强度 */
  meanStrength: number
  /** 是否循环团块(成员 > 1,内部存在克制环) */
  cyclic: boolean
  /** 按强度降序的序号 */
  rank: number
}

export interface ClusterOptions {
  /** 额外绝对余量:要求 A[i][j] > 0.5 + eps(默认 0) */
  eps?: number
  /** 每对选手的对局数矩阵 counts[i][j](可选)。传入后,边必须同时通过
   *  Wilson 95% 单侧检验(胜率显著 > 0.5),避免把有限样本噪声误判为克制环。 */
  counts?: number[][]
}

/** Wilson 95% 单侧置信区间下界:胜率 p(共 n 局)是否显著高于 0.5。 */
function wilsonLower(p: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96
  const z2 = z * z
  const center = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return center - half
}

/**
 * 响应图聚类:有向边 i→j 当且仅当 A[i][j] 显著大于 0.5
 * (无 counts 时退化为 A[i][j] > 0.5 + eps)。
 * 强连通分量(SCC, Tarjan)= 循环团块;SCC 之间的凝聚 DAG 是传递排序。
 */
export function responseGraphClusters(agentIds: string[], A: number[][], opts: ClusterOptions = {}): Cluster[] {
  const { eps = 0, counts } = opts
  const n = A.length
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const p = A[i]![j]!
      if (p <= 0.5 + eps) continue
      if (counts) {
        const g = counts[i]![j]!
        if (wilsonLower(p, g) <= 0.5) continue
      }
      adj[i]!.push(j)
    }
  }

  // Tarjan SCC
  let idx = 0
  const index = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const onStack = new Array<boolean>(n).fill(false)
  const stack: number[] = []
  const comps: number[][] = []

  const strongconnect = (v: number): void => {
    index[v] = idx
    low[v] = idx
    idx += 1
    stack.push(v)
    onStack[v] = true
    for (const w of adj[v]!) {
      if (index[w] === -1) {
        strongconnect(w)
        low[v] = Math.min(low[v]!, low[w]!)
      } else if (onStack[w]) {
        low[v] = Math.min(low[v]!, index[w]!)
      }
    }
    if (low[v] === index[v]) {
      const comp: number[] = []
      let w: number
      do {
        w = stack.pop()!
        onStack[w] = false
        comp.push(w)
      } while (w !== v)
      comps.push(comp)
    }
  }
  for (let v = 0; v < n; v++) {
    if (index[v] === -1) strongconnect(v)
  }

  // 每个 SCC 的平均传递强度,按降序排 rank
  const dec = decompose(A)
  return comps
    .map((comp) => ({
      members: comp.map((i) => agentIds[i]!).sort(),
      meanStrength: comp.reduce((s, i) => s + dec.strength[i]!, 0) / comp.length,
      cyclic: comp.length > 1,
    }))
    .sort((x, y) => y.meanStrength - x.meanStrength)
    .map((c, rank) => ({ ...c, rank }))
}

export interface SpinTopReport {
  agentIds: string[]
  winProbMatrix: number[][]
  decomposition: Decomposition
  nash: NashResult
  /** 响应图聚类,rank 0 = 最强团块 */
  clusters: Cluster[]
  /** 尖塔:从顶部开始连续的非循环(传递)团块成员;顶部就是循环团块时为空 */
  spire: string[]
  /** 循环团块(内部不可排序的选手集合) */
  cyclicClusters: string[][]
}

/** 汇总一次 spinning-top 诊断。 */
export function spinningTopReport(
  agentIds: string[],
  A: number[][],
  opts: ClusterOptions = {},
): SpinTopReport {
  const decomposition = decompose(A)
  const nash = nashAveraging(A)
  const clusters = responseGraphClusters(agentIds, A, opts)
  const spire: string[] = []
  for (const c of clusters) {
    if (c.cyclic) break
    spire.push(...c.members)
  }
  return {
    agentIds,
    winProbMatrix: A,
    decomposition,
    nash,
    clusters,
    spire,
    cyclicClusters: clusters.filter((c) => c.cyclic).map((c) => c.members),
  }
}

export interface BootstrapResult {
  /** 传递占比的 5%–95% 分位数区间 */
  transitiveShareCI: [number, number]
  /** 每个选手传递强度的 5%–95% 分位数区间 */
  strengthCI: number[][]
  samples: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * 按无序对分层重采样对局(bootstrap),估计传递占比与传递强度的置信区间。
 * 对局数少(如每对 5 局)时,分解结果被二项噪声主导,必须看这个区间。
 *
 * @param agentIds 选手顺序(必须与外部矩阵/报告一致,区间按此顺序返回)
 */
export function bootstrapSpinTop(
  results: GameResult[],
  agentIds: string[],
  samples = 200,
  seed = 123,
): BootstrapResult {
  const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  const groups = new Map<string, GameResult[]>()
  for (const g of results) {
    const k = key(g.p1, g.p2)
    let list = groups.get(k)
    if (!list) {
      list = []
      groups.set(k, list)
    }
    list.push(g)
  }

  const rng = mulberry32(seed)
  const shares: number[] = []
  const strengths: number[][] = []
  for (let s = 0; s < samples; s++) {
    const sample: GameResult[] = []
    for (const list of groups.values()) {
      const k = list.length
      for (let t = 0; t < k; t++) sample.push(list[Math.floor(rng() * k)]!)
    }
    const A = buildWinProbMatrix(agentIds, sample)
    const dec = decompose(A)
    shares.push(dec.transitiveShare)
    strengths.push(dec.strength)
  }
  shares.sort((a, b) => a - b)
  const n = agentIds.length
  const strengthCI: number[][] = []
  for (let i = 0; i < n; i++) {
    const col = strengths.map((s) => s[i]!).sort((a, b) => a - b)
    strengthCI.push([percentile(col, 0.05), percentile(col, 0.95)])
  }
  return {
    transitiveShareCI: [percentile(shares, 0.05), percentile(shares, 0.95)],
    strengthCI,
    samples,
  }
}
