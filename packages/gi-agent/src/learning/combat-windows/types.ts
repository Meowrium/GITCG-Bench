// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

export interface RuntimePlanArtifact {
  version?: string
  plan_id?: string
  session_id?: string
  deck_fingerprint?: string
  source_skills?: string[]
  global_goal?: string
  turn1_3_priorities?: string[]
  risk_rules?: string[]
  pivot_rules?: string[]
  created_at?: string
  updated_at?: string
}

export interface RuntimeCharacterSummary {
  id: number
  definition_id?: number | null
  name?: string
  element?: string
  weapon_type?: string
  hp: number
  max_hp: number
  energy: number
  max_energy: number
  alive: boolean
}

export interface RuntimeCandidateAction {
  candidate_id: string
  action_case: string
  candidate_signature?: string | null
  definition_id?: number | null
  card_definition_id?: number | null
  card_id?: number | null
  cost?: Record<string, unknown>
  damage_estimate?: number
  reaction_value?: number
  tempo_value?: number
  survival_risk?: number
  tags?: string[]
  notes?: string[]
}

export interface RuntimeCharacterDefinitionInfo {
  id: number
  definition_id: number
  name: string
  element: string
  weapon_type: string
  skills?: Array<{
    name: string
    description: string
    cost: number
  }>
}

export interface RuntimeCardDefinitionInfo {
  definition_id: number
  name: string
  type: string
  tags: string[]
  cost: number
  effect_text: string
}

export interface RuntimeDigestArtifact {
  version?: string
  digest_ref: string
  session_id: string
  round: number
  turn: number
  pending_method: string
  strategic_profile_ref?: string
  rpc_seq?: number
  state_signature?: string
  self_summary: {
    active_character_id: number
    hand_count?: number
    characters: RuntimeCharacterSummary[]
  }
  opponent_summary: {
    active_character_id: number
    characters: RuntimeCharacterSummary[]
  }
  resource_summary: {
    dice?: number[]
    dice_count: number
    omni_count: number
    cards_in_hand?: number
    support_count?: number
    summon_count?: number
    round_phase?: number
  }
  candidate_actions: RuntimeCandidateAction[]
  hard_constraints?: string[]
  character_definitions?: RuntimeCharacterDefinitionInfo[]
  card_definitions?: RuntimeCardDefinitionInfo[]
  active_combat_window?: {
    shard_ref?: string | null
    window_id?: string | null
    active_node_id?: string | null
    actions_taken?: number
    max_actions?: number
  } | null
}

export interface RuntimeFragmentArtifact {
  version?: string
  fragment_ref: string
  session_id: string
  digest_ref: string
  intent: string
  must_do?: string[]
  avoid?: string[]
  preference_order?: string[]
  resource_policy?: string
  target_policy?: string
  fallback_rule?: string
  explanation?: string
  created_at?: string
}

export interface RuntimeFeedbackArtifact {
  version?: string
  session_id: string
  digest_ref: string
  fragment_ref?: string | null
  selected_candidate_id?: string | null
  executed_tool?: string | null
  execution_ok: boolean
  resolver_reason?: string
  score_breakdown?: Record<string, number>
  fallback_used?: boolean
  notes?: string[]
  created_at?: string
  active_window_id?: string | null
  active_node_id?: string | null
  transition_reason?: string | null
}

export interface RuntimeWindowStep {
  step_index: number
  artifact_ts: number
  digest: RuntimeDigestArtifact
  fragment: RuntimeFragmentArtifact | null
  feedback: RuntimeFeedbackArtifact
  selected_candidate: RuntimeCandidateAction | null
}

export interface CombatWindowFingerprint {
  deck_fingerprint_self: string | null
  fingerprint_quality: "session" | "replay_backed"
  pending_method: string
  round_bucket: string
  turn_player: number
  self_active_hp_bucket: string
  opp_active_hp_bucket: string
  self_active_energy_bucket: string
  opp_active_energy_bucket: string
  dice_bucket: string
  omni_bucket: string
  tags: string[]
}

export interface CanonicalCombatWindowFingerprint extends CombatWindowFingerprint {
  deck_fingerprint_opp: string | null
  matchup_id: string | null
  self_active_character_definition_id: number | null
  opp_active_character_definition_id: number | null
  support_bucket: string
  summon_bucket: string
  cards_in_hand_bucket: string
  self_active_energy_bucket: string
  opp_active_energy_bucket: string
  first_action_case: string | null
  first_action_definition_id: number | null
  first_action_tags: string[]
  action_count_bucket: string
  canonical_key: string
}

export interface CandidateCombatWindow {
  window_id: string
  session_id: string
  source_window_kind: "session_sequence"
  sequence_index: number
  sequence_start_step: number
  action_count: number
  round: number
  turn: number
  started_at: string | null
  ended_at: string | null
  score: number
  deck_fingerprint_self: string | null
  deck_fingerprint_opp?: string | null
  strategic_profile_ref: string | null
  global_goal: string | null
  tags: string[]
  state_fingerprint: CombatWindowFingerprint
  source_paths: {
    plan_path: string | null
    artifact_dir: string
  }
  steps: RuntimeWindowStep[]
}

