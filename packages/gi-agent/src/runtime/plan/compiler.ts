// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { DeckAnalysis } from "@gi-tcg/llm-deck-analyzer"
import type {
  ActionPattern,
  Condition,
  DeckMeta,
  PhaseTransition,
  PlanPhase,
  ReplanTriggerDef,
  ThreatRule,
  V2PlanPhase,
} from "./types.js"

/**
 * ── V2 Framework: Phase Compiler ──
 *
 * Compiles deck analysis into the 3-phase, 8-node decision model
 * described in §2-3 of the AI Decision Framework V2.
 *
 * Phase → Node mapping:
 *   Opening (T1):          node 0 (Mulligan), node 1 (Reroll), node 2 (Action), node 3 (Risk Check)
 *   Midgame (T2):          node 4 (Offense), node 5 (Lethal Chain), node 6 (Phase Transition)
 *   Closing (T3+):         node 7 (Final Lethal)
 *
 * Phase transitions are discrete, condition-triggered (§2.2):
 *   opening → midgame:   self.summon_active AND investment_cards_played >= 1 AND round >= 2
 *   midgame → closing:   opponent.characters_alive <= 2
 */

/**
 * Compile a DeckAnalysis into V2 phases.
 */
export function compileDeckAnalysisToPlan(
  analysis: DeckAnalysis,
): PlanPhase[] {
  const phases: PlanPhase[] = []

  // ── Phase 1: Opening (T1) ──
  phases.push(createOpeningPhase(analysis))

  // ── Phase 2: Midgame (T2) ──
  phases.push(createMidgamePhase(analysis))

  // ── Phase 3: Closing (T3+) ──
  phases.push(createClosingPhase(analysis))

  // ── Emergency Recovery (always present as fallback) ──
  phases.push(createRecoveryPhase(analysis))

  return phases
}

/**
 * Create a static PlanPhase[] for a specific well-known deck.
 * Falls through to the general compiler for now.
 */
export function createStaticPlanForDeck(
  deckFingerprint: string,
  analysis: DeckAnalysis,
): PlanPhase[] {
  return compileDeckAnalysisToPlan(analysis)
}

// ---------------------------------------------------------------------------
// Phase Builders
// ---------------------------------------------------------------------------

const SKILL_PATTERN_NORMAL: ActionPattern = { type: "normal_attack", characterId: 0 }
const SKILL_PATTERN_SKILL: ActionPattern = { type: "elemental_skill", characterId: 0 }
const SKILL_PATTERN_BURST: ActionPattern = { type: "elemental_burst", characterId: 0 }
const PLAY_SUPPORT: ActionPattern = { type: "play_card_class", cardClass: "support" }
const PLAY_EVENT: ActionPattern = { type: "play_card_class", cardClass: "event" }
const PLAY_FOOD: ActionPattern = { type: "play_card_class", cardClass: "food" }
const PLAY_WEAPON: ActionPattern = { type: "play_card_class", cardClass: "weapon" }
const DECLARE_END: ActionPattern = { type: "declare_end" }
const ELEMENTAL_TUNING: ActionPattern = { type: "elemental_tuning" }

/**
 * Opening Phase (§3.1-3.4): Establish board state, minimize dice waste.
 * Nodes: 0-3 (Mulligan, Reroll, Action, Risk Check)
 */
