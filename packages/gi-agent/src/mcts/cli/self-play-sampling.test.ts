// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D3 — self-play sampling helper tests.
 */

import { describe, expect, it } from "vitest"
import {
  makeSelfPlayRng,
  sampleFromVisits,
  visitsToPolicy,
} from "./self-play-sampling.js"

describe("visitsToPolicy", () => {
  it("normalises visit counts to a distribution summing to 1", () => {
    const pi = visitsToPolicy([10, 30, 60])
    expect(pi).toEqual([0.1, 0.3, 0.6])
    expect(pi.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it("returns a uniform distribution when all visits are zero", () => {
    const pi = visitsToPolicy([0, 0, 0, 0])
    expect(pi).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it("clamps negative visits to zero", () => {
    const pi = visitsToPolicy([-5, 0, 5])
    expect(pi).toEqual([0, 0, 1])
  })
})

describe("sampleFromVisits", () => {
  it("returns argmax when temperature ~ 0 (greedy play)", () => {
    const rng = makeSelfPlayRng(1)
    expect(sampleFromVisits([3, 99, 7], 0, rng)).toBe(1)
    expect(sampleFromVisits([3, 99, 7], 1e-4, rng)).toBe(1)
  })

  it("returns index 0 when there are no visits", () => {
    const rng = makeSelfPlayRng(7)
    expect(sampleFromVisits([0, 0], 1, rng)).toBe(0)
  })

  it("at temperature 1, samples roughly proportional to visit counts", () => {
    const rng = makeSelfPlayRng(123)
    const visits = [10, 90] // ~10% / ~90%
    const counts = [0, 0]
    const N = 4000
    for (let i = 0; i < N; i++) counts[sampleFromVisits(visits, 1, rng)]++
    const freq1 = counts[1] / N
    // Expect ~0.9; allow generous slack for the toy LCG.
    expect(freq1).toBeGreaterThan(0.8)
    expect(freq1).toBeLessThan(0.97)
  })

  it("higher temperature flattens the distribution toward uniform", () => {
    const rng = makeSelfPlayRng(999)
    const visits = [10, 90]
    const counts = [0, 0]
    const N = 4000
    // tau=4 -> exponents 1/4: 10^0.25 ~ 1.78, 90^0.25 ~ 3.08 -> ~0.63 mass on idx1
    for (let i = 0; i < N; i++) counts[sampleFromVisits(visits, 4, rng)]++
    const freq1 = counts[1] / N
    expect(freq1).toBeGreaterThan(0.5)
    expect(freq1).toBeLessThan(0.8)
  })

  it("is deterministic for a fixed seed", () => {
    const a = makeSelfPlayRng(42)
    const b = makeSelfPlayRng(42)
    const visits = [5, 5, 5, 5]
    for (let i = 0; i < 50; i++) {
      expect(sampleFromVisits(visits, 1, a)).toBe(sampleFromVisits(visits, 1, b))
    }
  })
})
