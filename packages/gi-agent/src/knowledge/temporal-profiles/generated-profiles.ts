// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Static temporal profile artifact.
 *
 * Generated at build time by src/knowledge/temporal-profiles/generate-profiles.ts.
 * Running `pnpm exec gnx src/knowledge/temporal-profiles/generate-profiles.ts` produces
 * generated-profiles.json which this module imports.
 *
 * If the JSON file is absent (e.g. in environments where build tools haven't run),
 * this module returns an empty array and the registry falls back to runtime source
 * parsing in dev mode, or throws in strict mode.
 */

import type { TemporalCardProfile } from "./types.js"
import rawProfiles from "./generated-profiles.json" with { type: "json" }

interface GeneratedProfileManifest {
  schema_version: string
  generated_at: string
  source_count: number
  profile_count: number
  profiles: TemporalCardProfile[]
  errors?: string[]
}

const manifest = rawProfiles as GeneratedProfileManifest

export const GENERATED_TEMPORAL_PROFILES: TemporalCardProfile[] = manifest.profiles ?? []
export const GENERATED_PROFILE_COUNT = manifest.profile_count ?? 0
export const GENERATED_AT = manifest.generated_at ?? null
export const GENERATED_ERRORS = manifest.errors ?? []
