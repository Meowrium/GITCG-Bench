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
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/**
 * harness 反思 transcript 打捞：当 agentic reflect 因"轮次耗尽且无任何通过校验的
 * draft"失败、但某轮 raw 里实际含有近似完整的 ReflectPlanResultV1（如 brace 失衡
 * 一个）时，从 transcript 提取 revisedPlan，按 run-plan-reflect.ts finalizeMerged
 * 的同一管线收尾（谱系接管 → auto-repair → sampling → planId）并落盘。
 *
 * 用法：pnpm exec gnx scripts/salvage-reflect-transcript.ts <transcript.jsonl> <base-plan.json> <out-plan.json>
 */

import { readFile, writeFile } from "node:fs/promises"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { GamePlanV1 } from "../src/runtime/plan-oneshot/game-plan-v1.js"
import {
  autoRepairPlan,
  computePlanId,
  normalizePlanNumericFields,
  validateGamePlan,
  type PlanValidationContext,
} from "../src/runtime/plan-oneshot/validate.js"

const [transcriptPath, basePlanPath, outPath] = process.argv.slice(2)
if (!transcriptPath || !basePlanPath || !outPath) {
  console.error("usage: gnx scripts/salvage-reflect-transcript.ts <transcript.jsonl> <base-plan.json> <out-plan.json>")
  process.exit(1)
}

/** 容忍尾部缺失闭合括号：依次尝试补 0..4 个 `}` 后 JSON.parse */
function parseWithBraceRepair(raw: string): unknown | null {
  for (let extra = 0; extra <= 4; extra++) {
    try {
      return JSON.parse(raw + "}".repeat(extra))
    } catch {
      // 继续尝试更多闭合括号
    }
  }
  return null
}

const basePlan = JSON.parse(await readFile(basePlanPath, "utf-8")) as GamePlanV1
const lines = (await readFile(transcriptPath, "utf-8")).split("\n").filter((l) => l.trim().length > 0)

// 从最后一轮往前找含 final/draft 命令的 raw
let salvaged: { turn: number; result: Record<string, unknown> } | null = null
for (let i = lines.length - 1; i >= 0 && !salvaged; i--) {
  const t = JSON.parse(lines[i]) as { turn?: number; raw?: string }
  if (!t.raw || !t.raw.includes(`"action"`)) continue
  const parsed = parseWithBraceRepair(t.raw) as { action?: string; result?: Record<string, unknown>; plan?: Record<string, unknown> } | null
  if (!parsed || (parsed.action !== "final" && parsed.action !== "draft")) continue
  const result = parsed.result ?? (parsed.plan ? { revisedPlan: parsed.plan } : null)
  if (result && typeof result === "object" && result.revisedPlan) {
    salvaged = { turn: t.turn ?? i + 1, result }
  }
}

if (!salvaged) {
  console.error("salvage failed: 没有任何一轮 raw 含可修复的 final/draft 命令")
  process.exit(1)
}
console.log(`salvaged from turn ${salvaged.turn}`)

const result = salvaged.result as {
  revisedPlan: GamePlanV1
  revisedPredictions?: GamePlanV1["predictions"]
}

// ── 与 finalizeMerged 同一管线（run-plan-reflect.ts:151-168）──
const deck = DEFAULT_ASSETS_MANAGER.decode(basePlan.context.deckCode)
const opp = basePlan.context.opponent
const validCtx: PlanValidationContext = {
  deck,
  opponentDeck: opp.kind === "mirror" ? deck
    : opp.kind === "known_deck" ? DEFAULT_ASSETS_MANAGER.decode(opp.deckCode)
    : undefined,
}

const candidate = normalizePlanNumericFields(result.revisedPlan)
if (result.revisedPredictions) candidate.predictions = result.revisedPredictions
candidate.parentPlanId = basePlan.planId
candidate.createdAt = new Date().toISOString()
candidate.context = basePlan.context // 授权边界：context 永远接管自原计划
const repaired = autoRepairPlan(candidate, validCtx)
repaired.plan.sampling = { temperature: 0.2, seed: 20260851 }
repaired.plan.planId = computePlanId(repaired.plan)

const validation = validateGamePlan(repaired.plan, validCtx)
if (!validation.ok) {
  console.error(`salvaged plan 未通过校验（${validation.issues.length} 个问题）：`)
  for (const issue of validation.issues.slice(0, 30)) console.error(`  - ${JSON.stringify(issue)}`)
  process.exit(1)
}
if (repaired.dropped.length > 0) {
  console.log(`auto-repair 移除了 ${repaired.dropped.length} 个死规则/条目：${repaired.dropped.join("；")}`)
}

await writeFile(outPath, `${JSON.stringify(repaired.plan, null, 2)}\n`, "utf-8")
await writeFile(`${outPath}.reflection.json`, `${JSON.stringify(salvaged.result, null, 2)}\n`, "utf-8")
console.log(`OK: salvaged plan → ${outPath}（planId=${repaired.plan.planId}，rules=${repaired.plan.rules.length}，parent=${basePlan.planId}）`)
