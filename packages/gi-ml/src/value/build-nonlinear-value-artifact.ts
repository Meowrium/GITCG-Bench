import { flattenNumericRecord } from "../utils/flatten.js"
// Copyright (C) 2024-2025 Guyutongxue
//
// ⚠️  EXPERIMENTAL / FALLBACK: Pure-JS GBDT + MLP trainers.
//     Not used in the production pipeline (Python LightGBM is preferred).
//     Performance is orders of magnitude slower than native C++ implementations.
//     Kept for local experimentation only.
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

import type { JsonValue, MlValueDataset, MlValueSample } from "../contracts/index.js"
import type {
  GbdtValueArtifact,
  GbdtTree,
  GbdtTreeNode,
  MlpValueArtifact,
  MlpLayer,
} from "./nonlinear-artifacts.js"
import { predictGbdtValue, predictMlpValue } from "./nonlinear-artifacts.js"

// ---------------------------------------------------------------------------
// §18 P2: GBDT / MLP Value Model Trainers
// ---------------------------------------------------------------------------

export interface BuildGbdtValueArtifactOptions {
  artifactVersion?: string
  nEstimators?: number
  maxDepth?: number
  learningRate?: number
  minSamplesLeaf?: number
  subsampleRate?: number
  topFeatureCount?: number
}

export interface BuildMlpValueArtifactOptions {
  artifactVersion?: string
  hiddenDims?: number[]
  learningRate?: number
  epochs?: number
  batchSize?: number
  topFeatureCount?: number
}

// ======================== GBDT Value Trainer ========================

export function buildGbdtValueArtifactFromDataset(
  dataset: MlValueDataset,
  options: BuildGbdtValueArtifactOptions = {},
): GbdtValueArtifact {
  const nEstimators = options.nEstimators ?? 60
  const maxDepth = options.maxDepth ?? 4
  const learningRate = options.learningRate ?? 0.1
  const minSamplesLeaf = options.minSamplesLeaf ?? 8
  const subsampleRate = options.subsampleRate ?? 0.8
  const topFeatureCount = options.topFeatureCount ?? 48

  // 1. Flatten features and collect feature names
  const { matrix, featureNames, targets, weights } = prepareValueDataMatrix(
    dataset,
    topFeatureCount,
  )

  // 2. Compute initial bias (weighted mean of targets)
  const bias = weightedMean(targets, weights)

  // 3. Initialize residuals
  const residuals = targets.map((t) => t - bias)

  // 4. Build trees greedily
  const trees: GbdtTree[] = []
  for (let iter = 0; iter < nEstimators; iter++) {
    // Subsample
    const indices = subsample(matrix.length, subsampleRate)

    // Fit a regression tree to residuals
    const tree = fitRegressionTree(
      matrix,
      residuals,
      weights,
      featureNames,
      indices,
      maxDepth,
      minSamplesLeaf,
    )
    trees.push(tree)

    // Update residuals
    for (let i = 0; i < matrix.length; i++) {
      const prediction = predictTreeFromRow(tree, matrix[i], featureNames)
      residuals[i] -= learningRate * prediction
    }
  }

  // 5. Compute training metrics
  const trainingPredictions = matrix.map((row) => {
    const features = rowToFeatureMap(row, featureNames)
    return predictGbdtValue(
      { bias, learning_rate: learningRate, trees, feature_names: featureNames } as GbdtValueArtifact,
      features,
    )
  })
  const trainingMae = meanAbsoluteError(targets, trainingPredictions, weights)
  const trainingRmse = rootMeanSquaredError(targets, trainingPredictions, weights)

  return {
    artifact_type: "gbdt_value.v1",
    artifact_version: options.artifactVersion ?? `gbdt_${dataset.dataset_id}`,
    created_at: new Date().toISOString(),
    bias,
    learning_rate: learningRate,
    trees,
    feature_names: featureNames,
    metadata: {
      dataset_id: dataset.dataset_id,
      sample_count: dataset.samples.length,
      n_estimators: nEstimators,
      max_depth: maxDepth,
      training_mae: trainingMae,
      training_rmse: trainingRmse,
    },
  }
}

// ======================== MLP Value Trainer ========================

