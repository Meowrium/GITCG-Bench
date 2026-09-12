// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * CardEffectPlugin — detects and applies card effects from TypeScript source.
 *
 * Static analysis of card .ts files to extract:
 *   1. Dice generation (Paimon: +2 omni/round)
 *   2. Cost reduction (王下近侍: -2 to next E/talent)
 *   3. Energy gain (Starsigns: +1 energy)
 *   4. Damage boost (weapons: +1 flat damage)
 *   5. Draw cards (Strategize: draw 2)
 *
 * Parses card builder chains and .do() blocks for effect patterns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DicePool, SkillCost, TurnState, ParsedAction,
  ValidationResult, TurnStateDelta, TurnMetrics,
  CardData, ElementType,
} from "../core/types.js";
import { emptyDicePool, zeroCost, ALL_ELEMENTS } from "../core/types.js";
import type { DeckAnalysisPlugin } from "./plugin-interface.js";

// ── Card Effect Types ────────────────────────────────────────

export type CardEffectKind =
  | "dice_generation"    // generates dice (Paimon +2 omni)
  | "cost_reduction"     // reduces skill/card cost (王下近侍 -2)
  | "energy_gain"        // gains energy (Starsigns +1)
  | "damage_boost"       // flat damage increase (weapon +1)
  | "draw"               // draw cards (Strategize draw 2)
  | "heal"               // healing
  | "fast_action";       // fast action (doesn't consume turn)

export interface CardEffect {
  kind: CardEffectKind;
  /** Amount (dice count, energy amount, damage bonus) */
  amount: number;
  /** Dice type for generation (null = omni) */
  diceType?: ElementType | "omni";
  /** For cost_reduction: what type of action it applies to */
  appliesTo?: "skill_elemental" | "skill_all" | "talent" | "any";
  /** For conditional: short description */
  condition?: string;
  /** Usage limit (-1 = infinite, 1 = once, N = N times) */
  usage: number;
  /** Per-round limit? */
  perRound: boolean;
  /** Source card definition ID */
  sourceCardId: number;
  /** Source card name */
  sourceCardName: string;
  /** Whether this effect has been consumed (for one-time effects) */
  consumed: boolean;
}

// ── Card Parser ───────────────────────────────────────────────

const CARD_DEF_RE = /export\s+const\s+(\w+)\s*=\s*card\((\d+)\)/g;

/**
 * Extract effects from a card .ts file.
 * Focuses on common patterns used in competitive decks.
 */
