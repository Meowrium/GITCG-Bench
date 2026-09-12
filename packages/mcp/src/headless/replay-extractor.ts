// Copyright (C) 2025 Guyutongxue
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
 * Post-game replay extractor.
 *
 * Reads both players' `p{0,1}_llm.jsonl` conversation logs and the
 * `headless.log` from a single game, then produces a single
 * `game_replay.json` with a unified chronological timeline of both
 * players' decisions, reasoning, and state changes.
 *
 * Usage:
 *   import { generateGameReplay } from "./replay-extractor.js";
 *   generateGameReplay(gameDir, { matchupId, deck0Name, ... });
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

interface JsonlEntry {
  ts: string;
  type: string;
  [key: string]: unknown;
}

interface CharacterSnapshot {
  id: number;
  definition_id: number;
  name: string | null;
  hp: number;
  max_hp: number;
  energy: number;
  max_energy: number;
  alive: boolean;
  aura: number;
}

interface StateSnapshot {
  self: {
    active_character_id: number;
    hand_count: number;
    characters: CharacterSnapshot[];
    hand_card_definition_ids: number[];
  } | null;
  opponent: {
    active_character_id: number;
    hand_count: number;
    characters: CharacterSnapshot[];
  } | null;
  dice: {
    dice: number[];
    dice_distribution: Record<string, number>;
    omni_count: number;
  } | null;
  lethal_info: unknown | null;
}

interface CharacterDelta {
  id: number;
  definition_id: number;
  name: string | null;
  alive: boolean;
  hp_before: number;
  hp_after: number;
  hp_delta: number;
  energy_before: number;
  energy_after: number;
  energy_delta: number;
  max_hp: number;
  max_energy: number;
  aura_before: number;
  aura_after: number;
  shield_after: number;
}

interface CandidateAction {
  candidate_id: string;
  action_case: string;
  is_fast?: boolean;
  damage_estimate?: number;
  kills?: unknown;
  tags?: string[];
  notes?: string[];
  cost?: Record<string, unknown>;
  reaction_value?: number;
  tempo_value?: number;
  survival_risk?: number;
}

/**
 * Slim down a candidate to only the fields useful for post-game review.
 * Drops the verbose `notes` array (which contains full card descriptions)
 * and `cost` to keep the replay file compact.
 */
function slimCandidate(c: CandidateAction): CandidateAction {
  return {
    candidate_id: c.candidate_id,
    action_case: c.action_case,
    is_fast: c.is_fast,
    damage_estimate: c.damage_estimate,
    kills: c.kills,
    tags: c.tags,
    reaction_value: c.reaction_value,
    tempo_value: c.tempo_value,
    survival_risk: c.survival_risk,
  };
}

interface TimelineEvent {
  ts: string;
  who: 0 | 1;
  round: number;
  tool: string;
  action_label: string;
  reasoning: string | null;
  args: Record<string, unknown> | null;
  state: StateSnapshot | null;
  candidates: CandidateAction[] | null;
  chosen_candidate: CandidateAction | null;
  character_deltas: CharacterDelta[] | null;
  action_effects: unknown[] | null;
  opponent_action_effects: unknown[] | null;
  error: string | null;
}

interface DeckInfo {
  deck_code: string;
  characters: Array<{ definition_id: number; name: string | null }>;
  cards: Array<{ definition_id: number; name: string | null; count: number }>;
}

export interface GameReplayMeta {
  matchupId: string;
  gameIndex: number;
  deck0Name: string;
  deck1Name: string;
  deck0Code: string;
  deck1Code: string;
  /** Data versions used by the pre-game sandbox analysis, if explicitly configured. */
  deck0Version?: string;
  deck1Version?: string;
  /** Rules/data version used by the headless game. */
  gameVersion?: string;
  modelP0: string;
  modelP1: string;
  winner: number | null;
  error: string | null;
  elapsedMs: number;
}

export interface GameReplay {
  meta: GameReplayMeta;
  decks: {
    p0: DeckInfo | null;
    p1: DeckInfo | null;
  };
  timeline: TimelineEvent[];
  final_results: {
    p0: Record<string, unknown> | null;
    p1: Record<string, unknown> | null;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseJsonl(filePath: string): JsonlEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonlEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JsonlEntry => e !== null);
}

/**
 * Safely parse a tool_result's `result` field, which may be a JSON string
 * or an already-parsed object.
 */
function parseToolResult(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return null;
}

/**
 * Extract a compact state snapshot from a TurnDigestV1.
 */
