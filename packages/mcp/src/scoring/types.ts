/**
 * Scoring module types — extracted from StandaloneMcpToolHandler.
 *
 * These types define the data contracts for the fragment-decision resolver
 * pipeline: digest → fragment → scoring → decision.
 */

import type {
  CombatWindowPlanNodeV1,
  DecisionShardV1,
} from "@gi-tcg/tactic-mcp";

/** Detailed information about a character for LLM context. */
export type CharacterDefinitionInfo = {
  /** Runtime entity ID (negative number like -500000). */
  id: number;
  /** Definition ID used to look up in game data (positive number). */
  definition_id: number;
  /** Display name of the character (e.g., "雷电将军", "Raiden Shogun"). */
  name: string;
  /** Element type (pyro, hydro, electro, etc.). */
  element: string;
  /** Weapon type (sword, claymore, catalyst, etc.). */
  weapon_type: string;
  /** List of skill descriptions. */
  skills: Array<{
    /** Skill name. */
    name: string;
    /** Skill description. */
    description: string;
    /** Energy cost (0 for passive skills). */
    cost: number;
    /** Damage type: character's element, or "physical" for non-catalyst normal attacks. */
    damage_type: string;
  }>;
};

/** Detailed information about a card for LLM context. */
export type CardDefinitionInfo = {
  /** Definition ID of the card. */
  definition_id: number;
  /** Card name. */
  name: string;
  /** Card type (equipment, event, support). */
  type: string;
  /** Card tags. */
  tags: string[];
  /** Dice cost. */
  cost: number;
  /** Card effect description. */
  effect_text: string;
  /** Whether the card is currently in the player's hand. */
  in_hand?: boolean;
  /** Number of copies of this card in hand (1 or 2 for deck duplicates). */
  count_in_hand?: number;
  /** Effect duration: "immediate" (one-shot event), "this_round" (food buffs),
   *  "permanent" (equipment / most supports).  Derived from card type + tags. */
  duration?: string;
};

export type TurnDigestV1 = {
  version: "TurnDigestV1";
  digest_ref: string;
  session_id: string;
  rpc_seq?: number;
  state_signature?: string;
  round: number;
  turn: number;
  pending_method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard";
  strategic_profile_ref: string;
  /** Optional opening plan injected from runtime-plans/{session_id}.json.
   *  Contains global_goal, turn1_3_priorities, risk_rules, pivot_rules
   *  — set by the LLM via create_opening_plan_v1 or auto-created with defaults. */
  opening_plan?: {
    plan_id: string;
    deck_fingerprint: string;
    source_skills: string[];
    global_goal: string;
    turn1_3_priorities: string[];
    risk_rules: string[];
    pivot_rules: string[];
  } | null;
  self_summary: Record<string, unknown>;
  opponent_summary: Record<string, unknown>;
  resource_summary: Record<string, unknown>;
  candidate_actions: Array<Record<string, unknown>>;
  hard_constraints: string[];
  /** Detailed character definitions for both players (for LLM context). */
  character_definitions: CharacterDefinitionInfo[];
  /** Detailed card definitions for cards in hand (for LLM context). */
  card_definitions: CardDefinitionInfo[];
  active_combat_window?: {
    shard_id: string;
    window_id: string;
    active_node_id: string | null;
    actions_taken: number;
    max_actions: number;
    transition_reason?: string | null;
  } | null;
  generated_at: string;
  /** Simplified kill threat assessment for LLM anchor detection. */
  lethal_info?: {
    my_kill_threats: Array<{
      target: string;
      target_definition_id: number;
      target_hp: number;
      max_possible_damage: number;
      likely_kill: boolean;
      requires_reaction: boolean;
    }>;
    opponent_kill_threats: Array<{
      my_character: string;
      my_character_id: number;
      my_hp: number;
      max_possible_damage: number;
      likely_kill: boolean;
    }>;
  };
};

export type LocalEvalRequestV1 = {
  metric:
    | "opponent_damage_upper_bound"
    | "opponent_damage_bayes"
    | "opponent_buff_probability_upper_bound"
    | "opponent_dice_color_inference"
    | "deck_tracker_remaining_outs"
    | "candidate_damage_exact"
    | "candidate_reaction_exact"
    | "stall_risk_score"
    | "other";
  target?: string;
  estimate_kind: "exact" | "upper_bound" | "bayes_mean" | "heuristic";
  priority: 1 | 2 | 3;
  notes?: string;
};

// ── Rule-chain DSL types (pure Option B) ──────────────────────────────

/** A single condition in a rule's "when" clause. */
export type WhenConditionV1 = {
  /** Field reference from the digest state, e.g. "self.active.hp" */
  field: string;
  /** Comparison operator */
  op: "<=" | ">=" | "==" | "!=" | "<" | ">";
  /** Expected value — number, string, boolean, or "$field_ref" for dynamic lookup */
  value: number | string | boolean;
};

