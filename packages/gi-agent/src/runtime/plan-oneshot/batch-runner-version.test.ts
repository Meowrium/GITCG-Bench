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
 * 游戏版本钉扎（V0）冒烟测试：真实引擎对局 + 版本解析纯函数 + portfolio 层间版本校验。
 * 无网络、无 LLM；单局 seed 固定，确定性可复跑。
 *
 * 覆盖：
 * - runPlanBatch 落盘三处版本记录一致：state log `gv` / plan_trace `gameVersion` / summary.gameVersion；
 * - 缺省版本回归保护（gv = CURRENT_VERSION）；
 * - resolveBatchGameVersion 解析序与 force 放行（含 nn 锁定 v6.3.0）；
 * - loadPortfolioWithValidation 层间版本一致性（同版本通过 / 混合或互异报错 / 全未声明 warning）。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_VERSION, type DeckConfig, type Version } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import getData from "@gi-tcg/data"
import { loadPlanWithValidation, runPlanBatch, resolveBatchGameVersion } from "./batch-runner.js"
import { loadPortfolioWithValidation, type PlanPortfolioV1 } from "./portfolio.js"
import { validateGamePlan } from "./validate.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig

function makePlan(overrides: Partial<GamePlanV1> = {}): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "verplan0001",
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
      chooseActive: [{ characterDefId: deck0.characters[0], reason: "首发一号位" }],
      mulligan: [],
      reroll: [{ keepElements: ["pyro", "omni"], reason: "保留火骰与万能" }],
    },
    phases: [],
    rules: [
      {
        priority: 90,
        when: [{ field: "dice.total", op: "<=", value: 2 }],
        then: { action_case: "declareEnd" },
        reason: "骰尽结束回合",
      },
    ],
    fallback: { policy: "conservative" },
    ...overrides,
  }
}

