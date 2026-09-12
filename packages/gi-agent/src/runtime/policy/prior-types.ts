// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

export type PolicyPriorMode = "none" | "self-only" | "both";

export interface DeckPriorFeatureVector {
  selfDeckSetupSpeed: number;
  selfDeckTempoPush: number;
  selfDeckLongGameValue: number;
  selfDeckDefensiveStability: number;
  selfDeckFinisherDensity: number;
  selfDeckReactionReliance: number;
  selfDeckSupportReliance: number;
  selfDeckTalentReliance: number;
  selfDeckEquipmentReliance: number;
  selfDeckSummonReliance: number;
  selfDeckDependencyRisk: number;
  opponentDeckSetupSpeed: number;
  opponentDeckTempoPush: number;
  opponentDeckLongGameValue: number;
  opponentDeckDefensiveStability: number;
  opponentDeckFinisherDensity: number;
  opponentDeckReactionReliance: number;
  opponentDeckSupportReliance: number;
  opponentDeckTalentReliance: number;
  opponentDeckEquipmentReliance: number;
  opponentDeckSummonReliance: number;
  opponentDeckDependencyRisk: number;
  matchupSetupSpeedDelta: number;
  matchupLongGameValueDelta: number;
  matchupSupportGreedDelta: number;
  matchupDefensiveStabilityDelta: number;
  matchupFinisherDensityDelta: number;
  matchupPunishGreedySetupDelta: number;
  matchupAntiSummonDelta: number;
  matchupAntiSupportDelta: number;
  matchupRouteConflictScore: number;
  matchupDependencyPunishScore: number;
  selfRouteReaction: number;
  selfRouteResource: number;
  selfRouteCarry: number;
  selfArchetypeSupportEngine: number;
  opponentRouteReaction: number;
  opponentRouteResource: number;
  opponentRouteCarry: number;
  opponentArchetypeSupportEngine: number;
}

export interface PolicyDeckPriorContext {
  selfDeckCode: string;
  opponentDeckCode: string;
  priorFeatures: DeckPriorFeatureVector;
}
