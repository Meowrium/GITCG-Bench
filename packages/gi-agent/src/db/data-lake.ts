/**
 * DataLake — Local SQLite storage for labeled (state, action, outcome) triples.
 *
 * Stores feature vectors extracted from game replays, paired with win/loss
 * labels, for offline logistic regression training.
 *
 * Uses better-sqlite3 for synchronous, single-file persistence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { ScoringFeatureVector, LabeledSample } from "../learning/scoring/feature-extractor.js";
import { FeatureExtractor } from "../learning/scoring/feature-extractor.js";
import type { StateObservation } from "../learning/encoder/state-observation.js";

// V30 Stage 2.E hot-fix —
// Resolve a SQLite Database constructor across runtimes:
//   1. Bun: prefer the built-in `bun:sqlite` (no native compilation needed,
//      and better-sqlite3 native bindings often fail to load under Bun).
//   2. Node: fall back to `better-sqlite3` (a native module, requires
//      prebuild-install or local compile).
//   3. Otherwise: signal unavailable → caller will use JSON fallback.
//
// Both implementations expose Statement.{run,get,all} and Database.{prepare,
// exec,pragma,transaction,close} which is all DataLake uses.
//
// IMPORTANT: this module is ESM (`"type": "module"`). Bare `require` is
// undefined under node ESM. We use `createRequire(import.meta.url)` so the
// resolution starts from this file's location, picking up the package's own
// `node_modules/better-sqlite3` (a pnpm symlink) regardless of NODE_PATH.
// Without this, gnx (which sets NODE_PATH=node_modules/.pnpm/node_modules)
// silently falls back to JSON storage even when better-sqlite3 is installed.
const requireFromHere = createRequire(import.meta.url);

let DatabaseCtor: typeof BetterSqlite3 | undefined;
let dbBackendKind: "better-sqlite3" | "bun:sqlite" | "none" = "none";
let dbBackendError: string | undefined;

if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  try {
    const mod = requireFromHere("bun:sqlite") as { Database: typeof BetterSqlite3 };
    DatabaseCtor = mod.Database;
    dbBackendKind = "bun:sqlite";
  } catch (err) {
    dbBackendError = `bun:sqlite: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}
if (!DatabaseCtor) {
  try {
    DatabaseCtor = requireFromHere("better-sqlite3") as typeof BetterSqlite3;
    dbBackendKind = "better-sqlite3";
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    dbBackendError = dbBackendError ? `${dbBackendError}; better-sqlite3: ${msg}` : `better-sqlite3: ${msg}`;
  }
}

/** Which SQLite backend (or none) is currently in use. Exposed for diagnostics. */
export function dataLakeBackend(): "better-sqlite3" | "bun:sqlite" | "none" {
  return dbBackendKind;
}

