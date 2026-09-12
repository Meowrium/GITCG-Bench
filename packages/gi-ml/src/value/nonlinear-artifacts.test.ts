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

import { describe, test, expect } from "vitest"
import {
  predictGbdtTree,
  predictGbdtValue,
  predictMlpValue,
  predictGbdtRankerScore,
  type GbdtValueArtifact,
  type GbdtTree,
  type MlpValueArtifact,
  type GbdtRankerArtifact,
} from "./nonlinear-artifacts.js"

// ======================== GBDT Tree ========================
describe("predictGbdtTree", () => {
  const simpleTree: GbdtTree = {
    nodes: [
      // node 0: split on "hp" <= 5 → left=1, right=2
      { feature: "hp", threshold: 5, left: 1, right: 2, value: null },
      // node 1: leaf → 0.2
      { feature: null, threshold: null, left: null, right: null, value: 0.2 },
      // node 2: leaf → 0.8
      { feature: null, threshold: null, left: null, right: null, value: 0.8 },
    ],
  }

  test("goes left when feature <= threshold", () => {
    expect(predictGbdtTree(simpleTree, { hp: 3 })).toBe(0.2)
  })

  test("goes right when feature > threshold", () => {
    expect(predictGbdtTree(simpleTree, { hp: 7 })).toBe(0.8)
  })

  test("goes left on exact threshold value", () => {
    expect(predictGbdtTree(simpleTree, { hp: 5 })).toBe(0.2)
  })

  test("treats missing feature as 0", () => {
    expect(predictGbdtTree(simpleTree, {})).toBe(0.2) // 0 <= 5 → left
  })
})

// ======================== GBDT Value ========================
describe("predictGbdtValue", () => {
  const artifact: GbdtValueArtifact = {
    artifact_type: "gbdt_value.v1",
    artifact_version: "test",
    created_at: "2025-01-01",
    bias: 0.5,
    learning_rate: 0.1,
    trees: [
      {
        nodes: [
          { feature: "self.total_health", threshold: 10, left: 1, right: 2, value: null },
          { feature: null, threshold: null, left: null, right: null, value: -1.0 },
          { feature: null, threshold: null, left: null, right: null, value: 1.0 },
        ],
      },
      {
        nodes: [
          { feature: "self.dice_count", threshold: 3, left: 1, right: 2, value: null },
          { feature: null, threshold: null, left: null, right: null, value: -0.5 },
          { feature: null, threshold: null, left: null, right: null, value: 0.5 },
        ],
      },
    ],
    feature_names: ["self.total_health", "self.dice_count"],
    metadata: {
      dataset_id: "test",
      sample_count: 100,
      n_estimators: 2,
      max_depth: 1,
    },
  }

  test("predicts with bias + learning_rate * sum(trees)", () => {
    // health=15 > 10 → +1.0, dice=5 > 3 → +0.5
    // value = 0.5 + 0.1*(1.0 + 0.5) = 0.5 + 0.15 = 0.65
    const result = predictGbdtValue(artifact, { "self.total_health": 15, "self.dice_count": 5 })
    expect(result).toBeCloseTo(0.65, 5)
  })

  test("low health + low dice → lower value", () => {
    // health=5 <= 10 → -1.0, dice=2 <= 3 → -0.5
    // value = 0.5 + 0.1*(-1.0 + -0.5) = 0.5 - 0.15 = 0.35
    const result = predictGbdtValue(artifact, { "self.total_health": 5, "self.dice_count": 2 })
    expect(result).toBeCloseTo(0.35, 5)
  })

  test("clamps output to [0, 1]", () => {
    const extreme: GbdtValueArtifact = {
      ...artifact,
      bias: 0.9,
      learning_rate: 1.0,
      trees: [{
        nodes: [
          { feature: null, threshold: null, left: null, right: null, value: 2.0 },
        ],
      }],
    }
    expect(predictGbdtValue(extreme, {})).toBe(1)
  })
})

