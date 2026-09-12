// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Boundary note (Sprint 3): the canonical RL contract types live in
// `@gi-tcg/ml/contracts`. This module is a thin re-export so existing
// imports from `learning/rl/types.js` keep working while gi-agent
// avoids re-defining the same data shape. New code should import
// directly from `@gi-tcg/ml/contracts`.

export type {
  ActionCandidateFamilyV1,
  ActionCandidateV1,
  ActionRouteV1,
  CandidateRoutingV1,
  CharacterObservationV1,
  CheckpointPromotionInputV1,
  CheckpointPromotionResultV1,
  CostEntryV1,
  DecisionPointExportOptionsV1,
  DecisionPointLogBuildInputV1,
  DecisionPointLogV1,
  DecisionPointV1,
  DerivedObservationFeaturesV1,
  DicePoolObservationV1,
  EntityObservationV1,
  EntityRefV1,
  HandCardObservationV1,
  HandObservationV1,
  ObservationExportOptionsV1,
  ObservationV1,
  ObservationViewKindV1,
  OpponentHiddenEstimateV1,
  PendingMethodV1,
  PlayerObservationV1,
  PublicBoardObservationV1,
  RewardBreakdownV1,
  RewardComputationOptionsV1,
  RewardConfigV1,
  RlDatasetManifestShardEntryV1,
  RlDatasetManifestV1,
  RlDatasetShardV1,
  RlDatasetV1,
  RlDecisionPointSampleV1,
  SelfPlayRlGameCaptureV1,
  SelfPlayRlSideCaptureV1,
  ThresholdFeaturesV1,
  TrainingProtocolV1,
  TrainingUpdateDecisionV1,
  TrainingUpdateProgressV1,
} from "@gi-tcg/ml/contracts"
