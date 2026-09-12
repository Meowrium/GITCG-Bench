// Copyright (C) 2024-2025 Guyutongxue
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

import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DiceType } from "@gi-tcg/typings"
import { chooseDice } from "@gi-tcg/utils"
import type { JsonValue, SlotValue } from "@gi-tcg/ml/contracts"
import type {
  MlCandidateAction,
  MlDecisionPoint,
} from "@gi-tcg/ml/contracts"
import {
  LinearConceptModelPredictor,
  type LinearConceptModelArtifact,
} from "@gi-tcg/ml/runtime"
import type { RuntimeConceptState } from "@gi-tcg/ml/runtime"
import type {
  ConceptNumericWeight,
  SlotLinearRankerArtifact,
  SlotLinearRankerConfig,
} from "@gi-tcg/ml/ranker"
import type { LinearValueArtifact } from "@gi-tcg/ml/value"
import { predictValueSample } from "@gi-tcg/ml/value"
import {
  type AnyValueArtifact,
  predictValue,
  predictQValue,
} from "@gi-tcg/ml/value"
import type { GbdtQValueArtifact, GbdtRankerArtifact } from "@gi-tcg/ml/value"
import { predictGbdtRankerScore } from "@gi-tcg/ml/value"
import {
  buildBranchEvalCandidateNumericSlots,
  buildBranchEvalQueryNumericSlots,
} from "../../evaluation/branch-eval/report-slots.js"
import type { CombatWindowLibrary } from "../../learning/combat-windows/export-library.js"
import {
  buildLibraryQueryFromPolicyDigest,
  selectCombatWindowLibrary,
} from "../../learning/combat-windows/library-selector.js"
import {
  advanceRuntimeMacroPlanState,
  resolveRuntimeMacroPlanState,
  scoreCandidateAgainstMacroPlan,
} from "./macro-plan.js"
import { buildCombatWindowPlanSearchGuidance } from "./plan-search.js"
import { estimateStrategicValueAdjustment } from "./strategic-value.js"
import {
  matchReactionChainTemplates,
  scoreReactionChainPrior,
  type ReactionChainMatch,
} from "./reaction-chain-templates.js"
import { BaselinePolicy, type BaselinePolicyOptions } from "./baseline-policy.js"
import { matchAnyPattern } from "../plan/pattern-matcher.js"
import {
  gamePlanToMacroPlanKind,
  getPhasePreferTags,
  type GamePlanRuntimeState,
} from "./game-plan.js"
import {
  predictOpponentStyle,
  type OpponentModelState,
} from "./opponent-model.js"
import {
  computeInitiativeValue,
  computeFastActionTempoValue,
  DEFAULT_TEMPO_WEIGHTS,
  type TempoWeightConfig,
} from "./tempo-value.js"
import { scoreTemporalOpportunity } from "./temporal-opportunity.js"
import type {
  PolicyCandidateAction,
  PolicyDecisionContext,
  PolicyDecision,
  PolicyTurnDigest,
  RankedPolicyCandidate,
  RuntimeMacroPlan,
} from "./types.js"
import { flattenNumericRecord } from "@gi-tcg/ml/utils"
import { scoreTransitionV0, type TransitionScorerV0Config, DEFAULT_TRANSITION_CONFIG } from "./transition-scorer.js"
import { ScoringRegistry, makeScoringContext, type ScoringComponent, type ScoringContext, type ScoringContribution } from "./scoring-registry.js"
import { scoreDeckActionPrior } from "./deck-action-prior.js"
import type { DeckPriorFeatureVector } from "./prior-types.js"

export interface GiMlPolicyOptions extends BaselinePolicyOptions {
  useBaselineTieBreaker?: boolean
  valueArtifact?: AnyValueArtifact | null
  valueWeight?: number
  /** When true, use GBDT value model V(s\') directly as final score instead of ranker + value adjustment. */
  gbdtValueDirectMode?: boolean
  /**
   * Q(s,a) artifact trained with combined (state + action) features.
   * When provided, replaces the approximateCandidateValueAdjustment heuristic
   * with a direct Q-value estimate per candidate (no approximate next-state needed).
   */
  qValueArtifact?: GbdtQValueArtifact | null
  qValueWeight?: number
  /**
   * GBDT ranker artifact. When provided, used as the primary action scorer
   * instead of the SlotLinearRanker, with the linear ranker as fallback.
   */
  gbdtRankerArtifact?: GbdtRankerArtifact | null
  tuneFollowupWeight?: number
  combatWindowLibrary?: CombatWindowLibrary | null
  combatWindowMinScore?: number
  macroPlanWeight?: number
  planSearchWeight?: number
  strategicValueWeight?: number
  reactionChainWeight?: number
  /** ── Tempo: weight for state-driven initiative value (Section 18.4) ── */
  tempoValueWeight?: number
  /** ── Temporal options: delayed payoff, support slot pressure, and synergy readiness. */
  temporalOpportunityWeight?: number
  /** ── V27 Transition-based scoring (H1+H2+H4+H8 constraints). */
  transitionScoringConfig?: TransitionScorerV0Config
  /** ── V26 P0-1: Deck/Matchup prior features for action-conditional scoring. */
  deckPriorFeatures?: DeckPriorFeatureVector
}

const DEFAULT_USE_BASELINE_TIEBREAKER = true
const DEFAULT_VALUE_WEIGHT = 1
const DEFAULT_Q_VALUE_WEIGHT = 1.5
const DEFAULT_TUNE_FOLLOWUP_WEIGHT = 0.35
const DEFAULT_COMBAT_WINDOW_MIN_SCORE = 0.58
const DEFAULT_MACRO_PLAN_WEIGHT = 0.6
const DEFAULT_PLAN_SEARCH_WEIGHT = 0.8
const DEFAULT_STRATEGIC_VALUE_WEIGHT = 0.5
const DEFAULT_REACTION_CHAIN_WEIGHT = 1.2
const DEFAULT_TEMPO_VALUE_WEIGHT = 0.3
const DEFAULT_TEMPORAL_OPPORTUNITY_WEIGHT = 0.6
const GAME_DATA = getData(CURRENT_VERSION)
const CHARACTER_ELEMENT_BY_DEFINITION_ID = buildCharacterElementMap()
const CHARACTER_SEMANTIC_TAGS_BY_DEFINITION_ID = buildCharacterSemanticTagsMap()
const ENTITY_SEMANTIC_TAGS_BY_DEFINITION_ID = buildEntitySemanticTagsMap()

export class GiMlPolicy extends BaselinePolicy {
  readonly rankerArtifact: SlotLinearRankerArtifact
  readonly gbdtRankerArtifact: GbdtRankerArtifact | null
  readonly conceptModel: LinearConceptModelPredictor | null
  readonly valueArtifact: AnyValueArtifact | null
  readonly qValueArtifact: GbdtQValueArtifact | null
  readonly combatWindowLibrary: CombatWindowLibrary | null
  private readonly useBaselineTieBreaker: boolean
  private readonly valueWeight: number
  private readonly gbdtValueDirectMode: boolean
  private readonly qValueWeight: number
  private readonly tuneFollowupWeight: number
  private readonly combatWindowMinScore: number
  private readonly macroPlanWeight: number
  private readonly planSearchWeight: number
  private readonly strategicValueWeight: number
  private readonly reactionChainWeight: number
  private readonly tempoValueWeight: number
  private readonly temporalOpportunityWeight: number
  private readonly transitionScoringConfig: TransitionScorerV0Config
  private readonly scoringRegistry: ScoringRegistry
  private readonly deckPriorFeatures?: DeckPriorFeatureVector

  constructor(
    rankerArtifact: SlotLinearRankerArtifact,
    conceptModelArtifact: LinearConceptModelArtifact | null = null,
    options: GiMlPolicyOptions = {},
  ) {
    super(options)
    this.rankerArtifact = rankerArtifact
    this.gbdtRankerArtifact = options.gbdtRankerArtifact ?? null
    this.conceptModel = conceptModelArtifact
      ? new LinearConceptModelPredictor(conceptModelArtifact)
      : null
    this.valueArtifact = options.valueArtifact ?? null
    this.qValueArtifact = options.qValueArtifact ?? null
    this.combatWindowLibrary = options.combatWindowLibrary ?? null
    this.useBaselineTieBreaker =
      options.useBaselineTieBreaker ?? DEFAULT_USE_BASELINE_TIEBREAKER
    this.valueWeight = options.valueWeight ?? DEFAULT_VALUE_WEIGHT
    this.gbdtValueDirectMode = options.gbdtValueDirectMode ?? false
    this.qValueWeight = options.qValueWeight ?? DEFAULT_Q_VALUE_WEIGHT
    this.tuneFollowupWeight = options.tuneFollowupWeight ?? DEFAULT_TUNE_FOLLOWUP_WEIGHT
    this.combatWindowMinScore =
      options.combatWindowMinScore ?? DEFAULT_COMBAT_WINDOW_MIN_SCORE
    this.macroPlanWeight = options.macroPlanWeight ?? DEFAULT_MACRO_PLAN_WEIGHT
    this.planSearchWeight = options.planSearchWeight ?? DEFAULT_PLAN_SEARCH_WEIGHT
    this.strategicValueWeight =
      options.strategicValueWeight ?? DEFAULT_STRATEGIC_VALUE_WEIGHT
    this.reactionChainWeight = options.reactionChainWeight ?? DEFAULT_REACTION_CHAIN_WEIGHT
    this.tempoValueWeight = options.tempoValueWeight ?? DEFAULT_TEMPO_VALUE_WEIGHT
    this.temporalOpportunityWeight =
      options.temporalOpportunityWeight ?? DEFAULT_TEMPORAL_OPPORTUNITY_WEIGHT
    this.transitionScoringConfig =
      options.transitionScoringConfig ?? DEFAULT_TRANSITION_CONFIG
    this.deckPriorFeatures = options.deckPriorFeatures
    this.scoringRegistry = this.buildScoringRegistry()
  }