function createOpeningPhase(analysis: DeckAnalysis): V2PlanPhase {
  return {
    phaseId: "opening",
    name: "Opening",
    nodeId: 0,
    turnRange: { min: 1, max: 2 },
    preconditions: [
      { type: "round_gte", round: 1 },
    ],
    completionConditions: [
      // Transition when summons active AND investment cards played
      { type: "summon_active", characterId: 0 },
      { type: "round_gte", round: 2 },
    ],
    actionPriorities: {
      primary: [
        { type: "elemental_skill", characterId: 0 },   // Mona E = node 2
        PLAY_SUPPORT,
        PLAY_EVENT,
      ],
      secondary: [
        PLAY_WEAPON,
        ELEMENTAL_TUNING,
      ],
      banned: [
        DECLARE_END,
      ],
    },
    diceBudget: [
      { element: "hydro", count: 3, purpose: "Node 2: Elemental Skill (Mona E)", priority: 1 },
      { element: "any", count: 3, purpose: "Node 2: Investment support (Paimon)", priority: 2 },
    ],
    threatRules: createOpeningThreatRules(analysis),
    fallbackPhaseId: "emergency_recovery",
    weightOverrides: {
      supportWeight: 2.0,
      summonWeight: 2.0,
      equipmentWeight: 1.3,
      drawWeight: 0.5,
      diceFixWeight: 0.6,
      riskWeight: 1.5,
      reactionWeight: 1.0,
      tempoWeight: 0.6,
      costWeight: 0.5,
      energyWeight: 1.2,
      healingWeight: 1.0,
      effectlessPenalty: 4.0,
      endTurnPenalty: 5.0,
    },
    primaryMatchBonus: 2.0,
    transitions: [
      {
        from: "opening",
        to: "midgame",
        trigger: "self.summon_active AND investment_cards_played >= 1 AND round >= 2",
        condition: [
          { type: "summon_active", characterId: 0 },
          { type: "round_gte", round: 2 },
        ],
        immediateAction: "switch_to_dps_character",
      },
    ],
    replanTriggers: [
      {
        id: "opponent_early_end",
        condition: [{ type: "opponent_declared_end" }],
        priority: 1,
        description: "Opponent declared end — evaluate if our element plan is disrupted",
      },
      {
        id: "dice_catastrophe_opening",
        condition: [{ type: "dice_count", element: "any", min: 3 }],
        priority: 3,
        description: "Very few dice — reduce to single action and end",
      },
    ],
  }
}

/**
 * Midgame Phase (§3.5-3.6): Use opening resources for first offensive wave.
 * Nodes: 4-6 (Offense, Lethal Chain, Phase Transition)
 */
function createMidgamePhase(analysis: DeckAnalysis): V2PlanPhase {
  const midPrimary: ActionPattern[] = [
    SKILL_PATTERN_NORMAL,
    SKILL_PATTERN_SKILL,
    SKILL_PATTERN_BURST,
  ]
  // If analysis mentions anemo/reaction, prioritize skill
  if (analysis.gamePlan.midGame?.toLowerCase().includes("reaction") ||
      analysis.gamePlan.midGame?.toLowerCase().includes("扩散") ||
      analysis.gamePlan.midGame?.toLowerCase().includes("扩散")) {
    midPrimary.unshift(SKILL_PATTERN_SKILL)
  }

  return {
    phaseId: "midgame",
    name: "Midgame",
    nodeId: 4,
    turnRange: { min: 2, max: 4 },
    preconditions: [
      { type: "round_gte", round: 2 },
    ],
    completionConditions: [
      { type: "defeated_count", min: 1 },
    ],
    actionPriorities: {
      primary: midPrimary,
      secondary: [
        PLAY_EVENT,
        PLAY_FOOD,
        { type: "switch_to", characterId: 0 },
      ],
      banned: [],
    },
    diceBudget: [
      { element: "anemo", count: 3, purpose: "Node 4: Elemental Skill (Wanderer E)", priority: 1 },
      { element: "anemo", count: 4, purpose: "Node 5: Burst (Wanderer Q)", priority: 2 },
    ],
    threatRules: createMidgameThreatRules(analysis),
    fallbackPhaseId: "emergency_recovery",
    weightOverrides: {
      riskWeight: 2.0,
      reactionWeight: 1.5,
      tempoWeight: 1.0,
      energyWeight: 1.5,
      supportWeight: 0.8,
      summonWeight: 1.0,
      drawWeight: 1.0,
      equipmentWeight: 0.8,
      healingWeight: 1.2,
      diceFixWeight: 0.7,
      costWeight: 0.5,
    },
    primaryMatchBonus: 1.5,
    transitions: [
      {
        from: "midgame",
        to: "closing",
        trigger: "opponent.characters_alive <= 2",
        condition: [
          { type: "opponent_characters_alive_count", min: 1 },  // triggers when ≤ 2 alive (fewer than 3)
        ],
        immediateAction: "evaluate_freeze_lock_possibility",
      },
    ],
    replanTriggers: [
      {
        id: "core_character_dies",
        condition: [{ type: "character_defeated", characterId: 0 }],
        priority: 0,
        description: "Core character died — replan opening window with remaining characters",
      },
      {
        id: "opponent_core_dies_midgame",
        condition: [{ type: "defeated_count", min: 1 }],
        priority: 2,
        description: "Opponent core died — consider burst window or phase transition",
      },
      {
        id: "dice_catastrophe_midgame",
        condition: [{ type: "dice_count", element: "any", min: 3 }],
        priority: 3,
        description: "Dice catastrophe — must reduce action plan",
      },
    ],
  }
}

