// Copyright (C) 2024-2025 Guyutongxue
//
// TransitionScorer V0 — Transition-based scoring for GiMlPolicy
//
// Implements V27 §21 minimum viable slice:
//   H1 ActionRights, H2 DiceOpportunity, H4 SupportSlot, H8 HandRetention
//   L1 profile transition (no engine exact)
//   Gated fusion into existing score
//
// See: docs/v27-transition-constraints-formalization.md

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type { PolicyCandidateAction, PolicyTurnDigest } from "./types.js"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface TransitionScorerV0Config {
  enabled: boolean
  /** Overall transition scoring weight in final score */
  weight: number
  /** Maximum contribution per candidate to prevent runaway scores */
  maxContribution: number
  /** Which constraints to enable */
  enabledConstraints: Array<"H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8" | "H9">
}

export const DEFAULT_TRANSITION_CONFIG: TransitionScorerV0Config = {
  enabled: true,
  weight: 0.5,
  maxContribution: 3.0,
  enabledConstraints: ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9"],
}

export interface ConstraintContribution {
  id: string
  raw: number
  reasons: string[]
}

export interface TransitionScoringResult {
  rawDelta: number
  gate: number
  contribution: number
  constraints: ConstraintContribution[]
  reasons: string[]
}

// ──────────────────────────────────────────────────
// Transition state projection from ObservationV1
// ──────────────────────────────────────────────────

interface DiceState {
  total: number
  omni: number
  byElement: Record<string, number>
}

interface TransitionSnapshot {
  round: number
  dice: DiceState
  handSize: number
  supportCount: number
  summonCount: number
  selfDeclaredEnd: boolean
  oppDeclaredEnd: boolean
  activeHp: number
  activeMaxHp: number
  activeEnergy: number
  activeMaxEnergy: number
  activeAura: number | null
  totalHp: number
  totalMaxHp: number
  opponentActiveHp: number
  opponentTotalHp: number
  opponentActiveEnergy: number
  opponentActiveMaxEnergy: number
  opponentActiveAura: number | null
  opponentDiceTotal: number
  turn: number
}

function projectSnapshot(
  observation: ObservationV1 | null | undefined,
  digest: PolicyTurnDigest,
): TransitionSnapshot {
  const selfObs = observation?.self
  const oppObs = observation?.opponent

  // Dice
  const dice = selfObs?.dice
  const diceByElement: Record<string, number> = { ...dice?.counts_by_type }
  const rs = digest.resource_summary
  const totalDice = (dice?.total_count as number | undefined) ?? (rs?.dice_count as number | undefined) ?? 0
  const omniDice = (dice?.omni_count as number | undefined) ?? (rs?.omni_count as number | undefined) ?? 0

  // Characters
  const characters = selfObs?.characters ?? []
  let activeHp = 0, activeMaxHp = 0, activeEnergy = 0, activeMaxEnergy = 0
  let activeAura: number | null = null
  let totalHp = 0, totalMaxHp = 0

  for (const c of characters) {
    totalHp += c.health
    totalMaxHp += c.max_health
    if (c.is_active) {
      activeHp = c.health
      activeMaxHp = c.max_health
      activeEnergy = c.energy
      activeMaxEnergy = c.max_energy
      activeAura = c.aura
    }
  }

  // Opponent
  const oppChars = oppObs?.characters ?? []
  let oppActiveHp = 0, oppTotalHp = 0, oppActiveEnergy = 0, oppActiveMaxEnergy = 0
  let oppActiveAura: number | null = null
  for (const c of oppChars) {
    oppTotalHp += c.health
    if (c.is_active) {
      oppActiveHp = c.health
      oppActiveEnergy = c.energy
      oppActiveMaxEnergy = c.max_energy
      oppActiveAura = c.aura
    }
  }

  return {
    round: digest.round,
    dice: { total: totalDice, omni: omniDice, byElement: diceByElement },
    handSize: (selfObs?.hand?.card_count as number | undefined) ?? (rs?.cards_in_hand as number | undefined) ?? 0,
    supportCount: (selfObs?.supports?.length ?? 0) + ((rs?.support_count as number | undefined) ?? 0),
    summonCount: (selfObs?.summons?.length as number | undefined) ?? (rs?.summon_count as number | undefined) ?? 0,
    selfDeclaredEnd: selfObs?.declared_end ?? false,
    oppDeclaredEnd: oppObs?.declared_end ?? digest.opponent_declared_end ?? false,
    activeHp, activeMaxHp, activeEnergy, activeMaxEnergy, activeAura,
    totalHp, totalMaxHp,
    opponentActiveHp: oppActiveHp,
    opponentTotalHp: oppTotalHp,
    opponentActiveEnergy: oppActiveEnergy,
    opponentActiveMaxEnergy: oppActiveMaxEnergy,
    opponentActiveAura: oppActiveAura,
    opponentDiceTotal: oppObs?.dice?.total_count ?? 8,
    turn: digest.turn,
  }
}

