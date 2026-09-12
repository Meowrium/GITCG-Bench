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
 * 游戏版本钉扎（V1）共享工具：版本串封闭校验、计划声明版本解析、
 * run 目录版本断言、版本化 AssetsManager 构造。
 *
 * 纯函数优先（可单测、不拉网络）；checkRunDirVersions 只做判定不抛错，
 * 由 CLI 决定 errors → 中断 / warnings → 打印。--force 语义与 batch 侧一致：
 * 所有版本错误降级为 warning。
 */

import { CURRENT_VERSION, VERSIONS, type Version } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER, AssetsManager } from "@gi-tcg/assets-manager"

/** 版本串封闭校验（core VERSIONS 白名单）：非法抛错并列出可用版本；undefined 直通 */
export function parseGameVersion(raw: string | undefined): Version | undefined {
  if (raw === undefined) return undefined
  if (!(VERSIONS as readonly string[]).includes(raw)) {
    throw new Error(`未知游戏版本 "${raw}"；可用版本：${VERSIONS.join(", ")}`)
  }
  return raw as Version
}

/** 计划声明的版本 → 解析（未声明 = CURRENT_VERSION；声明了但非法 → 抛错） */
export function resolveDeclaredPlanVersion(plan: { context?: { gameVersion?: string } }): Version {
  return parseGameVersion(plan.context?.gameVersion) ?? CURRENT_VERSION
}

export interface RunDirVersionEntry {
  /** run 目录（报错信息用） */
  dir: string
  /** 该目录 summary.json（或侧专用 summary）里的 gameVersion；旧产物 undefined */
  version: string | undefined
}

export interface RunDirVersionCheckResult {
  errors: string[]
  warnings: string[]
}

/**
 * run 目录（证据组/基线）版本断言：summary 的 gameVersion 与期望版本比对。
 * - 未标注（旧产物）→ warning（不中断）；
 * - 不一致 → error（--force 时降级 warning）；
 * - 一致 → 无输出。
 */
export function checkRunDirVersions(
  entries: readonly RunDirVersionEntry[],
  expected: Version,
  opts: { force?: boolean } = {},
): RunDirVersionCheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  for (const e of entries) {
    if (e.version === undefined) {
      warnings.push(`${e.dir}：run 目录未标注 gameVersion（旧产物），无法断言版本一致性；期望 ${expected}`)
    } else if (e.version !== expected) {
      const message = `${e.dir}：run 目录版本 ${e.version} 与计划版本 ${expected} 不一致——按错误版本证据反思/消融会得出失真结论`
      if (opts.force === true) {
        warnings.push(`${message}；--force 放行`)
      } else {
        errors.push(message)
      }
    }
  }
  return { errors, warnings }
}

/**
 * author prompt 数据源版本化（§2.2 实测：静态素材 API 支持引擎版本串）：
 * 显式版本 → 版本化 AssetsManager（卡面文本按该版本）；未传 → DEFAULT_ASSETS_MANAGER
 * （"latest"，与旧行为一致）。deck 分享码 decode 与版本无关（静态映射）。
 */
export function assetsManagerForVersion(version: Version | undefined): AssetsManager {
  return version === undefined ? DEFAULT_ASSETS_MANAGER : new AssetsManager({ version })
}

/**
 * author 产物归一化的 context.gameVersion 写入契约：显式 --game-version 才写
 * （进 planId 内容哈希，planId 自动随版本区分）；缺省剥离（含 LLM 幻觉值），
 * 保持旧产物形态（无该字段）。
 * 必须用 delete 而非赋 undefined：planId 的 stableStringify 会把 undefined 值键
 * 序列化进去，与落盘 JSON（undefined 键被丢弃）不一致会破坏 planId 自洽。
 */
export function applyAuthorGameVersion<T extends { gameVersion?: string }>(
  context: T,
  gameVersion: Version | undefined,
): void {
  if (gameVersion !== undefined) {
    context.gameVersion = gameVersion
  } else {
    delete context.gameVersion
  }
}
