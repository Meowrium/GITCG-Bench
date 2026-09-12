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
 * reflect-portfolio 测试：D6 层路由建议纯函数（三种标注 + legacy 不标注）、
 * 组 portfolio 归档断言（一致/不一致两路 + 缺档）、组 → Single 路由判定
 * （trace.deckCodes 首选 / 对手计划备选）、portfolio 模式产物写出
 * （目录结构 + portfolio.json lineage 刷新）与产物 tag 解析。
 * 注：本模块是纯函数/装载侧，不 import run-plan-reflect（CLI 入口不可测）。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GamePlanV1 } from "../game-plan-v1.js"
import type { PlanPortfolioV1, ResolvedPortfolio } from "../portfolio.js"
import { computePortfolioId } from "../portfolio.js"
import {
  assertPortfolioGroupIds,
  buildLayerRoutingAdvice,
  portfolioTagOf,
  readPortfolioRunArchive,
  resolveGroupSingleLabel,
  writePortfolioOutputs,
  type LayerAdviceGroup,
  type WorkingPortfolio,
} from "./reflect-portfolio.js"

const DECK0 =
  "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 =
  "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

const mkPlan = (planId: string, opponent: GamePlanV1["context"]["opponent"], deckCode = DECK0): GamePlanV1 => ({
  version: "GamePlanV1",
  planId,
  parentPlanId: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  author: "manual",
  context: { deckCode, opponent },
  predictions: { winRateEstimate: 0.5, expectedRounds: 6, confidence: 0.5, keyThreats: [] },
  opening: { chooseActive: [], mulligan: [], reroll: [] },
  phases: [],
  rules: [{ priority: 1, when: [{ field: "dice.total", op: ">=", value: 0 }], then: { action_case: "declareEnd" }, reason: "通用兜底" }],
  fallback: { policy: "conservative" },
})

const general = (): GamePlanV1 => mkPlan("g10000000001", { kind: "unknown_deck" })
const single = (): GamePlanV1 => mkPlan("s10000000001", { kind: "known_deck", deckCode: DECK1 }, DECK0)

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reflect-pf-test-"))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("buildLayerRoutingAdvice（D6 k=2）", () => {
  const group = (label: string, keys: string[], singleLabel?: string): LayerAdviceGroup => {
    const perRuleHits: Record<string, number> = {}
    for (const k of keys) perRuleHits[k] = 1
    return { label, singleLabel, perRuleHits }
  }

  it("键出现在 ≥2 组 → 建议修 General（跨组共性）", () => {
    const lines = buildLayerRoutingAdvice([
      group("hongniu", ["general:global:5"]),
      group("shuining", ["general:global:5", "general:phase:burst:20"]),
    ])
    const cross = lines.find((l) => l.includes("general:global:5"))
    expect(cross).toBeDefined()
    expect(cross).toContain("出现于 2 组")
    expect(cross).toContain("建议修 General（跨组共性）")
  })

  it("键仅 1 组且带 single:<label>: 前缀 → 建议修 Single(<label>)（仅本组）", () => {
    const lines = buildLayerRoutingAdvice([
      group("hongniu", ["single:hongniu:global:5", "single:hongniu:phase:burst:20"], "hongniu"),
      group("shuining", ["general:global:5"]),
    ])
    const singleLine = lines.find((l) => l.includes("single:hongniu:global:5"))
    expect(singleLine).toBeDefined()
    expect(singleLine).toContain("建议修 Single(hongniu)（仅本组）")
  })

  it("键仅 1 组且为 general 层键 → 建议修 General（仅本组出现，注意过拟合）", () => {
    const lines = buildLayerRoutingAdvice([
      group("hongniu", ["general:global:9"]),
      group("shuining", ["general:global:5"]),
    ])
    const line = lines.find((l) => l.includes("general:global:9"))
    expect(line).toBeDefined()
    expect(line).toContain("建议修 General（仅本组出现，注意过拟合）")
    // 过拟合行不应误判为跨组共性
    expect(line).not.toContain("跨组共性")
  })

  it("legacy 无前缀键 → 不标注（旧流程不变）", () => {
    const lines = buildLayerRoutingAdvice([
      group("hongniu", ["global:5", "phase:burst:20", "opening:0"]),
      group("shuining", ["global:5"]),
    ])
    expect(lines).toEqual([])
  })

  it("多来源键并集计数（perRuleThenMiss / perRuleHits / perRuleEval）", () => {
    const lines = buildLayerRoutingAdvice([
      { label: "hongniu", perRuleThenMiss: { "general:global:7": 2 }, perRuleHits: { "general:global:5": 1 } },
      { label: "shuining", perRuleEval: { "general:global:7": { hits: 1 } } },
    ])
    const cross = lines.find((l) => l.includes("general:global:7"))
    expect(cross).toContain("出现于 2 组")
    const only = lines.find((l) => l.includes("general:global:5"))
    expect(only).toContain("仅本组出现，注意过拟合")
  })

  it("排序：跨组共性在前，同组数按字典序", () => {
    const lines = buildLayerRoutingAdvice([
      group("hongniu", ["general:global:5", "general:global:9"]),
      group("shuining", ["general:global:5"]),
    ])
    const idx5 = lines.findIndex((l) => l.includes("general:global:5"))
    const idx9 = lines.findIndex((l) => l.includes("general:global:9"))
    expect(idx5).toBeGreaterThanOrEqual(0)
    expect(idx9).toBeGreaterThanOrEqual(0)
    expect(idx5).toBeLessThan(idx9) // 跨组共性（出现于 2 组）排在单组过拟合前
  })
})

