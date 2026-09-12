// Copyright (C) 2024-2025 Guyutongxue
//
// Game-theoretic declareEnd prior-penalty constraints.
//
// Replaces learned declareEnd bias with deterministic, composable
// prior penalties derived from game mechanics and game theory.
// See: packages/gitcg-theory/declareEnd-hard-constraints.md
//
// Architecture:
//   declareEnd.prior_penalty = max(
//     penalty_kill,          // Constraint 1: Kill threshold
//     penalty_opp_ended,     // Constraint 2: Opponent ended → free window
//     penalty_dice_budget,   // Constraint 3: Dice budget floor (core)
//     penalty_special_cards, // Tenkaku/Whale exception adjustment
//   ) * phase_weight        // Constraint 4: Phase-aware soft adjustment

import type { ActionPhaseSnapshot } from "../../mcts/state-snapshot.js";
import type { PolicyCandidateAction } from "./types.js";
import { diceTotal } from "../../mcts/dice-vector.js";

// ── Penalty constants (calibrated for logit space ln(score^(1/T)), T=3) ──

/** Constraint 1: Kill threshold — near-absolute forbid (prior ≈ 1e-6). */
export const KILL_PENALTY = 14;
/** Constraint 2: Opponent ended — strong suppression (prior ≈ 0.1%). */
export const OPP_ENDED_PENALTY = 8;
/** Constraint 3: Dice budget base — moderate suppression. */
export const BASE_PENALTY = 4;
/** Special card reverse adjustment — offsets other penalties for Tenkaku/Whale. */
export const SPECIAL_REDUCTION = 2;

// ── Special card IDs ──
const TENKAKU_ID = 321007;    // Tenshukaku — 天守阁
const WHALE_CHAR_ID = 2204;   // Alldevouring Narwhal — 吞星之鲸

// ── Element ↔ DiceType mapping ──
const ELEMENT_TO_DICE: Record<string, number> = {
  pyro: 1, hydro: 2, cryo: 3, electro: 4,
  anemo: 5, geo: 6, dendro: 7,
};

// ── Reaction damage bonus (V31 F1: engine-aligned FLAT additive) ──
// Engine applies reaction damage as a flat increment, NOT a multiplier
// (core/src/base/skill.ts:963-997):
//   - Melt / Vaporize / Overloaded → +2
//   - other valid reactions        → +1
function estimateReactionBonus(
  attackElement: number,
  targetAura: number,
  _baseDamage: number,
): { bonus: number; isAmplifying: boolean } {
  // Pyro + Hydro/Cryo → Vaporize/Melt (amplifying, flat +2)
  if (attackElement === 1 && (targetAura === 2 || targetAura === 3)) {
    return { bonus: 2, isAmplifying: true };
  }
  // Hydro + Pyro → Vaporize (amplifying, flat +2)
  if (attackElement === 2 && targetAura === 1) {
    return { bonus: 2, isAmplifying: true };
  }
  // Cryo + Pyro → Melt (amplifying, flat +2)
  if (attackElement === 3 && targetAura === 1) {
    return { bonus: 2, isAmplifying: true };
  }
  // All other reactions: flat +1
  if (attackElement > 0 && targetAura > 0) {
    return { bonus: 1, isAmplifying: false };
  }
  return { bonus: 0, isAmplifying: false };
}