// ──────────────────────────────────────────────────
// L1 Profile Transition (apply action effects)
// ──────────────────────────────────────────────────

function applyActionToSnapshot(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
): TransitionSnapshot {
  const after = { ...snap, dice: { ...snap.dice, byElement: { ...snap.dice.byElement } } }

  // Apply dice cost
  const cost = candidate.dice_cost as
    | { type: number; count: number }[]
    | { type: string; count: number }[]
    | Record<string, number>
    | number
    | undefined

  if (typeof cost === "number" && cost > 0) {
    after.dice.total = Math.max(0, after.dice.total - cost)
  } else if (Array.isArray(cost)) {
    for (const entry of cost) {
      const typeKey = String(entry.type)
      const count = entry.count
      // Deduct from specific element, fallback to omni
      if (after.dice.byElement[typeKey] !== undefined) {
        const deduct = Math.min(after.dice.byElement[typeKey], count)
        after.dice.byElement[typeKey] -= deduct
        after.dice.total -= deduct
      } else if (after.dice.omni >= count) {
        after.dice.omni -= count
        after.dice.total -= count
      } else {
        after.dice.total = Math.max(0, after.dice.total - count)
      }
    }
  }

  // Apply hand changes
  if (candidate.action_case === "playCard" || candidate.action_case === "elementalTuning") {
    after.handSize = Math.max(0, after.handSize - 1)
  }

  // Apply support creation
  if (candidate.action_case === "playCard" && candidate.card_entity_type === 2) {
    after.supportCount = Math.min(4, after.supportCount + 1)
  }

  // Apply summon creation
  if (candidate.action_case === "playCard" && candidate.card_entity_type === 3) {
    after.summonCount += 1
  }

  // Apply declareEnd effects
  if (candidate.action_case === "declareEnd") {
    after.selfDeclaredEnd = true
  }

  return after
}

// ──────────────────────────────────────────────────
// H1: ActionRights — declareEnd constraint
// ──────────────────────────────────────────────────