/** Last error from backend resolution, if any. Exposed for diagnostics. */
export function dataLakeBackendError(): string | undefined {
  return dbBackendError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL,
  round       INTEGER NOT NULL,
  turn        INTEGER NOT NULL,
  player      INTEGER NOT NULL CHECK(player IN (0, 1)),
  action_case TEXT NOT NULL,
  features    TEXT NOT NULL,          -- JSON array of base ScoringFeatureVector floats
  features_ext TEXT,                  -- V30 Stage 2.E: JSON array of FeatureExtension floats (nullable for legacy rows)
  state_observation TEXT,             -- V30 Stage 3.B: JSON-encoded StateObservation (nullable for legacy rows)
  next_state_observation TEXT,        -- V31 F6: JSON-encoded StateObservation of the state AFTER the chosen action (for TD(λ)/V(s_next) bootstrap; nullable)
  label       REAL NOT NULL,          -- 1.0 = won, 0.0 = lost
  source      TEXT NOT NULL DEFAULT 'replay',  -- 'replay', 'self_play', 'human_critic'
  weight      REAL NOT NULL DEFAULT 1.0,       -- importance weight for training
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_samples_game ON samples(game_id);
CREATE INDEX IF NOT EXISTS idx_samples_source ON samples(source);
`;

const MIGRATION_ADD_WEIGHT = `
ALTER TABLE samples ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;
`;

/** V30 Stage 2.E: add features_ext column to existing databases. */
const MIGRATION_ADD_FEATURES_EXT = `
ALTER TABLE samples ADD COLUMN features_ext TEXT;
`;

/** V30 Stage 3.B: add state_observation column to existing databases. */
const MIGRATION_ADD_STATE_OBSERVATION = `
ALTER TABLE samples ADD COLUMN state_observation TEXT;
`;

/** V31 F6: add next_state_observation column for TD(λ)/V(s_next) bootstrap. */
const MIGRATION_ADD_NEXT_STATE_OBSERVATION = `
ALTER TABLE samples ADD COLUMN next_state_observation TEXT;
`;

// ─────────────────────────────────────────────────────────────────────────────
// DataLake
// ─────────────────────────────────────────────────────────────────────────────

export interface SampleRecord {
  gameId: string;
  round: number;
  turn: number;
  player: 0 | 1;
  actionCase: string;
  features: number[];
  /**
   * V30 Stage 2.E — Optional FeatureExtension array (PreviewMutationVector +
   * Fingerprint). When absent / null, the sample is "legacy" and the trainer
   * treats the extension contribution as zero.
   */
  featuresExt?: number[] | null;
  /**
   * V30 Stage 3.B — Optional `StateObservation` for the encoder pipeline.
   * Persisted as JSON; absence means the sample was captured before the
   * encoder column existed and should be ignored by encoder training.
   */
  stateObservation?: StateObservation | null;
  /**
   * V31 F6 — Optional `StateObservation` of the state *after* the chosen action
   * (and the opponent's 1-round response), used to bootstrap the V(s) target
   * with `r + γ·V(s_next)` (TD(λ)). Absence falls back to the terminal-label
   * proxy in the Python trainer.
   */
  nextStateObservation?: StateObservation | null;
  label: number;
  source: "replay" | "self_play" | "human_critic";
  /** Sample weight for importance-weighted training (default 1.0). */
  weight?: number;
}

export class DataLake {
  private db: BetterSqlite3.Database | null = null;
  private insertStmt: BetterSqlite3.Statement | null = null;
  private fallbackPath: string | null = null;
  private fallbackRecords: SampleRecord[] | null = null;

  constructor(dbPath: string) {
    if (!DatabaseCtor) {
      this.fallbackPath = resolve(
        dbPath.endsWith(".json") ? dbPath : `${dbPath}.json`,
      );
      mkdirSync(dirname(this.fallbackPath), { recursive: true });
      this.fallbackRecords = this.loadFallbackRecords();
      const reason = dbBackendError ?? "no SQLite backend resolved";
      console.warn(
        `[DataLake] Falling back to JSON storage at ${this.fallbackPath}: ${reason}`,
      );
      return;
    }
    try {
      // Ensure the parent directory exists before opening — better-sqlite3
      // raises "Cannot open database because the directory does not exist"
      // and the catch block below silently demotes us to JSON fallback,
      // which surprises callers who set up `dbPath` to a fresh subdirectory.
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
      this.db = new DatabaseCtor(dbPath);
      // V30 Stage 2.E hot-fix — performance pragmas for self-play write loops.
      //
      // WAL + synchronous=NORMAL gives ~6000× speed-up on cross-fs mounts
      // (e.g. WSL2 → NTFS) and ~10× even on native fs, vs. SQLite defaults.
      // We trade durability against the OS crashing for ~10ms of recent
      // writes; for self-play sample collection (which is regeneratable)
      // this is well worth it. See `docs/v30-feature-free-learning-plan.md`
      // §16 for the benchmark that motivated these settings.
      const execPragma = (sql: string) => {
        try {
          if (typeof (this.db as unknown as { pragma?: unknown }).pragma === "function") {
            this.db!.pragma(sql);
          } else {
            this.db!.exec(`PRAGMA ${sql}`);
          }
        } catch {
          // pragma failures are non-fatal
        }
      };
      execPragma("journal_mode = WAL");
      execPragma("synchronous = NORMAL");
      execPragma("temp_store = MEMORY");
      this.db.exec(SCHEMA_SQL);

      // Migration: add weight column if not present
      try {
        this.db.exec(MIGRATION_ADD_WEIGHT);
      } catch {
        // column already exists, ignore
      }

      // V30 Stage 2.E: migration for features_ext column
      try {
        this.db.exec(MIGRATION_ADD_FEATURES_EXT);
      } catch {
        // column already exists, ignore
      }

      // V30 Stage 3.B: migration for state_observation column
      try {
        this.db.exec(MIGRATION_ADD_STATE_OBSERVATION);
      } catch {
        // column already exists, ignore
      }

      // V31 F6: migration for next_state_observation column
      try {
        this.db.exec(MIGRATION_ADD_NEXT_STATE_OBSERVATION);
      } catch {
        // column already exists, ignore
      }

      this.insertStmt = this.db.prepare(`
        INSERT INTO samples (game_id, round, turn, player, action_case, features, features_ext, state_observation, next_state_observation, label, source, weight)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch (error) {
      this.db = null;
      this.insertStmt = null;
      this.fallbackPath = resolve(
        dbPath.endsWith(".json") ? dbPath : `${dbPath}.json`,
      );
      mkdirSync(dirname(this.fallbackPath), { recursive: true });
      this.fallbackRecords = this.loadFallbackRecords();
      const reason =
        error instanceof Error
          ? error.message.split("\n")[0]
          : String(error);
      console.warn(
        `[DataLake] Falling back to JSON storage at ${this.fallbackPath}: ${reason}`,
      );
    }
  }

  /** Insert a single sample. */
  insert(record: SampleRecord): void {
    if (this.insertStmt) {
      this.insertStmt.run(
        record.gameId,
        record.round,
        record.turn,
        record.player,
        record.actionCase,
        JSON.stringify(record.features),
        record.featuresExt && record.featuresExt.length > 0
          ? JSON.stringify(record.featuresExt)
          : null,
        record.stateObservation
          ? JSON.stringify(record.stateObservation)
          : null,
        record.nextStateObservation
          ? JSON.stringify(record.nextStateObservation)
          : null,
        record.label,
        record.source,
        record.weight ?? 1.0,
      );
      return;
    }

    const records = this.ensureFallbackRecords();
    records.push(record);
    this.flushFallbackRecords();
  }

  /** Bulk insert (wrapped in transaction). */
  insertBatch(records: SampleRecord[]): number {
    if (this.db) {
      const txn = this.db.transaction((recs: SampleRecord[]) => {
        for (const r of recs) {
          this.insert(r);
        }
        return recs.length;
      });
      return txn(records);
    }

    const current = this.ensureFallbackRecords();
    current.push(...records);
    this.flushFallbackRecords();
    return records.length;
  }

  /** Load all samples as LabeledSample for training. */
  loadAll(): LabeledSample[] {
    if (!this.db) {
      return this.ensureFallbackRecords().map((row) => ({
        features: FeatureExtractor.fromArray(row.features),
        label: row.label,
        weight: row.weight ?? 1.0,
        featuresExt: row.featuresExt ?? null,
      }));
    }

    const rows = this.db
      .prepare("SELECT features, features_ext, label, weight FROM samples")
      .all() as Array<{
      features: string;
      features_ext: string | null;
      label: number;
      weight: number;
    }>;
    return rows.map((row) => {
      const arr = JSON.parse(row.features) as number[];
      const extArr = row.features_ext ? (JSON.parse(row.features_ext) as number[]) : null;
      return {
        features: FeatureExtractor.fromArray(arr),
        label: row.label,
        weight: row.weight ?? 1.0,
        featuresExt: extArr,
      };
    });
  }

  /** Load samples filtered by source. */
  loadBySource(source: "replay" | "self_play" | "human_critic"): LabeledSample[] {
    if (!this.db) {
      return this.ensureFallbackRecords()
        .filter((row) => row.source === source)
        .map((row) => ({
          features: FeatureExtractor.fromArray(row.features),
          label: row.label,
          weight: row.weight ?? 1.0,
          featuresExt: row.featuresExt ?? null,
        }));
    }

    const rows = this.db
      .prepare(
        "SELECT features, features_ext, label, weight FROM samples WHERE source = ?",
      )
      .all(source) as Array<{
      features: string;
      features_ext: string | null;
      label: number;
      weight: number;
    }>;
    return rows.map((row) => ({
      features: FeatureExtractor.fromArray(JSON.parse(row.features)),
      label: row.label,
      weight: row.weight ?? 1.0,
      featuresExt: row.features_ext ? (JSON.parse(row.features_ext) as number[]) : null,
    }));
  }

  /** Count samples by source. */
  stats(): Record<string, number> {
    if (!this.db) {
      const result: Record<string, number> = { total: 0 };
      for (const row of this.ensureFallbackRecords()) {
        result[row.source] = (result[row.source] ?? 0) + 1;
        result.total += 1;
      }
      return result;
    }

    const rows = this.db
      .prepare("SELECT source, COUNT(*) as cnt FROM samples GROUP BY source")
      .all() as Array<{ source: string; cnt: number }>;
    const result: Record<string, number> = { total: 0 };
    for (const row of rows) {
      result[row.source] = row.cnt;
      result.total += row.cnt;
    }
    return result;
  }

  close(): void {
    this.db?.close();
  }

  /**
   * V30 Stage 3.B — Load all samples that have a `state_observation` column,
   * yielding `(observation, label, weight, gameId, sampleIndex)` tuples for
   * the encoder trainer.
   */
  loadStateObservations(): Array<{
    gameId: string;
    round: number;
    turn: number;
    player: 0 | 1;
    observation: StateObservation;
    nextObservation: StateObservation | null;
    label: number;
    weight: number;
  }> {
    if (!this.db) {
      const out: Array<{
        gameId: string;
        round: number;
        turn: number;
        player: 0 | 1;
        observation: StateObservation;
        nextObservation: StateObservation | null;
        label: number;
        weight: number;
      }> = [];
      for (const row of this.ensureFallbackRecords()) {
        if (!row.stateObservation) continue;
        out.push({
          gameId: row.gameId,
          round: row.round,
          turn: row.turn,
          player: row.player,
          observation: row.stateObservation,
          nextObservation: row.nextStateObservation ?? null,
          label: row.label,
          weight: row.weight ?? 1.0,
        });
      }
      return out;
    }

    const rows = this.db
      .prepare(
        "SELECT game_id, round, turn, player, state_observation, next_state_observation, label, weight FROM samples WHERE state_observation IS NOT NULL ORDER BY id",
      )
      .all() as Array<{
        game_id: string;
        round: number;
        turn: number;
        player: number;
        state_observation: string;
        next_state_observation: string | null;
        label: number;
        weight: number;
      }>;
    return rows.map((r) => ({
      gameId: r.game_id,
      round: r.round,
      turn: r.turn,
      player: (r.player === 1 ? 1 : 0) as 0 | 1,
      observation: JSON.parse(r.state_observation) as StateObservation,
      nextObservation: r.next_state_observation
        ? (JSON.parse(r.next_state_observation) as StateObservation)
        : null,
      label: r.label,
      weight: r.weight ?? 1.0,
    }));
  }

  /** V30 Stage 3.B — count samples that include a state_observation. */
  countStateObservations(): number {
    if (!this.db) {
      let n = 0;
      for (const row of this.ensureFallbackRecords()) {
        if (row.stateObservation) n++;
      }
      return n;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM samples WHERE state_observation IS NOT NULL")
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  private loadFallbackRecords(): SampleRecord[] {
    if (!this.fallbackPath || !existsSync(this.fallbackPath)) {
      return [];
    }

    const raw = readFileSync(this.fallbackPath, "utf8").trim();
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as SampleRecord[];
  }

  private ensureFallbackRecords(): SampleRecord[] {
    if (!this.fallbackRecords) {
      this.fallbackRecords = [];
    }
    return this.fallbackRecords;
  }

  private flushFallbackRecords(): void {
    if (!this.fallbackPath || !this.fallbackRecords) {
      return;
    }
    writeFileSync(
      this.fallbackPath,
      `${JSON.stringify(this.fallbackRecords, null, 2)}\n`,
      "utf8",
    );
  }
}
