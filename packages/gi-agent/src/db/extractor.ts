/**
 * Extractor — Pull game replay data from Server PostgreSQL
 * and convert to labeled training samples.
 *
 * Connects to the game server's PostgreSQL database, reads completed games
 * with known winners, deserializes the game state log, and extracts
 * (state, action, win/loss) triples for the DataLake.
 *
 * Note: PostgreSQL connection details should be provided via environment
 * variables: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE.
 * The actual extraction requires the `pg` package (peer dependency).
 *
 * This module is a STUB — the supervised data pipeline will be wired up
 * once game replay data is available on the server.
 */

import type { SampleRecord } from "./data-lake.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GameRow {
  id: string;
  winnerId: string | null;
  data: unknown;   // JSON blob containing serialized game log
  createdAt: string;
}

export interface ExtractionResult {
  gamesProcessed: number;
  samplesExtracted: number;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor
// ─────────────────────────────────────────────────────────────────────────────

export class ReplayExtractor {
  /**
   * Extract samples from a single game's serialized log.
   *
   * This is the core logic that will be called per-game once the
   * PostgreSQL pipeline is connected. For now it defines the interface.
   *
   * @param gameId    Unique game identifier.
   * @param gameData  The serialized game log (from Game.data JSON column).
   * @param winnerId  The player who won (mapped to 0 or 1).
   * @param playerMap Mapping from userId to player index (0 or 1).
   */
  extractFromGameLog(
    gameId: string,
    gameData: unknown,
    winnerPlayerIndex: 0 | 1,
    // The actual implementation will use:
    //   import { deserializeGameStateLog } from "@gi-tcg/core/src/log.js";
    //   to reconstruct state-action pairs.
  ): SampleRecord[] {
    // STUB: will be implemented when game replay data is available.
    // The flow will be:
    // 1. deserializeGameStateLog(coreGameData, serializedLog) → GameStateLogEntry[]
    // 2. For each entry with canResume=true, extract the state + action chosen
    // 3. Use FeatureExtractor.extract(digest, candidate) to get feature vector
    // 4. Label = 1.0 if the acting player == winnerPlayerIndex, else 0.0
    // 5. Return SampleRecord[]

    console.warn(`[ReplayExtractor] STUB: extractFromGameLog called for game ${gameId}`);
    return [];
  }

  /**
   * Batch extraction placeholder.
   *
   * Once connected to PostgreSQL, this will:
   * 1. SELECT id, "winnerId", data FROM "Game" WHERE "winnerId" IS NOT NULL LIMIT $batchSize OFFSET $offset
   * 2. Map winnerId → player index via PlayerOnGames join
   * 3. Call extractFromGameLog for each game
   * 4. Return aggregated SampleRecord[]
   */
  async extractBatch(
    _batchSize: number = 100,
    _offset: number = 0,
  ): Promise<ExtractionResult> {
    console.warn("[ReplayExtractor] STUB: extractBatch called — no PostgreSQL connection configured.");
    return {
      gamesProcessed: 0,
      samplesExtracted: 0,
      errors: ["PostgreSQL connection not yet configured. Set PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE."],
    };
  }
}
