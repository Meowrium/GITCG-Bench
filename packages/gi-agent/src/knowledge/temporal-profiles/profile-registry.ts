// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Profile registry — builds and queries TemporalCardProfile from generated artifacts.
 *
 * Loads from GENERATED_TEMPORAL_PROFILES (built at build time via
 * `pnpm run generate:temporal-profiles`).
 *
 * In strict mode, throws if the generated artifact is empty.
 * In policy (non-strict) mode, returns empty data with a diagnostic.
 */

import type { TemporalCardProfile } from "./types.js"
import { GENERATED_TEMPORAL_PROFILES } from "./generated-profiles.js"

let _registry: Map<number, TemporalCardProfile> | null = null
let _byName: Map<string, TemporalCardProfile> | null = null
let _loadDiagnostics: string[] = []

/** Whether to throw when profiles are missing. Set false for policy degradation. */
let _strictMode = false

export function setStrictMode(strict: boolean): void {
  _strictMode = strict
}

/** Load profiles from generated artifact. */
export function loadProfiles(): Map<number, TemporalCardProfile> {
  if (_registry) return _registry

  _registry = new Map()
  _byName = new Map()
  _loadDiagnostics = []

  if (GENERATED_TEMPORAL_PROFILES.length > 0) {
    for (const profile of GENERATED_TEMPORAL_PROFILES) {
      _registry.set(profile.definitionId, profile)
      _byName.set(profile.name, profile)
    }
    _loadDiagnostics.push(
      `Loaded ${_registry.size} profiles from generated artifact`,
    )
  } else {
    const msg = "Temporal profile registry is empty. Run: pnpm run generate:temporal-profiles"
    _loadDiagnostics.push(msg)
    if (_strictMode) {
      throw new Error(msg)
    }
  }

  return _registry
}

/** Get profile for a specific card definition ID */
export function getProfile(definitionId: number): TemporalCardProfile | null {
  loadProfiles()
  return _registry?.get(definitionId) ?? null
}

/** Get all loaded profiles */
export function getAllProfiles(): TemporalCardProfile[] {
  loadProfiles()
  return [...(_registry?.values() ?? [])]
}

/** Get synergy requirements (card tags required) for a given definition ID */
export function getSynergyRequirements(definitionId: number): string[] {
  const profile = getProfile(definitionId)
  if (!profile) return []
  return profile.prerequisites
    .filter((p) => p.kind === "card_tag")
    .map((p) => p.value)
}

/** Get the option kind for a definition ID */
export function getOptionKind(definitionId: number): string {
  return getProfile(definitionId)?.optionKind ?? "generic_setup"
}

/** Get load diagnostics (warnings, counts) */
export function getLoadDiagnostics(): string[] {
  loadProfiles()
  return [..._loadDiagnostics]
}

/** Force reload profiles (for testing) */
export function reloadProfiles(): Map<number, TemporalCardProfile> {
  _registry = null
  _byName = null
  _loadDiagnostics = []
  return loadProfiles()
}
