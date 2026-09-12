// Copyright (C) 2024-2025 Guyutongxue
//
// Action-phase state snapshot and lightweight forward simulator for MCTS.
// Captures only mutable fields — no engine cloning needed.

import type { GameState, PlayerState } from "@gi-tcg/core"
import {
  DiceType,
} from "@gi-tcg/typings"
import {
  type DiceVector,
  diceVectorFromArray,
  diceCanAfford,
  diceAfterPaying,
  diceTotal,
  DICE_ZERO,
} from "./dice-vector.js"

// ── Snapshot structures ──

export interface CharSnapshot {
  id: number
  definitionId: number
  hp: number
  maxHp: number
  energy: number
  maxEnergy: number
  alive: boolean
  aura: number // DiceType value, 0 = none
  equipDefIds: number[] // equipment definition IDs
}

export interface EntitySnapshot {
  id: number
  definitionId: number
  usage: number     // remaining usage count
  maxUsage: number
  /** Per-round usage counter (consumed by heuristic leaf eval; not hashed) */
  usagePerRound?: number
}

export interface ActionPhaseSnapshot {
  who: 0 | 1
  chars: CharSnapshot[]
  activeIdx: number
  dice: DiceVector
  handDefIds: number[]
  supports: EntitySnapshot[]
  summons: EntitySnapshot[]
  combatStatuses: EntitySnapshot[]
  declaredEnd: boolean
  roundNumber: number
}

// ── Take snapshot from engine state ──

export function takeActionPhaseSnapshot(state: GameState, who: 0 | 1): ActionPhaseSnapshot {
  const player = state.players[who]

  const chars: CharSnapshot[] = player.characters.map((ch) => ({
    id: ch.id,
    definitionId: ch.definition.id,
    hp: ch.variables.health ?? 0,
    maxHp: ch.variables.maxHealth ?? 10,
    energy: ch.variables.energy ?? 0,
    maxEnergy: ch.variables.maxEnergy ?? 2,
    alive: ch.variables.alive == null || ch.variables.alive === 1,
    aura: (ch.variables.aura as number) ?? 0,
    equipDefIds: (ch.entities ?? [])
      .filter((e) => e.definition.type === "equipment")
      .map((e) => e.definition.id),
  }))

  const toEntitySnapshot = (entities: readonly { id: number; definition: { id: number }; variables: Record<string, number> }[]): EntitySnapshot[] =>
    entities.map((e) => ({
      id: e.id,
      definitionId: e.definition.id,
      usage: (e.variables.usage as number) ?? (e.variables.count as number) ?? 1,
      maxUsage: (e.variables.maxUsage as number) ?? (e.variables.maxCount as number) ?? 3,
    }))

  return {
    who,
    chars,
    activeIdx: player.characters.findIndex((ch) => ch.id === player.activeCharacterId),
    dice: diceVectorFromArray(player.dice),
    handDefIds: player.hands.map((h) => h.definition.id),
    supports: toEntitySnapshot(player.supports),
    summons: toEntitySnapshot(player.summons),
    combatStatuses: toEntitySnapshot(player.combatStatuses),
    declaredEnd: player.declaredEnd,
    roundNumber: state.roundNumber,
  }
}

// ── Action types for MCTS ──

export type MctsActionType = "skill" | "card" | "switch" | "end"

export interface MctsAction {
  type: MctsActionType
  cost: Map<DiceType, number>  // dice requirement
  /** For skill: skill definition ID; for card: card definition ID; for switch: target char index */
  targetId: number
  /** Character definition ID performing the action (0 for self-active) */
  actorDefId: number
  /** Estimated damage to opponent active character */
  estimatedDamage: number
  /** Element applied to opponent (DiceType), 0 = none */
  applyElement: number
  /** For fast actions: true */
  fast: boolean
  /** Skill type for energy tracking (null for non-skill actions) */
  skillType?: "normal" | "elemental" | "burst" | null
  /** Energy cost for burst (subtracted when used) */
  energyCost?: number
  /** Known card effect hint for rapid simulation */
  cardEffectHint?: "draw1" | "heal1" | "diceGen1" | "summonPlace" | "equip" | null
}

