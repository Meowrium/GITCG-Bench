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
 * organize-export × lean trace 端到端单测（impl-spec-1 件 1 + 件 3）：
 * 用真实引擎对局（同 seed 各跑一局 full / lean）组装 run 目录，验证 lean run 的
 * evidencePack 出的 stateSignatures.jsonl 与 full run **语义一致**（整条签名对象
 * 逐字段相等）——即 organize-export 的「lean trace 从 state log 反查补齐」行为。
 */

import { describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_VERSION, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { SandboxRunner } from "../../../sandbox/runner.js"
import { PolicyPlayerIO } from "../../io/policy-player-io.js"
import { BaselinePolicy } from "../../policy/baseline-policy.js"
import { PlanPlayerIO } from "../plan-player-io.js"
import { buildEvidencePack, type EvidencePackResult } from "./organize-export.js"
import type { PlanTraceFile } from "../trace.js"
import type { GamePlanV1 } from "../game-plan-v1.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"

const data = getData(CURRENT_VERSION)
const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig

function makePlan(): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "testplan001",
    parentPlanId: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    author: "manual",
    context: { deckCode: DECK0, opponent: { kind: "mirror" } },
    predictions: {
      winRateEstimate: 0.5,
      expectedRounds: 6,
      confidence: 0.5,
      keyThreats: ["测试威胁"],
    },
    opening: {
      chooseActive: [{ characterDefId: deck0.characters[0]!, reason: "首发一号位" }],
      mulligan: [],
      reroll: [{ keepElements: ["pyro", "omni"], reason: "保留火骰与万能" }],
    },
    phases: [],
    rules: [
      { priority: 1, when: [], then: { action_case: "useSkill", kills: true }, reason: "能斩必斩" },
      {
        priority: 10,
        when: [{ field: "opponent.active.aura", op: "==", value: "none" }],
        then: { action_case: "useSkill", skill_type: "elemental_skill" },
        reason: "无附着优先挂元素",
      },
      { priority: 90, when: [{ field: "dice.total", op: "<=", value: 2 }], then: { action_case: "declareEnd" }, reason: "骰尽结束回合" },
    ],
    fallback: { policy: "conservative" },
  }
}

async function runGame(seed: number, plan: GamePlanV1, traceSignatures?: "lean") {
  const planIo = new PlanPlayerIO({
    side: 0,
    plan,
    gameData: data,
    ...(traceSignatures === "lean" ? { traceSignatures } : {}),
    trace: {
      planId: plan.planId,
      parentPlanId: plan.parentPlanId,
      side: 0,
      opponentPolicy: "baseline",
      seed,
      deckCodes: [DECK0, DECK0],
      ...(traceSignatures === "lean" ? { traceSignatures } : {}),
    },
  })
  const baselineIo = new PolicyPlayerIO({
    side: 1,
    policy: new BaselinePolicy(),
    searchOptions: { enabled: false },
  })
  const result = await new SandboxRunner().runOne([deck0, deck0], data, [planIo, baselineIo], {
    captureReplay: true,
    seed,
  })
  return { result, trace: planIo.getTraceFile() }
}

