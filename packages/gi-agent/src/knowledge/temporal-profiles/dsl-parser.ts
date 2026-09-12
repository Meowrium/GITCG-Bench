// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * DSL source parser for temporal card profiles.
 *
 * Reads TypeScript DSL source and extracts structural information about
 * card triggers, effects, prerequisites, and lifecycle characteristics.
 */

import type {
  TemporalCardProfile,
  TriggerWindow,
  TemporalPrerequisite,
  TemporalPayoffVector,
  TemporalFootprint,
  TemporalLifecycle,
  OptionKind,
} from "./types.js"

interface RawExtract {
  id: number
  name: string
  triggers: string[]
  conditions: string[]
  effects: EffectEntry[]
  usageCount: number | null
  usagePerRound: number | null
  variables: Array<{ name: string; initial: number }>
  supportTag: string | null
  diceCost: number
}

interface EffectEntry {
  kind: string
  value: number         // Extracted numeric argument (or 1 for boolean effects)
  isBoolean: boolean    // true for effects without numeric args (dispose, deduct_all)
}

/** Trigger name → TriggerWindow mapping */
const TRIGGER_MAP: Record<string, TriggerWindow> = {
  endPhase: "end_phase",
  actionPhase: "action_phase",
  roundBegin: "round_start",
  roundEnd: "round_end",
  playCard: "reactive",
  beforePlayCard: "reactive",
  useSkill: "reactive",
  beforeUseSkill: "reactive",
  beforeFastSwitch: "reactive",
  switchActive: "reactive",
  enter: "on_play",
  dispose: "on_play",
  deductAllDiceCard: "reactive",
  deductOmniDiceCard: "reactive",
  deductOmniDiceSkill: "reactive",
  onDelayedSkillDamage: "reactive",
  onDelayedSkillReaction: "reactive",
  generateDice: "reactive",
  decreaseDamaged: "end_phase",
  increaseDamaged: "end_phase",
}

export function parseAllDSL(source: string): TemporalCardProfile[] {
  const blocks = extractCardBlocks(source)
  return blocks.map(parseBlock).filter((p): p is TemporalCardProfile => p != null)
}

function extractCardBlocks(source: string): string[] {
  const regex = /export const (\w+) = card\((\d+)\)([\s\S]*?)\.done\(\);/g
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    blocks.push(`@id ${match[2]}\n@name ${match[1]}\n${match[3]}`)
  }
  return blocks
}

function parseBlock(block: string): TemporalCardProfile | null {
  const raw = extractRaw(block)
  if (!raw) return null

  const triggerWindows = classifyTriggers(raw.triggers)
  const prerequisites = extractPrerequisites(raw)
  const payoff = extractPayoff(raw)
  const footprint = extractFootprint(raw)
  const lifecycle = inferLifecycle(raw, triggerWindows)
  const optionKind = classifyOptionKind(raw, triggerWindows, payoff, prerequisites)

  return {
    definitionId: raw.id,
    name: raw.name,
    optionKind,
    triggerWindows,
    prerequisites,
    payoff,
    footprint,
    lifecycle,
    confidence: "source_parsed",
    source: `dsl:${raw.name}`,
  }
}

// ── Raw extraction ──

