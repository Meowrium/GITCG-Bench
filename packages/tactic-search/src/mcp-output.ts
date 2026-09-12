// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type {
  ComboEntry,
  ComboRecommendation,
  ActionType,
} from "./types";

/**
 * Layer 4: MCP Output Interface
 *
 * Converts combo entries into MCP-compatible JSON output
 * that maps to decision-shard-v1 / plan-v2 schemas.
 */

/**
 * Convert ComboEntry objects to MCP-compatible recommendations.
 */
export function toRecommendations(
  combos: ComboEntry[],
  maxPriority: number = 100,
): ComboRecommendation[] {
  if (combos.length === 0) return [];

  // Normalize scores to 1~maxPriority range
  const maxScore = Math.max(...combos.map((c) => c.evaluation.totalScore));
  const minScore = Math.min(...combos.map((c) => c.evaluation.totalScore));
  const scoreRange = maxScore - minScore || 1;

  return combos.map((combo) => {
    const priority = Math.max(
      1,
      Math.round(
        ((combo.evaluation.totalScore - minScore) / scoreRange) * maxPriority,
      ),
    );

    return {
      combo_id: combo.id,
      priority,
      preconditions: formatPreconditions(combo),
      action_sequence: combo.actionSequence.map((a) => ({
        step: a.step,
        tool: mapActionTool(a.type),
        args: {
          definition_id: a.definitionId,
          skill_type: inferSkillType(a),
        },
        is_fast: a.isFast,
      })),
      evaluation: {
        total_score: round2(combo.evaluation.totalScore),
        damage_dealt: combo.evaluation.delta.damageDealt,
        dice_efficiency:
          combo.evaluation.delta.diceSpent > 0
            ? round2(
                combo.evaluation.delta.damageDealt /
                  combo.evaluation.delta.diceSpent,
              )
            : 0,
        turns_consumed: combo.evaluation.delta.turnsConsumed,
        dice_feasibility: round2(combo.evaluation.delta.diceFeasibility),
        hand_dependency_turns: combo.evaluation.delta.handDependencyTurns,
        risk_factors: {
          opponent_response_windows:
            combo.evaluation.riskFactors.opponentResponseWindows,
          combo_break_probability: round2(
            combo.evaluation.riskFactors.comboBreakProbability,
          ),
          resource_overcommit:
            combo.evaluation.riskFactors.resourceOvercommit,
        },
      },
      annotation: formatAnnotation(combo),
    };
  });
}

/**
 * Format combo as a fixed-format annotation string for logging/debugging.
 *
 * Format: [action:name(cost,fast|combat)] → ... | dmg=N dice=M turns=T feas=F
 */
export function formatAnnotation(combo: ComboEntry): string {
  const steps = combo.actionSequence
    .map((a) => {
      const speed = a.isFast ? "fast" : "combat";
      return `[${a.type}:${a.definitionId}(${speed})]`;
    })
    .join(" → ");

  const d = combo.evaluation.delta;
  const stats = `dmg=${d.damageDealt} dice=${d.diceSpent} turns=${d.turnsConsumed} feas=${round2(d.diceFeasibility)}`;

  return `${steps} | ${stats}`;
}

/**
 * Convert combos to decision-shard-v1 candidate_policies format.
 */
export function toCandidatePolicies(
  combos: ComboEntry[],
): CandidatePolicy[] {
  return combos.map((combo, idx) => ({
    id: combo.id,
    priority: Math.max(1, Math.round(combo.evaluation.totalScore)),
    preconditions: formatPreconditions(combo),
    action_template: {
      tool: mapActionTool(combo.actionSequence[0]?.type ?? "declareEnd"),
      args: {
        definition_id: combo.actionSequence[0]?.definitionId ?? 0,
      },
    },
  }));
}

/**
 * Generate a plan-v2 compatible turn_priorities structure
 * for opening combos.
 */
export function toTurnPriorities(
  combos: ComboEntry[],
): TurnPriority[] {
  // Group by phase
  const byPhase = new Map<string, ComboEntry[]>();
  for (const c of combos) {
    const phase = c.preconditions.phase;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(c);
  }

  const priorities: TurnPriority[] = [];

  for (const [phase, phaseCombos] of byPhase) {
    const turn =
      phase === "early" ? 1 : phase === "mid" ? 3 : 6;

    priorities.push({
      turn,
      objectives: phaseCombos.map((c) => ({
        combo_id: c.id,
        score: round2(c.evaluation.totalScore),
        annotation: formatAnnotation(c),
      })),
    });
  }

  return priorities.sort((a, b) => a.turn - b.turn);
}

// ─── Types ───

export interface CandidatePolicy {
  id: string;
  priority: number;
  preconditions: string[];
  action_template: {
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface TurnPriority {
  turn: number;
  objectives: {
    combo_id: string;
    score: number;
    annotation: string;
  }[];
}

// ─── Helpers ───

function mapActionTool(
  type: ActionType,
): "choose_action" | "choose_active" | "elemental_tuning" {
  switch (type) {
    case "switchActive":
      return "choose_active";
    case "elementalTuning":
      return "elemental_tuning";
    default:
      return "choose_action";
  }
}

function inferSkillType(
  action: { type: ActionType; definitionId: number },
): "normal" | "elemental" | "burst" | "technique" | undefined {
  if (action.type !== "useSkill") return undefined;
  // Skill type is heuristic from definition ID patterns:
  // In gi-tcg, skill IDs follow a pattern where the last digit
  // indicates type. This is a rough heuristic.
  const lastDigit = action.definitionId % 10;
  switch (lastDigit) {
    case 1:
      return "normal";
    case 2:
      return "elemental";
    case 3:
      return "burst";
    case 4:
      return "technique";
    default:
      return undefined;
  }
}

function formatPreconditions(combo: ComboEntry): string[] {
  const conditions: string[] = [];
  const pre = combo.preconditions;

  conditions.push(`phase == "${pre.phase}"`);

  if (pre.myActive) {
    conditions.push(
      `my_active.definition_id == ${pre.myActive.definitionId}`,
    );
    if (pre.myActive.minEnergy !== undefined) {
      conditions.push(
        `my_active.energy >= ${pre.myActive.minEnergy}`,
      );
    }
  }

  if (pre.minDice !== undefined) {
    conditions.push(`my_dice_count >= ${pre.minDice}`);
  }

  if (pre.requiredHandCards && pre.requiredHandCards.length > 0) {
    conditions.push(
      `hand_contains([${pre.requiredHandCards.join(",")}])`,
    );
  }

  if (pre.opponentActive?.maxHealth !== undefined) {
    conditions.push(
      `opp_active.health <= ${pre.opponentActive.maxHealth}`,
    );
  }

  return conditions;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
