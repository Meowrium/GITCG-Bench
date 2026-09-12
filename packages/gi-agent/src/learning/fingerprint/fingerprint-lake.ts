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
 * V30 Stage 1.D — Runtime helper that reads the generated fingerprint
 * artifact and exposes O(1) lookup by definition_id.
 *
 * Single source of truth for downstream feature pipelines (stage 2 +
 * future encoder). Validates schema_version on load to fail fast on
 * artifact drift.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  FINGERPRINT_SCHEMA_VERSION,
  type EntityFingerprint,
  type FingerprintArtifact,
  type FingerprintKind,
} from "./types.js"

export class FingerprintLake {
  private readonly byId: Map<number, EntityFingerprint>
  readonly gameVersion: string
  readonly schemaVersion: number
  readonly entries: ReadonlyArray<EntityFingerprint>

  private constructor(artifact: FingerprintArtifact) {
    if (artifact.schema_version !== FINGERPRINT_SCHEMA_VERSION) {
      throw new Error(
        `[fingerprint-lake] schema mismatch: artifact=v${artifact.schema_version} ` +
          `expected=v${FINGERPRINT_SCHEMA_VERSION}. Regenerate with ` +
          `\`bun run src/learning/fingerprint/cli/generate-fingerprints.ts\`.`,
      )
    }
    this.gameVersion = artifact.game_version
    this.schemaVersion = artifact.schema_version
    this.entries = artifact.entries
    this.byId = new Map()
    for (const e of artifact.entries) {
      this.byId.set(e.definition_id, e)
    }
  }

  /** Construct from an in-memory artifact (for tests / inline use). */
  static fromArtifact(artifact: FingerprintArtifact): FingerprintLake {
    return new FingerprintLake(artifact)
  }

  /** Read artifact JSON from disk. */
  static async fromFile(path: string): Promise<FingerprintLake> {
    const abs = resolve(path)
    const text = await readFile(abs, "utf8")
    const artifact = JSON.parse(text) as FingerprintArtifact
    return new FingerprintLake(artifact)
  }

  get(id: number): EntityFingerprint | undefined {
    return this.byId.get(id)
  }

  has(id: number): boolean {
    return this.byId.has(id)
  }

  /** Filter entries by kind, useful for batch operations. */
  byKind(kind: FingerprintKind): EntityFingerprint[] {
    const out: EntityFingerprint[] = []
    for (const e of this.entries) {
      if (e.kind === kind) out.push(e)
    }
    return out
  }

  size(): number {
    return this.byId.size
  }

  /** Default artifact location relative to gi-agent package root. */
  static defaultArtifactPath(): string {
    return "output/entity-fingerprints.generated.json"
  }
}
