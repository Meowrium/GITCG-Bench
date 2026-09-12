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
 * plan:eval — oracle 回算 CLI（核心逻辑在 ../eval-game.ts）。
 *
 * 用法：pnpm run plan:eval -- <runDir|gameDir> [--tau 0.1] [--dets 4] [--sims 32] [--budget 300]
 *              [--trace-file plan_trace.side1.json] [--eval-out plan_eval.side1.json]
 *
 * 归因口径：ISMCTS。本快照不含外部 NN oracle（`--oracle nn`）及其桥接实现。
 */

import { DEFAULT_EVAL_CONFIG, evalRunDir } from "../eval-game.js"

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const target = args[0]
  if (!target) {
    console.error("usage: pnpm run plan:eval -- <runDir|gameDir> [--oracle ismcts|nn] [--tau 0.1] [--dets 4] [--sims 32] [--budget 300] [--trace-file <name>] [--eval-out <name>]")
    process.exit(1)
  }
  const numFlag = (name: string, def: number): number => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? Number(args[i + 1]) : def
  }
  const strFlag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const cfg = {
    tau: numFlag("tau", DEFAULT_EVAL_CONFIG.tau),
    determinizations: numFlag("dets", DEFAULT_EVAL_CONFIG.determinizations),
    simulations: numFlag("sims", DEFAULT_EVAL_CONFIG.simulations),
    timeBudgetMs: numFlag("budget", DEFAULT_EVAL_CONFIG.timeBudgetMs),
  }
  const traceFileName = strFlag("trace-file")
  const traceTag = traceFileName?.match(/^plan_trace\.(.+)\.json$/)?.[1]
  if (strFlag("oracle") !== undefined) {
    console.error("本快照不含 --oracle nn（外部 NN 桥接未入库）；归因口径仅 ISMCTS，请省略 --oracle")
    process.exit(1)
  }
  const evalOutName = strFlag("eval-out") ?? (traceTag ? `plan_eval.${traceTag}.json` : undefined)
  const summaryOutName = traceTag ? `plan_eval_summary.${traceTag}.json` : undefined

  console.log(`evaluating ${target}, tau=${cfg.tau}, dets=${cfg.determinizations}, sims=${cfg.simulations}, budget=${cfg.timeBudgetMs}ms${traceFileName ? `, trace=${traceFileName}` : ""}`)
  const aggregate = await evalRunDir(target, cfg, {
    traceFileName,
    evalOutName,
    summaryOutName: summaryOutName === "plan_eval_summary..json" ? undefined : summaryOutName,
    onGameDone: (dir, result) => {
      console.log(
        `${dir}: points=${result.metrics.total} blunders=${result.metrics.blunders} ` +
        `(${(result.metrics.blunderRate * 100).toFixed(1)}%) divergences=${result.metrics.divergences}` +
        (result.warnings.length > 0 ? ` warnings=${result.warnings.length}` : ""),
      )
      for (const w of result.warnings) console.log(`  warning: ${w}`)
    },
  })
  console.log(
    `\ntotal: ${aggregate.totalPoints} points, ${aggregate.totalBlunders} blunders ` +
    `(${(aggregate.blunderRate * 100).toFixed(1)}%), ${aggregate.totalDivergences} divergences`,
  )
  console.log("per-rule blame:")
  for (const [k, v] of Object.entries(aggregate.perRule).sort((a, b) => b[1].blunders - a[1].blunders)) {
    console.log(`  ${k}: ${v.blunders}/${v.points}`)
  }
}

await main()
