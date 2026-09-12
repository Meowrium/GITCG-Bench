// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DiceType } from "@gi-tcg/typings"
import type { ObservationV1 } from "@gi-tcg/ml/contracts";
import type {
  PolicyCandidateAction,
  PolicyDecisionContext,
  PolicyDecision,
  PolicyTurnDigest,
  RankedPolicyCandidate,
  RuntimeMacroPlan,
  RuntimeMacroPlanKind,
  TurnPlan,
  DiceReservation,
} from "./types.js";
import {
  computeCollapseDistance,
  computeAvgCollapseDistance,
  burstWindowUrgency,
  estimateReactionBonusFlat,
  estimateOpponentDamageCapacity,
  inferOpponentArchetype,
  detectGamePhaseFromObservation,
  generateTurnPlan,
  computeDiceReservation,
  assessCharacterValue,
  type FunctionalTier,
  type OpponentArchetype,
  type CharacterValueAssessment,
} from "./character-value-evaluator.js";
import { matchReactionChainTemplates } from "./reaction-chain-templates.js"
import type { GamePhaseKind } from "./game-plan.js"
import { matchAnyPattern } from "../plan/pattern-matcher.js"
import {
  computeThreatBonus,
  computePrimaryMatchBonus,
  computeDiceBudgetPenalty,
} from "../plan/scorer-adapter.js"
import type { PhaseWeightsOverride } from "../plan/types.js"

export interface HeuristicProfile {
  endTurnPenalty: number;
  riskWeight: number;
  reactionWeight: number;
  tempoWeight: number;
  costWeight: number;
  healingWeight: number;
  drawWeight: number;
  supportWeight: number;
  summonWeight: number;
  equipmentWeight: number;
  energyWeight: number;
  diceFixWeight: number;
  effectlessPenalty: number;
}

const DEFAULT_PROFILE: HeuristicProfile = {
  endTurnPenalty: 5,
  riskWeight: 2,
  reactionWeight: 1.2,
  tempoWeight: 0.8,
  costWeight: 0.6,
  healingWeight: 1.4,
  drawWeight: 0.9,
  supportWeight: 1.1,
  summonWeight: 1.1,
  equipmentWeight: 0.8,
  energyWeight: 1,
  diceFixWeight: 0.7,
  effectlessPenalty: 3,
};

const AGGRESSIVE_PROFILE: HeuristicProfile = {
  endTurnPenalty: 7,
  riskWeight: 1.2,
  reactionWeight: 1.5,
  tempoWeight: 1.1,
  costWeight: 0.4,
  healingWeight: 0.8,
  drawWeight: 0.7,
  supportWeight: 0.8,
  summonWeight: 0.9,
  equipmentWeight: 0.7,
  energyWeight: 0.8,
  diceFixWeight: 0.5,
  effectlessPenalty: 4,
};

const DEFENSIVE_PROFILE: HeuristicProfile = {
  endTurnPenalty: 3,
  riskWeight: 2.8,
  reactionWeight: 1.0,
  tempoWeight: 0.5,
  costWeight: 0.8,
  healingWeight: 1.8,
  drawWeight: 1.1,
  supportWeight: 1.3,
  summonWeight: 1.0,
  equipmentWeight: 1.0,
  energyWeight: 1.2,
  diceFixWeight: 0.9,
  effectlessPenalty: 2,
};

const EARLY_GAME_PROFILE: HeuristicProfile = {
  endTurnPenalty: 6,
  riskWeight: 1.5,
  reactionWeight: 1.0,
  tempoWeight: 0.6,
  costWeight: 0.5,
  healingWeight: 1.0,
  drawWeight: 1.2,
  supportWeight: 1.4,
  summonWeight: 1.4,
  equipmentWeight: 1.0,
  energyWeight: 0.9,
  diceFixWeight: 0.8,
  effectlessPenalty: 3.5,
};

const LATE_GAME_PROFILE: HeuristicProfile = {
  endTurnPenalty: 4,
  riskWeight: 2.5,
  reactionWeight: 1.4,
  tempoWeight: 1.0,
  costWeight: 0.5,
  healingWeight: 1.2,
  drawWeight: 0.6,
  supportWeight: 0.7,
  summonWeight: 0.6,
  equipmentWeight: 0.5,
  energyWeight: 1.5,
  diceFixWeight: 0.6,
  effectlessPenalty: 3,
};

function selectProfile(
  macroPlan: RuntimeMacroPlan | null,
  observation: ObservationV1 | null,
): HeuristicProfile {
  if (!macroPlan && !observation) return DEFAULT_PROFILE;
  if (macroPlan?.kind === "stabilize") return DEFENSIVE_PROFILE;
  if (macroPlan?.kind === "burst_convert") return AGGRESSIVE_PROFILE;
  if (macroPlan?.kind === "tempo_pressure") return AGGRESSIVE_PROFILE;
  if (macroPlan?.kind === "board_setup") return DEFAULT_PROFILE;        // balanced—don't suppress tempo for setup plans
  if (macroPlan?.kind === "reaction_convert") return AGGRESSIVE_PROFILE; // high reaction weight
  const round = observation?.point.round_number ?? 0;
  if (round <= 2) return EARLY_GAME_PROFILE;
  if (round >= 6) return LATE_GAME_PROFILE;
  return DEFAULT_PROFILE;
}