// ── Simplified forward simulation ──

export interface SimResult {
  newSnapshot: ActionPhaseSnapshot
  /** Opponent snapshot changes (if any) */
  opponentDelta?: Partial<ActionPhaseSnapshot>
}

// ── Inline reaction calculator (element → reaction bonus) ──
// Maps DiceType values: 1=cryo 2=hydro 3=pyro 4=electro 5=anemo 6=geo 7=dendro 8=omni
const DICE_TO_ELEMENT: Record<number, string> = {
  1: "cryo", 2: "hydro", 3: "pyro", 4: "electro", 5: "anemo", 6: "geo", 7: "dendro",
};

function computeReactionBonus(
  attackEl: number,   // DiceType of attacking element
  targetAura: number, // DiceType of target's current aura
): { bonus: number; consumes: boolean } {
  const atk = DICE_TO_ELEMENT[attackEl];
  const def = DICE_TO_ELEMENT[targetAura];
  if (!atk || !def) return { bonus: 0, consumes: false };

  // Vaporize: pyro↔hydro
  if ((atk === "pyro" && def === "hydro") || (atk === "hydro" && def === "pyro")) {
    return { bonus: 2, consumes: true };
  }
  // Melt: pyro↔cryo
  if ((atk === "pyro" && def === "cryo") || (atk === "cryo" && def === "pyro")) {
    return { bonus: 2, consumes: true };
  }
  // Overloaded: pyro↔electro
  if ((atk === "pyro" && def === "electro") || (atk === "electro" && def === "pyro")) {
    return { bonus: 2, consumes: true };
  }
  // Superconduct: cryo↔electro
  if ((atk === "cryo" && def === "electro") || (atk === "electro" && def === "cryo")) {
    return { bonus: 1, consumes: true };
  }
  // Electro-Charged: hydro↔electro (aura persists via electrocharged exception)
  if ((atk === "electro" && def === "hydro") || (atk === "hydro" && def === "electro")) {
    return { bonus: 1, consumes: false }; // aura persists in electrocharged
  }
  // Frozen: cryo on hydro
  if (atk === "cryo" && def === "hydro") {
    return { bonus: 0, consumes: true }; // frozen: no bonus damage but consumes aura
  }
  // Swirl: anemo on anything
  if (atk === "anemo" && def !== "geo" && def !== "anemo") {
    return { bonus: 1, consumes: true };
  }
  return { bonus: 0, consumes: false };
}

// ── Rapid card effect simulation for known definition IDs ──
// Approximates the most impactful card effects to give the MCTS tree
// a signal beyond "hand-1". Full engine simulation is too expensive.
function applyRapidCardEffect(
  ns: ActionPhaseSnapshot,
  _oppNs: ActionPhaseSnapshot,
  action: MctsAction,
): void {
  const hint = action.cardEffectHint;
  const defId = action.targetId;

  if (hint === "draw1") {
    // Simulates drawing 1 card — add a placeholder
    ns.handDefIds.push(0); // placeholder draw
  } else if (hint === "heal1") {
    // Heal self active character by ~2 HP
    if (ns.activeIdx >= 0 && ns.chars[ns.activeIdx]) {
      const actor = ns.chars[ns.activeIdx];
      actor.hp = Math.min(actor.maxHp, actor.hp + 2);
    }
  } else if (hint === "diceGen1") {
    // Generate 1 omni die
    if (ns.dice[7] !== undefined) {
      const dice = [...ns.dice] as number[];
      dice[7]++;
      ns.dice = dice as unknown as DiceVector;
    }
  } else if (hint === "summonPlace") {
    // Place a support/summon — add placeholder
    ns.supports.push({ id: -1, definitionId: defId, usage: 1, maxUsage: 1 });
  } else if (hint === "equip") {
    // Equipment — tag the active character
    if (ns.activeIdx >= 0 && ns.chars[ns.activeIdx]) {
      ns.chars[ns.activeIdx].equipDefIds.push(defId);
    }
  }
  // If no hint, only hand removal was already done in the caller
}

