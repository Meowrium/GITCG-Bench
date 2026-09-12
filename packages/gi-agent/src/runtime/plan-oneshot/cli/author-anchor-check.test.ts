// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

/**
 * 锚点断言机检测试：牌表存在性 / 费用断言 vs 卡面费用 / damage vs 基础伤害+2 /
 * dynamic 跳过 / 干净通过；含真实 @gi-tcg/data 事实表的雷神爆发回归用例。
 * 另覆盖首轮合规账：issue 机械归类（categorizeAnchorIssue）与旁档增量字段
 * （attempts / firstAttemptIssues）序列化。
 */

import { describe, expect, it } from "vitest"
import { buildCardFaceTable, type CardFaceDef, type CardFaceTable } from "../card-face-table.js"
import {
  ANCHOR_ASSERTIONS_VERSION,
  buildAnchorAssertionsSidecar,
  categorizeAnchorIssue,
  checkAnchorAssertions,
  parseCostAssertion,
  type AnchorCheckDeck,
} from "./author-anchor-check.js"

const DECK: AnchorCheckDeck = { characters: [1407], cards: [214071, 214072] }

function skill(over: Partial<CardFaceDef> & Pick<CardFaceDef, "defId" | "skillType">): CardFaceDef {
  return {
    kind: "skill",
    sourceFile: "characters/electro/raiden_shogun.ts",
    costs: [],
    damage: [],
    heal: [],
    dynamic: false,
    skillIds: [],
    ...over,
  }
}

/** 桩表：1407 的 burst = 3雷+2充能 / 基础 3 雷伤；elemental = 2雷 / 基础 2；normal 动态 */
function stubTable(): CardFaceTable {
  const burst = skill({ defId: 14073, skillType: "burst", costs: [{ element: "electro", count: 3 }, { element: "energy", count: 2 }], damage: [{ type: "Electro", value: 3 }] })
  const elemental = skill({ defId: 14072, skillType: "elemental", costs: [{ element: "electro", count: 2 }], damage: [{ type: "Electro", value: 2 }] })
  const normal = skill({ defId: 14071, skillType: "normal", costs: [{ element: "electro", count: 1 }, { element: "void", count: 1 }], dynamic: true })
  const byType: Record<string, CardFaceDef> = { burst, elemental, normal }
  return {
    gameVersion: "v6.6.0",
    size: 3,
    get: (id) => [burst, elemental, normal].find((d) => d.defId === id),
    skillsOf: () => [normal, elemental, burst],
    skillOfType: (_char, type) => byType[type],
    baseDamageOf: (id) => {
      const d = byType[Object.keys(byType).find((k) => byType[k].defId === id) ?? ""]
      return d && !d.dynamic ? d.damage[0] : undefined
    },
  }
}

describe("parseCostAssertion（牌表费用原样格式）", () => {
  it("解析 3雷 / 2无色+1充能 / 全角与顿号分隔", () => {
    expect(parseCostAssertion("3雷")).toMatchObject({ diceTotal: 3, energy: 0, text: "3雷" })
    expect(parseCostAssertion("2无色+1充能")).toMatchObject({ diceTotal: 2, energy: 1, text: "2无色+1充能" })
    expect(parseCostAssertion("2 雷＋1充能")).toMatchObject({ diceTotal: 2, energy: 1 })
    expect(parseCostAssertion("3雷、2充能")).toMatchObject({ diceTotal: 3, energy: 2 })
    expect(parseCostAssertion("3electro+2energy")).toMatchObject({ diceTotal: 3, energy: 2 })
  })

  it("零费形态 0费 可解析（空费用展示），与零费技能一致", () => {
    expect(parseCostAssertion("0费")).toMatchObject({ diceTotal: 0, energy: 0, text: "0费" })
    const table = stubTable()
    const zero: CardFaceTable = {
      ...table,
      skillsOf: () => [skill({ defId: 99002, skillType: "burst", costs: [], damage: [{ type: "Electro", value: 1 }] })],
    }
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "被动", damage: 1, skillType: "burst", costAssertion: "0费" }],
    }, DECK, zero)
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("ok")
  })

  it("无法解析：未知标签 / 缺数字 / 空串", () => {
    expect(parseCostAssertion("四个雷")).toBeNull()
    expect(parseCostAssertion("雷")).toBeNull()
    expect(parseCostAssertion("")).toBeNull()
    expect(parseCostAssertion("3骰子")).toBeNull()
  })
})