export function buildMlpValueArtifactFromDataset(
  dataset: MlValueDataset,
  options: BuildMlpValueArtifactOptions = {},
): MlpValueArtifact {
  const hiddenDims = options.hiddenDims ?? [32, 16]
  const lr = options.learningRate ?? 0.001
  const epochs = options.epochs ?? 80
  const batchSize = options.batchSize ?? 64
  const topFeatureCount = options.topFeatureCount ?? 48

  // 1. Prepare data
  const { matrix, featureNames, targets, weights } = prepareValueDataMatrix(
    dataset,
    topFeatureCount,
  )

  // 2. Normalize features (z-score)
  const { normalized, means, stds } = zScoreNormalize(matrix)

  // 3. Build layer dimensions
  const dims = [featureNames.length, ...hiddenDims, 1]
  const layers = initializeLayers(dims)

  // 4. Train with mini-batch SGD
  const n = normalized.length
  for (let epoch = 0; epoch < epochs; epoch++) {
    const perm = shuffleIndices(n)
    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(start + batchSize, n)
      const batchIndices = perm.slice(start, end)
      sgdStep(layers, normalized, targets, weights, batchIndices, lr)
    }
  }

  // 5. Convert to artifact layers (bake normalization into first layer)
  const artifactLayers = bakeNormalization(layers, means, stds, dims)

  // 6. Compute training metrics
  const trainingPredictions = matrix.map((row) => {
    const features = rowToFeatureMap(row, featureNames)
    return predictMlpValue(
      { layers: artifactLayers, feature_names: featureNames } as MlpValueArtifact,
      features,
    )
  })
  const trainingMae = meanAbsoluteError(targets, trainingPredictions, weights)
  const trainingRmse = rootMeanSquaredError(targets, trainingPredictions, weights)

  return {
    artifact_type: "mlp_value.v1",
    artifact_version: options.artifactVersion ?? `mlp_${dataset.dataset_id}`,
    created_at: new Date().toISOString(),
    layers: artifactLayers,
    feature_names: featureNames,
    metadata: {
      dataset_id: dataset.dataset_id,
      sample_count: dataset.samples.length,
      hidden_dims: hiddenDims,
      training_mae: trainingMae,
      training_rmse: trainingRmse,
    },
  }
}

// ======================== Data Preparation ========================

interface ValueDataMatrix {
  matrix: number[][]
  featureNames: string[]
  targets: number[]
  weights: number[]
}

function prepareValueDataMatrix(
  dataset: MlValueDataset,
  topFeatureCount: number,
): ValueDataMatrix {
  // Collect all feature paths and compute variance
  const featureVariance = new Map<string, { sum: number; sumSq: number; count: number }>()

  const flattenedSamples: Record<string, number>[] = []
  for (const sample of dataset.samples) {
    const flattened = flattenNumericRecord(
      (sample.feature_slots ?? {}) as Record<string, JsonValue>,
    )
    flattenedSamples.push(flattened)
    for (const [path, value] of Object.entries(flattened)) {
      const entry = featureVariance.get(path) ?? { sum: 0, sumSq: 0, count: 0 }
      entry.sum += value
      entry.sumSq += value * value
      entry.count += 1
      featureVariance.set(path, entry)
    }
  }

  // Select top features by variance
  const featureNames = [...featureVariance.entries()]
    .map(([path, stat]) => {
      const mean = stat.sum / stat.count
      const variance = stat.sumSq / stat.count - mean * mean
      return { path, variance, count: stat.count }
    })
    .filter((f) => f.variance > 1e-10 && f.count >= 5)
    .sort((a, b) => b.variance - a.variance || b.count - a.count)
    .slice(0, topFeatureCount)
    .map((f) => f.path)

  // Build matrix
  const matrix: number[][] = []
  const targets: number[] = []
  const weights: number[] = []
  for (let i = 0; i < dataset.samples.length; i++) {
    const sample = dataset.samples[i]
    const flat = flattenedSamples[i]
    const row = featureNames.map((name) => flat[name] ?? 0)
    matrix.push(row)
    targets.push(sample.target_value)
    weights.push(sample.weight ?? 1)
  }

  return { matrix, featureNames, targets, weights }
}

// ======================== GBDT Internals ========================

interface SplitResult {
  featureIdx: number
  threshold: number
  leftIndices: number[]
  rightIndices: number[]
  gain: number
}

