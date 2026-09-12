// Copyright (C) 2024-2025 Guyutongxue
//
// Scoring Component Registry — V26 P1-3
//
// Replaces the flat list of scoring adjustments in GiMlPolicy with a
// configurable, independently-testable component registry.
//
// Each ScoringComponent:
//   - Has a unique id
//   - Can be enabled/disabled via config
//   - Returns { score, reasons[] }
//   - Receives the full decision context via ScoringContext
//
// Usage:
//   const registry = createDefaultScoringRegistry(policy, options)
//   const contributions = registry.scoreAll(ctx)
//   const finalScore = contributions.reduce((s, c) => s + c.score, 0)

import type { MlCandidateAction, MlDecisionPoint } from "@gi-tcg/ml/contracts"
import type { RuntimeConceptState } from "@gi-tcg/ml/runtime"
import type { SlotLinearRankerConfig } from "@gi-tcg/ml/ranker"
import { predictGbdtRankerScore } from "@gi-tcg/ml/value"
import type { GbdtQValueArtifact, GbdtRankerArtifact, AnyValueArtifact } from "@gi-tcg/ml/value"
import { predictValueSample } from "@gi-tcg/ml/value"
import { flattenNumericRecord } from "@gi-tcg/ml/utils"
import type { CombatWindowLibrary } from "../../learning/combat-windows/export-library.js"
import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import { buildBranchEvalCandidateNumericSlots, buildBranchEvalQueryNumericSlots } from "../../evaluation/branch-eval/report-slots.js"
import type { PolicyCandidateAction, PolicyDecisionContext, PolicyTurnDigest, RankedPolicyCandidate, RuntimeMacroPlan } from "./types.js"
import type { ReactionChainMatch } from "./reaction-chain-templates.js"

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ScoringContribution {
  id: string
  score: number
  reasons: string[]
  /** If true, this is a hard constraint — score is absolute, not additive */
  hardConstraint?: boolean
}

export interface ScoringComponent {
  id: string
  label: string
  /** Whether this component is currently enabled */
  enabled: (ctx: ScoringContext) => boolean
  /** Compute score for one candidate */
  score: (ctx: ScoringContext) => ScoringContribution
}

/**
 * Complete context passed to every scoring component.
 * Contains all data that any component might need.
 */
export interface ScoringContext {
  // ── Per-decision data ──
  digest: PolicyTurnDigest
  candidate: PolicyCandidateAction
  mlCandidate: MlCandidateAction | null
  query: MlDecisionPoint
  conceptState: RuntimeConceptState | null
  macroPlan: RuntimeMacroPlan | null
  planSearchGuidance: { score: number; reasons: string[] } | null
  context: PolicyDecisionContext | undefined
  reactionChainMatches: ReactionChainMatch[] | undefined

  // ── Policy-level artifacts & config (readonly) ──
  gbdtValueDirectMode: boolean
  rankerConfig: SlotLinearRankerConfig
  gbdtRankerArtifact: GbdtRankerArtifact | null
  qValueArtifact: GbdtQValueArtifact | null
  valueArtifact: AnyValueArtifact | null
  valueWeight: number
  qValueWeight: number
  tuneFollowupWeight: number
  macroPlanWeight: number
  planSearchWeight: number
  strategicValueWeight: number
  reactionChainWeight: number
  tempoValueWeight: number
  temporalOpportunityWeight: number
  combatWindowLibrary: CombatWindowLibrary | null

  // ── State provider (for engine-level queries) ──
  stateProvider?: () => unknown

  // ── Custom component configs (extensible) ──
  componentConfigs: Record<string, unknown>
}

// ─────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────

export class ScoringRegistry {
  private components: ScoringComponent[] = []

  register(component: ScoringComponent): this {
    // Don't allow duplicate ids
    const existing = this.components.findIndex(c => c.id === component.id)
    if (existing >= 0) {
      this.components[existing] = component
    } else {
      this.components.push(component)
    }
    return this
  }

  registerAll(components: ScoringComponent[]): this {
    for (const c of components) {
      this.register(c)
    }
    return this
  }

  /** Remove a component by id */
  disable(id: string): this {
    this.components = this.components.filter(c => c.id !== id)
    return this
  }

  /** Get all enabled contributions for the current context */
  scoreAll(ctx: ScoringContext): ScoringContribution[] {
    const results: ScoringContribution[] = []
    for (const component of this.components) {
      if (component.enabled(ctx)) {
        try {
          const contribution = component.score(ctx)
          results.push(contribution)
        } catch (err) {
          // Log error but don't crash the whole ranking
          results.push({
            id: component.id,
            score: 0,
            reasons: [`error:${String(err)}`],
          })
        }
      }
    }
    return results
  }

  /** Get the list of component ids (for logging/debugging) */
  listIds(): string[] {
    return this.components.map(c => c.id)
  }

  /** Create a new registry from a config that enables/disables specific components */
  static fromConfig(
    components: ScoringComponent[],
    disabledIds: string[] = [],
  ): ScoringRegistry {
    const registry = new ScoringRegistry()
    for (const c of components) {
      if (!disabledIds.includes(c.id)) {
        registry.register(c)
      }
    }
    return registry
  }
}

// ─────────────────────────────────────────────
// Helpers for building ScoringContext
// ─────────────────────────────────────────────

export function makeScoringContext(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  mlCandidate: MlCandidateAction | null,
  query: MlDecisionPoint,
  conceptState: RuntimeConceptState | null,
  macroPlan: RuntimeMacroPlan | null,
  planSearchGuidance: { score: number; reasons: string[] } | null,
  context: PolicyDecisionContext | undefined,
  reactionChainMatches: ReactionChainMatch[] | undefined,
  options: {
    gbdtValueDirectMode: boolean
    rankerConfig: SlotLinearRankerConfig
    gbdtRankerArtifact: GbdtRankerArtifact | null
    qValueArtifact: GbdtQValueArtifact | null
    valueArtifact: AnyValueArtifact | null
    valueWeight: number
    qValueWeight: number
    tuneFollowupWeight: number
    macroPlanWeight: number
    planSearchWeight: number
    strategicValueWeight: number
    reactionChainWeight: number
    tempoValueWeight: number
    temporalOpportunityWeight: number
    combatWindowLibrary: CombatWindowLibrary | null
    componentConfigs?: Record<string, unknown>
  },
): ScoringContext {
  return {
    digest,
    candidate,
    mlCandidate,
    query,
    conceptState,
    macroPlan,
    planSearchGuidance,
    context,
    reactionChainMatches,
    ...options,
    componentConfigs: options.componentConfigs ?? {},
  }
}