function scoreActionRights(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
  _after: TransitionSnapshot,
  allCandidates: PolicyCandidateAction[],
): ConstraintContribution {
  if (candidate.action_case !== "declareEnd") {
    return { id: "H1", raw: 0, reasons: [] }
  }

  // Count useful actions available
  const usefulActions = allCandidates.filter(
    (c) =>
      c.action_case === "useSkill" ||
      (c.action_case === "playCard" &&
        (c.damage_estimate ?? 0) > 0),
  )

  const hasUsefulAction = usefulActions.length > 0
  const bestUsefulDamage = usefulActions.reduce(
    (max, c) => Math.max(max, c.damage_estimate ?? 0),
    0,
  )

  // Compute penalties
  let raw = 0
  const reasons: string[] = []

  if (hasUsefulAction && snap.dice.total >= 3) {
    // Opportunity loss: giving up useful actions
    const oppLoss = -3.0
    raw += oppLoss
    reasons.push(`H1:opportunity_loss=${oppLoss} (${usefulActions.length} useful actions available)`)
  }

  if (snap.oppDeclaredEnd && hasUsefulAction) {
    // Free window loss: opponent ended, we could act freely
    const freeWindowLoss = -3.0
    raw += freeWindowLoss
    reasons.push(`H1:free_window_loss=${freeWindowLoss} (opponent ended)`)
  }

  // Small phase-based adjustment
  if (snap.round === 1 && snap.dice.total >= 5) {
    const r1Penalty = -2.0
    raw += r1Penalty
    reasons.push(`H1:r1_penalty=${r1Penalty} (round 1, ${snap.dice.total} dice)`)
  }

  // Positive: end-phase cashout exists
  if (snap.summonCount > 0 || snap.supportCount > 0) {
    const cashoutBonus = 0.5
    raw += cashoutBonus
    reasons.push(`H1:cashout_bonus=+${cashoutBonus} (entities present)`)
  }

  return { id: "H1", raw, reasons }
}

// ──────────────────────────────────────────────────
// H2: DiceOpportunity — dice scarcity
// ──────────────────────────────────────────────────

/**
 * Simple estimate: the more dice we spend, and the fewer high-value
 * actions remain affordable, the higher the opportunity cost.
 */
function scoreDiceOpportunity(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
  after: TransitionSnapshot,
  _allCandidates: PolicyCandidateAction[],
): ConstraintContribution {
  const diceBefore = snap.dice.total
  const diceAfter = after.dice.total
  const diceSpent = diceBefore - diceAfter

  if (diceSpent <= 0) {
    return { id: "H2", raw: 0, reasons: [] }
  }

  // Higher cost = higher opportunity cost
  // But if the action does significant damage, it's worth the dice
  const dmgPerDie =
    diceSpent > 0 ? (candidate.damage_estimate ?? 0) / diceSpent : 0

  // Opportunity cost: future actions that need similar dice
  // Simple heuristic: each die spent costs ~0.3, but high-efficiency actions offset
  const baseCost = diceSpent * 0.3
  const efficiencyBonus = Math.min(dmgPerDie * 0.5, 1.0)

  const raw = -(baseCost - efficiencyBonus)
  const reasons: string[] = [
    `H2:dice_spent=${diceSpent} efficiency=${dmgPerDie.toFixed(1)} opp_cost=${baseCost.toFixed(2)}`,
  ]

  return { id: "H2", raw, reasons }
}

// ──────────────────────────────────────────────────
// H4: SupportSlot — support slot marginal value
// ──────────────────────────────────────────────────

function scoreSupportSlot(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
  _after: TransitionSnapshot,
): ConstraintContribution {
  // Only score support card plays
  if (
    candidate.action_case !== "playCard" ||
    candidate.card_entity_type !== 2
  ) {
    return { id: "H4", raw: 0, reasons: [] }
  }

  const used = snap.supportCount
  const reasons: string[] = []

  // Slot multiplier: first slot = worth more, last slot = worth less
  const slotMultipliers = [1.15, 1.0, 0.75, 0.45]
  const mult = used < 4 ? (slotMultipliers[used] ?? 0.45) : 0.3

  // Base value of support card deployment
  const baseValue = (candidate.create_support_value ?? 0) || 1.0

  if (used >= 4) {
    // Replacement: only worth it if new support >> old support
    const raw = (baseValue - 1.5) * mult
    reasons.push(
      `H4:slot_full replacement_delta=${raw.toFixed(2)} (value=${baseValue})`,
    )
    return { id: "H4", raw, reasons }
  }

  const raw = baseValue * mult
  reasons.push(
    `H4:slot_${used}=${mult.toFixed(2)} value=${baseValue} scored=${raw.toFixed(2)}`,
  )
  return { id: "H4", raw, reasons }
}

