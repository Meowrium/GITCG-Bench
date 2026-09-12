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
 * plan:organize-export — organizer 证据导出器 CLI（WP4 件 1）。
 *
 * 用法：pnpm run plan:organize-export -- --run-dir <dir> --out <evidencePack目录> [--games all|N|outliers] [--outliers]
 *       [--max-lines 2000] [--max-chars 200000]
 *
 * 输入：一个 plan:batch run 目录（game-NNNN/plan_trace.json、plan_trace.side1.json、
 * summary.json、summary.side1.json、game_state_log.json）。
 * 输出五件：fullDigest.txt / stateSignatures.jsonl / draw-sequence.md / outliers.json / side1/
 * （另附 plan.side0.json + manifest.json；详见 ../organize-export.ts 头注释与 WP4 规格 §2）。
 *
 * 上限口径：单局不截断；总行/总字符上限独立于 reflect 的 prompt 预算（3/局、8/run、420 行）。
 * 隔离红线：只读 --run-dir，只写 --out（验收 6：对 run 目录做前后清单对比应零差异）。
 */

import { buildEvidencePack, DEFAULT_MAX_CHARS, DEFAULT_MAX_LINES } from "./organize-export.js"

interface CliArgs {
  runDir: string
  out: string
  games: "all" | number | "outliers"
  maxLines: number
  maxChars: number
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const runDir = get("run-dir") ?? ""
  const out = get("out")
  const hasOutliersFlag = args.includes("--outliers")
  const gamesRaw = get("games") ?? (hasOutliersFlag ? "outliers" : "all")
  let games: "all" | number | "outliers"
  if (gamesRaw === "all" || gamesRaw === "outliers") games = gamesRaw
  else {
    const n = Number(gamesRaw)
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--games 需为 all | 正整数 | outliers，得到: ${gamesRaw}`)
      process.exit(1)
    }
    games = n
  }
  if (!runDir || !out) {
    console.error("usage: plan:organize-export -- --run-dir <dir> --out <evidencePack目录> [--games all|N|outliers] [--outliers] [--max-lines 2000] [--max-chars 200000]")
    process.exit(1)
  }
  return {
    runDir,
    out,
    games,
    maxLines: Number(get("max-lines") ?? DEFAULT_MAX_LINES),
    maxChars: Number(get("max-chars") ?? DEFAULT_MAX_CHARS),
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  console.log(`[organize-export] runDir=${args.runDir} out=${args.out} games=${String(args.games)} maxLines=${args.maxLines} maxChars=${args.maxChars}`)
  const result = await buildEvidencePack({
    runDir: args.runDir,
    outDir: args.out,
    games: args.games,
    maxLines: args.maxLines,
    maxChars: args.maxChars,
  })
  for (const f of result.files) console.log(`  写出 ${f}`)
  console.log(
    `[organize-export] 完成：${result.gamesSelected.length}/${result.gamesAll.length} 局`
    + ` ｜ side1=${result.side1Present ? "有" : "无"}`
    + ` ｜ fullDigest ${result.fullDigest.lines} 行 / ${result.fullDigest.chars} 字符`
    + ` ｜ 省略 ${result.omittedGames.length} 局`
    + ` ｜ 对齐警告 ${result.alignmentWarnings.length} 条`,
  )
  if (result.omittedGames.length > 0) {
    console.warn(`[organize-export] 因总上限省略的局：${result.omittedGames.join(", ")}（可调 --max-lines/--max-chars）`)
  }
}

await main()
