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
 * portfolio 测试：computePortfolioId 内容寻址稳定性、loadPortfolioWithValidation
 * 的 G8 校验（硬错误 + lint 警告）、routeSingle 命中/未命中。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computePortfolioId,
  loadPortfolioWithValidation,
  routeSingle,
  type PlanPortfolioV1,
} from "./portfolio.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

const DECK0 =
  "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 =
  "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

const generalPlan = (): GamePlanV1 => ({
  version: "GamePlanV1",
  planId: "aa0000000001",
  parentPlanId: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  author: "manual",
  context: { deckCode: DECK0, opponent: { kind: "unknown_deck" } },
  predictions: { winRateEstimate: 0.5, expectedRounds: 6, confidence: 0.5, keyThreats: [] },
  opening: { chooseActive: [], mulligan: [], reroll: [] },
  phases: [],
  rules: [
    {
      priority: 1,
      when: [{ field: "dice.total", op: ">=", value: 0 }],
      then: { action_case: "declareEnd" },
      reason: "通用兜底",
    },
  ],
  fallback: { policy: "conservative" },
})

const singlePlan = (): GamePlanV1 => ({
  ...generalPlan(),
  planId: "bb0000000001",
  context: { deckCode: DECK0, opponent: { kind: "known_deck", deckCode: DECK1 } },
  rules: [
    {
      priority: 5,
      when: [{ field: "dice.total", op: ">=", value: 0 }],
      then: { action_case: "elementalTuning" },
      reason: "对红牛专用调和",
    },
  ],
  fallback: { policy: "declare_end" },
})

