/**
 * label-taxonomy.ts — Standardized label system for semantic matching.
 *
 * Two-layer labels:
 *   1. Action category labels — what type of action it is
 *   2. Strategy intent labels — what strategic goal it serves
 *
 * Plus a synonym mapping table for Chinese/English free-text → standard labels.
 */

// ── Action Category Labels ──────────────────────────────────────────────────

export const ACTION_CATEGORY_LABELS = [
  "attack",
  "normal_attack",
  "elemental_skill",
  "elemental_burst",
  "burst",
  "skill",
  "switch",
  "support",
  "playcard",
  "heal",
  "shield",
  "summon",
  "end_turn",
] as const;

export type ActionCategoryLabel = (typeof ACTION_CATEGORY_LABELS)[number];

// ── Strategy Intent Labels ──────────────────────────────────────────────────

export const STRATEGY_INTENT_LABELS = [
  "stabilize_tempo",
  "aggressive_push",
  "build_energy",
  "setup_reaction",
  "protect_core",
  "conserve_resources",
  "burst_finish",
] as const;

export type StrategyIntentLabel = (typeof STRATEGY_INTENT_LABELS)[number];

// ── All Standard Labels (union) ─────────────────────────────────────────────

export const ALL_STANDARD_LABELS: ReadonlySet<string> = new Set([
  ...ACTION_CATEGORY_LABELS,
  ...STRATEGY_INTENT_LABELS,
]);

// ── Synonym Mapping Table ───────────────────────────────────────────────────
// Maps free-text variants (Chinese + English) to standard labels.
// Keys are lowercased for lookup.

export const SYNONYM_MAP: ReadonlyMap<string, string> = new Map([
  // stabilize_tempo
  ["稳定节奏", "stabilize_tempo"],
  ["节奏稳定", "stabilize_tempo"],
  ["保持节奏", "stabilize_tempo"],
  ["稳节奏", "stabilize_tempo"],
  ["tempo", "stabilize_tempo"],
  ["stabilize", "stabilize_tempo"],
  ["keep_tempo", "stabilize_tempo"],
  ["maintain_tempo", "stabilize_tempo"],

  // aggressive_push
  ["全力进攻", "aggressive_push"],
  ["猛攻", "aggressive_push"],
  ["进攻", "aggressive_push"],
  ["激进", "aggressive_push"],
  ["aggressive", "aggressive_push"],
  ["push", "aggressive_push"],
  ["all_in", "aggressive_push"],
  ["rush", "aggressive_push"],
  ["全力输出", "aggressive_push"],

  // build_energy
  ["充能", "build_energy"],
  ["蓄能", "build_energy"],
  ["攒能量", "build_energy"],
  ["积攒能量", "build_energy"],
  ["energy", "build_energy"],
  ["charge", "build_energy"],
  ["charge_energy", "build_energy"],

  // setup_reaction
  ["元素反应", "setup_reaction"],
  ["挂元素", "setup_reaction"],
  ["反应", "setup_reaction"],
  ["准备反应", "setup_reaction"],
  ["reaction", "setup_reaction"],
  ["element_setup", "setup_reaction"],
  ["setup", "setup_reaction"],

  // protect_core
  ["保护核心", "protect_core"],
  ["保核心", "protect_core"],
  ["换人保护", "protect_core"],
  ["保护", "protect_core"],
  ["protect", "protect_core"],
  ["defend", "protect_core"],
  ["guard", "protect_core"],

  // conserve_resources
  ["节省资源", "conserve_resources"],
  ["省骰子", "conserve_resources"],
  ["节约", "conserve_resources"],
  ["conserve", "conserve_resources"],
  ["save_dice", "conserve_resources"],
  ["save_resources", "conserve_resources"],
  ["经济", "conserve_resources"],

  // burst_finish
  ["大招收割", "burst_finish"],
  ["爆发", "burst_finish"],
  ["放大招", "burst_finish"],
  ["收割", "burst_finish"],
  ["finish", "burst_finish"],
  ["burst_kill", "burst_finish"],
  ["ultimate", "burst_finish"],

  // burst (action category — kept for backward compat, resolves to elemental_burst)
  ["burst", "elemental_burst"],

  // Action category synonyms — fine-grained skill types
  // "skill" is the generic label covering all three: normal_attack, elemental_skill, elemental_burst
  ["攻击", "attack"],
  ["普攻", "normal_attack"],
  ["normal_attack", "normal_attack"],
  ["普通攻击", "normal_attack"],
  ["平a", "normal_attack"],
  ["平A", "normal_attack"],
  ["大招", "elemental_burst"],
  ["元素爆发", "elemental_burst"],
  ["elemental_burst", "elemental_burst"],
  ["q技能", "elemental_burst"],
  ["放q", "elemental_burst"],
  ["战技", "elemental_skill"],
  ["元素战技", "elemental_skill"],
  ["元素技能", "elemental_skill"],
  ["elemental_skill", "elemental_skill"],
  ["e技能", "elemental_skill"],
  ["放e", "elemental_skill"],
  ["技能", "skill"],
  // action_case direct mappings for fragment matching
  ["useskill", "skill"],
  ["playcard", "playcard"],
  ["switchactive", "switch"],
  ["chooseactive", "switch"],
  ["declareend", "end_turn"],
  ["elementaltuning", "elementaltuning"],
  ["切人", "switch"],
  ["换人", "switch"],
  ["切换角色", "switch"],
  ["switch_active", "switch"],
  ["辅助", "support"],
  ["打牌", "playcard"],
  ["playcard", "playcard"],
  ["卡牌", "playcard"],
  ["打出卡牌", "playcard"],
  ["出牌", "playcard"],
  ["治疗", "heal"],
  ["回血", "heal"],
  ["healing", "heal"],
  ["护盾", "shield"],
  ["barrier", "shield"],
  ["召唤", "summon"],
  ["召唤物", "summon"],
  ["结束回合", "end_turn"],
  ["declare_end", "end_turn"],
  ["end", "end_turn"],

  // Element tuning
  ["元素调和", "elementaltuning"],
  ["调和", "elementaltuning"],
]);
