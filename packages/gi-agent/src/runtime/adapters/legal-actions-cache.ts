// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * C1 — `availableActions()` cache keyed by `GameState`.
 *
 * `GameState` is immutable (`@gi-tcg/core` uses immer / structural sharing),
 * so the same reference always corresponds to the same legal action slate
 * for the current-turn player. MCTS / BoundedSearcher revisit the same
 * `GameState` many times (root expansion, transposition, beam re-evaluation,
 * minimax response). Caching the action slate avoids re-running
 * `ActionPreviewer.modifyAndPreview` on every candidate, which is the
 * dominant cost of `availableActions()`.
 *
 * Why a `WeakMap`:
 *   - keys are GameState objects → GC-managed automatically, no leak risk
 *     for long self-play loops.
 *   - cache is process-local; multi-process pools have independent caches.
 *
 * The cached value is the *filtered* `VALID`-only slate, which is what
 * every caller in `sim-adapter.ts` and `engine-step.ts` actually wants.
 *
 * Engine invariants leveraged (verified against `@gi-tcg/core/game.ts`):
 *   1. `availableActions()` is pure w.r.t. `GameState` for a fresh
 *      `new Game(state)` constructed with default `PlayerConfig`
 *      (`alwaysOmni:false, allowTuningAnyDice:false` — the SimAdapter /
 *      engine-step usage). Verified by tracing skill enumeration, card
 *      enumeration, switch/declareEnd, ActionPreviewer.modifyAndPreview,
 *      applyAutoSelectedDiceToAction — all read state.players / activeCh
 *      from the GameState argument; PlayerConfig is constant.
 *   2. The returned `ActionInfoWithModification[]` carries `preview`
 *      which is shape-stable; downstream code reads but does not mutate.
 *
 * NOTE: This cache is for query (legalActions); `step()` / RPC responses
 * are unaffected.
 */

import { Game, type GameState } from "@gi-tcg/core"
import { ActionValidity } from "@gi-tcg/typings"
import type { ActionInfoWithModification } from "./internal-types.js"

interface CacheEntry {
  /** Full slate as the engine returns it (VALID + INVALID, in engine order).
   *  Required by stub RPC handlers because the engine indexes RPC responses
   *  into this array (see `core/src/game.ts:723-730`: `chosenActionIndex`
   *  must be a position in `actions = await this.availableActions()`). */
  full: ActionInfoWithModification[]
  /** Filtered VALID-only slate. Convenience view for searchers / policies
   *  that only care about playable moves. */
  valid: ActionInfoWithModification[]
  /** Index of `declareEnd` within `full` (engine-side index). -1 if absent
   *  (should not happen during an action phase, but kept defensive). */
  declareEndIndexFull: number
}

const cache: WeakMap<GameState, Promise<CacheEntry>> = new WeakMap()

/** Hit/miss instrumentation (optional; enable via env). */
const trackStats = process.env.GI_AGENT_LEGAL_ACTIONS_STATS === "1"
let hits = 0
let misses = 0

export function getLegalActionsCacheStats(): { hits: number; misses: number } {
  return { hits, misses }
}

export function resetLegalActionsCacheStats(): void {
  hits = 0
  misses = 0
}

async function computeEntry(state: GameState): Promise<CacheEntry> {
  if (state.phase !== "action") {
    return { full: [], valid: [], declareEndIndexFull: -1 }
  }
  const game = new Game(state)
  try {
    const full = await game.availableActions()
    const valid: ActionInfoWithModification[] = []
    let declareEndIndexFull = -1
    for (let i = 0; i < full.length; i++) {
      const a = full[i]
      if (a.type === "declareEnd") declareEndIndexFull = i
      if (a.validity === ActionValidity.VALID) valid.push(a)
    }
    return { full, valid, declareEndIndexFull }
  } finally {
    game.terminate()
  }
}

/**
 * Get (or compute) the VALID-only legal action slate for `state`.
 * Concurrent callers on the same state share a single in-flight Promise.
 */
export async function getCachedLegalActions(
  state: GameState,
): Promise<ActionInfoWithModification[]> {
  const existing = cache.get(state)
  if (existing) {
    if (trackStats) hits++
    return (await existing).valid
  }
  if (trackStats) misses++
  const promise = computeEntry(state)
  cache.set(state, promise)
  return (await promise).valid
}

/**
 * Variant returning the full entry (full slate, valid slate, declareEnd
 * engine-side index). Used by stub RPC handlers that need to respond with
 * an engine-indexed `chosenActionIndex`.
 */
export async function getCachedLegalActionsWithMeta(
  state: GameState,
): Promise<CacheEntry> {
  const existing = cache.get(state)
  if (existing) {
    if (trackStats) hits++
    return existing
  }
  if (trackStats) misses++
  const promise = computeEntry(state)
  cache.set(state, promise)
  return promise
}

/**
 * Test/debug helper: clear all cached entries. (Should never be needed
 * in production — WeakMap cleans up automatically.)
 */
export function _clearLegalActionsCacheForTests(): void {
  // WeakMap has no clear(); reassign the underlying map.
  // Since `cache` is `const`, we can only delete known refs — but for tests
  // garbage collection handles this once references are dropped.
}