// ──────────────────────────────────────────────────
// H8: HandRetention — tuning sacrifice cost
// ──────────────────────────────────────────────────

function scoreHandRetention(
  candidate: PolicyCandidateAction,
): ConstraintContribution {
  if (candidate.action_case !== "elementalTuning") {
    return { id: "H8", raw: 0, reasons: [] }
  }

  // Tuning cost = sacrificing a card from hand
  // Base cost depends on the card's meta effect slots
  const metaSlots = candidate.meta_effect_slots as
    | Record<string, number>
    | undefined

  const retentionValue = metaSlots?.retention_value_proxy ?? 1.0
  const reactionValue = metaSlots?.reaction_window_loss ?? 0
  const finisherLoss = metaSlots?.finisher_alignment_loss ?? 0
  const setupLoss = metaSlots?.setup_dependency_loss ?? 0

  // Tuning gain = unlock potential (future action improvement)
  const unlockGain = 0.5 // base unlock value

  const sacrificeCost =
    retentionValue + reactionValue * 0.5 + finisherLoss * 0.3 + setupLoss * 0.2
  const raw = unlockGain - sacrificeCost

  const reasons: string[] = [
    `H8:tuning retention=${retentionValue.toFixed(1)} reaction_loss=${reactionValue.toFixed(1)} unlock=+${unlockGain.toFixed(1)} net=${raw.toFixed(2)}`,
  ]

  return { id: "H8", raw, reasons }
}

// ──────────────────────────────────────────────────
// H3: AuraDelta — 元素附着债务约束
// ──────────────────────────────────────────────────

function scoreAuraDelta(
  before: TransitionSnapshot,
  candidate: PolicyCandidateAction,
  after: TransitionSnapshot,
): ConstraintContribution {
  const reasons: string[] = []

  // Only meaningful for skill actions (element application)
  const isSkill = candidate.action_case === "useSkill"

  // Before: estimate reaction window for self and opponent
  // Self aura: can opponent react?
  const selfBefore = before.activeAura ? 1.0 : 0  // simplified: aura present = window open
  const oppBefore = before.opponentActiveAura ? 1.0 : 0

  // After: same estimation
  const selfAfter = after.activeAura ? 1.0 : 0
  const oppAfter = after.opponentActiveAura ? 1.0 : 0

  // Compute deltas
  const cashout = (after.activeAura && after.activeAura !== before.activeAura)
    ? 0.5 // small bonus for applying element (changing aura)
    : 0
  const setupGain = Math.max(0, oppAfter - oppBefore) // opponent becoming more vulnerable
  const debt = Math.max(0, selfBefore - selfAfter)     // losing our own reaction window
  const oppGift = Math.max(0, selfAfter - selfBefore)  // giving opponent a reaction window

  const raw = cashout + setupGain - debt - oppGift

  // Static aura debt: we have aura and opponent might react
  if (raw === 0 && before.activeAura && isSkill) {
    // Static debt: having aura is a liability even without change
    reasons.push(
      `H3:aura static_debt aura=${before.activeAura} (reaction window open for opponent)`,
    )
    return { id: "H3", raw: -0.3, reasons }
  }

  if (raw !== 0) {
    reasons.push(
      `H3:aura cashout=${cashout.toFixed(2)} setup=${setupGain.toFixed(2)} debt=${debt.toFixed(2)} oppGift=${oppGift.toFixed(2)}`,
    )
  }

  return { id: "H3", raw, reasons }
}

// ──────────────────────────────────────────────────
// H5: RoleIntegrity — 角色功能完整性约束
// ──────────────────────────────────────────────────

/**
 * Simple role heuristic based on character energy and HP thresholds.
 * L1-profile mode — in production, use the full role-inference module.
 */
type SimpleRole = "carry" | "enabler" | "protector" | "hybrid"