  private buildScoringRegistry(): ScoringRegistry {
    const registry = new ScoringRegistry()

    // ── Core ML scorer (GBDT or SlotLinear) ──
    registry.register({
      id: "gi_ml",
      label: "Core ML Ranker",
      enabled: (ctx) => !ctx.gbdtValueDirectMode && ctx.mlCandidate !== null,
      score: (ctx) => {
        const score = this.scoreCandidate(ctx.query, ctx.mlCandidate!, ctx.conceptState)
        return { id: "gi_ml", score, reasons: [] }
      },
    })

    // ── Guardrail ──
    registry.register({
      id: "guardrail",
      label: "Runtime Guardrail",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const score = runtimeGuardrailAdjustment(ctx.digest, ctx.candidate)
        return { id: "guardrail", score, reasons: score !== 0 ? [`guardrail=${score.toFixed(3)}`] : [] }
      },
    })

    // ── Q-value adjustment ──
    registry.register({
      id: "q_value",
      label: "Q-Value (Action-aware)",
      enabled: (ctx) => !ctx.gbdtValueDirectMode && this.qValueArtifact !== null && ctx.context?.observation != null,
      score: (ctx) => {
        const score = computeQValueAdjustment(this.qValueArtifact!, ctx.context!.observation!, ctx.digest, ctx.candidate, this.qValueWeight)
        return { id: "q_value", score, reasons: score !== 0 ? [`q_value=${score.toFixed(3)}`] : [] }
      },
    })

    // ── Value adjustment ──
    registry.register({
      id: "value",
      label: "Value Model V(s)",
      enabled: (ctx) => ctx.context?.observation != null,
      score: (ctx) => {
        let score = 0
        if (ctx.gbdtValueDirectMode) {
          if (this.valueArtifact) {
            score = computeCandidateGbdtDirectValue(this.valueArtifact, ctx.context!.observation!, ctx.digest, ctx.candidate, this.valueWeight)
          }
        } else if (!this.qValueArtifact && this.valueArtifact) {
          score = approximateCandidateValueAdjustment(this.valueArtifact, ctx.context!.observation!, ctx.digest, ctx.candidate, this.valueWeight)
        }
        return { id: "value", score, reasons: score !== 0 ? [`value=${score.toFixed(3)}`] : [] }
      },
    })

    // ── Tune followup ──
    registry.register({
      id: "tune_followup",
      label: "Tuning Follow-up",
      enabled: (ctx) => !ctx.gbdtValueDirectMode && ctx.candidate.action_case === "elementalTuning" && ctx.mlCandidate !== null,
      score: (ctx) => {
        const score = estimateTuneFollowupAdjustment(ctx.digest, ctx.candidate, ctx.query, ctx.conceptState, this.rankerArtifact.config, this.tuneFollowupWeight)
        return { id: "tune_followup", score, reasons: score !== 0 ? [`tune_followup=${score.toFixed(3)}`] : [] }
      },
    })

