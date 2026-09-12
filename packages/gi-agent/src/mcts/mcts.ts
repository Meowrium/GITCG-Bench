// Copyright (C) 2024-2025 Guyutongxue
//
// MCTS with policy prior (PUCT) for GI-TCG action phase.
// Uses the existing SlotLinearRanker as policy prior and
// GBDT value model for leaf evaluation.

import type {
  ActionPhaseSnapshot,
  MctsAction,
} from "./state-snapshot.js"
import {
  takeActionPhaseSnapshot,
  simulateAction,
  isOpponentAlive,
  buildMctsAction,
  hashSnapshot,
} from "./state-snapshot.js"
import type { EngineActionInfo } from "./engine-continuation.js"
import type { GameState } from "@gi-tcg/core"
import { engineBackedActionSnapshot } from "./engine-continuation.js"

// ── Tree node with parent pointer ──

interface MctsNode {
  action: MctsAction | null
  parent: MctsNode | null
  snapshot: ActionPhaseSnapshot
  oppSnapshot: ActionPhaseSnapshot
  children: MctsNode[]
  visits: number
  totalValue: number
  prior: number
  isTerminal: boolean
  expanded: boolean        // children generated?
}

// ── MCTS Config ──

export interface MctsConfig {
  iterations: number
  explorationConstant: number
  maxDepth: number
  temperature: number
  priorWeight: number
  /** When true, use engine continuation for root node transitions instead of lightweight simulator */
  useEngineRoot?: boolean
  /** Engine action infos for root-level actions (required when useEngineRoot is true) */
  engineActions?: EngineActionInfo[]
  /**
   * CGT reversibility pruning: when true, fast-switch actions are heavily
   * deprioritized (prior × 0.001) because the opponent can undo them at zero
   * net cost, making them information-free from a combinatorial game perspective.
   * Theory: combinatorial-game-theory.md — reversibility + cooling tax.
   */
  enableReversibilityPruning?: boolean
  /**
   * P3: Temperature-weighted search — hot nodes get extra exploration bonus
   * in the PUCT formula, naturally attracting more simulations. Cold nodes
   * get fewer. Achieves per-node sim allocation without architectural changes.
   */
  temperatureWeightedSearch?: boolean
}

const DEFAULT_CONFIG: MctsConfig = {
  iterations: 200,
  explorationConstant: 1.4,
  maxDepth: 6,
  temperature: 1.0,
  priorWeight: 0.3,
}

// ── Callbacks ──

export type PolicyPriorFn = (
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  actions: MctsAction[],
) => number[]

export type ValueFn = (
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
) => number

export type ActionGeneratorFn = (
  snap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
) => { actions: MctsAction[]; engineIndices: number[] }

// ── MCTS Engine ──

/**
 * P3: Temperature estimator — how "hot" (urgent) is this position?
 * Returns 0..1 where 0=cold (Number-like, heuristic suffices), 1=hot (critical).
 *
 * Hot signals (additive, clipped to 0..1):
 *   +0.3  Opponent burst is ready
 *   +0.2  Amplifying reaction window (melt/vaporize) is open
 *   +0.3  Our active character is below 50% HP
 *   -0.1  Opponent has few dice (<3, limited options = less urgency)
 *   +0.1  Our burst is ready (can respond aggressively)
 *   +0.2  Any bench character near death (HP <= 2)
 */
function computeTemperature(snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot): number {
  const selfActive = snap.chars[snap.activeIdx];
  const oppActive = oppSnap.chars[oppSnap.activeIdx];
  if (!selfActive?.alive || !oppActive?.alive) return 0;

  let temp = 0;

  // Opponent burst ready → hot
  if (oppActive.maxEnergy > 0 && oppActive.energy >= oppActive.maxEnergy) {
    temp += 0.3;
  }

  // Amplifying reaction window open
  const selfAura = selfActive.aura as number | undefined;
  const oppAura = oppActive.aura as number | undefined;
  if (selfAura && selfAura > 0 && oppAura && oppAura > 0) {
    const key = `${oppAura},${selfAura}`;
    const amplifying: Record<string, boolean> = { "7,2": true, "2,7": true, "7,1": true, "1,7": true };
    if (amplifying[key]) temp += 0.2;
  }

  // Our active below 50% HP → danger
  if (selfActive.hp < selfActive.maxHp * 0.5) temp += 0.3;

  // Opponent has very few dice → less urgency (can't execute big plays)
  let oppDice = 0;
  const dv = oppSnap.dice;
  for (let i = 0; i < dv.length; i++) oppDice += dv[i];
  if (oppDice < 3) temp -= 0.1;

  // Our burst ready → can counter-attack
  if (selfActive.maxEnergy > 0 && selfActive.energy >= selfActive.maxEnergy) {
    temp += 0.1;
  }

  // Bench characters near death
  for (const ch of snap.chars) {
    if (!ch.alive || snap.chars.indexOf(ch) === snap.activeIdx) continue;
    if (ch.hp <= 2) temp += 0.2;
  }

  return Math.max(0, Math.min(1, temp));
}