/** Structured action specification for "then" clause. */
export type ActionSpecV1 = {
  /** Action case: useSkill, playCard, switchActive, declareEnd, elementalTuning */
  action_case: "useSkill" | "playCard" | "switchActive" | "declareEnd" | "elementalTuning";
  /** Skill type filter (only for useSkill) */
  skill_type?: "normal_attack" | "elemental_skill" | "burst";
  /** Target character: "opponent.active", "opponent.benched", or a numeric character ID */
  target?: string | number;
  /** Preferred elemental reactions (e.g. ["melt", "vaporize"]) */
  prefer_reaction?: string[];
  /** Minimum damage required */
  damage_min?: number;
  /** Require that the action kills the target */
  kills?: boolean;
  /** For playCard: match card by tag keyword */
  card_tag?: string;
  /** For playCard: match exact definition_id */
  card_def_id?: number;
  /** Match candidate by any tag (e.g. "fast_action", "consumes_turn") */
  require_tag?: string;
};

/** Per-round resource budget. */
export type ResourceBudgetV1 = {
  /** Maximum dice to spend this action */
  max_dice?: number;
  /** Whether elemental tuning is allowed */
  allow_tuning?: boolean;
  /** Preferred tuning target element (e.g. "pyro") */
  tuning_target?: string;
};

/** A single decision rule with priority ordering. */
export type DecisionRuleV1 = {
  /** Lower number = higher priority. Rules evaluated in ascending order. */
  priority: number;
  /** Conditions that must ALL be satisfied for the rule to fire.
   *  Omitted or empty = always matches (useful for fallback rules). */
  when?: WhenConditionV1[];
  /** Action to execute when conditions are met */
  then: ActionSpecV1;
  /** Human-readable reason for this rule (surfaces in ExecutionFeedback) */
  reason: string;
};

export type EvidencePolicyV1 = {
  require_local_eval_first: boolean;
  separate_verified_from_inferred: boolean;
  allow_heuristic_when_unavailable: boolean;
};

export type DecisionFragmentV1 = {
  version: "DecisionFragmentV1";
  fragment_ref: string;
  session_id: string;
  digest_ref: string;
  intent: string;
  must_do: string[];
  avoid: string[];
  preference_order: string[];
  resource_policy: "strict" | "balanced" | "aggressive";
  decision_mode?: "plan_first" | "evidence_first" | "hybrid";
  local_eval_requests?: LocalEvalRequestV1[];
  evidence_policy?: EvidencePolicyV1;
  target_policy: string;
  fallback_rule: string;
  explanation: string;
  /** Optional: directly anchor to a specific candidate_id (e.g. "cand_3").
   *  When set and the candidate passes legality/avoid filters, the resolver
   *  skips all scoring and uses this candidate directly. */
  anchor_candidate_id?: string;
  /** DSL: Rule chain — when present and non-empty, resolver uses rule-chain
   *  evaluation instead of tag-based scoring. */
  rules?: DecisionRuleV1[];
  /** DSL: Per-action resource budget. */
  resource?: ResourceBudgetV1;
  created_at: string;
};

export type ExecutionFeedbackV1 = {
  version: "ExecutionFeedbackV1";
  session_id: string;
  digest_ref: string;
  fragment_ref: string;
  selected_candidate_id: string | null;
  executed_tool: string | null;
  execution_ok: boolean;
  resolver_reason: string;
  score_breakdown: Record<string, number>;
  fallback_used: boolean;
  active_window_id?: string | null;
  active_node_id?: string | null;
  transition_reason?: string | null;
  /** Character HP/energy/aura snapshots AFTER action execution (same format as digest character summaries). */
  self_characters_after?: Array<Record<string, unknown>>;
  opponent_characters_after?: Array<Record<string, unknown>>;
  notes: string[];
  created_at: string;
};

export type FragmentedDecisionState = {
  digest: TurnDigestV1;
  candidateActionMap: Map<string, { tool: string; args: Record<string, unknown> }>;
};

export type ResolverScore = {
  strategyMatch: number;
  localGain: number;
  futurePotential: number;
  riskPenalty: number;
  resourcePenalty: number;
  total: number;
};

export type ResolverScoredCandidate = {
  candidateId: string;
  actionCase: string;
  score: ResolverScore;
  conservativeScore: number;
  endTurnLike: boolean;
};

export type ResolverDecision = {
  selectedCandidateId: string | null;
  executionOrder: string[];
  resolverReason: string;
  scoreBreakdown: Record<string, number>;
  fallbackUsed: boolean;
  effectiveFragment: DecisionFragmentV1;
  activeWindowId: string | null;
  activeNodeId: string | null;
  transitionReason: string | null;
  nextCombatWindowState: ActiveCombatWindowState | null;
  debugNotes: string[];
};

