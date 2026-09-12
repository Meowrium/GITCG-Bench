/**
 * BattleGraph — LangGraph.js StateGraph for real-time TCG decision making.
 *
 * Five-node loop:
 *   plan → reason → decide → execute → critic → (loop or end)
 *
 * ── V2 Framework Integration ──
 *   plan:     SPL state machine update + risk assessment
 *   reason:   Mulligan (switchHands), dice bucketing, lethal chain, risk injection
 *   critic:   Replan trigger detection
 *
 * Uses @langchain/langgraph StateAnnotation for typed state management.
 * Communicates with the game via StandaloneMcpClient HTTP API.
 */

import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {
  StandaloneMcpToolHandler,
  StandaloneMcpClient,
} from "@gi-tcg/mcp";
import { LogisticCalibrator, type CalibratedWeights } from "../learning/scoring/logistic-reg.js";
import { FeatureExtractor } from "../learning/scoring/feature-extractor.js";
import { BaselinePolicy } from "../runtime/policy/baseline-policy.js";
import { EvaluatorPolicy } from "../runtime/policy/evaluator-policy.js";
import type { PolicyDecision } from "../runtime/policy/types.js";
import type { PolicyLike } from "../runtime/io/policy-player-io.js";
import { StrategicPlanStateMachine, type PlanUpdateInput } from "../runtime/plan/state-machine.js";
import { compileDeckAnalysisToPlan } from "../runtime/plan/compiler.js";
import { computeRiskAssessment } from "../runtime/policy/risk-model.js";
import { computeLethalChains } from "../runtime/policy/lethal-chain.js";
import { evaluateMulligan, buildDeckOpeningProfile } from "../runtime/policy/mulligan.js";
import { buildDiceBucketsFromActions, allocateDiceToBuckets, computePlanFitness } from "../runtime/plan/dice-budget.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scoring types (mirrored from @gi-tcg/mcp internals)
// ─────────────────────────────────────────────────────────────────────────────

export interface CharacterDefinitionInfo {
  id: number;
  definition_id: number;
  name: string;
  element: string;
  weapon_type: string;
  skills: Array<{
    name: string;
    description: string;
    cost: number;
  }>;
}

export interface CardDefinitionInfo {
  definition_id: number;
  name: string;
  type: string;
  tags: string[];
  cost: number;
  effect_text: string;
}

export interface TurnDigestV1 {
  version: "TurnDigestV1";
  digest_ref: string;
  session_id: string;
  round: number;
  turn: number;
  pending_method: string;
  strategic_profile_ref: string;
  self_summary: Record<string, unknown>;
  opponent_summary: Record<string, unknown>;
  resource_summary: Record<string, unknown>;
  candidate_actions: Array<Record<string, unknown>>;
  hard_constraints: string[];
  character_definitions: CharacterDefinitionInfo[];
  card_definitions: CardDefinitionInfo[];
  generated_at: string;
}

export interface DecisionFragmentV1 {
  version: "DecisionFragmentV1";
  fragment_ref: string;
  session_id: string;
  digest_ref: string;
  intent: string;
  must_do: string[];
  avoid: string[];
  preference_order: string[];
  resource_policy: "strict" | "balanced" | "aggressive";
  target_policy: string;
  fallback_rule: string;
  explanation: string;
  created_at: string;
}

export interface ExecutionFeedbackV1 {
  version: "ExecutionFeedbackV1";
  session_id: string;
  digest_ref: string;
  fragment_ref: string;
  selected_candidate_id: string | null;
  executed_tool: string | null;
  execution_ok: boolean;
  resolver_reason: string;
  score_breakdown: Record<string, number>;
  fallback_used: boolean;
  notes: string[];
  created_at: string;
}

export interface ResolverScoredCandidate {
  candidateId: string;
  actionCase: string;
  score: { strategyMatch: number; localGain: number; futurePotential: number; riskPenalty: number; resourcePenalty: number; total: number };
  conservativeScore: number;
  endTurnLike: boolean;
}

// ── V2 Framework: BattleState extensions ──

interface V2BattleState {
  /** StrategicPlanStateMachine — tracks opening/midgame/closing phase */
  planStateMachine: StrategicPlanStateMachine | null;
  /** Last computed risk assessment */
  lastRiskAssessment: ReturnType<typeof computeRiskAssessment> | null;
  /** Last computed lethal chains */
  lastLethalChains: ReturnType<typeof computeLethalChains>;
}

