// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { flattenNumericRecord } from "../utils/flatten.js"
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { MlValueSample, JsonValue } from "../contracts/index.js"
import type { LinearValueArtifact } from "./artifact.js"
import { predictValueSample } from "./evaluate.js"
import {
  type GbdtValueArtifact,
  type GbdtQValueArtifact,
  type MlpValueArtifact,
  type MoEValueArtifact,
  predictGbdtValue,
  predictMlpValue,
  predictMoEValue,
} from "./nonlinear-artifacts.js"

// ---------------------------------------------------------------------------
// §18.3 P2: Unified Value Predictor
// ---------------------------------------------------------------------------
// 统一线性 / GBDT / MLP / Q-value 价值模型的推理接口，使 GiMlPolicy 可以透明切换。

export type AnyValueArtifact =
  | LinearValueArtifact
  | GbdtValueArtifact
  | GbdtQValueArtifact
  | MlpValueArtifact
  | MoEValueArtifact

/**
 * 统一价值预测：根据 artifact_type 分派到对应推理实现。
 * 注：GbdtQValueArtifact 使用与 GbdtValueArtifact 相同的推理路径，
 * 区别在于 feature_slots 中需含有 action.* 字段（Q-value 调用时已合并）。
 */
export function predictValue(
  artifact: AnyValueArtifact,
  sample: MlValueSample,
): number {
  switch (artifact.artifact_type) {
    case "linear_value_baseline.v1":
      return predictValueSample(artifact, sample)
    case "gbrl_value.v1":  // GBRL artifact without trees — treat as GBDT
    case "gbdt_value.v1":
    case "gbdt_q_value.v1":
      return predictGbdtValue(artifact, flattenSampleToRecord(sample))
    case "mlp_value.v1":
      return predictMlpValue(artifact, flattenSampleToRecord(sample))
    case "moe_value.v1":
      return predictMoEValue(artifact, flattenSampleToRecord(sample))
  }
}

/**
 * Q-value 推理：与 predictValue 相同，但额外接受预先构建好的 action 特征字典。
 * action_features 的 key 会自动加 "action." 前缀以与训练格式一致。
 */
export function predictQValue(
  artifact: GbdtQValueArtifact,
  sample: MlValueSample,
  actionFeatures: Record<string, number>,
): number {
  const stateFeatures = flattenSampleToRecord(sample)
  const prefixedAction: Record<string, number> = {}
  for (const [k, v] of Object.entries(actionFeatures)) {
    prefixedAction[`action.${k}`] = v
  }
  return predictGbdtValue(artifact, { ...stateFeatures, ...prefixedAction })
}

/**
 * 将 MlValueSample 的 feature_slots 拍平为 Record<string, number>，
 * 与 nonlinear-artifacts 中 features 参数对齐。
 */
function flattenSampleToRecord(
  sample: MlValueSample,
): Record<string, number> {
  return flattenNumericRecord(
    (sample.feature_slots ?? {}) as Record<string, JsonValue>,
  )
}

