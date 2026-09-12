// Copyright (C) 2024-2025 Guyutongxue
//
// GiMlMctsPolicy — wraps GiMlPolicy's full ranker scoring as MCTS prior
// with heuristic state-value evaluation at leaf nodes.
//
// On each action-phase decision:
//   1. Calls parent GiMlPolicy.choose() to get full ranker scores
//   2. Uses ranked[i].finalScore as log-prior for PUCT search
//   3. Evaluates leaf states with heuristicValueFn (HP advantage)
//   4. Returns MCTS-chosen candidate, falling back to parent if search fails.

import type { GameState } from "@gi-tcg/core";
import { GiMlPolicy, type GiMlPolicyOptions } from "./gi-ml-policy.js";
import type { PolicyDecision, PolicyDecisionContext, PolicyTurnDigest, PolicyCandidateAction } from "./types.js";
import {
  MctsEngine,
  heuristicValueFn,
  createGbdtValueFn,
  type MctsConfig,
  type ValueFn,
} from "../../mcts/index.js";
import type { AnyValueArtifact } from "@gi-tcg/ml/value";
import type {
  ActionPhaseSnapshot,
  EngineActionInfo,
} from "../../mcts/state-snapshot.js";
import {
  computeDeclareEndPenalty,
  type DeclareEndPenaltyResult,
} from "./declare-end-constraints.js";
import type {
  MctsAction,
} from "../../mcts/state-snapshot.js";
import { buildMctsAction, simulateAction } from "../../mcts/state-snapshot.js";
import { diceVectorFromArray, diceCanAfford, diceTotal } from "../../mcts/dice-vector.js";

export interface GiMlMctsPolicyOptions extends GiMlPolicyOptions {
  /** MCTS search iterations per decision (default: 100). */
  mctsIterations?: number;
  /** Maximum search depth (default: 3). */
  mctsMaxDepth?: number;
  /** Temperature for action selection (0 = greedy, default: 0.5). */
  mctsTemperature?: number;
  /** Exploration constant (UCB; default: 1.4). */
  mctsExploration?: number;
  /** If true, fall back to parent policy when MCTS fails. */
  fallbackToGreedy?: boolean;
  /** Temperature applied to ranker log-priors (higher = more uniform).
   *  0 = uniform prior (no GBDT influence). 1.0 = raw scores. Default: 3.0 */
  priorTemperature?: number;
  /** If true, use the GBDT value model to score each candidate action
   *  (via one-step simulation) as the MCTS prior, instead of the ranker.
   *  Gives the search a value-aligned warm start without ranker bias. */
  useValueModelPrior?: boolean;
  /** CGT reversibility pruning: deprioritize fast-switch actions */
  mctsReversibilityPruning?: boolean;
  /** P2: Skip MCTS when position is Number-like (cold).
   *  Cold = opponent can't meaningfully change board state in one action. */
  skipMctsWhenCold?: boolean;
  /** P1: Adaptive MCTS depth based on dice count (CGT cooling tax).
   *  More dice → shallow, fewer dice → deep. */
  diceAdaptiveDepth?: boolean;
  /** P3: Temperature-weighted PUCT — hot nodes get exploration bonus. */
  temperatureWeightedSearch?: boolean;
}

// ── Conversion: PolicyCandidateAction → EngineActionInfo ──