    // ── Macro plan ──
    registry.register({
      id: "macro_plan",
      label: "Macro Plan Guidance",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const estimate = scoreCandidateAgainstMacroPlan(ctx.digest, ctx.candidate, ctx.context?.observation, ctx.macroPlan)
        const score = estimate.score * this.macroPlanWeight
        return { id: "macro_plan", score, reasons: [...estimate.reasons, ...(score !== 0 ? [`macro_plan=${score.toFixed(3)}`] : [])] }
      },
    })

    // ── Plan search ──
    registry.register({
      id: "plan_search",
      label: "Combat Window Search",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const score = (ctx.planSearchGuidance?.score ?? 0) * this.planSearchWeight
        return { id: "plan_search", score, reasons: [...(ctx.planSearchGuidance?.reasons ?? []), ...(score !== 0 ? [`plan_search=${score.toFixed(3)}`] : [])] }
      },
    })

    // ── Strategic value ──
    registry.register({
      id: "strategic_value",
      label: "Strategic Value",
      enabled: () => true,
      score: (ctx) => {
        const estimate = ctx.gbdtValueDirectMode ? { score: 0, reasons: [] as string[] } : estimateStrategicValueAdjustment(ctx.digest, ctx.candidate, ctx.context?.observation, ctx.macroPlan)
        const score = estimate.score * this.strategicValueWeight
        return { id: "strategic_value", score, reasons: [...estimate.reasons, ...(score !== 0 ? [`strategic_value=${score.toFixed(3)}`] : [])] }
      },
    })

    // ── Reaction chain ──
    registry.register({
      id: "reaction_chain",
      label: "Reaction Chain Prior",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const prior = scoreReactionChainPrior(ctx.candidate, ctx.reactionChainMatches ?? [])
        const score = prior.score * this.reactionChainWeight
        return { id: "reaction_chain", score, reasons: [...prior.reasons, ...(score !== 0 ? [`reaction_chain=${score.toFixed(3)}`] : [])] }
      },
    })

    // ── Opponent model ──
    registry.register({
      id: "opponent",
      label: "Opponent Model",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const adj = scoreOpponentModelAdjustment(ctx.candidate, ctx.context?.opponentModelState ?? null)
        return { id: "opponent", score: adj.score, reasons: [...adj.reasons, ...(adj.score !== 0 ? [`opp_model=${adj.score.toFixed(3)}`] : [])] }
      },
    })

    // ── Lethal chain ──
    registry.register({
      id: "lethal_chain",
      label: "Lethal Chain First-Step",
      enabled: () => true,
      score: (ctx) => {
        const chains = ctx.context?.lethalChains ?? []
        if (chains.length === 0) return { id: "lethal_chain", score: 0, reasons: [] }
        const cid = String(ctx.candidate.candidate_id ?? "")
        const isFirstStep = chains.some(c => c.steps.length > 0 && String(c.steps[0].candidate.candidate_id) === cid)
        if (!isFirstStep) return { id: "lethal_chain", score: 0, reasons: [] }
        const mult = ctx.digest.round >= 3 ? 3.0 : ctx.digest.round >= 2 ? 1.5 : 0.5
        const score = 0.3 * mult
        return { id: "lethal_chain", score, reasons: [`lethal_chain_first=+${score.toFixed(2)}(r${ctx.digest.round})`] }
      },
    })

    // ── Risk response ──
    registry.register({
      id: "risk_response",
      label: "Risk Response",
      enabled: () => true,
      score: (ctx) => {
        if (ctx.context?.riskAssessment?.overallLevel !== "critical") return { id: "risk_response", score: 0, reasons: [] }
        const ac = String(ctx.candidate.action_case ?? "")
        if (ac === "switchActive" || Number(ctx.candidate.healing_estimate ?? 0) > 0) {
          return { id: "risk_response", score: 0.2, reasons: ["risk_critical=+0.20"] }
        }
        return { id: "risk_response", score: 0, reasons: [] }
      },
    })

    // ── Phase alignment ──
    registry.register({
      id: "phase",
      label: "Phase Alignment",
      enabled: () => true,
      score: (ctx) => {
        const result = computePhaseAlignment(ctx.digest.round, ctx.candidate, ctx.macroPlan)
        return { id: "phase", score: result.score, reasons: result.reason ? [result.reason] : [] }
      },
    })

    // ── Dice fitness ──
    registry.register({
      id: "dice_fitness",
      label: "Dice Fitness",
      enabled: () => true,
      score: (ctx) => {
        const result = computeDiceFitness(ctx.digest, ctx.candidate, ctx.context)
        return { id: "dice_fitness", score: result.score, reasons: result.reason ? [result.reason] : [] }
      },
    })

    // ── Temporal opportunity ──
    registry.register({
      id: "temporal",
      label: "Temporal Opportunity",
      enabled: (ctx) => !ctx.gbdtValueDirectMode,
      score: (ctx) => {
        const result = scoreTemporalOpportunity(ctx.digest, ctx.candidate, ctx.context?.observation, ctx.macroPlan)
        const score = result.score * this.temporalOpportunityWeight
        return { id: "temporal", score, reasons: [...result.reasons, ...(score !== 0 ? [`temporal=${score.toFixed(3)}`] : [])] }
      },
    })

    // ── Tempo ──
    registry.register({
      id: "tempo",
      label: "Tempo/Initiative",
      enabled: (ctx) => this.tempoValueWeight > 0 && ctx.context?.observation != null,
      score: (ctx) => {
        let bonus = 0
        let reason = ""
        const obs = ctx.context!.observation!
        const actionCase = String(ctx.candidate.action_case ?? "")
        if (actionCase === "declareEnd") {
          const oppEnded = obs.opponent.declared_end
          const myDice = obs.self.dice.total_count
          const meaningful = ctx.digest.candidate_actions.some(a => a !== ctx.candidate && a.action_case !== "declareEnd" && a.action_case !== "elementalTuning")
          if (oppEnded) {
            const tempoResult = computeInitiativeValue(obs, obs.point.actor_who)
            bonus = Math.max(-0.5, Math.min(0.5, tempoResult.total * this.tempoValueWeight))
            if (tempoResult.reason) reason = tempoResult.reason
          } else if (myDice <= 2 && !meaningful) {
            bonus = 0.1 * this.tempoValueWeight
          }
        } else if (actionCase === "elementalTuning") {
          bonus = 0.05 * this.tempoValueWeight
        } else if (actionCase === "switchActive") {
          const tags = Array.isArray(ctx.candidate.tags) ? ctx.candidate.tags.map(String) : []
          if (tags.some(t => String(t).toLowerCase().includes("fast"))) {
            const tempoResult = computeFastActionTempoValue(obs, obs.point.actor_who)
            bonus = Math.max(-0.5, Math.min(0.5, tempoResult.total * this.tempoValueWeight))
            if (tempoResult.reason) reason = tempoResult.reason
          }
        } else if (actionCase === "playCard" || actionCase === "useSkill") {
          const tags = Array.isArray(ctx.candidate.tags) ? ctx.candidate.tags.map(String) : []
          if (tags.some(t => String(t).toLowerCase().includes("fast"))) {
            const tempoResult = computeFastActionTempoValue(obs, obs.point.actor_who)
            bonus = Math.max(-0.5, Math.min(0.5, tempoResult.total * this.tempoValueWeight))
            if (tempoResult.reason) reason = tempoResult.reason
          }
        }
        return { id: "tempo", score: bonus, reasons: reason ? [reason] : [] }
      },
    })

    // ── V26 P0-1: Deck action prior (per-candidate, replaces side-level constant) ──
    registry.register({
      id: "deck_prior",
      label: "Deck/Matchup Action Prior",
      enabled: (ctx) => ctx.componentConfigs.priorFeatures != null,
      score: (ctx) => {
        const priorFeatures = ctx.componentConfigs.priorFeatures as DeckPriorFeatureVector | undefined
        if (!priorFeatures) return { id: "deck_prior", score: 0, reasons: [] }
        const result = scoreDeckActionPrior(priorFeatures, ctx.candidate, ctx.digest.round)
        return { id: "deck_prior", score: result.score, reasons: result.reasons }
      },
    })

    // ── V27 Transition scoring ──
    registry.register({
      id: "transition",
      label: "V27 Transition (H1-H4-H8)",
      enabled: (ctx) => this.transitionScoringConfig.enabled,
      score: (ctx) => {
        const result = scoreTransitionV0(
          ctx.context?.observation ?? null,
          ctx.digest,
          ctx.candidate,
          ctx.digest.candidate_actions,
          this.transitionScoringConfig,
        )
        return { id: "transition", score: result.contribution, reasons: result.reasons }
      },
    })

    // ── Combo Probability Nudge ──
    // Rewards actions that progress the deck's strategic combo (playing
    // key cards, using elemental skills) — a small positive nudge that
    // accumulates over a turn.  Disabled by default; enable via
    // componentConfigs.comboProbability.enabled = true.
    registry.register({
      id: "combo_probability",
      label: "Combo Probability Nudge",
      enabled: (ctx) =>
        (ctx.componentConfigs.comboProbability as { enabled?: boolean } | undefined)?.enabled === true,
      score: (ctx) => {
        const ac = String(ctx.candidate.action_case ?? "")
        let bonus = 0
        if (ac === "playCard") {
          // Playing cards progresses any combo that relies on specific cards
          bonus = 0.008
        } else if (ac === "useSkill") {
          // Skills are always part of some combo (damage, elemental application)
          bonus = 0.005
        }
        if (bonus === 0) return { id: "combo_probability", score: 0, reasons: [] }
        return { id: "combo_probability", score: bonus, reasons: [`combo_prob=+${bonus.toFixed(3)}`] }
      },
    })

    // ── Luck Awareness ──
    // Adjusts action preferences based on current luck state.
    // When dice are favorable → prefer conservative, lead-securing plays.
    // When dice are unfavorable → prefer variance-creating, aggressive plays.
    // Disabled by default; enable via componentConfigs.luckAwareness.enabled = true.
    registry.register({
      id: "luck_awareness",
      label: "Luck-Aware Action Adjustment",
      enabled: (ctx) =>
        (ctx.componentConfigs.luckAwareness as { enabled?: boolean } | undefined)?.enabled === true &&
        ctx.context?.observation != null,
      score: (ctx) => {
        const obs = ctx.context!.observation!
        const diceTotal = obs.self.dice.total_count
        if (diceTotal === 0) return { id: "luck_awareness", score: 0, reasons: [] }

        const omniCount = obs.self.dice.omni_count
        const expectedOmni = diceTotal / 8
        const luckSignal = (omniCount - expectedOmni) / Math.max(diceTotal, 1)
        // luckSignal > 0 → lucky dice (more omni than expected)
        // luckSignal < 0 → unlucky dice

        const ac = String(ctx.candidate.action_case ?? "")
        let bonus = 0
        const r = ctx.digest.round

        if (luckSignal > 0.15) {
          // Lucky: prefer safe, value-securing actions
          if (ac === "playCard") bonus = 0.01
          else if (ac === "declareEnd" && obs.opponent.declared_end) bonus = 0.01
        } else if (luckSignal < -0.10) {
          // Unlucky: prefer aggressive, variance-creating actions
          if (ac === "useSkill" && r >= 2) bonus = 0.01
          else if (ac === "switchActive") bonus = 0.005
        }

        if (bonus === 0) return { id: "luck_awareness", score: 0, reasons: [] }
        return { id: "luck_awareness", score: bonus, reasons: [`luck=+${bonus.toFixed(2)}(sig=${luckSignal.toFixed(2)})`] }
      },
    })

    return registry
  }

  override choose(digest: PolicyTurnDigest, context?: PolicyDecisionContext): PolicyDecision {
    const query = buildDecisionPoint(digest)
    const candidates = digest.candidate_actions.map((candidate) =>
      buildMlCandidate(query.query_id, digest, candidate),
    )
    const conceptState = this.conceptModel?.predict(query, candidates) ?? null
    const combatWindowSelection = this.combatWindowLibrary
      ? selectCombatWindowLibrary(
          this.combatWindowLibrary,
          buildLibraryQueryFromPolicyDigest(digest),
          {
            minScore: this.combatWindowMinScore,
          },
        )
      : null
    const macroPlanState = resolveRuntimeMacroPlanState(
      digest,
      context?.observation,
      context?.macroPlanState,
      combatWindowSelection,
    )
    // GamePlan override
    if (context?.gamePlanState && macroPlanState.plan) {
      const gpKind = gamePlanToMacroPlanKind(context.gamePlanState)
      const gpTags = getPhasePreferTags(context.gamePlanState)
      if (macroPlanState.plan.source !== "combat_window" || macroPlanState.plan.confidence < 0.75) {
        macroPlanState.plan.kind = gpKind
        macroPlanState.plan.prefer_tags = [
          ...gpTags,
          ...macroPlanState.plan.prefer_tags.filter((t) => !gpTags.includes(t)),
        ]
      }
    }
    const planSearchGuidance = buildCombatWindowPlanSearchGuidance(
      digest.candidate_actions,
      combatWindowSelection,
    )
    const reactionChainMatches = context?.observation
      ? matchReactionChainTemplates(context.observation)
      : []
    const selectableCandidates = digest.candidate_actions
      .filter((candidate) => candidate.is_valid !== false)
      .filter((candidate) => {
        if (context?.splPreFiltered) return true
        const banList = context?.actionBanList
        if (!banList || banList.length === 0) return true
        return !matchAnyPattern(banList, candidate)
      })

    const ranked = selectableCandidates
      .map((candidate) =>
        this.rankCandidateWithGiMl(
          digest,
          candidate,
          candidates[digest.candidate_actions.indexOf(candidate)] ?? null,
          query,
          conceptState,
          macroPlanState.plan,
          planSearchGuidance.adjustments.get(String(candidate.candidate_id ?? "")) ?? null,
          context,
          reactionChainMatches,
        ),
      )
      .sort((left, right) => {
        if (right.finalScore !== left.finalScore) {
          return right.finalScore - left.finalScore
        }
        if (this.useBaselineTieBreaker && right.heuristicScore !== left.heuristicScore) {
          return right.heuristicScore - left.heuristicScore
        }
        return left.candidateId.localeCompare(right.candidateId)
      })
    const nextMacroPlanState = advanceRuntimeMacroPlanState(
      macroPlanState,
      ranked[0]?.candidate,
    )
    const guidanceNotes = [
      ...(macroPlanState.plan
        ? [
            `macro_plan=${macroPlanState.plan.kind}`,
            `macro_plan_source=${macroPlanState.plan.source}`,
          ]
        : []),
      ...planSearchGuidance.notes,
    ]

    return {
      selectedCandidateId: this.temperatureSample(ranked)?.candidateId ?? null,
      ranked,
      macroPlanState: nextMacroPlanState,
      guidanceNotes,
    }
  }

  private rankCandidateWithGiMl(
    digest: PolicyTurnDigest,
    candidate: PolicyCandidateAction,
    mlCandidate: MlCandidateAction | null,
    query: MlDecisionPoint,
    conceptState: RuntimeConceptState | null,
    macroPlan: RuntimeMacroPlan | null,
    planSearchGuidance: { score: number; reasons: string[] } | null,
    context?: PolicyDecisionContext,
    reactionChainMatches?: ReactionChainMatch[],
  ): RankedPolicyCandidate {
    const baseline = super.rankCandidate(digest, candidate, undefined, context)

    // Build scoring context once per candidate
    const scoringCtx = makeScoringContext(
      digest, candidate, mlCandidate, query, conceptState,
      macroPlan, planSearchGuidance, context, reactionChainMatches,
      {
        gbdtValueDirectMode: this.gbdtValueDirectMode,
        rankerConfig: this.rankerArtifact.config,
        gbdtRankerArtifact: this.gbdtRankerArtifact,
        qValueArtifact: this.qValueArtifact,
        valueArtifact: this.valueArtifact,
        valueWeight: this.valueWeight,
        qValueWeight: this.qValueWeight,
        tuneFollowupWeight: this.tuneFollowupWeight,
        macroPlanWeight: this.macroPlanWeight,
        planSearchWeight: this.planSearchWeight,
        strategicValueWeight: this.strategicValueWeight,
        reactionChainWeight: this.reactionChainWeight,
        tempoValueWeight: this.tempoValueWeight,
        temporalOpportunityWeight: this.temporalOpportunityWeight,
        combatWindowLibrary: this.combatWindowLibrary,
        componentConfigs: {
          priorFeatures: this.deckPriorFeatures,
        },
      },
    )

    // Iterate through registry for all component scores
    const contributions = this.scoringRegistry.scoreAll(scoringCtx)
    const finalScore = contributions.reduce((sum, c) => sum + c.score, 0)
    const allReasons = contributions
      .filter((c) => c.reasons.length > 0)
      .flatMap((c) => c.reasons)

    return {
      ...baseline,
      finalScore,
      reasons: [
        ...allReasons,
        `baseline=${baseline.heuristicScore.toFixed(3)}`,
        ...(conceptState
          ? [`concepts=${conceptState.values.length}`]
          : ["concepts=0"]),
      ],
    }
  }

  /**
   * Score a candidate using GBDT ranker (primary) or SlotLinearRanker (fallback).
   */
  private scoreCandidate(
    query: MlDecisionPoint,
    mlCandidate: MlCandidateAction,
    conceptState: RuntimeConceptState | null,
  ): number {
    if (this.gbdtRankerArtifact) {
      const queryFeatures = flattenNumericRecord(query.context_slots)
      const candidateFeatures = flattenNumericRecord(mlCandidate.runtime_slots)
      return predictGbdtRankerScore(
        this.gbdtRankerArtifact,
        queryFeatures,
        candidateFeatures,
      )
    }
    return scoreMlCandidate(this.rankerArtifact.config, query, mlCandidate, conceptState)
  }
}
// ── Phase C1: Phase alignment scoring ──
// Rewards actions that match expected behavior for the current game phase.
// Round 1 (opening): summon skills, support cards, fast switches
// Round 2 (midgame): attack skills, reaction setup, equipment
// Round 3+ (closing): burst skills, healing, direct damage
function computePhaseAlignment(
  round: number,
  candidate: PolicyCandidateAction,
  macroPlan: RuntimeMacroPlan | null,
): { score: number; reason: string } {
  const ac = String(candidate.action_case ?? "")
  if (!ac) return { score: 0, reason: "" }

  // Round 1 — Opening: prioritize setup actions
  if (round <= 1) {
    if (ac === "useSkill") {
      const tags = String(candidate.tags ?? "")
      if (tags.includes("summon") || tags.includes("elementalSkill")) {
        return { score: 0.15, reason: "phase_opening_summon=+0.15" }
      }
    }
    if (ac === "playCard") {
      const tags = String(candidate.tags ?? "")
      if (tags.includes("support") || tags.includes("artifact") || tags.includes("location")) {
        return { score: 0.1, reason: "phase_opening_support=+0.10" }
      }
    }
    if (ac === "endTurn") {
      // Early end-turn in opening: good if opponent hasn't ended
      return { score: 0.05, reason: "phase_opening_fast_end=+0.05" }
    }
    // Penalize attacks in opening
    if (ac === "useSkill" && String(candidate.tags ?? "").includes("normalAttack")) {
      return { score: -0.05, reason: "phase_opening_attack_penalty=-0.05" }
    }
  }

  // Round 2 — Midgame: prioritize attack and reaction
  if (round === 2) {
    if (ac === "useSkill") {
      const tags = String(candidate.tags ?? "")
      if (tags.includes("elementalSkill") || tags.includes("elementalBurst")) {
        if (Number(candidate.damage_estimate ?? 0) > 2) {
          return { score: 0.2, reason: "phase_midgame_skill_damage=+0.20" }
        }
        return { score: 0.1, reason: "phase_midgame_skill=+0.10" }
      }
    }
    if (ac === "switchActive" && macroPlan?.kind === "reaction_convert") {
      return { score: 0.1, reason: "phase_midgame_reaction_switch=+0.10" }
    }
  }

  // Round 3+ — Closing: prioritize burst and lethal setup
  if (round >= 3) {
    if (ac === "useSkill") {
      const tags = String(candidate.tags ?? "")
      if (tags.includes("elementalBurst")) {
        return { score: 0.25, reason: "phase_closing_burst=+0.25" }
      }
      if (Number(candidate.damage_estimate ?? 0) > 4) {
        return { score: 0.2, reason: "phase_closing_heavy_damage=+0.20" }
      }
    }
    if (ac === "switchActive" && Number(candidate.self_switch_value ?? 0) > 2) {
      return { score: 0.1, reason: "phase_closing_protect_switch=+0.10" }
    }
    // Penalize pure setup actions in closing
    if (ac === "playCard") {
      const tags = String(candidate.tags ?? "")
      if (!tags.includes("food") && !tags.includes("talent")) {
        return { score: -0.05, reason: "phase_closing_setup_penalty=-0.05" }
      }
    }
  }

  return { score: 0, reason: "" }
}

