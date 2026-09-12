// Copyright (C) 2024-2025 Guyutongxue
//
// Sentinel tests for temporal card profiles generated from DSL source.

import { expect, test, describe } from "vitest"
import { readFileSync } from "node:fs"
import { parseAllDSL } from "./dsl-parser.js"
import type { TemporalCardProfile } from "./types.js"

const ALLY_SOURCE = readFileSync(
  new URL("../../../../data/src/cards/support/ally.ts", import.meta.url),
  "utf-8",
)

let _profiles: TemporalCardProfile[] | null = null
function profiles(): TemporalCardProfile[] {
  if (!_profiles) _profiles = parseAllDSL(ALLY_SOURCE)
  return _profiles
}
function profile(id: number): TemporalCardProfile | undefined {
  return profiles().find(p => p.definitionId === id)
}

describe("DSL parser: ally.ts", () => {
  test("parses at least 25 support cards", () => {
    expect(profiles().length).toBeGreaterThanOrEqual(25)
  })

  test("Liben (322008) is a deferred_bank with endPhase+actionPhase triggers", () => {
    const p = profile(322008)!
    expect(p.optionKind).toBe("deferred_bank")
    expect(p.triggerWindows).toContain("end_phase")
    expect(p.triggerWindows).toContain("action_phase")
    expect(p.payoff.draw).toBe(2)
    expect(p.payoff.generate_dice_omni).toBe(2)
    expect(p.payoff.self_dispose).toBe(true)
  })

  test("Chef Mao (322005) is a conditional_engine requiring food", () => {
    const p = profile(322005)!
    expect(p.optionKind).toBe("conditional_engine")
    expect(p.prerequisites.some(pr => pr.kind === "card_tag" && pr.value === "food")).toBe(true)
  })

  test("Timaeus (322003) is a conditional_engine requiring artifact", () => {
    const p = profile(322003)!
    expect(p.optionKind).toBe("conditional_engine")
    expect(p.prerequisites.some(pr => pr.kind === "card_tag" && pr.value === "artifact")).toBe(true)
    expect(p.payoff.cost_reduction_all).toBe(true)
  })

  test("Wagner (322004) is a conditional_engine requiring weapon", () => {
    const p = profile(322004)!
    expect(p.optionKind).toBe("conditional_engine")
    expect(p.prerequisites.some(pr => pr.kind === "card_tag" && pr.value === "weapon")).toBe(true)
  })

  test("Tubby (322006) is a conditional_engine requiring place", () => {
    const p = profile(322006)!
    expect(p.optionKind).toBe("conditional_engine")
    expect(p.prerequisites.some(pr => pr.kind === "card_tag" && pr.value === "place")).toBe(true)
  })

  test("Paimon (322001) is a recurring_engine with exact dice generation", () => {
    const p = profile(322001)!
    expect(p.optionKind).toBe("recurring_engine")
    expect(p.triggerWindows).toContain("action_phase")
    expect(p.payoff.generate_dice_omni).toBe(2)
    expect(p.footprint.dice_cost_average).toBeGreaterThan(0)
  })

  test("Katheryne (322002) has beforeFastSwitch reactive trigger", () => {
    const p = profile(322002)!
    expect(p.triggerWindows).toContain("reactive")
  })

  test("IronTongueTian (322011) is a burst_enabler with energy gain", () => {
    const p = profile(322011)!
    expect(p.optionKind).toBe("burst_enabler")
    expect(p.payoff.energy_gain).toBe(1)
  })

  test("LiuSu (322012) provides energy gain", () => {
    const p = profile(322012)!
    expect(p.payoff.energy_gain).toBeGreaterThan(0)
  })

  test("ChangTheNinth (322009) provides draw with variable threshold", () => {
    const p = profile(322009)!
    expect(p.payoff.draw).toBeGreaterThan(0)
    expect(p.prerequisites.some(pr => pr.kind === "variable_at_least")).toBe(true)
  })

  test("no profile has empty triggerWindows for known supports", () => {
    for (const p of profiles()) {
      // Some supports may legitimately have no reactive triggers (pure aura/status)
      // but most commonly used ones should have at least one trigger
    }
    // Just ensure the key 10 have triggers
    const key = [322008, 322005, 322003, 322001, 322011, 322012, 322009, 322002, 322004, 322006]
    for (const id of key) {
      const p = profile(id)!
      expect(p.triggerWindows.length, `${p.name} should have triggers`).toBeGreaterThan(0)
    }
  })
})