/**
 * Apply an MCTS action to a snapshot, returning a new snapshot.
 */
export function simulateAction(
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  action: MctsAction,
): SimResult {
  // Deep-ish copy the snapshot (only primitive fields)
  const ns: ActionPhaseSnapshot = {
    ...snap,
    chars: snap.chars.map((c) => ({ ...c, equipDefIds: [...c.equipDefIds] })),
    dice: [...snap.dice] as DiceVector,
    handDefIds: [...snap.handDefIds],
    supports: snap.supports.map((s) => ({ ...s })),
    summons: snap.summons.map((s) => ({ ...s })),
    combatStatuses: snap.combatStatuses.map((s) => ({ ...s })),
  }

  const oppNs: ActionPhaseSnapshot = {
    ...oppSnap,
    chars: oppSnap.chars.map((c) => ({ ...c, equipDefIds: [...c.equipDefIds] })),
    dice: [...oppSnap.dice] as DiceVector,
    handDefIds: [...oppSnap.handDefIds],
    supports: oppSnap.supports.map((s) => ({ ...s })),
    summons: oppSnap.summons.map((s) => ({ ...s })),
    combatStatuses: oppSnap.combatStatuses.map((s) => ({ ...s })),
  }

  // 1. Pay dice cost
  const alignedEl = ns.activeIdx >= 0 ? mapAuraToElement(ns.chars[ns.activeIdx]?.aura ?? 0) : null
  ns.dice = diceAfterPaying(ns.dice, action.cost, alignedEl)

  // 2. Apply action effect
  switch (action.type) {
    case "skill": {
      // Damage opponent active with reaction bonus (B)
      if (oppNs.activeIdx >= 0 && oppNs.chars[oppNs.activeIdx]) {
        const target = oppNs.chars[oppNs.activeIdx]
        const targetAura = target.aura

        // Compute reaction bonus if attack has element and target has aura
        let reactionDamage = 0
        let consumesAura = false
        if (action.applyElement > 0 && targetAura > 0) {
          const reaction = computeReactionBonus(action.applyElement, targetAura)
          reactionDamage = reaction.bonus
          consumesAura = reaction.consumes
        }

        const totalDmg = action.estimatedDamage + reactionDamage
        target.hp = Math.max(0, target.hp - totalDmg)
        if (target.hp <= 0) {
          target.alive = false
        }
        // Apply or clear element
        if (action.applyElement > 0) {
          // Reaction consumed the old aura → apply new element
          // No reaction → overwrite with new element
          target.aura = action.applyElement
        } else if (consumesAura) {
          // Physical/normal skill that triggered shatter → clear aura
          target.aura = 0
        }
      }

      // Energy tracking (C)
      if (ns.activeIdx >= 0 && ns.chars[ns.activeIdx]) {
        const actor = ns.chars[ns.activeIdx]
        if (action.skillType === "burst") {
          // Burst: consume energy
          const energyCost = action.energyCost ?? actor.maxEnergy
          actor.energy = Math.max(0, actor.energy - energyCost)
        } else {
          // Normal or elemental: gain energy
          actor.energy = Math.min(actor.maxEnergy, actor.energy + 1)
        }
      }
      break
    }
    case "card": {
      // Remove card from hand
      const cardIdx = ns.handDefIds.indexOf(action.targetId)
      if (cardIdx >= 0) {
        ns.handDefIds.splice(cardIdx, 1)
      }
      // Rapid card effect simulation (A)
      applyRapidCardEffect(ns, oppNs, action)
      break
    }
    case "switch": {
      ns.activeIdx = action.targetId
      break
    }
    case "end": {
      ns.declaredEnd = true
      break
    }
  }

  return { newSnapshot: ns, opponentDelta: oppNs }
}

// ── Build MCTS actions from snapshot + engine actions ──