// ── Phase C1: Dice fitness scoring ──
// Penalizes actions whose dice cost is incompatible with the current phase plan.
// In opening: prefer low-cost actions (save dice for setup)
// In closing: accept higher costs for finishing moves
function computeDiceFitness(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  context: PolicyDecisionContext | undefined,
): { score: number; reason: string } {
  const costRaw = (candidate as Record<string, unknown>).cost
  if (!costRaw || typeof costRaw !== "object") return { score: 0, reason: "" }

  const cost = costRaw as Record<string, number>
  // Count total dice cost for this action
  let totalCost = 0
  for (const v of Object.values(cost)) {
    if (typeof v === "number" && Number.isFinite(v)) totalCost += v
  }
  if (totalCost <= 0) return { score: 0, reason: "" }

  // Estimate remaining dice (from resource summary)
  const resource = digest.resource_summary as Record<string, unknown>
  const dicePool = (resource.dice ?? resource.dicePool ?? resource.available_dice ?? resource.dice_count) as Record<string, number> | number | undefined
  let remainingDice = 0
  if (typeof dicePool === "number") {
    remainingDice = dicePool
  } else if (dicePool && typeof dicePool === "object") {
    for (const v of Object.values(dicePool)) {
      if (typeof v === "number") remainingDice += v
    }
  }

  const round = digest.round

  // Opening (R1): penalize high-cost actions — we need dice for setup
  if (round <= 1 && totalCost >= 3) {
    return { score: -0.1, reason: `dice_fitness_opening_cost${totalCost}=-0.10` }
  }

  // Closing (R3+): reward efficient finishing moves
  if (round >= 3 && totalCost <= 2 && remainingDice >= 8) {
    return { score: 0.05, reason: "dice_fitness_closing_efficient=+0.05" }
  }

  // General: if action cost > 50% of remaining dice, slight penalty
  if (remainingDice > 0 && totalCost / remainingDice > 0.6) {
    return { score: -0.05, reason: `dice_fitness_high_cost_ratio=${(totalCost/remainingDice).toFixed(2)}` }
  }

  return { score: 0, reason: "" }
}