import { CARD_EFFECT_HINTS } from "./card-effect-hints.generated.js";

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
    if (!diceCanAfford(snap.dice, costMap)) return null;
    const skillType = (ca as any).skill_type as "normal" | "elemental" | "burst" | undefined;
    return {
      type: "useSkill",
      cost: costMap,
      estimatedDamage: ((ca as any).estimated_damage as number) ?? 2,
      applyElement: elem,
      skillType: skillType ?? (ac === "elementalSkill" ? "elemental" : null),
      energyCost: skillType === "burst" ? (activeChar.maxEnergy ?? 3) : undefined,
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
    // This prevents the self-play data from converging to the passive
    // "end early" equilibrium and forces exploration of offensive actions.
    if (snap.roundNumber <= 2) return null;
    return { type: "declareEnd", cost: new Map() };
  }

  if (ac === "playCard") {
    const cardDefId = (ca as any).card_definition_id as number | undefined;
    return {
      type: "playCard",
      cost: new Map(),
      cardDefId,
      cardEffectHint: cardDefId ? (CARD_EFFECT_HINTS[cardDefId] ?? null) : null,
    };
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

// ── GiMlMctsPolicy ──

/**
 * P2: Number-like (冷局面) classifier from CGT Number Avoidance Theorem.
 * Returns true when the position is "cold" — opponent cannot meaningfully
 * change the board state in one action. In such positions, heuristic
 * evaluation is sufficient and MCTS search can be skipped.
 *
 * Cold criteria (all must hold):
 *   1. Opponent cannot kill our active character
 *   2. Opponent cannot force a dangerous reaction chain
 *   3. Opponent burst is not an immediate threat
 */
function isNumberLike(selfSnap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot): boolean {
  const selfActive = selfSnap.chars[selfSnap.activeIdx];
  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  if (!selfActive?.alive || !oppActive?.alive) return true;

  const oppDice = diceTotal(oppSnap.dice);
  const oppBurstReady =
    oppActive.maxEnergy > 0 && oppActive.energy >= oppActive.maxEnergy;

  // ── Compute opponent max potential damage ──
  let maxDamage = 0;

  // Burst: ~5-7 base damage (highest threat)
  if (oppBurstReady && oppDice >= (oppActive.maxEnergy || 3)) {
    maxDamage = 5;
  }
  // Elemental skill: ~3 base damage
  if (oppDice >= 3) {
    maxDamage = Math.max(maxDamage, 3);
  }
  // Normal attack: ~2 base damage
  if (oppDice >= 2) {
    maxDamage = Math.max(maxDamage, 2);
  }

  // Reaction bonus: melt/vaporize = +2 damage
  const selfAura = selfActive.aura as number | undefined;
  const oppAura = oppActive.aura as number | undefined;
  if (selfAura && selfAura > 0 && oppAura && oppAura > 0) {
    // Pyro(7)+Hydro(2)=Vaporize, Pyro(7)+Cryo(1)=Melt, and reverse
    const key = `${oppAura},${selfAura}`;
    const amplifying: Record<string, boolean> = {
      "7,2": true, "2,7": true, "7,1": true, "1,7": true,
    };
    if (amplifying[key]) maxDamage += 2;
  }

  // ── Threat assessment ──
  // Kill threat: can opponent kill our active?
  if (maxDamage >= selfActive.hp) return false; // HOT

  // Danger zone: damage > 50% HP + opponent has follow-up dice
  if (maxDamage >= selfActive.hp * 0.5 && oppDice >= 5) return false; // HOT

  // Burst pressure: opponent burst is ready and has energy to use it soon
  if (oppBurstReady && oppDice >= 2) return false; // HOT — burst is imminent

  // Board wipe threat: any of our benched characters at risk?
  for (const ch of selfSnap.chars) {
    if (!ch.alive || selfSnap.chars.indexOf(ch) === selfSnap.activeIdx) continue;
    if (ch.hp <= 2) return false; // HOT — bench character near death
  }

  return true; // COLD — opponent cannot meaningfully change board state
}

export class GiMlMctsPolicy extends GiMlPolicy {
  private mctsConfig: MctsConfig;
  private fallbackToGreedy: boolean;
  private valueFn: ValueFn;  // GBDT or heuristic
  private useValueModelPrior: boolean;
  private skipMctsWhenCold: boolean;
  private diceAdaptiveDepth: boolean;
  private temperatureWeightedSearch: boolean;
  private priorTemperature: number;

  constructor(
    rankerArtifact: any,
    conceptModelArtifact: any = null,
    options: GiMlMctsPolicyOptions = {},
  ) {
    super(rankerArtifact, conceptModelArtifact, options);
    this.mctsConfig = {
      iterations: options.mctsIterations ?? 100,
      maxDepth: options.mctsMaxDepth ?? 3,
      temperature: options.mctsTemperature ?? 0.5,
      explorationConstant: options.mctsExploration ?? 1.4,
      priorWeight: 0.3,
      enableReversibilityPruning: options.mctsReversibilityPruning ?? false,
      temperatureWeightedSearch: options.temperatureWeightedSearch ?? false,
    };
    this.fallbackToGreedy = options.fallbackToGreedy ?? true;
    this.priorTemperature = options.priorTemperature ?? 3.0;
    this.useValueModelPrior = options.useValueModelPrior ?? false;
    this.skipMctsWhenCold = options.skipMctsWhenCold ?? false;
    this.diceAdaptiveDepth = options.diceAdaptiveDepth ?? false;
    this.temperatureWeightedSearch = options.temperatureWeightedSearch ?? false;

    // Use GBDT value model if available, otherwise fall back to heuristic
    const artifact = (options as any).valueArtifact as AnyValueArtifact | null | undefined;
    const gbdtFn = createGbdtValueFn((artifact ?? null) as Record<string, unknown> | null);
    this.valueFn = gbdtFn ?? heuristicValueFn;
  }

  override choose(
    digest: PolicyTurnDigest,
    context?: PolicyDecisionContext,
  ): PolicyDecision {
    // Get parent's ranked scores (only needed for ranker-based prior)
    let parentDecision = this.useValueModelPrior 
      ? ({ selectedCandidateId: null, ranked: [] } satisfies PolicyDecision)
      : super.choose(digest, context);
    let ranked = parentDecision.ranked ?? [];

    // Only activate MCTS during action phase with state access
    const state = context?.stateProvider?.() as GameState | undefined;
    if (!state || state.phase !== "action" || ranked.length <= 1) {
      return parentDecision;
    }

    const selfWho = state.currentTurn;
    const selfSnap = buildSnapshotFromGameState(state, selfWho);
    const oppSnap = buildSnapshotFromGameState(state, selfWho === 0 ? 1 : 0);

    // ── P2: Number Avoidance — skip MCTS on cold positions ──
    if (this.skipMctsWhenCold && isNumberLike(selfSnap, oppSnap)) {
      return parentDecision;
    }

    // ── P0: hard constraint — forbid declareEnd in R1-R2 ──
    // Filter at the candidate level so NO code path (MCTS, fallback, greedy)
    // can select declareEnd in early rounds.
    let effectiveCandidates = digest.candidate_actions;
    if (selfSnap.roundNumber <= 2) {
      const filteredCandidates = digest.candidate_actions.filter(
        (c) => (c as any).is_valid !== false && c.action_case !== "declareEnd",
      );
      // Also filter parentDecision.ranked so fallback can't leak declareEnd.
      const declareEndIds = new Set(
        digest.candidate_actions
          .filter((c) => c.action_case === "declareEnd")
          .map((c) => c.candidate_id),
      );
      if (parentDecision.ranked) {
        parentDecision.ranked = parentDecision.ranked.filter(
          (r) => !declareEndIds.has(r.candidateId),
        );
      }
      // If nothing left after filtering, use original (punt to engine).
      if (filteredCandidates.length === 0) {
        return parentDecision;
      }
      effectiveCandidates = filteredCandidates;
      ranked = (parentDecision.ranked ?? []).filter(
        (r) => effectiveCandidates.some((c) => c.candidate_id === r.candidateId),
      );
    }

    // Convert valid candidates to engine actions
    const validCandidates = effectiveCandidates.filter(
      (c) => (c as any).is_valid !== false,
    );
    const engineActions: EngineActionInfo[] = [];
    const engineIndices: number[] = [];

    for (const ca of validCandidates) {
      const engineAct = candidateToEngineAction(ca, selfSnap);
      if (engineAct) {
        engineActions.push(engineAct);
        engineIndices.push(effectiveCandidates.indexOf(ca));
      }
    }

    if (engineActions.length <= 1) {
      return parentDecision;
    }

    // ── declareEnd prior-penalty constraints (game-theoretic, not learned) ──
    // Compute once before prior log-scores so both ranker and value-model
    // paths use the same penalty.
    const declareEndConstraint = computeDeclareEndPenalty({
      selfSnap,
      oppSnap,
      candidates: effectiveCandidates,
      isFirstMover: selfSnap.who === 0,
      valueFn: (snap, opp) => this.valueFn(snap, opp),
    });

    // Compute prior log-scores
    const priorLogScores: number[] = [];

    if (this.useValueModelPrior) {
      // Build MCTS actions for one-step simulation
      const tempActions: MctsAction[] = [];
      for (const ea of engineActions) {
        const mctsA = buildMctsAction(selfSnap, ea);
        if (mctsA) tempActions.push(mctsA);
        else tempActions.push(null as unknown as MctsAction);
      }

      const priorTemp = 0.5; // temperature for prior softmax
      for (let i = 0; i < engineActions.length; i++) {
        const action = tempActions[i];
        if (!action) {
          priorLogScores.push(-1e9); // impossible action
          continue;
        }
        try {
          const simResult = simulateAction(selfSnap, oppSnap, action);
          const value = this.valueFn(simResult.newSnapshot, oppSnap);
          const clamped = Math.max(value, -1.0);
          const temperedValue = Math.pow(Math.max(clamped + 1, 0.01), 1.0 / priorTemp);
          let logit = Math.log(temperedValue);
          // Apply declareEnd penalty
          const ca = validCandidates[i];
          if (ca?.action_case === "declareEnd") {
            logit -= declareEndConstraint.penalty;
          }
          priorLogScores.push(logit);
        } catch {
          priorLogScores.push(0);
        }
      }
    } else {
      // Ranker-based prior (default)
      const scoreByCandId = new Map<string, number>();
      for (const r of ranked) {
        scoreByCandId.set(r.candidateId, r.heuristicScore);
      }

      for (let i = 0; i < engineActions.length; i++) {
        const ca = validCandidates[i];
        if (!ca) {
          priorLogScores.push(0);
          continue;
        }
        const score = scoreByCandId.get(ca.candidate_id ?? "") ?? 5.0;
        const t = this.priorTemperature > 0.001 ? this.priorTemperature : 1;
        if (this.priorTemperature < 0.001) {
          priorLogScores.push(0); // uniform prior
        } else {
          const temperedScore = Math.pow(Math.max(score, 0.01), 1.0 / t);
          let logit = Math.log(temperedScore);
          // Apply declareEnd penalty (game-theoretic constraint)
          if (ca.action_case === "declareEnd") {
            logit -= declareEndConstraint.penalty;
          }
          priorLogScores.push(logit);
        }
      }
    }

    // Action generator: rebuild actions for each tree node
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

    // Prior: log-scores (from ranker or value model depending on config)
    const policyPrior = (
      _snap: ActionPhaseSnapshot,
      _oppSnap: ActionPhaseSnapshot,
      actions: MctsAction[],
    ): number[] => {
      return priorLogScores.slice(0, actions.length);
    };

    // ── P1: Dice→Depth inverse (CGT cooling tax) ──
    // More dice = low temperature, shallow search suffices.
    // Fewer dice = high temperature, each choice is critical.
    let savedMaxDepth: number | null = null;
    if (this.diceAdaptiveDepth) {
      const totalDice = diceTotal(selfSnap.dice);
      const adaptiveDepth = Math.max(2, Math.min(8, Math.round(14 - totalDice * 1.5)));
      savedMaxDepth = this.mctsConfig.maxDepth;
      this.mctsConfig.maxDepth = adaptiveDepth;
    }

    const engine = new MctsEngine(
      policyPrior,
      this.valueFn,
      generate,
      this.mctsConfig,
    );

    let result;
    try {
      result = engine.searchFromSnapshots(selfSnap, oppSnap);
    } catch (e: any) {
      return this.fallbackToGreedy ? parentDecision : super.choose(digest, context);
    } finally {
      if (savedMaxDepth != null) this.mctsConfig.maxDepth = savedMaxDepth;
    }

    if (!result.action || result.engineIndex == null) {
      return this.fallbackToGreedy ? parentDecision : super.choose(digest, context);
    }

    const chosenCandidate = effectiveCandidates[result.engineIndex];
    if (!chosenCandidate) {
      return this.fallbackToGreedy ? parentDecision : super.choose(digest, context);
    }

    return {
      selectedCandidateId: chosenCandidate.candidate_id ?? null,
      ranked: [
        {
          candidateId: chosenCandidate.candidate_id ?? "",
          actionCase: chosenCandidate.action_case ?? "",
          heuristicScore: 0,
          finalScore: 1000,
          reasons: [`mcts:${result.action.type}`, `ranker_prior`],
          candidate: chosenCandidate,
        },
      ],
      guidanceNotes: [`mcts:${result.action.type}`],
    };
  }
}