describe("checkAnchorAssertions", () => {
  it("牌表外引用：combo 前提卡牌与 killMath 角色均报 issue（#18 类前提缺失）", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1602, source: "大扫除", damage: 4 }],
      comboLines: [{ name: "奥兹追击", sequence: ["菲谢尔 E"], requiredCardDefIds: [113021], diceNeeded: "3雷" }],
    }, DECK, stubTable())
    expect(r.issues.map((i) => i.path)).toEqual(["killMath[0].characterDefId", "comboLines[0].requiredCardDefIds[0]"])
    expect(r.issues[0].message).toContain("is not in the deck's characters")
    expect(r.issues[1].message).toContain("is not in the deck (deck cards")
    expect(r.killMath[0].status).toBe("issue")
    expect(r.comboLines[0].status).toBe("issue")
  })

  it("费用断言不一致：4雷 vs 卡面 3雷+2充能 → issue（雷神 Q 记错费用的回归用例）", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "奥义·梦想真说", damage: 3, skillType: "burst", costAssertion: "4雷" }],
    }, DECK, stubTable())
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].path).toBe("killMath[0].costAssertion")
    expect(r.issues[0].message).toContain("dice total 4 ≠ card-face 3")
    expect(r.issues[0].message).toContain("energy cost 0 ≠ card-face 2")
  })

  it("费用断言一致（含充能）与等价写法（2雷+1无色 ≈ 3雷）都放行", () => {
    const ok = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 5, skillType: "burst", costAssertion: "3雷+2充能" }],
    }, DECK, stubTable())
    expect(ok.issues).toEqual([])
    expect(ok.killMath[0].status).toBe("ok")

    const equivalent = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "E", damage: 4, skillType: "elemental", costAssertion: "1雷+1无色" }],
    }, DECK, stubTable())
    expect(equivalent.issues).toEqual([])
  })

  it("元素构成错误：2雷 无法支付卡面 1雷+1冰 → issue", () => {
    const special = skill({ defId: 99001, skillType: "burst", costs: [{ element: "electro", count: 1 }, { element: "cryo", count: 1 }], damage: [{ type: "Electro", value: 2 }] })
    const patched: CardFaceTable = {
      ...stubTable(),
      skillsOf: () => [special],
      baseDamageOf: () => ({ type: "Electro", value: 2 }),
    }
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 2, skillType: "burst", costAssertion: "2雷" }],
    }, DECK, patched)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].message).toContain("cryo dice insufficient")
  })

  it("damage 超过基础伤害 +2 → issue；等于 +2 放行", () => {
    const over = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 6, skillType: "burst", costAssertion: "3雷+2充能" }],
    }, DECK, stubTable())
    expect(over.issues.map((i) => i.path)).toEqual(["killMath[0].damage"])
    expect(over.issues[0].message).toContain("exceeds the skill's base damage 3 + 2")

    const edge = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 5, skillType: "burst", costAssertion: "3雷+2充能" }],
    }, DECK, stubTable())
    expect(edge.issues).toEqual([])
    expect(edge.killMath[0].status).toBe("ok")
  })

  it("dynamic 技能：基础伤害不可静态判定 → 不报 issue，记 unchecked", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "普攻", damage: 9, skillType: "normal", costAssertion: "2雷" }],
    }, DECK, stubTable())
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("ok")
    expect(r.unchecked.join("\n")).toContain("damage is dynamic")
  })

  it("缺 skillType / 缺 costAssertion / 缺 requiredCardDefIds → unchecked 而非 issue", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 3 }],
      comboLines: [{ name: "combo" }],
    }, DECK, stubTable())
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("unchecked")
    expect(r.comboLines[0].status).toBe("unchecked")
    expect(r.unchecked.some((u) => u.includes("no skillType provided"))).toBe(true)
    expect(r.unchecked.some((u) => u.includes("no requiredCardDefIds provided"))).toBe(true)
  })

  it("技能无法解析（角色不在牌表/事实表无此技能）→ unchecked，不误报费用/伤害", () => {
    const empty: CardFaceTable = {
      gameVersion: "v6.6.0",
      size: 0,
      get: () => undefined,
      skillsOf: () => [],
      skillOfType: () => undefined,
      baseDamageOf: () => undefined,
    }
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 5, skillType: "burst", costAssertion: "4雷" }],
    }, DECK, empty)
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("unchecked")
    expect(r.unchecked.some((u) => u.includes("card-face table is empty"))).toBe(true)
  })

  it("无法解析的 costAssertion 与非法 skillType → issue（格式可修）", () => {
    const r = checkAnchorAssertions({
      killMath: [
        { characterDefId: 1407, source: "Q", damage: 3, skillType: "burst", costAssertion: "四个雷" },
        { characterDefId: 1407, source: "E", damage: 2, skillType: "被动" },
      ],
    }, DECK, stubTable())
    expect(r.issues.map((i) => i.path)).toEqual(["killMath[0].costAssertion", "killMath[1].skillType"])
    expect(r.issues[0].message).toContain("cannot be parsed")
  })

  it("skillType 接受新三值（normal_attack|elemental_skill|burst）与旧两值（normal|elemental）", () => {
    const cases: Array<{ skillType: string; costAssertion: string }> = [
      { skillType: "burst", costAssertion: "3雷+2充能" },
      { skillType: "elemental_skill", costAssertion: "2雷" },
      { skillType: "elemental", costAssertion: "2雷" },
      { skillType: "normal_attack", costAssertion: "1雷+1无色" },
    ]
    for (const c of cases) {
      const r = checkAnchorAssertions({ killMath: [{ characterDefId: 1407, source: "s", damage: 1, ...c }] }, DECK, stubTable())
      expect(r.issues, c.skillType).toEqual([])
    }
    const bad = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "s", damage: 1, skillType: "normalAttack" }],
    }, DECK, stubTable())
    expect(bad.issues.map((i) => i.path)).toEqual(["killMath[0].skillType"])
  })

  it("killMath 不是数组 → issue；comboLines 缺席不报错", () => {
    const r = checkAnchorAssertions({ killMath: "3雷" }, DECK, stubTable())
    expect(r.issues.map((i) => i.path)).toEqual(["killMath"])
    expect(r.comboLines).toEqual([])
  })

  it("旁档可直接回喂（归一化断言再校核幂等）", () => {
    const first = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "Q", damage: 3, skillType: "burst", costAssertion: "4雷" }],
      comboLines: [{ name: "combo", requiredCardDefIds: [214071] }],
    }, DECK, stubTable())
    const sidecar = buildAnchorAssertionsSidecar({ check: first, deckCode: "deck-code", checkedAt: "2026-09-08T00:00:00.000Z" })
    expect(sidecar.version).toBe(ANCHOR_ASSERTIONS_VERSION)
    const second = checkAnchorAssertions(sidecar, DECK, stubTable())
    expect(second.issues.map((i) => i.path)).toEqual(first.issues.map((i) => i.path))
    expect(second.killMath[0].status).toBe("issue")
    expect(second.comboLines[0].status).toBe("ok")
  })
})

