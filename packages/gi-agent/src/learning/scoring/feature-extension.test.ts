// Copyright (C) 2026 Piovium Labs
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { FingerprintLake } from "../fingerprint/fingerprint-lake.js"
import { extractStaticFingerprints } from "../fingerprint/ast-visitor.js"
import {
  FINGERPRINT_SCHEMA_VERSION,
  type FingerprintArtifact,
} from "../fingerprint/types.js"
import {
  PREVIEW_VECTOR_SCALAR_DIM,
} from "../fingerprint/preview-vector.js"
import {
  FEATURE_EXTENSION_DIM,
  FINGERPRINT_FLAT_DIM,
  FeatureExtension,
  flattenFingerprint,
} from "./feature-extension.js"

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

describe("FeatureExtension", () => {
  const lake = buildLake()

  it("zero() length matches FEATURE_EXTENSION_DIM", () => {
    const z = FeatureExtension.zero()
    expect(z.preview.length).toBe(PREVIEW_VECTOR_SCALAR_DIM)
    expect(z.fingerprint.length).toBe(FINGERPRINT_FLAT_DIM)
    expect(FeatureExtension.toArray(z).length).toBe(FEATURE_EXTENSION_DIM)
  })

  it("featureNames length matches concat dim", () => {
    expect(FeatureExtension.featureNames().length).toBe(FEATURE_EXTENSION_DIM)
  })

  it("extracts fingerprint for known skill (Ganyu burst)", () => {
    const ext = FeatureExtension.extract({
      primaryDefinitionId: 11014,
      lake,
    })
    const names = FeatureExtension.featureNames()
    const flat = FeatureExtension.toArray(ext)
    const idxBurst = names.indexOf("fp_kind_skill_burst")
    const idxAligned = names.indexOf("fp_cost_aligned")
    const idxTotalDice = names.indexOf("fp_cost_total_dice")
    expect(flat[idxBurst]).toBe(1)
    expect(flat[idxAligned]).toBe(3)
    expect(flat[idxTotalDice]).toBe(6)
  })

  it("returns zero fingerprint for unknown definition", () => {
    const ext = FeatureExtension.extract({
      primaryDefinitionId: 99999999,
      lake,
    })
    const names = FeatureExtension.featureNames()
    const flat = FeatureExtension.toArray(ext)
    const idxHas = names.indexOf("fp_has_fingerprint")
    expect(flat[idxHas]).toBe(0)
  })

  it("returns zero fingerprint when lake absent", () => {
    const ext = FeatureExtension.extract({ primaryDefinitionId: 11014 })
    const names = FeatureExtension.featureNames()
    const flat = FeatureExtension.toArray(ext)
    expect(flat[names.indexOf("fp_has_fingerprint")]).toBe(0)
  })

  it("uses zero preview when previewVector absent", () => {
    const ext = FeatureExtension.extract({ primaryDefinitionId: 11014, lake })
    expect(ext.preview.every((x) => x === 0)).toBe(true)
  })

  it("flattenFingerprint identity for character (Ganyu cryo+bow)", () => {
    const fp = lake.get(1101)
    expect(fp).toBeDefined()
    const flat = flattenFingerprint(fp!)
    expect(flat.length).toBe(FINGERPRINT_FLAT_DIM)
    const names = FeatureExtension.featureNames()
    const offsetCryo = names.indexOf("fp_element_cryo") - PREVIEW_VECTOR_SCALAR_DIM
    const offsetUnknown = names.indexOf("fp_element_unknown") - PREVIEW_VECTOR_SCALAR_DIM
    const offsetWeaponBow = names.indexOf("fp_weapon_bow") - PREVIEW_VECTOR_SCALAR_DIM
    const offsetHas = names.indexOf("fp_has_fingerprint") - PREVIEW_VECTOR_SCALAR_DIM
    expect(flat[offsetCryo]).toBe(1)
    expect(flat[offsetUnknown]).toBe(0)
    expect(flat[offsetWeaponBow]).toBe(1)
    expect(flat[offsetHas]).toBe(1)
  })
})
