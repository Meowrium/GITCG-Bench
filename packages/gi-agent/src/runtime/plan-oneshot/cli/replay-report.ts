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
 * replay-report 落盘（WP2 P0-3）：plan:reflect --patch 的静态回放核验结果
 * （PlanReplayResult / PatchAssertion[]）此前只进 transcript 文本，本模块定义
 * 结构化落盘形状并负责写出：
 * - legacy 单树：`<out>.replay-report.json`
 * - portfolio 模式：`<out目录>/reflect.replay-report.<tag>.json`（每代一份，tag 带 r<N>）
 *
 * schema 以 plan-replay.ts 现有类型为准：逐 patch 命令记录 opsCount + 逐 op
 * 反事实断言（PatchAssertion，status ∈ fixed/partial/ineffective/no-target）+
 * 静态回放口径的 fallback 率（base→next）。PlanReplayResult 的 perRule/fallbackPoints
 * 明细不进本产物（fallbackPoints 与语料等量级，需要时从 run 目录 trace 重算）；
 * portfolio 模式另带逐对手组 fallback 率。独立成文件是便于单元测试直接调用
 * （run-plan-reflect.ts 顶层即执行 main，不可被测试导入）。
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { PatchAssertion } from "../plan-replay.js"

/** 单条 patch 命令的回放核验记录 */
export interface ReplayReportPatch {
  /** patch 命令序号（1 起，跨命令递增） */
  patchIndex: number
  /** 本命令实际应用的 op 数 */
  opsCount: number
  /** 逐 op 反事实断言（status ∈ fixed/partial/ineffective/no-target） */
  assertions: PatchAssertion[]
  /** 静态回放口径 fallback 率：base = 原 tree，next = 合并后 tree */
  fallbackRate: { base: number; next: number }
  /** portfolio 模式：逐对手组 fallback 率（legacy 单树缺省） */
  groups?: Array<{ label: string; fallbackRate: { base: number; next: number } }>
}

/** `<out>.replay-report.json` 的顶层形状 */
export interface ReplayReport {
  /** 被修订计划的 planId（portfolio 模式 = general 层 planId） */
  basePlanId: string
  /** portfolio 模式的 portfolioId */
  portfolioId?: string
  /** 逐 patch 命令核验记录（含 op 断言明细） */
  patches: ReplayReportPatch[]
  /** 累计应用的 op 总数 */
  totalAppliedOps: number
}

export function createReplayReport(basePlanId: string, portfolioId?: string): ReplayReport {
  return {
    basePlanId,
    ...(portfolioId !== undefined ? { portfolioId } : {}),
    patches: [],
    totalAppliedOps: 0,
  }
}

/** 累计一条 patch 命令的核验记录（patchIndex 自动递增） */
export function recordPatchReplay(report: ReplayReport, patch: Omit<ReplayReportPatch, "patchIndex">): void {
  report.patches.push({ patchIndex: report.patches.length + 1, ...patch })
  report.totalAppliedOps += patch.opsCount
}

/** 落盘（JSON 缩进 2 + 结尾换行，与计划/summary 等产物一致） */
export async function writeReplayReport(path: string, report: ReplayReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
}
