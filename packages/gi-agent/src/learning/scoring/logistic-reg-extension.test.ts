// Copyright (C) 2026 Piovium Labs
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * V30 Stage 2.B — Tests for LogisticCalibrator extension methods.
 *
 * Validates:
 *   1. Backward compat: predictWithExtension() with old-shape weights
 *      (no extension coefficients) returns the same value as predict().
 *   2. Extension activation: weights with trailing extension coefficients
 *      apply them when extension array is provided.
 *   3. Graceful degradation: shorter-than-expected extension array zeros
 *      the missing dims rather than throwing.
 *   4. hasExtensionCoefficients() / extensionDim() introspection.
 */

import { describe, expect, it } from "vitest"
import { FeatureExtractor, type ScoringFeatureVector } from "./feature-extractor.js"
import { LogisticCalibrator, type CalibratedWeights } from "./logistic-reg.js"

const BASE_DIM = FeatureExtractor.featureNames().length

function buildBaseFeatures(overrides: Partial<ScoringFeatureVector> = {}): ScoringFeatureVector {
  const base: ScoringFeatureVector = Object.fromEntries(
    FeatureExtractor.featureNames().map((n) => [n, 0]),
  ) as never
  return { ...base, ...overrides }
}

function buildLegacyWeights(): CalibratedWeights {
  return {
    featureNames: FeatureExtractor.featureNames() as string[],
    coefficients: new Array(BASE_DIM).fill(0).map((_, i) => (i % 5 === 0 ? 0.1 : 0)),
    intercept: -0.5,
    meta: {
      samples: 100,
      epochs: 50,
      finalLoss: 0.42,
      accuracy: 0.62,
      timestamp: new Date().toISOString(),
    },
  }
}

function buildExtensionWeights(extDim: number): CalibratedWeights {
  const baseCoefs = new Array(BASE_DIM).fill(0).map((_, i) => (i % 5 === 0 ? 0.1 : 0))
  const extCoefs = new Array(extDim).fill(0).map((_, i) => 0.05 + i * 0.001)
  return {
    featureNames: [
      ...FeatureExtractor.featureNames(),
      ...new Array(extDim).fill(0).map((_, i) => `ext_${i}`),
    ] as string[],
    coefficients: [...baseCoefs, ...extCoefs],
    intercept: -0.5,
    meta: {
      samples: 200,
      epochs: 50,
      finalLoss: 0.4,
      accuracy: 0.65,
      timestamp: new Date().toISOString(),
    },
  }
}

describe("LogisticCalibrator extension methods", () => {
  it("predictWithExtension matches predict() for legacy weights", () => {
    const cal = LogisticCalibrator.fromJSON(buildLegacyWeights())
    const f = buildBaseFeatures({ damageEstimate: 5, round: 2 })
    const a = cal.predict(f)
    const b = cal.predictWithExtension(f, [1, 2, 3, 4, 5])
    expect(b).toBeCloseTo(a, 12)
  })

  it("predictWithExtension ignores extension arr when weights have no ext coefs", () => {
    const cal = LogisticCalibrator.fromJSON(buildLegacyWeights())
    const f = buildBaseFeatures({ damageEstimate: 5 })
    const withExt = cal.predictWithExtension(f, new Array(50).fill(99))
    const noExt = cal.predictWithExtension(f, null)
    expect(withExt).toBeCloseTo(noExt, 12)
  })

  it("hasExtensionCoefficients reflects weights shape", () => {
    const legacy = LogisticCalibrator.fromJSON(buildLegacyWeights())
    expect(legacy.hasExtensionCoefficients()).toBe(false)
    expect(legacy.extensionDim()).toBe(0)

    const ext = LogisticCalibrator.fromJSON(buildExtensionWeights(85))
    expect(ext.hasExtensionCoefficients()).toBe(true)
    expect(ext.extensionDim()).toBe(85)
  })

  it("predictWithExtension applies extension coefficients", () => {
    const w = buildExtensionWeights(10)
    const cal = LogisticCalibrator.fromJSON(w)
    const f = buildBaseFeatures()
    // All-zero extension should equal intercept-only prediction
    const ext0 = cal.predictWithExtension(f, new Array(10).fill(0))
    // Non-zero extension should produce a different prediction
    const ext1 = cal.predictWithExtension(f, new Array(10).fill(2))
    expect(ext0).not.toBeCloseTo(ext1, 4)
  })

  it("predictWithExtension handles short extension array (zero-pad)", () => {
    const cal = LogisticCalibrator.fromJSON(buildExtensionWeights(20))
    const f = buildBaseFeatures()
    const full = cal.predictWithExtension(f, new Array(20).fill(0))
    const truncated = cal.predictWithExtension(f, new Array(5).fill(0))
    // Both all-zero so should match
    expect(truncated).toBeCloseTo(full, 12)
  })

  it("predictWithExtension handles null extension when weights have ext", () => {
    const cal = LogisticCalibrator.fromJSON(buildExtensionWeights(10))
    const f = buildBaseFeatures()
    const result = cal.predictWithExtension(f, null)
    // null extension is equivalent to all-zero extension — only base coefs apply
    const allZeroExt = cal.predictWithExtension(f, new Array(10).fill(0))
    expect(result).toBeCloseTo(allZeroExt, 12)
  })

  it("predictThompsonWithExtension falls back when no variances", () => {
    const w = buildExtensionWeights(10)
    expect(w.coefficientVariances).toBeUndefined()
    const cal = LogisticCalibrator.fromJSON(w)
    const f = buildBaseFeatures()
    const a = cal.predictThompsonWithExtension(f, new Array(10).fill(0))
    const b = cal.predictWithExtension(f, new Array(10).fill(0))
    expect(a).toBeCloseTo(b, 12)
  })
})