function extractRaw(block: string): RawExtract | null {
  const idMatch = block.match(/@id (\d+)/)
  const nameMatch = block.match(/@name (\w+)/)
  if (!idMatch || !nameMatch) return null

  const id = parseInt(idMatch[1], 10)
  const name = nameMatch[1]

  // Triggers: match all .on("xxx") or .onDelayedXxx or .endPhaseDamage(...)
  const triggers = new Set<string>()
  const onRegex = /\.on\("(\w+)"\)/g
  let m: RegExpExecArray | null
  while ((m = onRegex.exec(block)) !== null) {
    triggers.add(m[1])
  }
  // Also match .on("xxx", condition)
  const onCondRegex = /\.on\("(\w+)",/g
  while ((m = onCondRegex.exec(block)) !== null) {
    triggers.add(m[1])
  }
  // Shorthand triggers
  if (/\.endPhaseDamage\(/.test(block)) triggers.add("endPhase")
  if (/\.onDelayedSkillDamage\(/.test(block)) triggers.add("onDelayedSkillDamage")
  if (/\.onDelayedSkillReaction\(/.test(block)) triggers.add("onDelayedSkillReaction")

  // Conditions: extract hasCardTag / hasOneOfCardTag calls
  const conditions: string[] = []
  const hasCardRegex = /hasCardTag\("(\w+)"\)/g
  while ((m = hasCardRegex.exec(block)) !== null) {
    conditions.push(`hasCardTag:${m[1]}`)
  }
  const hasOneOfRegex = /hasOneOfCardTag\(([^)]+)\)/g
  while ((m = hasOneOfRegex.exec(block)) !== null) {
    const tags = m[1].match(/"(\w+)"/g)
    if (tags) {
      for (const tag of tags) {
        conditions.push(`hasCardTag:${tag.replace(/"/g, "")}`)
      }
    }
  }
  // Variable conditions
  const varCondRegex = /c\.getVariable\("(\w+)"\)\s*(>=?|<=?|===?)\s*(\d+)/g
  while ((m = varCondRegex.exec(block)) !== null) {
    conditions.push(`var:${m[1]}${m[2]}${m[3]}`)
  }

  // ── Effects: extract game-mechanical mutations with exact numeric values ──
  // Track source spans to deduplicate (a single source span should only count once)
  const seenSpans = new Set<string>()

  // Each entry: regex with 1 capture group for the numeric value.
  // Use position-based dedup: store {kind, value, matchIndex}.
  interface RawEffectHit {
    kind: string
    value: number
  }
  const rawHits: RawEffectHit[] = []

  // Patterns with numeric capture groups — extract the actual value, not match count
  const numericPatterns: Array<{
    regex: RegExp
    kind: string
    isBoolean?: boolean
  }> = [
    { regex: /c\.drawCards\((\d+)/g, kind: "draw" },
    { regex: /\.drawCards\((\d+)/g, kind: "draw" },
    { regex: /c\.generateDice\(DiceType\.Omni,\s*(\d+)/g, kind: "dice_omni" },
    { regex: /(?<!c\.)\.generateDice\(DiceType\.Omni,\s*(\d+)/g, kind: "dice_omni" },
    { regex: /c\.generateDice\("randomElement",\s*(\d+)/g, kind: "dice_random" },
    { regex: /(?<!c\.)\.generateDice\("randomElement",\s*(\d+)/g, kind: "dice_random" },
    { regex: /c\.generateDice\(\s*next\.element\(\),\s*(\d+)/g, kind: "dice_elemental" },
    { regex: /(?<!c\.)\.generateDice\(\s*next\.element\(\),\s*(\d+)/g, kind: "dice_elemental" },
    // Generic generateDice must run AFTER the specific ones above to avoid matching their spans
    // We'll handle this via span dedup
    { regex: /c\.generateDice\([^,)]+,\s*(\d+)/g, kind: "dice_elemental" },
    { regex: /c\.damage\([^,)]+,\s*(\d+)/g, kind: "damage" },
    { regex: /c\.heal\((\d+)/g, kind: "heal" },
    { regex: /\.gainEnergy\((\d+)/g, kind: "energy" },
    { regex: /\.deductOmniCost\((\d+)\)/g, kind: "deduct_omni" },
  ]

  for (const { regex, kind } of numericPatterns) {
    let match: RegExpExecArray | null
    while ((match = regex.exec(block)) !== null) {
      const spanKey = `${match.index}:${match[0].length}`
      if (seenSpans.has(spanKey)) continue
      seenSpans.add(spanKey)
      rawHits.push({ kind, value: parseInt(match[1], 10) })
    }
  }

  // Boolean patterns (no numeric arg)
  const booleanPatterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /e\.deductAllCost\(\)/g, kind: "deduct_all" },
    { regex: /c\.dispose\(\)/g, kind: "dispose" },
  ]

  for (const { regex, kind } of booleanPatterns) {
    let match: RegExpExecArray | null
    while ((match = regex.exec(block)) !== null) {
      const spanKey = `${match.index}:${match[0].length}`
      if (seenSpans.has(spanKey)) continue
      seenSpans.add(spanKey)
      rawHits.push({ kind, value: 1 })
    }
  }

  // Merge hits by kind — take MAX per kind (multiple matches are alternative trigger paths,
  // not cumulative payoffs). For boolean effects, just set the flag.
  const effects: EffectEntry[] = []
  const valueByKind = new Map<string, number>()
  for (const hit of rawHits) {
    const prev = valueByKind.get(hit.kind)
    // Default: take max (alternative trigger paths for same payoff)
    valueByKind.set(hit.kind, Math.max(prev ?? 0, hit.value))
  }
  for (const [kind, value] of valueByKind) {
    const isBoolean = ["deduct_all", "dispose"].includes(kind)
    effects.push({ kind, value, isBoolean })
  }

  // Usage limits
  let usageCount: number | null = null
  const usageMatch = block.match(/\.usage\((\d+)/)
  if (usageMatch) usageCount = parseInt(usageMatch[1], 10)

  let usagePerRound: number | null = null
  const uprMatch = block.match(/\.usagePerRound\((\d+)/)
  if (uprMatch) usagePerRound = parseInt(uprMatch[1], 10)

  // Variables
  const variables: Array<{ name: string; initial: number }> = []
  const varRegex = /\.variable\("(\w+)",?\s*(\d*)\)/g
  while ((m = varRegex.exec(block)) !== null) {
    variables.push({ name: m[1], initial: parseInt(m[2] || "0", 10) })
  }

  // Support type
  let supportTag: string | null = null
  const stMatch = block.match(/\.support\("(\w+)"\)/)
  if (stMatch) supportTag = stMatch[1]

  // Dice cost extraction: sum all .costSame(n), .costAny(n), .costVoid(n)
  let totalDiceCost = 0
  const costSameMatch = block.match(/\.costSame\((\d+)\)/)
  if (costSameMatch) totalDiceCost += parseInt(costSameMatch[1], 10)
  const costAnyMatch = block.match(/\.costAny\((\d+)\)/)
  if (costAnyMatch) totalDiceCost += parseInt(costAnyMatch[1], 10)
  const costVoidMatches = block.match(/\.costVoid\((\d+)\)/g)
  if (costVoidMatches) {
    for (const cv of costVoidMatches) {
      const m = cv.match(/\.costVoid\((\d+)\)/)
      if (m) totalDiceCost += parseInt(m[1], 10)
    }
  }

  return {
    id,
    name,
    triggers: [...triggers],
    conditions,
    effects,
    usageCount,
    usagePerRound,
    variables,
    supportTag,
    diceCost: totalDiceCost,
  }
}

// ── Classification ──

function classifyTriggers(triggers: string[]): TriggerWindow[] {
  const result = new Set<TriggerWindow>()
  for (const t of triggers) {
    const mapped = TRIGGER_MAP[t]
    if (mapped) result.add(mapped)
  }
  return [...result]
}

function extractPrerequisites(raw: RawExtract): TemporalPrerequisite[] {
  const prereqs: TemporalPrerequisite[] = []
  const seenTags = new Set<string>()

  for (const cond of raw.conditions) {
    if (cond.startsWith("hasCardTag:")) {
      const tag = cond.slice("hasCardTag:".length)
      if (!seenTags.has(tag)) {
        seenTags.add(tag)
        prereqs.push({ kind: "card_tag", value: tag })
      }
    } else if (cond.startsWith("var:")) {
      prereqs.push({ kind: "variable_at_least", value: cond.slice("var:".length) })
    }
  }

  return prereqs
}

function extractPayoff(raw: RawExtract): TemporalPayoffVector {
  const payoff: TemporalPayoffVector = {}
  for (const effect of raw.effects) {
    switch (effect.kind) {
      case "draw":
        payoff.draw = (payoff.draw ?? 0) + effect.value
        break
      case "dice_omni":
        payoff.generate_dice_omni = (payoff.generate_dice_omni ?? 0) + effect.value
        break
      case "dice_random":
        payoff.generate_dice_random = (payoff.generate_dice_random ?? 0) + effect.value
        break
      case "dice_elemental":
        payoff.generate_dice_elemental = (payoff.generate_dice_elemental ?? 0) + effect.value
        break
      case "damage":
        payoff.damage = (payoff.damage ?? 0) + effect.value
        break
      case "heal":
        payoff.heal = (payoff.heal ?? 0) + effect.value
        break
      case "energy":
        payoff.energy_gain = (payoff.energy_gain ?? 0) + effect.value
        break
      case "deduct_omni":
        payoff.cost_reduction = Math.max(payoff.cost_reduction ?? 0, effect.value)
        break
      case "deduct_all":
        payoff.cost_reduction_all = true
        break
      case "dispose":
        payoff.self_dispose = true
        break
    }
  }
  return payoff
}

function extractFootprint(raw: RawExtract): TemporalFootprint {
  return {
    support_slot: raw.supportTag != null,
    dice_cost_average: raw.diceCost, // extracted from .costSame/.costAny/.costVoid DSL
    usage_limit: raw.usageCount,
    usage_per_round: raw.usagePerRound,
    max_uses_per_game: raw.usageCount,
  }
}

function classifyOptionKind(
  raw: RawExtract,
  triggers: TriggerWindow[],
  payoff: TemporalPayoffVector,
  prerequisites: TemporalPrerequisite[],
): OptionKind {
  const hasEndPhase = triggers.includes("end_phase")
  const hasActionPhase = triggers.includes("action_phase")
  const hasReactive = triggers.includes("reactive")
  const hasOnPlay = triggers.includes("on_play")
  const hasCardTagPrereq = prerequisites.some(p => p.kind === "card_tag")

  // Dice bank: endPhase collect + actionPhase cash (Liben pattern)
  if (hasEndPhase && hasActionPhase && !!raw.variables.find(v => v.name === "collected")) {
    return "deferred_bank"
  }

  // Conditional engine: reactive + has card_tag prerequisites
  if (hasReactive && hasCardTagPrereq) {
    return "conditional_engine"
  }

  // Recurring engine: actionPhase with recurring dice/draw generation
  if (hasActionPhase && (payoff.generate_dice_omni || payoff.generate_dice_elemental || payoff.generate_dice_random)) {
    return "recurring_engine"
  }

  // Burst enabler: energy gain
  if (payoff.energy_gain) {
    return "burst_enabler"
  }

  // Defense
  if (payoff.heal) {
    return "defense"
  }

  // Converter: on_play with immediate value
  if (hasOnPlay && (payoff.damage || payoff.heal || payoff.draw || payoff.cost_reduction_all)) {
    return "converter"
  }

  // Cost reduction engine: reactive + cost reduction
  if (hasReactive && (payoff.cost_reduction || payoff.cost_reduction_all)) {
    return "conditional_engine"
  }

  // Generic deferred: has endPhase but no clear bank pattern
  if (hasEndPhase) {
    return "deferred_bank"
  }

  return "generic_setup"
}

function inferLifecycle(
  raw: RawExtract,
  triggers: TriggerWindow[],
): TemporalLifecycle {
  const hasEndPhase = triggers.includes("end_phase")
  const hasActionPhase = triggers.includes("action_phase")
  const hasReactive = triggers.includes("reactive")

  // Liben-like deferred bank
  if (hasEndPhase && hasActionPhase && raw.variables.length > 0) {
    return {
      ideal_deploy_round: { min: 1, max: 2 },
      payoff_delay: 1,
      payoff_recurrence: "once",
    }
  }

  // Recurring action-phase engine
  if (hasActionPhase && !hasEndPhase) {
    return {
      ideal_deploy_round: { min: 1, max: 2 },
      payoff_delay: 0,
      payoff_recurrence: "per_round",
    }
  }

  // End-phase trigger (deferred value, one-shot or usage-limited)
  if (hasEndPhase && !hasActionPhase) {
    return {
      ideal_deploy_round: { min: 1, max: 2 },
      payoff_delay: 1,
      payoff_recurrence: raw.usageCount ? "once" : "per_round",
    }
  }

  // Conditional/reactive engine
  if (hasReactive) {
    return {
      ideal_deploy_round: { min: 1, max: 3 },
      payoff_delay: 0,
      payoff_recurrence: "per_condition",
    }
  }

  return {
    ideal_deploy_round: { min: 1, max: 3 },
    payoff_delay: 0,
    payoff_recurrence: "once",
  }
}
