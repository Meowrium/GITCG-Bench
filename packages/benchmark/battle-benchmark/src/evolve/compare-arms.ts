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

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EvolveReport, EvolveReportRound } from "./run"

const HELP = `用法: gnx battle-benchmark/src/evolve/compare-arms.ts --run-a <dir> --run-b <dir>

对 evolve 两个臂的 outputDir 做逐单元格统计对比（纯 CLI 纯统计，无 LLM、无文件写入）。

要求:
  --run-a <dir>         臂 A 的 evolve outputDir（含 report.json）
  --run-b <dir>         臂 B 的 evolve outputDir（含 report.json）
  -h, --help            显示本帮助

说明:
  - 两臂须同 matchup 同卡组（镜像/非镜像均可，须一致）、同被测模型；
  - 先后手已由 alternateFirstPlayer 交替，单元格内聚合不拆先后手；
  - 差异显著性用近似正态检验（WRa - WRb ± 1.96·SE），两臂合计 <100 局
    时 ~14pp 检测口径无法满足，结论仅作探索性参考。
`

interface ArmSummary {
  arm: string
  n: number
  wr: number | null
  se: number | null
  draws: number
  errors: number
}

function take(name: string, args: string[], i: number): [string, number] {
  const value = args[i + 1]
  if (value === undefined) {
    fail(`缺少 ${name} 的参数值`)
  }
  return [value, i + 1]
}

function fail(msg: string): never {
  console.error(`[compare-arms] 错误: ${msg}`)
  process.exit(1)
}

function loadReport(dir: string): EvolveReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, "report.json"), "utf-8"))
  } catch (err) {
    fail(`无法读取 ${join(dir, "report.json")}: ${String(err)}`)
  }
  return parsed as EvolveReport
}

/** 聚合一轮的胜/负/平/错；WR 与标准误在单元格内计算（不含平局与错误）。 */
function summarizeArm(arm: string, report: EvolveReport): ArmSummary {
  let wins = 0
  let losses = 0
  let draws = 0
  let errors = 0
  for (const r of report.rounds) {
    wins += r.wins
    losses += r.losses
    draws += r.draws
    errors += r.errors
  }
  const n = wins + losses
  const wr = n > 0 ? wins / n : null
  const se = n > 0 ? Math.sqrt(wr! * (1 - wr!) / n) : null
  return { arm, n, wr, se, draws, errors }
}

/** 检查两臂可比性：matchup 必须一致；被测模型不一致只警告。 */
function checkPremise(a: EvolveReport, b: EvolveReport): void {
  if (
    a.matchup.id !== b.matchup.id ||
    a.matchup.deck0 !== b.matchup.deck0 ||
    a.matchup.deck1 !== b.matchup.deck1
  ) {
    fail(
      `两臂 matchup 不一致：A=${a.matchup.id}(${a.matchup.deck0}/${a.matchup.deck1})，` +
        `B=${b.matchup.id}(${b.matchup.deck0}/${b.matchup.deck1})`,
    )
  }
  if (a.modelTested !== b.modelTested) {
    console.error(`警告: 两臂被测模型不一致（A=${a.modelTested}，B=${b.modelTested}）`)
  }
  if (a.matchup.deck0 !== a.matchup.deck1) {
    console.log(`提示: 非镜像 matchup（${a.matchup.deck0} vs ${a.matchup.deck1}），仍按单元格内聚合（先后手已交替）`)
  }
}

function main(): void {
  const args = process.argv.slice(2)
  let runA: string | null = null
  let runB: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "-h":
      case "--help":
        console.log(HELP)
        return
      case "--run-a": {
        const [value, next] = take("--run-a", args, i)
        runA = value
        i = next
        break
      }
      case "--run-b": {
        const [value, next] = take("--run-b", args, i)
        runB = value
        i = next
        break
      }
      default:
        fail(`未知参数: ${arg}`)
    }
  }
  if (runA === null || runB === null) {
    fail("缺少 --run-a <dir> 或 --run-b <dir>")
  }

  const reportA = loadReport(resolve(process.cwd(), runA))
  const reportB = loadReport(resolve(process.cwd(), runB))
  checkPremise(reportA, reportB)

  const a = summarizeArm("A", reportA)
  const b = summarizeArm("B", reportB)
  const fmt = (s: ArmSummary) =>
    `${s.arm}: controlArm=${s.arm === "A" ? reportA.controlArm : reportB.controlArm} ` +
    `n=${s.n} WR=${s.wr === null ? "n/a" : `${(s.wr * 100).toFixed(1)}%`} ` +
    `SE=${s.se === null ? "n/a" : `${(s.se * 100).toFixed(1)}pp`} ` +
    `draws=${s.draws} errors=${s.errors}`

  console.log("两臂汇总（单元格内聚合，先后手已交替）:")
  console.log(`  arm ${fmt(a)}`)
  console.log(`  arm ${fmt(b)}`)

  if (a.wr === null || b.wr === null) {
    console.log("结论: 至少一臂无有效对局（wins+losses=0），无法比较")
    return
  }
  const diff = a.wr - b.wr
  const seDiff = Math.sqrt(a.se! ** 2 + b.se! ** 2)
  const lo = diff - 1.96 * seDiff
  const hi = diff + 1.96 * seDiff
  console.log(`diff = WRa - WRb = ${(diff * 100).toFixed(1)}pp`)
  console.log(`SE_diff = sqrt(SEa² + SEb²) = ${(seDiff * 100).toFixed(1)}pp`)
  console.log(`95% CI = diff ± 1.96·SE_diff = [${(lo * 100).toFixed(1)}pp, ${(hi * 100).toFixed(1)}pp]`)
  console.log(
    lo <= 0 && hi >= 0
      ? "结论: CI 含 0，两臂无显著差异"
      : `结论: CI 不含 0，差异显著（WRa - WRb = ${(diff * 100).toFixed(1)}pp）`,
  )
  const totalN = a.n + b.n
  if (totalN < 100) {
    console.error(`样本量提示: 两臂合计 ${totalN} 局 < 100，~14pp 检测口径无法满足，结论仅作探索性参考`)
  }
}

// 入口守卫：仅当作为脚本直接执行时运行 main（被 import 时不执行）。
if (
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