export class MctsEngine {
  private config: MctsConfig
  private policyPrior: PolicyPriorFn
  private valueFn: ValueFn
  private generateActions: ActionGeneratorFn
  private valueCache: Map<string, number> = new Map()
  private actionCache: Map<string, { actions: MctsAction[]; engineIndices: number[] }> = new Map()
  private currentState?: GameState  // V26: stored for engine root continuation

  constructor(
    policyPrior: PolicyPriorFn,
    valueFn: ValueFn,
    generateActions: ActionGeneratorFn,
    config: Partial<MctsConfig> = {},
  ) {
    this.policyPrior = policyPrior
    this.valueFn = valueFn
    this.generateActions = generateActions
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  clearCaches(): void {
    this.valueCache.clear()
    this.actionCache.clear()
  }

  /**
   * Search from the current game state and opponent state.
   * Returns the best MctsAction, or null if no actions are available.
   */
  search(
    state: GameState,
    oppState: GameState,
    who: 0 | 1,
  ): { action: MctsAction | null; engineIndex: number | null } {
    this.currentState = state  // V26: store for engine root continuation
    const selfSnap = takeActionPhaseSnapshot(state, who)
    const oppSnap = takeActionPhaseSnapshot(oppState, who === 0 ? 1 : 0)
    return this.searchFromSnapshots(selfSnap, oppSnap)
  }

  /**
   * Search from pre-built action-phase snapshots (for testing / offline replay).
   */
  searchFromSnapshots(
    selfSnap: ActionPhaseSnapshot,
    oppSnap: ActionPhaseSnapshot,
  ): { action: MctsAction | null; engineIndex: number | null } {
    // If called directly (no GameState), disable engine root
    if (!this.currentState) {
      this.config = { ...this.config, useEngineRoot: false }
    }
    return this.searchCore(selfSnap, oppSnap)
  }

  // ── Core search logic ──

  private searchCore(
    selfSnap: ActionPhaseSnapshot,
    oppSnap: ActionPhaseSnapshot,
  ): { action: MctsAction | null; engineIndex: number | null } {

    // Generate actions (with cache)
    const snapHash = hashSnapshot(selfSnap)
    let cachedActions = this.actionCache.get(snapHash)
    if (!cachedActions) {
      cachedActions = this.generateActions(selfSnap, oppSnap)
      this.actionCache.set(snapHash, cachedActions)
    }
    const { actions, engineIndices } = cachedActions
    if (actions.length === 0) return { action: null, engineIndex: null }

    // Policy priors
    const logPriors = this.policyPrior(selfSnap, oppSnap, actions)

    // Build root
    const root: MctsNode = {
      action: null,
      parent: null,
      snapshot: selfSnap,
      oppSnapshot: oppSnap,
      children: [],
      visits: 1,
      totalValue: 0,
      prior: 1,
      isTerminal: false,
      expanded: true,
    }

    // Root children
    for (let i = 0; i < actions.length; i++) {
      const child: MctsNode = {
        action: actions[i],
        parent: root,
        snapshot: selfSnap,        // filled on expansion
        oppSnapshot: oppSnap,
        children: [],
        visits: 0,
        totalValue: 0,
        prior: Math.exp(logPriors[i] ?? -10),
        isTerminal: false,
        expanded: false,
      }
      root.children.push(child)
    }

    // Normalize priors
    const totalPrior = root.children.reduce((s, c) => s + c.prior, 0) || 1
    for (const child of root.children) {
      child.prior /= totalPrior
    }

    // CGT: reversibility pruning at root
    this.applyReversibilityPruning(root.children)

    // Main loop
    for (let iter = 0; iter < this.config.iterations; iter++) {
      let node = root
      let depth = 0

      // ── SELECT ──
      while (node.expanded && node.children.length > 0 && depth < this.config.maxDepth) {
        node = this.selectChild(node)
        depth++
      }

      // ── EXPAND & EVALUATE ──
      let value: number

      if (node.isTerminal) {
        value = node.totalValue
      } else if (!node.expanded && node.action && node.parent) {
        // Simulate the action to get the resulting state
        // V26 P0-2: Use engine continuation for root children, lightweight for inner
        const isRootChild = node.parent.parent === null && this.config.useEngineRoot
        if (isRootChild && this.config.engineActions) {
          // Engine-backed exact transition for root children
          const rootActionIdx = node.parent.children.indexOf(node)
          const engineAction = this.config.engineActions[rootActionIdx]
          if (engineAction) {
            const result = engineBackedActionSnapshot(
              this.currentState!,
              (node.parent.snapshot.who) as 0 | 1,
              engineAction,
            )
            node.snapshot = result.selfSnapshot
            node.oppSnapshot = result.oppSnapshot
          } else {
            // Fallback to lightweight
            const result = simulateAction(
              node.parent.snapshot,
              node.parent.oppSnapshot,
              node.action,
            )
            node.snapshot = result.newSnapshot
            node.oppSnapshot = result.opponentDelta
              ? mergeSnapshots(node.parent.oppSnapshot, result.opponentDelta)
              : node.parent.oppSnapshot
          }
        } else {
          // Lightweight simulation for inner nodes
          const result = simulateAction(
            node.parent.snapshot,
            node.parent.oppSnapshot,
            node.action,
          )
          node.snapshot = result.newSnapshot
          node.oppSnapshot = result.opponentDelta
            ? mergeSnapshots(node.parent.oppSnapshot, result.opponentDelta)
            : node.parent.oppSnapshot
        }

        // Check terminal conditions
        if (!isOpponentAlive(node.oppSnapshot)) {
          node.isTerminal = true
          value = 1.0
        } else if (node.snapshot.declaredEnd) {
          node.isTerminal = true
          value = this.getCachedValue(node.snapshot, node.oppSnapshot)
        } else if (depth >= this.config.maxDepth) {
          value = this.getCachedValue(node.snapshot, node.oppSnapshot)
        } else {
          // Expand: generate children for this new state (with cache)
          const childHash = hashSnapshot(node.snapshot)
          let childCached = this.actionCache.get(childHash)
          if (!childCached) {
            childCached = this.generateActions(node.snapshot, node.oppSnapshot)
            this.actionCache.set(childHash, childCached)
          }
          const childActions = childCached
          if (childActions.actions.length === 0) {
            node.isTerminal = true
            value = this.getCachedValue(node.snapshot, node.oppSnapshot)
          } else {
            const childLogPriors = this.policyPrior(
              node.snapshot, node.oppSnapshot, childActions.actions,
            )
            for (let i = 0; i < childActions.actions.length; i++) {
              const child: MctsNode = {
                action: childActions.actions[i],
                parent: node,
                snapshot: node.snapshot,
                oppSnapshot: node.oppSnapshot,
                children: [],
                visits: 0,
                totalValue: 0,
                prior: Math.exp(childLogPriors[i] ?? -10),
                isTerminal: false,
                expanded: false,
              }
              node.children.push(child)
            }
            // Normalize
            const cTotal = node.children.reduce((s, c) => s + c.prior, 0) || 1
            for (const c of node.children) c.prior /= cTotal

            // CGT: reversibility pruning in inner expansion
            this.applyReversibilityPruning(node.children)

            node.expanded = true
            value = this.getCachedValue(node.snapshot, node.oppSnapshot)
          }
        }
      } else {
        // Root or already visited terminal
        value = this.getCachedValue(node.snapshot, node.oppSnapshot)
      }

      // ── BACKUP ──
      this.backupFrom(node, value)
    }

    // Select best action (most visits from root children)
    return this.selectBest(root, engineIndices)
  }

  private getCachedValue(snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot): number {
    const key = hashSnapshot(snap) + "#" + hashSnapshot(oppSnap)
    const cached = this.valueCache.get(key)
    if (cached !== undefined) return cached
    const v = this.valueFn(snap, oppSnap)
    this.valueCache.set(key, v)
    return v
  }

  // ── CGT Reversibility Pruning ──

  /**
   * Deprioritize fast-switch actions when the opponent can undo them.
   * Returns the number of actions that were deprioritized.
   */
  private applyReversibilityPruning(children: MctsNode[]): number {
    if (!this.config.enableReversibilityPruning) return 0

    // Only prune when there are non-switch alternatives
    const nonSwitchCount = children.filter(
      (c) => c.action?.type !== "switch",
    ).length
    if (nonSwitchCount === 0) return 0  // all switches, keep them

    let pruned = 0
    for (const child of children) {
      if (child.action?.type === "switch" && child.action.fast) {
        // CGT: fast-switch is reversible — opponent can undo at 0 net cost.
        // Reduce prior to near-zero to avoid wasting search budget.
        child.prior *= 0.001
        pruned++
      }
    }

    // Re-normalize after pruning
    if (pruned > 0) {
      const newTotal = children.reduce((s, c) => s + c.prior, 0) || 1
      for (const c of children) c.prior /= newTotal
    }

    return pruned
  }

  // ── PUCT selection ──

  private selectChild(node: MctsNode): MctsNode {
    const sqrtParent = Math.sqrt(node.visits + 1)
    let best: MctsNode = node.children[0]
    let bestScore = -Infinity

    for (const child of node.children) {
      let score: number
      // P3: Temperature bonus — hot nodes get higher exploration bonus
      const tempBonus = this.config.temperatureWeightedSearch
        ? computeTemperature(child.snapshot, child.oppSnapshot)
        : 0

      if (child.visits === 0) {
        score = this.config.explorationConstant * child.prior * (1 + tempBonus) * sqrtParent + 1000
      } else {
        const q = child.totalValue / child.visits
        const u = this.config.explorationConstant * child.prior * (1 + tempBonus) * sqrtParent / (1 + child.visits)
        score = q + u
      }

      if (score > bestScore) {
        bestScore = score
        best = child
      }
    }

    return best
  }

  // ── Backup (walk up to root) ──

  private backupFrom(node: MctsNode, value: number): void {
    let current: MctsNode | null = node
    while (current) {
      current.visits++
      current.totalValue += value
      current = current.parent
    }
  }

  // ── Select best action from root ──

  private selectBest(
    root: MctsNode,
    engineIndices: number[],
  ): { action: MctsAction | null; engineIndex: number | null } {
    if (root.children.length === 0) return { action: null, engineIndex: null }

    const visits = root.children.map((c) => c.visits)
    const totalVisits = visits.reduce((s, v) => s + v, 0)

    if (totalVisits === 0) {
      return { action: root.children[0].action, engineIndex: engineIndices[0] ?? null }
    }

    if (this.config.temperature <= 0) {
      // Greedy
      let bestIdx = 0
      for (let i = 1; i < visits.length; i++) {
        if (visits[i] > visits[bestIdx]) bestIdx = i
      }
      return {
        action: root.children[bestIdx].action,
        engineIndex: engineIndices[bestIdx] ?? null,
      }
    }

    // Temperature sampling
    const temp = this.config.temperature
    const probs = visits.map((v) => Math.pow(Math.max(v, 0.01) / totalVisits, 1 / temp))
    const totalProb = probs.reduce((s, p) => s + p, 0)
    const r = Math.random() * totalProb
    let cum = 0
    for (let i = 0; i < probs.length; i++) {
      cum += probs[i]
      if (r <= cum) {
        return {
          action: root.children[i].action,
          engineIndex: engineIndices[i] ?? null,
        }
      }
    }
    return {
      action: root.children[root.children.length - 1].action,
      engineIndex: engineIndices[engineIndices.length - 1] ?? null,
    }
  }
}

function mergeSnapshots(base: ActionPhaseSnapshot, delta: Partial<ActionPhaseSnapshot>): ActionPhaseSnapshot {
  return { ...base, ...delta }
}
