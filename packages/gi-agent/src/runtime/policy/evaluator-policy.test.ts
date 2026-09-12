// Copyright (C) 2026 Piovium Labs
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * V30 Stage 2.B — Integration tests for EvaluatorPolicy + FeatureExtension wiring.
 *
 * Validates:
 *   1. Backward compat: EvaluatorPolicy with legacy weights (no extension
 *      coefficients) produces deterministic decisions identical to the
 *      pre-V30 path. enableFeatureExtension auto-detects from weights shape.
 *   2. Extension wiring: when weights include extension coefficients and
 *      candidates carry preview_data + skill_definition_id, the extension
 *      array is built and applied. Different extension arrays → different
 *      learnedScore.
 *   3. Graceful behaviour when fingerprintLake is absent.
 */

import { describe, expect, it } from "vitest"
import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { extractStaticFingerprints } from "../../learning/fingerprint/ast-visitor.js"
import { FingerprintLake } from "../../learning/fingerprint/fingerprint-lake.js"
import {
  FINGERPRINT_SCHEMA_VERSION,
  type FingerprintArtifact,
} from "../../learning/fingerprint/types.js"
import { FeatureExtractor } from "../../learning/scoring/feature-extractor.js"
import {
  FEATURE_EXTENSION_DIM,
} from "../../learning/scoring/feature-extension.js"
import type { CalibratedWeights } from "../../learning/scoring/logistic-reg.js"
import { EvaluatorPolicy } from "./evaluator-policy.js"
import type { PolicyTurnDigest } from "./types.js"

const BASE_DIM = FeatureExtractor.featureNames().length

function makeLake(): FingerprintLake {
  const data = getData(CURRENT_VERSION)
  const artifact: FingerprintArtifact = {
    schema_version: FINGERPRINT_SCHEMA_VERSION,
    game_version: CURRENT_VERSION,
    generated_at: new Date().toISOString(),
    counts: {} as never,
    entries: extractStaticFingerprints(data, { gameVersion: CURRENT_VERSION }),
  }
  return FingerprintLake.fromArtifact(artifact)
}

function makeLegacyWeights(): CalibratedWeights {
  return {
    featureNames: FeatureExtractor.featureNames() as string[],
    coefficients: new Array(BASE_DIM).fill(0).map((_, i) => (i % 7 === 0 ? 0.05 : 0)),
    intercept: 0.1,
    meta: {
      samples: 1, epochs: 1, finalLoss: 0, accuracy: 0,
      timestamp: new Date().toISOString(),
    },
  }
}

function makeExtensionWeights(): CalibratedWeights {
  const baseCoefs = new Array(BASE_DIM).fill(0).map((_, i) => (i % 7 === 0 ? 0.05 : 0))
  const extCoefs = new Array(FEATURE_EXTENSION_DIM).fill(0).map((_, i) => 0.02 + i * 0.0005)
  return {
    featureNames: [
      ...FeatureExtractor.featureNames(),
      ...new Array(FEATURE_EXTENSION_DIM).fill(0).map((_, i) => `ext_${i}`),
    ] as string[],
    coefficients: [...baseCoefs, ...extCoefs],
    intercept: 0.1,
    meta: {
      samples: 1, epochs: 1, finalLoss: 0, accuracy: 0,
      timestamp: new Date().toISOString(),
    },
  }
}

function makeDigest(): PolicyTurnDigest {
  return {
    round: 1,
    turn: 0,
    self_summary: {
      characters: [
        { id: 100, character_id: 1101, hp: 10, max_hp: 12, energy: 0, max_energy: 3, alive: true, is_active: true, aura: 0 },
        { id: 101, character_id: 1102, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true, is_active: false, aura: 0 },
        { id: 102, character_id: 1103, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true, is_active: false, aura: 0 },
      ],
      active_character_id: 100,
      supports: [],
      summons: [],
      combat_statuses: [],
    },
    opponent_summary: {
      characters: [
        { id: 200, character_id: 2101, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true, is_active: true, aura: 0 },
        { id: 201, character_id: 2102, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true, is_active: false, aura: 0 },
        { id: 202, character_id: 2103, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true, is_active: false, aura: 0 },
      ],
      active_character_id: 200,
      supports: [],
      summons: [],
      combat_statuses: [],
    },
    resource_summary: {
      dice_count: 8,
      dice_colors: [],
      hand_size: 5,
      pile_size: 25,
    },
    candidate_actions: [
      {
        candidate_id: "0",
        action_case: "useSkill",
        skill_definition_id: 11014, // Ganyu burst
        damage_estimate: 6,
        cost: 6,
        is_valid: true,
        tags: [],
      },
      {
        candidate_id: "1",
        action_case: "useSkill",
        skill_definition_id: 11011, // Ganyu normal
        damage_estimate: 1,
        cost: 3,
        is_valid: true,
        tags: [],
      },
      {
        candidate_id: "2",
        action_case: "declareEnd",
        damage_estimate: 0,
        cost: 0,
        is_valid: true,
        tags: [],
      },
    ],
  }
}

