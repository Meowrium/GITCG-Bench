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

import type { SlotValue } from "../contracts/index.js"

// ---------------------------------------------------------------------------
// P2: Non-linear Model Artifacts (§18.3)
// ---------------------------------------------------------------------------
// 替代 SlotLinearRanker / LinearValueModel 的非线性模型格式。
// "价值函数是平滑基线 + 若干阶跃叠加的混合体" — 线性模型无法捕获阈值跳变。

// ======================== GBDT Value Model ========================

/**
 * GBDT 决策树中的单个节点。
 */
export interface GbdtTreeNode {
  /** 分裂特征名（叶节点为 null） */
  feature: string | null
  /** 分裂阈值（叶节点为 null；分类特征分裂时为 null） */
  threshold: number | null
  /** 左子节点索引（叶节点为 null） */
  left: number | null
  /** 右子节点索引（叶节点为 null） */
  right: number | null
  /** 叶节点预测值（非叶节点为 null） */
  value: number | null
  /** 分类特征分裂集合：特征值 ∈ set → 走左子树（非分类分裂或叶节点为 undefined） */
  categorical_set?: number[] | null
}

/**
 * GBDT 单棵树。
 */
export interface GbdtTree {
  nodes: GbdtTreeNode[]
}

/**
 * GBDT 价值模型 Artifact。
 *
 * 推理: value = bias + learning_rate * sum(tree_predict(tree, features))
 */
export interface GbdtValueArtifact {
  artifact_type: "gbdt_value.v1"
  artifact_version: string
  created_at: string
  bias: number
  learning_rate: number
  trees: GbdtTree[]
  feature_names: string[]
  metadata: {
    dataset_id: string
    sample_count: number
    n_estimators: number
    max_depth: number
    training_mae?: number
    training_rmse?: number
  }
}

/**
 * Q-value artifact: maps (state + action) features → win probability.
 * Structurally identical to GbdtValueArtifact but trained with combined
 * state+action feature vectors (action features under "action.*" keys).
 * At inference, action features are extracted from PolicyCandidateAction.meta_effect_slots.
 */
export interface GbdtQValueArtifact {
  artifact_type: "gbdt_q_value.v1"
  artifact_version: string
  created_at: string
  bias: number
  learning_rate: number
  trees: GbdtTree[]
  feature_names: string[]
  metadata: {
    dataset_id: string
    sample_count: number
    n_estimators: number
    max_depth: number
    training_mae?: number
    training_rmse?: number
  }
}

/**
 * GBDT 单棵树推理。
 */
export function predictGbdtTree(
  tree: GbdtTree,
  features: Record<string, number>,
): number {
  let nodeIdx = 0
  while (nodeIdx < tree.nodes.length) {
    const node = tree.nodes[nodeIdx]
    if (node.value != null) {
      return node.value
    }
    if (node.feature == null) {
      return 0
    }
    const featureValue = features[node.feature] ?? 0
    // Categorical split: value ∈ set → left, else → right
    if (node.categorical_set != null) {
      nodeIdx = node.categorical_set.includes(featureValue)
        ? (node.left ?? nodeIdx + 1)
        : (node.right ?? nodeIdx + 2)
    } else {
      // Numeric split: value <= threshold → left, else → right
      if (node.threshold == null) return 0
      nodeIdx = featureValue <= node.threshold
        ? (node.left ?? nodeIdx + 1)
        : (node.right ?? nodeIdx + 2)
    }
  }
  return 0
}

/**
 * GBDT 完整推理。
 */
export function predictGbdtValue(
  artifact: GbdtValueArtifact | GbdtQValueArtifact,
  features: Record<string, number>,
): number {
  let score = artifact.bias
  for (const tree of artifact.trees) {
    score += artifact.learning_rate * predictGbdtTree(tree, features)
  }
  return clamp01(score)
}

// ======================== MLP Value Model ========================

/**
 * MLP 层：权重矩阵 + 偏置向量 + 激活函数。
 */
export interface MlpLayer {
  /** 权重矩阵 (output_dim × input_dim)，行优先 */
  weights: number[][]
  /** 偏置向量 (output_dim) */
  biases: number[]
  /** 激活函数 */
  activation: "relu" | "sigmoid" | "tanh" | "none"
}

/**
 * 浅层 MLP 价值模型 Artifact。
 *
 * 推理: 逐层 forward pass。
 */
export interface MlpValueArtifact {
  artifact_type: "mlp_value.v1"
  artifact_version: string
  created_at: string
  layers: MlpLayer[]
  feature_names: string[]
  metadata: {
    dataset_id: string
    sample_count: number
    hidden_dims: number[]
    training_mae?: number
    training_rmse?: number
  }
}

/**
 * MLP 完整推理。
 */
