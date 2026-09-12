/**
 * FragmentResolver — core scoring engine for the fragment-decision pipeline.
 *
 * Extracted from StandaloneMcpToolHandler.resolveFragmentCandidate() to enable
 * independent testing and iterative scoring improvements.
 */

import type {
  ActiveCombatWindowState,
  ActionSpecV1,
  CombatWindowSelection,
  DecisionFragmentV1,
  DecisionRuleV1,
  FragmentedDecisionState,
  OpeningPlanLock,
  ResolverDecision,
  ResolverRuntimeContext,
  ResolverScoredCandidate,
  ResourceBudgetV1,
  WhenConditionV1,
} from "./types";
import type {
  CombatWindowPlanNodeV1,
  CombatWindowPlanV1,
} from "@gi-tcg/tactic-mcp";
import {
  safeNumber,
  normalizeLabel,
  containsLabel,
  totalCostFromCandidate,
} from "./scoring-utils";
import { RiskEvaluator, type RiskContext } from "./RiskEvaluator";
import { ResourceWeightCalculator, type ResourceContext } from "./ResourceWeightCalculator";
import { FuturePotentialEvaluator, type FuturePotentialContext } from "./FuturePotentialEvaluator";
import { StrategyMatcher } from "./StrategyMatcher";

/** Normalize unknown value to string[], filtering out non-string / empty entries. */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