/** 组装单局 run 目录（batch-runner 产物布局子集） */
async function writeRunDir(prefix: string, game: { result: Awaited<ReturnType<typeof runGame>>["result"]; trace: PlanTraceFile }): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), prefix))
  const g1 = join(runDir, "game-0001")
  await mkdir(g1, { recursive: true })
  await writeFile(join(g1, "plan_trace.json"), `${JSON.stringify(game.trace, null, 2)}\n`, "utf-8")
  if (game.result.replayLogJson) {
    await writeFile(join(g1, "game_state_log.json"), `${JSON.stringify(game.result.replayLogJson)}\n`, "utf-8")
  }
  const summary = {
    planId: game.trace.planId,
    gameVersion: CURRENT_VERSION,
    games: 1,
    seedBase: game.trace.seed ?? 0,
    alternateFirstPlayer: false,
    wins: game.trace.summary.result === "win" ? 1 : 0,
    losses: game.trace.summary.result === "loss" ? 1 : 0,
    draws: game.trace.summary.result === "draw" ? 1 : 0,
    winRate: game.trace.summary.result === "win" ? 1 : 0,
    avgRounds: game.trace.summary.rounds,
    avgCoverage: game.trace.summary.coverage,
    fallbackRate: game.trace.summary.decisionCounts.total > 0
      ? game.trace.summary.decisionCounts.fallback / game.trace.summary.decisionCounts.total
      : 0,
    perRuleHits: game.trace.summary.perRuleHits,
    perRuleThenMiss: game.trace.summary.perRuleThenMiss,
    perGame: [{
      gameDir: "game-0001",
      seed: game.trace.seed ?? 0,
      planSide: 0,
      winner: game.trace.summary.result === "win" ? 0 : game.trace.summary.result === "loss" ? 1 : null,
      rounds: game.trace.summary.rounds,
      coverage: game.trace.summary.coverage,
      ruleMatched: game.trace.summary.decisionCounts.ruleMatched,
      fallback: game.trace.summary.decisionCounts.fallback,
      total: game.trace.summary.decisionCounts.total,
    }],
  }
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary)}\n`, "utf-8")
  return runDir
}

describe("organize-export lean run 端到端", () => {
  const SEED = 4209
  const plan = makePlan()

  it("lean run 的 stateSignatures.jsonl 与 full run 语义一致（整条签名对象逐字段相等）", async () => {
    const full = await runGame(SEED, plan)
    const lean = await runGame(SEED, plan, "lean")
    expect(lean.trace.traceSignatures).toBe("lean")

    const fullRunDir = await writeRunDir("org-exp-full-", full)
    const leanRunDir = await writeRunDir("org-exp-lean-", lean)
    const fullPack = await mkdtemp(join(tmpdir(), "org-exp-full-pack-"))
    const leanPack = await mkdtemp(join(tmpdir(), "org-exp-lean-pack-"))
    try {
      const fullResult: EvidencePackResult = await buildEvidencePack({ runDir: fullRunDir, outDir: fullPack })
      const leanResult: EvidencePackResult = await buildEvidencePack({ runDir: leanRunDir, outDir: leanPack })
      expect(fullResult.files).toContain("stateSignatures.jsonl")
      expect(leanResult.files).toContain("stateSignatures.jsonl")

      const parse = (dir: string) =>
        readFile(join(dir, "stateSignatures.jsonl"), "utf-8").then((raw) =>
          raw.split("\n").filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as { seq: number; method: string; stateSignature?: Record<string, unknown> }),
        )
      const fullLines = await parse(fullPack)
      const leanLines = await parse(leanPack)
      expect(leanLines.length).toBe(fullLines.length)
      const fullBySeq = new Map(fullLines.map((l) => [l.seq, l]))
      // lean 包的每条回填签名与 full 包同 seq 的整条签名**逐字段相等**（同 seed 确定性对局）
      let compared = 0
      for (const l of leanLines) {
        const ref = fullBySeq.get(l.seq)!
        if (l.stateSignature !== undefined) {
          expect(l.stateSignature).toEqual(ref.stateSignature)
          compared++
        }
      }
      // 至少覆盖全部 action 决策点（opening 类部分条目的中间态不在 state log 快照里，预期缺）
      const actionCount = leanLines.filter((l) => l.method === "action").length
      expect(compared).toBeGreaterThanOrEqual(actionCount)

      // fullDigest 局面摘要不因 lean 降级（action 行仍带 round digests，无解析失败标记）
      const digest = await readFile(join(leanPack, "fullDigest.txt"), "utf-8")
      expect(digest).not.toContain("(state 解析失败)")
      expect(digest).toContain("round1")
    } finally {
      await rm(fullRunDir, { recursive: true, force: true })
      await rm(leanRunDir, { recursive: true, force: true })
      await rm(fullPack, { recursive: true, force: true })
      await rm(leanPack, { recursive: true, force: true })
    }
  }, 120000)
})