function buildDecisionPoint(digest: PolicyTurnDigest): MlDecisionPoint {
  return {
    query_id: buildQueryId(digest),
    source: "runtime",
    state_ref: null,
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: digest.candidate_actions.map((candidate, index) =>
      String(candidate.candidate_id ?? index),
    ),
    evidence_refs: [],
    context_slots: {
      round: digest.round,
      actor: digest.turn,
      legal_action_count: digest.candidate_actions.length,
      self_active_character_definition_id: activeCharacterDefinitionId(digest.self_summary),
      opp_active_character_definition_id: activeCharacterDefinitionId(digest.opponent_summary),
      self_active_character_semantic_tags: getCharacterSemanticTags(activeCharacterDefinitionId(digest.self_summary)),
      opp_active_character_semantic_tags: getCharacterSemanticTags(activeCharacterDefinitionId(digest.opponent_summary)),
      query_numeric_slots: buildBranchEvalQueryNumericSlots(digest),
    },
  }
}

function buildMlCandidate(
  queryId: string,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
): MlCandidateAction {
  return {
    candidate_id: String(candidate.candidate_id ?? ""),
    query_id: queryId,
    action_case: String(candidate.action_case ?? "unknown"),
    runtime_slots: {
      candidate_tags: normalizeTags(candidate.tags),
      action_definition_kind: actionDefinitionKind(candidate),
      skill_definition_id: numericOrNull(candidate.skill_definition_id),
      card_definition_id: numericOrNull(candidate.card_definition_id),
      character_definition_id: numericOrNull(candidate.character_definition_id),
      actor_character_definition_id: activeCharacterDefinitionId(digest.self_summary),
      candidate_numeric_slots: buildBranchEvalCandidateNumericSlots(digest, candidate),
    },
  }
}

function buildQueryId(digest: PolicyTurnDigest): string {
  const activeSelf = activeCharacterDefinitionId(digest.self_summary) ?? "na"
  const activeOpp = activeCharacterDefinitionId(digest.opponent_summary) ?? "na"
  return `runtime:r${digest.round}:t${digest.turn}:self${activeSelf}:opp${activeOpp}:legal${digest.candidate_actions.length}`
}

function scoreMlCandidate(
  config: SlotLinearRankerConfig,
  query: MlDecisionPoint,
  candidate: MlCandidateAction,
  conceptState: RuntimeConceptState | null,
): number {
  let score = 0
  score += config.action_case_bias?.[candidate.action_case] ?? 0
  score += candidateTagBias(config, candidate.runtime_slots)
  score += numericSlotWeights(config.candidate_numeric_slot_weights, candidate.runtime_slots ?? null)
  score += numericSlotWeights(config.query_numeric_slot_weights, query.context_slots ?? null)
  score += conceptPresenceWeights(config, conceptState)
  score += conceptNumericWeights(config, conceptState)
  return score
}

function candidateTagBias(
  config: SlotLinearRankerConfig,
  runtimeSlots: SlotValue | null | undefined,
): number {
  const weights = config.candidate_tag_bias
  if (!weights || !runtimeSlots) {
    return 0
  }

  return extractRuntimeTags(runtimeSlots).reduce(
    (sum, tag) => sum + (weights[tag] ?? 0),
    0,
  )
}

function numericSlotWeights(
  weights: Record<string, number> | undefined,
  slot: SlotValue,
): number {
  if (!weights || !slot) {
    return 0
  }

  let total = 0
  for (const [path, weight] of Object.entries(weights)) {
    const value = numericValueAtPath(slot, path)
    if (value != null) {
      total += value * weight
    }
  }
  return total
}

function runtimeGuardrailAdjustment(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
): number {
  if (candidate.action_case !== "elementalTuning") {
    return 0
  }

  const handCount = currentCardsInHand(digest)
  const round = Number(digest.round ?? 0)
  const retentionValue = numericRecordValue(candidate.meta_effect_slots, "retention_value_proxy")
  const reactionLoss = numericRecordValue(candidate.meta_effect_slots, "reaction_window_loss")
  const finisherLoss = numericRecordValue(candidate.meta_effect_slots, "finisher_alignment_loss")
  const setupLoss = numericRecordValue(candidate.meta_effect_slots, "setup_dependency_loss")
  const highValueSacrifice = numericRecordValue(candidate.synergy_slots, "sacrifice_is_high_value")
  const reactionPieceSacrifice = numericRecordValue(candidate.synergy_slots, "sacrifice_is_reaction_piece")
  const postTuneHandCount = Math.max(0, handCount - 1)
  const hasPlayableNonTuningLine = digest.candidate_actions.some((other) =>
    other !== candidate &&
    other.action_case !== "elementalTuning" &&
    (other.action_case === "useSkill" ||
      other.action_case === "playCard" ||
      other.action_case === "switchActive"),
  )

  let penalty = 0
  if (round <= 1) {
    if (postTuneHandCount <= 1) {
      penalty -= 4
    }
    if (hasPlayableNonTuningLine && (retentionValue > 0 || reactionLoss > 0 || highValueSacrifice > 0)) {
      penalty -= 1
    }
  }

  penalty -= retentionValue * 1.5
  penalty -= reactionLoss * 1.5
  penalty -= finisherLoss * 1.25
  penalty -= setupLoss
  penalty -= highValueSacrifice * 2.5
  penalty -= reactionPieceSacrifice * 2

  return penalty
}

function numericRecordValue(value: unknown, key: string): number {
  if (!value || typeof value !== "object") {
    return 0
  }
  const record = value as Record<string, unknown>
  const numeric = Number(record[key] ?? 0)
  return Number.isFinite(numeric) ? numeric : 0
}

function currentCardsInHand(digest: PolicyTurnDigest): number {
  const cardsInHand = Number(
    (digest.resource_summary as Record<string, unknown>)?.cards_in_hand ?? 0,
  )
  if (Number.isFinite(cardsInHand) && cardsInHand > 0) {
    return cardsInHand
  }
  const handCards = (digest.self_summary as Record<string, unknown>)?.hand_cards
  return Array.isArray(handCards) ? handCards.length : 0
}

/**
 * Compute Q(s,a) adjustment for a candidate action using a trained Q-value artifact.
 * Unlike approximateCandidateValueAdjustment (which approximates V(s')-V(s)),
 * this directly estimates Q(s, candidate) using (state + action) features.
 * The returned value is Q(s,a) * weight, providing a per-candidate signal that
 * differentiates between candidates in the same state.
 */
function computeQValueAdjustment(
  artifact: GbdtQValueArtifact,
  observation: NonNullable<PolicyDecisionContext["observation"]>,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  weight: number,
): number {
  const actionCase = String(candidate.action_case ?? "")
  const tags: string[] = Array.isArray(candidate.tags) ? (candidate.tags as string[]) : []
  const isFastAction = tags.some((t) => String(t).toLowerCase().includes("fast")) ? 1 : 0
  // Read meta_effect_slots — same values as stored in ActionCandidateV1 at training time
  const meta = ((candidate.meta_effect_slots ?? {}) as Record<string, unknown>)
  const metaNum = (k: string) => {
    const v = Number(meta[k] ?? 0)
    return Number.isFinite(v) ? v : 0
  }
  // Dice cost from required_cost array or fallback to cost fields
  const requiredCost = Array.isArray(candidate.required_cost)
    ? (candidate.required_cost as Array<{ count?: number; type?: number }>)
    : []
  const diceCost = requiredCost.reduce((sum, e) => sum + (Number(e.count) || 0), 0)

  const actionFeatures: Record<string, number> = {
    is_use_skill: actionCase === "useSkill" ? 1 : 0,
    is_play_card: actionCase === "playCard" ? 1 : 0,
    is_switch_active: actionCase === "switchActive" ? 1 : 0,
    is_declare_end: actionCase === "declareEnd" ? 1 : 0,
    is_elemental_tuning: actionCase === "elementalTuning" ? 1 : 0,
    is_fast_action: isFastAction,
    dice_cost: diceCost,
    tempo_gain_now: metaNum("tempo_gain_now"),
    reaction_window_enable: metaNum("reaction_window_enable"),
    burst_window_enable: metaNum("burst_window_enable"),
    action_density_gain: metaNum("action_density_gain"),
    stability_gain: metaNum("stability_gain"),
    finisher_alignment: metaNum("finisher_alignment"),
    setup_dependency: metaNum("setup_dependency"),
    resource_conversion_score: metaNum("resource_conversion_score"),
    retention_value_proxy: metaNum("retention_value_proxy"),
    setup_dependency_loss: metaNum("setup_dependency_loss"),
    reaction_window_loss: metaNum("reaction_window_loss"),
    finisher_alignment_loss: metaNum("finisher_alignment_loss"),
    source_definition_id: Number(candidate.card_definition_id ?? 0),
  }

  // State features: current observation (no candidate effect applied — Q already encodes action)
  const stateSlots = buildApproximateValueFeatureSlots(observation, digest, null)
  const stateSample = {
    sample_id: `${observation.point.decision_point_id}:q:${String(candidate.candidate_id ?? "c")}`,
    source: "runtime" as const,
    state_ref: observation.point.decision_point_id,
    target_value: 0.5,
    feature_slots: stateSlots,
  }

  const qValue = predictQValue(artifact, stateSample, actionFeatures)
  return qValue * weight
}

