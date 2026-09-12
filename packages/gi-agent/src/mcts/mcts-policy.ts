// Copyright (C) 2024-2025 Guyutongxue
//
// MCTS policy adapter — bridges engine state with MctsEngine.
// Replaces greedy 1-step scoring with tree search.

import type { GameState } from "@gi-tcg/core"
import type {
  ActionPhaseSnapshot,
  MctsAction,
  EngineActionInfo,
} from "./state-snapshot.js"
import {
  takeActionPhaseSnapshot,
  buildMctsAction,
} from "./state-snapshot.js"
import { diceCanAfford } from "./dice-vector.js"
import {
  MctsEngine,
  type PolicyPriorFn,
  type ValueFn,
} from "./mcts.js"

// ── Integration types ──

export interface MctsPolicyConfig {
  iterations: number
  explorationConstant: number
  maxDepth: number
  temperature: number
  priorWeight: number
  /** If true, fall back to greedy ranking when MCTS returns no action. */
  fallbackToGreedy: boolean
}

const DEFAULT_MCTS_POLICY_CONFIG: MctsPolicyConfig = {
  iterations: 200,
  explorationConstant: 1.4,
  maxDepth: 6,
  temperature: 0.5,
  priorWeight: 0.3,
  fallbackToGreedy: true,
}

// ── Policy prior factory ──
// Uses a scoring function (e.g., SlotLinearRanker) to compute priors

export function createPolicyPrior(
  scoreFn: (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot, action: MctsAction) => number,
): PolicyPriorFn {
  return (snap, oppSnap, actions) => {
    const scores = actions.map((a) => scoreFn(snap, oppSnap, a))
    // Softmax → log-probabilities
    const maxScore = Math.max(...scores, -1e9)
    const exps = scores.map((s) => Math.exp(Math.min(s - maxScore, 20)))
    const total = exps.reduce((a, b) => a + b, 0) || 1
    return exps.map((e) => Math.log(Math.max(e / total, 1e-10)))
  }
}

// ── Value function factory ──
// Uses a GBDT-value-like function