describe("checkAnchorAssertions（真实 @gi-tcg/data 事实表）", () => {
  const table = buildCardFaceTable()
  const deck: AnchorCheckDeck = { characters: [1407], cards: [214071] }
  const variantDeck: AnchorCheckDeck = { characters: [1407, 1703, 2201, 1401], cards: [214071] }

  it("雷神爆发：costAssertion 3雷+2充能 通过，4雷 报不一致", () => {
    const ok = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "奥义·梦想真说", damage: 3, skillType: "burst", costAssertion: "3雷+2充能" }],
    }, deck, table)
    expect(ok.issues).toEqual([])

    const bad = checkAnchorAssertions({
      killMath: [{ characterDefId: 1407, source: "奥义·梦想真说", damage: 3, skillType: "burst", costAssertion: "4雷" }],
    }, deck, table)
    expect(bad.issues).toHaveLength(1)
    expect(bad.issues[0].path).toBe("killMath[0].costAssertion")
    expect(bad.issues[0].message).toContain('card-face cost "3雷+2充能"')
    expect(bad.killMath[0].status).toBe("issue")
  })

  it("纳西妲两个元素战技（17032 3草 / 17033 5草）：任一变体匹配即通过", () => {
    const tathata = checkAnchorAssertions({
      killMath: [{ characterDefId: 1703, source: "所闻遍计·真如", damage: 3, skillType: "elemental_skill", costAssertion: "5草" }],
    }, variantDeck, table)
    expect(tathata.issues).toEqual([])
    expect(tathata.killMath[0].status).toBe("ok")

    // 旧两值写法同样放行
    const legacy = checkAnchorAssertions({
      killMath: [{ characterDefId: 1703, source: "所闻遍计·真如", damage: 3, skillType: "elemental", costAssertion: "5草" }],
    }, variantDeck, table)
    expect(legacy.issues).toEqual([])

    // 命中另一变体（3草）也放行
    const base = checkAnchorAssertions({
      killMath: [{ characterDefId: 1703, source: "所闻遍计", damage: 2, skillType: "elemental_skill", costAssertion: "3草" }],
    }, variantDeck, table)
    expect(base.issues).toEqual([])

    // 纯水精灵两个水战技（22012 3水 / 22013 5水）同口径
    const hydro = checkAnchorAssertions({
      killMath: [{ characterDefId: 2201, source: "纯水精灵元素战技", damage: 2, skillType: "elemental_skill", costAssertion: "5水" }],
    }, variantDeck, table)
    expect(hydro.issues).toEqual([])
  })

  it("纳西妲：7草 全部变体都不匹配 → issue，文案列出各变体费用", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1703, source: "所闻遍计·真如", damage: 3, skillType: "elemental_skill", costAssertion: "7草" }],
    }, variantDeck, table)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].path).toBe("killMath[0].costAssertion")
    expect(r.issues[0].message).toContain("card-face costs: 3草 (skill 17032) / 5草 (skill 17033)")
    expect(r.killMath[0].status).toBe("issue")
  })

  it("纯水精灵爆发为动态伤害：断言总值不拦截（unchecked + detail 注明 dynamic）", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 2201, source: "潮涌与激流", damage: 6, skillType: "burst" }],
    }, variantDeck, table)
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("unchecked")
    expect(r.killMath[0].detail).toContain("dynamic")
    expect(r.unchecked.join("\n")).toContain("damage is dynamic")
  })

  it("菲谢尔普攻 base 2：damage=5 无 reactionPrereq → 仍 issue", () => {
    const r = checkAnchorAssertions({
      killMath: [{ characterDefId: 1401, source: "夜巡影翼", damage: 5, skillType: "normal_attack" }],
    }, variantDeck, table)
    expect(r.issues.map((i) => i.path)).toEqual(["killMath[0].damage"])
    expect(r.killMath[0].status).toBe("issue")
  })

  it("菲谢尔普攻 base 2：damage=5 带 reactionPrereq → 不报，unchecked 且 detail 含原文", () => {
    const r = checkAnchorAssertions({
      killMath: [{
        characterDefId: 1401,
        source: "夜巡影翼",
        damage: 5,
        skillType: "normal_attack",
        reactionPrereq: "quicken +1, Oz +2",
      }],
    }, variantDeck, table)
    expect(r.issues).toEqual([])
    expect(r.killMath[0].status).toBe("unchecked")
    expect(r.killMath[0].detail).toContain("asserted with reactionPrereq (quicken +1, Oz +2); boosted total not statically verifiable")
    expect(r.killMath[0].reactionPrereq).toBe("quicken +1, Oz +2")
  })
})

