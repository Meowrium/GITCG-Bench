// Copyright (C) 2024-2025 Guyutongxue
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

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type BetterSqlite3 from "better-sqlite3"

let DatabaseCtor: typeof BetterSqlite3 | undefined;
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  try {
    const mod = require("bun:sqlite") as { Database: typeof BetterSqlite3 };
    DatabaseCtor = mod.Database;
  } catch {
    // bun:sqlite not available — fall through
  }
}
if (!DatabaseCtor) {
  try {
    DatabaseCtor = require("better-sqlite3");
  } catch {
    // Native module unavailable — JSON fallback will be used
  }
}
import type {
  BranchEvalSummary,
  CanonicalCombatWindowFingerprint,
  CandidateCombatWindow,
  CombatWindowAnalysisRecord,
  ReplayAlignmentSummary,
  TreeRecord,
  TreeStatus,
  TreeUsageStat,
  TreeValidationRun,
  TreeValidationSummary,
} from "./types.js"

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trees (
  tree_id TEXT PRIMARY KEY,
  source_window_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  source_window_json TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  canonical_fingerprint_json TEXT,
  replay_alignment_json TEXT,
  branch_eval_summary_json TEXT,
  validation_summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_validation_runs (
  run_id TEXT PRIMARY KEY,
  tree_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_usage_stats (
  tree_id TEXT PRIMARY KEY,
  used_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  avg_local_value REAL,
  last_used_at TEXT
);
`

interface TreeLakeFallbackData {
  trees: TreeRecord[]
  validations: TreeValidationRun[]
  usage_stats: TreeUsageStat[]
}

export class TreeLake {
  private db: BetterSqlite3.Database | null = null
  private fallbackPath: string | null = null
  private fallbackData: TreeLakeFallbackData | null = null

  constructor(dbPath: string) {
    if (!DatabaseCtor) {
      this.fallbackPath = resolve(dbPath.endsWith(".json") ? dbPath : `${dbPath}.json`)
      mkdirSync(dirname(this.fallbackPath), { recursive: true })
      this.fallbackData = this.loadFallbackData()
      console.warn(`[TreeLake] Falling back to JSON storage at ${this.fallbackPath}: better-sqlite3 native module unavailable`)
      return
    }
    try {
      this.db = new DatabaseCtor(dbPath)
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
      execPragma("journal_mode = WAL")
      this.db.exec(SCHEMA_SQL)
      ensureColumn(this.db, "trees", "canonical_fingerprint_json", "TEXT")
      ensureColumn(this.db, "trees", "replay_alignment_json", "TEXT")
      ensureColumn(this.db, "trees", "branch_eval_summary_json", "TEXT")
    } catch (error) {
      this.db = null
      this.fallbackPath = resolve(dbPath.endsWith(".json") ? dbPath : `${dbPath}.json`)
      mkdirSync(dirname(this.fallbackPath), { recursive: true })
      this.fallbackData = this.loadFallbackData()
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error)
      console.warn(`[TreeLake] Falling back to JSON storage at ${this.fallbackPath}: ${reason}`)
    }
  }

  saveDraft(args: {
    sourceWindow: CandidateCombatWindow
    analysis: CombatWindowAnalysisRecord
  }): TreeRecord {
    const now = new Date().toISOString()
    const existing = this.findBySourceWindowId(args.sourceWindow.window_id)
    const treeId = existing?.tree_id ?? `tree_${Date.now()}_${randomUUID()}`
    const record: TreeRecord = {
      tree_id: treeId,
      source_window_id: args.sourceWindow.window_id,
      status: existing?.status ?? "draft",
      source_window: args.sourceWindow,
      analysis: args.analysis,
      canonical_fingerprint: existing?.canonical_fingerprint ?? null,
      replay_alignment: existing?.replay_alignment ?? null,
      branch_eval_summary: existing?.branch_eval_summary ?? null,
      validation_summary: existing?.validation_summary ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }

    if (this.db) {
      this.db.prepare(`
        INSERT INTO trees (
          tree_id,
          source_window_id,
          status,
          source_window_json,
          analysis_json,
          canonical_fingerprint_json,
          replay_alignment_json,
          branch_eval_summary_json,
          validation_summary_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tree_id) DO UPDATE SET
          source_window_id=excluded.source_window_id,
          status=excluded.status,
          source_window_json=excluded.source_window_json,
          analysis_json=excluded.analysis_json,
          canonical_fingerprint_json=excluded.canonical_fingerprint_json,
          replay_alignment_json=excluded.replay_alignment_json,
          branch_eval_summary_json=excluded.branch_eval_summary_json,
          validation_summary_json=excluded.validation_summary_json,
          updated_at=excluded.updated_at
      `).run(
        record.tree_id,
        record.source_window_id,
        record.status,
        JSON.stringify(record.source_window),
        JSON.stringify(record.analysis),
        record.canonical_fingerprint ? JSON.stringify(record.canonical_fingerprint) : null,
        record.replay_alignment ? JSON.stringify(record.replay_alignment) : null,
        record.branch_eval_summary ? JSON.stringify(record.branch_eval_summary) : null,
        record.validation_summary ? JSON.stringify(record.validation_summary) : null,
        record.created_at,
        record.updated_at,
      )
      return record
    }

    const fallback = this.ensureFallbackData()
    const index = fallback.trees.findIndex((item) => item.tree_id === record.tree_id)
    if (index >= 0) {
      fallback.trees[index] = record
    } else {
      fallback.trees.push(record)
    }
    this.flushFallbackData()
    return record
  }

  findBySourceWindowId(sourceWindowId: string): TreeRecord | null {
    if (this.db) {
      const row = this.db
        .prepare("SELECT * FROM trees WHERE source_window_id = ? LIMIT 1")
        .get(sourceWindowId) as Record<string, string> | undefined
      return row ? mapTreeRow(row) : null
    }
    return this.ensureFallbackData().trees.find((item) => item.source_window_id === sourceWindowId) ?? null
  }

  getTree(treeId: string): TreeRecord | null {
    if (this.db) {
      const row = this.db.prepare("SELECT * FROM trees WHERE tree_id = ? LIMIT 1").get(treeId) as Record<string, string> | undefined
      return row ? mapTreeRow(row) : null
    }
    return this.ensureFallbackData().trees.find((item) => item.tree_id === treeId) ?? null
  }

  listTrees(filters: { status?: TreeStatus; limit?: number } = {}): TreeRecord[] {
    if (this.db) {
      const rows = filters.status
        ? this.db
            .prepare("SELECT * FROM trees WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
            .all(filters.status, filters.limit ?? 1000)
        : this.db
            .prepare("SELECT * FROM trees ORDER BY updated_at DESC LIMIT ?")
            .all(filters.limit ?? 1000)
      return (rows as Array<Record<string, string>>).map(mapTreeRow)
    }

    return this.ensureFallbackData().trees
      .filter((item) => (filters.status ? item.status === filters.status : true))
      .slice(0, filters.limit ?? 1000)
  }

  updateValidation(args: {
    treeId: string
    summary: TreeValidationSummary
  }): TreeRecord | null {
    const tree = this.getTree(args.treeId)
    if (!tree) {
      return null
    }
    const nextStatus: TreeStatus = args.summary.status === "validated" ? "validated" : "rejected"
    const updated: TreeRecord = {
      ...tree,
      status: nextStatus,
      validation_summary: args.summary,
      updated_at: new Date().toISOString(),
    }
    if (this.db) {
      this.db.prepare(`
        UPDATE trees
        SET status = ?, validation_summary_json = ?, updated_at = ?
        WHERE tree_id = ?
      `).run(
        updated.status,
        JSON.stringify(args.summary),
        updated.updated_at,
        updated.tree_id,
      )
      return updated
    }
    const fallback = this.ensureFallbackData()
    const index = fallback.trees.findIndex((item) => item.tree_id === args.treeId)
    if (index >= 0) {
      fallback.trees[index] = updated
      this.flushFallbackData()
    }
    return updated
  }

  updateReplayAlignment(args: {
    treeId: string
    replayAlignment: ReplayAlignmentSummary
  }): TreeRecord | null {
    const tree = this.getTree(args.treeId)
    if (!tree) {
      return null
    }
    const updated: TreeRecord = {
      ...tree,
      replay_alignment: args.replayAlignment,
      updated_at: new Date().toISOString(),
    }
    if (this.db) {
      this.db.prepare(`
        UPDATE trees
        SET replay_alignment_json = ?, updated_at = ?
        WHERE tree_id = ?
      `).run(
        JSON.stringify(args.replayAlignment),
        updated.updated_at,
        updated.tree_id,
      )
      return updated
    }
    const fallback = this.ensureFallbackData()
    const index = fallback.trees.findIndex((item) => item.tree_id === args.treeId)
    if (index >= 0) {
      fallback.trees[index] = updated
      this.flushFallbackData()
    }
    return updated
  }

  updateCanonicalFingerprint(args: {
    treeId: string
    canonicalFingerprint: CanonicalCombatWindowFingerprint
  }): TreeRecord | null {
    const tree = this.getTree(args.treeId)
    if (!tree) {
      return null
    }
    const updated: TreeRecord = {
      ...tree,
      canonical_fingerprint: args.canonicalFingerprint,
      updated_at: new Date().toISOString(),
    }
    if (this.db) {
      this.db.prepare(`
        UPDATE trees
        SET canonical_fingerprint_json = ?, updated_at = ?
        WHERE tree_id = ?
      `).run(
        JSON.stringify(args.canonicalFingerprint),
        updated.updated_at,
        updated.tree_id,
      )
      return updated
    }
    const fallback = this.ensureFallbackData()
    const index = fallback.trees.findIndex((item) => item.tree_id === args.treeId)
    if (index >= 0) {
      fallback.trees[index] = updated
      this.flushFallbackData()
    }
    return updated
  }

  updateBranchEvalSummary(args: {
    treeId: string
    branchEvalSummary: BranchEvalSummary
  }): TreeRecord | null {
    const tree = this.getTree(args.treeId)
    if (!tree) {
      return null
    }
    const nextStatus: TreeStatus =
      tree.status === "validated" && args.branchEvalSummary.promote_signal === "promote"
        ? "promoted"
        : tree.status
    const updated: TreeRecord = {
      ...tree,
      status: nextStatus,
      branch_eval_summary: args.branchEvalSummary,
      updated_at: new Date().toISOString(),
    }
    if (this.db) {
      this.db.prepare(`
        UPDATE trees
        SET status = ?, branch_eval_summary_json = ?, updated_at = ?
        WHERE tree_id = ?
      `).run(
        updated.status,
        JSON.stringify(args.branchEvalSummary),
        updated.updated_at,
        updated.tree_id,
      )
      return updated
    }
    const fallback = this.ensureFallbackData()
    const index = fallback.trees.findIndex((item) => item.tree_id === args.treeId)
    if (index >= 0) {
      fallback.trees[index] = updated
      this.flushFallbackData()
    }
    return updated
  }

  insertValidationRun(run: TreeValidationRun): void {
    if (this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO tree_validation_runs (
          run_id,
          tree_id,
          summary_json,
          created_at
        ) VALUES (?, ?, ?, ?)
      `).run(run.run_id, run.tree_id, JSON.stringify(run.summary), run.created_at)
      return
    }
    const fallback = this.ensureFallbackData()
    const index = fallback.validations.findIndex((item) => item.run_id === run.run_id)
    if (index >= 0) {
      fallback.validations[index] = run
    } else {
      fallback.validations.push(run)
    }
    this.flushFallbackData()
  }

  close(): void {
    this.db?.close()
  }

  private loadFallbackData(): TreeLakeFallbackData {
    if (!this.fallbackPath || !existsSync(this.fallbackPath)) {
      return { trees: [], validations: [], usage_stats: [] }
    }
    const raw = readFileSync(this.fallbackPath, "utf8").trim()
    if (!raw) {
      return { trees: [], validations: [], usage_stats: [] }
    }
    return JSON.parse(raw) as TreeLakeFallbackData
  }

  private ensureFallbackData(): TreeLakeFallbackData {
    if (!this.fallbackData) {
      this.fallbackData = { trees: [], validations: [], usage_stats: [] }
    }
    return this.fallbackData
  }

  private flushFallbackData(): void {
    if (!this.fallbackPath || !this.fallbackData) {
      return
    }
    writeFileSync(this.fallbackPath, `${JSON.stringify(this.fallbackData, null, 2)}\n`, "utf8")
  }
}

function mapTreeRow(row: Record<string, string>): TreeRecord {
  return {
    tree_id: row.tree_id,
    source_window_id: row.source_window_id,
    status: row.status as TreeStatus,
    source_window: JSON.parse(row.source_window_json) as CandidateCombatWindow,
    analysis: JSON.parse(row.analysis_json) as CombatWindowAnalysisRecord,
    canonical_fingerprint: row.canonical_fingerprint_json
      ? (JSON.parse(row.canonical_fingerprint_json) as CanonicalCombatWindowFingerprint)
      : null,
    replay_alignment: row.replay_alignment_json
      ? (JSON.parse(row.replay_alignment_json) as ReplayAlignmentSummary)
      : null,
    branch_eval_summary: row.branch_eval_summary_json
      ? (JSON.parse(row.branch_eval_summary_json) as BranchEvalSummary)
      : null,
    validation_summary: row.validation_summary_json
      ? (JSON.parse(row.validation_summary_json) as TreeValidationSummary)
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function ensureColumn(
  db: BetterSqlite3.Database,
  tableName: string,
  columnName: string,
  columnType: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  if (columns.some((column) => column.name === columnName)) {
    return
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`)
}