export type ActiveCombatWindowState = {
  shard_id: string;
  window_id: string;
  active_node_id: string | null;
  actions_taken: number;
  interrupted: boolean;
  last_digest_ref: string;
  last_state_signature?: string;
  transition_reason?: string | null;
};

export type ResolverRuntimeContext = {
  openingPlanLock?: OpeningPlanLock | null;
  activeDecisionShard?: DecisionShardV1 | null;
  activeCombatWindowState?: ActiveCombatWindowState | null;
};

export type CombatWindowSelection = {
  node: CombatWindowPlanNodeV1 | null;
  state: ActiveCombatWindowState | null;
  activeWindowId: string | null;
  activeNodeId: string | null;
  transitionReason: string | null;
  debugNotes: string[];
};

/**
 * Opening plan lock — when the LLM submits a structured opening plan,
 * the resolver can lock onto mandatory steps and bypass scoring for them.
 */
export type OpeningPlanLock = {
  steps: Array<{
    /** action_case to match, e.g. "useSkill", "playCard", "switchActive" */
    action_case: string;
    /** Optional target identifier substring (skill_def_id, card_def_id, character name) */
    target_hint?: string;
    /** "mandatory" = bypass scoring; "preferred" = large score bonus */
    priority: "mandatory" | "preferred";
  }>;
  currentStep: number;
};

// ── Mulligan (switchHands) advisor interface ──────────────────────────────────

/** Describes a single hand card with resolved metadata for mulligan decisions. */
export type HandCardInfo = {
  /** Runtime entity ID of the card in hand. */
  id: number;
  /** Definition ID used to look up card metadata in CardIndexStore. */
  definitionId: number;
  /** Resolved card name (from CardIndexStore or fallback). */
  name: string;
  /** Card type label, e.g. "equipment", "event", "support". */
  type: string;
  /** Tags from the card index entry. */
  tags: string[];
  /** Total dice cost from definition_cost array. */
  cost: number;
};

/**
 * A proposed mulligan candidate (set of cards to remove) from a MulliganAdvisor.
 * Each proposal becomes a candidate_action in the digest.
 */
export type MulliganProposal = {
  /** Unique suffix for the candidate_id (e.g. "advisor_aggressive"). */
  keySuffix: string;
  /** IDs of hand cards to remove. Empty = keep all. */
  removeIds: number[];
  /** Short label used as a tag, e.g. "aggressive_mulligan". */
  label: string;
  /** Explanation note appended to candidate notes. */
  reason: string;
  /** Optional score hints — higher values make the resolver prefer this. */
  scoreHints?: {
    tempo_value?: number;
    survival_risk?: number;
  };
};

/**
 * Interface for pluggable mulligan strategy advisors.
 * Future implementations can rank hand cards by deck synergy + opening plan
 * and propose specific removal sets.
 */
// ── Deck Analysis types ──────────────────────────────────────────────

export type DeckAnalysisV1 = {
  version: "DeckAnalysisV1";
  deck_name: string;
  characters: Array<{
    definition_id: number;
    name: string;
    element: string;
    weapon_type: string;
    hp: number;
    skills: Array<{
      name: string;
      description: string;
      cost: number;
      element_cost: number;
      type: string;
    }>;
  }>;
  cards: Array<{
    definition_id: number;
    name: string;
    type: string;
    tags: string[];
    cost: number;
    effect_text: string;
    count: number;
  }>;
  analysis: {
    archetype_hint: string;
    skill_economy: string;
    combo_windows: string[];
    resource_cycling: string;
    support_pressure: string;
    free_cards: Array<{ name: string; definition_id: number }>;
    key_cards: Array<{ name: string; definition_id: number; reason: string }>;
    speed: "fast" | "midrange" | "control" | "unknown";
  };
  entity_descriptions: Array<{
    definition_id: number;
    name: string;
    kind: string;
    description: string;
  }>;
};

export type MatchupAnalysisV1 = {
  version: "MatchupAnalysisV1";
  my_deck: DeckAnalysisV1;
  opponent_deck: DeckAnalysisV1;
  cross_analysis: {
    reaction_matrix: Record<string, string[]>;
    speed_comparison: string;
    key_threats: string[];
    key_advantages: string[];
    suggested_gameplan: string;
  };
};

export interface MulliganAdvisor {
  /**
   * Given the full hand and game context, return zero or more proposals.
   * Each proposal will be added as a separate candidate_action for the resolver.
   */
  propose(
    hand: HandCardInfo[],
    context: {
      /** The opening plan JSON (if available). */
      openingPlan: Record<string, unknown> | null;
      /** Round number (expected 0 for mulligan). */
      round: number;
      /** Self character summaries. */
      characters: Array<{ id: number; hp: number; max_hp: number; energy: number; max_energy: number; alive: boolean }>;
    },
  ): MulliganProposal[];
}
