// Copyright (C) 2024-2025 Guyutongxue
//
// MctsPolicy — wraps BaselinePolicy with MCTS lookahead search.
// On each action-phase decision, runs PUCT search (with the parent policy's
// ranking as prior) to find better multi-step lines.

import type { GameState } from "@gi-tcg/core";
import { BaselinePolicy, type BaselinePolicyOptions } from "./baseline-policy.js";
import type { PolicyDecision, PolicyDecisionContext, PolicyTurnDigest, PolicyCandidateAction } from "./types.js";
import {
  MctsEngine,
  heuristicValueFn,
  createPolicyPrior,
  type MctsConfig,
} from "../../mcts/index.js";
import type {
  ActionPhaseSnapshot,
  EngineActionInfo,
  MctsAction,
} from "../../mcts/state-snapshot.js";
import { buildMctsAction } from "../../mcts/state-snapshot.js";
import { diceVectorFromArray, diceCanAfford } from "../../mcts/dice-vector.js";

export interface MctsPolicyOptions extends BaselinePolicyOptions {
  /** MCTS search iterations per decision (default: 100). */
  mctsIterations?: number;
  /** Maximum search depth (default: 3). */
  mctsMaxDepth?: number;
  /** Temperature for action selection (0 = greedy). */
  mctsTemperature?: number;
  /** Exploration constant (UCB; default: 1.4). */
  mctsExploration?: number;
  /** If true, fall back to parent policy when MCTS has too few actions. */
  fallbackToGreedy?: boolean;
}

// ── Conversion: PolicyCandidateAction → EngineActionInfo ──

function candidateToEngineAction(
  ca: PolicyCandidateAction,
  snap: ActionPhaseSnapshot,
): EngineActionInfo | null {
  const activeChar = snap.chars[snap.activeIdx];
  if (!activeChar || !activeChar.alive) return null;

  const ac = ca.action_case;

  if (ac === "useSkill" || ac === "elementalSkill") {
    const cost = (ca as any).cost_charged_dice ?? (ca as any).cost_dice ?? 3;
    const elem = activeChar.aura || 0;
    const costMap = new Map<number, number>();
    if (elem > 0 && elem <= 8) costMap.set(elem, Math.max(cost, 1));
    if (cost > 0 && !diceCanAfford(snap.dice, costMap)) return null;
    return {
      type: "useSkill",
      cost: costMap,
      estimatedDamage: ((ca as any).estimated_damage as number) ?? 2,
      applyElement: elem,
    };
  }

  if (ac === "switchActive" || ac === "fastSwitch") {
    return {
      type: "switchActive",
      cost: new Map([[0, 1]]),
      switchTargetIdx: (ca.target_slot != null ? ca.target_slot : 1) as number,
      fast: ac === "fastSwitch",
    };
  }

  if (ac === "declareEnd") {
    // P0: MCTS search-level hard constraint — forbid declareEnd in R1-R2.
    if (snap.roundNumber <= 2) return null;
    return { type: "declareEnd", cost: new Map() };
  }

  if (ac === "playCard") {
    return { type: "playCard", cost: new Map() };
  }

  return null;
}

// ── Snapshot builder ──

function buildSnapshotFromGameState(state: GameState, who: 0 | 1): ActionPhaseSnapshot {
  const player = state.players[who];
  const diceArr: number[] = [];
  for (const d of player.dice) {
    if (d >= 1 && d <= 8) diceArr.push(d);
  }

  return {
    who,
    chars: player.characters.map((ch) => ({
      id: ch.id,
      definitionId: ch.definition.id,
      hp: ch.variables.health,
      maxHp: ch.variables.maxHealth,
      energy: ch.variables.energy,
      maxEnergy: ch.variables.maxEnergy,
      alive: ch.variables.alive === 1,
      aura: (ch.variables as any).aura ?? 0,
      equipDefIds: (ch.entities ?? []).map((e: any) => e.definition.id),
    })),
    activeIdx: player.characters.findIndex((ch) => ch.id === player.activeCharacterId),
    dice: diceVectorFromArray(diceArr),
    handDefIds: player.hands.map((h: any) => h.definition.id),
    supports: player.supports.map((s: any) => ({
      id: s.id,
      definitionId: s.definition.id,
      usage: s.variables.usage ?? 0,
      maxUsage: s.variables.maxUsage ?? s.variables.maxCount ?? 3,
      usagePerRound: s.variables.usagePerRound ?? 0,
    })),
    summons: player.summons.map((s: any) => ({
      id: s.id,
      definitionId: s.definition.id,
      usage: s.variables.usage ?? 0,
      maxUsage: s.variables.maxUsage ?? s.variables.maxCount ?? 3,
      usagePerRound: 0,
    })),
    combatStatuses: player.combatStatuses.map((s: any) => ({
      id: s.id,
      definitionId: s.definition.id,
      usage: s.variables.usage ?? 0,
      maxUsage: s.variables.maxUsage ?? s.variables.maxCount ?? 3,
      usagePerRound: 0,
    })),
    declaredEnd: player.declaredEnd,
    roundNumber: state.roundNumber,
  };
}

// ── MctsPolicy ──

export class MctsPolicy extends BaselinePolicy {
  private mctsConfig: MctsConfig;
  private fallbackToGreedy: boolean;

