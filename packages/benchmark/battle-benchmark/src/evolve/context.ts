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

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { EvolveError } from "./llm-client"

const MCP_SCORING_TYPES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/mcp/src/scoring/types.ts",
)

/**
 * 引擎算法的静态背景上下文，供预测/复盘提示词使用。三段：
 *   1. TurnDigestV1 结构（从 packages/mcp/src/scoring/types.ts 提取原文）；
 *   2. 可用决策工具（StandaloneToolRegistry 的六种决策工具描述）；
 *   3. 算法规则速查（本目录 algorithmic-context.md）。
 */
export function buildAlgorithmicContext(): string {
  return [
    `## TurnDigestV1 结构\n${extractTurnDigestV1()}`,
    `## 可用决策工具\n${DECISION_TOOLS_TEXT}`,
    `## 算法规则速查\n${readAlgorithmicContext()}`,
  ].join("\n\n")
}

/** 决策工具描述（与 packages/mcp/src/mcp/StandaloneToolRegistry.ts 的 description 一致）。 */
const DECISION_TOOLS_TEXT = [
  "- choose_action：轮到你行动时按索引选择一个行动。返回 action_feedback（每个角色的行动前后差值：hp/能量/元素附着/护盾）与 enriched action_effects（解析后的角色/技能名与伤害/反应类型标签）。可选参数 explanation（行动理由）。",
  "- elemental_tuning：显式执行元素调和（弃一张手牌，将一个骰子转为目标元素）。",
  "- select_card：从候选卡中选择一张卡（selectCard 决策）。",
  "- choose_active：对局开始时选择出战角色。",
  "- reroll_dice：每轮开始时选择要重掷的骰子。",
  "- switch_hands：选择从初始手牌中移除的牌（换手牌/调度）。",
  "决策点 pending_method 与工具的对应关系：action → choose_action；chooseActive → choose_active；rerollDice → reroll_dice；switchHands → switch_hands；selectCard → select_card。",
].join("\n")

let cachedTurnDigest: string | null = null

/**
 * 从 packages/mcp/src/scoring/types.ts 提取 `export type TurnDigestV1 = { ... };` 原文块
 * （行扫描 + 大括号深度计数，结果按模块缓存）。
 */
function extractTurnDigestV1(): string {
  if (cachedTurnDigest !== null) {
    return cachedTurnDigest
  }
  let source: string
  try {
    source = readFileSync(MCP_SCORING_TYPES_PATH, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  } catch (err) {
    throw new EvolveError(
      `读取 TurnDigestV1 定义失败: ${MCP_SCORING_TYPES_PATH}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }

  const lines = source.split("\n")
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("export type TurnDigestV1 = {")) {
      start = i
      break
    }
  }
  if (start < 0) {
    throw new EvolveError(`未找到 TurnDigestV1 定义: ${MCP_SCORING_TYPES_PATH}`)
  }

  let depth = 0
  let end = -1
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === "{") {
        depth += 1
      } else if (ch === "}") {
        depth -= 1
      }
    }
    if (depth === 0) {
      end = i
      break
    }
  }
  if (end < 0) {
    throw new EvolveError(`TurnDigestV1 定义未闭合: ${MCP_SCORING_TYPES_PATH}`)
  }

  cachedTurnDigest = lines.slice(start, end + 1).join("\n")
  return cachedTurnDigest
}

let cachedAlgorithmicContext: string | null = null

/** 读取本目录 algorithmic-context.md（每轮构建一次即可，缓存）。 */
function readAlgorithmicContext(): string {
  if (cachedAlgorithmicContext !== null) {
    return cachedAlgorithmicContext
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), "algorithmic-context.md")
  try {
    cachedAlgorithmicContext = readFileSync(file, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
  } catch (err) {
    throw new EvolveError(
      `读取算法规则速查失败: ${file}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }
  return cachedAlgorithmicContext
}