export interface CombatWindowExtractionConfig {
  runtime_plans_dir: string
  session_id?: string
  min_actions?: number
  max_actions?: number
  top_k_per_session?: number
}

export interface CombatWindowExtractionResult {
  generated_at: string
  runtime_plans_dir: string
  sessions_scanned: number
  windows: CandidateCombatWindow[]
}

export type CombatWindowNodeKind =
  | "setup"
  | "pivot"
  | "convert"
  | "burst"
  | "survive"
  | "exit"

export interface CombatWindowPlanTransition {
  condition: string
  to: string
  priority: number
}

export interface CombatWindowPlanNode {
  id: string
  kind: CombatWindowNodeKind
  intent: string
  expected_action_case?: string[]
  when: string[]
  must_do: string[]
  avoid: string[]
  prefer_tags: string[]
  resource_policy?: "strict" | "balanced" | "aggressive"
  fallback_rule?: string
  next: CombatWindowPlanTransition[]
}

export interface CombatWindowPlan {
  window_id: string
  plan_horizon: {
    min_actions: number
    max_actions: number
  }
  entry_conditions: string[]
  interrupt_conditions: string[]
  success_conditions: string[]
  fail_conditions: string[]
  entry_node_id: string
  nodes: CombatWindowPlanNode[]
}

export interface PostAnalysisBranchClaim {
  claim: string
  evidence_type: "observed" | "heuristic" | "branch_eval"
  needs_branch_eval: boolean
}

export interface CombatWindowAnalysisRecord {
  analysis_meta: {
    schema_version: "combat-window-analysis.v1"
    model: string
    prompt_version: string
    created_at: string
  }
  source_context: {
    window_id: string
    session_id: string
    matchup_id: string | null
    deck_fingerprint_self: string | null
    replay_path: string | null
  }
  window_locator: {
    round: number
    turn: number
    sequence_index: number
    sequence_start_step: number
    action_count: number
  }
  state_fingerprint: CombatWindowFingerprint
  combat_window_plan: CombatWindowPlan
  candidate_review: {
    actual_line: string[]
    preferred_line_tags: string[]
    rejected_patterns: string[]
    key_branch_claims: PostAnalysisBranchClaim[]
  }
  outcome_assessment: {
    local_result: "good" | "mixed" | "bad"
    why: string[]
    reusable: boolean
    reuse_scope: "same_deck_same_matchup" | "same_deck_broad" | "narrow_only"
  }
  quality: {
    llm_confidence: number
    generalization_confidence: number
    risk_flags: string[]
  }
}

export type TreeStatus = "draft" | "validated" | "promoted" | "rejected"

export interface TreeRecord {
  tree_id: string
  source_window_id: string
  status: TreeStatus
  source_window: CandidateCombatWindow
  analysis: CombatWindowAnalysisRecord
  canonical_fingerprint?: CanonicalCombatWindowFingerprint | null
  replay_alignment?: ReplayAlignmentSummary | null
  branch_eval_summary?: BranchEvalSummary | null
  validation_summary?: TreeValidationSummary | null
  created_at: string
  updated_at: string
}

export interface TreeValidationSummary {
  schema_ok: boolean
  entry_conditions_ok: boolean | null
  replay_alignment_ok: boolean | null
  legality_ok: boolean | null
  branch_eval_ok: boolean | null
  status: "validated" | "rejected"
  reasons: string[]
  matched_node_ids: string[]
}

export interface TreeValidationRun {
  run_id: string
  tree_id: string
  summary: TreeValidationSummary
  created_at: string
}

export interface TreeUsageStat {
  tree_id: string
  used_count: number
  success_count: number
  fail_count: number
  avg_local_value: number | null
  last_used_at: string | null
}

export interface ReplayAlignmentSummary {
  matched: boolean
  benchmark_path: string | null
  matchup_id: string | null
  replay_dir: string | null
  replay_file: string | null
  replay_entry_index: number | null
  replay_next_state_index: number | null
  replay_action_index: number | null
  replay_action_case: string | null
  replay_action_tags: string[]
  self_deck_fingerprint: string | null
  opponent_deck_fingerprint: string | null
  similarity: number
  matched_fields: string[]
}

export interface BranchEvalSummary {
  matchup_id: string | null
  replay_file: string | null
  replay_entry_index: number | null
  replay_action_index: number | null
  replay_action_type: string | null
  replay_action_definition_id: number | null
  replay_action_tags: string[]
  policy_selected_action_index: number | null
  policy_selected_action_type: string | null
  best_action_index: number | null
  best_action_type: string | null
  best_action_definition_id: number | null
  best_action_tags: string[]
  replay_action_win_rate: number | null
  policy_action_win_rate: number | null
  best_action_win_rate: number | null
  lift_vs_replay: number | null
  lift_vs_policy: number | null
  tree_first_action_case_matches_replay: boolean
  promote_signal: "promote" | "hold" | "reject"
}