function inferSimpleRole(
  maxEnergy: number,
  maxHp: number,
  _definitionId: number,
): SimpleRole {
  // High max_energy (3) → likely carry or hybrid
  if (maxEnergy >= 3) return maxHp > 10 ? "hybrid" : "carry"
  // Low energy (2) + high HP → likely protector
  if (maxHp >= 10) return "protector"
  // Everything else → enabler
  return "enabler"
}

/** Risk weight by role */
const ROLE_RISK_WEIGHT: Record<SimpleRole, number> = {
  carry: 1.5,
  hybrid: 1.0,
  enabler: 0.7,
  protector: 0.5,
}

/** Cashout importance by role */
const ROLE_CASHOUT_IMPORTANCE: Record<SimpleRole, number> = {
  carry: 2.0,
  hybrid: 1.5,
  enabler: 0.8,
  protector: 0.5,
}

function scoreRoleIntegrity(
  before: TransitionSnapshot,
  candidate: PolicyCandidateAction,
  after: TransitionSnapshot,
): ConstraintContribution {
  const reasons: string[] = []

  // HP loss cost for active character
  const hpLoss = Math.max(0, before.activeHp - after.activeHp)
  const hpLossFraction = before.activeMaxHp > 0 ? hpLoss / before.activeMaxHp : 0

  // Infer role for active character
  const role = inferSimpleRole(before.activeMaxEnergy, before.activeMaxHp, 0)
  const riskWeight = ROLE_RISK_WEIGHT[role]
  const cashoutImportance = ROLE_CASHOUT_IMPORTANCE[role]

  // HP loss cost
  const hpCost = riskWeight * hpLossFraction * 3.0

  // Exposure risk: if we end the action with a carry in active slot
  // and opponent threatens, that's risky
  let exposure = 0
  if (role === "carry" || role === "hybrid") {
    // Estimate opponent threat: if opponent has high energy ready
    const oppThreatFactor =
      before.opponentActiveEnergy >= before.opponentActiveMaxEnergy - 1 ? 0.6 : 0.2
    exposure = cashoutImportance * oppThreatFactor * 0.5
  }

  // Role alignment gain
  let alignment = 0
  if (candidate.action_case === "useSkill") {
    if (role === "carry" && before.activeEnergy >= before.activeMaxEnergy - 1) {
      // Carry using burst-ready action → positive alignment
      alignment = 1.5
      reasons.push("H5:carry_burst_ready")
    } else if (role === "enabler") {
      // Enabler applying element → small positive
      alignment = 0.5
    }
  }
  if (candidate.action_case === "switchCharacter") {
    // Switching away from exposed carry → positive
    if ((role === "carry" || role === "hybrid") && hpLossFraction > 0) {
      alignment = 1.0
      reasons.push("H5:carry_retreat")
    }
  }

  const raw = alignment - hpCost - exposure

  if (raw !== 0 || hpLossFraction > 0) {
    if (!reasons.length) {
      reasons.push(
        `H5:role=${role} hp_loss=${hpLossFraction.toFixed(2)} cost=${hpCost.toFixed(2)} exposure=${exposure.toFixed(2)}`,
      )
    } else {
      reasons.push(
        `H5:role=${role} cost=${hpCost.toFixed(2)} exposure=${exposure.toFixed(2)} net=${raw.toFixed(2)}`,
      )
    }
  }

  return { id: "H5", raw, reasons }
}

// ──────────────────────────────────────────────────
// H6: OpponentThreat — 对手 cashout readiness 约束
// ──────────────────────────────────────────────────