const manifest = (singles: PlanPortfolioV1["singles"]): PlanPortfolioV1 => ({
  version: "PlanPortfolioV1",
  generalPlan: "general.json",
  singles,
})

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "portfolio-test-"))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeJson = (dir: string, rel: string, value: unknown): void => {
  writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

/** 标准 happy-path 布局：general.json + single.json + portfolio.json */
const writeFixtures = (dir: string, m: PlanPortfolioV1, general?: GamePlanV1, single?: GamePlanV1): void => {
  writeJson(dir, "general.json", general ?? generalPlan())
  writeJson(dir, "single.json", single ?? singlePlan())
  writeJson(dir, "portfolio.json", m)
}

describe("computePortfolioId", () => {
  it("与 singles 数组顺序无关；12 位 hex；generalId 变化则变化", () => {
    const a = computePortfolioId({
      generalId: "g-1",
      singles: [
        { label: "hongniu", opponentDeckCode: DECK1, planId: "s-1" },
        { label: "lingren", opponentDeckCode: DECK0, planId: "s-2" },
      ],
    })
    const b = computePortfolioId({
      generalId: "g-1",
      singles: [
        { label: "lingren", opponentDeckCode: DECK0, planId: "s-2" },
        { label: "hongniu", opponentDeckCode: DECK1, planId: "s-1" },
      ],
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    const c = computePortfolioId({
      generalId: "g-2",
      singles: [
        { label: "hongniu", opponentDeckCode: DECK1, planId: "s-1" },
        { label: "lingren", opponentDeckCode: DECK0, planId: "s-2" },
      ],
    })
    expect(c).not.toBe(a)
  })
})

describe("loadPortfolioWithValidation", () => {
  it("happy path：label 缺省=opponentDeckCode；portfolioId 自洽；routeSingle 命中/未命中", async () => {
    await withTempDir(async (dir) => {
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "single.json" }]))
      const { portfolio, warnings } = await loadPortfolioWithValidation(join(dir, "portfolio.json"))
      // fixture 未声明 context.gameVersion → 允许 V0 版本钉扎 advisory warning，其余 warning 为空
      expect(warnings.filter((w) => !w.includes("context.gameVersion"))).toEqual([])
      expect(portfolio.general.context.opponent.kind).toBe("unknown_deck")
      expect(portfolio.generalId).toBe("aa0000000001")
      expect(portfolio.singles).toHaveLength(1)
      expect(portfolio.singles[0].label).toBe(DECK1)
      expect(portfolio.singles[0].planId).toBe("bb0000000001")
      expect(portfolio.singles[0].plan.context.opponent).toEqual({ kind: "known_deck", deckCode: DECK1 })
      expect(portfolio.portfolioId).toBe(
        computePortfolioId({
          generalId: "aa0000000001",
          singles: [{ label: DECK1, opponentDeckCode: DECK1, planId: "bb0000000001" }],
        }),
      )
      expect(routeSingle(portfolio, DECK1)?.label).toBe(DECK1)
      expect(routeSingle(portfolio, DECK0)).toBeNull()
    })
  })

  it("manifest version 不符 / 非 JSON / singles 非数组 → 拒绝", async () => {
    await withTempDir(async (dir) => {
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "single.json" }]))
      writeJson(dir, "bad-version.json", { ...manifest([]), version: "PlanPortfolioV0" })
      await expect(loadPortfolioWithValidation(join(dir, "bad-version.json"))).rejects.toThrowError(
        /PlanPortfolioV1/,
      )
      writeFileSync(join(dir, "not-json.json"), "{ not json", "utf-8")
      await expect(loadPortfolioWithValidation(join(dir, "not-json.json"))).rejects.toThrowError(
        /读取失败/,
      )
      writeJson(dir, "bad-singles.json", { version: "PlanPortfolioV1", generalPlan: "general.json", singles: {} })
      await expect(loadPortfolioWithValidation(join(dir, "bad-singles.json"))).rejects.toThrowError(
        /singles 必须是数组/,
      )
    })
  })

  it("G8②：general 未声明 unknown_deck → 拒绝", async () => {
    await withTempDir(async (dir) => {
      const badGeneral = {
        ...generalPlan(),
        context: { deckCode: DECK0, opponent: { kind: "known_deck", deckCode: DECK1 } },
      } as GamePlanV1
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "single.json" }]), badGeneral)
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(
        /必须声明 context\.opponent = unknown_deck/,
      )
    })
  })

  it("G8①：single 未声明 known_deck → 拒绝", async () => {
    await withTempDir(async (dir) => {
      const badSingle = {
        ...singlePlan(),
        context: { deckCode: DECK0, opponent: { kind: "unknown_deck" } },
      } as GamePlanV1
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "single.json" }]), undefined, badSingle)
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(
        /known_deck/,
      )
    })
  })

  it("G8①：single 绑定牌组码与计划声明不符 → 拒绝", async () => {
    await withTempDir(async (dir) => {
      // manifest 绑定 DECK0，但 single.json 声明的对手是 DECK1
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK0, planRef: "single.json" }]))
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(
        /绑定一致/,
      )
    })
  })

  it("G8④：label 含 ':' / 重复 → 拒绝", async () => {
    await withTempDir(async (dir) => {
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, label: "a:b", planRef: "single.json" }]))
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(
        /label 非法/,
      )
      writeFixtures(
        dir,
        manifest([
          { opponentDeckCode: DECK1, label: "x", planRef: "single.json" },
          { opponentDeckCode: DECK1, label: "x", planRef: "single.json" },
        ]),
      )
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(/重复/)
    })
  })

  it("G8⑤：planRef 文件缺失 → 拒绝并给出路径", async () => {
    await withTempDir(async (dir) => {
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "missing.json" }]))
      await expect(loadPortfolioWithValidation(join(dir, "portfolio.json"))).rejects.toThrowError(
        /missing\.json/,
      )
    })
  })

  it("G8 lint：general 规则 when 引用 opp.hand.* → 警告（不阻断）", async () => {
    await withTempDir(async (dir) => {
      const leaky = generalPlan()
      leaky.rules = [
        {
          priority: 1,
          when: [{ field: "opp.hand.hasCardP.332101", op: ">=", value: 0.5 }],
          then: { action_case: "declareEnd" },
          reason: "泄漏对手手牌先验",
        },
      ]
      writeFixtures(dir, manifest([{ opponentDeckCode: DECK1, planRef: "single.json" }]), leaky)
      const { portfolio, warnings } = await loadPortfolioWithValidation(join(dir, "portfolio.json"))
      expect(warnings.some((w) => w.includes("opp.hand.hasCardP.332101"))).toBe(true)
      expect(portfolio.singles).toHaveLength(1)
    })
  })

  it("lineage 与解析结果不符 → 警告（不阻断，以重算为准）", async () => {
    await withTempDir(async (dir) => {
      writeFixtures(dir, {
        ...manifest([{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }]),
        lineage: { generalId: "deadbeef0000", singles: { hongniu: "deadbeef1111" } },
      })
      const { portfolio, warnings } = await loadPortfolioWithValidation(join(dir, "portfolio.json"))
      expect(warnings.some((w) => w.includes("lineage.generalId"))).toBe(true)
      expect(warnings.some((w) => w.includes('lineage.singles["hongniu"]'))).toBe(true)
      expect(portfolio.generalId).toBe("aa0000000001")
      expect(portfolio.singles[0].label).toBe("hongniu")
    })
  })
})
