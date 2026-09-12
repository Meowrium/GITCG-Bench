// Copyright (C) 2026 Piovium Labs
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

import { describe, expect, it } from "vitest"
import { CURRENT_VERSION } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { extractStaticFingerprints } from "./ast-visitor.js"
import { FingerprintLake } from "./fingerprint-lake.js"
import { FINGERPRINT_SCHEMA_VERSION, type FingerprintArtifact } from "./types.js"

function buildArtifact(): FingerprintArtifact {
  const data = getData(CURRENT_VERSION)
  const entries = extractStaticFingerprints(data, { gameVersion: CURRENT_VERSION })
  return {
    schema_version: FINGERPRINT_SCHEMA_VERSION,
    game_version: CURRENT_VERSION,
    generated_at: new Date().toISOString(),
    counts: {} as never,
    entries,
  }
}

describe("FingerprintLake", () => {
  const artifact = buildArtifact()
  const lake = FingerprintLake.fromArtifact(artifact)

  it("loads schema_version", () => {
    expect(lake.schemaVersion).toBe(FINGERPRINT_SCHEMA_VERSION)
  })

  it("rejects mismatched schema version", () => {
    const bad: FingerprintArtifact = { ...artifact, schema_version: 999 as never }
    expect(() => FingerprintLake.fromArtifact(bad)).toThrowError(/schema mismatch/)
  })

  it("indexes characters with element/weapon meta", () => {
    // 甘雨 (Ganyu): cryo bow liyue, HP 12, energy 3
    const ganyu = lake.get(1101)
    expect(ganyu).toBeDefined()
    expect(ganyu!.kind).toBe("character")
    expect(ganyu!.meta.element).toBe("cryo")
    expect(ganyu!.meta.weapon).toBe("bow")
    expect(ganyu!.meta.max_health).toBe(12)
    expect(ganyu!.meta.max_energy).toBe(3)
    expect(ganyu!.references).toContain(11011) // normal attack id
  })

  it("indexes skills with cost from initiativeSkillConfig", () => {
    // 甘雨 burst (11014): 3 cryo + 3 aligned (X), zero on cast
    const burst = lake.get(11014)
    expect(burst).toBeDefined()
    expect(burst!.kind).toBe("skill_burst")
    expect(burst!.cost.specific[1]).toBe(3) // cryo
    expect(burst!.cost.aligned).toBe(3)
    expect(burst!.cost.total_dice).toBe(6)
    expect(burst!.energy.self_active_zeroed).toBe(true)
  })

  it("classifies elemental and normal skills correctly", () => {
    const e = lake.get(11012)
    expect(e!.kind).toBe("skill_elemental")
    expect(e!.cost.specific[1]).toBe(3)
    expect(e!.energy.self_active).toBe(1)

    const normal = lake.get(11011)
    expect(normal!.kind).toBe("skill_normal")
    expect(normal!.cost.void).toBe(2)
    expect(normal!.cost.specific[1]).toBe(1)
    expect(normal!.energy.self_active).toBe(1)
  })

  it("byKind returns all entries of a kind", () => {
    const chars = lake.byKind("character")
    expect(chars.length).toBeGreaterThan(100) // > 100 characters in current pool
    for (const c of chars) {
      expect(c.kind).toBe("character")
      expect(typeof c.meta.element === "string" || c.meta.element === undefined).toBe(true)
    }
  })

  it("covers all data definitions (sanity)", () => {
    // characters + entities + at least one skill per char
    expect(lake.size()).toBeGreaterThan(1000)
    expect(lake.byKind("character").length).toBeGreaterThan(50)
    expect(lake.byKind("skill_burst").length).toBeGreaterThan(50)
    expect(lake.byKind("card_event").length).toBeGreaterThan(20)
    expect(lake.byKind("card_support").length).toBeGreaterThan(20)
  })

  it("entries are sorted by definition_id", () => {
    for (let i = 1; i < lake.entries.length; i++) {
      expect(lake.entries[i].definition_id).toBeGreaterThanOrEqual(
        lake.entries[i - 1].definition_id,
      )
    }
  })

  it("source_hash is stable across runs", () => {
    const lake2 = FingerprintLake.fromArtifact(buildArtifact())
    const a = lake.get(1101)
    const b = lake2.get(1101)
    expect(a!.source_hash).toBe(b!.source_hash)
  })
})
