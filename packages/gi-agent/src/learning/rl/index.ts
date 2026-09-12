// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

export type {
  ActionCandidateFamilyV1,
  ActionCandidateV1,
  ActionRouteV1,
  CandidateRoutingV1,
  CharacterObservationV1,
  CheckpointPromotionInputV1,
  CheckpointPromotionResultV1,
  DecisionPointExportOptionsV1,
  DecisionPointLogBuildInputV1,
  DecisionPointLogV1,
  DecisionPointV1,
  DerivedObservationFeaturesV1,
  DicePoolObservationV1,
  EntityObservationV1,
  EntityRefV1,
  HandCardObservationV1,
  ObservationExportOptionsV1,
  ObservationV1,
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
  TrainingProtocolV1,
  TrainingUpdateDecisionV1,
  TrainingUpdateProgressV1,
} from "./types.js"

export {
  buildObservationV1FromGameState,
  buildObservationV1FromVisibleState,
  buildDerivedFeatures,
} from "./observation-exporter.js"
export {
  buildDecisionPointV1FromActionInfos,
  buildDecisionPointV1FromRpcRequest,
} from "./candidate-exporter.js"
export {
  DEFAULT_REWARD_CONFIG_V1,
  createDefaultRewardConfigV1,
  computeRewardBreakdownV1,
} from "./reward-config.js"
export {
  DEFAULT_TRAINING_PROTOCOL_V1,
  createDefaultTrainingProtocolV1,
  shouldRunTrainingUpdateV1,
  evaluateCheckpointPromotionV1,
  buildDecisionPointLogV1,
} from "./training-protocol.js"
export {
  SelfPlayRlRecorder,
  type SelfPlayRlRecorderOptions,
  type SelfPlayRlSelectionInput,
} from "./self-play-recorder.js"
export {
  exportRlDatasetSamplesFromCapture,
  exportRlDatasetShardsV1,
  exportRlDatasetV1,
  type ExportRlDatasetOptionsV1,
  type ExportRlDatasetShardsOptionsV1,
  type ExportedRlDatasetShardsV1,
} from "./export-dataset.js"
