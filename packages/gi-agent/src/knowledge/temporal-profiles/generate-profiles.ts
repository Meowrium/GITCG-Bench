// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Build-time temporal profile generator.
 *
 * Reads support card DSL source files, parses them into TemporalCardProfile
 * objects, and writes a JSON artifact that can be imported at runtime without
 * accessing packages/data/src.
 *
 * Usage:
 *   pnpm exec gnx src/knowledge/temporal-profiles/generate-profiles.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { parseAllDSL } from "./dsl-parser.js"

const SOURCE_FILES: Array<{ path: string; category: string }> = [
  { path: "../../../../data/src/cards/support/ally.ts", category: "support_ally" },
  { path: "../../../../data/src/cards/support/item.ts", category: "support_item" },
  { path: "../../../../data/src/cards/support/place.ts", category: "support_place" },
]

const OUTPUT_PATH = new URL("./generated-profiles.json", import.meta.url)

function main(): void {
  const allProfiles: unknown[] = []
  const errors: string[] = []

  for (const source of SOURCE_FILES) {
    try {
      const content = readFileSync(new URL(source.path, import.meta.url), "utf-8")
      const profiles = parseAllDSL(content)
      allProfiles.push(...profiles)
      console.log(`Parsed ${profiles.length} profiles from ${source.path}`)
    } catch (err) {
      errors.push(`${source.path}: ${String(err)}`)
    }
  }

  const output = {
    schema_version: "temporal_profiles.v1",
    generated_at: new Date().toISOString(),
    source_count: SOURCE_FILES.length,
    profile_count: allProfiles.length,
    profiles: allProfiles,
    errors: errors.length > 0 ? errors : undefined,
  }

  mkdirSync(dirname(OUTPUT_PATH.pathname), { recursive: true })
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8")
  console.log(`Wrote ${allProfiles.length} profiles to ${OUTPUT_PATH.pathname}`)

  if (errors.length > 0) {
    console.warn("Warnings:")
    for (const err of errors) console.warn(`  ${err}`)
    process.exit(1)
  }
}

main()