export interface EngineActionInfo {
  type: "useSkill" | "playCard" | "switchActive" | "declareEnd"
  cost: Map<DiceType, number>
  targetId?: number
  actorDefId?: number
  estimatedDamage?: number
  applyElement?: number
  fast?: boolean
  cardDefId?: number
  switchTargetIdx?: number
  /** Skill type for energy tracking */
  skillType?: "normal" | "elemental" | "burst" | null
  /** Energy cost for burst */
  energyCost?: number
  /** Known card effect hint */
  cardEffectHint?: "draw1" | "heal1" | "diceGen1" | "summonPlace" | "equip" | null
}

export function buildMctsAction(
  snap: ActionPhaseSnapshot,
  engineAction: EngineActionInfo,
): MctsAction | null {
  const alignedEl = snap.activeIdx >= 0
    ? mapAuraToElement(snap.chars[snap.activeIdx]?.aura ?? 0)
    : null

  // Check dice affordability
  if (!diceCanAfford(snap.dice, engineAction.cost, alignedEl)) {
    return null
  }

  switch (engineAction.type) {
    case "useSkill":
      return {
        type: "skill",
        cost: engineAction.cost,
        targetId: engineAction.targetId ?? 0,
        actorDefId: engineAction.actorDefId ?? 0,
        estimatedDamage: engineAction.estimatedDamage ?? 0,
        applyElement: engineAction.applyElement ?? 0,
        fast: false,
        skillType: engineAction.skillType ?? null,
        energyCost: engineAction.energyCost ?? undefined,
      }
    case "playCard":
      return {
        type: "card",
        cost: engineAction.cost,
        targetId: engineAction.cardDefId ?? 0,
        actorDefId: engineAction.actorDefId ?? 0,
        estimatedDamage: 0,
        applyElement: 0,
        fast: engineAction.fast ?? false,
        cardEffectHint: engineAction.cardEffectHint ?? null,
      }
    case "switchActive":
      return {
        type: "switch",
        cost: engineAction.cost,
        targetId: engineAction.switchTargetIdx ?? 0,
        actorDefId: 0,
        estimatedDamage: 0,
        applyElement: 0,
        fast: engineAction.fast ?? false,
      }
    case "declareEnd":
      return {
        type: "end",
        cost: new Map(),
        targetId: 0,
        actorDefId: 0,
        estimatedDamage: 0,
        applyElement: 0,
        fast: false,
      }
    default:
      return null
  }
}

// ── Helpers ──

function mapAuraToElement(aura: number): number | null {
  // Aura is stored as DiceType (1-7); return as-is for aligned cost
  if (aura >= 1 && aura <= 7) return aura
  return null
}

export function isOpponentAlive(snap: ActionPhaseSnapshot): boolean {
  return snap.chars.some((c) => c.alive)
}

export function selfActiveHp(snap: ActionPhaseSnapshot): number {
  if (snap.activeIdx < 0) return 0
  return snap.chars[snap.activeIdx]?.hp ?? 0
}

export function oppActiveHp(oppSnap: ActionPhaseSnapshot): number {
  if (oppSnap.activeIdx < 0) return 0
  return oppSnap.chars[oppSnap.activeIdx]?.hp ?? 0
}

// ── Deterministic hash for transposition table / caches ──

export function hashSnapshot(snap: ActionPhaseSnapshot): string {
  const parts: string[] = []
  parts.push(String(snap.who))
  parts.push(String(snap.activeIdx))
  parts.push(String(snap.declaredEnd))
  parts.push(String(snap.roundNumber))
  for (const c of snap.chars) {
    parts.push(`${c.id}:${c.definitionId}:${c.hp}:${c.maxHp}:${c.energy}:${c.maxEnergy}:${c.alive ? 1 : 0}:${c.aura}:${c.equipDefIds.join(",")}`)
  }
  for (const e of snap.supports) {
    parts.push(`S${e.id}:${e.definitionId}:${e.usage}:${e.maxUsage}`)
  }
  for (const e of snap.summons) {
    parts.push(`M${e.id}:${e.definitionId}:${e.usage}:${e.maxUsage}`)
  }
  for (const e of snap.combatStatuses) {
    parts.push(`C${e.id}:${e.definitionId}:${e.usage}:${e.maxUsage}`)
  }
  parts.push(snap.dice.join(","))
  parts.push(snap.handDefIds.join(","))
  return parts.join("|")
}