function extractStateSnapshot(digest: Record<string, unknown> | null): StateSnapshot | null {
  if (!digest) return null;
  const selfSummary = digest.self_summary as Record<string, unknown> | undefined;
  const oppSummary = digest.opponent_summary as Record<string, unknown> | undefined;
  const resourceSummary = digest.resource_summary as Record<string, unknown> | undefined;
  const lethalInfo = digest.lethal_info ?? null;

  return {
    self: selfSummary
      ? {
          active_character_id: (selfSummary.active_character_id as number) ?? 0,
          hand_count: (selfSummary.hand_count as number) ?? 0,
          characters: (selfSummary.characters as CharacterSnapshot[]) ?? [],
          hand_card_definition_ids: (selfSummary.hand_card_definition_ids as number[]) ?? [],
        }
      : null,
    opponent: oppSummary
      ? {
          active_character_id: (oppSummary.active_character_id as number) ?? 0,
          hand_count: (oppSummary.hand_count as number) ?? 0,
          characters: (oppSummary.characters as CharacterSnapshot[]) ?? [],
        }
      : null,
    dice: resourceSummary
      ? {
          dice: (resourceSummary.dice as number[]) ?? [],
          dice_distribution: (resourceSummary.dice_distribution as Record<string, number>) ?? {},
          omni_count: (resourceSummary.omni_count as number) ?? 0,
        }
      : null,
    lethal_info: lethalInfo,
  };
}

/**
 * Build a human-readable action label from the chosen candidate.
 */
function formatCandidateLabel(c: CandidateAction | null, actionIndex: number | null): string {
  if (!c) return `Action #${actionIndex ?? "?"}`;
  switch (c.action_case) {
    case "useSkill":
      return `Use Skill (cand: ${c.candidate_id}, dmg: ${c.damage_estimate ?? 0})`;
    case "playCard":
      return `Play Card (cand: ${c.candidate_id})`;
    case "switchActive":
      return `Switch Active (cand: ${c.candidate_id})`;
    case "elementalTuning":
      return `Elemental Tuning (cand: ${c.candidate_id})`;
    case "declareEnd":
      return "Declare End";
    default:
      return `${c.action_case} (cand: ${c.candidate_id})`;
  }
}

/**
 * Look up the chosen candidate from candidate_actions by action_index.
 * action_index is 1-indexed; candidate_id is "cand_{action_index}".
 */
function findChosenCandidate(
  candidates: CandidateAction[] | null,
  actionIndex: number | null,
): CandidateAction | null {
  if (!candidates || actionIndex == null) return null;
  // Try exact candidate_id match
  const targetId = `cand_${actionIndex}`;
  const byId = candidates.find((c) => c.candidate_id === targetId);
  if (byId) return byId;
  // Fallback: array index (0-indexed, so action_index - 1)
  if (actionIndex >= 1 && actionIndex <= candidates.length) {
    return candidates[actionIndex - 1] ?? null;
  }
  return null;
}

/**
 * Extract deck info from the first get_player{N}_deck tool_result in a jsonl.
 */
function extractDeckInfo(entries: JsonlEntry[], toolName: string): DeckInfo | null {
  for (const e of entries) {
    if (e.type === "tool_result" && e.tool === toolName) {
      const parsed = parseToolResult(e.result);
      if (parsed) {
        return {
          deck_code: (parsed.deck_code as string) ?? "",
          characters: (parsed.characters as DeckInfo["characters"]) ?? [],
          cards: (parsed.cards as DeckInfo["cards"]) ?? [],
        };
      }
    }
  }
  return null;
}

/**
 * Extract final_result from a jsonl.
 */