/**
 * Closing Phase (§3.7-3.8): Lock in victory with freeze or lethal chain.
 * Node: 7 (Final Lethal)
 */
function createClosingPhase(analysis: DeckAnalysis): V2PlanPhase {
  return {
    phaseId: "closing",
    name: "Closing",
    nodeId: 7,
    turnRange: { min: 3, max: 15 },
    preconditions: [
      { type: "round_gte", round: 3 },
      { type: "defeated_count", min: 1 },
    ],
    completionConditions: [
      { type: "defeated_count", min: 3 },
    ],
    actionPriorities: {
      primary: [
        SKILL_PATTERN_BURST,
        SKILL_PATTERN_SKILL,
        SKILL_PATTERN_NORMAL,
        PLAY_FOOD,
      ],
      secondary: [
        PLAY_EVENT,
        { type: "switch_to", characterId: 0 },
      ],
      banned: [
        { type: "play_card_class", cardClass: "support" },
      ],
    },
    diceBudget: [
      { element: "cryo", count: 3, purpose: "Node 7: Skill for freeze lock (Eula E)", priority: 1 },
      { element: "cryo", count: 4, purpose: "Node 7: Burst for lethal (Eula Q)", priority: 2 },
    ],
    threatRules: createClosingThreatRules(analysis),
    fallbackPhaseId: "emergency_recovery",
    weightOverrides: {
      riskWeight: 2.5,
      reactionWeight: 2.0,
      tempoWeight: 1.5,
      energyWeight: 2.0,
      healingWeight: 1.5,
      supportWeight: 0.3,
      summonWeight: 0.5,
      drawWeight: 0.5,
      equipmentWeight: 0.5,
      diceFixWeight: 0.4,
      costWeight: 0.3,
    },
    primaryMatchBonus: 2.5,
    transitions: [],
    replanTriggers: [
      {
        id: "core_character_dies_closing",
        condition: [{ type: "character_defeated", characterId: 0 }],
        priority: 0,
        description: "Core died in closing — emergency recovery",
      },
      {
        id: "freeze_lock_possible",
        condition: [
          { type: "all_opponents_have_aura", aura: 2 },  // AuraType.Hydro = 2
        ],
        priority: 1,
        description: "All opponents have hydro aura — activate freeze lock gameplan",
      },
    ],
  }
}

/**
 * Emergency Recovery Phase (always present as fallback).
 */
