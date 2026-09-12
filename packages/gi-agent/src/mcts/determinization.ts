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

/**
 * V31 F6 / V30 §6.3 Step 2 — determinization (`randomize_unknowns`).
 *
 * Genius Invokation is an imperfect-information game: from the perspective
 * player's view the opponent's hand *contents* and both sides' pile *order*
 * are hidden. ISMCTS handles this by sampling K determinizations — concrete
 * full states consistent with the observation — and searching each.
 *
 * Inference of the opponent's hidden pool (framework §4.2 / V30 §6.3):
 *   - The engine `GameState` already tracks the exact remaining cards as
 *     `opponent.hands ∪ opponent.pile` (everything played / tuned / discarded
 *     has left those zones). That multiset *is* the "deck code − played − ban"
 *     pool the spec refers to; we don't need to re-decode the deck.
 *   - We re-shuffle that pool and re-split it into hand (size preserved) + pile,
 *     so the searching policy cannot exploit which specific cards the opponent
 *     drew (information it must not have online).
 *   - The perspective player's own hand is known and preserved; only their pile
 *     *order* is randomised (draw order is genuinely unknown to them).
 *   - Dice in the action phase are already rolled and public, so they are kept;
 *     future rolls are produced by the engine's own RNG during rollout.
 *
 * Crucially we only move *existing* `EntityState` objects between the `hands`
 * and `pile` arrays (ids / definitions / variables untouched), so the produced
 * state is always engine-legal. No `packages/core` code is modified.
 */

import type { GameState, PlayerState } from "@gi-tcg/core"

/** Minimal RNG contract: returns a float in [0, 1). */
export type Rng = () => number

/** Deterministic minstd LCG matching the engine's `nextRandom` family. */
export function makeLcg(seed: number): Rng {
  let s = seed >>> 0
  if (s === 0) s = 1
  return () => {
    // 48271 * s mod 2147483647 (Park–Miller minstd)
    s = (s * 48271) % 2147483647
    return (s - 1) / 2147483646
  }
}

/** Fisher–Yates shuffle producing a new array (does not mutate input). */
function shuffled<T>(arr: readonly T[], rng: Rng): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

export interface RandomizeOptions {
  /** RNG to use; defaults to a fresh LCG seeded from `Date.now()`. */
  rng?: Rng
  /**
   * When true (default), re-randomise the opponent's hand/pile split so the
   * searcher cannot see which cards the opponent actually drew. When false,
   * only the pile *order* is shuffled (useful for ablation / debugging).
   */
  randomizeOpponentHand?: boolean
  /**
   * When true (default), also shuffle the perspective player's own pile order.
   */
  randomizeSelfPile?: boolean
}

/**
 * Produce a determinized copy of `state` consistent with what `who` can observe.
 *
 * Returns a *new* `GameState` (shallow-cloned players with re-bucketed card
 * arrays); the original is untouched. The result is engine-legal and can be
 * fed straight into `new Game(state)` for rollout.
 */
export function randomizeUnknowns(
  state: GameState,
  who: 0 | 1,
  opts: RandomizeOptions = {},
): GameState {
  const rng = opts.rng ?? makeLcg((Date.now() & 0x7fffffff) || 1)
  const randomizeOpponentHand = opts.randomizeOpponentHand ?? true
  const randomizeSelfPile = opts.randomizeSelfPile ?? true
  const opp = (1 - who) as 0 | 1

  const players = state.players.map((p, idx) => {
    if (idx === who) {
      if (!randomizeSelfPile || p.pile.length <= 1) return p
      // Known hand; unknown pile order → shuffle pile only.
      return { ...p, pile: shuffled(p.pile, rng) } as PlayerState
    }
    // Opponent side.
    if (!randomizeOpponentHand) {
      if (p.pile.length <= 1) return p
      return { ...p, pile: shuffled(p.pile, rng) } as PlayerState
    }
    return determinizeOpponent(p, rng)
  }) as unknown as readonly [PlayerState, PlayerState]

  return { ...state, players } as GameState
}

/**
 * Re-sample the opponent's hidden hand/pile from the combined remaining pool.
 * Hand size is preserved; which specific cards land in hand vs pile (and pile
 * order) are randomised.
 */
function determinizeOpponent(p: PlayerState, rng: Rng): PlayerState {
  const handSize = p.hands.length
  const pool = shuffled([...p.hands, ...p.pile], rng)
  if (pool.length === 0) return p
  const newHands = pool.slice(0, handSize)
  const newPile = pool.slice(handSize)
  return { ...p, hands: newHands, pile: newPile } as PlayerState
}

/**
 * Draw K determinizations. Each call advances the shared RNG so the worlds are
 * distinct (framework §4.2: "对每个可能手牌世界各跑一次").
 */
export function sampleDeterminizations(
  state: GameState,
  who: 0 | 1,
  k: number,
  opts: RandomizeOptions = {},
): GameState[] {
  const rng = opts.rng ?? makeLcg((Date.now() & 0x7fffffff) || 1)
  const out: GameState[] = []
  for (let i = 0; i < k; i++) {
    out.push(randomizeUnknowns(state, who, { ...opts, rng }))
  }
  return out
}