/** 跑 1 局 plan vs baseline（真实引擎），返回落盘产物与 summary */
async function runOneGame(seed: number, gameVersion?: Version) {
  const dir = mkdtempSync(join(tmpdir(), "plan-batch-version-"))
  try {
    const summary = await runPlanBatch({
      plan: makePlan(),
      opponent: { type: "baseline" },
      opponentDeckCode: DECK1,
      games: 1,
      seedBase: seed,
      outDir: dir,
      ...(gameVersion !== undefined ? { gameVersion } : {}),
    })
    const stateLog = JSON.parse(await readFile(join(dir, "game-0001", "game_state_log.json"), "utf-8"))
    const trace = JSON.parse(await readFile(join(dir, "game-0001", "plan_trace.json"), "utf-8"))
    const summaryJson = JSON.parse(await readFile(join(dir, "summary.json"), "utf-8"))
    return { dir, summary, stateLog, trace, summaryJson }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("runPlanBatch 版本钉扎（真实引擎）", () => {
  it("gameVersion=v6.3.0：state log gv / trace.gameVersion / summary.gameVersion 一致", async () => {
    const { summary, stateLog, trace, summaryJson } = await runOneGame(9801, "v6.3.0")
    expect(stateLog.gv).toBe("v6.3.0")
    expect(trace.gameVersion).toBe("v6.3.0")
    expect(summary.gameVersion).toBe("v6.3.0")
    expect(summaryJson.gameVersion).toBe("v6.3.0")
    // 对局真实跑通（winner 非空，rounds > 0）
    expect(summary.wins + summary.losses + summary.draws).toBe(1)
  }, 60000)

  it("缺省版本：gv = CURRENT_VERSION（回归保护：不传时行为与现状一致）", async () => {
    const { summary, stateLog, trace } = await runOneGame(9802)
    expect(stateLog.gv).toBe(CURRENT_VERSION)
    expect(trace.gameVersion).toBe(CURRENT_VERSION)
    expect(summary.gameVersion).toBe(CURRENT_VERSION)
  }, 60000)
})

describe("resolveBatchGameVersion（解析序 config ?? plan ?? CURRENT）", () => {
  it("两侧都未设置 → CURRENT_VERSION", () => {
    const r = resolveBatchGameVersion(undefined, undefined)
    expect(r.gameVersion).toBe(CURRENT_VERSION)
    expect(r.warnings).toEqual([])
  })

  it("config 优先：config 与 plan 相同 → 该版本", () => {
    const r = resolveBatchGameVersion("v6.3.0", "v6.3.0")
    expect(r.gameVersion).toBe("v6.3.0")
    expect(r.warnings).toEqual([])
  })

  it("仅 plan 声明 → 用 plan 版本", () => {
    expect(resolveBatchGameVersion(undefined, "v6.3.0").gameVersion).toBe("v6.3.0")
  })

  it("错配：plan=v6.3.0 + config=v6.6.0 → 抛错", () => {
    expect(() => resolveBatchGameVersion("v6.6.0", "v6.3.0")).toThrowError(/冲突/)
  })

  it("force → 放行且以 config 为准（降级为 warning）", () => {
    const r = resolveBatchGameVersion("v6.6.0", "v6.3.0", { force: true })
    expect(r.gameVersion).toBe("v6.6.0")
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("v6.6.0")
  })

  it("nn：忽略 plan 声明、锁定 v6.3.0；config 给了别的值 → 报错（force 放行仍强制 v6.3.0）", () => {
    // plan 来源无关：即便 plan 声明 v6.6.0，nn 也锁 v6.3.0
    expect(resolveBatchGameVersion(undefined, "v6.6.0", { nn: true }).gameVersion).toBe("v6.3.0")
    // config 显式给了别的值 → 错配报错
    expect(() => resolveBatchGameVersion("v6.6.0", "v6.3.0", { nn: true })).toThrowError(/v6\.3\.0/)
    // force 放行：warning 说明 NN 词表限制，实际仍 v6.3.0
    const r = resolveBatchGameVersion("v6.6.0", "v6.3.0", { nn: true, force: true })
    expect(r.gameVersion).toBe("v6.3.0")
    expect(r.warnings).toHaveLength(1)
  })
})

describe("loadPortfolioWithValidation 层间版本一致性", () => {
  const writePortfolio = (
    dir: string,
    versions: { general?: string; single?: string },
  ): string => {
    const general: GamePlanV1 = {
      ...makePlan({ planId: "pfgeneral01" }),
      context: {
        deckCode: DECK0,
        opponent: { kind: "unknown_deck" },
        ...(versions.general !== undefined ? { gameVersion: versions.general } : {}),
      },
    }
    const single: GamePlanV1 = {
      ...makePlan({ planId: "pfsingle001" }),
      context: {
        deckCode: DECK0,
        opponent: { kind: "known_deck", deckCode: DECK1 },
        ...(versions.single !== undefined ? { gameVersion: versions.single } : {}),
      },
    }
    writeFileSync(join(dir, "general.json"), `${JSON.stringify(general, null, 2)}\n`, "utf-8")
    writeFileSync(join(dir, "single.json"), `${JSON.stringify(single, null, 2)}\n`, "utf-8")
    const manifest: PlanPortfolioV1 = {
      version: "PlanPortfolioV1",
      generalPlan: "general.json",
      singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }],
    }
    writeFileSync(join(dir, "portfolio.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
    return join(dir, "portfolio.json")
  }

  const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "portfolio-version-"))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("各层全部声明且相同 → 通过，commonGameVersion 注入", async () => {
    await withTempDir(async (dir) => {
      const path = writePortfolio(dir, { general: "v6.3.0", single: "v6.3.0" })
      const { portfolio, warnings } = await loadPortfolioWithValidation(path)
      expect(portfolio.commonGameVersion).toBe("v6.3.0")
      expect(warnings.some((w) => w.includes("context.gameVersion"))).toBe(false)
    })
  })

  it("互不相同 → 硬错误", async () => {
    await withTempDir(async (dir) => {
      const path = writePortfolio(dir, { general: "v6.3.0", single: "v6.6.0" })
      await expect(loadPortfolioWithValidation(path)).rejects.toThrowError(/不一致/)
    })
  })

  it("混合（有的声明有的没声明）→ 硬错误", async () => {
    await withTempDir(async (dir) => {
      const path = writePortfolio(dir, { general: "v6.3.0", single: undefined })
      await expect(loadPortfolioWithValidation(path)).rejects.toThrowError(/不一致/)
    })
  })

  it("全未声明 → 放行 + warning（建议钉版本）", async () => {
    await withTempDir(async (dir) => {
      const path = writePortfolio(dir, { general: undefined, single: undefined })
      const { portfolio, warnings } = await loadPortfolioWithValidation(path)
      expect(portfolio.commonGameVersion).toBeUndefined()
      expect(warnings.some((w) => w.includes("context.gameVersion") && w.includes("未声明"))).toBe(true)
    })
  })

  it("force → 互不相同降级为 warning，commonGameVersion 回退 undefined", async () => {
    await withTempDir(async (dir) => {
      const path = writePortfolio(dir, { general: "v6.3.0", single: "v6.6.0" })
      const { portfolio, warnings } = await loadPortfolioWithValidation(path, { force: true })
      expect(portfolio.commonGameVersion).toBeUndefined()
      expect(warnings.some((w) => w.includes("--force"))).toBe(true)
    })
  })
})