// ── Static character skill base damage lookup ──
//
// Extracted from @gi-tcg/data character skill definitions.
// Format: { normal, elemental, burst }
// TODO: auto-generate from data package at build time.
//
const SKILL_BASE_DAMAGE: Record<number, { normal: number; elemental: number; burst: number }> = {
  // ── Electro ──
  1401: { normal: 1, elemental: 3, burst: 4 },  // Fischl
  1402: { normal: 2, elemental: 3, burst: 4 },  // Keqing
  1403: { normal: 1, elemental: 4, burst: 3 },  // Razor
  1404: { normal: 1, elemental: 1, burst: 2 },  // Lisa (E charges)
  1405: { normal: 2, elemental: 3, burst: 7 },  // Cyno
  1406: { normal: 2, elemental: 4, burst: 2 },  // Yae Miko (sesshou sakura)
  1407: { normal: 1, elemental: 2, burst: 3 },  // Raiden Shogun (雷神)
  1408: { normal: 2, elemental: 3, burst: 4 },  // Beidou
  1409: { normal: 2, elemental: 3, burst: 1 },  // Dori

  // ── Pyro ──
  1301: { normal: 1, elemental: 3, burst: 2 },  // Diluc
  1302: { normal: 1, elemental: 2, burst: 2 },  // Bennett
  1303: { normal: 2, elemental: 1, burst: 3 },  // Amber
  1304: { normal: 2, elemental: 3, burst: 3 },  // Xiangling
  1305: { normal: 2, elemental: 3, burst: 4 },  // Yoimiya (宵宫)
  1306: { normal: 2, elemental: 4, burst: 4 },  // Hu Tao
  1307: { normal: 2, elemental: 3, burst: 8 },  // Klee
  1308: { normal: 2, elemental: 3, burst: 2 },  // Dehya (迪希雅)
  1309: { normal: 2, elemental: 3, burst: 8 },  // Arlecchino
  1310: { normal: 2, elemental: 4, burst: 3 },  // Xinyan
  1311: { normal: 2, elemental: 2, burst: 3 },  // Chevreuse
  1312: { normal: 2, elemental: 4, burst: 2 },  // Mavuika

  // ── Cryo ──
  1101: { normal: 1, elemental: 3, burst: 1 },  // Kaeya
  1102: { normal: 2, elemental: 1, burst: 2 },  // Qiqi
  1103: { normal: 2, elemental: 3, burst: 4 },  // Ganyu
  1104: { normal: 2, elemental: 3, burst: 4 },  // Diona
  1105: { normal: 2, elemental: 3, burst: 4 },  // Ayaka (神里)
  1106: { normal: 2, elemental: 3, burst: 4 },  // Chongyun (重云)
  1107: { normal: 2, elemental: 3, burst: 2 },  // Shenhe (申鹤)
  1108: { normal: 2, elemental: 3, burst: 2 },  // Eula
  1109: { normal: 2, elemental: 3, burst: 5 },  // Citlali
  1110: { normal: 2, elemental: 3, burst: 4 },  // Layla
  1111: { normal: 2, elemental: 3, burst: 5 },  // Freminet
  1112: { normal: 2, elemental: 3, burst: 4 },  // Mika
  1113: { normal: 1, elemental: 3, burst: 1 },  // Charlotte

  // ── Hydro ──
  1201: { normal: 1, elemental: 3, burst: 1 },  // Barbara
  1202: { normal: 2, elemental: 1, burst: 4 },  // Xingqiu
  1203: { normal: 2, elemental: 2, burst: 2 },  // Tartaglia
  1204: { normal: 2, elemental: 4, burst: 4 },  // Mona
  1205: { normal: 1, elemental: 3, burst: 2 },  // Sangonomiya Kokomi
  1206: { normal: 1, elemental: 3, burst: 2 },  // Candace
  1207: { normal: 2, elemental: 3, burst: 4 },  // Nilou
  1208: { normal: 1, elemental: 2, burst: 2 },  // Furina
  1209: { normal: 2, elemental: 3, burst: 4 },  // Yelan
  1210: { normal: 2, elemental: 3, burst: 4 },  // Ayato
  1211: { normal: 2, elemental: 3, burst: 4 },  // Neuvillette

  // ── Anemo ──
  1501: { normal: 1, elemental: 1, burst: 2 },  // Sucrose
  1502: { normal: 2, elemental: 3, burst: 2 },  // Venti
  1503: { normal: 2, elemental: 3, burst: 4 },  // Xiao
  1504: { normal: 2, elemental: 1, burst: 4 },  // Jean
  1505: { normal: 2, elemental: 5, burst: 8 },  // Wanderer (流浪者)
  1506: { normal: 2, elemental: 3, burst: 2 },  // Lynette

  // ── Geo ──
  1601: { normal: 2, elemental: 3, burst: 5 },  // Ningguang
  1602: { normal: 2, elemental: 3, burst: 4 },  // Noelle
  1603: { normal: 2, elemental: 4, burst: 6 },  // Zhongli
  1604: { normal: 2, elemental: 3, burst: 4 },  // Albedo
  1605: { normal: 2, elemental: 3, burst: 5 },  // Arataki Itto (一斗)
  1607: { normal: 2, elemental: 2, burst: 1 },  // Yun Jin
  1608: { normal: 2, elemental: 2, burst: 2 },  // Gorou
  1609: { normal: 2, elemental: 3, burst: 6 },  // Navia

  // ── Dendro ──
  1701: { normal: 1, elemental: 2, burst: 1 },  // Nahida
  1702: { normal: 1, elemental: 2, burst: 2 },  // Tighnari
  1703: { normal: 2, elemental: 3, burst: 2 },  // Collei
  1704: { normal: 2, elemental: 3, burst: 3 },  // Alhaitham
  1705: { normal: 2, elemental: 3, burst: 2 },  // Baizhu
  1706: { normal: 2, elemental: 3, burst: 3 },  // Yaoyao
  1707: { normal: 2, elemental: 4, burst: 2 },  // Kinich

  // ── Monsters (2401-2499) ──
  2204: { normal: 2, elemental: 1, burst: 4 },  // Alldevouring Narwhal (吞星之鲸)
};

