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
 * V30 Stage 1.B — Sentinel-based dynamic fingerprint extractor.
 *
 * STATUS: deferred placeholder.
 *
 * RATIONALE:
 *   The original V30 plan called for running `ActionPreviewer.modifyAndPreview`
 *   on synthetic sentinel `GameState`s to derive each card/skill's dynamic
 *   effects (damage amount, dice gen, draws, creates, ...) once at artifact
 *   generation time.
 *
 *   On audit (2026-06-18) we discovered the runtime already emits the same
 *   `PreviewData[]` for every concrete decision point via
 *   `Game.notify` → `ActionPreviewer`, and `candidate-semantics.ts` already
 *   consumes it. Re-running it offline on synthetic states is therefore
 *   redundant and would require reconstructing legal `GameState`s for every
 *   card × every legal context — which is more complex than just letting the
 *   live preview do its job.
 *
 *   Therefore stage 1 only emits **static** fingerprint fields (kind, cost,
 *   tags, references, character/entity meta) from the resolved `GameData`.
 *   Dynamic fields (damage / heal / dice_gen / draws / creates) are populated
 *   on the fly by stage 2's `PreviewMutationVector`.
 *
 * WHEN TO REVISIT:
 *   - If we ever need a static-only "card encyclopedia" usable without a live
 *     `Game` instance (e.g. for deck-builder UI or LLM preprocessing), wire
 *     up sentinel runs here. The infrastructure is `new Game({...}).preview`
 *     after a synthetic `prepareInitialState`. See `core/src/game.ts:1132`.
 *   - If preview vectors prove too noisy and we want a deterministic
 *     "expected mutation" baseline per definition_id, run sentinels on a
 *     canonical state and store the average mutation vector here.
 *
 * For now this module exists only to make the staging contract explicit and
 * to keep `fingerprint-lake.ts` callers from importing a missing file.
 */

import type { EntityFingerprint } from "./types.js"

/**
 * Future hook — currently a no-op identity transform.
 *
 * Will be replaced by sentinel-driven enrichment when (and only when) we
 * have a concrete need that runtime preview cannot serve.
 */
export function enrichWithSentinelPreviews(
  fingerprints: EntityFingerprint[],
): EntityFingerprint[] {
  return fingerprints
}