  constructor(options: MctsPolicyOptions = {}) {
    super(options);
    this.mctsConfig = {
      iterations: options.mctsIterations ?? 100,
      maxDepth: options.mctsMaxDepth ?? 3,
      temperature: options.mctsTemperature ?? 0.5,
      explorationConstant: options.mctsExploration ?? 1.4,
      priorWeight: 0.3,
    };
    this.fallbackToGreedy = options.fallbackToGreedy ?? true;
  }

  override choose(
    digest: PolicyTurnDigest,
    context?: PolicyDecisionContext,
  ): PolicyDecision {
    const state = context?.stateProvider?.() as GameState | undefined;
    if (!state || state.phase !== "action") {
      return super.choose(digest, context);
    }

    // Get the parent policy ranking as MCTS prior
    let greedyDecision = super.choose(digest, context);
    let ranked = greedyDecision.ranked ?? [];

    // Build score lookup
    const scoreByCandId = new Map<string, number>();
    for (const r of ranked) {
      scoreByCandId.set(r.candidateId, r.finalScore);
    }

    const selfWho = state.currentTurn;
    const selfSnap = buildSnapshotFromGameState(state, selfWho);
    const oppSnap = buildSnapshotFromGameState(state, selfWho === 0 ? 1 : 0);

    // ── P0: hard constraint — forbid declareEnd in R1-R2 ──
    // Use digest.round (from notification state, 1-indexed, reliable) rather than
    // selfSnap.roundNumber (from stateProvider, may be stale if onPause fires late).
    let effectiveCandidates = digest.candidate_actions;
    if (digest.round <= 2) {
      const filteredCandidates = digest.candidate_actions.filter(
        (c) => (c as any).is_valid !== false && c.action_case !== "declareEnd",
      );
      // Filter greedyDecision.ranked so fallback can't leak declareEnd.
      // ALSO reset selectedCandidateId — filtering ranked but not selectedCandidateId
      // leaves a stale declareEnd reference that bypasses both policy and IO filters.
      const declareEndIds = new Set(
        digest.candidate_actions
          .filter((c) => c.action_case === "declareEnd")
          .map((c) => c.candidate_id),
      );
      const filteredRanked = ranked.filter((r) => !declareEndIds.has(r.candidateId));
      greedyDecision = {
        ...greedyDecision,
        ranked: filteredRanked,
        selectedCandidateId: filteredRanked[0]?.candidateId ?? null,
      };
      if (filteredCandidates.length === 0) {
        return greedyDecision;
      }
      effectiveCandidates = filteredCandidates;
      ranked = filteredRanked;
    }

    // Convert candidates, carrying ranker scores
    const validCandidates = effectiveCandidates.filter(
      (c) => (c as any).is_valid !== false,
    );
    const engineActions: EngineActionInfo[] = [];
    const engineIndices: number[] = [];
    const rankerLogScores: number[] = [];

    for (const ca of validCandidates) {
      const engineAct = candidateToEngineAction(ca, selfSnap);
      if (engineAct) {
        engineActions.push(engineAct);
        engineIndices.push(effectiveCandidates.indexOf(ca));
        const score = scoreByCandId.get(ca.candidate_id ?? "") ?? 5.0;
        rankerLogScores.push(Math.log(Math.max(score, 0.01)));
      }
    }

    if (engineActions.length <= 1) {
      return this.fallbackToGreedy ? greedyDecision : super.choose(digest, context);
    }

    // Action generator
    const generate = (
      snap: ActionPhaseSnapshot,
      _oppSnap: ActionPhaseSnapshot,
    ) => {
      const mctsActions: MctsAction[] = [];
      const mctsEngineIndices: number[] = [];
      for (let i = 0; i < engineActions.length; i++) {
        const mctsA = buildMctsAction(snap, engineActions[i]);
        if (mctsA) {
          mctsActions.push(mctsA);
          mctsEngineIndices.push(engineIndices[i]);
        }
      }
      return { actions: mctsActions, engineIndices: mctsEngineIndices };
    };

    // Prior from ranker scores
    const policyPrior = (
      _snap: ActionPhaseSnapshot,
      _oppSnap: ActionPhaseSnapshot,
      actions: MctsAction[],
    ): number[] => {
      // Map back to ranker scores (actions are built from engineActions in order)
      return rankerLogScores.slice(0, actions.length);
    };

    const engine = new MctsEngine(
      policyPrior,
      heuristicValueFn,
      generate,
      this.mctsConfig,
    );

    let result;
    try {
      result = engine.searchFromSnapshots(selfSnap, oppSnap);
    } catch (e: any) {
      if (this.fallbackToGreedy) return greedyDecision;
      return super.choose(digest, context);
    }

    if (!result.action || result.engineIndex == null) {
      return this.fallbackToGreedy ? greedyDecision : super.choose(digest, context);
    }

    const chosenCandidate = digest.candidate_actions[result.engineIndex];
    if (!chosenCandidate) {
      return this.fallbackToGreedy ? greedyDecision : super.choose(digest, context);
    }

    return {
      selectedCandidateId: chosenCandidate.candidate_id ?? null,
      ranked: [
        {
          candidateId: chosenCandidate.candidate_id ?? "",
          actionCase: chosenCandidate.action_case ?? "",
          heuristicScore: 0,
          finalScore: 1000,
          reasons: [`mcts:${result.action.type}`],
          candidate: chosenCandidate,
        },
      ],
      guidanceNotes: [`mcts:${result.action.type}`],
    };
  }
}