export function computePhaseAdjustedWeights(
  phase: GamePhaseKind,
  baseWeights: HeuristicProfile,
  round: number,
  selfAliveCount: number,
  opponentAliveCount: number,
): HeuristicProfile {
  const adjusted = { ...baseWeights }

  switch (phase) {
    case "setup":
      adjusted.equipmentWeight *= 1.4
      adjusted.supportWeight *= 1.3
      adjusted.summonWeight *= 1.3
      adjusted.drawWeight *= 1.2
      adjusted.energyWeight *= 1.1
      adjusted.tempoWeight *= 0.7
      break
    case "execution":
      adjusted.tempoWeight *= 1.5
      adjusted.reactionWeight *= 1.3
      adjusted.energyWeight *= 1.2
      adjusted.equipmentWeight *= 0.7
      adjusted.drawWeight *= 0.8
      break
    case "closing":
      adjusted.tempoWeight *= 1.8
      adjusted.reactionWeight *= 1.5
      adjusted.healingWeight *= 0.6
      adjusted.equipmentWeight *= 0.5
      adjusted.energyWeight *= 0.7
      break
    case "transition":
      break
  }

  if (selfAliveCount === 2) {
    adjusted.tempoWeight *= 1.2
    adjusted.healingWeight *= 0.8
    adjusted.supportWeight *= 0.7
  }

  return adjusted
}

export interface BaselinePolicyOptions extends Partial<HeuristicProfile> {
  /**
   * Softmax temperature for stochastic action selection during self-play.
   * 0 (default) = argmax (greedy). Values around 1.0~2.0 promote exploration.
   */
  temperature?: number;
  /**
   * Enable adaptive heuristic profile selection based on macro plan & observation.
   * When true, selectProfile() overrides individual weight options per decision.
   */
  adaptiveProfile?: boolean;
  /** Exploration strategy: "greedy" (argmax), "softmax" (temperature-based), "ucb" (Upper Confidence Bound), or "thompson" (Thompson sampling via weight posterior). */
  explorationStrategy?: "greedy" | "softmax" | "ucb" | "thompson";
  /** UCB exploration constant. Higher = more exploration. Default 0.5. */
  ucbC?: number;
}

export class BaselinePolicy {
  protected readonly options: Required<BaselinePolicyOptions>;
  protected actionVisitCounts = new Map<string, number>();
  protected totalActionCount = 0;

  constructor(options: BaselinePolicyOptions = {}) {
    const defaults: Required<BaselinePolicyOptions> = {
      ...DEFAULT_PROFILE,
      temperature: 0,
      adaptiveProfile: false,
      explorationStrategy: (options.temperature != null && options.temperature > 0) ? "softmax" : "greedy",
      ucbC: 0.5,
    };
    this.options = { ...defaults, ...options };
  }