const BattleState = Annotation.Root({
  /** Current turn digest from the game (populated by plan node). */
  digest: Annotation<TurnDigestV1 | null>({ reducer: (_, v) => v, default: () => null }),
  /** LLM-generated decision fragment. */
  fragment: Annotation<DecisionFragmentV1 | null>({ reducer: (_, v) => v, default: () => null }),
  /** Scored + ranked candidates from the resolver. */
  rankedCandidates: Annotation<ResolverScoredCandidate[]>({ reducer: (_, v) => v, default: () => [] }),
  /** The selected candidate ID to execute. */
  selectedCandidateId: Annotation<string | null>({ reducer: (_, v) => v, default: () => null }),
  /** Local policy decision before MCP resolver execution. */
  policyDecision: Annotation<PolicyDecision | null>({ reducer: (_, v) => v, default: () => null }),
  /** Execution feedback after action is performed. */
  feedback: Annotation<ExecutionFeedbackV1 | null>({ reducer: (_, v) => v, default: () => null }),
  /** Critic's assessment: should we loop or end? */
  criticVerdict: Annotation<"continue" | "end_turn" | "error">({ reducer: (_, v) => v, default: () => "continue" }),
  /** Running conversation history for the LLM. */
  messages: Annotation<Array<{ role: string; content: string }>>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  /** Session ID for multi-game tracking. */
  sessionId: Annotation<string>({ reducer: (_, v) => v, default: () => "" }),
  /** Turn counter within the graph's execution loop. */
  loopCount: Annotation<number>({ reducer: (_, v) => v, default: () => 0 }),
  /** Maximum loops before forced end (safety). */
  maxLoops: Annotation<number>({ reducer: (_, v) => v, default: () => 30 }),

  // ── V2 Framework state ──
  planStateMachine: Annotation<StrategicPlanStateMachine | null>({ reducer: (_, v) => v, default: () => null }),
  lastRiskAssessment: Annotation<ReturnType<typeof computeRiskAssessment> | null>({ reducer: (_, v) => v, default: () => null }),
  lastLethalChains: Annotation<ReturnType<typeof computeLethalChains>>({ reducer: (_, v) => v, default: () => [] }),
});

type BattleStateType = typeof BattleState.State;

// ─────────────────────────────────────────────────────────────────────────────
// Graph Builder
// ─────────────────────────────────────────────────────────────────────────────

export interface BattleGraphOptions {
  /** Base URL of the standalone game server. */
  baseUrl?: string;
  /** OpenAI model name. */
  model?: string;
  /** Temperature for LLM. */
  temperature?: number;
  /** Pre-trained calibrated weights. */
  calibratedWeights?: CalibratedWeights;
  /** Max actions per turn before forced end. */
  maxLoops?: number;
  /** External policy (e.g. GiMlPolicy) to use instead of default Baseline/Evaluator. */
  policy?: PolicyLike;
}