function createRecoveryPhase(analysis: DeckAnalysis): PlanPhase {
  return {
    phaseId: "emergency_recovery",
    name: "Emergency Recovery",
    turnRange: { min: 1, max: 15 },
    preconditions: [
      { type: "character_defeated", characterId: 0 },
    ],
    completionConditions: [],
    actionPriorities: {
      primary: [
        PLAY_FOOD,
        { type: "switch_to", characterId: 1 },
      ],
      secondary: [],
      banned: [
        DECLARE_END,
        { type: "play_card_class", cardClass: "support" },
        ELEMENTAL_TUNING,
      ],
    },
    diceBudget: [],
    threatRules: extractRecoveryThreatRules(analysis),
    fallbackPhaseId: null,
    weightOverrides: {
      healingWeight: 3.0,
      riskWeight: 3.0,
      drawWeight: 0.3,
      supportWeight: 0.1,
      summonWeight: 0.5,
      equipmentWeight: 0.3,
    },
    primaryMatchBonus: 3.0,
  }
}

// ---------------------------------------------------------------------------
// Threat Rules
// ---------------------------------------------------------------------------

function createOpeningThreatRules(_analysis: DeckAnalysis): ThreatRule[] {
  return [
    {
      threatId: "opp_full_energy_setup",
      threat: { type: "any_opponent_full_energy" },
      priorityActions: [PLAY_FOOD, { type: "switch_to", characterId: -1 }],
      bonusMultiplier: 100,
      description: "Opponent has full energy — prioritize defensive actions",
    },
  ]
}

function createMidgameThreatRules(analysis: DeckAnalysis): ThreatRule[] {
  const rules: ThreatRule[] = [
    {
      threatId: "core_low_hp_mid",
      threat: { type: "character_hp_below", characterId: 0, maxHp: 5 },
      priorityActions: [PLAY_FOOD],
      bonusMultiplier: 100,
      description: "Core character at risk — play food or switch",
    },
    {
      threatId: "opp_full_energy_mid",
      threat: { type: "any_opponent_full_energy" },
      priorityActions: [PLAY_FOOD],
      bonusMultiplier: 50,
      description: "Opponent has full energy during execution",
    },
  ]
  return rules
}

function createClosingThreatRules(_analysis: DeckAnalysis): ThreatRule[] {
  return [
    {
      threatId: "self_burst_ready_closing",
      threat: { type: "any_self_full_energy" },
      priorityActions: [{ type: "elemental_burst", characterId: 0 }],
      bonusMultiplier: 80,
      description: "Self burst ready — prioritize using it in closing",
    },
  ]
}

function extractRecoveryThreatRules(_analysis: DeckAnalysis): ThreatRule[] {
  return [
    {
      threatId: "recovery_low_hp",
      threat: { type: "character_hp_below", characterId: 0, maxHp: 4 },
      priorityActions: [PLAY_FOOD],
      bonusMultiplier: 200,
      description: "Emergency — heal immediately",
    },
  ]
}

// ---------------------------------------------------------------------------
// DeckMeta classification
// ---------------------------------------------------------------------------

export function classifyDeck(analysis: DeckAnalysis): DeckMeta {
  const allText = [
    analysis.winCondition ?? "",
    analysis.gamePlan.earlyGame ?? "",
    analysis.gamePlan.midGame ?? "",
    analysis.gamePlan.lateGame ?? "",
    ...(analysis.strengths ?? []),
    ...(analysis.weaknesses ?? []),
  ].join(" ").toLowerCase()

  const earlyText = (analysis.gamePlan.earlyGame ?? "").toLowerCase()

  let speed: DeckMeta["speed"] = "medium"
  if (/速攻|快攻|抢血|速杀|rush|aggro|tempo|快速/.test(earlyText)) {
    speed = "fast"
  } else if (/后期|慢速|运营|资源|ramp|control|铺场/.test(earlyText)) {
    speed = "slow"
  }

  let archetype: DeckMeta["archetype"] = "midrange"
  if (/爆发|斩杀|otk|combo|一套|秒杀|元素爆发|burst/.test(allText)) {
    archetype = "combo"
  } else if (/快攻|速攻|抢血|aggro/.test(allText)) {
    archetype = "aggro"
  } else if (/铺场|召唤|支援|控制|消耗|ramp|control/.test(allText)) {
    archetype = "control"
  }

  return {
    strength: analysis.strength ?? 5,
    archetype,
    speed,
  }
}