// ── Known equipment damage bonus IDs ──
// Equipment cards that provide +1 or +2 damage to skills.
const DAMAGE_EQUIP_IDS = new Set([
  // Talent cards providing damage bonus:
  212041, // 深渊之灾·凝水盛放 (Mona talent, +2 hydro dmg)
  213051, // 长野原龙势流星群 (Yoimiya talent)
  213091, // 崇诚之真 (Lyney talent)
  214011, // 噬星魔鸦 (Fischl talent)
  214031, // 抵天雷罚 (Beidou talent)
  // Weapons:
  // (Add more as discovered via benchmark / data inspection)
]);

// ── Public API ──────────────────────────────────────────────────────────

export interface DeclareEndConstraintContext {
  selfSnap: ActionPhaseSnapshot;
  oppSnap: ActionPhaseSnapshot;
  candidates: PolicyCandidateAction[];
  /** Whether we are P0 (going first this round). Derived from round order. */
  isFirstMover: boolean;
  /** Value function for max_Q_non_end. If omitted, constraint 2 uses rule-based fallback. */
  valueFn?: (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => number;
}

export interface DeclareEndPenaltyResult {
  /** Total penalty to subtract from declareEnd's logit. */
  penalty: number;
  /** Per-constraint breakdown for debugging. */
  breakdown: {
    penalty_kill: number;
    penalty_opp_ended: number;
    penalty_dice_budget: number;
    penalty_special_cards: number;
    phase_weight: number;
  };
}

/**
 * Compute the composite declareEnd prior penalty.
 *
 * Called during MCTS prior computation, BEFORE the log-scores are calculated.
 * Subtracted directly from the declareEnd candidate's logit.
 */
export function computeDeclareEndPenalty(
  ctx: DeclareEndConstraintContext,
): DeclareEndPenaltyResult {
  const { selfSnap, oppSnap, candidates, isFirstMover } = ctx;

  const breakdown = {
    penalty_kill: 0,
    penalty_opp_ended: 0,
    penalty_dice_budget: 0,
    penalty_special_cards: 0,
    phase_weight: 1.0, // Phase-aware guidance deferred (Constraint 4).
  };

  // ── Constraint 1: Kill threshold ──
  breakdown.penalty_kill = computeKillPenalty(selfSnap, oppSnap, candidates);

  // ── Constraint 2: Opponent ended → free window ──
  breakdown.penalty_opp_ended = computeOppEndedPenalty(
    oppSnap,
    selfSnap,
    candidates,
    ctx.valueFn,
  );

  // ── Constraint 3: Dice budget floor ──
  breakdown.penalty_dice_budget = computeDiceBudgetPenalty(
    selfSnap,
    oppSnap,
    candidates,
    isFirstMover,
  );

  // ── Special card exception adjustment ──
  breakdown.penalty_special_cards = computeSpecialCardsAdjustment(selfSnap);

  // ── Aggregate ──
  const penalty = Math.max(
    breakdown.penalty_kill,
    breakdown.penalty_opp_ended,
    breakdown.penalty_dice_budget,
    breakdown.penalty_special_cards,
  ) * breakdown.phase_weight;

  return { penalty, breakdown };
}

// ── Constraint 1: Kill threshold ────────────────────────────────────────

function computeKillPenalty(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  candidates: PolicyCandidateAction[],
): number {
  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  if (!oppActive || !oppActive.alive) return 0;

  const oppHp = oppActive.hp;

  for (const c of candidates) {
    if (c.action_case !== "useSkill") continue;

    // Use candidate's damage_estimate (from engine preview) as primary source.
    // Supplement with static character damage lookup for cases where
    // the engine preview underestimates multi-hit damage.
    const previewDmg = safeNum(c.damage_estimate);
    const staticDmg = estimateSkillDamage(selfSnap, oppSnap, c);
    const dmg = Math.max(previewDmg, staticDmg);

    if (dmg >= oppHp && dmg > 0) {
      return KILL_PENALTY;
    }
  }

  return 0;
}

// ── Constraint 2: Opponent ended → free window ──────────────────────────

function computeOppEndedPenalty(
  oppSnap: ActionPhaseSnapshot,
  selfSnap: ActionPhaseSnapshot,
  candidates: PolicyCandidateAction[],
  valueFn?: (snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => number,
): number {
  if (!oppSnap.declaredEnd) return 0;

  // Check if there's at least one non-declareEnd action with positive expected value.
  const nonEndCandidates = candidates.filter(
    (c) => c.action_case !== "declareEnd",
  );

  if (nonEndCandidates.length === 0) return 0;

  // Rule-based quick check: any candidate with damage, heal, draw, or setup value.
  const hasPositiveRule = nonEndCandidates.some(
    (c) =>
      safeNum(c.damage_estimate) > 0 ||
      safeNum(c.healing_estimate) > 0 ||
      safeNum(c.draw_value) > 0 ||
      safeNum(c.dice_fix_value) > 0 ||
      safeNum(c.create_support_value) > 0 ||
      safeNum(c.create_summon_value) > 0 ||
      safeNum(c.energy_gain_value) > 0,
  );

  if (hasPositiveRule) return OPP_ENDED_PENALTY;

  // If no rule-based positive signal, try value model.
  if (valueFn) {
    // Evaluate current state — if value > 0 (winning), declareEnd acceptable.
    const currentValue = valueFn(selfSnap, oppSnap);
    if (currentValue > 0) return 0; // Already winning, ending is fine.

    // Otherwise: opponent ended but we're behind — any action is better than doing nothing.
    return OPP_ENDED_PENALTY;
  }

  // Fallback: if only switch actions remain, don't penalize (per user answer).
  const onlySwitchesLeft = nonEndCandidates.every(
    (c) => c.action_case === "switchActive" || c.action_case === "fastSwitch",
  );
  if (onlySwitchesLeft) return 0;

  return 0; // Insufficient signal to penalize.
}

// ── Constraint 3: Dice budget floor ─────────────────────────────────────

function computeDiceBudgetPenalty(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  candidates: PolicyCandidateAction[],
  isFirstMover: boolean,
): number {
  // 1. Find minimum skill cost among available skill actions.
  const skillCandidates = candidates.filter(
    (c) => c.action_case === "useSkill",
  );
  if (skillCandidates.length === 0 && !hasSetupActions(candidates)) {
    // No attack AND no setup actions → no penalty for ending.
    return 0;
  }

  // 2. Dice factor: how many more attacks could we afford?
  const remainingDice = diceTotal(selfSnap.dice);
  const minSkillCost = findMinSkillCost(candidates) ?? 3;

  let diceFactor: number;
  if (remainingDice >= minSkillCost * 2) {
    diceFactor = 1.5; // Can afford 2+ attacks — high opportunity cost
  } else if (remainingDice >= minSkillCost) {
    diceFactor = 1.0; // Can afford 1 attack
  } else {
    // Not enough dice for a skill. Check if all dice are unaligned (no tuning cards).
    if (allDiceUnaligned(selfSnap)) {
      return 0; // Can't attack even with tuning — no penalty.
    }
    // Could potentially tune and attack — light penalty.
    diceFactor = 0.3;
  }

  // 3. Attack factor: quality of available attacks.
  const attackFactor = computeAttackFactor(
    selfSnap,
    oppSnap,
    skillCandidates,
  );
  if (attackFactor <= 0) return 0; // No useful attack — skip penalty.

  // 4. Mover factor: first-mover advantage.
  let moverFactor: number;
  if (isFirstMover && !oppSnap.declaredEnd) {
    // P0 before opponent acts: free attack window — penalize ending MORE.
    moverFactor = 1.5;
  } else if (isFirstMover && oppSnap.declaredEnd) {
    moverFactor = 1.0; // Constraint 2 handles opponent-ended separately.
  } else if (!isFirstMover && !oppSnap.declaredEnd) {
    moverFactor = 0.8; // P1 has info advantage — can judge more precisely.
  } else {
    moverFactor = 1.5; // P1 + opponent ended → free window (constraint 2).
  }

  return BASE_PENALTY * diceFactor * attackFactor * moverFactor;
}

// ── Constraint 3 helpers ─────────────────────────────────────────────────

function findMinSkillCost(candidates: PolicyCandidateAction[]): number | null {
  let minCost: number | null = null;
  for (const c of candidates) {
    if (c.action_case !== "useSkill") continue;
    const cost = extractDiceCost(c);
    if (cost > 0 && (minCost === null || cost < minCost)) {
      minCost = cost;
    }
  }
  return minCost;
}

function extractDiceCost(c: PolicyCandidateAction): number {
  // Try common cost fields.
  const raw = (c as any).dice_cost ?? (c as any).cost_dice ?? (c as any).total_cost;
  if (typeof raw === "number") return raw;
  if (raw && typeof raw === "object") {
    // CostMap-like: { type: count, ... }
    let total = 0;
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (typeof v === "number") total += v;
    }
    if (total > 0) return total;
  }
  // Fallback: assume 3 dice for elemental skill, 2 for normal.
  const tags = String((c as any).tags ?? "");
  if (tags.includes("burst")) return 4;
  if (tags.includes("elementalSkill")) return 3;
  return 2; // Normal attack
}

function allDiceUnaligned(snap: ActionPhaseSnapshot): boolean {
  const activeChar = snap.chars[snap.activeIdx];
  if (!activeChar) return true;
  const activeElem = mapAuraToDiceType(activeChar.aura);
  if (activeElem <= 0) return true;
  // Check if any dice matches the active character's element.
  for (const d of snap.dice) {
    if (d === activeElem || d === 0 || d >= 8) return false; // 0=omni? 8=omni
  }
  // Also check for omni dice (index 7 = omni).
  if ((snap.dice[7] ?? 0) > 0) return false;
  return true;
}

function computeAttackFactor(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  skillCandidates: PolicyCandidateAction[],
): number {
  if (skillCandidates.length === 0) return 0;

  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  const oppHp = oppActive?.hp ?? 999;
  const activeChar = selfSnap.chars[selfSnap.activeIdx];
  const selfElem = activeChar ? mapAuraToDiceType(activeChar.aura) : 0;

  let maxFactor = 0;

  for (const c of skillCandidates) {
    const previewDmg = safeNum(c.damage_estimate);
    const staticDmg = estimateSkillDamageRaw(selfSnap, c);
    const dmg = Math.max(previewDmg, staticDmg);

    // L0: Kill threshold → handled by constraint 1 (penalty_kill).
    if (dmg >= oppHp && dmg > 0) {
      return 1.5; // Max factor — constraint 1 adds the kill penalty.
    }

    // L1: High damage + amplifying reaction.
    const oppAura = oppActive?.aura ?? 0;
    const reaction = estimateReactionBonus(selfElem, oppAura, dmg);
    const totalDmg = dmg + reaction.bonus;

    if (totalDmg >= oppHp) {
      maxFactor = Math.max(maxFactor, 1.5);
      continue;
    }

    if (dmg >= 3 && reaction.isAmplifying) {
      maxFactor = Math.max(maxFactor, 1.2); // L1
    } else if (dmg >= 3) {
      maxFactor = Math.max(maxFactor, 1.0); // L1'
    } else if (dmg >= 1 && reaction.bonus === 0) {
      maxFactor = Math.max(maxFactor, 0.6); // L2
    } else if (dmg >= 1) {
      maxFactor = Math.max(maxFactor, 0.3); // L2' — gives opponent aura
    }
  }

  // L3: If no useful attack, check for setup actions.
  if (maxFactor <= 0) {
    if (hasSetupActionsInList(skillCandidates)) {
      return 0; // Setup actions are valid — don't penalize ending.
    }
    // L3': weak normal attack vs full-hp opponent.
    if (oppHp >= (oppActive?.maxHp ?? 10)) {
      return 0.2;
    }
  }

  return maxFactor;
}

function hasSetupActions(candidates: PolicyCandidateAction[]): boolean {
  return candidates.some(
    (c) =>
      c.action_case === "playCard" &&
      (safeNum(c.create_support_value) > 0 ||
        safeNum(c.create_summon_value) > 0 ||
        safeNum(c.create_equipment_value) > 0 ||
        safeNum(c.dice_fix_value) > 0 ||
        safeNum(c.draw_value) > 0 ||
        safeNum(c.energy_gain_value) > 0),
  );
}

function hasSetupActionsInList(candidates: PolicyCandidateAction[]): boolean {
  // Check if ANY candidate is a setup action (not just skill candidates).
  return hasSetupActions(candidates);
}

// ── Special cards ────────────────────────────────────────────────────────

function computeSpecialCardsAdjustment(
  selfSnap: ActionPhaseSnapshot,
): number {
  let adjustment = 0;

  // Tenkaku (321007) — needs diverse dice colors to trigger omni generation.
  const hasTenkaku =
    selfSnap.handDefIds.includes(TENKAKU_ID) ||
    selfSnap.supports.some((s) => s.definitionId === TENKAKU_ID);

  if (hasTenkaku) {
    const nonOmniTypes = new Set<number>();
    let omniCount = 0;
    for (const d of selfSnap.dice) {
      if (d >= 1 && d <= 7) {
        nonOmniTypes.add(d);
      } else if (d === 0 || d === 8) {
        omniCount++;
      }
    }
    const effectiveDiversity = nonOmniTypes.size + omniCount;
    // If diversity is close to 5 (trigger threshold), using any die may break it.
    if (effectiveDiversity >= 4 && effectiveDiversity < 5 + omniCount) {
      adjustment = -SPECIAL_REDUCTION;
    }
  }

  // Whale (2204) — needs high-cost hand cards to discard for HP growth.
  const hasWhale = selfSnap.chars.some((c) => c.definitionId === WHALE_CHAR_ID);
  if (hasWhale) {
    // Whale benefits from keeping dice AND hand cards.
    // If we have hand cards (proxied by handDefIds) and low dice, allow ending.
    if (selfSnap.handDefIds.length >= 2) {
      adjustment = Math.min(adjustment, -SPECIAL_REDUCTION);
    }
  }

  return adjustment;
}

// ── Damage estimation ────────────────────────────────────────────────────

/**
 * Estimate skill damage for a useSkill candidate.
 *
 * Priority:
 * 1. Static character skill base damage lookup
 * 2. + Equipment bonus (if equipDefIds includes known damage-boosting cards)
 * 3. + Reaction bonus estimation
 *
 * Falls back to candidate.damage_estimate if static data unavailable.
 */
function estimateSkillDamage(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  candidate: PolicyCandidateAction,
): number {
  const activeChar = selfSnap.chars[selfSnap.activeIdx];
  if (!activeChar) return 0;

  const charData = SKILL_BASE_DAMAGE[activeChar.definitionId];
  if (!charData) return 0; // Unknown character — rely on preview.

  // Determine skill type.
  const skillType = inferSkillType(candidate);
  let baseDmg: number;
  switch (skillType) {
    case "normal":
      baseDmg = charData.normal;
      break;
    case "elemental":
      baseDmg = charData.elemental;
      break;
    case "burst":
      baseDmg = charData.burst;
      break;
    default:
      return 0;
  }

  // Equipment bonus.
  let equipBonus = 0;
  for (const equipId of activeChar.equipDefIds) {
    if (DAMAGE_EQUIP_IDS.has(equipId)) {
      equipBonus += 1; // Simplified: most weapons/talents add +1.
    }
  }

  // Reaction bonus.
  const selfElem = mapAuraToDiceType(activeChar.aura);
  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  const reaction = oppActive
    ? estimateReactionBonus(selfElem, oppActive.aura, baseDmg)
    : { bonus: 0, isAmplifying: false };

  return baseDmg + equipBonus + reaction.bonus;
}

/**
 * Estimate raw damage without reaction (for attack factor).
 */
function estimateSkillDamageRaw(
  selfSnap: ActionPhaseSnapshot,
  candidate: PolicyCandidateAction,
): number {
  const activeChar = selfSnap.chars[selfSnap.activeIdx];
  if (!activeChar) return 0;

  const charData = SKILL_BASE_DAMAGE[activeChar.definitionId];
  if (!charData) return 0;

  const skillType = inferSkillType(candidate);
  switch (skillType) {
    case "normal": return charData.normal;
    case "elemental": return charData.elemental;
    case "burst": return charData.burst;
    default: return 0;
  }
}

function inferSkillType(
  candidate: PolicyCandidateAction,
): "normal" | "elemental" | "burst" | null {
  const tags = String((candidate as any).tags ?? "");
  const ac = candidate.action_case;
  if (ac === "elementalSkill" || tags.includes("elementalSkill")) return "elemental";
  if (tags.includes("burst") || tags.includes("elementalBurst")) return "burst";
  return "normal"; // Default for useSkill without specific tags.
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapAuraToDiceType(aura: number): number {
  if (aura >= 1 && aura <= 7) return aura;
  return 0;
}
