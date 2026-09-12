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
 * 骰子分布先验：8 面骰（7 元素 + 万能 omni，各面等概）的精确组合概率。
 *
 * 两个消费点：
 * ① harness 的 dice_prior 模块（cli/modules.ts）——author/reflect 写骰子阈值时查表；
 * ② opp.threat.burstP 字段（threat.ts）——对手骰面隐藏时估计其支付概率。
 *
 * 规模极小（n ≤ 8），运行时即时精确计算，不打离线表。
 */

/** 单骰掷出某指定元素的概率 */
export const P_SINGLE_ELEMENT = 1 / 8
/** 单骰掷出"指定元素或万能"（可支付该元素费用）的概率 */
export const P_ELEMENT_OR_OMNI = 2 / 8

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return r
}

/** P(X >= k)，X ~ Binomial(n, p) */
export function binomialTail(n: number, p: number, k: number): number {
  if (k <= 0) return 1
  if (k > n) return 0
  let sum = 0
  for (let x = k; x <= n; x++) {
    sum += choose(n, x) * p ** x * (1 - p) ** (n - x)
  }
  return sum
}

/** n 骰中某指定元素骰 ≥ k 的概率 */
export function probSingleElementAtLeast(n: number, k: number): number {
  return binomialTail(n, P_SINGLE_ELEMENT, k)
}

/**
 * 超几何概率（对手手牌估牌）：未见牌 U 张中藏有某卡 k 张时，
 * 对手手牌 h 张持有 ≥1 张的概率 P = 1 − C(U−k,h)/C(U,h)。
 * 用乘积形式逐位计算，n ≤ 30 规模下双精度精确（choose 同口径）。
 * k ≤ 0 或 h ≤ 0 → 0；k > U 按 k = U 钳制；U − k < h → 1（鸽笼：手牌必含）。
 */
export function probHoldAtLeastOne(unseenU: number, handH: number, copiesK: number): number {
  if (copiesK <= 0 || handH <= 0 || unseenU <= 0) return 0
  const k = Math.min(copiesK, unseenU)
  if (unseenU - k < handH) return 1
  let p0 = 1
  for (let i = 0; i < handH; i++) p0 *= (unseenU - k - i) / (unseenU - i)
  return 1 - p0
}

/** n 骰中"某元素 + 万能"合计 ≥ k 的概率——支付 n 骰元素费用的标准概率 */
export function probElementOrOmniAtLeast(n: number, k: number): number {
  return binomialTail(n, P_ELEMENT_OR_OMNI, k)
}

/**
 * 一次 reroll（保留可用骰、重掷其余全部一次）后，单骰最终"可用"的概率：
 * q = p + (1-p)·p = p(2-p)。各骰独立，最终可用数 ~ Binomial(n, q)。
 *
 * @param usefulFaces 单骰的可用面数：指定元素+万能 = 2；2 元素队可用 = 3；3 元素队 = 4
 */
export function usefulProbAfterReroll(usefulFaces: number): number {
  const p = usefulFaces / 8
  return p * (2 - p)
}

/** reroll 一次后 n 骰中可用骰 ≥ k 的概率 */
export function probUsefulAfterReroll(n: number, k: number, usefulFaces: number): number {
  return binomialTail(n, usefulProbAfterReroll(usefulFaces), k)
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`
}

/**
 * dice_prior 模块内容：关键概率的精炼 markdown（体量须远低于
 * cli/modules.ts 的 MAX_MODULE_CHARS=4000，只给决策最常用的三张表）。
 */
export function formatDicePriorMarkdown(): string {
  const lines: string[] = [
    `# 骰子分布先验（8 面骰：7 元素 + 万能；每回合 roll 8 颗，可全部重掷一次）`,
    ``,
    `## 开局 8 骰（未 reroll）`,
    ``,
    `| 数量 k | P(指定元素 ≥ k) | P(元素+万能 ≥ k) |`,
    `|---|---|---|`,
  ]
  for (let k = 1; k <= 5; k++) {
    lines.push(`| ${k} | ${pct(probSingleElementAtLeast(8, k))} | ${pct(probElementOrOmniAtLeast(8, k))} |`)
  }
  lines.push(
    ``,
    `写"元素费用 ≥ n"类阈值时对照此表：3 元素费战技裸 roll 命中只有约三成，`,
    `依赖它的规则应考虑 reroll 后概率或元素调和兜底。`,
    ``,
    `## reroll 一次后（保留可用骰、重掷其余）`,
    ``,
    `| 可用面口径 | 单骰可用概率 q | P(≥3) | P(≥5) | P(≥6) |`,
    `|---|---|---|---|---|`,
  )
  for (const [label, faces] of [["指定元素+万能", 2], ["2 元素队可用骰", 3], ["3 元素队可用骰", 4]] as const) {
    lines.push(
      `| ${label} | ${pct(usefulProbAfterReroll(faces))} | ${pct(probUsefulAfterReroll(8, 3, faces))} | ${pct(probUsefulAfterReroll(8, 5, faces))} | ${pct(probUsefulAfterReroll(8, 6, faces))} |`,
    )
  }
  lines.push(
    ``,
    `## 剩余 n 骰时的元素费用支付概率（P(元素+万能 ≥ k | n 骰)）`,
    ``,
    `对手骰面隐藏时估计其支付能力（opp.threat.burstP 同口径），`,
    `也用于"下回合还剩几骰能做什么"的规划：`,
    ``,
    `| n \\ k | 2 | 3 | 4 |`,
    `|---|---|---|---|`,
  )
  for (let n = 2; n <= 8; n++) {
    lines.push(`| ${n} | ${pct(probElementOrOmniAtLeast(n, 2))} | ${pct(probElementOrOmniAtLeast(n, 3))} | ${pct(probElementOrOmniAtLeast(n, 4))} |`)
  }
  return lines.join("\n")
}