function approximateCandidateValueAdjustment(
  artifact: AnyValueArtifact,
  observation: PolicyDecisionContext["observation"],
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  weight: number,
): number {
  if (!observation) {
    return 0
  }
  const currentSlots = buildApproximateValueFeatureSlots(observation, digest, null)
  const nextSlots = buildApproximateValueFeatureSlots(observation, digest, candidate)
  const currentValue = predictValue(artifact, {
    sample_id: `${observation.point.decision_point_id}:current`,
    source: "runtime",
    state_ref: observation.point.decision_point_id,
    target_value: 0.5,
    feature_slots: currentSlots,
  })
  const nextValue = predictValue(artifact, {
    sample_id: `${observation.point.decision_point_id}:${String(candidate.candidate_id ?? "candidate")}`,
    source: "runtime",
    state_ref: observation.point.decision_point_id,
    target_value: 0.5,
    feature_slots: nextSlots,
  })
  return (nextValue - currentValue) * weight
}

/**
 * GBDT value direct mode: compute V(s') (expected value of state after candidate action)
 * instead of the delta V(s') - V(s). Used when gbdtValueDirectMode is enabled.
 */
function computeCandidateGbdtDirectValue(
  artifact: AnyValueArtifact,
  observation: NonNullable<PolicyDecisionContext["observation"]>,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  weight: number,
): number {
  const nextSlots = buildApproximateValueFeatureSlots(observation, digest, candidate)
  const nextValue = predictValue(artifact, {
    sample_id: `${observation.point.decision_point_id}:${String(candidate.candidate_id ?? "candidate")}`,
    source: "runtime",
    state_ref: observation.point.decision_point_id,
    target_value: 0.5,
    feature_slots: nextSlots,
  })
  // Scale to [0, 1] range: center at 0.5 so weights are comparable with ranker scores
  return (nextValue - 0.5) * weight
}

function buildApproximateValueFeatureSlots(
  observation: NonNullable<PolicyDecisionContext["observation"]>,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction | null,
): Record<string, JsonValue> {
  const selfSupportDelta = candidate ? safeNumber(candidate.create_support_value) : 0
  const selfSummonDelta = candidate ? safeNumber(candidate.create_summon_value) : 0
  const isBurst = candidate ? isBurstCandidate(candidate) : false
  const rawEnergyDelta = candidate ? safeNumber(candidate.energy_gain_value) : 0
  // Q3 fix: burst consumes all active energy; energy_gain_value only counts gains
  const burstEnergyCost = isBurst
    ? (observation.self.characters[observation.self.active_character_index ?? 0]?.energy ?? 0)
    : 0
  const energyDelta = rawEnergyDelta - burstEnergyCost
  const handDelta = candidate ? estimateHandDelta(candidate) : 0
  const selfHeal = candidate ? safeNumber(candidate.healing_estimate) + safeNumber(candidate.self_heal_value) : 0
  const teamHeal = candidate ? safeNumber(candidate.team_heal_value) : 0
  const outgoingDamage = candidate ? safeNumber(candidate.damage_estimate) + safeNumber(candidate.reaction_value) : 0
  const opponentPressure = candidate ? safeNumber(candidate.tempo_value) : 0

  const currentSelfActiveIndex = observation.self.active_character_index ?? 0
  const currentOppActiveIndex = observation.opponent.active_character_index ?? 0
  const selfActive = observation.self.characters[currentSelfActiveIndex] ?? null
  const oppActive = observation.opponent.characters[currentOppActiveIndex] ?? null

  const selfActiveHealth = Math.max(0, (selfActive?.health ?? 0) + selfHeal)
  const oppActiveHealth = Math.max(0, (oppActive?.health ?? 0) - outgoingDamage)

  return {
    round: digest.round,
    current_turn: digest.turn,
    action_count_in_round: observation.point.action_count_in_round,
    self: {
      hand_count: Math.max(0, observation.self.hand.card_count + handDelta),
      dice_count: Number((digest.resource_summary as Record<string, unknown>).dice_count ?? observation.self.dice.total_count),
      omni_count: Number((digest.resource_summary as Record<string, unknown>).omni_count ?? observation.self.dice.omni_count),
      support_count: observation.self.supports.length + selfSupportDelta,
      summon_count: observation.self.summons.length + selfSummonDelta,
      alive_count: observation.self.characters.filter((character) => character.alive).length,
      total_health: observation.self.characters.reduce((sum, character, index) =>
        sum + (index === currentSelfActiveIndex ? selfActiveHealth : character.health + teamHeal), 0),
      total_energy: observation.self.characters.reduce((sum, character, index) =>
        sum + character.energy + (index === currentSelfActiveIndex ? energyDelta : 0), 0),
      active_health: selfActiveHealth,
      active_energy: Math.max(0, (selfActive?.energy ?? 0) + energyDelta),
      can_afford_normal: (observation.self.dice.total_count >= 3) ? 1 : 0,
      can_afford_skill: (observation.self.dice.total_count >= 3) ? 1 : 0,
      can_afford_burst: (observation.self.dice.total_count >= 4) ? 1 : 0,
    },
    opponent: {
      hand_count: observation.opponent.hand.card_count,
      dice_count: observation.opponent.dice.total_count,
      omni_count: observation.opponent.dice.omni_count,
      support_count: observation.opponent.supports.length,
      summon_count: observation.opponent.summons.length,
      alive_count: observation.opponent.characters.filter((character) => character.alive).length,
      total_health: observation.opponent.characters.reduce((sum, character, index) =>
        sum + (index === currentOppActiveIndex ? oppActiveHealth : character.health), 0),
      total_energy: observation.opponent.characters.reduce((sum, character) => sum + character.energy, 0),
      active_health: oppActiveHealth,
      active_energy: oppActive?.energy ?? 0,
    },
    public_state: {
      self_declared_end: observation.public_state.self_declared_end || candidate?.action_case === "declareEnd",
      opponent_declared_end: observation.public_state.opponent_declared_end,
      self_support_count: observation.public_state.self_support_count + selfSupportDelta,
      opponent_support_count: observation.public_state.opponent_support_count,
      self_summon_count: observation.public_state.self_summon_count + selfSummonDelta,
      opponent_summon_count: observation.public_state.opponent_summon_count,
    },
    derived: {
      self_damage_capacity_now: Math.max(0, observation.derived.self_damage_capacity_now + outgoingDamage),
      opp_damage_capacity_now: Math.max(0, observation.derived.opp_damage_capacity_now - outgoingDamage * 0.5),
      self_ko_pressure_now: Math.max(0, observation.derived.self_ko_pressure_now + outgoingDamage),
      opp_ko_pressure_now: Math.max(0, observation.derived.opp_ko_pressure_now - opponentPressure),
      self_resource_score: observation.derived.self_resource_score + selfSupportDelta + selfSummonDelta + energyDelta * 0.5 + handDelta * 0.5,
      opp_resource_score: observation.derived.opp_resource_score,
      self_reaction_ready_score: observation.derived.self_reaction_ready_score + safeNumber(candidate?.reaction_value),
      opp_reaction_ready_score: observation.derived.opp_reaction_ready_score,
      self_burst_online_count: observation.derived.self_burst_online_count - (isBurst ? 1 : 0),
      opp_burst_online_count: observation.derived.opp_burst_online_count,
      self_role_integrity_score: observation.derived.self_role_integrity_score + selfHeal * 0.25,
      opp_role_integrity_score: observation.derived.opp_role_integrity_score - outgoingDamage * 0.1,
      self_window_score: observation.derived.self_window_score + opponentPressure + safeNumber(candidate?.tempo_value),
      opp_window_score: observation.derived.opp_window_score - opponentPressure,
    },
    static_priors: {
      self_effect_family_counts: observation.self.effect_family_counts ?? {},
      self_meta_prior_slots: observation.self.meta_prior_slots ?? {},
      opponent_public_effect_family_counts: observation.opponent.effect_family_counts ?? {},
      opponent_public_meta_prior_slots: observation.opponent.meta_prior_slots ?? {},
    },
    // Per-character features (aligned with training)
    self_characters: buildRuntimeCharacterFeatures(observation.self.characters, currentSelfActiveIndex, selfActiveHealth, energyDelta),
    opponent_characters: buildRuntimeCharacterFeatures(observation.opponent.characters, currentOppActiveIndex, oppActiveHealth, 0),
    // Hand composition features (aligned with training)
    hand_composition: buildRuntimeHandComposition(observation.self.hand, handDelta),
    // 方案 A+ 新增特征
    opponent_bench: buildRuntimeOpponentBenchFeatures(observation.opponent),
    opponent_active: buildRuntimeOpponentActiveFeatures(observation.opponent),
    self_active: buildRuntimeSelfActiveFeatures(observation.self, observation.self.dice),
    pending_method: {
      is_action: observation.point.pending_method === "action" ? 1 : 0,
      is_choose_active: observation.point.pending_method === "chooseActive" ? 1 : 0,
      is_reroll_dice: observation.point.pending_method === "rerollDice" ? 1 : 0,
      is_switch_hands: observation.point.pending_method === "switchHands" ? 1 : 0,
      is_select_card: observation.point.pending_method === "selectCard" ? 1 : 0,
    },
  }
}

function estimateHandDelta(candidate: PolicyCandidateAction): number {
  switch (candidate.action_case) {
    case "playCard":
    case "elementalTuning":
      return -1
    default:
      return 0
  }
}

