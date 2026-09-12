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
 * plan:validate — 校验 GamePlanV1 JSON（设计文档组件 A/F）。
 *
 * 用法：pnpm run plan:validate -- <plan.json>
 * 退出码：0 合法；1 非法或文件不可读。
 */

import { readFile } from "node:fs/promises"
import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { validateGamePlan, computePlanId, type GamePlanV1 } from "../index.js"
import { parseGameVersion } from "../version.js"

async function main() {
  const planPath = process.argv.slice(2).filter((a) => a !== "--")[0]
  if (!planPath) {
    console.error("usage: pnpm run plan:validate -- <plan.json>")
    process.exit(1)
  }

  let plan: GamePlanV1
  try {
    plan = JSON.parse(await readFile(planPath, "utf-8")) as GamePlanV1
  } catch (e) {
    console.error(`failed to read/parse ${planPath}: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }

  let deck: { characters: number[]; cards: number[] }
  try {
    deck = DEFAULT_ASSETS_MANAGER.decode(plan.context?.deckCode ?? "")
  } catch (e) {
    console.error(`failed to decode context.deckCode: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }

  // 与 batch-runner 的 loadPlanWithValidation 一致：known_deck 解对手分享码、
  // mirror 用自身牌表，使 hasCardP 等对手牌表语义校验在 CLI 下同样生效；
  // 计划声明 gameVersion 时用该版本数据做存在性校验（V1 版本钉扎）。
  const opp = plan.context?.opponent
  let opponentDeck: { characters: number[]; cards: number[] } | undefined
  try {
    opponentDeck = opp?.kind === "mirror" ? deck
      : opp?.kind === "known_deck"
        ? DEFAULT_ASSETS_MANAGER.decode(opp.deckCode)
        : undefined
  } catch (e) {
    console.error(`failed to decode opponent deckCode: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }

  let declaredVersion: ReturnType<typeof parseGameVersion>
  try {
    declaredVersion = parseGameVersion(plan.context?.gameVersion)
  } catch (e) {
    console.error(`invalid context.gameVersion: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const data = declaredVersion === undefined ? undefined : getData(declaredVersion)

  const result = validateGamePlan(plan, {
    deck,
    opponentDeck,
    ...(data !== undefined ? { data } : {}),
  })
  console.log(`gameVersion: ${declaredVersion ?? CURRENT_VERSION}（计划声明：${plan.context?.gameVersion ?? "未声明"}）`)
  console.log(`computedPlanId: ${computePlanId(plan)} (file claims: ${plan.planId})`)
  const warningsText = result.warnings.map((w) => `  [warning] ${w.path}: ${w.message}`).join("\n")
  if (result.ok) {
    console.log(`OK: plan is valid${warningsText ? `\n${warningsText}` : ""}`)
    return
  }
  console.log(`INVALID: ${result.issues.length} issue(s)${warningsText ? `\n${warningsText}` : ""}`)
  for (const issue of result.issues) {
    console.log(`  [${issue.repairable ? "repairable" : "fatal"}] ${issue.path}: ${issue.message}`)
  }
  process.exit(1)
}

await main()