describe("validateGamePlan 版本存在性（V1）", () => {
  // 313010（膨膨兽特技）.since("v6.5.0")——v6.3.0 数据中不存在（data/src/cards/equipment/techniques.ts）
  const FUTURE_CARD = 313010

  it("data=v6.3.0 + 牌表含该版本不存在的卡 → issue", () => {
    const result = validateGamePlan(makePlan(), {
      deck: { characters: [...deck0.characters], cards: [FUTURE_CARD] },
      data: getData("v6.3.0"),
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.path === "context.deckCode" && i.message.includes(`card ${FUTURE_CARD}`))).toBe(true)
  })

  it("data=v6.3.0 + 牌表角色卡牌都在该版本存在 → 通过", () => {
    const result = validateGamePlan(makePlan(), {
      deck: { characters: [...deck0.characters], cards: [...deck0.cards] },
      data: getData("v6.3.0"),
    })
    expect(result.ok).toBe(true)
  })

  it("无 data ctx：同牌表通过（现状回归——不声明版本时不做存在性校验）", () => {
    const result = validateGamePlan(makePlan(), {
      deck: { characters: [...deck0.characters], cards: [FUTURE_CARD] },
    })
    expect(result.ok).toBe(true)
  })

  it("context.gameVersion 非法版本串 → issue（不依赖 data ctx）", () => {
    const result = validateGamePlan(
      makePlan({ context: { deckCode: DECK0, opponent: { kind: "mirror" }, gameVersion: "v9.9.9" } }),
      { deck: { characters: [...deck0.characters], cards: [...deck0.cards] } },
    )
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.path === "context.gameVersion" && i.message.includes("v9.9.9"))).toBe(true)
  })
})

describe("loadPlanWithValidation 版本感知（V1）", () => {
  const withPlanFile = async (plan: GamePlanV1, fn: (path: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "load-plan-version-"))
    try {
      const path = join(dir, "plan.json")
      writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf-8")
      await fn(path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("声明非法版本 → 抛错并列出可用版本", async () => {
    await withPlanFile(
      { ...makePlan(), context: { deckCode: DECK0, opponent: { kind: "mirror" }, gameVersion: "v9.9.9" } },
      async (path) => {
        await expect(loadPlanWithValidation(path)).rejects.toThrowError(/未知游戏版本 "v9\.9\.9"/)
      },
    )
  })

  it("声明 v6.3.0 且牌表在该版本存在 → 通过", async () => {
    await withPlanFile(
      { ...makePlan(), context: { deckCode: DECK0, opponent: { kind: "mirror" }, gameVersion: "v6.3.0" } },
      async (path) => {
        const plan = await loadPlanWithValidation(path)
        expect(plan.context.gameVersion).toBe("v6.3.0")
      },
    )
  })
})