describe("组 portfolio 归档断言", () => {
  const archive = (portfolioId: string) => JSON.stringify({ version: "PlanPortfolioV1", generalPlan: "plans/general.json", portfolioId }, null, 2)

  it("两路：portfolioId 一致 → 无错误；不一致（组间）→ 报错", async () => {
    await withTempDir(async (dir) => {
      const runA = join(dir, "run-hongniu")
      const runB = join(dir, "run-shuining")
      mkdirSync(runA, { recursive: true })
      mkdirSync(runB, { recursive: true })
      writeFileSync(join(runA, "portfolio.side0.json"), archive("aaaaaaaaaaaa"), "utf-8")
      writeFileSync(join(runB, "portfolio.side0.json"), archive("aaaaaaaaaaaa"), "utf-8")
      const groups = [
        { label: "run-hongniu", archive: await readPortfolioRunArchive(runA) },
        { label: "run-shuining", archive: await readPortfolioRunArchive(runB) },
      ]
      expect(assertPortfolioGroupIds(groups, "aaaaaaaaaaaa")).toEqual([])

      // 不一致路：B 的 portfolioId 不同（重读归档——readPortfolioRunArchive 是读盘时快照）
      writeFileSync(join(runB, "portfolio.side0.json"), archive("bbbbbbbbbbbb"), "utf-8")
      const groups2 = [
        { label: "run-hongniu", archive: await readPortfolioRunArchive(runA) },
        { label: "run-shuining", archive: await readPortfolioRunArchive(runB) },
      ]
      const errors = assertPortfolioGroupIds(groups2, "aaaaaaaaaaaa")
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.some((e) => e.includes("交叉对手证据包要求同一 portfolio"))).toBe(true)
      expect(errors.some((e) => e.includes("与 --portfolio manifest 重算值 aaaaaaaaaaaa 不一致"))).toBe(true)
    })
  })

  it("组 portfolioId 与 manifest 重算值不一致（全部组同代但 manifest 新）→ 报错", async () => {
    await withTempDir(async (dir) => {
      const runA = join(dir, "run-hongniu")
      mkdirSync(runA, { recursive: true })
      writeFileSync(join(runA, "portfolio.side0.json"), archive("aaaaaaaaaaaa"), "utf-8")
      const errors = assertPortfolioGroupIds([{ label: "run-hongniu", archive: await readPortfolioRunArchive(runA) }], "deadbeef0000")
      expect(errors.some((e) => e.includes("不一致"))).toBe(true)
    })
  })

  it("缺 portfolio.side0.json → 报错（portfolio 模式要求批跑按组合模式产出）", async () => {
    await withTempDir(async (dir) => {
      const runA = join(dir, "run-hongniu")
      mkdirSync(runA, { recursive: true })
      // 不写 portfolio.side0.json
      const errors = assertPortfolioGroupIds([{ label: "run-hongniu", archive: await readPortfolioRunArchive(runA) }], "aaaaaaaaaaaa")
      expect(errors.some((e) => e.includes("缺 portfolio.side0.json"))).toBe(true)
    })
  })
})

describe("resolveGroupSingleLabel（组 → Single 路由）", () => {
  const portfolio = (): ResolvedPortfolio => ({
    manifest: { version: "PlanPortfolioV1", generalPlan: "general.json", singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }] },
    general: general(),
    generalId: "g10000000001",
    singles: [{ label: "hongniu", opponentDeckCode: DECK1, planRef: "single.json", plan: single(), planId: "s10000000001" }],
    portfolioId: "aaaaaaaaaaaa",
  })

  it("trace.deckCodes[1-side] 首选：命中 singles → 该 single label", async () => {
    await withTempDir(async (dir) => {
      const game = join(dir, "game-000")
      mkdirSync(game, { recursive: true })
      writeFileSync(join(game, "plan_trace.json"), JSON.stringify({
        version: "PlanTraceV1",
        planId: "g10000000001",
        side: 0,
        deckCodes: [DECK0, DECK1],
        entries: [],
        summary: {},
      }), "utf-8")
      expect(await resolveGroupSingleLabel(dir, 0, portfolio())).toBe("hongniu")
    })
  })

  it("trace.deckCodes 按实际执舵侧排列（alternateFirstPlayer 奇数局 side=1）", async () => {
    await withTempDir(async (dir) => {
      const game = join(dir, "game-000")
      mkdirSync(game, { recursive: true })
      // planSide=1：deckCodes = [对手牌表, 主计划牌表]
      writeFileSync(join(game, "plan_trace.json"), JSON.stringify({
        version: "PlanTraceV1",
        planId: "g10000000001",
        side: 1,
        deckCodes: [DECK1, DECK0],
        entries: [],
        summary: {},
      }), "utf-8")
      expect(await resolveGroupSingleLabel(dir, 0, portfolio())).toBe("hongniu")
    })
  })

  it("trace 无 deckCodes → 备选对手侧计划 context.deckCode；无命中 → undefined", async () => {
    await withTempDir(async (dir) => {
      const game = join(dir, "game-000")
      mkdirSync(game, { recursive: true })
      // 无 trace（或 trace 无 deckCodes）
      writeFileSync(join(game, "plan_trace.json"), JSON.stringify({
        version: "PlanTraceV1",
        planId: "g10000000001",
        side: 0,
        deckCodes: null,
        entries: [],
        summary: {},
      }), "utf-8")
      // 对手计划声明 DECK1（known_deck）→ 命中
      writeFileSync(join(dir, "plan.side1.json"), JSON.stringify(mkPlan("opp0000000001", { kind: "known_deck", deckCode: DECK1 })), "utf-8")
      expect(await resolveGroupSingleLabel(dir, 0, portfolio())).toBe("hongniu")

      // 未覆盖对手（无 trace 无对手计划）→ undefined
      const bare = join(dir, "bare")
      mkdirSync(bare, { recursive: true })
      expect(await resolveGroupSingleLabel(bare, 0, portfolio())).toBeUndefined()
    })
  })
})

