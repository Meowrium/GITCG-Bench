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
 * 游戏版本钉扎（V1）纯函数测试：版本串封闭校验、计划声明版本解析、
 * run 目录版本断言、版本化 AssetsManager 构造、author context.gameVersion 写入契约。
 * 无网络（AssetsManager 只构造不请求）。
 */

import { describe, expect, it } from "vitest"
import { CURRENT_VERSION, VERSIONS, type Version } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { stableStringify } from "./validate.js"
import {
  applyAuthorGameVersion,
  assetsManagerForVersion,
  checkRunDirVersions,
  parseGameVersion,
  resolveDeclaredPlanVersion,
} from "./version.js"

describe("parseGameVersion（VERSIONS 封闭校验）", () => {
  it("合法版本直通；undefined → undefined", () => {
    expect(parseGameVersion(undefined)).toBeUndefined()
    expect(parseGameVersion("v6.3.0")).toBe("v6.3.0")
    expect(parseGameVersion(CURRENT_VERSION)).toBe(CURRENT_VERSION)
  })

  it("非法版本串 → 抛错并列出可用版本", () => {
    expect(() => parseGameVersion("v9.9.9")).toThrowError(/v9\.9\.9/)
    expect(() => parseGameVersion("v9.9.9")).toThrowError(new RegExp(VERSIONS[0].replaceAll(".", "\\.")))
    expect(() => parseGameVersion("6.3.0")).toThrowError(/可用版本/)
  })
})

describe("resolveDeclaredPlanVersion（计划声明版本解析）", () => {
  it("未声明 → CURRENT_VERSION", () => {
    expect(resolveDeclaredPlanVersion({ context: {} })).toBe(CURRENT_VERSION)
    expect(resolveDeclaredPlanVersion({})).toBe(CURRENT_VERSION)
  })

  it("声明 → 该版本；声明非法 → 抛错", () => {
    expect(resolveDeclaredPlanVersion({ context: { gameVersion: "v6.3.0" } })).toBe("v6.3.0")
    expect(() => resolveDeclaredPlanVersion({ context: { gameVersion: "v0.0.1" } })).toThrowError(/未知游戏版本/)
  })
})

describe("checkRunDirVersions（run 目录版本断言）", () => {
  it("一致 → 无 errors 无 warnings", () => {
    const r = checkRunDirVersions([{ dir: "run-a", version: "v6.3.0" }], "v6.3.0")
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it("未标注（旧产物）→ warning 不中断", () => {
    const r = checkRunDirVersions([{ dir: "run-old", version: undefined }], "v6.3.0")
    expect(r.errors).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("旧产物")
  })

  it("错配 → error；--force 降级 warning", () => {
    const entries = [{ dir: "run-b", version: "v6.6.0" }] as const
    const strict = checkRunDirVersions(entries, "v6.3.0")
    expect(strict.errors).toHaveLength(1)
    expect(strict.errors[0]).toContain("v6.6.0")
    expect(strict.warnings).toEqual([])
    const forced = checkRunDirVersions(entries, "v6.3.0", { force: true })
    expect(forced.errors).toEqual([])
    expect(forced.warnings).toHaveLength(1)
    expect(forced.warnings[0]).toContain("--force")
  })
})

describe("assetsManagerForVersion（版本化素材源）", () => {
  it("缺省 → DEFAULT_ASSETS_MANAGER（latest，现状）", () => {
    expect(assetsManagerForVersion(undefined)).toBe(DEFAULT_ASSETS_MANAGER)
  })

  it("显式版本 → 独立实例（版本串生效，不发请求）", () => {
    const m = assetsManagerForVersion("v6.3.0" as Version)
    expect(m).not.toBe(DEFAULT_ASSETS_MANAGER)
    // 版本进 URL：与默认实例行为可区分（此处仅验证构造成功且为 AssetsManager 实例）
    expect(m.constructor.name).toBe("AssetsManager")
  })
})

describe("applyAuthorGameVersion（author context 写入契约）", () => {
  it("显式版本 → 写入", () => {
    const ctx: { deckCode: string; gameVersion?: string } = { deckCode: "ABC" }
    applyAuthorGameVersion(ctx, "v6.3.0")
    expect(ctx.gameVersion).toBe("v6.3.0")
  })

  it("缺省 → 键被删除（不是 undefined 值键），stableStringify 与无键形态一致", () => {
    const withHallucination: { deckCode: string; gameVersion?: string; opponent: unknown } = {
      deckCode: "ABC",
      gameVersion: "v9.9.9", // LLM 幻觉值
      opponent: { kind: "mirror" },
    }
    applyAuthorGameVersion(withHallucination, undefined)
    expect("gameVersion" in withHallucination).toBe(false)
    // planId 自洽关键：序列化形态必须与从未有过该字段的计划完全一致
    expect(stableStringify(withHallucination)).toBe(stableStringify({ deckCode: "ABC", opponent: { kind: "mirror" } }))
  })
})