function fitRegressionTree(
  matrix: number[][],
  residuals: number[],
  weights: number[],
  featureNames: string[],
  sampleIndices: number[],
  maxDepth: number,
  minSamplesLeaf: number,
): GbdtTree {
  const nodes: GbdtTreeNode[] = []

  function buildNode(indices: number[], depth: number): number {
    const nodeIdx = nodes.length
    nodes.push({ feature: null, threshold: null, left: null, right: null, value: null })

    // Leaf conditions
    if (depth >= maxDepth || indices.length < minSamplesLeaf * 2) {
      nodes[nodeIdx].value = weightedMean(
        indices.map((i) => residuals[i]),
        indices.map((i) => weights[i]),
      )
      return nodeIdx
    }

    // Find best split
    const split = findBestSplit(matrix, residuals, weights, featureNames, indices, minSamplesLeaf)
    if (!split || split.gain <= 0) {
      nodes[nodeIdx].value = weightedMean(
        indices.map((i) => residuals[i]),
        indices.map((i) => weights[i]),
      )
      return nodeIdx
    }

    nodes[nodeIdx].feature = featureNames[split.featureIdx]
    nodes[nodeIdx].threshold = split.threshold
    const leftIdx = buildNode(split.leftIndices, depth + 1)
    const rightIdx = buildNode(split.rightIndices, depth + 1)
    nodes[nodeIdx].left = leftIdx
    nodes[nodeIdx].right = rightIdx
    return nodeIdx
  }

  buildNode(sampleIndices, 0)
  return { nodes }
}

function findBestSplit(
  matrix: number[][],
  residuals: number[],
  weights: number[],
  featureNames: string[],
  indices: number[],
  minSamplesLeaf: number,
): SplitResult | null {
  let bestSplit: SplitResult | null = null
  let bestGain = 0

  // Parent SSE
  const parentStats = computeStats(
    indices.map((i) => residuals[i]),
    indices.map((i) => weights[i]),
  )

  // Randomly sample a subset of features for each split (like random forests)
  const featureSubset = sampleFeatureIndices(
    featureNames.length,
    Math.max(3, Math.floor(Math.sqrt(featureNames.length))),
  )

  for (const fIdx of featureSubset) {
    // Sort indices by feature value
    const sorted = indices
      .map((i) => ({ idx: i, value: matrix[i][fIdx] }))
      .sort((a, b) => a.value - b.value)

    // Scan thresholds
    let leftSum = 0
    let leftWeightSum = 0
    let leftSumSq = 0
    let leftCount = 0
    let rightSum = parentStats.sum
    let rightWeightSum = parentStats.weightSum
    let rightSumSq = parentStats.sumSq
    let rightCount = indices.length

    for (let k = 0; k < sorted.length - 1; k++) {
      const i = sorted[k].idx
      const r = residuals[i]
      const w = weights[i]
      leftSum += r * w
      leftWeightSum += w
      leftSumSq += r * r * w
      leftCount++
      rightSum -= r * w
      rightWeightSum -= w
      rightSumSq -= r * r * w
      rightCount--

      // Skip if same feature value as next
      if (sorted[k].value === sorted[k + 1].value) {
        continue
      }
      // Min leaf size
      if (leftCount < minSamplesLeaf || rightCount < minSamplesLeaf) {
        continue
      }

      // Compute variance reduction (SSE reduction)
      const leftMean = leftWeightSum > 0 ? leftSum / leftWeightSum : 0
      const rightMean = rightWeightSum > 0 ? rightSum / rightWeightSum : 0
      const leftSSE = leftSumSq - leftMean * leftMean * leftWeightSum
      const rightSSE = rightSumSq - rightMean * rightMean * rightWeightSum
      const gain = parentStats.sse - leftSSE - rightSSE

      if (gain > bestGain) {
        const threshold = (sorted[k].value + sorted[k + 1].value) / 2
        bestGain = gain
        bestSplit = {
          featureIdx: fIdx,
          threshold,
          leftIndices: sorted.slice(0, k + 1).map((s) => s.idx),
          rightIndices: sorted.slice(k + 1).map((s) => s.idx),
          gain,
        }
      }
    }
  }

  return bestSplit
}

function computeStats(values: number[], weights: number[]) {
  let sum = 0
  let weightSum = 0
  let sumSq = 0
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]
    sum += values[i] * w
    weightSum += w
    sumSq += values[i] * values[i] * w
  }
  const mean = weightSum > 0 ? sum / weightSum : 0
  const sse = sumSq - mean * mean * weightSum
  return { sum, weightSum, sumSq, mean, sse }
}

function predictTreeFromRow(
  tree: GbdtTree,
  row: number[],
  featureNames: string[],
): number {
  const features = rowToFeatureMap(row, featureNames)
  let nodeIdx = 0
  while (nodeIdx < tree.nodes.length) {
    const node = tree.nodes[nodeIdx]
    if (node.value != null) {
      return node.value
    }
    if (node.feature == null || node.threshold == null) {
      return 0
    }
    const featureValue = features[node.feature] ?? 0
    nodeIdx = featureValue <= node.threshold
      ? (node.left ?? nodeIdx + 1)
      : (node.right ?? nodeIdx + 2)
  }
  return 0
}