function scoreOpponentThreat(
  before: TransitionSnapshot,
  _candidate: PolicyCandidateAction,
  after: TransitionSnapshot,
): ConstraintContribution {
  const reasons: string[] = []

  // Estimate threat vector
  const estimateThreat = (snap: TransitionSnapshot): number => {
    let threat = 0

    // 1. Opponent burst readiness → one-step lethal risk
    if (snap.opponentActiveEnergy >= snap.opponentActiveMaxEnergy) {
      threat += 2.0
    } else if (snap.opponentActiveEnergy >= snap.opponentActiveMaxEnergy - 1) {
      threat += 1.0
    }

    // 2. Opponent has dice to act
    if (snap.opponentDiceTotal >= 3) {
      threat += 0.5
    }

    // 3. Our active in kill range
    const hpRemaining = snap.activeHp
    if (hpRemaining <= 2) threat += 2.0
    else if (hpRemaining <= 4) threat += 1.0

    // 4. End phase damage (summons)
    if (snap.summonCount > 0) {
      threat += snap.summonCount * 0.3
    }

    // 5. Opponent reaction window
    if (snap.activeAura != null && snap.opponentActiveAura == null) {
      // We have aura → opponent can react
      threat += 1.0
    }

    return threat
  }

  const beforeThreat = estimateThreat(before)
  const afterThreat = estimateThreat(after)

  const delta = beforeThreat - afterThreat

  if (delta !== 0) {
    reasons.push(
      `H6:threat_delta=${delta.toFixed(2)} before=${beforeThreat.toFixed(1)} after=${afterThreat.toFixed(1)}`,
    )
  } else if (beforeThreat >= 3.0) {
    // Report static threat level even when no change, for high-risk states
    reasons.push(
      `H6:threat_static=${beforeThreat.toFixed(1)} (high threat — burst ready / low HP / aura exposed)`,
    )
  }

  return { id: "H6", raw: delta * 0.5, reasons }
}

// ──────────────────────────────────────────────────
// H7: RoundTempo — 先后手与轮次节奏约束
// ──────────────────────────────────────────────────

function scoreRoundTempo(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
): ConstraintContribution {
  const reasons: string[] = []

  // Tempo multiplier computation
  const round = snap.round
  const isFirstMover = snap.turn % 2 === 0 // approximate: even turn = first mover

  // Base multiplier by round and mover role
  let mult = 1.0
  if (round === 1) {
    mult = isFirstMover ? 1.25 : 1.10
  } else if (round <= 3) {
    mult = isFirstMover ? 1.1 : 1.0
  } else {
    // Late game: urgency increases
    mult = 1.15
  }

  // Free window bonus: opponent ended but we're still acting
  if (snap.oppDeclaredEnd && candidate.action_case !== "declareEnd") {
    mult += 0.4
    reasons.push("H7:free_window")
  }

  // Action-type factor
  let actionFactor = 1.0
  if (candidate.action_case === "useSkill") {
    actionFactor = 1.0
  } else if (candidate.action_case === "switchCharacter") {
    actionFactor = 0.8
  } else if (candidate.action_case === "playCard") {
    actionFactor = 0.9
  } else if (candidate.action_case === "declareEnd") {
    actionFactor = 0 // H1 handles declareEnd
  }

  // Use the candidate's intrinsic value as tempo action value
  const actionValue = candidate.damage_estimate ?? 0

  const raw = (mult * actionFactor - 1.0) * Math.min(actionValue, 3.0)

  if (raw !== 0) {
    reasons.push(
      `H7:round=${round} mover=${isFirstMover ? "first" : "second"} mult=${mult.toFixed(2)} af=${actionFactor.toFixed(1)}`,
    )
  }

  return { id: "H7", raw, reasons }
}

// ──────────────────────────────────────────────────
// H9: HiddenRisk — 随机性与隐藏信息约束
// ──────────────────────────────────────────────────

