// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Core type definitions for the Deck Analytics engine.
 *
 * All element enums mirror the game engine's DamageType/Aura values.
 * Dice cost types are extracted from character/card .ts source files.
 */

// ── Element Types ────────────────────────────────────────────

export type ElementType = "cryo" | "hydro" | "pyro" | "electro" | "anemo" | "geo" | "dendro";

export const ALL_ELEMENTS: ElementType[] = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"];

/** Maps DamageType enum name → our ElementType */
export function damageTypeToElement(dt: string): ElementType | "physical" | "piercing" {
  const map: Record<string, ElementType | "physical" | "piercing"> = {
    Cryo: "cryo", Hydro: "hydro", Pyro: "pyro", Electro: "electro",
    Anemo: "anemo", Geo: "geo", Dendro: "dendro",
    Physical: "physical", Piercing: "piercing",
  };
  return map[dt] ?? "physical";
}

// ── Dice Pool ─────────────────────────────────────────────────

/**
 * Represents a pool of dice available for actions.
 * Omni dice can substitute any element.
 */
export interface DicePool {
  cryo: number;
  hydro: number;
  pyro: number;
  electro: number;
  anemo: number;
  geo: number;
  dendro: number;
  omni: number;
}

/** Create an empty dice pool */
export function emptyDicePool(): DicePool {
  return { cryo: 0, hydro: 0, pyro: 0, electro: 0, anemo: 0, geo: 0, dendro: 0, omni: 0 };
}

/** Total dice count */
export function totalDice(pool: DicePool): number {
  return pool.cryo + pool.hydro + pool.pyro + pool.electro
       + pool.anemo + pool.geo + pool.dendro + pool.omni;
}

/** Subtract one pool from another (mutates target) */
export function subtractDice(target: DicePool, source: DicePool): void {
  target.cryo -= source.cryo;
  target.hydro -= source.hydro;
  target.pyro -= source.pyro;
  target.electro -= source.electro;
  target.anemo -= source.anemo;
  target.geo -= source.geo;
  target.dendro -= source.dendro;
  target.omni -= source.omni;
}

// ── Skill Cost ────────────────────────────────────────────────

/** A specific color requirement: N dice of a given element */
export interface ColoredCost {
  element: ElementType;
  count: number;
}

/**
 * Describes the dice cost of a skill or card.
 * This is the canonical representation extracted from source files.
 */
export interface SkillCost {
  /** Per-element requirements, e.g. { element: "pyro", count: 3 } */
  colored: ColoredCost[];
  /** Generic "any element" dice (costVoid) */
  void: number;
  /** "All same element" dice (costSame) — paid with any N dice of the same element */
  same: number;
  /** Energy cost for bursts */
  energy: number;
}

/** Create a zero-cost */
export function zeroCost(): SkillCost {
  return { colored: [], void: 0, same: 0, energy: 0 };
}

/** Total non-energy dice required */
export function totalDiceCost(cost: SkillCost): number {
  let sum = cost.void + cost.same;
  for (const c of cost.colored) sum += c.count;
  return sum;
}

// ── Skill & Character Data ────────────────────────────────────

export type SkillType = "normal" | "elemental" | "burst" | "passive" | "technique";

export interface SkillData {
  definitionId: number;
  name: string;
  type: SkillType;
  cost: SkillCost;
  /** Base damage [damageType, amount]. Empty if no simple .damage() call. */
  damage: { type: string; amount: number }[];
  /** Whether this skill creates a summon (extracted from .summon() calls) */
  createsSummon: boolean;
}

export interface CharacterData {
  definitionId: number;
  name: string;
  element: ElementType;
  health: number;
  maxEnergy: number;
  tags: string[];
  skills: SkillData[];
}

// ── Card Data ─────────────────────────────────────────────────

export type CardCategory = "equipment" | "event" | "support" | "talent" | "weapon" | "artifact" | "food";

export interface CardData {
  definitionId: number;
  name: string;
  category: CardCategory;
  cost: SkillCost;
  /** For talent/equipment cards: the character definitionId this card belongs to */
  characterId?: number;
  /** Effect tags extracted from comments or static-priors */
  effectTags: string[];
}

// ── Turn State ────────────────────────────────────────────────

export interface CharacterState {
  definitionId: number;
  name: string;
  element: ElementType;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  alive: boolean;
  /** Equipped card definition IDs */
  equipment: number[];
  /** Active status effect definition IDs */
  statuses: number[];
}

export interface OpponentState {
  /** Definition ID of this opponent character */
  definitionId: number;
  hp: number;
  maxHp: number;
  /** Current elemental aura — null if none */
  aura: ElementType | null;
  alive: boolean;
}

export interface CardState {
  definitionId: number;
  name: string;
  category: CardCategory;
  cost: SkillCost;
}

export interface TurnState {
  round: number;
  dice: DicePool;
  activeChar: CharacterState;
  bench: CharacterState[];
  hand: CardState[];
  opponents: OpponentState[];
}

// ── Actions ───────────────────────────────────────────────────

export type ActionType = "useSkill" | "playCard" | "switchActive" | "declareEnd" | "elementalTuning";

export interface ParsedAction {
  type: ActionType;
  /** For useSkill: the skill's definitionId */
  skillId?: number;
  /** For playCard: the card's definitionId */
  cardId?: number;
  /** For switchActive: target character index in bench (0-based) */
  switchTarget?: number;
  /** Cost pre-computed from the skill/card/switch cost */
  cost: SkillCost;
}

// ── Plugin Types ──────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface TurnStateDelta {
  diceSpent: DicePool;
  energyGained: number;
  energySpent: number;
  damageDealt: { targetIndex: number; amount: number; type: string }[];
  selfDamage: number;
  newAuras: { targetIndex: number; aura: ElementType | null }[];
  summonCreated: boolean;
}

export interface TurnMetrics {
  totalDiceSpent: number;
  totalDamageDealt: number;
  totalEnergyGained: number;
  actionCount: number;
}

// ── Deck Model ────────────────────────────────────────────────

export interface DeckModel {
  characters: CharacterData[];
  cards: CardData[];
}