// ======================== MLP Internals ========================

interface TrainableLayer {
  weights: number[][]
  biases: number[]
  activation: MlpLayer["activation"]
}

function initializeLayers(dims: number[]): TrainableLayer[] {
  const layers: TrainableLayer[] = []
  for (let l = 0; l < dims.length - 1; l++) {
    const inDim = dims[l]
    const outDim = dims[l + 1]
    const isLast = l === dims.length - 2
    // He initialization
    const scale = Math.sqrt(2 / inDim)
    const weights: number[][] = []
    for (let i = 0; i < outDim; i++) {
      const row: number[] = []
      for (let j = 0; j < inDim; j++) {
        row.push(gaussianRandom() * scale)
      }
      weights.push(row)
    }
    layers.push({
      weights,
      biases: new Array(outDim).fill(0),
      activation: isLast ? "sigmoid" : "relu",
    })
  }
  return layers
}

function sgdStep(
  layers: TrainableLayer[],
  matrix: number[][],
  targets: number[],
  weights: number[],
  batchIndices: number[],
  lr: number,
): void {
  const batchSize = batchIndices.length
  if (batchSize === 0) return

  // Accumulate gradients
  const gradWeights: number[][][] = layers.map((l) =>
    l.weights.map((row) => new Array(row.length).fill(0)),
  )
  const gradBiases: number[][] = layers.map((l) => new Array(l.biases.length).fill(0))

  for (const idx of batchIndices) {
    const input = matrix[idx]
    const target = targets[idx]
    const w = weights[idx]

    // Forward pass (save activations)
    const activations: number[][] = [input]
    const preActivations: number[][] = []
    let current = input
    for (const layer of layers) {
      const pre: number[] = new Array(layer.biases.length)
      const post: number[] = new Array(layer.biases.length)
      for (let i = 0; i < layer.biases.length; i++) {
        let sum = layer.biases[i]
        for (let j = 0; j < current.length; j++) {
          sum += layer.weights[i][j] * current[j]
        }
        pre[i] = sum
        post[i] = applyActivation(sum, layer.activation)
      }
      preActivations.push(pre)
      activations.push(post)
      current = post
    }

    // Backward pass
    const predicted = current[0]
    let delta = [2 * (predicted - target) * w] // MSE gradient

    for (let l = layers.length - 1; l >= 0; l--) {
      const layerActivations = activations[l]
      const layerPre = preActivations[l]
      const layer = layers[l]

      // Apply activation derivative
      const localDelta = delta.map((d, i) =>
        d * activationDerivative(layerPre[i], layer.activation),
      )

      // Accumulate weight gradients
      for (let i = 0; i < localDelta.length; i++) {
        gradBiases[l][i] += localDelta[i]
        for (let j = 0; j < layerActivations.length; j++) {
          gradWeights[l][i][j] += localDelta[i] * layerActivations[j]
        }
      }

      // Propagate delta to previous layer
      if (l > 0) {
        const newDelta = new Array(layer.weights[0].length).fill(0)
        for (let i = 0; i < localDelta.length; i++) {
          for (let j = 0; j < layer.weights[i].length; j++) {
            newDelta[j] += localDelta[i] * layer.weights[i][j]
          }
        }
        delta = newDelta
      }
    }
  }

  // Update weights
  const scale = lr / batchSize
  for (let l = 0; l < layers.length; l++) {
    for (let i = 0; i < layers[l].biases.length; i++) {
      layers[l].biases[i] -= scale * gradBiases[l][i]
      for (let j = 0; j < layers[l].weights[i].length; j++) {
        layers[l].weights[i][j] -= scale * gradWeights[l][i][j]
      }
    }
  }
}

