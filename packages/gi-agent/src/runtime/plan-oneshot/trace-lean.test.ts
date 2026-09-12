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
 * lean trace 签名指针化单测（impl-spec-1 件 1）：
 * ① 默认 full 模式产物不变（内嵌 stateSignature、无 sigHash、无 traceSignatures 标记）；
 * ② lean 模式条目以 16 hex 短哈希指针代替整份签名，文件级 traceSignatures="lean"；
 * ③ sig-backfill 从同局 game_state_log.json 反查回填，回填签名与同 seed full 模式
 *    内嵌签名逐字节相等（语义等价性验收）；full trace 回填恒 no-op。
 */

import { describe, expect, it } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_VERSION, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { SandboxRunner } from "../../sandbox/runner.js"
import { PolicyPlayerIO } from "../io/policy-player-io.js"
import { BaselinePolicy } from "../policy/baseline-policy.js"
import { PlanPlayerIO } from "./plan-player-io.js"
import { backfillTraceSignatures, isLeanTrace } from "./sig-backfill.js"
import type { PlanTraceFile } from "./trace.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

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

describe("lean trace 签名指针化", () => {
  const SEED = 4207
  const plan = makePlan()

  it("默认 full 模式：内嵌 stateSignature、无 sigHash、无 traceSignatures 文件级标记", async () => {
    const { trace } = await runGame(SEED, plan)
    expect(trace.entries.length).toBeGreaterThan(0)
    for (const e of trace.entries) {
      expect(e.stateSignature).toBeDefined()
      expect(e.sigHash).toBeUndefined()
    }
    expect(trace.traceSignatures).toBeUndefined()
    expect(trace.sigHashAlgo).toBeUndefined()
    expect(isLeanTrace(trace)).toBe(false)
  }, 60000)

  it("lean 模式：条目无 stateSignature、带 16 hex sigHash，文件级标记 lean + sha256-16hex", async () => {
    const { trace } = await runGame(SEED, plan, "lean")
    expect(trace.traceSignatures).toBe("lean")
    expect(trace.sigHashAlgo).toBe("sha256-16hex")
    expect(trace.entries.length).toBeGreaterThan(0)
    for (const e of trace.entries) {
      expect(e.stateSignature).toBeUndefined()
      expect(e.sigHash).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(isLeanTrace(trace)).toBe(true)
  }, 60000)

  it("同 seed 双模式：除签名及其指针字段外，条目内容逐字段相等", async () => {
    const full = await runGame(SEED, plan)
    const lean = await runGame(SEED, plan, "lean")
    expect(full.trace.entries.length).toBe(lean.trace.entries.length)
    for (let i = 0; i < full.trace.entries.length; i++) {
      const a = { ...full.trace.entries[i]!, stateSignature: undefined }
      const b = { ...lean.trace.entries[i]!, sigHash: undefined }
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    }
    // 汇总与其余文件级字段一致
    expect(JSON.stringify(lean.trace.summary)).toBe(JSON.stringify(full.trace.summary))
  }, 120000)

  it("sig-backfill：lean trace 从 state log 反查，回填签名与 full 模式内嵌签名逐字节相等；full trace 恒 no-op", async () => {
    const full = await runGame(SEED, plan)
    const lean = await runGame(SEED, plan, "lean")

    // 落盘 lean 单局目录（plan_trace.json + game_state_log.json，与 batch-runner 同布局）
    const dir = await mkdtemp(join(tmpdir(), "trace-lean-"))
    try {
      await writeFile(join(dir, "plan_trace.json"), `${JSON.stringify(lean.trace, null, 2)}\n`, "utf-8")
      if (lean.result.replayLogJson) {
        await writeFile(join(dir, "game_state_log.json"), `${JSON.stringify(lean.result.replayLogJson)}\n`, "utf-8")
      }

      // full trace：回填 no-op（attempted=0，不改对象）
      const noOp = await backfillTraceSignatures(dir, full.trace)
      expect(noOp).toEqual({ attempted: 0, restored: 0, missed: 0 })

      // lean trace：回填后与 full 模式签名逐字节比对（同 seed 确定性对局）
      const disk = JSON.parse(await readFile(join(dir, "plan_trace.json"), "utf-8")) as PlanTraceFile
      const res = await backfillTraceSignatures(dir, disk)
      expect(res.attempted).toBe(lean.trace.entries.length)
      expect(res.restored + res.missed).toBe(res.attempted)
      // 全部 action 决策点可反查（引擎 pause/notify 边界差异 <10%，与 full 模式
      // loadAlignedGameInput 对齐口径一致——见 plan-player-io.test 同阈值）
      const actions = disk.entries.filter((e) => e.method === "action")
      const missedActions = actions.filter((e) => e.stateSignature === undefined).length
      expect(missedActions / Math.max(1, actions.length)).toBeLessThan(0.1)
      // 未回填条目只允许出现在 opening 类（其决策中间态本就不在 state log 快照里，
      // roll 暂停点先于掷骰 mutation——full 模式 eval 对齐同样不覆盖这些点）
      for (const e of disk.entries) {
        if (e.stateSignature === undefined) expect(e.method).not.toBe("action")
      }
      const fullBySeq = new Map(full.trace.entries.map((e) => [e.seq, e]))
      for (const e of disk.entries) {
        // 回填成功的条目：签名 === full 模式内嵌签名（逐字节）；未回填条目
        // （引擎 pause/notify 边界差异）full 模式同样对不齐，由 missed 比例断言覆盖
        if (e.stateSignature !== undefined) {
          const ref = fullBySeq.get(e.seq)!
          expect(e.stateSignature).toBe(ref.stateSignature)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120000)

  it("sig-backfill：state log 缺失时按全部 missed 处理（不抛错）", async () => {
    const lean = await runGame(SEED, plan, "lean")
    const dir = await mkdtemp(join(tmpdir(), "trace-lean-nolog-"))
    try {
      await writeFile(join(dir, "plan_trace.json"), JSON.stringify(lean.trace), "utf-8")
      const res = await backfillTraceSignatures(dir, lean.trace)
      expect(res.attempted).toBe(lean.trace.entries.length)
      expect(res.restored).toBe(0)
      expect(res.missed).toBe(res.attempted)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})