export function buildBattleGraph(options: BattleGraphOptions = {}) {
  const {
    baseUrl = "http://localhost:3901",
    model = "gpt-4o",
    temperature = 0.2,
    calibratedWeights,
    maxLoops = 30,
    policy: externalPolicy,
  } = options;

  const mcpClient = new StandaloneMcpClient(baseUrl);
  const mcpTools = new StandaloneMcpToolHandler(baseUrl, {
    toolExposureMode: "fragmented-decision",
  });
  const llm = new ChatOpenAI({ model, temperature });
  const featureExtractor = new FeatureExtractor();
  const calibrator = calibratedWeights
    ? LogisticCalibrator.fromJSON(calibratedWeights)
    : null;
  const policy = externalPolicy ?? (calibratedWeights
    ? new EvaluatorPolicy(calibratedWeights)
    : new BaselinePolicy());

  function parseToolJson(text: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers: digest → V2 data extraction
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build a PlanUpdateInput from the TurnDigest.
   * V2: Used by StrategicPlanStateMachine.update().
   */
  function buildPlanUpdateInput(digest: TurnDigestV1): PlanUpdateInput {
    const selfSummary = digest.self_summary as Record<string, any> ?? {};
    const oppSummary = digest.opponent_summary as Record<string, any> ?? {};
    const resourceSummary = digest.resource_summary as Record<string, any> ?? {};

    const selfChars = Array.isArray(selfSummary.characters)
      ? selfSummary.characters.map((ch: any) => ({
          id: Number(ch.character_id ?? ch.id ?? 0),
          hp: Number(ch.hp ?? ch.health ?? 10),
          maxHp: Number(ch.max_hp ?? ch.maxHp ?? ch.max_health ?? 10),
          energy: Number(ch.energy ?? 0),
          maxEnergy: Number(ch.max_energy ?? ch.maxEnergy ?? 3),
          defeated: ch.defeated === true || ch.alive === false || Number(ch.hp ?? 1) <= 0,
          definitionId: Number(ch.definition_id ?? ch.definitionId ?? 0),
        }))
      : [];

    const oppChars = Array.isArray(oppSummary.characters)
      ? oppSummary.characters.map((ch: any) => ({
          id: Number(ch.character_id ?? ch.id ?? 0),
          hp: Number(ch.hp ?? ch.health ?? 10),
          maxHp: Number(ch.max_hp ?? ch.maxHp ?? ch.max_health ?? 10),
          energy: Number(ch.energy ?? 0),
          maxEnergy: Number(ch.max_energy ?? ch.maxEnergy ?? 3),
          defeated: ch.defeated === true || ch.alive === false || Number(ch.hp ?? 1) <= 0,
          definitionId: Number(ch.definition_id ?? ch.definitionId ?? 0),
        }))
      : [];

    return {
      round: digest.round,
      selfCharacters: selfChars,
      opponentCharacters: oppChars,
      summons: Array.isArray(selfSummary.summons)
        ? selfSummary.summons.map((s: any) => ({
            characterId: Number(s.character_id ?? s.characterId ?? s.id ?? 0),
          }))
        : [],
      dice: (resourceSummary.dice as Record<string, number>) ?? {},
      handCardIds: Array.isArray(selfSummary.hand_card_ids)
        ? selfSummary.hand_card_ids.map(Number)
        : [],
      opponentDeclaredEnd: oppSummary.declared_end === true || oppSummary.declaredEnd === true,
      selfActiveCharacterId: selfSummary.active_character_id != null
        ? Number(selfSummary.active_character_id)
        : null,
    };
  }

  /**
   * Build a lightweight observation-ish object from digest for risk/lethal-chain.
   */
  function buildDigestObservation(digest: TurnDigestV1): any {
    const selfSummary = digest.self_summary as Record<string, any> ?? {};
    const oppSummary = digest.opponent_summary as Record<string, any> ?? {};
    const resourceSummary = digest.resource_summary as Record<string, any> ?? {};

    const makeChars = (summary: any) => Array.isArray(summary.characters)
      ? summary.characters.map((ch: any) => ({
          id: Number(ch.character_id ?? ch.id ?? 0),
          definition_id: Number(ch.definition_id ?? ch.definitionId ?? 0),
          health: Number(ch.hp ?? ch.health ?? 10),
          max_health: Number(ch.max_hp ?? ch.maxHp ?? ch.max_health ?? 10),
          energy: Number(ch.energy ?? 0),
          max_energy: Number(ch.max_energy ?? ch.maxEnergy ?? 3),
          alive: ch.alive !== false && Number(ch.hp ?? 1) > 0,
          is_active: ch.is_active === true || Number(ch.character_id ?? ch.id ?? 0) === Number(summary.active_character_id ?? -1),
          aura: ch.aura != null ? Number(ch.aura) : null,
        }))
      : [];

    const diceTotal = resourceSummary.dice_total != null
      ? Number(resourceSummary.dice_total)
      : Object.values((resourceSummary.dice as Record<string, number>) ?? {}).reduce((a: number, b: number) => a + b, 0);

    return {
      point: {
        round_number: digest.round,
        action_count_in_round: selfSummary.action_count ?? 0,
      },
      self: {
        characters: makeChars(selfSummary),
        dice: {
          total_count: diceTotal,
          counts_by_type: (resourceSummary.dice as Record<string, number>) ?? {},
          omni_count: Number((resourceSummary.dice as any)?.omni ?? 0),
          unspecified_count: 0,
        },
        summons: Array.isArray(selfSummary.summons) ? selfSummary.summons : [],
      },
      opponent: {
        characters: makeChars(oppSummary),
        dice: {
          total_count: oppSummary.dice_total ?? 0,
          counts_by_type: {},
          omni_count: 0,
          unspecified_count: 0,
        },
        summons: Array.isArray(oppSummary.summons) ? oppSummary.summons : [],
      },
      public_state: {
        opponent_declared_end: oppSummary.declared_end === true || oppSummary.declaredEnd === true,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // SPL initialization: create state machine once per game session
  // ───────────────────────────────────────────────────────────────────────

  function ensurePlanStateMachine(state: BattleStateType): StrategicPlanStateMachine {
    if (state.planStateMachine) return state.planStateMachine;
    // Create a new SPL with generic opening/midgame/closing phases
    const analysis = {
      gamePlan: {
        earlyGame: "Setup summons and investment supports",
        midGame: "Reaction-based offensive",
        lateGame: "Burst lethal",
      },
      commonLines: [],
      winCondition: "",
      strengths: [],
      weaknesses: [],
      strength: 5,
    };
    const phases = compileDeckAnalysisToPlan(analysis as any);
    return new StrategicPlanStateMachine(phases);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Node: plan
  // ───────────────────────────────────────────────────────────────────────

  async function plan(state: BattleStateType): Promise<Partial<BattleStateType>> {
    const digestResult = await mcpTools.executeTool("get_turn_digest_v1", {
      session_id: state.sessionId,
    });

    const digestText = digestResult.content?.[0]?.text ?? "{}";
    const payload = parseToolJson(digestText);
    const digest = payload?.digest as TurnDigestV1 | undefined;

    if (!payload || !payload.ok || !digest) {
      if (payload?.error_code === "NO_PENDING_RPC") {
        return {
          criticVerdict: "end_turn",
          messages: [{ role: "system", content: `No pending RPC, end current loop: ${digestText.slice(0, 300)}` }],
        };
      }
      return {
        criticVerdict: "error",
        messages: [{ role: "system", content: `Failed to get digest: ${digestText.slice(0, 300)}` }],
      };
    }

    const candidates = Array.isArray(digest.candidate_actions)
      ? digest.candidate_actions
      : [];

    // ── V2: Update SPL state machine ──
    const sm = ensurePlanStateMachine(state);
    const planInput = buildPlanUpdateInput(digest);
    const splCtx = sm.update(planInput);

    // ── V2: Compute risk assessment ──
    const observation = buildDigestObservation(digest);
    const riskAssessment = computeRiskAssessment(observation);

    // ── V2: Compute lethal chains (if not reroll/switchHands phase) ──
    const pendingMethod = digest.pending_method ?? "";
    let lethalChains: ReturnType<typeof computeLethalChains> = [];
    if (pendingMethod === "action" && splCtx.phaseId !== "opening") {
      lethalChains = computeLethalChains(observation, candidates);
    }

    return {
      digest,
      planStateMachine: sm,
      lastRiskAssessment: riskAssessment,
      lastLethalChains: lethalChains,
      loopCount: state.loopCount + 1,
      messages: [{
        role: "system",
        content: `[T${digest.round}.${digest.turn}] ${pendingMethod} | phase=${splCtx.phaseId} | risk=${riskAssessment.overallLevel} | chains=${lethalChains.length}`,
      }],
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Node: reason
  // ───────────────────────────────────────────────────────────────────────

  async function reason(state: BattleStateType): Promise<Partial<BattleStateType>> {
    if (state.criticVerdict === "error" || state.criticVerdict === "end_turn") {
      return {};
    }
    if (!state.digest) {
      return { criticVerdict: "error" };
    }

    const digest = state.digest;
    const pendingMethod = digest.pending_method ?? "";
    const risk = state.lastRiskAssessment;

    if (pendingMethod === "switchHands") {
      // ── V2: Mulligan path ──
      return handleMulligan(state, digest);
    }

    // ── Default: policy-based decision ──
    const policyDecision = policy.choose(digest);
    const topActionCase = policyDecision.ranked[0]?.actionCase ?? "unknown";
    const preferenceOrder = Array.from(
      new Set(policyDecision.ranked.map((r) => r.actionCase).filter((v) => v.length > 0)),
    );
    const avoid = policyDecision.ranked
      .filter((r) => r.actionCase === "declareEnd" || r.finalScore < 0)
      .slice(0, 3)
      .map((r) => r.actionCase);

    // ── V2: Dice bucketing injection ──
    const resourceSummary = digest.resource_summary as Record<string, any> ?? {};
    const dicePool = (resourceSummary.dice as Record<string, number>) ?? {};
    const buckets = buildDiceBucketsFromActions(digest.candidate_actions);
    const diceAllocation = buckets.length > 0
      ? allocateDiceToBuckets(dicePool, buckets)
      : null;
    const planFitness = diceAllocation ? diceAllocation.fitness : 1.0;

    // ── V2: Lethal chain injection ──
    const lethalChains = state.lastLethalChains ?? [];

    // ── V2: Risk-based resource policy ──
    let resourcePolicy: "strict" | "balanced" | "aggressive" = "balanced";
    if (risk) {
      if (risk.overallLevel === "critical" || risk.overallLevel === "high") {
        resourcePolicy = "strict";
      } else if (risk.overallLevel === "low" && planFitness > 0.8) {
        resourcePolicy = "aggressive";
      }
    }

    // ── Build explanation ──
    const explanationParts: string[] = [];
    const policyTop = policyDecision.ranked.slice(0, 3)
      .map((r) => `${r.candidateId}:${r.finalScore.toFixed(2)} ${r.reasons.join(",")}`);
    explanationParts.push(`policy:${policyTop.join("|")}`);
    if (diceAllocation && planFitness < 0.7) {
      explanationParts.push(`dice_fitness:${planFitness.toFixed(2)}`);
    }
    if (lethalChains.length > 0) {
      explanationParts.push(`lethal:${lethalChains[0].description}`);
    }
    if (risk) {
      explanationParts.push(`risk:${risk.overallLevel}`);
    }

    const fragment: DecisionFragmentV1 = {
      version: "DecisionFragmentV1",
      fragment_ref: `frag_${Date.now()}`,
      session_id: state.sessionId,
      digest_ref: state.digest.digest_ref,
      intent: `prefer_${topActionCase}`,
      must_do: [],
      avoid,
      preference_order: preferenceOrder,
      resource_policy: resourcePolicy,
      target_policy: "maximize_local_policy_score",
      fallback_rule: "pick_highest_valid_candidate",
      explanation: explanationParts.join(" | "),
      created_at: new Date().toISOString(),
    };

    return {
      policyDecision,
      fragment,
      messages: [{
        role: "assistant",
        content: `Policy intent: ${fragment.intent}; resource=${resourcePolicy}; top=${policyDecision.selectedCandidateId ?? "none"}`,
      }],
    };
  }

  /**
   * ── V2: Mulligan handler ──
   * Replaces the standard policy with mulligan-specific logic.
   */
  async function handleMulligan(
    state: BattleStateType,
    digest: TurnDigestV1,
  ): Promise<Partial<BattleStateType>> {
    const selfSummary = digest.self_summary as Record<string, any> ?? {};
    const cardDefs = digest.card_definitions ?? [];
    const charDefs = digest.character_definitions ?? [];
    const candidateActions = digest.candidate_actions ?? [];

    // Extract hand cards from self_summary
    const handCards = Array.isArray(selfSummary.hand_card_ids)
      ? selfSummary.hand_card_ids.map((id: number, idx: number) => ({
          entity_id: id,
          definition_id: cardDefs.find((cd: any) => cd.definition_id === id)?.definition_id ?? null,
          tags: cardDefs.find((cd: any) => cd.definition_id === id)?.tags ?? [],
          cost_summary: [],
        }))
      : [];

    // Build hand observation
    const handObservation = {
      card_count: handCards.length,
      visible_cards: handCards,
    };

    // Build deck opening profile
    const allCardTags = cardDefs.flatMap((cd: any) => cd.tags ?? []);
    const deckProfile = buildDeckOpeningProfile(
      charDefs.map((cd: any) => ({ definition_id: cd.definition_id, tags: cd.tags ?? [] })),
      allCardTags,
    );

    // Evaluate mulligan
    const mulliganResult = evaluateMulligan(handObservation, [], deckProfile);

    // Build fragment: preference_order = cards to keep, avoid = cards to discard
    const keepActionIds = mulliganResult.keepCards.map((id) => `keep_${id}`);
    const discardActionIds = mulliganResult.discardCards.map((id) => `discard_${id}`);

    const fragment: DecisionFragmentV1 = {
      version: "DecisionFragmentV1",
      fragment_ref: `mulligan_${Date.now()}`,
      session_id: state.sessionId,
      digest_ref: digest.digest_ref,
      intent: `mulligan_${mulliganResult.openingStrategy}`,
      must_do: [],
      avoid: discardActionIds,
      preference_order: keepActionIds,
      resource_policy: "balanced",
      target_policy: "mulligan_keep_strategy",
      fallback_rule: "keep_all",
      explanation: `mulligan:${mulliganResult.openingStrategy} keep=${mulliganResult.keepCards.length}/${handCards.length} ${mulliganResult.planViable ? "viable" : "risky"}`,
      created_at: new Date().toISOString(),
    };

    // Build a minimal policy decision for the return
    const ranked = mulliganResult.cardScores.map((s) => ({
      candidateId: `card_${s.cardId}`,
      actionCase: s.keep ? `keep_${s.cardId}` : `discard_${s.cardId}`,
      heuristicScore: s.score,
      learnedScore: undefined,
      finalScore: s.score,
      reasons: [s.reason],
      candidate: {
        candidate_id: `card_${s.cardId}`,
        action_case: s.keep ? `keep_${s.cardId}` : `discard_${s.cardId}`,
      } as any,
    }));
    ranked.sort((a, b) => b.finalScore - a.finalScore);

    const policyDecision: PolicyDecision = {
      selectedCandidateId: ranked[0]?.candidateId ?? null,
      ranked,
    };

    return {
      policyDecision,
      fragment,
      messages: [{
        role: "assistant",
        content: `Mulligan: strategy=${mulliganResult.openingStrategy}, keep=${mulliganResult.keepCards.length}, discard=${mulliganResult.discardCards.length}, viable=${mulliganResult.planViable}`,
      }],
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Node: decide
  // ───────────────────────────────────────────────────────────────────────

  async function decide(state: BattleStateType): Promise<Partial<BattleStateType>> {
    if (state.criticVerdict === "error" || state.criticVerdict === "end_turn") {
      return {};
    }
    if (!state.fragment) {
      return { criticVerdict: "error" };
    }

    const resolveResult = await mcpTools.executeTool("submit_decision_fragment_v1", {
      session_id: state.sessionId,
      digest_ref: state.fragment.digest_ref,
      intent: state.fragment.intent,
      must_do: state.fragment.must_do,
      avoid: state.fragment.avoid,
      preference_order: state.fragment.preference_order,
      resource_policy: state.fragment.resource_policy,
      target_policy: state.fragment.target_policy,
      fallback_rule: state.fragment.fallback_rule,
      explanation: state.fragment.explanation,
    });

    const resolveText = resolveResult.content?.[0]?.text ?? "{}";
    const parsed = parseToolJson(resolveText);
    if (!parsed) {
      return {
        criticVerdict: "error",
        messages: [{ role: "system", content: `Resolve failed: ${resolveText.slice(0, 200)}` }],
      };
    }

    const feedback = parsed.feedback as ExecutionFeedbackV1 | undefined;
    const ranked: ResolverScoredCandidate[] = (state.policyDecision?.ranked ?? []).map((r) => ({
      candidateId: r.candidateId,
      actionCase: r.actionCase,
      score: {
        strategyMatch: 0,
        localGain: r.heuristicScore,
        futurePotential: r.learnedScore ?? 0,
        riskPenalty: 0,
        resourcePenalty: 0,
        total: r.finalScore,
      },
      conservativeScore: r.finalScore,
      endTurnLike: r.actionCase === "declareEnd",
    }));

    let selectedId = feedback?.selected_candidate_id
      ?? state.policyDecision?.selectedCandidateId
      ?? null;

    return {
      rankedCandidates: ranked,
      selectedCandidateId: selectedId,
      feedback: feedback ?? null,
      messages: [{
        role: "system",
        content: `Resolved: selected=${selectedId ?? "none"}, ok=${feedback?.execution_ok ?? false}, ranked=${ranked.length}`,
      }],
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Node: execute
  // ───────────────────────────────────────────────────────────────────────

  async function execute(state: BattleStateType): Promise<Partial<BattleStateType>> {
    if (state.criticVerdict === "error" || state.criticVerdict === "end_turn") {
      return {};
    }
    if (state.feedback) {
      return {
        feedback: state.feedback,
        messages: [{
          role: "system",
          content: `Feedback cached: ok=${state.feedback.execution_ok}, tool=${state.feedback.executed_tool}`,
        }],
      };
    }

    const execResult = await mcpTools.executeTool("get_execution_feedback_v1", {
      session_id: state.sessionId,
    });

    const execText = execResult.content?.[0]?.text ?? "{}";
    const payload = parseToolJson(execText);
    let feedback = payload?.feedback as ExecutionFeedbackV1 | undefined;

    if (!payload || !payload.ok || !feedback) {
      feedback = {
        version: "ExecutionFeedbackV1",
        session_id: state.sessionId,
        digest_ref: state.digest?.digest_ref ?? "",
        fragment_ref: state.fragment?.fragment_ref ?? "",
        selected_candidate_id: state.selectedCandidateId ?? null,
        executed_tool: null,
        execution_ok: false,
        resolver_reason: "parse_error",
        score_breakdown: {},
        fallback_used: false,
        notes: [`Failed to parse execution response: ${execText.slice(0, 100)}`],
        created_at: new Date().toISOString(),
      } as ExecutionFeedbackV1;
    }

    return {
      feedback,
      messages: [{
        role: "system",
        content: `Executed: ok=${feedback.execution_ok}, tool=${feedback.executed_tool}`,
      }],
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Node: critic
  // ───────────────────────────────────────────────────────────────────────

  async function critic(state: BattleStateType): Promise<Partial<BattleStateType>> {
    if (state.criticVerdict === "error" || state.criticVerdict === "end_turn") {
      return { criticVerdict: state.criticVerdict };
    }
    // Safety: max loop limit
    if (state.loopCount >= state.maxLoops) {
      return {
        criticVerdict: "end_turn",
        messages: [{ role: "system", content: "Max loop count reached, ending turn." }],
      };
    }

    // If execution failed, end
    if (state.feedback && !state.feedback.execution_ok) {
      return {
        criticVerdict: "error",
        messages: [{ role: "system", content: `Execution failed: ${state.feedback.resolver_reason}` }],
      };
    }

    // ── V2: Check replan triggers ──
    if (state.digest && state.planStateMachine) {
      const planInput = buildPlanUpdateInput(state.digest);
      const replan = state.planStateMachine.checkReplanTriggers(planInput);
      if (replan) {
        state.planStateMachine.markDeviated();
        // Force continue so the next loop picks up the new phase
        return {
          criticVerdict: "continue",
          planStateMachine: state.planStateMachine,
          messages: [{
            role: "system",
            content: `Replan triggered: ${replan.triggerId} — ${replan.immediateActionHint}. Entering ${replan.phaseOverride ?? "emergency"} phase.`,
          }],
        };
      }
    }

    // Check if game has pending RPC (more actions needed)
    try {
      const status = await mcpClient.getStatus();
      if (status.hasPendingRpc) {
        return { criticVerdict: "continue" };
      }
      return { criticVerdict: "end_turn" };
    } catch {
      return { criticVerdict: "end_turn" };
    }
  }

  // ── Conditional edge: critic → plan or END ──
  function shouldContinue(state: BattleStateType): "plan" | typeof END {
    if (state.criticVerdict === "continue") return "plan";
    return END;
  }

  // ── Build the graph ──
  const graph = new StateGraph(BattleState)
    .addNode("plan", plan)
    .addNode("reason", reason)
    .addNode("decide", decide)
    .addNode("execute", execute)
    .addNode("critic", critic)
    .addEdge("__start__", "plan")
    .addEdge("plan", "reason")
    .addEdge("reason", "decide")
    .addEdge("decide", "execute")
    .addEdge("execute", "critic")
    .addConditionalEdges("critic", shouldContinue);

  return graph.compile();
}

export type BattleGraphCompiled = ReturnType<typeof buildBattleGraph>;
