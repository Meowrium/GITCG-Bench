// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type {
  MlCandidateAction,
  MlConceptBank,
  MlCompatibilityInfo,
  MlDecisionPoint,
  SlotValue,
} from "../contracts/index.js"
import type { ModelObservationV1 } from "./types.js"
import { buildObservationValueFeatureSlots } from "../datasets/rl-value.js"
import { readJsonFile } from "../io/index.js"
import {
  readSlotLinearRankerArtifact,
  SlotLinearRanker,
  type ActionRanker,
  type RankResult,
  type SlotLinearRankerArtifact,
} from "../ranker/index.js"
import {
  LinearConceptModelPredictor,
  readLinearConceptModelArtifact,
} from "./concept-model.js"
import {
  predictValueSample,
  readLinearValueArtifact,
  type LinearValueArtifact,
} from "../value/index.js"
import type {
  RuntimeConceptState,
  RuntimeConceptValue,
  RuntimeModelManifest,
} from "./types.js"

export interface RuntimeInferenceRequest {
  query: MlDecisionPoint
  candidates: MlCandidateAction[]
  concept_state?: RuntimeConceptState | null
  rank_slots?: SlotValue
}

export interface RuntimeConceptStateResult {
  query_id?: string | null
  values: RuntimeConceptValue[]
  summary_slots?: SlotValue
}

export interface RuntimeRankResult extends RankResult {
  concept_state: RuntimeConceptStateResult
  manifest: RuntimeModelManifest
}

export interface RuntimeValueResult {
  predicted_value: number
  summary_slots: SlotValue
}

export interface GiMlRuntimeBridgeOptions {
  conceptBank: MlConceptBank | null
  ranker: ActionRanker
  /** Optional second ranker (e.g. GBDT) for dual-ranking and disagreement computation. */
  ranker2?: ActionRanker | null
  manifest: RuntimeModelManifest
  conceptModel?: LinearConceptModelPredictor | null
  valueArtifact?: LinearValueArtifact | null
}

export interface LoadRuntimeBridgeOptions {
  conceptBankPath?: string | null
  rankerArtifactPath: string
  conceptModelPath?: string | null
  valueArtifactPath?: string | null
}

export class GiMlRuntimeBridge {
  readonly conceptBank: MlConceptBank | null
  readonly ranker: ActionRanker
  readonly ranker2: ActionRanker | null
  readonly manifest: RuntimeModelManifest
  readonly conceptModel: LinearConceptModelPredictor | null
  readonly valueArtifact: LinearValueArtifact | null

  constructor(options: GiMlRuntimeBridgeOptions) {
    this.conceptBank = options.conceptBank
    this.ranker = options.ranker
    this.ranker2 = options.ranker2 ?? null
    this.manifest = options.manifest
    this.conceptModel = options.conceptModel ?? null
    this.valueArtifact = options.valueArtifact ?? null
  }

  static async load(options: LoadRuntimeBridgeOptions): Promise<GiMlRuntimeBridge> {
    const [conceptBank, artifact, conceptModelArtifact, valueArtifact] = await Promise.all([
      options.conceptBankPath
        ? readJsonFile<MlConceptBank>(options.conceptBankPath)
        : Promise.resolve(null),
      readSlotLinearRankerArtifact(options.rankerArtifactPath),
      options.conceptModelPath
        ? readLinearConceptModelArtifact(options.conceptModelPath)
        : Promise.resolve(null),
      options.valueArtifactPath
        ? readLinearValueArtifact(options.valueArtifactPath)
        : Promise.resolve(null),
    ])

    return fromArtifactAndBank(
      artifact,
      conceptBank,
      conceptModelArtifact ? new LinearConceptModelPredictor(conceptModelArtifact) : null,
      valueArtifact,
    )
  }

  async evaluateConceptState(
    query: MlDecisionPoint,
    conceptState?: RuntimeConceptState | null,
    candidates: readonly MlCandidateAction[] = [],
  ): Promise<RuntimeConceptStateResult> {
    const predicted = conceptState ?? this.conceptModel?.predict(query, candidates) ?? null
    return normalizeConceptState(this.conceptBank, query, predicted)
  }

  async rankActions(request: RuntimeInferenceRequest): Promise<RuntimeRankResult> {
    const conceptState = await this.evaluateConceptState(
      request.query,
      request.concept_state ?? null,
      request.candidates,
    )
    const result = await this.ranker.rank({
      query: request.query,
      candidates: request.candidates,
      concept_state: {
        query_id: conceptState.query_id ?? request.query.query_id,
        values: conceptState.values,
        summary_slots: conceptState.summary_slots ?? null,
      },
      rank_slots: request.rank_slots,
    })

    return {
      ...result,
      concept_state: conceptState,
      manifest: this.manifest,
    }
  }

