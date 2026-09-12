// Copyright (C) 2026 Piovium Labs
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * V30 Stage 2.E — End-to-end training pipeline tests.
 *
 * Validates:
 *   1. Backward compat: legacy DataLake (no featuresExt) still trains and
 *      produces base-only weights.
 *   2. Extension training: DataLake with featuresExt + useFeatureExtension=true
 *      produces weights whose featureNames includes both base and ext names.
 *   3. End-to-end: trained ext weights → EvaluatorPolicy auto-detects and
 *      enables extension; predictions stay finite & bounded.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DataLake } from "../../db/data-lake.js"
import { extractStaticFingerprints } from "../fingerprint/ast-visitor.js"
import { FingerprintLake } from "../fingerprint/fingerprint-lake.js"
import {
  FINGERPRINT_SCHEMA_VERSION,
  type FingerprintArtifact,
} from "../fingerprint/types.js"
import { FeatureExtractor, type ScoringFeatureVector } from "../scoring/feature-extractor.js"
import {
  FEATURE_EXTENSION_DIM,
  FeatureExtension,
} from "../scoring/feature-extension.js"
import { LogisticCalibrator } from "../scoring/logistic-reg.js"
import { trainEvaluatorFromDataLake } from "./train-evaluator.js"

const BASE_DIM = FeatureExtractor.featureNames().length

function buildLake(): FingerprintLake {
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

function makeBaseSample(overrides: Partial<{
  damageEstimate: number
  selfActiveHpRatio: number
}> = {}) {
  const features = Object.fromEntries(
    FeatureExtractor.featureNames().map((n) => [n, 0]),
  ) as Record<string, number>
  return {
    ...features,
    damageEstimate: overrides.damageEstimate ?? 0,
    selfActiveHpRatio: overrides.selfActiveHpRatio ?? 1,
  } as ScoringFeatureVector
}

function withTmpDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "v30-train-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("trainEvaluatorFromDataLake — Stage 2.E", () => {
  it("backward-compat: trains base-only weights when no samples have featuresExt", () => {
    withTmpDir((dir) => {
      const dbPath = join(dir, "samples.sqlite")
      const lake = new DataLake(dbPath)
      try {
        for (let i = 0; i < 60; i++) {
          lake.insert({
            gameId: `game_${Math.floor(i / 6)}`,
            round: 1 + (i % 5),
            turn: i % 3,
            player: (i % 2) as 0 | 1,
            actionCase: "useSkill",
            features: FeatureExtractor.toArray(
              makeBaseSample({ damageEstimate: i % 7 }),
            ),
            label: i % 2,
            source: "self_play",
            weight: 1,
          })
        }
      } finally {
        lake.close()
      }

      const result = trainEvaluatorFromDataLake({
        dbPath,
        options: { epochs: 5 },
      })
      expect(result.sampleCount).toBe(60)
      expect(result.extensionDim).toBe(0)
      expect(result.weights.featureNames.length).toBe(BASE_DIM)
      expect(result.weights.coefficients.length).toBe(BASE_DIM)
    })
  })

  it("ext training: trains base + ext weights when samples carry featuresExt", () => {
    withTmpDir((dir) => {
      const dbPath = join(dir, "samples-ext.sqlite")
      const lake = new DataLake(dbPath)
      const flake = buildLake()
      try {
        for (let i = 0; i < 80; i++) {
          // Build a synthetic ext array per sample
          const ext = FeatureExtension.extract({
            previewVector: null,
            primaryDefinitionId: i % 2 === 0 ? 11014 : 11011, // alternate ganyu burst / normal
            lake: flake,
          })
          lake.insert({
            gameId: `game_${Math.floor(i / 8)}`,
            round: 1 + (i % 5),
            turn: i % 3,
            player: (i % 2) as 0 | 1,
            actionCase: "useSkill",
            features: FeatureExtractor.toArray(
              makeBaseSample({ damageEstimate: i % 7 }),
            ),
            featuresExt: FeatureExtension.toArray(ext),
            label: i % 2,
            source: "self_play",
            weight: 1,
          })
        }
      } finally {
        lake.close()
      }

      const result = trainEvaluatorFromDataLake({
        dbPath,
        useFeatureExtension: true,
        options: { epochs: 5 },
      })
      expect(result.sampleCount).toBe(80)
      expect(result.extensionDim).toBe(FEATURE_EXTENSION_DIM)
      expect(result.weights.featureNames.length).toBe(BASE_DIM + FEATURE_EXTENSION_DIM)
      expect(result.weights.coefficients.length).toBe(BASE_DIM + FEATURE_EXTENSION_DIM)
      // featureNames must contain at least one preview and one fingerprint slot
      expect(result.weights.featureNames.some((n) => n.startsWith("preview_"))).toBe(true)
      expect(result.weights.featureNames.some((n) => n.startsWith("fp_"))).toBe(true)
    })
  })

  it("trained ext weights are loadable by EvaluatorPolicy auto-detect", () => {
    withTmpDir((dir) => {
      const dbPath = join(dir, "samples-e2e.sqlite")
      const lake = new DataLake(dbPath)
      const flake = buildLake()
      try {
        for (let i = 0; i < 40; i++) {
          const ext = FeatureExtension.extract({
            previewVector: null,
            primaryDefinitionId: 11014,
            lake: flake,
          })
          lake.insert({
            gameId: `g${i}`,
            round: 1,
            turn: 0,
            player: 0,
            actionCase: "useSkill",
            features: FeatureExtractor.toArray(makeBaseSample({ damageEstimate: i % 5 })),
            featuresExt: FeatureExtension.toArray(ext),
            label: i % 2,
            source: "self_play",
            weight: 1,
          })
        }
      } finally {
        lake.close()
      }

      const result = trainEvaluatorFromDataLake({
        dbPath,
        useFeatureExtension: true,
        options: { epochs: 3 },
      })
      const cal = LogisticCalibrator.fromJSON(result.weights)
      expect(cal.hasExtensionCoefficients()).toBe(true)
      expect(cal.extensionDim()).toBe(FEATURE_EXTENSION_DIM)
      const f = makeBaseSample({ damageEstimate: 2 })
      const ext = FeatureExtension.toArray(
        FeatureExtension.extract({
          previewVector: null,
          primaryDefinitionId: 11014,
          lake: flake,
        }),
      )
      const p = cal.predictWithExtension(f, ext)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    })
  })

  it("handles mixed-extension DataLake (some samples have ext, some don't)", () => {
    withTmpDir((dir) => {
      const dbPath = join(dir, "mixed.sqlite")
      const lake = new DataLake(dbPath)
      const flake = buildLake()
      try {
        for (let i = 0; i < 30; i++) {
          const hasExt = i % 2 === 0
          const ext = hasExt
            ? FeatureExtension.toArray(
                FeatureExtension.extract({
                  previewVector: null,
                  primaryDefinitionId: 11014,
                  lake: flake,
                }),
              )
            : null
          lake.insert({
            gameId: `mix${i}`,
            round: 1,
            turn: 0,
            player: 0,
            actionCase: "useSkill",
            features: FeatureExtractor.toArray(makeBaseSample()),
            featuresExt: ext,
            label: i % 2,
            source: "self_play",
            weight: 1,
          })
        }
      } finally {
        lake.close()
      }

      const result = trainEvaluatorFromDataLake({
        dbPath,
        useFeatureExtension: true,
        options: { epochs: 3 },
      })
      // legacy samples are zero-padded, so we still train ext weights
      expect(result.extensionDim).toBe(FEATURE_EXTENSION_DIM)
      expect(result.sampleCount).toBe(30)
    })
  })
})