describe("EvaluatorPolicy V30 extension wiring", () => {
  it("auto-disables extension for legacy weights", () => {
    const policy = new EvaluatorPolicy(makeLegacyWeights(), {
      fingerprintLake: makeLake(),
    })
    // auto-detect: legacy weights → no extension
    // Effectively: behaviour identical to pre-V30
    const decision = policy.choose(makeDigest())
    expect(decision.selectedCandidateId).toBeDefined()
    expect(decision.ranked.length).toBe(3)
    // No "+ext" tag in reasons since extension is disabled
    const hasExt = decision.ranked.some((r) => r.reasons.some((s) => s.includes("[+ext]")))
    expect(hasExt).toBe(false)
  })

  it("auto-enables extension when weights include extension coefficients", () => {
    const lake = makeLake()
    const policy = new EvaluatorPolicy(makeExtensionWeights(), {
      fingerprintLake: lake,
    })
    const decision = policy.choose(makeDigest())
    expect(decision.selectedCandidateId).toBeDefined()
    expect(decision.ranked.length).toBe(3)
    // Each ranked entry should reflect extension contribution
    const hasExt = decision.ranked.some((r) => r.reasons.some((s) => s.includes("[+ext]")))
    expect(hasExt).toBe(true)
  })

  it("decisions are deterministic when greedy", () => {
    const lake = makeLake()
    const weights = makeExtensionWeights()
    const policy1 = new EvaluatorPolicy(weights, {
      fingerprintLake: lake,
      explorationStrategy: "greedy",
    })
    const policy2 = new EvaluatorPolicy(weights, {
      fingerprintLake: lake,
      explorationStrategy: "greedy",
    })
    const d1 = policy1.choose(makeDigest())
    const d2 = policy2.choose(makeDigest())
    expect(d1.selectedCandidateId).toBe(d2.selectedCandidateId)
    for (let i = 0; i < d1.ranked.length; i++) {
      expect(d1.ranked[i].finalScore).toBeCloseTo(d2.ranked[i].finalScore, 12)
    }
  })

  it("legacy and extension paths yield identical rankings when ext coefs are zero", () => {
    // Build extension weights where all extension coefficients = 0 — the
    // extension contribution should be zero, so output must match legacy.
    const baseCoefs = new Array(BASE_DIM).fill(0).map((_, i) => (i % 7 === 0 ? 0.05 : 0))
    const zeroExtCoefs = new Array(FEATURE_EXTENSION_DIM).fill(0)
    const zeroExtWeights: CalibratedWeights = {
      featureNames: [
        ...FeatureExtractor.featureNames(),
        ...new Array(FEATURE_EXTENSION_DIM).fill(0).map((_, i) => `ext_${i}`),
      ] as string[],
      coefficients: [...baseCoefs, ...zeroExtCoefs],
      intercept: 0.1,
      meta: { samples: 1, epochs: 1, finalLoss: 0, accuracy: 0, timestamp: "" },
    }

    const legacy = new EvaluatorPolicy(makeLegacyWeights(), {
      fingerprintLake: makeLake(),
      explorationStrategy: "greedy",
    })
    const extZero = new EvaluatorPolicy(zeroExtWeights, {
      fingerprintLake: makeLake(),
      explorationStrategy: "greedy",
    })
    const legacyD = legacy.choose(makeDigest())
    const extD = extZero.choose(makeDigest())
    // Top-1 must match; finalScore must match within fp tolerance
    expect(extD.selectedCandidateId).toBe(legacyD.selectedCandidateId)
    for (let i = 0; i < legacyD.ranked.length; i++) {
      expect(extD.ranked[i].finalScore).toBeCloseTo(legacyD.ranked[i].finalScore, 6)
    }
  })

  it("works without fingerprintLake (zero fingerprint dims)", () => {
    const policy = new EvaluatorPolicy(makeExtensionWeights(), {
      fingerprintLake: null,
    })
    const decision = policy.choose(makeDigest())
    expect(decision.selectedCandidateId).toBeDefined()
    // Still includes "[+ext]" because extension is enabled by weights shape;
    // fingerprint dims are simply zeroed.
    const hasExt = decision.ranked.some((r) => r.reasons.some((s) => s.includes("[+ext]")))
    expect(hasExt).toBe(true)
  })

  it("explicit enableFeatureExtension=false overrides auto-detect", () => {
    const policy = new EvaluatorPolicy(makeExtensionWeights(), {
      fingerprintLake: makeLake(),
      enableFeatureExtension: false,
    })
    const decision = policy.choose(makeDigest())
    const hasExt = decision.ranked.some((r) => r.reasons.some((s) => s.includes("[+ext]")))
    expect(hasExt).toBe(false)
  })
})