export function predictMlpValue(
  artifact: MlpValueArtifact,
  features: Record<string, number>,
): number {
  // 构建输入向量
  let activations = artifact.feature_names.map((name) => features[name] ?? 0)

  for (const layer of artifact.layers) {
    const output: number[] = new Array(layer.biases.length).fill(0)
    for (let i = 0; i < layer.biases.length; i++) {
      let sum = layer.biases[i]
      const row = layer.weights[i]
      for (let j = 0; j < activations.length && j < row.length; j++) {
        sum += row[j] * activations[j]
      }
      output[i] = applyActivation(sum, layer.activation)
    }
    activations = output
  }

  return activations.length > 0 ? clamp01(activations[0]) : 0.5
}

// ======================== GBDT Ranker Model ========================

/**
 * GBDT 排序模型 Artifact。
 *
 * 用于替代 SlotLinearRanker：
 * - 输入: query features + candidate features（concat）
 * - 输出: 排序分数
 */
export interface GbdtRankerArtifact {
  artifact_type: "gbdt_ranker.v1"
  artifact_version: string
  created_at: string
  bias: number
  learning_rate: number
  trees: GbdtTree[]
  query_feature_names: string[]
  candidate_feature_names: string[]
  metadata: {
    dataset_id: string
    sample_count: number
    n_estimators: number
    max_depth: number
    ndcg_at_1?: number
    ndcg_at_3?: number
  }
}

/**
 * GBDT Ranker 推理。
 */
export function predictGbdtRankerScore(
  artifact: GbdtRankerArtifact,
  queryFeatures: Record<string, number>,
  candidateFeatures: Record<string, number>,
): number {
  const combined: Record<string, number> = {}
  for (const name of artifact.query_feature_names) {
    combined[`q:${name}`] = queryFeatures[name] ?? 0
  }
  for (const name of artifact.candidate_feature_names) {
    combined[`c:${name}`] = candidateFeatures[name] ?? 0
  }
  let score = artifact.bias
  for (const tree of artifact.trees) {
    score += artifact.learning_rate * predictGbdtTree(tree, combined)
  }
  return score
}

// ======================== Helpers ========================

function applyActivation(x: number, activation: MlpLayer["activation"]): number {
  switch (activation) {
    case "relu":
      return Math.max(0, x)
    case "sigmoid":
      return 1 / (1 + Math.exp(-clamp(x, -20, 20)))
    case "tanh":
      return Math.tanh(x)
    case "none":
      return x
  }
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x))
}

function clamp01(x: number): number {
  return clamp(x, 0, 1)
}

// ======================== MoE (Mixture of Experts) Value Model ========================

/**
 * Single expert within a MoE ensemble.
 */
export interface MoEExpert {
  name: string
  model: GbdtValueArtifact | null
  sample_count: number
}

/**
 * MoE (Mixture of Experts) GBDT Value Artifact.
 *
 * Contains multiple specialized GBDT models (experts) and a baseline.
 * At inference: select the matching expert based on gating rules,
 * falling back to the baseline model if no expert matches or expert is not trained.
 */
export interface MoEValueArtifact {
  artifact_type: "moe_value.v1"
  artifact_version: string
  created_at: string
  experts: MoEExpert[]
  baseline_model: GbdtValueArtifact
  expert_names: string[]
  metadata: {
    dataset_id: string
    sample_count: number
    expert_counts: number[]
    baseline_mae: number
    baseline_rmse: number
    expert_maes: (number | null)[]
    n_estimators: number
    max_depth: number
  }
}

/**
 * Assign game state features to an expert index.
 * Mirrors the Python assign_expert() logic.
 */
export function assignMoEExpert(features: Record<string, number>): number {
  const selfHp = features["self.active_health"] ?? 10
  const selfAlive = features["self.alive_count"] ?? 3
  const selfEnergyFull = features["self_active.energy_full"] ?? 0
  const oppHp = features["opponent.active_health"] ?? 10
  const roundNum = features["round"] ?? 1
  const selfSupport = features["self.support_count"] ?? 0
  const selfSummon = features["self.summon_count"] ?? 0
  const selfTotalEnergy = features["self.total_energy"] ?? 0
  const canBurst = features["self.can_afford_burst"] ?? 1

  // Survival: low health or missing character
  if (selfHp <= 5 || selfAlive < 3) {
    return 0  // survival
  }

  // Burst: energy full, can afford burst, and opponent has HP to target
  if (selfEnergyFull >= 0.5 && oppHp > 0 && selfTotalEnergy >= 2 && canBurst >= 0.5) {
    return 1  // burst
  }

  // Setup: early game or undeveloped board
  if (roundNum <= 2 || (selfSupport + selfSummon < 2 && selfEnergyFull < 0.5)) {
    return 2  // setup
  }

  // Neutral: everything else
  return 3
}

/**
 * MoE 完整推理。
 */
export function predictMoEValue(
  artifact: MoEValueArtifact,
  features: Record<string, number>,
): number {
  const expertIdx = assignMoEExpert(features)

  // Try to use the matching expert
  if (expertIdx < artifact.experts.length) {
    const expert = artifact.experts[expertIdx]
    if (expert.model != null) {
      return predictGbdtValue(expert.model, features)
    }
  }

  // Fallback to baseline model
  return predictGbdtValue(artifact.baseline_model, features)
}