// ======================== MLP Value ========================
describe("predictMlpValue", () => {
  const artifact: MlpValueArtifact = {
    artifact_type: "mlp_value.v1",
    artifact_version: "test",
    created_at: "2025-01-01",
    layers: [
      {
        // Hidden layer: 2 inputs → 2 outputs, relu
        weights: [
          [1.0, 0.0],  // neuron 0: pass-through input 0
          [0.0, 1.0],  // neuron 1: pass-through input 1
        ],
        biases: [0.0, 0.0],
        activation: "relu",
      },
      {
        // Output layer: 2 inputs → 1 output, sigmoid
        weights: [
          [0.5, 0.5],
        ],
        biases: [0.0],
        activation: "sigmoid",
      },
    ],
    feature_names: ["self.total_health", "self.dice_count"],
    metadata: {
      dataset_id: "test",
      sample_count: 100,
      hidden_dims: [2],
    },
  }

  test("forward pass with relu + sigmoid", () => {
    // Input: [10, 4]
    // Hidden (relu): [max(0, 10*1+4*0+0), max(0, 10*0+4*1+0)] = [10, 4]
    // Output (sigmoid): sigmoid(10*0.5 + 4*0.5 + 0) = sigmoid(7) ≈ 0.999
    const result = predictMlpValue(artifact, { "self.total_health": 10, "self.dice_count": 4 })
    expect(result).toBeGreaterThan(0.99)
  })

  test("negative inputs clipped by relu", () => {
    // Input: [-5, -3]
    // Hidden (relu): [max(0, -5), max(0, -3)] = [0, 0]
    // Output (sigmoid): sigmoid(0) = 0.5
    const result = predictMlpValue(artifact, { "self.total_health": -5, "self.dice_count": -3 })
    expect(result).toBeCloseTo(0.5, 2)
  })

  test("handles tanh activation", () => {
    const tanhArtifact: MlpValueArtifact = {
      ...artifact,
      layers: [
        {
          weights: [[1.0]],
          biases: [0.0],
          activation: "tanh",
        },
        {
          weights: [[1.0]],
          biases: [0.5],
          activation: "none",
        },
      ],
      feature_names: ["x"],
    }
    // Input: [0] → tanh(0)=0 → 0*1+0.5=0.5
    const result = predictMlpValue(tanhArtifact, { x: 0 })
    expect(result).toBeCloseTo(0.5, 5)
  })

  test("missing features default to 0", () => {
    const result = predictMlpValue(artifact, {})
    // Input: [0, 0] → Hidden: [0, 0] → sigmoid(0) = 0.5
    expect(result).toBeCloseTo(0.5, 2)
  })
})

// ======================== GBDT Ranker ========================
describe("predictGbdtRankerScore", () => {
  const artifact: GbdtRankerArtifact = {
    artifact_type: "gbdt_ranker.v1",
    artifact_version: "test",
    created_at: "2025-01-01",
    bias: 0,
    learning_rate: 1.0,
    trees: [
      {
        nodes: [
          { feature: "c:damage_estimate", threshold: 5, left: 1, right: 2, value: null },
          { feature: null, threshold: null, left: null, right: null, value: -1.0 },
          { feature: null, threshold: null, left: null, right: null, value: 2.0 },
        ],
      },
    ],
    query_feature_names: ["round", "dice_count"],
    candidate_feature_names: ["damage_estimate", "cost"],
    metadata: {
      dataset_id: "test",
      sample_count: 50,
      n_estimators: 1,
      max_depth: 1,
    },
  }

  test("scores high damage candidate higher", () => {
    const query = { round: 3, dice_count: 8 }
    const highDamage = { damage_estimate: 7, cost: 3 }
    const lowDamage = { damage_estimate: 2, cost: 1 }
    const highScore = predictGbdtRankerScore(artifact, query, highDamage)
    const lowScore = predictGbdtRankerScore(artifact, query, lowDamage)
    expect(highScore).toBeGreaterThan(lowScore)
  })

  test("combines query and candidate features", () => {
    const score = predictGbdtRankerScore(
      artifact,
      { round: 1, dice_count: 4 },
      { damage_estimate: 10, cost: 5 },
    )
    // c:damage_estimate = 10 > 5 → value = 2.0
    // score = 0 + 1.0 * 2.0 = 2.0
    expect(score).toBe(2.0)
  })
})
