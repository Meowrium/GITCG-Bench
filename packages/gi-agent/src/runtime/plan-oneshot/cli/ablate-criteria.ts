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
 * plan:ablate 的引擎侧判定（2026-08-30 无 oracle 自进化臂 S-M2）。
 *
 * engine-only 消融不读任何 eval 文件——判据全部来自批跑 summary（机械可检）：
 * - revise 且基线 thenMiss[R] > 0（thenMiss 类修订）：以 thenMiss 归零为主判据，
 *   coverage/fallback 劣化为混淆闸（劣化超容差 → inconclusive，无法归因）；
 * - revise 数值修订（then.damage_min / then.kills / when 骰子闸或 HP 闸数值变化，
 *   检测在 ablate-numeric.ts）：同种子反事实判据——base/arm 同 seed 逐局配对取该
 *   规则命中数（numericPaired），配对 seeds<20 或覆盖劣化 → inconclusive，否则
 *   每局命中率差超出 ±minEffect 才下方向性结论；配对不可用回落胜率区间；
 * - 其余（remove，或 revise 无配对指标）：胜率区间判据——同 seed 梯 N≥20 才生效
 *   （噪声纪律 §4），臂胜率−基线胜率超出 ±minEffect 才下方向性结论。
 */

/**
 * 同种子反事实配对命中数（numericTouched revise 臂）：baseHits/armHits 按 seed
 * 升序对齐（数组下标 = 同一 seed 的 base/arm 命中数），seeds = 配对局数。
 * 缺省 = 配对指标不可用（旧 trace 缺逐条目规则身份 / 两侧零命中等）→ 回落胜率区间。
 */
export interface NumericPairedHits {
  /** 配对局数（N≥20 闸） */
  seeds: number
  baseHits: number[]
  armHits: number[]
}

export interface EngineOnlyJudgeInput {
  verdict: "revise" | "remove"
  ruleRef: string
  /** 基线批跑 summary.perRuleThenMiss[ruleRef] ?? 0 */
  baseThenMiss: number
  armThenMiss: number
  baseCoverage: number
  armCoverage: number
  baseFallbackRate: number
  armFallbackRate: number
  baseWinRate: number
  armWinRate: number
  /** 消融臂局数（胜率判据的样本量闸） */
  games: number
  /** 胜率区间半宽（如 0.03 = ±3pp） */
  minEffect: number
  /** coverage/fallback 劣化容差（如 0.05 = 5pp） */
  coverageTol: number
  /** 同种子反事实配对命中数（数值修订 revise 臂；缺省 = 不可用，回落胜率区间） */
  numericPaired?: NumericPairedHits
}

export interface EngineOnlyJudgeResult {
  status: "supported" | "refuted" | "inconclusive"
  note: string
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

const mean = (xs: readonly number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length

export function judgeEngineOnly(i: EngineOnlyJudgeInput): EngineOnlyJudgeResult {
  const coverageDrop = i.armCoverage < i.baseCoverage - i.coverageTol
  const fallbackJump = i.armFallbackRate > i.baseFallbackRate + i.coverageTol
  const coverNote = `coverage ${pct(i.baseCoverage)}→${pct(i.armCoverage)}，fallback 率 ${pct(i.baseFallbackRate)}→${pct(i.armFallbackRate)}`
  const confusion = coverageDrop || fallbackJump

  // ── thenMiss 类修订：主判据 = thenMiss 归零 ──
  if (i.verdict === "revise" && i.baseThenMiss > 0) {
    const tmNote = `thenMiss ${i.baseThenMiss} → ${i.armThenMiss}`
    if (confusion) {
      return { status: "inconclusive", note: `${tmNote}；但覆盖劣化（${coverNote}）——效应无法与覆盖崩坏区分` }
    }
    if (i.armThenMiss === 0) {
      return { status: "supported", note: `${tmNote}（归零）；${coverNote}` }
    }
    if (i.armThenMiss < i.baseThenMiss) {
      return { status: "inconclusive", note: `${tmNote}（部分下降未归零）；${coverNote}` }
    }
    return { status: "refuted", note: `${tmNote}（未降反升/持平）；${coverNote}` }
  }

  // ── 同种子反事实判据（数值修订 revise 臂：damage_min/kills/when 闸数值）──
  // thenMiss 归零仍是主判据（基线 thenMiss>0 时上方分支已返回）；本判据在
  // numericPaired 可用时优先于胜率区间，不可用（缺省）时回落后者。
  if (i.verdict === "revise" && i.numericPaired) {
    const p = i.numericPaired
    const baseRate = mean(p.baseHits)
    const armRate = mean(p.armHits)
    const delta = armRate - baseRate
    const pairNote = `同种子反事实判据：修订规则命中率 ${baseRate.toFixed(2)}→${armRate.toFixed(2)} 次/局（seeds=${p.seeds}，阈值 ±${i.minEffect.toFixed(2)} 次/局）`
    if (confusion) {
      return { status: "inconclusive", note: `${pairNote}；但覆盖劣化（${coverNote}）——效应无法与覆盖崩坏区分` }
    }
    if (p.seeds < 20) {
      return { status: "inconclusive", note: `同种子反事实判据需 N≥20（当前配对 seeds=${p.seeds}），样本不足不下方向性结论；${coverNote}` }
    }
    if (delta > i.minEffect) return { status: "supported", note: `${pairNote}（命中率上升）；${coverNote}` }
    if (delta < -i.minEffect) return { status: "refuted", note: `${pairNote}（命中率下降）；${coverNote}` }
    return { status: "inconclusive", note: `${pairNote}，落在噪声区间内；${coverNote}` }
  }

  // ── 胜率区间判据（remove 恒走这里；revise 无配对指标时回落这里）──
  const tmExtra = i.armThenMiss > i.baseThenMiss ? `；注意臂 thenMiss 新增 ${i.armThenMiss - i.baseThenMiss}（${i.ruleRef} 出现死规则迹象）` : ""
  if (i.games < 20) {
    return { status: "inconclusive", note: `胜率判据需 N≥20（当前 N=${i.games}），样本不足不下方向性结论；${coverNote}${tmExtra}` }
  }
  if (confusion) {
    return { status: "inconclusive", note: `覆盖劣化（${coverNote}）——胜率变化无法归因于 ${i.ruleRef}${tmExtra}` }
  }
  const diff = i.armWinRate - i.baseWinRate
  const wrNote = `胜率 ${pct(i.baseWinRate)}→${pct(i.armWinRate)}（${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}pp，阈值 ±${(i.minEffect * 100).toFixed(0)}pp，N=${i.games}）`
  if (diff > i.minEffect) return { status: "supported", note: `${wrNote}；${coverNote}${tmExtra}` }
  if (diff < -i.minEffect) return { status: "refuted", note: `${wrNote}；${coverNote}${tmExtra}` }
  return { status: "inconclusive", note: `${wrNote}，落在噪声区间内；${coverNote}${tmExtra}` }
}