export class FragmentResolver {
  private riskEvaluator = new RiskEvaluator();
  private resourceCalculator = new ResourceWeightCalculator();
  private futurePotentialEvaluator = new FuturePotentialEvaluator();
  private strategyMatcher = new StrategyMatcher();

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
  }

  private buildDigestSearchableText(
    digestState: FragmentedDecisionState,
    combatWindowState?: ActiveCombatWindowState | null,
  ): string {
    const digest = digestState.digest;
    const selfSummary = (digest.self_summary as Record<string, unknown>) ?? {};
    const opponentSummary = (digest.opponent_summary as Record<string, unknown>) ?? {};
    const resourceSummary = (digest.resource_summary as Record<string, unknown>) ?? {};
    const selfCharacters = Array.isArray(selfSummary.characters)
      ? (selfSummary.characters as Array<Record<string, unknown>>)
      : [];
    const opponentCharacters = Array.isArray(opponentSummary.characters)
      ? (opponentSummary.characters as Array<Record<string, unknown>>)
      : [];
    const activeSelfId = Number(selfSummary.active_character_id ?? -1);
    const activeOpponentId = Number(opponentSummary.active_character_id ?? -1);
    const activeSelf = selfCharacters.find((character) => Number(character.character_id ?? character.id ?? -1) === activeSelfId);
    const activeOpponent = opponentCharacters.find((character) =>
      Number(character.character_id ?? character.id ?? -1) === activeOpponentId
    );

    const tokens: string[] = [
      `pending_method=${digest.pending_method}`,
      `round=${digest.round}`,
      `turn=${digest.turn}`,
      `resource.dice_count=${safeNumber(resourceSummary.dice_count)}`,
      `resource.omni_count=${safeNumber(resourceSummary.omni_count)}`,
      `resource.cards_in_hand=${safeNumber(resourceSummary.cards_in_hand)}`,
      `candidate_count=${digest.candidate_actions.length}`,
      `self.active=${activeSelfId}`,
      `self.active_hp=${safeNumber(activeSelf?.hp)}`,
      `self.active_energy=${safeNumber(activeSelf?.energy)}`,
      `opponent.active=${activeOpponentId}`,
      `opponent.active_hp=${safeNumber(activeOpponent?.hp)}`,
      `actions_taken=${combatWindowState?.actions_taken ?? 0}`,
      `active_node=${combatWindowState?.active_node_id ?? "none"}`,
      digest.state_signature ?? "",
    ];

    for (const character of selfCharacters) {
      const characterId = Number(character.character_id ?? character.id ?? -1);
      tokens.push(
        `self.char.${characterId}.hp=${safeNumber(character.hp)}`,
        `self.char.${characterId}.energy=${safeNumber(character.energy)}`,
        `self.char.${characterId}.alive=${String(character.alive !== false && safeNumber(character.hp) > 0)}`,
      );
    }

    for (const character of opponentCharacters) {
      const characterId = Number(character.character_id ?? character.id ?? -1);
      tokens.push(
        `opponent.char.${characterId}.hp=${safeNumber(character.hp)}`,
        `opponent.char.${characterId}.energy=${safeNumber(character.energy)}`,
        `opponent.char.${characterId}.alive=${String(character.alive !== false && safeNumber(character.hp) > 0)}`,
      );
    }

    for (const candidate of digest.candidate_actions) {
      const actionCase = String(candidate.action_case ?? "unknown");
      tokens.push(actionCase);
      if (Array.isArray(candidate.tags)) {
        tokens.push(
          ...(candidate.tags as unknown[]).filter((tag): tag is string => typeof tag === "string"),
        );
      }
      if (Array.isArray(candidate.notes)) {
        tokens.push(
          ...(candidate.notes as unknown[]).filter((note): note is string => typeof note === "string"),
        );
      }
    }

    return tokens.join(" ");
  }

  private resolveConditionField(
    field: string,
    digestState: FragmentedDecisionState,
    combatWindowState: ActiveCombatWindowState | null,
    maxActions: number,
  ): string | number | boolean | null {
    const digest = digestState.digest;
    const selfSummary = (digest.self_summary as Record<string, unknown>) ?? {};
    const opponentSummary = (digest.opponent_summary as Record<string, unknown>) ?? {};
    const resourceSummary = (digest.resource_summary as Record<string, unknown>) ?? {};
    const selfCharacters = Array.isArray(selfSummary.characters)
      ? (selfSummary.characters as Array<Record<string, unknown>>)
      : [];
    const opponentCharacters = Array.isArray(opponentSummary.characters)
      ? (opponentSummary.characters as Array<Record<string, unknown>>)
      : [];
    const activeSelfId = Number(selfSummary.active_character_id ?? -1);
    const activeOpponentId = Number(opponentSummary.active_character_id ?? -1);
    const activeSelf = selfCharacters.find((character) => Number(character.character_id ?? character.id ?? -1) === activeSelfId);
    const activeOpponent = opponentCharacters.find((character) =>
      Number(character.character_id ?? character.id ?? -1) === activeOpponentId
    );

    switch (field) {
      case "pending_method":
        return digest.pending_method;
      case "round":
        return digest.round;
      case "turn":
        return digest.turn;
      case "actions_taken":
        return combatWindowState?.actions_taken ?? 0;
      case "max_actions":
        return maxActions;
      case "candidate_count":
        return digest.candidate_actions.length;
      case "state_signature":
        return digest.state_signature ?? "";
      case "self.active":
        return activeSelfId;
      case "self.active_hp":
        return safeNumber(activeSelf?.hp);
      case "self.active_energy":
        return safeNumber(activeSelf?.energy);
      case "self.alive_count":
        return selfCharacters.filter((character) => character.alive !== false && safeNumber(character.hp) > 0).length;
      case "opponent.active":
        return activeOpponentId;
      case "opponent.active_hp":
        return safeNumber(activeOpponent?.hp);
      case "opponent.alive_count":
        return opponentCharacters.filter((character) => character.alive !== false && safeNumber(character.hp) > 0).length;
      case "resource.dice_count":
        return safeNumber(resourceSummary.dice_count);
      case "resource.omni_count":
        return safeNumber(resourceSummary.omni_count);
      case "resource.cards_in_hand":
        return safeNumber(resourceSummary.cards_in_hand);
      default:
        return null;
    }
  }

  private compareAtomicCondition(
    field: string,
    operator: string,
    rawExpected: string,
    digestState: FragmentedDecisionState,
    combatWindowState: ActiveCombatWindowState | null,
    maxActions: number,
  ): boolean {
    const actualValue = this.resolveConditionField(field, digestState, combatWindowState, maxActions);
    if (actualValue === null) {
      return false;
    }
    const expectedText = rawExpected.replace(/^['"]|['"]$/g, "");
    const expectedNumber = Number(expectedText);
    const expectedBoolean =
      expectedText === "true"
        ? true
        : expectedText === "false"
          ? false
          : null;

    if (typeof actualValue === "number" && Number.isFinite(expectedNumber)) {
      switch (operator) {
        case "=":
        case "==":
          return actualValue === expectedNumber;
        case "!=":
          return actualValue !== expectedNumber;
        case ">":
          return actualValue > expectedNumber;
        case ">=":
          return actualValue >= expectedNumber;
        case "<":
          return actualValue < expectedNumber;
        case "<=":
          return actualValue <= expectedNumber;
        default:
          return false;
      }
    }

    if (typeof actualValue === "boolean" && expectedBoolean !== null) {
      return operator === "!="
        ? actualValue !== expectedBoolean
        : actualValue === expectedBoolean;
    }

    const actualText = String(actualValue).toLowerCase();
    const normalizedExpected = expectedText.toLowerCase();
    return operator === "!="
      ? actualText !== normalizedExpected
      : actualText === normalizedExpected;
  }

  private evaluateCondition(
    condition: string,
    digestState: FragmentedDecisionState,
    digestSearchable: string,
    combatWindowState: ActiveCombatWindowState | null,
    maxActions: number,
  ): boolean {
    const trimmed = condition.trim();
    if (trimmed.length === 0) {
      return true;
    }
    if (trimmed.includes(" or ")) {
      return trimmed.split(/\s+or\s+/i).some((part) =>
        this.evaluateCondition(part, digestState, digestSearchable, combatWindowState, maxActions)
      );
    }
    if (trimmed.includes(" and ")) {
      return trimmed.split(/\s+and\s+/i).every((part) =>
        this.evaluateCondition(part, digestState, digestSearchable, combatWindowState, maxActions)
      );
    }
    if (trimmed === "max_actions_reached") {
      return (combatWindowState?.actions_taken ?? 0) >= maxActions;
    }
    const comparison = trimmed.match(/^([a-zA-Z0-9_.]+)\s*(<=|>=|!=|=|==|<|>)\s*(.+)$/);
    if (comparison) {
      return this.compareAtomicCondition(
        comparison[1],
        comparison[2],
        comparison[3],
        digestState,
        combatWindowState,
        maxActions,
      );
    }
    return this.strategyMatcher.matchTerm(trimmed, digestSearchable).matched;
  }

  private selectCombatWindowNode(
    digestState: FragmentedDecisionState,
    combatWindowPlan: CombatWindowPlanV1,
    shardId: string,
    combatWindowState?: ActiveCombatWindowState | null,
  ): CombatWindowSelection {
    const debugNotes: string[] = [];
    const maxActions = combatWindowPlan.plan_horizon.max_actions;
    const digestSearchable = this.buildDigestSearchableText(digestState, combatWindowState ?? null);
    const nodeMap = new Map(combatWindowPlan.nodes.map((node) => [node.id, node]));
    const matchesAll = (conditions: string[], state: ActiveCombatWindowState | null) =>
      conditions.every((condition) => this.evaluateCondition(condition, digestState, digestSearchable, state, maxActions));
    const matchesAny = (conditions: string[], state: ActiveCombatWindowState | null) =>
      conditions.some((condition) => this.evaluateCondition(condition, digestState, digestSearchable, state, maxActions));

    let state = combatWindowState && combatWindowState.window_id === combatWindowPlan.window_id
      ? { ...combatWindowState }
      : null;

    if (state && state.actions_taken >= maxActions) {
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=max_actions_reached`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason: "max_actions_reached",
        debugNotes,
      };
    }

    if (state && matchesAny(combatWindowPlan.interrupt_conditions, state)) {
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=interrupt_condition`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason: "interrupt_condition",
        debugNotes,
      };
    }

    if (
      state &&
      state.actions_taken >= combatWindowPlan.plan_horizon.min_actions &&
      (matchesAny(combatWindowPlan.success_conditions, state) || matchesAny(combatWindowPlan.fail_conditions, state))
    ) {
      const transitionReason = matchesAny(combatWindowPlan.success_conditions, state)
        ? "success_condition"
        : "fail_condition";
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=${transitionReason}`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason,
        debugNotes,
      };
    }

    if (!state) {
      if (!matchesAll(combatWindowPlan.entry_conditions, null)) {
        return {
          node: null,
          state: null,
          activeWindowId: null,
          activeNodeId: null,
          transitionReason: null,
          debugNotes,
        };
      }
      state = {
        shard_id: shardId,
        window_id: combatWindowPlan.window_id,
        active_node_id: combatWindowPlan.entry_node_id,
        actions_taken: 0,
        interrupted: false,
        last_digest_ref: digestState.digest.digest_ref,
        last_state_signature: digestState.digest.state_signature,
        transition_reason: "entry",
      };
      debugNotes.push(`[combat_window] activate window=${combatWindowPlan.window_id} node=${combatWindowPlan.entry_node_id}`);
    }

    let node = state.active_node_id ? (nodeMap.get(state.active_node_id) ?? null) : null;
    if (!node) {
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=missing_node`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason: "missing_node",
        debugNotes,
      };
    }

    const transition = [...node.next]
      .sort((left, right) => right.priority - left.priority)
      .find((candidate) => this.evaluateCondition(candidate.condition, digestState, digestSearchable, state, maxActions));
    if (transition) {
      state.active_node_id = transition.to;
      state.transition_reason = transition.condition;
      node = nodeMap.get(transition.to) ?? null;
      debugNotes.push(
        `[combat_window] transition window=${combatWindowPlan.window_id} to=${transition.to} reason=${transition.condition}`,
      );
    }

    if (!node) {
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=transition_target_missing`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason: transition?.condition ?? "transition_target_missing",
        debugNotes,
      };
    }

    if (!matchesAll(node.when, state)) {
      debugNotes.push(`[combat_window] deactivate window=${combatWindowPlan.window_id} reason=node_when_mismatch node=${node.id}`);
      return {
        node: null,
        state: null,
        activeWindowId: combatWindowPlan.window_id,
        activeNodeId: null,
        transitionReason: "node_when_mismatch",
        debugNotes,
      };
    }

    state.last_digest_ref = digestState.digest.digest_ref;
    state.last_state_signature = digestState.digest.state_signature;

    return {
      node,
      state,
      activeWindowId: combatWindowPlan.window_id,
      activeNodeId: node.id,
      transitionReason: state.transition_reason ?? null,
      debugNotes,
    };
  }

  private applyCombatWindowNode(
    fragment: DecisionFragmentV1,
    node: CombatWindowPlanNodeV1,
  ): DecisionFragmentV1 {
    const preferenceOrder = this.uniqueStrings([
      ...(node.expected_action_case ?? []),
      ...node.prefer_tags,
      ...fragment.preference_order,
    ]);
    return {
      ...fragment,
      intent:
        fragment.intent.trim().length === 0 || fragment.intent === "stabilize_tempo"
          ? node.intent
          : fragment.intent,
      must_do: this.uniqueStrings([...node.must_do, ...fragment.must_do]),
      avoid: this.uniqueStrings([...node.avoid, ...fragment.avoid]),
      preference_order: preferenceOrder,
      resource_policy:
        fragment.resource_policy === "balanced" && node.resource_policy
          ? node.resource_policy
          : fragment.resource_policy,
      fallback_rule:
        fragment.fallback_rule === "pick_highest_valid_candidate" && node.fallback_rule
          ? node.fallback_rule
          : fragment.fallback_rule,
      explanation: `[combat_window:${node.id}] ${fragment.explanation}`.trim(),
    };
  }

  // ── Rule-chain DSL resolution ──────────────────────────────────────

  /** Supported field references for when conditions. */
  private static readonly DSL_FIELDS: Record<string, (digest: Record<string, unknown>, selfChars: any[], oppChars: any[], activeSelfId: number, activeOppId: number) => unknown> = {
    "self.active.hp": (_, sc, __, id) => { const c = sc.find((ch: any) => Number(ch.character_id ?? ch.id) === id); return safeNumber(c?.hp); },
    "self.active.energy": (_, sc, __, id) => { const c = sc.find((ch: any) => Number(ch.character_id ?? ch.id) === id); return safeNumber(c?.energy); },
    "self.active.max_energy": (_, sc, __, id) => { const c = sc.find((ch: any) => Number(ch.character_id ?? ch.id) === id); return safeNumber(c?.max_energy); },
    "opponent.active.hp": (_, __, oc, _a, oid) => { const c = oc.find((ch: any) => Number(ch.character_id ?? ch.id) === oid); return safeNumber(c?.hp); },
    "opponent.active.aura": (_, __, oc, _a, oid) => { const c = oc.find((ch: any) => Number(ch.character_id ?? ch.id) === oid); return String(c?.aura ?? "none"); },
    "opponent.active.alive": (_, __, oc, _a, oid) => { const c = oc.find((ch: any) => Number(ch.character_id ?? ch.id) === oid); return c?.alive !== false && safeNumber(c?.hp) > 0; },
    "resource.dice_count": (d, _, __) => safeNumber((d.resource_summary as any)?.dice_count),
    "resource.omni_count": (d, _, __) => safeNumber((d.resource_summary as any)?.omni_count),
    "resource.cards_in_hand": (d, _, __) => safeNumber((d.resource_summary as any)?.cards_in_hand),
    "digest.round": (d) => d.round as number,
    "digest.turn": (d) => d.turn as number,
    "digest.lethal.my_kill": (d) => Array.isArray((d.lethal_info as any)?.my_kill_threats) && (d.lethal_info as any).my_kill_threats.some((t: any) => t.likely_kill),
    "digest.lethal.opponent_kill": (d) => Array.isArray((d.lethal_info as any)?.opponent_kill_threats) && (d.lethal_info as any).opponent_kill_threats.some((t: any) => t.likely_kill),
  };

  /** Resolve a $field_ref (dynamic value reference in when conditions). */
  private resolveDslFieldRef(ref: string, digest: Record<string, unknown>, selfChars: any[], oppChars: any[], activeSelfId: number, activeOppId: number): unknown {
    if (typeof ref !== "string") return ref;
    if (ref.startsWith("$")) {
      // Strip the $ prefix and look up
      const field = ref.slice(1);
      const resolver = FragmentResolver.DSL_FIELDS[field];
      if (resolver) return resolver(digest, selfChars, oppChars, activeSelfId, activeOppId);
    }
    return ref;
  }

  /** Evaluate a single when condition. */
  private evaluateWhenCondition(
    condition: WhenConditionV1,
    digest: Record<string, unknown>,
    selfChars: any[],
    oppChars: any[],
    activeSelfId: number,
    activeOppId: number,
  ): boolean {
    const resolver = FragmentResolver.DSL_FIELDS[condition.field];
    if (!resolver) return false;
    const actual = resolver(digest, selfChars, oppChars, activeSelfId, activeOppId);
    if (actual === null || actual === undefined) return false;

    const expected = this.resolveDslFieldRef(String(condition.value), digest, selfChars, oppChars, activeSelfId, activeOppId);

    // Type coercion for comparison
    if (typeof actual === "number" && typeof expected === "number") {
      switch (condition.op) {
        case "==": return actual === expected;
        case "!=": return actual !== expected;
        case "<": return actual < expected;
        case "<=": return actual <= expected;
        case ">": return actual > expected;
        case ">=": return actual >= expected;
      }
    }
    if (typeof actual === "boolean" && typeof expected === "boolean") {
      return condition.op === "!=" ? actual !== expected : actual === expected;
    }
    // String comparison
    const a = String(actual).toLowerCase();
    const e = String(expected).toLowerCase();
    switch (condition.op) {
      case "==": return a === e;
      case "!=": return a !== e;
      default: return false;
    }
  }

  /** Check if all when conditions for a rule are satisfied. */
  private ruleConditionsMatch(
    rule: DecisionRuleV1,
    digest: Record<string, unknown>,
    selfChars: any[],
    oppChars: any[],
    activeSelfId: number,
    activeOppId: number,
  ): boolean {
    if (!rule.when || rule.when.length === 0) return true; // no conditions = always match
    return rule.when.every((c) =>
      this.evaluateWhenCondition(c, digest, selfChars, oppChars, activeSelfId, activeOppId),
    );
  }

  /** Check if a candidate matches an action spec. */
  private candidateMatchesSpec(
    candidate: Record<string, unknown>,
    spec: ActionSpecV1,
  ): boolean {
    const actionCase = String(candidate.action_case ?? "");
    if (actionCase !== spec.action_case) return false;

    const tags = Array.isArray(candidate.tags) ? (candidate.tags as string[]) : [];
    const notes = Array.isArray(candidate.notes) ? (candidate.notes as string[]) : [];
    const searchable = [actionCase, ...tags, ...notes].join(" ").toLowerCase();

    // Skill type filter
    if (spec.skill_type) {
      if (!tags.map((t) => t.toLowerCase()).includes(spec.skill_type.toLowerCase())) return false;
    }

    // Damage minimum
    if (typeof spec.damage_min === "number") {
      const totalDmg = safeNumber(candidate.total_damage);
      if (totalDmg < spec.damage_min) return false;
    }

    // Kills required
    if (spec.kills === true && candidate.kills !== true) return false;

    // Preferred reaction
    if (spec.prefer_reaction && spec.prefer_reaction.length > 0) {
      const reactionType = String(candidate.reaction_type ?? "").toLowerCase();
      const hasMatch = spec.prefer_reaction.some((r) => reactionType.includes(r.toLowerCase()));
      if (!hasMatch) {
        // Allow matching if no reaction data at all (candidate might still work)
        if (reactionType.length > 0) return false;
      }
    }

    // Card tag filter (for playCard)
    if (spec.card_tag && actionCase === "playCard") {
      if (!tags.map((t) => t.toLowerCase()).includes(spec.card_tag!.toLowerCase()) &&
          !notes.some((n) => n.toLowerCase().includes(spec.card_tag!.toLowerCase()))) {
        return false;
      }
    }

    // Card definition_id filter
    if (typeof spec.card_def_id === "number" && actionCase === "playCard") {
      const defIdMatch = notes.some((n) =>
        n.includes(`definition_id=${spec.card_def_id}`) || n.includes(`card_def_id=${spec.card_def_id}`)
      );
      if (!defIdMatch) return false;
    }

    // Generic tag filter (e.g. "fast_action", "consumes_turn")
    if (spec.require_tag && !tags.map((t) => t.toLowerCase()).includes(spec.require_tag.toLowerCase())) {
      return false;
    }

    return true;
  }

  /** Evaluate rules against digest candidates. Returns selected candidate ID or null. */
  private resolveRules(
    digestState: FragmentedDecisionState,
    rules: DecisionRuleV1[],
    resource?: ResourceBudgetV1,
  ): { selectedCandidateId: string | null; reason: string; debugNotes: string[] } {
    const digest = digestState.digest;
    const selfSummary = (digest.self_summary ?? {}) as Record<string, unknown>;
    const opponentSummary = (digest.opponent_summary ?? {}) as Record<string, unknown>;
    const selfChars = Array.isArray(selfSummary.characters) ? selfSummary.characters as any[] : [];
    const oppChars = Array.isArray(opponentSummary.characters) ? opponentSummary.characters as any[] : [];
    const activeSelfId = Number(selfSummary.active_character_id ?? -1);
    const activeOppId = Number(opponentSummary.active_character_id ?? -1);
    const debugNotes: string[] = [];

    // Sort rules by priority ascending
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sorted) {
      debugNotes.push(`[dsl] evaluating rule priority=${rule.priority}: ${rule.reason}`);

      // Check when conditions
      if (!this.ruleConditionsMatch(rule, digest as Record<string, unknown>, selfChars, oppChars, activeSelfId, activeOppId)) {
        debugNotes.push(`[dsl] rule priority=${rule.priority} conditions NOT met, skipping`);
        continue;
      }
      debugNotes.push(`[dsl] rule priority=${rule.priority} conditions MET`);

      // Match then against candidates — prefer earlier candidates in the digest
      for (const candidate of digest.candidate_actions) {
        if (this.candidateMatchesSpec(candidate, rule.then)) {
          const candidateId = String(candidate.candidate_id ?? "");
          if (candidateId.length === 0) continue;
          // Verify candidate is in the action map (legality check)
          if (!digestState.candidateActionMap.has(candidateId)) {
            debugNotes.push(`[dsl] candidate ${candidateId} matched but not in action map, skipping`);
            continue;
          }
          // Check tags for invalid marker
          const tags = Array.isArray(candidate.tags) ? (candidate.tags as string[]) : [];
          if (tags.some((t) => normalizeLabel(t) === "invalid")) {
            debugNotes.push(`[dsl] candidate ${candidateId} has invalid tag, skipping`);
            continue;
          }
          debugNotes.push(`[dsl] rule priority=${rule.priority} matched candidate ${candidateId}`);
          return {
            selectedCandidateId: candidateId,
            reason: `Rule priority=${rule.priority}: ${rule.reason}`,
            debugNotes,
          };
        }
      }
      debugNotes.push(`[dsl] rule priority=${rule.priority} conditions met but no candidate matched action spec`);
    }

    // No rules matched — return null for fallback handling
    debugNotes.push(`[dsl] no rules matched any candidate`);
    return { selectedCandidateId: null, reason: "No rules matched", debugNotes };
  }

  /**
   * Score all legal candidates against a decision fragment and return a
   * resolver decision (selected candidate, execution order, scores, debug notes).
   *
   * This is a pure function of (digestState, fragment) — no side-effects.
   */
  resolve(
    digestState: FragmentedDecisionState,
    fragment: DecisionFragmentV1,
    runtimeContext: ResolverRuntimeContext = {},
  ): ResolverDecision {
    const digest = digestState.digest;

    // ── DSL Rule-Chain Path (priority over tag-based scoring) ──
    if (fragment.rules && fragment.rules.length > 0) {
      const result = this.resolveRules(digestState, fragment.rules, fragment.resource);
      const executionOrder = result.selectedCandidateId
        ? [result.selectedCandidateId]
        : [];
      // Collect all other valid candidate IDs as fallback
      for (const candidate of digest.candidate_actions) {
        const cid = String(candidate.candidate_id ?? "");
        if (cid.length > 0 && cid !== result.selectedCandidateId && digestState.candidateActionMap.has(cid)) {
          executionOrder.push(cid);
        }
      }
      return {
        selectedCandidateId: result.selectedCandidateId,
        executionOrder,
        resolverReason: result.reason,
        scoreBreakdown: {},
        fallbackUsed: result.selectedCandidateId === null,
        effectiveFragment: fragment,
        activeWindowId: null,
        activeNodeId: null,
        transitionReason: null,
        nextCombatWindowState: null,
        debugNotes: result.debugNotes,
      };
    }

    const combatWindowPlan = runtimeContext.activeDecisionShard?.combat_window_plan ?? null;
    const combatWindowSelection = combatWindowPlan
      ? this.selectCombatWindowNode(
        digestState,
        combatWindowPlan,
        runtimeContext.activeDecisionShard?.shard_id ?? "shard_unknown",
        runtimeContext.activeCombatWindowState ?? null,
      )
      : ({
        node: null,
        state: runtimeContext.activeCombatWindowState ?? null,
        activeWindowId: null,
        activeNodeId: null,
        transitionReason: null,
        debugNotes: [],
      } as CombatWindowSelection);
    const effectiveFragment = combatWindowSelection.node
      ? this.applyCombatWindowNode(fragment, combatWindowSelection.node)
      : fragment;

    // Build risk context from digest summaries
    const riskCtx: RiskContext = {
      selfSummary: {
        active_character_id: (digest.self_summary as any)?.active_character_id ?? null,
        characters: Array.isArray((digest.self_summary as any)?.characters)
          ? (digest.self_summary as any).characters
          : [],
      },
      opponentSummary: {
        active_character_id: (digest.opponent_summary as any)?.active_character_id ?? null,
        characters: Array.isArray((digest.opponent_summary as any)?.characters)
          ? (digest.opponent_summary as any).characters
          : [],
      },
      resourceSummary: {
        dice_count: safeNumber((digest.resource_summary as any)?.dice_count),
        omni_count: safeNumber((digest.resource_summary as any)?.omni_count),
      },
      round: digest.round,
    };

    // Build resource context from digest summaries
    const resourceCtx: ResourceContext = {
      diceCount: safeNumber((digest.resource_summary as any)?.dice_count),
      omniCount: safeNumber((digest.resource_summary as any)?.omni_count),
      cardsInHand: safeNumber((digest.resource_summary as any)?.cards_in_hand),
      round: digest.round,
      resourcePolicy: "balanced", // will be overridden per-candidate with fragment policy
    };

    const profileKeywords = [
      ...normalizeStringArray(
        (digest as unknown as Record<string, unknown>).hard_constraints,
      ),
      ...normalizeStringArray(
        (digest as unknown as Record<string, unknown>).strategic_profile_ref,
      ),
    ];

    // ── Hard filter helper: build searchable text for a candidate ──
    const buildSearchable = (candidate: Record<string, unknown>): string => {
      const actionCase = String(candidate.action_case ?? "unknown");
      const tags = Array.isArray(candidate.tags)
        ? (candidate.tags as unknown[]).filter(
            (tag): tag is string => typeof tag === "string",
          )
        : [];
      const notes = Array.isArray(candidate.notes)
        ? (candidate.notes as unknown[]).filter(
            (note): note is string => typeof note === "string",
          )
        : [];
      return [actionCase, ...tags, ...notes].join(" ");
    };

    // ── Anchor candidate: LLM directly specifies a candidate_id ──
    // When set, skip ALL scoring and use the anchored candidate directly,
    // provided it exists and passes the avoid filter.
    if (effectiveFragment.anchor_candidate_id) {
      const anchorId = effectiveFragment.anchor_candidate_id.trim();
      if (digestState.candidateActionMap.has(anchorId)) {
        const anchorCandidate = digest.candidate_actions.find(
          (c) => String(c.candidate_id ?? "").trim() === anchorId
        );
        if (anchorCandidate) {
          const anchorTags = Array.isArray(anchorCandidate.tags)
            ? (anchorCandidate.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [];
          const hasInvalidTag = anchorTags.some((tag) => normalizeLabel(tag) === "invalid");
          if (!hasInvalidTag) {
            // Check avoid filter
            const searchable = buildSearchable(anchorCandidate);
            const blocked = effectiveFragment.avoid.length > 0 && effectiveFragment.avoid.some(
              (avoidTerm) => this.strategyMatcher.matchTerm(avoidTerm, searchable).matched,
            );
            if (!blocked) {
              const reason = `Anchor candidate: LLM specified ${anchorId} directly, bypassing scoring.`;
              debugNotes.push(`[resolver] ${reason}`);
              return {
                selectedCandidateId: anchorId,
                executionOrder: [anchorId],
                resolverReason: reason,
                scoreBreakdown: { [anchorId]: 999, [`${anchorId}.anchor`]: 1 },
                fallbackUsed: false,
                effectiveFragment,
                activeWindowId: combatWindowSelection.activeWindowId,
                activeNodeId: combatWindowSelection.activeNodeId,
                transitionReason: combatWindowSelection.transitionReason,
                nextCombatWindowState: combatWindowSelection.state,
                debugNotes: [...combatWindowSelection.debugNotes, `[resolver] ${reason}`],
              };
            }
            debugNotes.push(`[resolver] anchor ${anchorId} blocked by avoid filter, falling through to scoring`);
          } else {
            debugNotes.push(`[resolver] anchor ${anchorId} has invalid tag, falling through to scoring`);
          }
        } else {
          debugNotes.push(`[resolver] anchor ${anchorId} not found in digest candidates, falling through to scoring`);
        }
      } else {
        debugNotes.push(`[resolver] anchor ${anchorId} not in candidateActionMap, falling through to scoring`);
      }
    }

    // ── Opening Plan Lock: bypass scoring if a mandatory step matches ──
    const openingPlanLock = runtimeContext.openingPlanLock ?? null;
    if (openingPlanLock && openingPlanLock.currentStep < openingPlanLock.steps.length) {
      const step = openingPlanLock.steps[openingPlanLock.currentStep];
      const planCandidate = digest.candidate_actions.find((candidate) => {
        const candidateId = String(candidate.candidate_id ?? "").trim();
        if (!digestState.candidateActionMap.has(candidateId)) return false;
        const actionCase = String(candidate.action_case ?? "");
        if (actionCase !== step.action_case) return false;
        if (step.target_hint) {
          const searchable = buildSearchable(candidate);
          return searchable.toLowerCase().includes(step.target_hint.toLowerCase());
        }
        return true;
      });

      if (planCandidate && step.priority === "mandatory") {
        const candidateId = String(planCandidate.candidate_id ?? "");
        const reason = `Opening plan lock: mandatory step ${openingPlanLock.currentStep} → ${step.action_case}${step.target_hint ? ` (${step.target_hint})` : ""}`;
        return {
          selectedCandidateId: candidateId,
          executionOrder: [candidateId],
          resolverReason: reason,
          scoreBreakdown: { [candidateId]: 999, [`${candidateId}.plan_lock`]: 1 },
          fallbackUsed: false,
          effectiveFragment,
          activeWindowId: combatWindowSelection.activeWindowId,
          activeNodeId: combatWindowSelection.activeNodeId,
          transitionReason: combatWindowSelection.transitionReason,
          nextCombatWindowState: combatWindowSelection.state,
          debugNotes: [...combatWindowSelection.debugNotes, `[resolver] ${reason}`],
        };
      }
    }

    // ── Phase 1: Legality filter ────────────────────────────────
    const validCandidates = digest.candidate_actions.filter((candidate) => {
      const candidateId = String(candidate.candidate_id ?? "").trim();
      if (
        candidateId.length === 0 ||
        !digestState.candidateActionMap.has(candidateId)
      ) {
        return false;
      }
      const tags = Array.isArray(candidate.tags)
        ? (candidate.tags as unknown[]).filter(
            (tag): tag is string => typeof tag === "string",
          )
        : [];
      const hasInvalidTag = tags.some(
        (tag) => normalizeLabel(tag) === "invalid",
      );
      const hasValidTag = tags.some(
        (tag) => normalizeLabel(tag) === "valid",
      );
      if (hasInvalidTag) {
        return false;
      }
      return hasValidTag || tags.length === 0;
    });

    // ── Phase 2: Hard avoid filter ──────────────────────────────
    // Candidates matching any avoid term are removed unless it would
    // eliminate all candidates (safety fallback keeps the full set).
    let afterAvoid = validCandidates;
    if (effectiveFragment.avoid.length > 0) {
      const surviving = validCandidates.filter((candidate) => {
        const searchable = buildSearchable(candidate);
        return !effectiveFragment.avoid.some(
          (avoidTerm) => this.strategyMatcher.matchTerm(avoidTerm, searchable).matched,
        );
      });
      if (surviving.length > 0) {
        afterAvoid = surviving;
      }
    }

    // ── Phase 3: Hard must-do preference ────────────────────────
    // If any candidates match a must_do term, restrict to those.
    // Falls back to afterAvoid set if no candidate matches any must_do.
    let filteredCandidates = afterAvoid;
    if (effectiveFragment.must_do.length > 0) {
      const mustDoMatches = afterAvoid.filter((candidate) => {
        const searchable = buildSearchable(candidate);
        return effectiveFragment.must_do.some(
          (mustDoTerm) => this.strategyMatcher.matchTerm(mustDoTerm, searchable).matched,
        );
      });
      if (mustDoMatches.length > 0) {
        filteredCandidates = mustDoMatches;
      }
    }

    const legalCandidates = filteredCandidates
      .map((candidate): ResolverScoredCandidate => {
        const candidateId = String(candidate.candidate_id ?? "");
        const actionCase = String(candidate.action_case ?? "unknown");
        const tags = Array.isArray(candidate.tags)
          ? (candidate.tags as unknown[]).filter(
              (tag): tag is string => typeof tag === "string",
            )
          : [];
        const notes = Array.isArray(candidate.notes)
          ? (candidate.notes as unknown[]).filter(
              (note): note is string => typeof note === "string",
            )
          : [];
        const searchable = [actionCase, ...tags, ...notes].join(" ");
        const totalCost = totalCostFromCandidate(candidate);

        // ── Strategy Match (structured label matching) ──────────
        const strategyBreakdown = this.strategyMatcher.computeStrategyMatch(
          searchable,
          effectiveFragment,
          profileKeywords,
        );
        const strategyMatch = strategyBreakdown.total;

        // ── Local Gain ──────────────────────────────────────────
        const damageEstimate = safeNumber(candidate.damage_estimate);
        const reactionValue = safeNumber(candidate.reaction_value);
        const tempoValue = safeNumber(candidate.tempo_value);
        const energyGain = containsLabel(searchable, ["energy", "charge"])
          ? 1
          : 0;
        const switchGain = containsLabel(searchable, [
          "switch",
          "chooseactive",
        ])
          ? 1
          : 0;
        const actionBias = (() => {
          if (actionCase === "useSkill") {
            // Differentiate by skill type tag (normal_attack vs elemental_skill vs burst)
            if (containsLabel(searchable, ["burst"])) return 5;
            if (containsLabel(searchable, ["elemental_skill"])) return 4;
            return 2; // normal_attack or unknown
          }
          if (actionCase === "playCard") {
            // Differentiate card quality: zero-cost cards with no tangible
            // effect should not score as high as meaningful cards.
            const hasPositiveEffect =
              damageEstimate > 0 ||
              reactionValue > 0 ||
              containsLabel(searchable, [
                "summon", "shield", "heal", "buff", "weapon",
                "artifact", "location", "companion", "food",
              ]);
            if (totalCost === 0 && !hasPositiveEffect) return 0.5;
            if (totalCost === 0 && hasPositiveEffect) return 2;
            return 3;
          }
          if (actionCase === "switchActive" || actionCase === "chooseActive") return 1;
          if (actionCase === "declareEnd") return -2;
          return 0;
        })();
        const localGain =
          damageEstimate +
          reactionValue +
          tempoValue +
          energyGain +
          switchGain +
          actionBias;

        // ── Risk Penalty (multi-dimensional) ────────────────────
        const riskBreakdown = this.riskEvaluator.evaluate(candidate, riskCtx, localGain);
        const riskPenalty = riskBreakdown.total;

        // ── Future Potential ────────────────────────────────────
        const selfChars = Array.isArray((digest.self_summary as any)?.characters)
          ? (digest.self_summary as any).characters.map((ch: any) => ({
              id: Number(ch.character_id ?? ch.id ?? 0),
              energy: Number(ch.energy ?? 0),
              maxEnergy: Number(ch.max_energy ?? ch.maxEnergy ?? 3),
              alive: ch.alive !== false && Number(ch.hp ?? 1) > 0,
            }))
          : [];
        const futureCtx: FuturePotentialContext = {
          selfCharacters: selfChars,
          activeCharacterId: (digest.self_summary as any)?.active_character_id ?? null,
          candidateTags: tags,
          candidateNotes: notes,
        };
        const futureBreakdown = this.futurePotentialEvaluator.evaluate(candidate, futureCtx);
        const futurePotential = futureBreakdown.total;

        // ── Resource Penalty (dynamic weights, efficiency-ratio damped) ──
        const candidateResourceCtx: ResourceContext = {
          ...resourceCtx,
          resourcePolicy: effectiveFragment.resource_policy,
        };
        const resourceBreakdown = this.resourceCalculator.evaluate(
          candidate, candidateResourceCtx, localGain, futurePotential,
        );
        const resourcePenalty = resourceBreakdown.total;

        // ── Total ───────────────────────────────────────────────
        const total =
          strategyMatch + localGain + futurePotential - riskPenalty - resourcePenalty;
        const conservativeScore = riskPenalty + resourcePenalty;
        const endTurnLike = containsLabel(actionCase, [
          "declareEnd",
          "endTurn",
        ]);

        return {
          candidateId,
          actionCase,
          score: {
            strategyMatch,
            localGain,
            futurePotential,
            riskPenalty,
            resourcePenalty,
            total,
          },
          conservativeScore,
          endTurnLike,
        };
      })
      .sort((left, right) => {
        if (right.score.total !== left.score.total) {
          return right.score.total - left.score.total;
        }
        if (left.conservativeScore !== right.conservativeScore) {
          return left.conservativeScore - right.conservativeScore;
        }
        return left.candidateId.localeCompare(right.candidateId);
      });

    // ── Build breakdown + debug notes ─────────────────────────
    const breakdown: Record<string, number> = {};
    for (const item of legalCandidates) {
      breakdown[item.candidateId] = item.score.total;
      breakdown[`${item.candidateId}.strategy_match`] =
        item.score.strategyMatch;
      breakdown[`${item.candidateId}.local_gain`] = item.score.localGain;
      breakdown[`${item.candidateId}.risk_penalty`] =
        item.score.riskPenalty;
      breakdown[`${item.candidateId}.resource_penalty`] =
        item.score.resourcePenalty;
      breakdown[`${item.candidateId}.future_potential`] =
        item.score.futurePotential;
    }

    const debugNotes = [
        `[resolver] digest_summary=${JSON.stringify({
          digest_ref: digest.digest_ref,
          pending_method: digest.pending_method,
          candidate_count: digest.candidate_actions.length,
        })}`,
        `[resolver] fragment_summary=${JSON.stringify({
          fragment_ref: fragment.fragment_ref,
          intent: effectiveFragment.intent,
          must_do: effectiveFragment.must_do,
          avoid: effectiveFragment.avoid,
          preference_order: effectiveFragment.preference_order,
          resource_policy: effectiveFragment.resource_policy,
          decision_mode: effectiveFragment.decision_mode,
          local_eval_requests: effectiveFragment.local_eval_requests,
          evidence_policy: effectiveFragment.evidence_policy,
          fallback_rule: effectiveFragment.fallback_rule,
          combat_window: combatWindowSelection.activeWindowId,
          active_node: combatWindowSelection.activeNodeId,
        })}`,
      `[resolver] candidate_scores=${JSON.stringify(
        legalCandidates.map((item) => ({
          candidate_id: item.candidateId,
          action_case: item.actionCase,
          strategy_match: item.score.strategyMatch,
          local_gain: item.score.localGain,
          future_potential: item.score.futurePotential,
          risk_penalty: item.score.riskPenalty,
          resource_penalty: item.score.resourcePenalty,
          total_score: item.score.total,
        })),
      )}`,
    ];
    debugNotes.unshift(...combatWindowSelection.debugNotes);

    // ── Empty candidates → immediate fallback ─────────────────
    if (legalCandidates.length === 0) {
      debugNotes.push(
        "[resolver] final=none, reason=no legal candidates available after legality filtering",
      );
      return {
        selectedCandidateId: null,
        executionOrder: [],
        resolverReason:
          "No legal candidate available after legality filter.",
        scoreBreakdown: breakdown,
        fallbackUsed: true,
        effectiveFragment,
        activeWindowId: combatWindowSelection.activeWindowId,
        activeNodeId: combatWindowSelection.activeNodeId,
        transitionReason: combatWindowSelection.transitionReason,
        nextCombatWindowState: combatWindowSelection.state,
        debugNotes,
      };
    }

    // ── Selection logic ───────────────────────────────────────
    const best = legalCandidates[0];
    const fallbackRule = effectiveFragment.fallback_rule.toLowerCase();
    let selected = best;
    let fallbackUsed = false;
    let reason = `Selected ${selected.candidateId} by linear score.`;

    if (best.score.total <= 0) {
      fallbackUsed = true;

      // 1) Apply fallback_rule when preferred score is non-positive.
      if (
        fallbackRule.includes("end") ||
        fallbackRule.includes("declare")
      ) {
        const endTurnCandidate = legalCandidates.find(
          (item) => item.endTurnLike,
        );
        if (endTurnCandidate) {
          selected = endTurnCandidate;
          reason = `Fallback rule matched end-turn policy, selected ${selected.candidateId}.`;
        }
      } else if (
        fallbackRule.includes("low") ||
        fallbackRule.includes("safe") ||
        fallbackRule.includes("conservative")
      ) {
        selected = [...legalCandidates].sort((left, right) => {
          if (left.conservativeScore !== right.conservativeScore) {
            return left.conservativeScore - right.conservativeScore;
          }
          if (right.score.total !== left.score.total) {
            return right.score.total - left.score.total;
          }
          return left.candidateId.localeCompare(right.candidateId);
        })[0];
        reason = `Fallback rule requested conservative action, selected ${selected.candidateId}.`;
      }

      // 2) Conservative fallback if still no positive-yield choice.
      if (selected.score.total <= 0) {
        selected = [...legalCandidates].sort((left, right) => {
          if (left.conservativeScore !== right.conservativeScore) {
            return left.conservativeScore - right.conservativeScore;
          }
          return left.candidateId.localeCompare(right.candidateId);
        })[0];
        reason = `No positive-yield candidate, selected conservative action ${selected.candidateId}.`;
      }

      // 3) End-turn fallback for no-benefit set.
      if (selected.score.total <= 0) {
        const endTurnCandidate = legalCandidates.find(
          (item) => item.endTurnLike,
        );
        if (endTurnCandidate) {
          selected = endTurnCandidate;
          reason = `No positive-yield candidate, selected end-turn action ${selected.candidateId}.`;
        }
      }
    }

    const executionOrder = [
      selected.candidateId,
      ...legalCandidates
        .map((item) => item.candidateId)
        .filter(
          (candidateId) => candidateId !== selected.candidateId,
        ),
    ];

    // Append non-must_do candidates from afterAvoid as execution-retry
    // fallbacks so the execution loop can recover if all preferred
    // candidates fail at runtime (e.g. server-side rejection).
    const inOrder = new Set(executionOrder);
    for (const candidate of afterAvoid) {
      const id = String(candidate.candidate_id ?? "").trim();
      if (id.length > 0 && !inOrder.has(id)) {
        executionOrder.push(id);
        inOrder.add(id);
      }
    }

    debugNotes.push(
      `[resolver] final=${selected.candidateId}, reason=${reason}, fallback_used=${String(fallbackUsed)}`,
    );

    return {
      selectedCandidateId: selected.candidateId,
      executionOrder,
      resolverReason: reason,
      scoreBreakdown: breakdown,
      fallbackUsed,
      effectiveFragment,
      activeWindowId: combatWindowSelection.activeWindowId,
      activeNodeId: combatWindowSelection.activeNodeId,
      transitionReason: combatWindowSelection.transitionReason,
      nextCombatWindowState: combatWindowSelection.state,
      debugNotes,
    };
  }
}
