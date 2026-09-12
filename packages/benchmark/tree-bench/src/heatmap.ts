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
 * 配对胜率 heatmap:从胜率矩阵渲染无依赖 SVG。
 *
 * 配色约定与 PTCG-Bench 论文一致:冷色 = 行选手更强(胜率高),
 * 白 = 50%,暖色 = 行选手更弱。单元格标注行选手对列选手的胜率。
 */

export interface HeatmapOptions {
  title?: string
  /** 单元格边长(px),默认 72 */
  cellSize?: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function rgb(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
}

/** 冷-白-暖发散色:强(蓝) → 0.5(白) → 弱(红)。 */
function heatColor(v: number): string {
  const t = clamp((v - 0.5) * 2, -1, 1) // v=0.5 -> 0, v=1 -> 1, v=0 -> -1
  const cold: [number, number, number] = [23, 69, 168] // #1745a8
  const mid: [number, number, number] = [245, 245, 245]
  const warm: [number, number, number] = [176, 35, 24] // #b02318
  if (t >= 0) return rgb([lerp(mid[0], cold[0], t), lerp(mid[1], cold[1], t), lerp(mid[2], cold[2], t)])
  return rgb([lerp(warm[0], mid[0], t + 1), lerp(warm[1], mid[1], t + 1), lerp(warm[2], mid[2], t + 1)])
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * 渲染 heatmap SVG 字符串。
 *
 * @param agentIds 选手 id(行 = 列 = 该顺序)
 * @param A 胜率矩阵 A[i][j] = P(i 胜 j)
 */
export function renderHeatmapSvg(agentIds: string[], A: number[][], opts: HeatmapOptions = {}): string {
  const n = agentIds.length
  const cell = opts.cellSize ?? 72
  const rowLabelW = 170
  const colLabelH = 110
  const legendH = 70
  const pad = 16
  const width = rowLabelW + n * cell + pad * 2
  const height = colLabelH + n * cell + legendH + pad * 2

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`,
  )
  if (opts.title) {
    parts.push(
      `<text x="${rowLabelW + (n * cell) / 2}" y="${pad + 14}" text-anchor="middle" ` +
        `font-size="15" font-weight="600" fill="#222">${esc(opts.title)}</text>`,
    )
  }
  const titleH = opts.title ? 26 : 0
  const x0 = rowLabelW + pad
  const y0 = colLabelH + titleH

  // 单元格
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = x0 + j * cell
      const y = y0 + i * cell
      const v = A[i]?.[j] ?? 0.5
      parts.push(
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${heatColor(v)}" ` +
          `stroke="#fff" stroke-width="1.5"/>`,
      )
      const label = i === j ? "—" : `${Math.round(v * 100)}%`
      parts.push(
        `<text x="${x + cell / 2}" y="${y + cell / 2 + 4.5}" text-anchor="middle" ` +
          `font-size="13" fill="${Math.abs(v - 0.5) < 0.12 ? "#444" : "#fff"}">${label}</text>`,
      )
    }
  }

  // 行标签(左侧,选手 id)
  for (let i = 0; i < n; i++) {
    const y = y0 + i * cell + cell / 2
    parts.push(
      `<text x="${x0 - 10}" y="${y + 4.5}" text-anchor="end" font-size="12.5" fill="#222">${esc(agentIds[i]!)}</text>`,
    )
  }

  // 列标签(顶部,旋转 -45°)
  for (let j = 0; j < n; j++) {
    const x = x0 + j * cell + cell / 2
    const y = y0 - 12
    parts.push(
      `<text x="${x}" y="${y}" text-anchor="end" font-size="12.5" fill="#222" ` +
        `transform="rotate(-45 ${x} ${y})">${esc(agentIds[j]!)}</text>`,
    )
  }

  // 图例
  const legendW = 320
  const lx = x0 + (n * cell - legendW) / 2
  const ly = y0 + n * cell + 26
  const stops = [
    ["0%", rgb([176, 35, 24])],
    ["50%", rgb([245, 245, 245])],
    ["100%", rgb([23, 69, 168])],
  ]
    .map(([pos, color]) => `<stop offset="${pos}" stop-color="${color}"/>`)
    .join("")
  parts.push(
    `<defs><linearGradient id="legend" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>`,
    `<rect x="${lx}" y="${ly}" width="${legendW}" height="14" fill="url(#legend)" stroke="#ccc"/>`,
    `<text x="${lx}" y="${ly + 28}" font-size="11" fill="#666" text-anchor="start">0% (弱)</text>`,
    `<text x="${lx + legendW / 2}" y="${ly + 28}" font-size="11" fill="#666" text-anchor="middle">行选手胜率 50%</text>`,
    `<text x="${lx + legendW}" y="${ly + 28}" font-size="11" fill="#666" text-anchor="end">100% (强)</text>`,
  )

  parts.push("</svg>")
  return parts.join("\n")
}