  choose(digest: PolicyTurnDigest, context?: PolicyDecisionContext): PolicyDecision {
    const profile = this.resolveProfile(context?.macroPlanState?.plan ?? null, context?.observation ?? null);

    // Generate turn plan at round start
    let turnPlan = context?.turnPlan ?? null;
    let diceReservation = context?.diceReservation ?? null;
    if (context?.observation && context.observation.point.action_count_in_round === 0) {
      const reactionChainMatches = matchReactionChainTemplates(context.observation);
      turnPlan = generateTurnPlan(context.observation, context.macroPlanState?.plan ?? null, reactionChainMatches);
      diceReservation = computeDiceReservation(context.observation, turnPlan);
    }

    const updatedContext: PolicyDecisionContext | undefined = context
      ? { ...context, turnPlan, diceReservation }
      : undefined;

    // SPL: filter banned actions before scoring
    const banList = updatedContext?.actionBanList;
    const preFiltered = updatedContext?.splPreFiltered;

    const ranked = digest.candidate_actions
      .filter((candidate) => candidate.is_valid !== false)
      .filter((candidate) => {
        if (preFiltered) return true
        if (!banList || banList.length === 0) return true
        return !matchAnyPattern(banList, candidate)
      })
      .map((candidate) => {
        const base = this.rankCandidate(digest, candidate, profile, updatedContext)
        // UCB bonus
        if (this.options.explorationStrategy === "ucb" && this.totalActionCount > 0) {
          const bucket = candidate.action_case ?? "unknown"
          const visitCount = this.actionVisitCounts.get(bucket) ?? 0
          const ucbBonus = this.options.ucbC * Math.sqrt(
            Math.log(this.totalActionCount + 1) / (visitCount + 1),
          )
          return { ...base, finalScore: base.finalScore + ucbBonus }
        }
        return base
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const selected = this.selectAction(ranked);

    // Update UCB visit counts
    if (selected) {
      this.totalActionCount++
      const bucket = selected.actionCase ?? "unknown"
      this.actionVisitCounts.set(bucket, (this.actionVisitCounts.get(bucket) ?? 0) + 1)
    }

    return {
      selectedCandidateId: selected?.candidateId ?? null,
      ranked,
    };
  }

  protected resolveProfile(
    macroPlan: RuntimeMacroPlan | null,
    observation: ObservationV1 | null,
  ): HeuristicProfile {
    const base: HeuristicProfile = {
      endTurnPenalty: this.options.endTurnPenalty,
      riskWeight: this.options.riskWeight,
      reactionWeight: this.options.reactionWeight,
      tempoWeight: this.options.tempoWeight,
      costWeight: this.options.costWeight,
      healingWeight: this.options.healingWeight,
      drawWeight: this.options.drawWeight,
      supportWeight: this.options.supportWeight,
      summonWeight: this.options.summonWeight,
      equipmentWeight: this.options.equipmentWeight,
      energyWeight: this.options.energyWeight,
      diceFixWeight: this.options.diceFixWeight,
      effectlessPenalty: this.options.effectlessPenalty,
    };
    if (!this.options.adaptiveProfile) {
      return base;
    }
    return selectProfile(macroPlan, observation);
  }

  /**
   * Select an action based on the configured exploration strategy.
   */
  protected selectAction(ranked: RankedPolicyCandidate[]): RankedPolicyCandidate | undefined {
    if (ranked.length === 0) return undefined
    switch (this.options.explorationStrategy) {
      case "softmax":
        return this.temperatureSample(ranked)
      case "ucb":
        // UCB bonus already applied during ranking; pick argmax of augmented scores
        return ranked[0]
      case "thompson":
        // Thompson sampling: scores already randomized via weight sampling in EvaluatorPolicy
        return ranked[0]
      case "greedy":
      default:
        return ranked[0]
    }
  }

  /**
   * Sample a candidate using softmax temperature.
   * T=0 (default) → argmax. T>0 → stochastic, higher T = more uniform.
   */
  protected temperatureSample(ranked: RankedPolicyCandidate[]): RankedPolicyCandidate | undefined {
    if (ranked.length === 0) return undefined
    const T = this.options.temperature
    if (T <= 0) return ranked[0]
    // Numerically stable softmax: subtract max before exp
    const maxScore = ranked[0].finalScore  // already sorted desc
    const exps = ranked.map((r) => Math.exp((r.finalScore - maxScore) / T))
    const sum = exps.reduce((a, b) => a + b, 0)
    let r = Math.random() * sum
    for (let i = 0; i < ranked.length; i++) {
      r -= exps[i]
      if (r <= 0) return ranked[i]
    }
    return ranked[ranked.length - 1]
  }

  protected rankCandidate(
    digest: PolicyTurnDigest,
    candidate: PolicyCandidateAction,
    profile?: HeuristicProfile,
    context?: PolicyDecisionContext,
  ): RankedPolicyCandidate {
    const baseProfile = profile ?? {
      endTurnPenalty: this.options.endTurnPenalty,
      riskWeight: this.options.riskWeight,
      reactionWeight: this.options.reactionWeight,
      tempoWeight: this.options.tempoWeight,
      costWeight: this.options.costWeight,
      healingWeight: this.options.healingWeight,
      drawWeight: this.options.drawWeight,
      supportWeight: this.options.supportWeight,
      summonWeight: this.options.summonWeight,
      equipmentWeight: this.options.equipmentWeight,
      energyWeight: this.options.energyWeight,
      diceFixWeight: this.options.diceFixWeight,
      effectlessPenalty: this.options.effectlessPenalty,
    };

    // Phase-adjusted weights
    const observation = context?.observation ?? null;
    const phase = detectGamePhaseFromObservation(observation, context?.gamePlanState ? { setup_completion: context.gamePlanState.setup_completion, current_phase: context.gamePlanState.current_phase } : null);
    const selfAliveCount = observation?.self.characters.filter(c => c.alive).length ?? 3;
    const oppAliveCount = observation?.opponent.characters.filter(c => c.alive).length ?? 3;
    let p = computePhaseAdjustedWeights(phase, baseProfile, digest.round, selfAliveCount, oppAliveCount);

    // SPL: merge phase weight overrides from context
    if (context?.phaseWeightsOverride) {
      p = mergeWeightOverrides(p, context.phaseWeightsOverride)
    }

    const actionCase = String(candidate.action_case ?? "unknown");
    const candidateId = String(candidate.candidate_id ?? `candidate_${Math.random().toString(36).slice(2)}`);
    const reasons: string[] = [];

    const damage = safeNumber(candidate.damage_estimate);
    const reaction = safeNumber(candidate.reaction_value);
    const tempo = safeNumber(candidate.tempo_value);
    const risk = safeNumber(candidate.survival_risk);
    const healing = safeNumber(candidate.healing_estimate);
    const selfHeal = safeNumber(candidate.self_heal_value);
    const draw = safeNumber(candidate.draw_value);
    const diceFix = safeNumber(candidate.dice_fix_value);
    const energyGain = safeNumber(candidate.energy_gain_value);
    const createSupport = safeNumber(candidate.create_support_value);
    const createSummon = safeNumber(candidate.create_summon_value);
    const createEquipment = safeNumber(candidate.create_equipment_value);
    const forcedSwitch = safeNumber(candidate.forced_switch_value);
    const selfSwitch = safeNumber(candidate.self_switch_value);
    const effectless = Boolean(candidate.will_be_effectless);
    const totalCost = totalCostFromCandidate(candidate);
    const selfActiveHpRatio = currentSelfActiveHpRatio(digest);
    const selfAvgHpRatio = currentSelfTeamAvgHpRatio(digest);
    const selfActiveEnergyGap = currentSelfActiveEnergyGap(digest);
    const supportRoom = remainingSlots(digest.resource_summary, "support_count", "max_support_count");
    const summonRoom = remainingSlots(digest.resource_summary, "summon_count", "max_summon_count");

    // ── Collapse distance & burst window urgency ──
    const oppDmgCap = estimateOpponentDamageCapacity(observation);
    const selfActiveAura = observation?.self.characters.find((c) => c.is_active)?.aura ?? null;
    const oppReactionBonus = estimateReactionBonusFlat(observation?.opponent, selfActiveAura);
    const opponentArchetype = inferOpponentArchetype(observation);

    const activeCharSummary = getActiveCharacter(digest.self_summary);
    const activeHp = activeCharSummary?.hp ?? 10;
    const activeMaxHp = activeCharSummary?.max_hp ?? 10;
    const activeEnergy = activeCharSummary?.energy ?? 0;
    const activeMaxEnergy = activeCharSummary?.max_energy ?? 3;
    const activeDefId = activeCharSummary?.definition_id ?? 0;

    const activeTier = determineFunctionalTierSimple(activeDefId, activeEnergy, activeMaxEnergy, activeHp, activeMaxHp, phase, opponentArchetype);
    const activeCollapseDist = computeCollapseDistance(activeHp, activeMaxHp, activeEnergy, activeMaxEnergy, activeTier, oppDmgCap, oppReactionBonus);

    const allSelfChars = getAliveCharacters(digest.self_summary);
    const avgCollapseDist = allSelfChars.length > 0
      ? allSelfChars.reduce((sum, c) => sum + computeCollapseDistance(c.hp, c.max_hp, c.energy, c.max_energy, determineFunctionalTierSimple(c.definition_id, c.energy, c.max_energy, c.hp, c.max_hp, phase, opponentArchetype), oppDmgCap, oppReactionBonus), 0) / allSelfChars.length
      : 1;

    // burstWindowUrgency using opponent damage capacity
    const hasReactionSetup = (context?.turnPlan?.hasReactionWindow ?? false) || (observation?.derived.self_reaction_ready_score ?? 0) > 0.5;
    const burstUrgency = burstWindowUrgency(activeEnergy, activeMaxEnergy, activeHp, oppDmgCap, hasReactionSetup);

    // healUrgency based on collapse distance
    const healUrgency = (1 - activeCollapseDist) * 0.7 + (1 - avgCollapseDist) * 0.3;

    let score = 0;

    if (damage !== 0) {
      score += damage;
      reasons.push(`damage=${damage.toFixed(2)}`);
    }

    if (reaction !== 0) {
      score += reaction * p.reactionWeight;
      reasons.push(`reaction=${reaction.toFixed(2)}`);
    }

    if (tempo !== 0) {
      score += tempo * p.tempoWeight;
      reasons.push(`tempo=${tempo.toFixed(2)}`);
    }

    if (healing !== 0) {
      // Use collapse-distance-based healUrgency with tier multiplier
      const tierMultiplier = activeTier === "core" ? 1.5
        : activeTier === "tactical" ? 1.0
        : 0.6;
      const healScore = healing * Math.max(0.3, healUrgency) * tierMultiplier * p.healingWeight;
      score += healScore;
      reasons.push(`heal=+${healScore.toFixed(2)}`);
      if (selfHeal > 0 && activeCollapseDist < 0.5) {
        score += 0.5;
        reasons.push("selfHealLowCollapse=+0.50");
      }
    }

    if (draw !== 0) {
      const handDemand = currentCardsInHand(digest) <= 2 ? 1.2 : 0.8;
      const drawScore = draw * handDemand * p.drawWeight;
      score += drawScore;
      reasons.push(`draw=+${drawScore.toFixed(2)}`);
    }

    // HC-04:支援位满时的净价值计算
    if (createSupport !== 0) {
      if (supportRoom > 0) {
        const supportScore = createSupport * (1 + earlyRoundFactor(digest) * 0.5) * p.supportWeight;
        score += supportScore;
        reasons.push(`support=+${supportScore.toFixed(2)}`);
      } else {
        const replacementScore = createSupport * 0.4 * p.supportWeight;
        if (replacementScore > 0.5) {
          score += replacementScore;
          reasons.push(`supportReplace=+${replacementScore.toFixed(2)}`);
        }
      }
    }

    if (createSummon !== 0 && summonRoom > 0) {
      const summonScore = createSummon * (1 + earlyRoundFactor(digest) * 0.5) * p.summonWeight;
      score += summonScore;
      reasons.push(`summon=+${summonScore.toFixed(2)}`);
    }

    if (createEquipment !== 0) {
      const equipmentScore = createEquipment * p.equipmentWeight;
      score += equipmentScore;
      reasons.push(`equip=+${equipmentScore.toFixed(2)}`);
    }

    // H1: Burst window urgency replaces simple energyGap threshold
    if (energyGain !== 0) {
      const energyScore = energyGain * burstUrgency * p.energyWeight;
      score += energyScore;
      reasons.push(`energy=+${energyScore.toFixed(2)}`);
    }

    if (diceFix !== 0) {
      const diceFixScore = diceFix * (1 + poorDiceFactor(digest)) * p.diceFixWeight;
      score += diceFixScore;
      reasons.push(`diceFix=+${diceFixScore.toFixed(2)}`);
    }

    if (forcedSwitch !== 0) {
      const forcedSwitchScore = forcedSwitch * 0.8;
      score += forcedSwitchScore;
      reasons.push(`forceSwitch=+${forcedSwitchScore.toFixed(2)}`);
    }

    if (selfSwitch !== 0) {
      let switchPenalty = selfSwitch * 0.3;

      // Reduce penalty if current active character is at risk of collapse
      if (activeCollapseDist < 0.4) {
        const collapseRelief = (0.4 - activeCollapseDist) * 1.5;
        switchPenalty = Math.max(-0.5, switchPenalty - collapseRelief);
        reasons.push(`switch_collapse=+${collapseRelief.toFixed(2)}`);
      }

      // Reduce penalty if current character has no energy (can't act meaningfully)
      if (selfActiveEnergyGap >= activeMaxEnergy && activeMaxEnergy > 0) {
        switchPenalty = Math.max(-0.5, switchPenalty - 0.3);
        reasons.push("switch_noEnergy=+0.30");
      }

      // Increase penalty if current character has burst ready (should stay on field)
      if (selfActiveEnergyGap <= 0 && activeMaxEnergy > 0) {
        switchPenalty += 0.5;
        reasons.push("switch_burstReady=+0.50");
      }

      score -= switchPenalty;
      reasons.push(`selfSwitch=-${switchPenalty.toFixed(2)}`);
    }

    // H8: Risk weighted by functional tier — core characters penalized more
    if (risk !== 0) {
      const riskMultiplier = activeTier === "core" ? 1.5
        : activeTier === "tactical" ? 1.0
        : 0.6;
      score -= risk * p.riskWeight * riskMultiplier;
      reasons.push(`risk=-${(risk * p.riskWeight * riskMultiplier).toFixed(2)}`);
    }

    if (totalCost > 0) {
      score -= totalCost * p.costWeight;
      reasons.push(`cost=-${(totalCost * p.costWeight).toFixed(2)}`);
    }

    // ── TurnPlan & DiceReservation adjustments ──
    const turnPlan = context?.turnPlan;
    const diceReservation = context?.diceReservation;
    const tags = Array.isArray(candidate.tags) ? (candidate.tags as string[]) : [];

    // H1: burst window risk — core charging character should not be exposed on front line
    if (actionCase === "useSkill" && !tags.includes("skill_type:burst") && burstUrgency >= 2.0) {
      score -= burstUrgency * 0.5;
      reasons.push(`burst_window_risk=-${(burstUrgency * 0.5).toFixed(2)}`);
    }

    // TurnPlan: protected character should not be switched to
    const protectedIds = turnPlan?.protectedCharacterIds ?? [];
    const targetId = Number(candidate.target_ids?.[0] ?? candidate.character_definition_id ?? 0);
    if (actionCase === "switchActive" && protectedIds.includes(targetId)) {
      score -= 2.0;
      reasons.push("protect_char=-2.00");
    }

    // TurnPlan: burst window should not be missed for non-burst actions
    if (turnPlan?.hasBurstWindow && actionCase !== "useSkill" && !tags.includes("skill_type:burst")) {
      score -= 1.0;
      reasons.push("burst_window_miss=-1.00");
    }

    // DiceReservation: penalize consuming reserved dice
    if (diceReservation && diceReservation.reserved.size > 0) {
      const costMap = buildCostMapFromCandidate(candidate);
      const isInPlannedSequence = turnPlan?.plannedActionSequence
        ?.some(plannedCase => actionCase === plannedCase) ?? false;

      for (const [type, count] of costMap) {
        const reservedCount = diceReservation.reserved.get(type) ?? 0;
        if (count > 0 && reservedCount > 0) {
          if (isInPlannedSequence) {
            const softPenalty = Math.min(count, reservedCount) * 0.25;
            score -= softPenalty;
            if (softPenalty > 0) reasons.push(`dice_seq_consume=-${softPenalty.toFixed(2)}`);
          } else {
            const conflictPenalty = Math.min(count, reservedCount) * 0.8;
            score -= conflictPenalty;
            reasons.push(`dice_reservation=-${conflictPenalty.toFixed(2)}`);
          }
        }
      }

      // Tuning bonus: if tuning aligns with plan
      if (actionCase === "elementalTuning" && diceReservation.tuningSuggested && diceReservation.tuningTarget != null) {
        score += 0.5;
        reasons.push("tune_for_plan=+0.50");
      }
    }

    if (actionCase === "declareEnd") {
      let penalty = p.endTurnPenalty;

      // HC-02: 对手已结束回合 → 降低 declareEnd 惩罚
      if (digest.opponent_declared_end) {
        penalty *= 0.6;
        reasons.push("opp_ended_discount");
      }

      // HC-02: 能量已满（大招就绪）→ 增加 declareEnd 惩罚
      if (selfActiveEnergyGap === 0) {
        penalty += 1.5;
        reasons.push("burst_ready=+1.50");
      }

      score -= penalty;
      reasons.push(`declareEnd=-${penalty.toFixed(2)}`);
    }

    if (effectless) {
      score -= p.effectlessPenalty;
      reasons.push(`effectless=-${p.effectlessPenalty.toFixed(2)}`);
    }

    // Q2 fix: 食物/治疗卡在不产生实际治疗时的浪费惩罚
    if (actionCase === "playCard" && isHealFoodCard(candidate) && healing === 0 && selfHeal === 0) {
      const wastePenalty = 1.5 + totalCost * 0.5;
      score -= wastePenalty;
      reasons.push(`foodWaste=-${wastePenalty.toFixed(2)}`);
    }

    if (isFastAction(candidate)) {
      score += 0.5;
      reasons.push("fast=+0.50");
    }

    if (damage >= currentOpponentActiveHp(digest) && damage > 0) {
      score += 4;
      reasons.push("lethal=+4.00");
    }

    // HC-05: 集中击杀激励 — 对低血量角色造成伤害时额外奖励
    const oppActiveHp = currentOpponentActiveHp(digest);
    const oppActiveMaxHp = currentOpponentActiveMaxHp(digest);
    if (damage > 0 && oppActiveHp <= oppActiveMaxHp * 0.5) {
      const focusBonus = Math.min(1.5, (1 - oppActiveHp / oppActiveMaxHp) * 2);
      score += focusBonus;
      reasons.push(`focusKill=+${focusBonus.toFixed(2)}`);
    }

    // H2: Core character collapse risk — penalize using non-burst skills when core char collapse distance is low
    if (activeCollapseDist < 0.35 && activeTier === "core") {
      if (actionCase === "useSkill" && !tags.includes("skill_type:burst")) {
        score -= 0.8;
        reasons.push("core_collapse_risk=-0.80");
      }
    }

    // ── SPL: Threat response bonus ──
    if (context?.threatBonusMap && context.threatBonusMap.size > 0) {
      const threatBonus = computeThreatBonus(candidate, context.threatBonusMap)
      if (threatBonus > 0) {
        score += threatBonus
        reasons.push(`spl_threat=+${threatBonus.toFixed(2)}`)
      }
    }

    // ── SPL: Primary pattern match bonus ──
    if (context?.primaryPatterns && context.primaryPatterns.length > 0) {
      const primaryBonus = computePrimaryMatchBonus(
        candidate,
        context.primaryPatterns,
        context.primaryMatchBonus ?? 2.0,
      )
      if (primaryBonus > 0) {
        score += primaryBonus
        reasons.push(`spl_primary=+${primaryBonus.toFixed(2)}`)
      }
    }

    // ── SPL: Dice budget penalty ──
    if (context?.diceBudget && context.diceBudget.length > 0) {
      const availableDice = extractDiceFromDigest(digest)
      const budgetPenalty = computeDiceBudgetPenalty(candidate, context.diceBudget, availableDice)
      if (budgetPenalty > 0) {
        score -= budgetPenalty
        reasons.push(`spl_budget=-${budgetPenalty.toFixed(2)}`)
      }
    }

    return {
      candidateId,
      actionCase,
      heuristicScore: score,
      finalScore: score,
      reasons,
      candidate,
    };
  }
}

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function totalCostFromCandidate(candidate: PolicyCandidateAction): number {
  const cost = candidate.cost ?? candidate.total_cost ?? candidate.dice_cost;
  if (typeof cost === "number") return cost;
  if (Array.isArray(cost)) return cost.length;
  if (cost && typeof cost === "object") {
    const values = Object.values(cost as Record<string, unknown>).map(safeNumber);
    return values.reduce((sum, v) => sum + v, 0);
  }
  return safeNumber(cost);
}

function isFastAction(candidate: PolicyCandidateAction): boolean {
  const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
  const notes = Array.isArray(candidate.notes) ? candidate.notes : [];
  const text = [...tags, ...notes].map(String).join(" ").toLowerCase();
  return text.includes("fast");
}

function currentOpponentActiveHp(digest: PolicyTurnDigest): number {
  const summary = digest.opponent_summary as {
    active_character_id?: number;
    characters?: Array<{ id?: number; hp?: number }>;
  };
  const activeId = summary.active_character_id;
  const chars = Array.isArray(summary.characters) ? summary.characters : [];
  return chars.find((c) => c.id === activeId)?.hp ?? 999;
}

function currentOpponentActiveMaxHp(digest: PolicyTurnDigest): number {
  const summary = digest.opponent_summary as {
    active_character_id?: number;
    characters?: Array<{ id?: number; max_hp?: number }>;
  };
  const activeId = summary.active_character_id;
  const chars = Array.isArray(summary.characters) ? summary.characters : [];
  return chars.find((c) => c.id === activeId)?.max_hp ?? 10;
}

function currentSelfActiveHpRatio(digest: PolicyTurnDigest): number {
  const summary = digest.self_summary as {
    active_character_id?: number;
    characters?: Array<{ id?: number; hp?: number; max_hp?: number }>;
  };
  const activeId = summary.active_character_id;
  const chars = Array.isArray(summary.characters) ? summary.characters : [];
  const active = chars.find((c) => c.id === activeId);
  if (!active) {
    return 1;
  }
  return (active.hp ?? 0) / Math.max(1, active.max_hp ?? 10);
}

function currentSelfTeamAvgHpRatio(digest: PolicyTurnDigest): number {
  const summary = digest.self_summary as {
    characters?: Array<{ hp?: number; max_hp?: number; alive?: boolean }>;
  };
  const chars = Array.isArray(summary.characters) ? summary.characters : [];
  const alive = chars.filter((c) => c.alive !== false && (c.hp ?? 1) > 0);
  if (alive.length === 0) {
    return 1;
  }
  return alive.reduce(
    (sum, c) => sum + (c.hp ?? 0) / Math.max(1, c.max_hp ?? 10),
    0,
  ) / alive.length;
}

function currentSelfActiveEnergyGap(digest: PolicyTurnDigest): number {
  const summary = digest.self_summary as {
    active_character_id?: number;
    characters?: Array<{ id?: number; energy?: number; max_energy?: number }>;
  };
  const activeId = summary.active_character_id;
  const chars = Array.isArray(summary.characters) ? summary.characters : [];
  const active = chars.find((c) => c.id === activeId);
  if (!active) {
    return 3;
  }
  return Math.max(0, (active.max_energy ?? 3) - (active.energy ?? 0));
}

function currentCardsInHand(digest: PolicyTurnDigest): number {
  return safeNumber((digest.resource_summary as Record<string, unknown>).cards_in_hand);
}

function remainingSlots(
  summary: Record<string, unknown>,
  usedKey: string,
  maxKey: string,
): number {
  const used = safeNumber(summary[usedKey]);
  const max = safeNumber(summary[maxKey]) || 4;
  return Math.max(0, max - used);
}

function earlyRoundFactor(digest: PolicyTurnDigest): number {
  return digest.round <= 2 ? 1 : digest.round <= 4 ? 0.5 : 0.2;
}

function poorDiceFactor(digest: PolicyTurnDigest): number {
  const summary = digest.resource_summary as Record<string, unknown>;
  const diceCount = safeNumber(summary.dice_count);
  const omniCount = safeNumber(summary.omni_count);
  if (diceCount <= 0) {
    return 0;
  }
  return Math.max(0, 1 - omniCount / diceCount);
}

function isHealFoodCard(candidate: PolicyCandidateAction): boolean {
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : [];
  return tags.some((tag) =>
    tag === "heal" || tag === "heal_now" || tag === "tag:food" || tag === "food",
  );
}

function getActiveCharacter(summary: Record<string, unknown>): { hp: number; max_hp: number; energy: number; max_energy: number; definition_id: number } | null {
  const chars = Array.isArray((summary as Record<string, unknown>).characters)
    ? ((summary as Record<string, unknown>).characters as Array<{ id?: number; hp?: number; max_hp?: number; energy?: number; max_energy?: number; definition_id?: number }>)
    : [];
  const activeId = Number((summary as Record<string, unknown>).active_character_id ?? 0);
  const found = chars.find(c => c.id === activeId) ?? chars[0];
  if (!found) return null;
  return { hp: found.hp ?? 10, max_hp: found.max_hp ?? 10, energy: found.energy ?? 0, max_energy: found.max_energy ?? 3, definition_id: found.definition_id ?? 0 };
}

function getAliveCharacters(summary: Record<string, unknown>): Array<{ hp: number; max_hp: number; energy: number; max_energy: number; definition_id: number }> {
  const chars = Array.isArray((summary as Record<string, unknown>).characters)
    ? ((summary as Record<string, unknown>).characters as Array<{ hp?: number; max_hp?: number; energy?: number; max_energy?: number; definition_id?: number; alive?: boolean }>)
    : [];
  return chars
    .filter(c => c.alive !== false && (c.hp ?? 1) > 0)
    .map(c => ({
      hp: c.hp ?? 10,
      max_hp: c.max_hp ?? 10,
      energy: c.energy ?? 0,
      max_energy: c.max_energy ?? 3,
      definition_id: c.definition_id ?? 0,
    }));
}

function determineFunctionalTierSimple(
  charId: number,
  energy: number,
  maxEnergy: number,
  hp: number,
  maxHp: number,
  phase: GamePhaseKind,
  deckArchetype: OpponentArchetype,
): FunctionalTier {
  return determineFunctionalTier(charId, energy, maxEnergy, hp, maxHp, phase, deckArchetype);
}

function determineFunctionalTier(
  charId: number,
  energy: number,
  maxEnergy: number,
  hp: number,
  maxHp: number,
  phase: GamePhaseKind,
  deckArchetype: OpponentArchetype,
): FunctionalTier {
  const DECK_DEFAULT_ROLE_MAP: Record<number, "core_dps" | "core_burst" | "enabler" | "aura_applier" | "flex"> = {}
  const roleMap = DECK_DEFAULT_ROLE_MAP
  const role = roleMap[charId]
  if (!role) return "tactical"

  const hpRatio = maxHp > 0 ? hp / maxHp : 1
  const energyRatio = maxEnergy > 0 ? energy / maxEnergy : 0

  if (role === "core_dps" || role === "core_burst") {
    if (phase === "closing" && hpRatio > 0.5) return "core"
    if (phase === "setup" && energyRatio < 0.5) return "tactical"
    return "core"
  }
  if (role === "enabler" || role === "aura_applier") {
    if (phase === "execution" || phase === "closing") return "residual"
    return "tactical"
  }
  return "tactical"
}

export interface DiceQualityMetrics {
  omniCount: number
  totalDice: number
  deficitByElement: Record<number, number>
  unlockPotential: number
  qualityScore: number
}

export function computeDiceQualityMetrics(digest: PolicyTurnDigest): DiceQualityMetrics {
  const summary = digest.resource_summary as Record<string, unknown>
  const totalDice = safeNumber(summary.dice_count)
  const omniCount = safeNumber(summary.omni_count)
  const diceValues = Array.isArray(summary.dice_values)
    ? (summary.dice_values as number[])
    : []

  const deficitByElement: Record<number, number> = {}
  let totalDeficit = 0
  for (const candidate of digest.candidate_actions) {
    if (candidate.is_valid === false) continue
    if (candidate.action_case === "elementalTuning" || candidate.action_case === "declareEnd") continue
    const cost = buildCostMapFromCandidate(candidate)
    for (const [type, count] of cost) {
      const current = deficitByElement[type] ?? 0
      const deficit = Math.max(0, count - (deficitByElement[type] ?? 0))
      if (deficit > 0) {
        deficitByElement[type] = Math.max(current, count)
        totalDeficit += deficit
      }
    }
  }

  let unlockPotential = 0
  const activeElement = activeCharacterElementFromDigest(digest)
  if (activeElement != null && diceValues.length > 0) {
    for (const candidate of digest.candidate_actions) {
      if (candidate.is_valid !== false) continue
      if (candidate.action_case === "elementalTuning" || candidate.action_case === "declareEnd") continue
      const cost = buildCostMapFromCandidate(candidate)
      if (cost.size === 0) continue
      if (hasPayableDiceCost(cost, diceValues)) continue
      for (let i = 0; i < diceValues.length; i++) {
        const tunedDice = [...diceValues]
        tunedDice[i] = activeElement
        if (hasPayableDiceCost(cost, tunedDice)) {
          unlockPotential++
          break
        }
      }
    }
  }

  const maxDeficit = Math.max(totalDeficit, 1)
  const qualityScore = totalDice > 0
    ? Math.max(0, Math.min(1, 1 - totalDeficit / (totalDice * 2) + omniCount / totalDice * 0.5))
    : 0

  return {
    omniCount,
    totalDice,
    deficitByElement,
    unlockPotential,
    qualityScore,
  }
}

function buildCostMapFromCandidate(candidate: PolicyCandidateAction): Map<number, number> {
  const result = new Map<number, number>()
  const requiredCost = Array.isArray(candidate.required_cost)
    ? candidate.required_cost
    : []
  for (const item of requiredCost) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const type = Number((item as Record<string, unknown>).type ?? 0)
    const count = Number((item as Record<string, unknown>).count ?? 0)
    if (!Number.isFinite(type) || !Number.isFinite(count) || count <= 0) continue
    result.set(type, count)
  }
  return result
}

function hasPayableDiceCost(cost: Map<number, number>, diceValues: readonly number[]): boolean {
  let omniAvailable = 0
  const diceCounts = new Map<number, number>()
  for (const d of diceValues) {
    const key = Number(d)
    diceCounts.set(key, (diceCounts.get(key) ?? 0) + 1)
    if (key === 8) omniAvailable++
  }
  let remainingOmni = omniAvailable
  for (const [type, count] of cost) {
    let needed = count
    const available = diceCounts.get(type) ?? 0
    if (available >= needed) {
      needed = 0
    } else {
      needed -= available
      if (remainingOmni >= needed) {
        remainingOmni -= needed
        needed = 0
      }
    }
    if (needed > 0) return false
  }
  return true
}

function activeCharacterElementFromDigest(digest: PolicyTurnDigest): number | null {
  const summary = digest.self_summary as {
    active_character_id?: number
    characters?: Array<{ id?: number; definition_id?: number }>
  }
  const activeId = summary.active_character_id
  const chars = Array.isArray(summary.characters) ? summary.characters : []
  const active = chars.find((c) => c.id === activeId)
  if (!active?.definition_id) return null
  return CHARACTER_ELEMENT_MAP.get(active.definition_id) ?? null
}

const GAME_DATA = getData(CURRENT_VERSION)
const CHARACTER_ELEMENT_MAP = buildCharacterElementMap()

function buildCharacterElementMap(): Map<number, number> {
  const map = new Map<number, number>()
  for (const [id, character] of GAME_DATA.characters) {
    map.set(id, characterElementFromTags(character))
  }
  return map
}

function characterElementFromTags(character: { tags?: readonly string[] }): number {
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

// ── SPL helpers ──

function mergeWeightOverrides(
  base: HeuristicProfile,
  override: PhaseWeightsOverride,
): HeuristicProfile {
  const merged = { ...base }
  if (override.endTurnPenalty != null) merged.endTurnPenalty = override.endTurnPenalty
  if (override.riskWeight != null) merged.riskWeight = override.riskWeight
  if (override.reactionWeight != null) merged.reactionWeight = override.reactionWeight
  if (override.tempoWeight != null) merged.tempoWeight = override.tempoWeight
  if (override.costWeight != null) merged.costWeight = override.costWeight
  if (override.healingWeight != null) merged.healingWeight = override.healingWeight
  if (override.drawWeight != null) merged.drawWeight = override.drawWeight
  if (override.supportWeight != null) merged.supportWeight = override.supportWeight
  if (override.summonWeight != null) merged.summonWeight = override.summonWeight
  if (override.equipmentWeight != null) merged.equipmentWeight = override.equipmentWeight
  if (override.energyWeight != null) merged.energyWeight = override.energyWeight
  if (override.diceFixWeight != null) merged.diceFixWeight = override.diceFixWeight
  if (override.effectlessPenalty != null) merged.effectlessPenalty = override.effectlessPenalty
  return merged
}

function extractDiceFromDigest(digest: PolicyTurnDigest): Record<string, number> {
  const resource = digest.resource_summary as Record<string, unknown> | undefined
  const dice: Record<string, number> = {}
  if (resource?.dice && Array.isArray(resource.dice)) {
    for (const d of resource.dice as Array<{ type?: number | string; count?: number }>) {
      if (d && d.type != null) {
        const key = String(d.type)
        dice[key] = (dice[key] ?? 0) + (d.count ?? 1)
      }
    }
  }
  return dice
}