describe("portfolio 模式产物写出", () => {
  const working = (): WorkingPortfolio => ({ general: general(), singles: [{ label: "hongniu", opponentDeckCode: DECK1, plan: single() }] })

  it("目录结构：plans/general.<tag>.json + plans/single.<label>.<tag>.json + portfolio.json（lineage 刷新）", async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, "out")
      const { portfolioPath, planFiles } = await writePortfolioOutputs({ outDir: out, tag: "r2", working: working() })
      // 计划文件
      expect(planFiles).toEqual(["plans/general.r2.json", "plans/single.hongniu.r2.json"])
      expect(portfolioPath).toBe(join(out, "portfolio.json"))
      const generalOnDisk = JSON.parse(readFileSync(join(out, "plans/general.r2.json"), "utf-8")) as GamePlanV1
      expect(generalOnDisk.planId).toBe("g10000000001")
      const singleOnDisk = JSON.parse(readFileSync(join(out, "plans/single.hongniu.r2.json"), "utf-8")) as GamePlanV1
      expect(singleOnDisk.planId).toBe("s10000000001")
      // 更新后的 manifest
      const manifest = JSON.parse(readFileSync(portfolioPath, "utf-8")) as PlanPortfolioV1
      expect(manifest.generalPlan).toBe("plans/general.r2.json")
      expect(manifest.singles).toEqual([{ opponentDeckCode: DECK1, label: "hongniu", planRef: "plans/single.hongniu.r2.json" }])
      expect(manifest.lineage).toEqual({ generalId: "g10000000001", singles: { hongniu: "s10000000001" } })
      // lineage 与重算一致（可被 loadPortfolioWithValidation 接受）
      expect(manifest.lineage?.generalId).toBe(generalOnDisk.planId)
    })
  })

  it("portfolioId 内容寻址：tag 只影响文件名不影响 portfolioId（lineage 刷新到同一 planId 时 id 不变）", async () => {
    await withTempDir(async (dir) => {
      const outA = join(dir, "a")
      const outB = join(dir, "b")
      await writePortfolioOutputs({ outDir: outA, tag: "r1", working: working() })
      await writePortfolioOutputs({ outDir: outB, tag: "r2", working: working() })
      const idA = computePortfolioId({ generalId: "g10000000001", singles: [{ label: "hongniu", opponentDeckCode: DECK1, planId: "s10000000001" }] })
      const idB = computePortfolioId({ generalId: "g10000000001", singles: [{ label: "hongniu", opponentDeckCode: DECK1, planId: "s10000000001" }] })
      expect(idA).toBe(idB)
    })
  })
})

describe("portfolioTagOf（产物 tag）", () => {
  it("--round N → r<N>", () => {
    const manifest: PlanPortfolioV1 = { version: "PlanPortfolioV1", generalPlan: "plans/general.r1.json", singles: [] }
    expect(portfolioTagOf({ round: 4, portfolioPath: "x/portfolio.json" }, manifest)).toBe("r4")
  })

  it("缺省：沿用 manifest generalPlan 文件名 tag（原位修订）；否则 manifest 文件名去扩展名", () => {
    const tagged: PlanPortfolioV1 = { version: "PlanPortfolioV1", generalPlan: "plans/general.r3.json", singles: [] }
    expect(portfolioTagOf({ portfolioPath: "x/portfolio.json" }, tagged)).toBe("r3")
    const plain: PlanPortfolioV1 = { version: "PlanPortfolioV1", generalPlan: "plans/general.json", singles: [] }
    expect(portfolioTagOf({ portfolioPath: "x/portfolio.json" }, plain)).toBe("portfolio")
  })
})