describe("categorizeAnchorIssue（首轮合规率机械归类）", () => {
  it("机检文案 → 五类（含 damage 非数值这类纪律问题，不做兜底）", () => {
    const cases: Array<[string, string, string]> = [
      ["killMath[0].damage", "damage is missing or not a number", "missing-number"],
      ["killMath[0].characterDefId", "characterDefId is missing or not a number", "missing-number"],
      ["killMath[0].costAssertion", 'costAssertion "4雷" does not match the card-face cost "3雷+2充能": dice total 4 ≠ card-face 3; energy cost 0 ≠ card-face 2', "cost-mismatch"],
      ["killMath[0].costAssertion", 'costAssertion "四个雷" cannot be parsed — copy the deck-detail cost verbatim (number + element, e.g. "3雷" / "2无色+1充能", terms joined with +)', "cost-mismatch"],
      ["killMath[0].damage", "damage=6 exceeds the skill's base damage 3 + 2 (reaction/buff allowance) — if it relies on a specific reaction/equipment bonus, state that in reactionPrereq", "damage-over-allowance"],
      ["killMath[1].damage", "damage=6 exceeds the base damage + 2 of every literal variant of this burst skill (card-face bases: 3 (skill 14073)) — …", "damage-over-allowance"],
      ["killMath[0].characterDefId", "character 1602 is not in the deck's characters (deck characters: 1407) — the anchor premise references a character the deck does not have", "not-in-deck"],
      ["comboLines[0].requiredCardDefIds[0]", "defId 113021 is not in the deck (deck cards: 214071) — the combo premise references a card the deck does not have", "not-in-deck"],
      ["killMath[0].skillType", 'skillType "normalAttack" is invalid (allowed: normal_attack|elemental_skill|burst)', "other"],
      ["", "output is not valid JSON", "other"],
    ]
    for (const [path, message, category] of cases) {
      expect(categorizeAnchorIssue(path, message), `${path}: ${message}`).toBe(category)
    }
  })

  it("归类只看固定措辞，不看 path 语义（costAssertion 之外的 damage 超量优先 damage 类）", () => {
    expect(categorizeAnchorIssue("killMath[0].damage", "damage=6 exceeds the base damage + 2")).toBe("damage-over-allowance")
    expect(categorizeAnchorIssue("killMath[0].damage", "no literal ground truth")).toBe("other")
  })
})

