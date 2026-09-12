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
 * author / reflect 的提示词加载：提示词本体在 ../prompts/*.md（便于审查与迭代），
 * 此处只做读取与模板占位替换。修改提示词请直接编辑对应 .md 文件。
 *
 * evidence = "engine-only"（2026-08-30 无 oracle 自进化臂）：reflect 系统提示词与
 * harness 协议换用 oracle-free 变体（机械指标锚点），patch 模式追加口径说明。
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { EvidenceMode } from "./evidence-extract.js"

function loadPrompt(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf-8")
}

/** GamePlanV1 规则语义 + 字段封闭集合 + declareEnd 纪律（author/reflect 共用） */
export const PLAN_SCHEMA_SPEC = loadPrompt("plan-schema-spec")

/** 游戏规则参考：回合/费用/反应/伤害数值依据（author/reflect 共用） */
export const GAME_RULES = loadPrompt("game-rules")

/** author 系统提示词（内含 {{PLAN_SCHEMA_SPEC}} / {{GAME_RULES}} 占位） */
export const AUTHOR_SYSTEM_PROMPT = loadPrompt("author-system")
  .replace("{{PLAN_SCHEMA_SPEC}}", PLAN_SCHEMA_SPEC)
  .replace("{{GAME_RULES}}", GAME_RULES)

/** reflect 系统提示词（内含 {{PLAN_SCHEMA_SPEC}} / {{GAME_RULES}} 占位） */
export const REFLECT_SYSTEM_PROMPT = loadPrompt("reflect-system")
  .replace("{{PLAN_SCHEMA_SPEC}}", PLAN_SCHEMA_SPEC)
  .replace("{{GAME_RULES}}", GAME_RULES)

/** 策略锚点分析系统提示词（plan:author --anchor 的第一阶段） */
export const ANCHOR_SYSTEM_PROMPT = loadPrompt("anchor-system")

/** harness 多轮协议章节（author 版，含模块目录与轮次纪律；占位替换预算数值） */
const HARNESS_PROTOCOL_AUTHOR = loadPrompt("harness-protocol-author")

/** harness 多轮协议章节（reflect 版） */
const HARNESS_PROTOCOL_REFLECT = loadPrompt("harness-protocol-reflect")

/** patch 修订协议章节（reflect 的 --patch 模式追加；占位替换 op 上限） */
const HARNESS_PATCH_REFLECT = loadPrompt("harness-patch-reflect")

/** 多候选起草章节（author --candidates N；同一对话 N 轮顺序起草，占位替换候选数） */
const CANDIDATES_AUTHOR = loadPrompt("candidates-author")

/** 候选评审系统提示词（author --candidates N 的即时评审调用；占位替换候选数） */
const CANDIDATES_REVIEW = loadPrompt("candidates-review")

/** reflect 系统提示词的 oracle-free 变体（无 oracle 自进化臂；机械指标锚点） */
export const REFLECT_SYSTEM_PROMPT_ENGINE_ONLY = loadPrompt("reflect-system-engine-only")
  .replace("{{PLAN_SCHEMA_SPEC}}", PLAN_SCHEMA_SPEC)
  .replace("{{GAME_RULES}}", GAME_RULES)

/** harness 多轮协议章节的 oracle-free 变体 */
const HARNESS_PROTOCOL_REFLECT_ENGINE_ONLY = loadPrompt("harness-protocol-reflect-engine-only")

/** engine-only + patch 时追加的口径说明：无 oracle，逐 op 断言无 blunder 点属预期 */
const PATCH_ENGINE_ONLY_NOTE = `# 口径说明（本轮无外部强评）

静态回放核验照常给出（命中矩阵 diff / fallback 率变化 / 命中迁移样例），但逐 op 断言的
"blunder 点"集合来自 eval 回算——本轮没有该数据，断言一律显示 no-target，**属预期而非
修订无效**。判断修订是否到位的依据：thenMiss 归零、目标规则命中面变化、fallback 率变化
与覆盖率保持。falsifiableClaim 照常在消融臂以引擎侧判据（thenMiss/coverage/胜率区间）验证。`

export interface HarnessProtocolParams {
  maxTurns: number
  moduleBudget: number
  perTurnModules: number
  /** patch 模式单条命令 op 上限（仅 patch 协议章节使用） */
  maxPatchOps?: number
}

function fillProtocol(template: string, p: HarnessProtocolParams): string {
  return template
    .replaceAll("{{MAX_TURNS}}", String(p.maxTurns))
    .replaceAll("{{MODULE_BUDGET}}", String(p.moduleBudget))
    .replaceAll("{{PER_TURN_MODULES}}", String(p.perTurnModules))
    .replaceAll("{{MAX_OPS}}", String(p.maxPatchOps ?? 8))
}

/**
 * 构建 author 系统提示词。agentic=false 时逐字节同 AUTHOR_SYSTEM_PROMPT
 * （one-shot 对照臂纯度）；true 时尾部拼接多轮起草协议章节。
 */
export function buildAuthorSystemPrompt(agentic: false): string
export function buildAuthorSystemPrompt(agentic: true, protocol: HarnessProtocolParams): string
export function buildAuthorSystemPrompt(agentic: boolean, protocol?: HarnessProtocolParams): string {
  if (!agentic || !protocol) return AUTHOR_SYSTEM_PROMPT
  return `${AUTHOR_SYSTEM_PROMPT}\n\n${fillProtocol(HARNESS_PROTOCOL_AUTHOR, protocol)}`
}

/** 多候选起草系统提示词（--candidates N）：author 系统提示词 + 候选模式章节（单对话多轮） */
export function buildCandidatesSystemPrompt(count: number): string {
  return `${AUTHOR_SYSTEM_PROMPT}\n\n${CANDIDATES_AUTHOR.replaceAll("{{CANDIDATE_COUNT}}", String(count))}`
}

/** 候选评审系统提示词（--candidates N 的即时评审调用） */
export function buildCandidateReviewSystemPrompt(count: number): string {
  return CANDIDATES_REVIEW.replaceAll("{{CANDIDATE_COUNT}}", String(count))
}

/** reflect 系统提示词（同 buildAuthorSystemPrompt 的拼接约定；patch=true 追加 patch 修订协议；
 *  evidence="engine-only" 换用 oracle-free 变体，patch 模式再追加口径说明） */
export function buildReflectSystemPrompt(agentic: false, protocol?: undefined, patch?: boolean, evidence?: EvidenceMode): string
export function buildReflectSystemPrompt(agentic: true, protocol: HarnessProtocolParams, patch?: boolean, evidence?: EvidenceMode): string
export function buildReflectSystemPrompt(agentic: boolean, protocol?: HarnessProtocolParams, patch?: boolean, evidence: EvidenceMode = "oracle"): string {
  const sysBase = evidence === "engine-only" ? REFLECT_SYSTEM_PROMPT_ENGINE_ONLY : REFLECT_SYSTEM_PROMPT
  if (!agentic || !protocol) return sysBase
  const proto = evidence === "engine-only" ? HARNESS_PROTOCOL_REFLECT_ENGINE_ONLY : HARNESS_PROTOCOL_REFLECT
  const base = `${sysBase}\n\n${fillProtocol(proto, protocol)}`
  if (!patch) return base
  const patched = `${base}\n\n${fillProtocol(HARNESS_PATCH_REFLECT, protocol)}`
  return evidence === "engine-only" ? `${patched}\n\n${PATCH_ENGINE_ONLY_NOTE}` : patched
}
