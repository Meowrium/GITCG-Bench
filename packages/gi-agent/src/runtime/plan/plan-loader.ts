// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DeckMeta, PlanPhase, ThreatRule } from "./types.js"
import { computeMatchupDelta } from "./matchup-delta.js"

// ---------------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------------

export function deckFingerprintForPlan(deckCode: string): string {
  return deckCode.length <= 40 ? deckCode : deckCode.slice(0, 20) + "_" + simplePlanHash(deckCode)
}

function simplePlanHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).slice(0, 6)
}

// ---------------------------------------------------------------------------
// Plan file shape (with optional deckMeta from newer compilations)
// ---------------------------------------------------------------------------

interface PlanFile {
  deckFingerprint?: string
  deckCode?: string
  deckName?: string
  deckMeta?: DeckMeta
  phases?: PlanPhase[]
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Load base PlanPhase[] from a plan JSON file.
 */
export function loadPlanFile(plansDir: string, deckCode: string): PlanPhase[] | null {
  const fingerprint = deckFingerprintForPlan(deckCode)
  const planPath = join(plansDir, `${fingerprint}.plan.json`)
  if (!existsSync(planPath)) {
    console.warn(`  [SPL] Plan file not found for ${fingerprint.slice(0, 20)}: ${planPath}`)
    return null
  }
  try {
    const raw = readFileSync(planPath, "utf-8")
    const data = JSON.parse(raw) as PlanFile
    const phases = data.phases ?? (Array.isArray(data) ? (data as unknown as PlanPhase[]) : null)
    if (Array.isArray(phases)) return phases
    console.warn(`  [SPL] Invalid plan file (no phases array): ${planPath}`)
    return null
  } catch (err) {
    console.warn(`  [SPL] Error loading plan file: ${planPath}: ${String(err)}`)
    return null
  }
}

/**
 * Load only the DeckMeta from a plan JSON file (lightweight — skips phase deserialization).
 */
export function loadPlanMeta(plansDir: string, deckCode: string): DeckMeta | null {
  const fingerprint = deckFingerprintForPlan(deckCode)
  const planPath = join(plansDir, `${fingerprint}.plan.json`)
  if (!existsSync(planPath)) return null
  try {
    const raw = readFileSync(planPath, "utf-8")
    const data = JSON.parse(raw) as PlanFile
    return data.deckMeta ?? null
  } catch {
    return null
  }
}

/**
 * Load PlanPhase[] for our deck, optionally augmented with extra threat rules
 * derived from comparing our DeckMeta against the opponent's DeckMeta.
 *
 * When planStrategy is "compiled" and plansDir is available, this loads both
 * sides' deck meta and merges generic opponent-aware threat rules into the
 * base plan before returning.
 */
export function loadPlanWithMatchupAwareness(
  plansDir: string,
  ourDeckCode: string,
  opponentDeckCode: string,
): PlanPhase[] | null {
  const base = loadPlanFile(plansDir, ourDeckCode)
  if (!base) return null

  const ourMeta = loadPlanMeta(plansDir, ourDeckCode)
  const oppMeta = loadPlanMeta(plansDir, opponentDeckCode)

  if (!ourMeta || !oppMeta) {
    console.log(
      `  [SPL] DeckMeta missing for ${deckFingerprintForPlan(ourDeckCode).slice(0, 12)}` +
      ` or ${deckFingerprintForPlan(opponentDeckCode).slice(0, 12)} — using base plan only.`,
    )
    return base
  }

  const delta = computeMatchupDelta(ourMeta, oppMeta)

  // Merge extra threat rules into matching phases
  return base.map((phase) => {
    const extras = delta.extraThreatRules[phase.phaseId]
    if (!extras || extras.length === 0) return phase

    const mergedThreatRules: ThreatRule[] = [
      ...phase.threatRules,
      ...extras,
    ]

    return {
      ...phase,
      threatRules: mergedThreatRules,
    }
  })
}