export function extractCardEffects(filePath: string): CardEffect[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const effects: CardEffect[] = [];

  const cardMatches = content.matchAll(CARD_DEF_RE);
  for (const cm of cardMatches) {
    const cardName = cm[1];
    const cardId = parseInt(cm[2], 10);
    const start = cm.index!;
    const after = content.slice(start);
    const doneIdx = after.indexOf(".done()");
    const block = doneIdx >= 0 ? after.slice(0, doneIdx) : after;

    // ── Dice Generation ──
    // .generateDice(DiceType.Omni, 2)
    const genDiceMatch = block.match(/\.generateDice\(DiceType\.(\w+),\s*(\d+)\)/);
    if (genDiceMatch) {
      const diceType = genDiceMatch[1].toLowerCase() as ElementType | "omni";
      effects.push({
        kind: "dice_generation",
        amount: parseInt(genDiceMatch[2], 10),
        diceType: diceType === "omni" ? "omni" : diceType,
        usage: -1, // per-round effects have infinite usage conceptually
        perRound: /\.on\("actionPhase"\)/.test(block) || /usagePerRound/.test(block),
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Energy Gain ──
    // .gainEnergy(1) or .do((c) => c.$("...")?.gainEnergy(1))
    const energyMatch = block.match(/\.gainEnergy\((\d+)\)/);
    if (energyMatch) {
      effects.push({
        kind: "energy_gain",
        amount: parseInt(energyMatch[1], 10),
        usage: 1,
        perRound: false,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Draw ──
    // .drawCards(N)
    const drawMatch = block.match(/\.drawCards\((\d+)\)/);
    if (drawMatch) {
      effects.push({
        kind: "draw",
        amount: parseInt(drawMatch[1], 10),
        usage: 1,
        perRound: false,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Damage Boost ──
    // .increaseDamage(N) — permanent weapon bonuses
    const dmgBoostMatch = block.match(/\.on\("increaseSkillDamage"\)\s*\.increaseDamage\((\d+)\)/);
    if (dmgBoostMatch) {
      const isPerRound = /\.usagePerRound/.test(block);
      effects.push({
        kind: "damage_boost",
        amount: parseInt(dmgBoostMatch[1], 10),
        usage: isPerRound ? 1 : -1,
        perRound: isPerRound,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Cost Reduction (via status) ──
    // Status cards like 王下近侍 create a status that reduces cost
    // .deductOmniCost(2) or .deductCost(...)
    const costRedMatch = block.match(/\.deductOmniCost\((\d+)\)/);
    if (costRedMatch) {
      effects.push({
        kind: "cost_reduction",
        amount: parseInt(costRedMatch[1], 10),
        appliesTo: "skill_elemental",
        usage: 1,
        perRound: false,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Fast Action ──
    if (/\.fastAction\(\)/.test(block) || /\.setFastAction\(\)/.test(block)) {
      effects.push({
        kind: "fast_action",
        amount: 0,
        usage: -1,
        perRound: false,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }

    // ── Talent "on enter useSkill" ──
    // 完场喝彩: .on("enter").useSkill(PropArrow)
    if (/\.on\("enter"\)\s*\.useSkill\(/.test(block)) {
      // This is a complex effect — the talent card triggers a skill use
      // We mark it as a special case
      effects.push({
        kind: "cost_reduction",
        amount: 99, // sentinel: triggers free skill use
        appliesTo: "talent",
        usage: 1,
        perRound: false,
        sourceCardId: cardId,
        sourceCardName: cardName,
        consumed: false,
      });
    }
  }

  return effects;
}

// ── Known Card Effect Registry ────────────────────────────────

/**
 * Pre-built registry of well-known card effects.
 * Populated from parsing card source files at init time.
 */
export class CardEffectRegistry {
  /** cardId → effects */
  private effects = new Map<number, CardEffect[]>();

  /** Load effects from cards directory */
  loadFromDir(cardsDir: string): void {
    const self = this;
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const effects = extractCardEffects(full);
          for (const e of effects) {
            const existing = self.effects.get(e.sourceCardId) ?? [];
            existing.push(e);
            self.effects.set(e.sourceCardId, existing);
          }
        }
      }
    }
    walk(cardsDir);
  }

  /** Get effects for a specific card */
  getEffects(cardId: number): CardEffect[] {
    return this.effects.get(cardId) ?? [];
  }

  /** Check if a card has a specific effect kind */
  hasEffect(cardId: number, kind: CardEffectKind): boolean {
    return this.getEffects(cardId).some((e) => e.kind === kind);
  }

  /** Get total dice generation from a card per round */
  getDiceGeneration(cardId: number): number {
    return this.getEffects(cardId)
      .filter((e) => e.kind === "dice_generation")
      .reduce((s, e) => s + e.amount, 0);
  }
}

// ── Plugin ───────────────────────────────────────────────────

export class CardEffectPlugin implements DeckAnalysisPlugin {
  readonly name = "CardEffect";
  private registry: CardEffectRegistry;
  /** Active effects (from played cards that are still in effect) */
  private activeEffects: CardEffect[] = [];
  /** Cost reduction available (from 王下近侍-style effects) */
  private pendingCostReduction = 0;

  constructor(registry?: CardEffectRegistry) {
    this.registry = registry ?? new CardEffectRegistry();
  }

  getRegistry(): CardEffectRegistry {
    return this.registry;
  }

  validate(action: ParsedAction, state: TurnState): ValidationResult {
    return { valid: true }; // effects are applied during apply, not validated
  }

  apply(action: ParsedAction, state: TurnState): TurnStateDelta {
    const delta: TurnStateDelta = {
      diceSpent: emptyDicePool(),
      energyGained: 0,
      energySpent: 0,
      damageDealt: [],
      selfDamage: 0,
      newAuras: [],
      summonCreated: false,
    };

    if (action.type === "playCard" && action.cardId) {
      const effects = this.registry.getEffects(action.cardId);

      for (const effect of effects) {
        if (effect.kind === "dice_generation") {
          // Add dice to pool
          if (effect.diceType && effect.diceType !== "omni") {
            const el = effect.diceType as ElementType;
            state.dice[el] += effect.amount;
          } else {
            state.dice.omni += effect.amount;
          }
          delta.energyGained += 0; // dice gen not energy
        }

        if (effect.kind === "energy_gain" && !effect.consumed) {
          state.activeChar.energy = Math.min(
            state.activeChar.maxEnergy,
            state.activeChar.energy + effect.amount,
          );
          delta.energyGained += effect.amount;
          effect.consumed = true;
        }

        if (effect.kind === "cost_reduction" && !effect.consumed) {
          if (effect.amount === 99) {
            // Special: talent card triggers a free skill (完场喝彩 pattern)
            // The free skill is handled separately by the simulator
          } else {
            this.pendingCostReduction += effect.amount;
          }
          effect.consumed = true;
        }

        if (effect.kind === "draw") {
          // In static analysis, draw = more options, not modeled directly
          // We just record it
        }

        if (effect.kind === "damage_boost") {
          // Add to active effects
          this.activeEffects.push({ ...effect });
        }
      }
    }

    // Apply pending cost reduction to next applicable action
    if (action.type === "useSkill" && this.pendingCostReduction > 0) {
      // Reduce the action's cost by this amount (omni/void portion)
      // For static analysis, we just reduce void cost
      const reducedBy = Math.min(this.pendingCostReduction, action.cost.void + action.cost.same);
      action.cost.void = Math.max(0, action.cost.void - reducedBy);
      // If void isn't enough, reduce colored costs
      let remaining = reducedBy - reducedBy; // already applied above
      this.pendingCostReduction = 0;
    }

    return delta;
  }

  observeTurn(_state: TurnState, _actions: ParsedAction[]): TurnMetrics {
    // Reset per-turn state
    this.pendingCostReduction = 0;
    for (const e of this.activeEffects) {
      if (e.perRound) e.consumed = false;
    }
    return {
      totalDiceSpent: 0,
      totalDamageDealt: 0,
      totalEnergyGained: 0,
      actionCount: _actions.length,
    };
  }

  /** Get total active damage boost */
  getDamageBoost(): number {
    return this.activeEffects
      .filter((e) => e.kind === "damage_boost" && !e.consumed)
      .reduce((s, e) => s + e.amount, 0);
  }

  /** Reset all state */
  reset(): void {
    this.activeEffects = [];
    this.pendingCostReduction = 0;
  }
}
