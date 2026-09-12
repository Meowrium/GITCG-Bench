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
 * tournament-schedule — battle 赛程枚举（纯函数；WP1 赛程扩展，2026-09-08 赛程缺口修复）。
 *
 * 赛程维度（config.schedule 缺省 = 现行赛程，逐字段与旧 model-tournament 内联循环等价）：
 * - 同代跨模型全矩阵：每代 r、每有序模型对 X≠Y、每有序格对 (di,dj)（含 di=dj 镜像格与
 *   双向交叉）——现行；
 * - 同模型链批：每代 r≥1、每 k=1..chainGap、每 (di,dj)，X@r vs X@(r-k)（isChain=true）
 *   ——k=1 现行，k≥2 由 schedule.chainGap>1 追加（隔代链，弥合 G6）；
 * - 跨模型跨代：schedule.crossGeneration="vs-previous" 时每代 r≥1、每有序模型对 X≠Y、
 *   每 s<r、每 (di,dj)，X@r vs Y@s（isChain=false）——仅新代打旧代的有界切片，不是
 *   r×s 全方阵（弥合 G1；全方阵随代次平方膨胀，无必要）。
 *
 * 顺序契约（默认输出必须与旧内联循环逐元素一致）：
 *   env 外层 → 代 r 升序 → [同代矩阵 → 同模型链 k=1 → 隔代链 k=2..chainGap → 跨模型跨代]
 * 追加维度一律排在现行维度之后，故缺省/显式缺省时输出是旧输出的原样前缀+同序。
 *
 * 本模块零依赖（不读 config/文件系统），供 model-tournament 与离线单测直接调用。
 */

/** 单个 battle 批的赛程坐标（与 model-tournament / tournament-scheduler 的批结构逐字段一致） */
export interface BatchSpec {
  round: number
  envLabel: string
  planModel: string
  planRound: number
  di: number
  oppModel: string
  oppRound: number
  dj: number
  /** 同模型跨代链批（state log 恒全量） */
  isChain: boolean
}

/** 赛程开关（tournament.json 的 schedule 键；缺省 = 现行赛程） */
export interface TournamentSchedule {
  /**
   * 跨模型跨代切片（缺省 "none"）："vs-previous" 追加 X@r vs Y@s（X≠Y，s<r）全格对批。
   * 注意：`r` 是计划侧代数，故只出「新代打旧代」方向；反向（旧代打新代）由 r' 更大的
   * 代次覆盖，无需重复枚举。
   */
  crossGeneration?: "none" | "vs-previous"
  /**
   * 同模型链的代差上限（缺省 1 = 仅相邻代）：k=2..chainGap 追加 X@r vs X@(r-k) 全格对批。
   * 缺省 1 时输出与现行赛程逐元素一致。
   */
  chainGap?: number
}

/** 单个环境的赛程入参（只用到标签与卡组数——赛程枚举不需要牌表内容） */
export interface ScheduleEnv {
  label: string
  /** 卡组数 D（格对为 D²，含 di=dj 镜像格） */
  deckCount: number
}

export interface ScheduleInput {
  /** 模型名（选手 id 前缀 `<model>@r<n>`） */
  models: readonly string[]
  envs: readonly ScheduleEnv[]
  /** 代数上限（含；与 config.rounds 同语义：枚举 r=0..rounds） */
  rounds: number
  /** 只枚举该代（与 config --round 同语义）；缺省全代 */
  roundFilter?: number
  schedule?: TournamentSchedule
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

/**
 * 赛程枚举（纯函数）。默认（无 schedule / 全缺省）与旧 model-tournament.enumerateBatches
 * 输出逐元素一致：同代矩阵按 X→Y→di→dj，链批按 X→di→dj（k=1）。
 */
export function enumerateSchedule(input: ScheduleInput): BatchSpec[] {
  const crossGeneration = input.schedule?.crossGeneration ?? "none"
  const chainGap = Math.max(1, input.schedule?.chainGap ?? 1)
  const specs: BatchSpec[] = []
  const rounds = input.roundFilter !== undefined ? [input.roundFilter] : range(0, input.rounds)
  for (const env of input.envs) {
    const D = env.deckCount
    for (const r of rounds) {
      // 同代跨模型批（含 r0；双向交叉：有序模型对 × 有序格对，含 di=dj 镜像格）
      for (const X of input.models) {
        for (const Y of input.models) {
          if (X === Y) continue // 同模型同代对局不排入赛程
          for (let di = 0; di < D; di++) {
            for (let dj = 0; dj < D; dj++) {
              specs.push({
                round: r, envLabel: env.label,
                planModel: X, planRound: r, di,
                oppModel: Y, oppRound: r, dj,
                isChain: false,
              })
            }
          }
        }
      }
      // 同模型链批（r ≥ 1）：X@r 持 di vs X@(r-k) 持 dj（k=1 相邻代；k≥2 隔代链）
      if (r >= 1) {
        for (const X of input.models) {
          for (let k = 1; k <= chainGap; k++) {
            if (r - k < 0) break
            for (let di = 0; di < D; di++) {
              for (let dj = 0; dj < D; dj++) {
                specs.push({
                  round: r, envLabel: env.label,
                  planModel: X, planRound: r, di,
                  oppModel: X, oppRound: r - k, dj,
                  isChain: true,
                })
              }
            }
          }
        }
      }
      // 跨模型跨代（vs-previous）：X@r vs Y@s（X≠Y，s<r）——只排新代打旧代
      if (crossGeneration === "vs-previous" && r >= 1) {
        for (const X of input.models) {
          for (const Y of input.models) {
            if (X === Y) continue
            for (let s = 0; s < r; s++) {
              for (let di = 0; di < D; di++) {
                for (let dj = 0; dj < D; dj++) {
                  specs.push({
                    round: r, envLabel: env.label,
                    planModel: X, planRound: r, di,
                    oppModel: Y, oppRound: s, dj,
                    isChain: false,
                  })
                }
              }
            }
          }
        }
      }
    }
  }
  return specs
}