export function createValueFn(
  evalFn: (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => number,
): ValueFn {
  return evalFn
}

// ── Action generator from engine actions ──

export function createActionGenerator(
  getEngineActions: (
    snap: ActionPhaseSnapshot,
    oppSnap: ActionPhaseSnapshot,
  ) => EngineActionInfo[],
) {
  return (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => {
    const engineActions = getEngineActions(snap, oppSnap)
    const mctsActions: MctsAction[] = []
    const engineIndices: number[] = []

    for (let i = 0; i < engineActions.length; i++) {
      const mctsAction = buildMctsAction(snap, engineActions[i])
      if (mctsAction) {
        mctsActions.push(mctsAction)
        engineIndices.push(i)
      }
    }

    return { actions: mctsActions, engineIndices }
  }
}

// ── Simple heuristic value function (fallback when no GBDT) ──

import { getProfile as _rawGetProfile } from "../knowledge/temporal-profiles/profile-registry.js";

/** Safe wrapper — returns null if profile loading fails (e.g. in worker threads) */
function getProfileSafe(defId: number): any {
  try {
    return _rawGetProfile(defId);
  } catch {
    return null;
  }
}

/** Estimate remaining rounds from current HP totals */
function estimateRoundsRemaining(
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
): number {
  const selfTotal = snap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const oppTotal = oppSnap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const avgDpr = 3.5; // average damage per round from empirical benchmark data (7.64 rounds, ~30 HP per side)
  const minHp = Math.max(selfTotal, oppTotal);
  return Math.max(1, Math.ceil(minHp / avgDpr));
}

export function heuristicValueFn(
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
): number {
  // ── P0: kill threshold — opponent active dead = won the exchange ──
  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  if (!oppActive || !oppActive.alive) {
    // Active opponent dead → massive advantage (opponent must switch)
    return 0.85;
  }

  const oppAliveCount = oppSnap.chars.filter((c) => c.alive).length;
  if (oppAliveCount === 0) {
    return 1.0; // game over — we won
  }

  const selfAliveCount = snap.chars.filter((c) => c.alive).length;
  if (selfAliveCount === 0) {
    return -1.0; // game over — we lost
  }

  // ── Base: HP advantage (smooth) ──
  const selfHp = snap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const selfMaxHp = snap.chars.reduce((s, c) => s + c.maxHp, 0);
  const oppHp = oppSnap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const oppMaxHp = oppSnap.chars.reduce((s, c) => s + c.maxHp, 0);

  const hpAdvantage = (selfHp / Math.max(selfMaxHp, 1)) - (oppHp / Math.max(oppMaxHp, 1));
  const aliveAdvantage = selfAliveCount - oppAliveCount;

  let value = hpAdvantage * 0.55 + aliveAdvantage * 0.25;

  // ── P0 (sharp): active HP near-zero bonus ──
  // Opponent active at ≤ 3 HP → we should prioritize killing them
  if (oppActive.hp <= 3 && oppActive.alive) {
    // The closer to 0, the bigger the missed-opportunity penalty
    value -= 0.03 * (4 - oppActive.hp);
  }

  // ── P1 & P2: board support evaluation with profile data ──
  const rnd = snap.roundNumber;
  const roundsLeft = estimateRoundsRemaining(snap, oppSnap);

  let supportValue = 0;
  let handDeadCardPenalty = 0;

  // P2: evaluate already-deployed supports
  for (const support of snap.supports) {
    const profile = getProfileSafe(support.definitionId);
    if (!profile) continue;

    const usage = support.usage ?? 0;
    const usagePerRound = (support as any).usagePerRound ?? 0;
    const isActive = usage > 0 || usagePerRound > 0;

    if (isActive) {
      const payoff = profile.payoff as Record<string, number> | undefined;
      const effectiveRounds = Math.min(roundsLeft, 3);
      if (payoff) {
        if (payoff.draw) supportValue += 0.12 * effectiveRounds;
        if (payoff.generate_dice_omni) supportValue += 0.18 * effectiveRounds;
        if (payoff.generate_dice_random || payoff.generate_dice_elemental) supportValue += 0.08 * effectiveRounds;
        if (payoff.damage) supportValue += 0.20 * effectiveRounds;
        if (payoff.heal) supportValue += 0.08 * effectiveRounds;
        if (payoff.cost_reduction) supportValue += 0.10 * effectiveRounds;
      }
    }

    // P1: was this deployed too late?
    const ideal = profile.lifecycle?.ideal_deploy_round as { min: number; max: number } | undefined;
    if (ideal && rnd > ideal.max) {
      const lateness = rnd - ideal.max;
      supportValue -= lateness * 0.04; // diminishing returns for late support
    }
  }

  // P1: hand card timeliness — cards past their ideal window are dead draws
  for (const defId of snap.handDefIds) {
    const profile = getProfileSafe(defId);
    if (!profile?.lifecycle) continue;
    const ideal = profile.lifecycle.ideal_deploy_round as { min: number; max: number };
    if (rnd > ideal.max + 1) {
      handDeadCardPenalty += Math.min((rnd - ideal.max) * 0.06, 0.3);
    }
  }

  value += supportValue * 0.15;
  value -= handDeadCardPenalty * 0.1;

  // ── ④ Opponent archetype bias ──
  // Aggressive decks (红牛/HongNiu, 雷狼/LeiLang) should value HP advantage more.
  // Control decks (水凝/ShuiNing) should value alive advantage more.
  const isAggressive = oppSnap.chars.some(
    (c) => c.definitionId === 1605 || c.definitionId === 1309, // 一斗, 迪希雅
  );
  const isControl = oppSnap.chars.some(
    (c) => c.definitionId === 1205 || c.definitionId === 1201, // 心海, 芭芭拉
  );
  if (isAggressive) {
    // Against aggressive decks: HP advantage matters less (they'll output damage anyway),
    // but alive advantage matters more (killing one of their chars is meaningful)
    value = hpAdvantage * 0.40 + aliveAdvantage * 0.40;
    // Re-apply sharp kill penalty since we reset value above
    if (oppActive.hp <= 3 && oppActive.alive) {
      value -= 0.03 * (4 - oppActive.hp);
    }
    value += supportValue * 0.15;
    value -= handDeadCardPenalty * 0.1;
  } else if (isControl) {
    // Against control decks: HP advantage matters more (they'll heal back chip damage),
    // alive advantage matters less (they don't threaten kills as much)
    value = hpAdvantage * 0.60 + aliveAdvantage * 0.15;
    value += supportValue * 0.15;
    value -= handDeadCardPenalty * 0.1;
  }

  // ── ⑦ Symmetry breaking: first-mover advantage ──
  // P0 (who=0) has a natural +0.03 advantage from going first in mirror matchups
  if (snap.who === 0) {
    value += 0.03;
  }

  // Clamp to [-1, 1]
  return Math.max(-1, Math.min(1, value));
}

// ── Ranker-based scoring for policy prior ──

export function createRankerScoreFn(
  rankerConfig: {
    candidate_numeric_slot_weights: Record<string, number>
    candidate_tag_bias?: Record<string, number>
  },
): (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot, action: MctsAction) => number {
  return (snap, _oppSnap, action) => {
    let score = 0

    // Tag biases
    const tagBias = rankerConfig.candidate_tag_bias ?? {}
    score += tagBias[action.type] ?? 0
    if (action.fast) score += tagBias["fast_action"] ?? 0

    // Numeric slot weights
    const w = rankerConfig.candidate_numeric_slot_weights

    // temporal_dice_cost
    const diceCost = [...(action.cost.values())].reduce((s, c) => s + c, 0)
    score += (w["temporal_dice_cost"] ?? 0) * diceCost

    // temporal_dice_budget_ratio
    const totalDice = snap.dice.reduce((s, c) => s + c, 0)
    if (totalDice > 0) {
      score += (w["temporal_dice_budget_ratio"] ?? 0) * (diceCost / totalDice)
    }

    // Action case bias
    score += (w["is_fast_action"] ?? 0) * (action.fast ? 1 : 0)

    // estimated damage as a positive signal
    score += (action.estimatedDamage ?? 0) * 0.05

    return score
  }
}