function bakeNormalization(
  layers: TrainableLayer[],
  means: number[],
  stds: number[],
  dims: number[],
): MlpLayer[] {
  // Bake z-score normalization into the first layer's weights and biases
  // normalized = (x - mean) / std
  // W_baked[i][j] = W[i][j] / std[j]
  // b_baked[i] = b[i] - sum_j(W[i][j] * mean[j] / std[j])
  const firstLayer = layers[0]
  const bakedWeights: number[][] = []
  const bakedBiases: number[] = []
  for (let i = 0; i < firstLayer.weights.length; i++) {
    const row: number[] = []
    let biasAdj = firstLayer.biases[i]
    for (let j = 0; j < firstLayer.weights[i].length; j++) {
      const s = stds[j] > 1e-10 ? stds[j] : 1
      row.push(firstLayer.weights[i][j] / s)
      biasAdj -= firstLayer.weights[i][j] * means[j] / s
    }
    bakedWeights.push(row)
    bakedBiases.push(biasAdj)
  }

  const result: MlpLayer[] = [
    {
      weights: bakedWeights,
      biases: bakedBiases,
      activation: firstLayer.activation,
    },
  ]

  for (let l = 1; l < layers.length; l++) {
    result.push({
      weights: layers[l].weights.map((row) => [...row]),
      biases: [...layers[l].biases],
      activation: layers[l].activation,
    })
  }
  return result
}

// ======================== Shared Utilities ========================


function rowToFeatureMap(row: number[], featureNames: string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (let i = 0; i < featureNames.length; i++) {
    result[featureNames[i]] = row[i]
  }
  return result
}

function weightedMean(values: number[], weights: number[]): number {
  let sum = 0
  let wSum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * weights[i]
    wSum += weights[i]
  }
  return wSum > 0 ? sum / wSum : 0
}

function meanAbsoluteError(
  targets: number[],
  predictions: number[],
  weights: number[],
): number {
  let sum = 0
  let wSum = 0
  for (let i = 0; i < targets.length; i++) {
    sum += Math.abs(targets[i] - predictions[i]) * weights[i]
    wSum += weights[i]
  }
  return wSum > 0 ? sum / wSum : 0
}

function rootMeanSquaredError(
  targets: number[],
  predictions: number[],
  weights: number[],
): number {
  let sum = 0
  let wSum = 0
  for (let i = 0; i < targets.length; i++) {
    const diff = targets[i] - predictions[i]
    sum += diff * diff * weights[i]
    wSum += weights[i]
  }
  return wSum > 0 ? Math.sqrt(sum / wSum) : 0
}

function zScoreNormalize(matrix: number[][]): {
  normalized: number[][]
  means: number[]
  stds: number[]
} {
  if (matrix.length === 0) {
    return { normalized: [], means: [], stds: [] }
  }
  const nFeatures = matrix[0].length
  const means = new Array(nFeatures).fill(0)
  const stds = new Array(nFeatures).fill(0)

  for (const row of matrix) {
    for (let j = 0; j < nFeatures; j++) {
      means[j] += row[j]
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    means[j] /= matrix.length
  }

  for (const row of matrix) {
    for (let j = 0; j < nFeatures; j++) {
      const diff = row[j] - means[j]
      stds[j] += diff * diff
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    stds[j] = Math.sqrt(stds[j] / matrix.length)
  }

  const normalized = matrix.map((row) =>
    row.map((v, j) => (stds[j] > 1e-10 ? (v - means[j]) / stds[j] : 0)),
  )
  return { normalized, means, stds }
}

function subsample(n: number, rate: number): number[] {
  if (rate >= 1) {
    return Array.from({ length: n }, (_, i) => i)
  }
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    if (Math.random() < rate) {
      indices.push(i)
    }
  }
  return indices.length > 0 ? indices : [Math.floor(Math.random() * n)]
}

function sampleFeatureIndices(total: number, count: number): number[] {
  if (count >= total) {
    return Array.from({ length: total }, (_, i) => i)
  }
  const indices = new Set<number>()
  while (indices.size < count) {
    indices.add(Math.floor(Math.random() * total))
  }
  return [...indices]
}

function shuffleIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

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

function activationDerivative(x: number, activation: MlpLayer["activation"]): number {
  switch (activation) {
    case "relu":
      return x > 0 ? 1 : 0
    case "sigmoid": {
      const s = 1 / (1 + Math.exp(-clamp(x, -20, 20)))
      return s * (1 - s)
    }
    case "tanh": {
      const t = Math.tanh(x)
      return 1 - t * t
    }
    case "none":
      return 1
  }
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x))
}

// Box-Muller transform for Gaussian random numbers
let spareGaussian: number | null = null
function gaussianRandom(): number {
  if (spareGaussian != null) {
    const val = spareGaussian
    spareGaussian = null
    return val
  }
  let u: number, v: number, s: number
  do {
    u = Math.random() * 2 - 1
    v = Math.random() * 2 - 1
    s = u * u + v * v
  } while (s >= 1 || s === 0)
  const mul = Math.sqrt(-2 * Math.log(s) / s)
  spareGaussian = v * mul
  return u * mul
}
