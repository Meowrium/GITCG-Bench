// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type {
  DeckFeaturesV2,
  MatchupFeaturesV2,
} from "../../../../llm-deck-analyzer/src/index.js";
import type { DeckPriorFeatureVector } from "../../runtime/policy/prior-types.js";

function hasLabel(source: readonly string[], target: string): number {
  return source.includes(target) ? 1 : 0;
}

export function flattenDeckMatchupPriors(
  selfDeck: DeckFeaturesV2,
  opponentDeck: DeckFeaturesV2,
  matchup: MatchupFeaturesV2,
): DeckPriorFeatureVector {
  return {
    selfDeckSetupSpeed: selfDeck.dense.tempoProfile.setupSpeed,
    selfDeckTempoPush: selfDeck.dense.tempoProfile.tempoPush,
    selfDeckLongGameValue: selfDeck.dense.tempoProfile.longGameValue,
    selfDeckDefensiveStability: selfDeck.dense.tempoProfile.defensiveStability,
    selfDeckFinisherDensity: selfDeck.dense.tempoProfile.finisherDensity,
    selfDeckReactionReliance: selfDeck.dense.strategyProfile.reactionReliance,
    selfDeckSupportReliance: selfDeck.dense.strategyProfile.supportReliance,
    selfDeckTalentReliance: selfDeck.dense.strategyProfile.talentReliance,
    selfDeckEquipmentReliance: selfDeck.dense.strategyProfile.equipmentReliance,
    selfDeckSummonReliance: selfDeck.dense.strategyProfile.summonReliance,
    selfDeckDependencyRisk: selfDeck.dense.strategyProfile.dependencyRisk,
    opponentDeckSetupSpeed: opponentDeck.dense.tempoProfile.setupSpeed,
    opponentDeckTempoPush: opponentDeck.dense.tempoProfile.tempoPush,
    opponentDeckLongGameValue: opponentDeck.dense.tempoProfile.longGameValue,
    opponentDeckDefensiveStability: opponentDeck.dense.tempoProfile.defensiveStability,
    opponentDeckFinisherDensity: opponentDeck.dense.tempoProfile.finisherDensity,
    opponentDeckReactionReliance: opponentDeck.dense.strategyProfile.reactionReliance,
    opponentDeckSupportReliance: opponentDeck.dense.strategyProfile.supportReliance,
    opponentDeckTalentReliance: opponentDeck.dense.strategyProfile.talentReliance,
    opponentDeckEquipmentReliance: opponentDeck.dense.strategyProfile.equipmentReliance,
    opponentDeckSummonReliance: opponentDeck.dense.strategyProfile.summonReliance,
    opponentDeckDependencyRisk: opponentDeck.dense.strategyProfile.dependencyRisk,
    matchupSetupSpeedDelta: matchup.dense.setupSpeedDelta,
    matchupLongGameValueDelta: matchup.dense.longGameValueDelta,
    matchupSupportGreedDelta: matchup.dense.supportGreedDelta,
    matchupDefensiveStabilityDelta: matchup.dense.defensiveStabilityDelta,
    matchupFinisherDensityDelta: matchup.dense.finisherDensityDelta,
    matchupPunishGreedySetupDelta: matchup.dense.punishGreedySetupDelta,
    matchupAntiSummonDelta: matchup.dense.antiSummonDelta,
    matchupAntiSupportDelta: matchup.dense.antiSupportDelta,
    matchupRouteConflictScore: matchup.dense.routeConflictScore,
    matchupDependencyPunishScore: matchup.dense.dependencyPunishScore,
    selfRouteReaction: hasLabel(selfDeck.labels.routes, "reaction_route"),
    selfRouteResource: hasLabel(selfDeck.labels.routes, "resource_route"),
    selfRouteCarry: hasLabel(selfDeck.labels.routes, "carry_route"),
    selfArchetypeSupportEngine: hasLabel(selfDeck.labels.archetypes, "support_engine"),
    opponentRouteReaction: hasLabel(opponentDeck.labels.routes, "reaction_route"),
    opponentRouteResource: hasLabel(opponentDeck.labels.routes, "resource_route"),
    opponentRouteCarry: hasLabel(opponentDeck.labels.routes, "carry_route"),
    opponentArchetypeSupportEngine: hasLabel(opponentDeck.labels.archetypes, "support_engine"),
  };
}

export function scoreDeckPriorFeatures(features: DeckPriorFeatureVector): number {
  const setupEdge = features.selfDeckSetupSpeed - features.opponentDeckSetupSpeed;
  const longGameEdge = features.selfDeckLongGameValue - features.opponentDeckLongGameValue;
  const finisherEdge = features.selfDeckFinisherDensity - features.opponentDeckFinisherDensity;
  const stabilityEdge =
    features.selfDeckDefensiveStability - features.opponentDeckDefensiveStability;
  const dependencyPenalty =
    features.selfDeckDependencyRisk - features.opponentDeckDependencyRisk;

  return (
    setupEdge * 1.2 +
    longGameEdge * 0.9 +
    finisherEdge * 1.1 +
    stabilityEdge * 0.6 +
    features.matchupSetupSpeedDelta * 0.8 +
    features.matchupLongGameValueDelta * 0.5 -
    dependencyPenalty * 0.8 +
    features.matchupPunishGreedySetupDelta * 0.4 +
    features.matchupDependencyPunishScore * 0.35 +
    features.selfRouteReaction * 0.25 +
    features.selfRouteCarry * 0.15 +
    features.selfArchetypeSupportEngine * 0.2
  );
}
