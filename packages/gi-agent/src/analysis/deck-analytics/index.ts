// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Deck Analytics Engine — public API.
 */

// Core types
export type {
  DicePool, ElementType, SkillCost, ColoredCost,
  CharacterData, SkillData, SkillType, CardData, CardCategory,
  CharacterState, OpponentState, CardState, TurnState,
  ParsedAction, ActionType,
  ValidationResult, TurnStateDelta, TurnMetrics,
  DeckModel,
} from "./core/types.js";

export {
  ALL_ELEMENTS, emptyDicePool, totalDice, subtractDice,
  zeroCost, totalDiceCost, damageTypeToElement,
} from "./core/types.js";

// Data loader
export { parseCharacterFile, parseCardFile, loadAllCharacters, loadAllCards } from "./core/data-loader.js";

// Turn simulator
export {
  TurnSimulator,
  createCharacterState,
  createOpponent,
  createTurnState,
} from "./core/turn-simulator.js";
export type { SimulationResult, StepResult } from "./core/turn-simulator.js";

// Plugin interface
export type { DeckAnalysisPlugin } from "./plugins/plugin-interface.js";

// Plugins
export { DiceEconomyPlugin, canAfford, SWITCH_COST, TUNING_COST, buildSkillActionCost } from "./plugins/dice-economy.js";
export { EnergyTrackerPlugin } from "./plugins/energy-tracker.js";
export { DamageCalculatorPlugin, maxSkillDamage } from "./plugins/damage-calculator.js";
export type { DamageBonus } from "./plugins/damage-calculator.js";
export { OpeningAnalyzerPlugin, analyzeOpenings } from "./plugins/opening-analyzer.js";
export type { OpeningAnalysis } from "./plugins/opening-analyzer.js";
export { CardEffectPlugin, CardEffectRegistry, extractCardEffects } from "./plugins/card-effect.js";
export type { CardEffect, CardEffectKind } from "./plugins/card-effect.js";

// Reaction table
export { computeReaction, reactionDamageBonus } from "./data/reaction-table.js";
export type { Aura, ReactionResult } from "./data/reaction-table.js";
