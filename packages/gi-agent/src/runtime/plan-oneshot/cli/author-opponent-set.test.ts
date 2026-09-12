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
 * author-opponent-set 测试：--opponent-set 文件解析（JSON 数组 / { opponents } /
 * 换行文本 + 垃圾输入）、prompt 注入结构（全部对手与稳健性纪律段落）。
 */

import { describe, expect, it } from "vitest"
import {
  buildOpponentSetPromptSections,
  GENERAL_ROBUSTNESS_DISCIPLINE,
  parseOpponentSetFile,
} from "./author-opponent-set.js"

const CODE_A = "AAAA-aaaaaaaaaa"
const CODE_B = "BBBB-bbbbbbbbbb"

describe("parseOpponentSetFile：三种格式 + 垃圾", () => {
  it("JSON 数组", () => {
    expect(parseOpponentSetFile(JSON.stringify([CODE_A, CODE_B]))).toEqual({ ok: true, codes: [CODE_A, CODE_B] })
  })

  it("JSON 对象 { opponents: [...] }", () => {
    expect(parseOpponentSetFile(JSON.stringify({ opponents: [CODE_A, CODE_B] }))).toEqual({ ok: true, codes: [CODE_A, CODE_B] })
  })

  it("换行文本（每行一个 deckCode；空行与 # 注释忽略）", () => {
    const text = `${CODE_A}\n\n# 这是注释\n${CODE_B}   \n# 另一条注释\n`
    expect(parseOpponentSetFile(text)).toEqual({ ok: true, codes: [CODE_A, CODE_B] })
  })

  it("去重（保持首现顺序）", () => {
    expect(parseOpponentSetFile([CODE_A, CODE_B, CODE_A].join("\n"))).toEqual({ ok: true, codes: [CODE_A, CODE_B] })
  })

  it("垃圾输入 → 报错", () => {
    expect(parseOpponentSetFile("")).toEqual({ ok: false, error: expect.stringContaining("为空") })
    expect(parseOpponentSetFile("   \n  ")).toEqual({ ok: false, error: expect.stringContaining("为空") })
    expect(parseOpponentSetFile("[1,2,3]")).toEqual({ ok: false, error: expect.stringContaining("非字符串") })
    expect(parseOpponentSetFile('{"nope": []}')).toEqual({ ok: false, error: expect.stringContaining("opponents") })
    expect(parseOpponentSetFile("{ not json")).toEqual({ ok: false, error: expect.stringContaining("解析失败") })
    expect(parseOpponentSetFile("# 只有注释")).toEqual({ ok: false, error: expect.stringContaining("为空") })
  })
})

describe("buildOpponentSetPromptSections：prompt 注入结构", () => {
  it("含全部对手一节 + 稳健性纪律段落", () => {
    const sections = buildOpponentSetPromptSections([CODE_A, CODE_B], (code) => `DETAIL:${code}`)
    expect(sections.length).toBe(4) // 标题 + 2 对手 + 纪律
    expect(sections[0]).toContain("对手集合")
    expect(sections[0]).toContain("2 个对手")
    expect(sections[1]).toContain(CODE_A)
    expect(sections[1]).toContain("DETAIL:" + CODE_A)
    expect(sections[2]).toContain(CODE_B)
    expect(sections[2]).toContain("DETAIL:" + CODE_B)
    expect(sections[3]).toBe(GENERAL_ROBUSTNESS_DISCIPLINE)
  })

  it("稳健性纪律：明牌先验可用、不得引用单对手 defId、声明 unknown_deck", () => {
    expect(GENERAL_ROBUSTNESS_DISCIPLINE).toContain("稳健")
    expect(GENERAL_ROBUSTNESS_DISCIPLINE).toContain("unknown_deck")
    expect(GENERAL_ROBUSTNESS_DISCIPLINE).toContain("不得引用仅单个对手特有的 defId")
    expect(GENERAL_ROBUSTNESS_DISCIPLINE).toContain("明牌先验")
  })
})