function isBurstCandidate(candidate: PolicyCandidateAction): boolean {
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : []
  return tags.includes("skill_type:burst") || tags.includes("burst_enable")
}

interface RuntimeCharacterLike {
  definition_id: number
  alive: boolean
  health: number
  max_health: number
  energy: number
  max_energy: number
  equipment_ids?: number[]
}

function buildRuntimeCharacterFeatures(
  characters: readonly RuntimeCharacterLike[],
  activeIndex: number,
  activeHealth: number,
  activeEnergyDelta: number,
): Record<string, number> {
  const features: Record<string, number> = {}
  for (let i = 0; i < 3; i++) {
    const ch = characters[i]
    const prefix = `c${i}`
    if (!ch) {
      features[`${prefix}_alive`] = 0
      features[`${prefix}_hp`] = 0
      features[`${prefix}_hp_ratio`] = 0
      features[`${prefix}_energy_ratio`] = 0
      features[`${prefix}_equip_count`] = 0
      features[`${prefix}_definition_id`] = 0
      continue
    }
    const hp = i === activeIndex ? activeHealth : ch.health
    const energy = i === activeIndex ? Math.max(0, ch.energy + activeEnergyDelta) : ch.energy
    features[`${prefix}_alive`] = ch.alive ? 1 : 0
    features[`${prefix}_hp`] = hp
    features[`${prefix}_hp_ratio`] = ch.max_health > 0 ? hp / ch.max_health : 0
    features[`${prefix}_energy_ratio`] = ch.max_energy > 0 ? energy / ch.max_energy : 0
    features[`${prefix}_equip_count`] = ch.equipment_ids?.length ?? 0
    features[`${prefix}_definition_id`] = ch.definition_id ?? 0
  }
  return features
}

function buildRuntimeHandComposition(
  hand: { visible_cards: readonly { definition_id?: number | null; tags?: readonly string[]; static_effect_tags?: readonly string[] }[]; card_count: number },
  handDelta: number,
): Record<string, number> {
  let eventCount = 0
  let supportCount = 0
  let equipmentCount = 0
  let foodCount = 0
  let otherCount = 0
  for (const card of hand.visible_cards) {
    const allTags = [...(card.tags ?? []), ...(card.static_effect_tags ?? [])].map(String)
    if (allTags.some((t) => t === "tag:food" || t === "food")) {
      foodCount++
    } else if (allTags.some((t) => t === "support_card" || t === "support_create")) {
      supportCount++
    } else if (allTags.some((t) => t === "equipment_card" || t === "weapon" || t === "artifact")) {
      equipmentCount++
    } else if (allTags.some((t) => t === "event")) {
      eventCount++
    } else {
      otherCount++
    }
  }
  // Per-card definition_id (up to 10 slots, zero-padded, aligned with training)
  const cardIds: Record<string, number> = {}
  const maxHandSlots = 10
  for (let i = 0; i < maxHandSlots; i++) {
    const card = hand.visible_cards[i]
    cardIds[`card${i}_definition_id`] = card?.definition_id ?? 0
  }
  return {
    total: Math.max(0, hand.card_count + handDelta),
    event_count: eventCount,
    support_count: supportCount,
    equipment_count: equipmentCount,
    food_count: foodCount,
    other_count: otherCount,
    ...cardIds,
  }
}

function buildRuntimeOpponentBenchFeatures(
  opponent: NonNullable<PolicyDecisionContext["observation"]>["opponent"],
): { min_hp: number; min_hp_index: number } {
  let minHp = Infinity
  let minHpIndex = -1
  for (let i = 0; i < opponent.characters.length; i++) {
    const ch = opponent.characters[i]
    if (!ch.alive || ch.is_active) continue
    if (ch.health < minHp) {
      minHp = ch.health
      minHpIndex = i
    }
  }
  if (minHpIndex === -1) minHp = 0
  return { min_hp: minHp, min_hp_index: minHpIndex }
}

function buildRuntimeOpponentActiveFeatures(
  opponent: NonNullable<PolicyDecisionContext["observation"]>["opponent"],
): { is_frozen: 0 | 1; is_stunned: 0 | 1; shield: number } {
  const activeIdx = opponent.active_character_index ?? -1
  const activeChar = activeIdx >= 0 ? opponent.characters[activeIdx] : null
  let isFrozen = 0 as 0 | 1
  let isStunned = 0 as 0 | 1
  if (activeChar) {
    const rawEntities = (activeChar as unknown as { entities?: readonly { definition_id: number }[] }).entities
    if (rawEntities?.some((e) => e.definition_id === 106)) isFrozen = 1
    if (rawEntities?.some((e) => e.definition_id === 116033)) isStunned = 1
  }
  const shieldValue = (opponent.combat_statuses as unknown as readonly { variable_name?: string | null; variable_value?: number | null }[] | undefined)
    ?.reduce((sum, cs) => {
      if (cs.variable_name?.toLowerCase().includes("shield")) return sum + (cs.variable_value ?? 0)
      return sum
    }, 0) ?? 0
  return { is_frozen: isFrozen, is_stunned: isStunned, shield: shieldValue }
}

function buildRuntimeSelfActiveFeatures(
  self: NonNullable<PolicyDecisionContext["observation"]>["self"],
  dice: NonNullable<PolicyDecisionContext["observation"]>["self"]["dice"],
): { skill_damage_normal: number; skill_damage_skill: number; skill_damage_burst: number; energy_full: 0 | 1 } {
  const activeIdx = self.active_character_index ?? -1
  const activeChar = activeIdx >= 0 ? self.characters[activeIdx] : null
  const energyFull = activeChar && activeChar.max_energy > 0 && activeChar.energy >= activeChar.max_energy ? 1 as 0 | 1 : 0 as 0 | 1
  return {
    skill_damage_normal: 2,
    skill_damage_skill: 3,
    skill_damage_burst: 4,
    energy_full: energyFull,
  }
}

function estimateTuneFollowupAdjustment(
  digest: PolicyTurnDigest,
  tuningCandidate: PolicyCandidateAction,
  query: MlDecisionPoint,
  conceptState: RuntimeConceptState | null,
  config: SlotLinearRankerConfig,
  weight: number,
): number {
  const diceValues = Array.isArray((digest.resource_summary as Record<string, unknown>).dice_values)
    ? ((digest.resource_summary as Record<string, unknown>).dice_values as number[])
    : []
  const activeElement = activeCharacterElement(digest)
  if (!activeElement || diceValues.length === 0) {
    return 0
  }

  const unlocked = digest.candidate_actions
    .filter((candidate) => candidate.is_valid === false)
    .filter((candidate) => candidate.action_case !== "elementalTuning" && candidate.action_case !== "declareEnd")
    .filter((candidate) => wouldBecomePayableAfterTuning(candidate, diceValues, activeElement))

  if (unlocked.length === 0) {
    return 0
  }

  let best = Number.NEGATIVE_INFINITY
  for (const candidate of unlocked) {
    const mlCandidate = buildMlCandidate(query.query_id, digest, candidate)
    const mlScore = scoreMlCandidate(config, query, mlCandidate, conceptState)
    const heuristic = safeNumber(candidate.damage_estimate)
      + safeNumber(candidate.reaction_value)
      + safeNumber(candidate.create_support_value)
      + safeNumber(candidate.create_summon_value)
      + safeNumber(candidate.energy_gain_value)
      + safeNumber(candidate.tempo_value)
    best = Math.max(best, mlScore + heuristic * 0.15)
  }

  return Number.isFinite(best) ? best * weight : 0
}

function activeCharacterElement(digest: PolicyTurnDigest): number | null {
  const definitionId = activeCharacterDefinitionId(digest.self_summary)
  if (definitionId == null) {
    return null
  }
  return CHARACTER_ELEMENT_BY_DEFINITION_ID.get(definitionId) ?? null
}

function buildCharacterElementMap(): Map<number, number> {
  const map = new Map<number, number>()
  for (const [id, character] of GAME_DATA.characters) {
    map.set(id, characterElementFromDefinition(character))
  }
  return map
}

function buildCharacterSemanticTagsMap(): Map<number, string[]> {
  const map = new Map<number, string[]>()
  for (const [id, character] of GAME_DATA.characters) {
    map.set(id, extractCharacterSemanticTags(character))
  }
  return map
}

function extractCharacterSemanticTags(character: { tags?: readonly string[]; varConfigs?: Record<string, { initialValue: number }> }): string[] {
  const tags: string[] = []
  const characterTags = Array.isArray(character.tags)
    ? character.tags.filter((tag): tag is string => typeof tag === "string")
    : []
  for (const tag of characterTags) {
    // Element tags
    if (["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"].includes(tag)) {
      tags.push(`element:${tag}`)
    }
    // Weapon tags
    if (["sword", "claymore", "polearm", "bow", "catalyst", "otherWeapon"].includes(tag)) {
      tags.push(`weapon:${tag}`)
    }
  }
  // HP tier
  const maxHp = character.varConfigs?.maxHealth?.initialValue
  if (maxHp != null) {
    if (maxHp <= 7) tags.push("hp_tier:low")
    else if (maxHp <= 9) tags.push("hp_tier:mid")
    else tags.push("hp_tier:high")
  }
  // Energy tier
  const maxEnergy = character.varConfigs?.maxEnergy?.initialValue
  if (maxEnergy != null) {
    if (maxEnergy <= 2) tags.push("energy_tier:low")
    else if (maxEnergy <= 3) tags.push("energy_tier:mid")
    else tags.push("energy_tier:high")
  }
  return tags
}