describe("buildAnchorAssertionsSidecar（首轮合规字段，增量 schema）", () => {
  const OK_ANCHOR = {
    killMath: [{ characterDefId: 1407, source: "Q", damage: 5, skillType: "burst", costAssertion: "3雷+2充能" }],
  }

  it("首轮即过：attempts=1，firstAttemptIssues 为空数组（JSON 往返不丢键）", () => {
    const check = checkAnchorAssertions(OK_ANCHOR, DECK, stubTable())
    expect(check.issues).toEqual([])
    const sidecar = buildAnchorAssertionsSidecar({ check, deckCode: "deck-code", checkedAt: "2026-09-09T00:00:00.000Z" })
    expect(sidecar.attempts).toBe(1)
    expect(sidecar.firstAttemptIssues).toEqual([])
    const roundTripped = JSON.parse(JSON.stringify(sidecar)) as { attempts?: number; firstAttemptIssues?: unknown[] }
    expect(roundTripped.attempts).toBe(1)
    expect(roundTripped.firstAttemptIssues).toEqual([])
  })

  it("首轮失败：attempts=2，firstAttemptIssues 带 path/category/message 且逐条归类", () => {
    const failed = checkAnchorAssertions({
      killMath: [
        { characterDefId: 1602, source: "大扫除", damage: 4, skillType: "burst" },
        { characterDefId: 1407, source: "Q", damage: "很多", skillType: "burst", costAssertion: "4雷" },
      ],
    }, DECK, stubTable())
    expect(failed.issues.map((i) => i.path)).toEqual([
      "killMath[0].characterDefId",
      "killMath[1].costAssertion",
      "killMath[1].damage",
    ])
    const sidecar = buildAnchorAssertionsSidecar({
      check: checkAnchorAssertions(OK_ANCHOR, DECK, stubTable()),
      deckCode: "deck-code",
      attempts: 2,
      firstAttemptIssues: failed.issues,
      checkedAt: "2026-09-09T00:00:00.000Z",
    })
    expect(sidecar.attempts).toBe(2)
    expect(sidecar.firstAttemptIssues?.map((i) => i.category)).toEqual(["not-in-deck", "cost-mismatch", "missing-number"])
    expect(sidecar.firstAttemptIssues?.[0]).toMatchObject({ path: "killMath[0].characterDefId", category: "not-in-deck" })
    expect(sidecar.firstAttemptIssues?.[2].message).toContain("missing or not a number")
  })

  it("旧旁档（无 attempts/firstAttemptIssues 键）仍可回喂重算，新字段不影响判定", () => {
    const legacy = {
      version: ANCHOR_ASSERTIONS_VERSION,
      deckCode: "deck-code",
      killMath: [{ index: 0, characterDefId: 1407, source: "Q", damage: 6, skillType: "burst", costAssertion: "3雷+2充能", reactionPrereq: null, status: "issue", detail: "" }],
      comboLines: [],
      unchecked: [],
      checkedAt: "2026-09-08T00:00:00.000Z",
    }
    expect("attempts" in legacy).toBe(false)
    expect("firstAttemptIssues" in legacy).toBe(false)
    const r = checkAnchorAssertions(legacy, DECK, stubTable())
    expect(r.issues.map((i) => i.path)).toEqual(["killMath[0].damage"])
    expect(categorizeAnchorIssue(r.issues[0].path, r.issues[0].message)).toBe("damage-over-allowance")
  })
})
