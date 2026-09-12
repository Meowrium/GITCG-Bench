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
 * results-connectivity — tree-bench results 的「已交手图」连通性预检（纯函数）。
 *
 * 动机（2026-09-07 赛程缺口 §G5）：Glicko-2 不校验池连通性——断连分量各自按自己的
 * 对局结算，分量之间分数不可比；heatmap 对无对局格填 0.5、spin-top 自动缩稠密子块，
 * 都不显式暴露「池裂成了几块」。本模块把 results（`[{p1,p2,winner,period?}]`）建成
 * 无向「已交手图」（边 = 一对选手打过至少一局，胜负与手数无关），给出连通分量与摘要，
 * 供 analyze 在调 tree-bench 前打 WARNING（只告警不阻断）。
 *
 * period 语义与 tree-bench 一致：缺省 0；逐 period 的当期图 = 只含该期对局的子图
 * （tree-bench 每期用当期对局做一次 rating period 更新，故期内连通性才是「该期更新
 * 是否可比」的判据）。
 */

/** 对局行（tree-bench results 的输入结构子集；winner 不参与图构造） */
export interface ConnectivityGame {
  p1: string
  p2: string
  winner?: string
  period?: number
}

export interface PlayerGraph {
  /** 连通分量：分量内选手 id 升序，分量间按首元素升序 */
  components: string[][]
  componentCount: number
  /** 孤立选手（无任何对手边；自对局 p1===p2 或仅出现在单元素分量里的选手） */
  isolatedPlayers: string[]
  /** 已交手的不同无序对局对数（与 tree-bench coverage 的 pairsPlayed 同口径） */
  pairsPlayed: number
  /** 池内可能对数 C(n,2)（n = 图中选手数） */
  pairsTotal: number
}

/** 单期图（period 语义与 tree-bench 一致：缺省 0） */
export interface PeriodPlayerGraph extends PlayerGraph {
  period: number
}

/** 无序对键（与 tree-bench collectPairs 同约定：字典序小者在前） */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** 建无向已交手图并求连通分量（BFS；零依赖、确定性输出顺序） */
export function buildPlayerGraph(games: readonly ConnectivityGame[]): PlayerGraph {
  const adjacency = new Map<string, Set<string>>()
  const pairs = new Set<string>()
  const addNode = (id: string): void => {
    if (!adjacency.has(id)) adjacency.set(id, new Set())
  }
  for (const g of games) {
    addNode(g.p1)
    addNode(g.p2)
    if (g.p1 === g.p2) continue // 自对局：节点入图但不产生对手边
    adjacency.get(g.p1)!.add(g.p2)
    adjacency.get(g.p2)!.add(g.p1)
    pairs.add(pairKey(g.p1, g.p2))
  }
  const seen = new Set<string>()
  const components: string[][] = []
  for (const id of [...adjacency.keys()].sort()) {
    if (seen.has(id)) continue
    const comp: string[] = []
    const queue: string[] = [id]
    seen.add(id)
    while (queue.length > 0) {
      const cur = queue.shift()!
      comp.push(cur)
      for (const next of adjacency.get(cur)!) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    comp.sort()
    components.push(comp)
  }
  const n = adjacency.size
  return {
    components,
    componentCount: components.length,
    isolatedPlayers: components.filter((c) => c.length === 1).map((c) => c[0]!),
    pairsPlayed: pairs.size,
    pairsTotal: n < 2 ? 0 : (n * (n - 1)) / 2,
  }
}

/** 按 rating period 分组求图（period 升序；缺省 period = 0，与 tree-bench 一致） */
export function buildPlayerGraphsByPeriod(games: readonly ConnectivityGame[]): PeriodPlayerGraph[] {
  const byPeriod = new Map<number, ConnectivityGame[]>()
  for (const g of games) {
    const p = g.period ?? 0
    let list = byPeriod.get(p)
    if (!list) {
      list = []
      byPeriod.set(p, list)
    }
    list.push(g)
  }
  return [...byPeriod.keys()]
    .sort((a, b) => a - b)
    .map((period) => ({ period, ...buildPlayerGraph(byPeriod.get(period)!) }))
}

/** 分量 → 单行文本（analyze WARNING 用）：`{a, b, c}` */
export function formatComponents(components: readonly string[][]): string {
  return components.map((c) => `{${c.join(", ")}}`).join("  ")
}
