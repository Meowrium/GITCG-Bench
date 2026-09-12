// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D3 — pure self-play sampling helpers (AlphaZero exploration schedule).
 *
 * Extracted from the ISMCTS self-play CLI so the visit -> policy / sampling
 * logic is unit-testable without spinning up the engine. No engine or encoder
 * imports here on purpose.
 */

/** Deterministic LCG in [0,1). Reproducible self-play sampling. */
export function makeSelfPlayRng(seed: number): () => number {
  let s = (seed >>> 0) || 1
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/**
 * Sample an index proportional to `visits^(1/temperature)`. When
 * `temperature <= 1e-3` (or all visits are 0) returns the argmax visit index
 * (greedy). This is the AlphaZero move-selection rule: high temperature early
 * for exploration, ~0 later for strength.
 */
export function sampleFromVisits(
  visits: number[],
  temperature: number,
  rng: () => number,
): number {
  const total = visits.reduce((a, b) => a + Math.max(0, b), 0)
  if (total <= 0) return 0
  if (temperature <= 1e-3) {
    let best = 0
    for (let i = 1; i < visits.length; i++) if (visits[i] > visits[best]) best = i
    return best
  }
  const inv = 1 / temperature
  const weighted = visits.map((v) => Math.pow(Math.max(0, v), inv))
  const wsum = weighted.reduce((a, b) => a + b, 0)
  if (wsum <= 0) return 0
  let r = rng() * wsum
  for (let i = 0; i < weighted.length; i++) {
    r -= weighted[i]
    if (r <= 0) return i
  }
  return weighted.length - 1
}

/**
 * Normalise visit counts into pi_MCTS (sums to 1). Uniform fall-back when all
 * visits are zero so the trainer always gets a valid distribution.
 */
export function visitsToPolicy(visits: number[]): number[] {
  const total = visits.reduce((a, b) => a + Math.max(0, b), 0)
  if (total <= 0) return visits.map(() => 1 / Math.max(1, visits.length))
  return visits.map((v) => Math.max(0, v) / total)
}