  predictObservationValue(observation: ModelObservationV1): RuntimeValueResult | null {
    if (!this.valueArtifact) {
      return null
    }
    const featureSlots = buildObservationValueFeatureSlots(observation as any)
    const predictedValue = predictValueSample(this.valueArtifact, {
      sample_id: observation.point.decision_point_id,
      source: "self_play",
      state_ref: observation.point.decision_point_id,
      target_value: 0.5,
      feature_slots: featureSlots,
    })
    return {
      predicted_value: predictedValue,
      summary_slots: {
        artifact_version: this.valueArtifact.artifact_version,
        round: observation.point.round_number,
        phase: observation.point.phase,
        pending_method: observation.point.pending_method,
      },
    }
  }
}

export function fromArtifactAndBank(
  artifact: SlotLinearRankerArtifact,
  conceptBank: MlConceptBank | null,
  conceptModel: LinearConceptModelPredictor | null = null,
  valueArtifact: LinearValueArtifact | null = null,
): GiMlRuntimeBridge {
  return new GiMlRuntimeBridge({
    conceptBank,
    ranker: new SlotLinearRanker(artifact),
    conceptModel,
    valueArtifact,
    manifest: {
      artifact_version: artifact.artifact_version,
      concept_bank_version: conceptBank?.bank_version ?? null,
      concept_model_ref: conceptModel?.artifact.artifact_version ?? null,
      ranker_model_ref: artifact.artifact_type,
      value_model_ref: valueArtifact?.artifact_version ?? null,
      compatibility: mergeCompatibility(artifact.compatibility ?? null, conceptBank?.compatibility ?? null),
    },
  })
}

function normalizeConceptState(
  conceptBank: MlConceptBank | null,
  query: MlDecisionPoint,
  conceptState: RuntimeConceptState | null,
): RuntimeConceptStateResult {
  const bankConcepts = new Map(
    (conceptBank?.concepts ?? [])
      .filter((concept) => concept.status !== "deprecated")
      .map((concept) => [concept.concept_id, concept]),
  )
  const rawValues = conceptState?.values ?? []
  const values: RuntimeConceptValue[] = []
  const unsupportedConceptIds: string[] = []

  for (const value of rawValues) {
    const concept = bankConcepts.get(value.concept_id)
    if (!concept && conceptBank) {
      unsupportedConceptIds.push(value.concept_id)
      continue
    }
    values.push({
      concept_id: value.concept_id,
      value_slot: value.value_slot ?? null,
      confidence: value.confidence ?? null,
      evidence_refs: dedupeStrings([
        ...(value.evidence_refs ?? []),
        ...(concept?.evidence_refs ?? []),
      ]),
    })
  }

  values.sort((left, right) => left.concept_id.localeCompare(right.concept_id))
  const bankConceptIds = [...bankConcepts.keys()].sort()
  const activeConceptIds = new Set(values.map((value) => value.concept_id))
  const missingConceptIds = bankConceptIds.filter((conceptId) => !activeConceptIds.has(conceptId))
  const activeComboConceptIds = values
    .map((value) => value.concept_id)
    .filter((conceptId) => isComboConcept(bankConcepts.get(conceptId)))
    .sort()
  const missingComboConceptIds = missingConceptIds
    .filter((conceptId) => isComboConcept(bankConcepts.get(conceptId)))
    .sort()

  return {
    query_id: conceptState?.query_id ?? query.query_id,
    values,
    summary_slots: {
      query_id: query.query_id,
      concept_bank_version: conceptBank?.bank_version ?? null,
      active_concept_count: values.length,
      active_combo_concept_ids: activeComboConceptIds,
      missing_concept_ids: missingConceptIds,
      missing_combo_concept_ids: missingComboConceptIds,
      unsupported_concept_ids: unsupportedConceptIds.sort(),
    },
  }
}

function mergeCompatibility(
  ...items: Array<MlCompatibilityInfo | null | undefined>
): SlotValue {
  const merged: Record<string, string> = {}

  for (const item of items) {
    if (!item) {
      continue
    }
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === "string") {
        merged[key] = value
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

function dedupeStrings(items: readonly string[]): string[] {
  return [...new Set(items)].sort()
}

function isComboConcept(concept: MlConceptBank["concepts"][number] | undefined): boolean {
  if (!concept) {
    return false
  }
  if (concept.scope === "aggregate_candidate") {
    return true
  }
  const tags = concept.tags ?? []
  return tags.includes("combat_window_combo") || tags.includes("combo_pattern")
}