function buildEntitySemanticTagsMap(): Map<number, string[]> {
  const map = new Map<number, string[]>()
  for (const [id, entity] of GAME_DATA.entities) {
    map.set(id, extractEntitySemanticTags(entity))
  }
  return map
}

function extractEntitySemanticTags(entity: { type: string; tags?: readonly string[]; varConfigs?: Record<string, { initialValue: number }> }): string[] {
  const tags: string[] = [`entity:${entity.type}`]
  const entityTags = Array.isArray(entity.tags)
    ? entity.tags.filter((tag): tag is string => typeof tag === "string")
    : []
  for (const tag of entityTags) {
    tags.push(`tag:${tag}`)
    // Map high-level semantic categories
    switch (tag) {
      case "food":
        tags.push("category:consumable")
        break
      case "legend":
        tags.push("category:legendary")
        break
      case "talent":
        tags.push("category:talent")
        break
      case "resonance":
        tags.push("category:resonance")
        break
      case "weapon":
      case "artifact":
        tags.push("category:equipment")
        break
    }
  }
  return tags
}

function getCharacterSemanticTags(definitionId: number | null): string[] {
  if (definitionId == null) return []
  return CHARACTER_SEMANTIC_TAGS_BY_DEFINITION_ID.get(definitionId) ?? []
}

function getEntitySemanticTags(definitionId: number | null): string[] {
  if (definitionId == null) return []
  return ENTITY_SEMANTIC_TAGS_BY_DEFINITION_ID.get(definitionId) ?? []
}

function characterElementFromDefinition(character: { tags?: readonly string[] }): number {
  const tags = Array.isArray(character.tags)
    ? character.tags.filter((tag): tag is string => typeof tag === "string")
    : []
  if (tags.includes("cryo")) return DiceType.Cryo
  if (tags.includes("hydro")) return DiceType.Hydro
  if (tags.includes("pyro")) return DiceType.Pyro
  if (tags.includes("electro")) return DiceType.Electro
  if (tags.includes("anemo")) return DiceType.Anemo
  if (tags.includes("geo")) return DiceType.Geo
  if (tags.includes("dendro")) return DiceType.Dendro
  return DiceType.Void
}

function wouldBecomePayableAfterTuning(
  candidate: PolicyCandidateAction,
  diceValues: readonly number[],
  tunedElement: number,
): boolean {
  const cost = buildCostMap(candidate.required_cost)
  if (cost.size === 0) {
    return false
  }
  if (hasPayableCost(cost, diceValues)) {
    return false
  }

  for (let index = 0; index < diceValues.length; index += 1) {
    const original = Number(diceValues[index] ?? 0)
    if (!Number.isFinite(original) || original <= 0) {
      continue
    }
    const tunedDice = [...diceValues]
    tunedDice[index] = tunedElement
    if (hasPayableCost(cost, tunedDice)) {
      return true
    }
  }
  return false
}

function buildCostMap(value: unknown): Map<number, number> {
  const result = new Map<number, number>()
  if (!Array.isArray(value)) {
    return result
  }
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue
    }
    const type = numericValue((item as Record<string, unknown>).type)
    const count = numericValue((item as Record<string, unknown>).count)
    if (type == null || count == null || count <= 0) {
      continue
    }
    result.set(type, count)
  }
  return result
}

function hasPayableCost(cost: Map<number, number>, diceValues: readonly number[]): boolean {
  return chooseDice(cost as Map<DiceType, number>, diceValues as DiceType[]).some(Boolean)
}

function conceptPresenceWeights(
  config: SlotLinearRankerConfig,
  conceptState: RuntimeConceptState | null,
): number {
  if (!config.concept_presence_weights || !conceptState) {
    return 0
  }

  let total = 0
  for (const [conceptId, weight] of Object.entries(config.concept_presence_weights)) {
    if (conceptState.values.some((value) => value.concept_id === conceptId)) {
      total += weight
    }
  }
  return total
}

function conceptNumericWeights(
  config: SlotLinearRankerConfig,
  conceptState: RuntimeConceptState | null,
): number {
  if (!config.concept_numeric_slot_weights || !conceptState) {
    return 0
  }

  let total = 0
  for (const item of config.concept_numeric_slot_weights) {
    const value = conceptNumericContribution(conceptState, item)
    if (value != null) {
      total += value * item.weight
    }
  }
  return total
}

function conceptNumericContribution(
  conceptState: RuntimeConceptState,
  item: ConceptNumericWeight,
): number | null {
  const concept = conceptState.values.find((value) => value.concept_id === item.concept_id)
  if (!concept?.value_slot) {
    return null
  }
  return numericValueAtPath(concept.value_slot, item.path)
}

function extractRuntimeTags(slot: SlotValue): string[] {
  if (!slot) {
    return []
  }
  const tags = normalizeTags(slot.candidate_tags)
  const actionKind = slot.action_definition_kind
  if (typeof actionKind === "string" && actionKind.length > 0) {
    tags.push(`action_kind::${actionKind}`)
  }

  for (const key of [
    "skill_definition_id",
    "card_definition_id",
    "character_definition_id",
    "actor_character_definition_id",
  ]) {
    const numeric = numericValue(slot[key])
    if (numeric != null) {
      tags.push(`${key}::${numeric}`)
    }
  }

  return tags
}

function numericValueAtPath(slot: SlotValue, path: string): number | null {
  if (!slot) {
    return null
  }
  const parts = path.split(".").filter(Boolean)
  let current: JsonValue | undefined = slot

  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null
    }
    current = current[part]
  }

  return numericValue(current)
}

function numericValue(value: unknown): number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function safeNumber(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function numericOrNull(value: unknown): number | null {
  return numericValue(value)
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
}

function actionDefinitionKind(candidate: PolicyCandidateAction): string | null {
  const actionCase = String(candidate.action_case ?? "unknown")
  switch (actionCase) {
    case "useSkill":
      return "skill"
    case "playCard":
    case "elementalTuning":
      return "card"
    case "switchActive":
      return "character"
    case "declareEnd":
      return "none"
    default:
      return null
  }
}

function activeCharacterDefinitionId(summary: Record<string, unknown>): number | null {
  const activeId = numericValue(summary.active_character_id)
  const characters = Array.isArray(summary.characters)
    ? summary.characters
    : []
  const active = characters.find((character) => {
    if (!character || typeof character !== "object" || Array.isArray(character)) {
      return false
    }
    return numericValue(character.id) === activeId
  })
  if (!active || typeof active !== "object" || Array.isArray(active)) {
    return null
  }
  return numericValue(active.definition_id) ?? numericValue(active.id) ?? null
}

/**
 * P3: 基于对手模型的候选行动评分调整。
 *
 * 当我们知道对手是快攻型时，提升防御/治疗行动；
 * 当对手是控制型时，提升进攻/节奏行动。
 */
function scoreOpponentModelAdjustment(
  candidate: PolicyCandidateAction,
  opponentModelState?: OpponentModelState | null,
): { score: number; reasons: string[] } {
  if (!opponentModelState || opponentModelState.confidence < 0.2) {
    return { score: 0, reasons: [] }
  }

  const style = predictOpponentStyle(opponentModelState)
  let score = 0
  const reasons: string[] = []

  const isHealing = safeNumber(candidate.healing_estimate) > 0
    || safeNumber(candidate.self_heal_value) > 0
    || safeNumber(candidate.team_heal_value) > 0
  const isHighDamage = safeNumber(candidate.damage_estimate) >= 3
  const isDefensiveSwitch = candidate.action_case === "switchActive"
    && safeNumber(candidate.survival_risk) < 0

  // 对手偏攻击 → 提升我方防御/治疗价值
  if (style.aggressionLevel > 0.4) {
    const aggroBonus = (style.aggressionLevel - 0.4) * 0.5
    if (isHealing) {
      score += aggroBonus * 0.6
      reasons.push(`opp_aggro_heal_bonus=${(aggroBonus * 0.6).toFixed(3)}`)
    }
    if (isDefensiveSwitch) {
      score += aggroBonus * 0.3
    }
  }

  // 对手偏防御 → 提升我方进攻/节奏价值
  if (style.defensivenessLevel > 0.4) {
    const ctrlBonus = (style.defensivenessLevel - 0.4) * 0.5
    if (isHighDamage) {
      score += ctrlBonus * 0.4
      reasons.push(`opp_ctrl_dmg_bonus=${(ctrlBonus * 0.4).toFixed(3)}`)
    }
  }

  // 对手可能打 combo → 提升打断/切人价值
  if (style.comboLikelihood > 0.4 && candidate.action_case === "switchActive") {
    score += (style.comboLikelihood - 0.4) * 0.3
  }

  return { score, reasons }
}