function scoreHiddenRisk(
  snap: TransitionSnapshot,
  _candidate: PolicyCandidateAction,
): ConstraintContribution {
  // Hidden info proxies:
  // 1. Opponent hand size → information variance
  // 2. Hand size vs deck remaining → draw uncertainty
  // 3. Our health status → risk amplifier
  const reasons: string[] = []

  // Information uncertainty
  const oppHandUnknown = Math.max(0, 10 - (snap.handSize > 0 ? 5 : 0))
  const handVariance = oppHandUnknown * 0.1

  // Health pressure amplifies hidden risk
  const hpFraction = snap.activeMaxHp > 0 ? snap.activeHp / snap.activeMaxHp : 1.0
  const healthPressure = Math.max(0, 1.0 - hpFraction) * 2.0

  // Combined risk penalty: more uncertainty + low HP → conservative adjustments
  const raw = -(handVariance + healthPressure * 0.3)

  if (raw < -0.1) {
    reasons.push(
      `H9:hidden_var=${handVariance.toFixed(2)} hp_pressure=${healthPressure.toFixed(2)} risk=${raw.toFixed(2)}`,
    )
  }

  return { id: "H9", raw, reasons }
}

// ──────────────────────────────────────────────────
// Gate function — high-impact actions get full benefit
// ──────────────────────────────────────────────────

function computeGate(
  snap: TransitionSnapshot,
  candidate: PolicyCandidateAction,
): number {
  let gate = 0

  // declareEnd always high-impact
  if (candidate.action_case === "declareEnd") {
    gate = Math.max(gate, 1.0)
  }

  // Elemental tuning
  if (candidate.action_case === "elementalTuning") {
    gate = Math.max(gate, 0.8)
  }

  // Support card when slots nearly full
  if (
    candidate.action_case === "playCard" &&
    candidate.card_entity_type === 2 &&
    snap.supportCount >= 3
  ) {
    gate = Math.max(gate, 0.8)
  }

  // High damage skills
  if (
    candidate.action_case === "useSkill" &&
    (candidate.damage_estimate ?? 0) >= 4
  ) {
    gate = Math.max(gate, 0.6)
  }

  // Low-impact actions get lower gate
  if (gate === 0) {
    gate = 0.1
  }

  return gate
}

// ──────────────────────────────────────────────────
// Main scoring entry point
// ──────────────────────────────────────────────────

export function scoreTransitionV0(
  observation: ObservationV1 | null | undefined,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  allCandidates: PolicyCandidateAction[],
  config: TransitionScorerV0Config,
): TransitionScoringResult {
  if (!config.enabled) {
    return {
      rawDelta: 0,
      gate: 0,
      contribution: 0,
      constraints: [],
      reasons: [],
    }
  }

  const before = projectSnapshot(observation, digest)
  const after = applyActionToSnapshot(before, candidate)

  const constraints: ConstraintContribution[] = []
  const allReasons: string[] = []

  if (config.enabledConstraints.includes("H1")) {
    const r = scoreActionRights(before, candidate, after, allCandidates)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H2")) {
    const r = scoreDiceOpportunity(before, candidate, after, allCandidates)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H4")) {
    const r = scoreSupportSlot(before, candidate, after)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H8")) {
    const r = scoreHandRetention(candidate)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H3")) {
    const r = scoreAuraDelta(before, candidate, after)
    if (r.raw !== 0 || r.reasons.length > 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H5")) {
    const r = scoreRoleIntegrity(before, candidate, after)
    if (r.raw !== 0 || r.reasons.length > 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H6")) {
    const r = scoreOpponentThreat(before, candidate, after)
    if (r.raw !== 0 || r.reasons.length > 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H7")) {
    const r = scoreRoundTempo(before, candidate)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  if (config.enabledConstraints.includes("H9")) {
    const r = scoreHiddenRisk(before, candidate)
    if (r.raw !== 0) {
      constraints.push(r)
      allReasons.push(...r.reasons)
    }
  }

  const rawDelta = constraints.reduce((sum, c) => sum + c.raw, 0)
  const gate = computeGate(before, candidate)
  const weightedDelta = rawDelta * config.weight
  const contribution = Math.max(
    -config.maxContribution,
    Math.min(config.maxContribution, gate * weightedDelta),
  )

  return {
    rawDelta,
    gate,
    contribution,
    constraints,
    reasons: allReasons,
  }
}
