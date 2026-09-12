// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { ParsedAction, TurnState, ValidationResult, TurnStateDelta, TurnMetrics } from "../core/types.js";

/**
 * Plugin interface for the Deck Analytics engine.
 *
 * Each plugin handles one domain (dice, energy, damage, reactions).
 * The core TurnSimulator orchestrates plugins in sequence:
 *   validate → apply → observeTurn
 */
export interface DeckAnalysisPlugin {
  readonly name: string;

  /** Validate whether the action is legal given current TurnState */
  validate(action: ParsedAction, state: TurnState): ValidationResult;

  /** Apply the action's effects to TurnState (mutates state in place, returns delta) */
  apply(action: ParsedAction, state: TurnState): TurnStateDelta;

  /** Post-turn observation — aggregate metrics across all actions in the turn */
  observeTurn(state: TurnState, actions: ParsedAction[]): TurnMetrics;
}
