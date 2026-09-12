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
 * author-portfolio-singles — 两层 portfolio 的 Single 层批量起草 wrapper（G2，Phase 4）。
 *
 * 用法（在 gi-agent 包目录内）：
 *   pnpm exec gnx scripts/ops/author-portfolio-singles.ts <config.json>
 *
 * config:
 * {
 *   "deck": "<己方分享码>",
 *   "opponents": [ { "code": "<对手分享码>", "label": "hongniu" }, ... ],
 *   "outDir": "output/plans",            // 相对 gi-agent 包目录（不硬编码绝对路径）
 *   "round": 3,                           // 产物 plans/single.<label>.r3.json
 *   "extraAuthorArgs": ["--stream"],      // 可选；透传给 plan:author 的附加参数
 *   "generalOpponentsFile": "opponents.txt" // 可选；存在则最后再调一次 --opponent-set 生成
 *                                          // plans/general.r<round>.json（General 层公共树）
 * }
 *
 * 行为：逐对手串行调用 `pnpm run plan:author -- --deck <deck> --opponent-deck <code>
 * --out <outDir>/plans/single.<label>.r<round>.json [extraAuthorArgs]`；任一对手失败
 * 继续跑其余（最后汇总列出失败项，非零退出码）；全部成功后若给了 generalOpponentsFile，
 * 再调一次 `--opponent-set` 生成 General 计划。
 *
 * 与 scripts/ops/gen_all_plans.sh 的关系：该脚本硬编码了 /mnt/d/... 绝对路径且产物为旧
 * schema；本 wrapper 用 JSON config 接收全部路径（相对包目录解析），产物为 GamePlanV1
 * （plan:author 的新管线）。
 */

import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

interface OpponentEntry {
  code: string
  label: string
}

interface AuthorPortfolioConfig {
  deck: string
  opponents: OpponentEntry[]
  outDir: string
  round: number
  extraAuthorArgs?: string[]
  generalOpponentsFile?: string
}

async function main(): Promise<void> {
  const configPath = process.argv.slice(2).filter((a) => a !== "--")[0]
  if (!configPath) {
    console.error("usage: pnpm exec gnx scripts/ops/author-portfolio-singles.ts <config.json>")
    process.exit(1)
  }
  const config = JSON.parse(await readFile(configPath, "utf-8")) as AuthorPortfolioConfig
  if (!config.deck || !Array.isArray(config.opponents) || config.opponents.length === 0) {
    console.error("config 需包含 deck 与非空 opponents（[{ code, label }, ...]）")
    process.exit(1)
  }
  if (!config.outDir || !Number.isInteger(config.round) || config.round < 0) {
    console.error("config 需包含 outDir 与 round（≥0 整数）")
    process.exit(1)
  }
  const labels = config.opponents.map((o) => o.label)
  if (new Set(labels).size !== labels.length) {
    console.error("opponents[].label 必须唯一（产物文件名与 ruleRef 层前缀依赖 label）")
    process.exit(1)
  }
  for (const o of config.opponents) {
    if (o.label.length === 0 || o.label.includes(":")) {
      console.error(`opponents[].label 非法：${JSON.stringify(o.label)}（必须非空且不含 ':'——ruleRef 层前缀分隔符）`)
      process.exit(1)
    }
  }
  const outDir = resolve(config.outDir)
  const extra = config.extraAuthorArgs ?? []

  const runAuthor = (args: string[]): { ok: boolean; output: string } => {
    // 与 scripts/v30_parallel_benchmark.ts 同约定：shell: true（Windows 下 pnpm 是 .cmd）
    const res = spawnSync("pnpm", ["run", "plan:author", "--", ...args], {
      cwd: process.cwd(),
      shell: true,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: res.status === 0, output: (res.stdout ?? "") + (res.stderr ?? "") }
  }

  const failures: Array<{ label: string; output: string }> = []
  for (const o of config.opponents) {
    const outFile = join(outDir, "plans", `single.${o.label}.r${config.round}.json`)
    console.log(`[Single] ${o.label} …（对手 ${o.code.slice(0, 8)}… → ${outFile}）`)
    const r = runAuthor(["--deck", config.deck, "--opponent-deck", o.code, "--out", outFile, ...extra])
    if (!r.ok) {
      console.error(`[Single] ${o.label} 失败（继续其余对手）`)
      const tail = r.output.trim().split("\n").slice(-8).join("\n")
      console.error(tail)
      failures.push({ label: o.label, output: r.output })
    } else {
      console.log(`[Single] ${o.label} OK`)
    }
  }

  if (failures.length > 0) {
    console.error(`\nSingle 起草完成，${failures.length} 个失败：${failures.map((f) => f.label).join(", ")}`)
    console.error("（失败的产物文件不完整，请按需重跑）")
    process.exit(1)
  }

  if (config.generalOpponentsFile) {
    const generalOut = join(outDir, "plans", `general.r${config.round}.json`)
    console.log(`[General] --opponent-set ${config.generalOpponentsFile} → ${generalOut}`)
    const r = runAuthor(["--deck", config.deck, "--opponent-set", resolve(config.generalOpponentsFile), "--out", generalOut, ...extra])
    if (!r.ok) {
      console.error("[General] 起草失败：")
      console.error(r.output.trim().split("\n").slice(-8).join("\n"))
      process.exit(1)
    }
    console.log("[General] OK")
  }

  console.log(`\n全部完成 → ${join(outDir, "plans")}/single.<label>.r${config.round}.json${config.generalOpponentsFile ? ` + general.r${config.round}.json` : ""}`)
}

await main()
