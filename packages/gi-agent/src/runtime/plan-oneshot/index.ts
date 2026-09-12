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

export type {
  GamePlanV1,
  GamePlanPhaseV1,
  DecisionRuleV1,
  WhenConditionV1,
  PlanConditionOp,
  ActionSpecV1,
  OpeningChooseActiveRuleV1,
  MulliganRuleV1,
  RerollRuleV1,
  PlanFallbackPolicyKind,
} from "./game-plan-v1.js"
export {
  isKnownPlanField,
  resolvePlanField,
  evaluateWhenCondition,
  evaluateWhenAll,
  elementOfCharacterDefId,
  auraNameOf,
  planStateSignature,
  ELEMENT_NAMES,
  DICE_TYPE_BY_ELEMENT,
  type PlanFieldContext,
  type PbViewState,
} from "./fields.js"
export {
  buildSkillTypeIndex,
  candidateMatchesSpec,
  candidateTieBreakScore,
  previewDamageVsOpponent,
  previewKillsOpponent,
  previewReactionNames,
  summarizeAction,
  type RpcAction,
  type ActionMatchContext,
} from "./action-match.js"
export {
  PlanTraceCollector,
  type PlanTraceEntry,
  type PlanTraceFile,
  type PlanTraceMeta,
  type PlanTraceSummary,
} from "./trace.js"
export { PlanPlayerIO, type PlanPlayerIOOptions } from "./plan-player-io.js"
export {
  validateGamePlan,
  computePlanId,
  autoRepairPlan,
  normalizePlanNumericFields,
  type PlanValidationIssue,
  type PlanValidationResult,
  type PlanValidationContext,
} from "./validate.js"
// ── patch 修订协议 + 静态回放核验（2026-08-29 迭代动力学对策）──
export {
  parsePlanPatchCommand,
  applyPlanPatch,
  isSyntheticPatchRef,
  type PlanPatchOp,
  type PlanPatchCommand,
  type PatchVerdict,
  type PlanPatchApplyResult,
  type PlanPatchPortfolioApplyResult,
  type PatchPlanTarget,
  type PatchLayerSpec,
  type PatchPosition,
} from "./plan-patch.js"
export {
  loadReplayCorpus,
  replayPlan,
  replayPointKeys,
  replayChainPlan,
  replayChainPointKeys,
  replayPortfolio,
  verifyPatchAssertions,
  verifyChainPatchAssertions,
  verifyPortfolioPatchAssertions,
  formatPatchVerification,
  formatMatrixSummary,
  sideFileNames,
  type ReplayPoint,
  type ReplayCorpus,
  type PlanReplayResult,
  type PatchAssertion,
  type ReplayChainInput,
  type PortfolioPlanTarget,
  type PortfolioReplayGroup,
  type PortfolioReplayResult,
} from "./plan-replay.js"
// ── 两层组合链（D1=A 层主序唯一构造点，plan-player-io 与 plan-replay 共用）──
export {
  combinedChain,
  type ChainScopedRule,
  type ChainLayerSpec,
  type ChainOrderedRule,
} from "./rule-chain.js"
// ── 两层决策树（General+Single portfolio）：规则归因键 helper + portfolio manifest ──
export {
  formatRuleKey,
  parseRuleKey,
  collectRuleKeys,
  type RuleScope,
  type RuleLayer,
  type ParsedRuleKey,
  type RuleKeyParts,
} from "./rule-key.js"
export {
  computePortfolioId,
  routeSingle,
  loadPortfolioWithValidation,
  type PlanPortfolioV1,
  type PlanPortfolioSingleEntry,
  type ResolvedSingle,
  type ResolvedPortfolio,
  type PortfolioRouting,
} from "./portfolio.js"
export { lintPlan, type PlanLintFinding, type PlanLintKind, type PlanLintContext } from "./fields-lint.js"
// ── 卡面事实表（@gi-tcg/data builder-DSL 源码静态扫描；卡面校核的数据源之一）──
export {
  buildCardFaceTable,
  type CardFaceTable,
  type CardFaceDef,
  type CardFaceCost,
  type CardFaceDamage,
  type CardFaceKind,
} from "./card-face-table.js"