function extractFinalResult(entries: JsonlEntry[]): Record<string, unknown> | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "final_result") {
      return (e.game_result as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

// ─── Core Extraction ──────────────────────────────────────────────────────

interface ExtractionContext {
  currentDigest: Record<string, unknown> | null;
  currentReasoning: string | null;
  currentCandidates: CandidateAction[] | null;
}

/**
 * Walk a single player's jsonl and extract decision events.
 */
function extractPlayerEvents(
  jsonlPath: string,
  who: 0 | 1,
): { events: TimelineEvent[]; deck: DeckInfo | null; finalResult: Record<string, unknown> | null } {
  const entries = parseJsonl(jsonlPath);
  const events: TimelineEvent[] = [];
  const ctx: ExtractionContext = {
    currentDigest: null,
    currentReasoning: null,
    currentCandidates: null,
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "llm_response": {
        const content = entry.content as string | null;
        if (content) {
          ctx.currentReasoning = content;
        }
        break;
      }

      case "tool_result": {
        const tool = entry.tool as string;
        const args = (entry.args as Record<string, unknown>) ?? null;
        const parsed = parseToolResult(entry.result);

        // Update digest from wait_for_my_turn
        if (tool === "wait_for_my_turn" && parsed) {
          const digest = parsed.digest as Record<string, unknown> | undefined;
          if (digest) {
            ctx.currentDigest = digest;
            const rawCands = digest.candidate_actions as CandidateAction[] | undefined;
            ctx.currentCandidates = rawCands ? rawCands.map(slimCandidate) : null;
          }

          // If opponent did things, record as an opponent-actions event
          const opponentEffects = parsed.action_effects as unknown[];
          if (Array.isArray(opponentEffects) && opponentEffects.length > 0) {
            const round = (ctx.currentDigest?.round as number) ?? 0;
            events.push({
              ts: entry.ts,
              who,
              round,
              tool: "wait_for_my_turn",
              action_label: `Round ${round} - opponent acted`,
              reasoning: ctx.currentReasoning,
              args: null,
              state: extractStateSnapshot(ctx.currentDigest),
              candidates: ctx.currentCandidates,
              chosen_candidate: null,
              character_deltas: null,
              action_effects: null,
              opponent_action_effects: opponentEffects,
              error: null,
            });
          }
          ctx.currentReasoning = null;
          continue;
        }

        // Update digest from choose_action (fast action refresh)
        if (tool === "choose_action" && parsed) {
          const digest = parsed.digest as Record<string, unknown> | undefined;
          if (digest) {
            ctx.currentDigest = digest;
            const rawCands = digest.candidate_actions as CandidateAction[] | undefined;
            ctx.currentCandidates = rawCands ? rawCands.map(slimCandidate) : null;
          }
        }

        // Decision-type tools
        const decisionTools = new Set([
          "choose_action",
          "switch_hands",
          "choose_active",
          "reroll_dice",
          "elemental_tuning",
        ]);
        if (!decisionTools.has(tool)) continue;

        const round = (ctx.currentDigest?.round as number) ?? 0;

        // Build action label
        let actionLabel = tool;
        let chosenCandidate: CandidateAction | null = null;
        if (tool === "choose_action") {
          const actionIndex = (args?.action_index as number) ?? null;
          chosenCandidate = findChosenCandidate(ctx.currentCandidates, actionIndex);
          actionLabel = formatCandidateLabel(chosenCandidate, actionIndex);
        } else if (tool === "switch_hands") {
          const ids = (args?.removed_hand_ids as number[]) ?? [];
          actionLabel = `Switch ${ids.length} card(s)`;
        } else if (tool === "choose_active") {
          const charId = args?.character_id ?? args?.activeCharacterId;
          actionLabel = `Choose active (ID=${charId})`;
        } else if (tool === "reroll_dice") {
          const dice = (args?.dice_to_reroll as number[]) ?? [];
          actionLabel = `Reroll ${dice.length} dice`;
        } else if (tool === "elemental_tuning") {
          actionLabel = "Elemental Tuning";
        }

        // Extract effects from action_feedback
        const actionFeedback = parsed?.action_feedback as Record<string, unknown> | undefined;
        const characterDeltas = (actionFeedback?.character_deltas as CharacterDelta[]) ?? null;
        const actionEffects = (actionFeedback?.action_effects as unknown[]) ?? null;

        const isError = entry.is_error === true;
        const errorMsg = isError
          ? (parsed?.error as string) ?? (parsed?.message as string) ?? "Tool error"
          : null;

        events.push({
          ts: entry.ts,
          who,
          round,
          tool,
          action_label: actionLabel,
          reasoning: ctx.currentReasoning,
          args,
          state: extractStateSnapshot(ctx.currentDigest),
          candidates: ctx.currentCandidates,
          chosen_candidate: chosenCandidate,
          character_deltas: characterDeltas,
          action_effects: actionEffects,
          opponent_action_effects: null,
          error: errorMsg,
        });

        ctx.currentReasoning = null;
        break;
      }
    }
  }

  const deck = extractDeckInfo(entries, who === 0 ? "get_player0_deck" : "get_player1_deck");
  const finalResult = extractFinalResult(entries);
  return { events, deck, finalResult };
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface GenerateReplayOptions {
  gameDir: string;
  meta: GameReplayMeta;
}

/**
 * Generate a `game_replay.json` from a game's output directory.
 *
 * Reads `p0_llm.jsonl` and `p1_llm.jsonl`, extracts a unified timeline,
 * and writes the result to `{gameDir}/game_replay.json`.
 */
export function generateGameReplay(opts: GenerateReplayOptions): GameReplay {
  const { gameDir, meta } = opts;
  const p0Path = join(gameDir, "p0_llm.jsonl");
  const p1Path = join(gameDir, "p1_llm.jsonl");

  const { events: p0Events, deck: p0Deck, finalResult: p0Final } = extractPlayerEvents(p0Path, 0);
  const { events: p1Events, deck: p1Deck, finalResult: p1Final } = extractPlayerEvents(p1Path, 1);

  // Merge by timestamp (both are ISO strings, lexicographic sort = chronological)
  const timeline = [...p0Events, ...p1Events].sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    // Same timestamp: P0 before P1 as a tiebreaker
    return a.who - b.who;
  });

  const replay: GameReplay = {
    meta,
    decks: {
      p0: p0Deck,
      p1: p1Deck,
    },
    timeline,
    final_results: {
      p0: p0Final,
      p1: p1Final,
    },
  };

  const outPath = join(gameDir, "game_replay.json");
  writeFileSync(outPath, JSON.stringify(replay, null, 2), "utf8");

  return replay;
}
