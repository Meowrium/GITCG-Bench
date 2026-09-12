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

import type { GameData, GameState, PlayerIO } from "@gi-tcg/core";
import {
  ActionValidity,
  PbDiceType,
  type Notification,
  type RpcRequest,
  type RpcResponse,
  createRpcResponse,
} from "@gi-tcg/typings";
import type { SearchResult } from "../search/types.js";
import { BoundedSearcher } from "../search/bounded-searcher.js";
import { expansionActionHeuristicScore } from "../search/bounded-searcher.js";
import { SimAdapter } from "../adapters/sim-adapter.js";
import { StateEvaluator } from "../eval-baselines/state-evaluator.js";
import type { BaselinePolicy } from "../policy/baseline-policy.js";
import type { EvaluatorPolicy } from "../policy/evaluator-policy.js";
import type { GamePlan } from "../policy/game-plan.js";
import { buildGamePlanRuntimeState, type GamePlanRuntimeState } from "../policy/game-plan.js";
import { computeExecutionReadiness, computeClosingPressure } from "../policy/game-plan.js";
import { estimateReactionBonusFlat } from "../policy/character-value-evaluator.js";
import type { GiMlPolicy } from "../policy/gi-ml-policy.js";
import { buildPolicyTurnDigest } from "../policy/candidate-semantics.js";
import type { PolicyDecision, PolicyTurnDigest, RuntimeMacroPlanState } from "../policy/types.js";
import { getCharacterSkillProfile } from "../../knowledge/character-skill-profiles.js";
import { buildObservationV1FromVisibleState } from "../../learning/rl/observation-exporter.js";
import {
  initOpponentModel,
  updateOpponentModel,
  type OpponentModelState,
} from "../policy/opponent-model.js";
import { extractOpponentBehaviorEvents } from "../policy/behavior-event-extractor.js";
import {
  StrategicPlanStateMachine,
  type PlanPhase,
  type PlanUpdateInput,
} from "../plan/index.js"
import type { ActionPattern } from "../plan/types.js"
import { matchAnyPattern } from "../plan/pattern-matcher.js"
import type { PolicyCandidateAction } from "../policy/types.js"
import { computeRiskAssessment } from "../policy/risk-model.js"
import { computeLethalChains } from "../policy/lethal-chain.js"
import { buildDiceBucketsFromActions, allocateDiceToBuckets } from "../plan/dice-budget.js"

export type PolicyLike = Pick<BaselinePolicy | EvaluatorPolicy | GiMlPolicy, "choose">;

export interface PolicyPlayerSearchOptions {
  enabled?: boolean;
  maxDepth?: number;
  beamWidth?: number;
  enableMinimax?: boolean;
  minimaxDepth?: number;
  topK?: number;
  minCandidateCount?: number;
  rerankWeight?: number;
  /** Simulate opponent for this many steps. 0=skip (default 0 for shallow, 2+ for temporal reasoning) */
  maxOpponentDepth?: number;
  /** Continue searching across round boundaries */
  crossRoundSearch?: boolean;
}

export interface PolicyPlayerGameContext {
  data: GameData;
  stateProvider: () => GameState;
}

export interface PolicyPlayerIOOptions {
  side: 0 | 1;
  policy: PolicyLike;
  searchOptions?: PolicyPlayerSearchOptions;
  gamePlan?: GamePlan | null;
  /** SPL: Compiled plan phases for this deck */
  planPhases?: PlanPhase[] | null;
  /** ── V2 Framework: Enable risk model, lethal chain, dice bucketing */
  v2Enabled?: boolean;
}

const DEFAULT_SEARCH_OPTIONS: Required<PolicyPlayerSearchOptions> = {
  enabled: true,
  maxDepth: 2,
  beamWidth: 4,
  enableMinimax: true,
  minimaxDepth: 1,
  topK: 4,
  minCandidateCount: 3,
  rerankWeight: 1.1,
  maxOpponentDepth: 0,
  crossRoundSearch: false,
}

// ── Mulligan Prior Helpers ──

interface MulliganPriorsFile {
  version: number
  perDeck: Record<string, {
    deckChars: number[]
    cards: Record<number, {
      keepWins: number; keepTotal: number; keepWinrate: number
      replaceWins: number; replaceTotal: number; replaceWinrate: number
      delta: number; confident: boolean
    }>
    combos: Array<{
      cardIds: [number, number]; jointWinrate: number
      expectedProduct: number; synergy: number; confident: boolean
    }>
  }>
}

let _mulliganPriorsCache: MulliganPriorsFile | null = null
let _mulliganPriorsLoaded = false

function loadMulliganPriors(): MulliganPriorsFile | null {
  if (_mulliganPriorsLoaded) return _mulliganPriorsCache
  _mulliganPriorsLoaded = true
  try {
    const fs = require("node:fs")
    const candidates = [
      "/app/artifacts/mulligan-priors.json",
      "/app/v15-artifacts/mulligan-priors.json",
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        _mulliganPriorsCache = JSON.parse(fs.readFileSync(p, "utf-8"))
        return _mulliganPriorsCache
      }
    }
  } catch {
    // Not available
  }
  _mulliganPriorsCache = null
  return null
}

type SearchComparableAction = {
  type: string;
  fast?: boolean;
  skill?: { definition: { id: number }; caller?: { definition: { id: number } } };
  to?: { definition: { id: number } };
  card?: { definition: { id: number } };
  result?: number;
}

export class PolicyPlayerIO implements PlayerIO {
  private readonly side: 0 | 1;
  private readonly policy: PolicyLike;
  private readonly searchOptions: Required<PolicyPlayerSearchOptions>;
  private latestNotificationState?: Notification["state"];
  private macroPlanState: RuntimeMacroPlanState | null = null;
  private readonly gamePlan: GamePlan | null;
  private gamePlanState: GamePlanRuntimeState | null = null;
  private opponentModelState: OpponentModelState | null = null;
  private stateProvider?: () => GameState;
  private searcher: BoundedSearcher | null = null;
  private planStateMachine: StrategicPlanStateMachine | null = null;
  private readonly v2Enabled: boolean;

  constructor(options: PolicyPlayerIOOptions) {
    this.side = options.side;
    this.policy = options.policy;
    this.searchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...options.searchOptions };
    this.gamePlan = options.gamePlan ?? null;
    this.v2Enabled = options.v2Enabled ?? false;
    if (options.planPhases && options.planPhases.length > 0) {
      this.planStateMachine = new StrategicPlanStateMachine(options.planPhases)
    }
  }

  notify(notification: Notification) {
    // P3: 从 mutations 中提取对手行为事件并更新对手模型
    if (notification.mutation && notification.mutation.length > 0) {
      const opponentWho = (this.side === 0 ? 1 : 0) as 0 | 1;
      // 懒初始化对手模型（从对手角色阵容推断先验）
      if (!this.opponentModelState && notification.state) {
        const oppPlayer = notification.state.player[opponentWho];
        if (oppPlayer) {
          const elements = oppPlayer.character
            .filter((ch) => !ch.defeated)
            .map((ch) => inferElementFromDefinitionId(ch.definitionId))
            .filter((e) => e !== "unknown");
          this.opponentModelState = initOpponentModel(elements);
        }
      }
      if (this.opponentModelState) {
        const events = extractOpponentBehaviorEvents(notification.mutation, (this.side === 0 ? 1 : 0) as 0 | 1);
        if (events.length > 0) {
          this.opponentModelState = updateOpponentModel(this.opponentModelState, events);
        }
      }
    }
    this.latestNotificationState = notification.state;
  }

  private gameData?: GameData

  attachGameContext(context: PolicyPlayerGameContext) {
    this.gameData = context.data
    this.stateProvider = context.stateProvider;
    this.searcher = this.searchOptions.enabled
      ? new BoundedSearcher(
          new SimAdapter(context.data),
          new StateEvaluator(),
          {
            maxDepth: this.searchOptions.maxDepth,
            beamWidth: this.searchOptions.beamWidth,
            perspective: this.side,
            enableMinimax: this.searchOptions.enableMinimax,
            minimaxDepth: this.searchOptions.minimaxDepth,
            maxOpponentDepth: this.searchOptions.maxOpponentDepth ?? 0,
            crossRoundSearch: this.searchOptions.crossRoundSearch ?? false,
            maxFastActionDepth: this.searchOptions.maxOpponentDepth ? 4 : 3,
          },
        )
      : null;
  }

  async rpc(request: RpcRequest): Promise<RpcResponse> {
    const rpc = request.request;
    if (!rpc) {
      throw new Error("Missing RPC request envelope");
    }

    switch (rpc.$case) {
      case "action":
        return createRpcResponse("action", await this.chooseAction(rpc.value.action));
      case "chooseActive":
        return createRpcResponse("chooseActive", {
          activeCharacterId: this.chooseBestActiveCharacter(rpc.value.candidateIds),
        });
      case "switchHands": {
        const handDefIds = (rpc.value as any).handCardDefinitionIds as number[] ?? []
        const handEntityIds = (rpc.value as any).handCardEntityIds as number[] ?? []
        return createRpcResponse("switchHands", {
          removedHandIds: this.getCardsToMulligan(handDefIds, handEntityIds),
        })
      }
      case "rerollDice":
        return createRpcResponse("rerollDice", {
          diceToReroll: this.getDiceToReroll(),
        });
      case "selectCard":
        return createRpcResponse("selectCard", {
          selectedDefinitionId: rpc.value.candidateDefinitionIds[0] ?? 0,
        });
      default: {
        const _exhaustive: never = rpc;
        throw new Error(`Unsupported RPC method: ${String(_exhaustive)}`);
      }
    }
  }

  private async chooseAction(actions: readonly RpcAction[]): Promise<{
    chosenActionIndex: number;
    usedDice: PbDiceType[];
  }> {
    const allActions = actions
      .map((action, index) => ({ action, index }));
    const validActions = allActions.filter(
      ({ action }) => action.validity === ActionValidity.VALID,
    );

    if (validActions.length === 0) {
      const fallback = actions[0];
      return {
        chosenActionIndex: 0,
        usedDice: fallback?.autoSelectedDice ?? [],
      };
    }

    const digest = this.buildDigest(allActions);
    const observation = this.latestNotificationState
      ? buildObservationV1FromVisibleState(this.latestNotificationState, this.side, {
          gameId: "runtime",
          episodeId: "runtime",
          decisionPointId: `runtime:r${this.latestNotificationState.roundNumber}:t${this.latestNotificationState.currentTurn}:a${actions.length}`,
          actorWho: this.side,
          pendingMethod: "action",
          actionCountInRound: 0,
          viewKind: "policy_public",
        })
      : null;
    if (observation && this.gamePlan) {
      this.gamePlanState = buildGamePlanRuntimeState(this.gamePlan, observation)
      observation.derived.game_setup_completion = this.gamePlanState.setup_completion
      // V31 F2: game_phase_estimate is @deprecated-P5; still populated for legacy
      // captures but new continuous progress signals (below) supersede it.
      const phaseMap = { setup: 0, transition: 1, execution: 2, closing: 3 } as const
      observation.derived.game_phase_estimate = phaseMap[this.gamePlanState.current_phase]
      observation.derived.game_primary_path_viable = this.gamePlanState.primary_path_viable ? 1 : 0
    }
    if (observation) {
      // V31 F1: engine-aligned additive reaction-threat bonus (flat +2/+1/0).
      const selfActiveAura = observation.self.characters.find((c) => c.is_active)?.aura ?? null
      observation.derived.opp_reaction_bonus_now = estimateReactionBonusFlat(
        observation.opponent,
        selfActiveAura,
      )
      // V31 F2: continuous phase-progress signals (replace discrete game_phase_estimate).
      // Computed from public state only, so available with or without a GamePlan.
      observation.derived.execution_readiness = computeExecutionReadiness(observation)
      observation.derived.closing_pressure = computeClosingPressure(observation)
    }

    // SPL: Update strategic plan state machine and pre-filter candidates
    let splContext = null
    if (this.planStateMachine && this.latestNotificationState) {
      const input = buildPlanUpdateInput(this.latestNotificationState, this.side)
      splContext = this.planStateMachine.update(input)

      // Pre-filter valid actions using SPL ban list
      if (splContext.actionBanList.length > 0) {
        const filterResult = filterValidActionsBySPL(
          validActions,
          this.latestNotificationState,
          this.side,
          splContext.actionBanList,
        )
        if (filterResult.length > 0) {
        }
      }
    }

    // ── V2: Risk assessment + dice bucketing + lethal chains ──
    let v2Notes: string[] = []
    let riskAssessment = null
    let diceAllocation = null
    let lethalChains = null
    if (this.v2Enabled && this.latestNotificationState) {
      // Risk assessment
      if (observation) {
        riskAssessment = computeRiskAssessment(observation)
        v2Notes.push(`risk:${riskAssessment.overallLevel}`)
      }

      // Dice bucketing
      if (observation) {
        const dicePool = observation.self.dice.counts_by_type ?? {}
        const candidates = digest.candidate_actions ?? []
        const buckets = buildDiceBucketsFromActions(candidates)
        if (buckets.length > 0) {
          diceAllocation = allocateDiceToBuckets(dicePool, buckets)
          v2Notes.push(`dice_fitness:${diceAllocation.fitness.toFixed(2)}`)
        }
      }

      // Lethal chains (midgame/closing only)
      if (splContext && splContext.phaseId !== "opening" && observation) {
        const candidates = digest.candidate_actions ?? []
        lethalChains = computeLethalChains(observation, candidates)
        if (lethalChains.length > 0) {
          v2Notes.push(`lethal:${lethalChains[0].description}`)
        }
      }
    }

    const decision = this.policy.choose(digest, {
      observation,
      macroPlanState: this.macroPlanState,
      gamePlanState: this.gamePlanState,
      opponentModelState: this.opponentModelState,
      actionBanList: splContext?.actionBanList ?? null,
      threatBonusMap: splContext?.threatBonusMap ?? null,
      diceBudget: splContext?.diceBudget ?? null,
      primaryPatterns: splContext?.primaryPatterns ?? null,
      primaryMatchBonus: 2.0,
      splPreFiltered: false,
      // ── V5: V2 computed data now passed to policy ──
      riskAssessment,
      lethalChains,
      diceAllocation,
      // ── MCTS: GameState snapshot provider ──
      stateProvider: this.stateProvider,
    });
    this.macroPlanState = decision.macroPlanState ?? this.macroPlanState
    const searchSelected = await this.chooseActionWithSearch(validActions, decision)
    const selected =
      searchSelected ??
      validActions.find(
        ({ index }) => String(index) === decision.selectedCandidateId,
      ) ?? validActions[0];

    return {
      chosenActionIndex: selected.index,
      usedDice: selected.action.autoSelectedDice,
    };
  }

  private getDiceToReroll(): PbDiceType[] {
    const state = this.latestNotificationState;
    const self = state?.player[this.side];
    if (!self) {
      return [];
    }

    // Collect elements of all alive characters — keep dice matching ANY of them.
    // PbDiceType enum: Cryo=1, Hydro=2, Pyro=3, Electro=4, Anemo=5, Geo=6, Dendro=7, OMNI=8.
    const neededElements = new Set<number>();
    for (const ch of self.character) {
      if (!ch.defeated) {
        // Character definition IDs encode element in the hundreds digit: 1xyz → x=element.
        const elementDigit = Math.floor((ch.definitionId % 1000) / 100);
        if (elementDigit >= 1 && elementDigit <= 7) {
          neededElements.add(elementDigit);
        }
      }
    }

    // Reroll dice that do NOT match any alive character's element.
    // OMNI dice (8) and unspecified dice (0) are always kept.
    return self.dice.filter(
      (die) =>
        die !== PbDiceType.OMNI &&
        die !== 0 &&
        !neededElements.has(die),
    );
  }

  private buildDigest(
    actions: Array<{ action: RpcAction; index: number }>,
  ): PolicyTurnDigest {
    return buildPolicyTurnDigest(this.latestNotificationState, this.side, actions);
  }

  /**
   * Heuristic-based active character selection.
   *
   * At game start (all chars full HP, 0 energy):
   *   Relies primarily on openingPriority — summoners first,
   *   then self-buffers, then everything else.
   *
   * Mid-game (post-death replacement):
   *   Adds dice-matching, equipment-in-hand, and kill-potential signals.
   */
  private chooseBestActiveCharacter(candidateIds: readonly number[]): number {
    if (candidateIds.length <= 1) {
      return candidateIds[0] ?? 0
    }
    const state = this.latestNotificationState
    const selfPlayer = state?.player[this.side]
    if (!selfPlayer) {
      return candidateIds[0] ?? 0
    }

    const opponentPlayer = state?.player[this.side === 0 ? 1 : 0]
    const isGameStart = selfPlayer.character.every(
      (c) => !c.defeated && c.health === c.maxHealth && c.energy === 0,
    )

    // ── Mid-game context signals ──
    const selfDice = selfPlayer.dice ?? []
    const selfHandDefIds = new Set(
      (selfPlayer.handCard ?? []).map((c) => c.definitionId),
    )
    // Equipment cards have definition IDs in 21xxxx-28xxxx (talent) and 31xxxx (weapon/artifact)
    const isEquipDefId = (id: number) =>
      (id >= 210000 && id < 290000) || (id >= 310000 && id < 320000)
    const handEquipDefIds = new Set(
      [...selfHandDefIds].filter(isEquipDefId),
    )
    // Talent equipment: definition ID 2X YYYY where YYYY is the character defId 1XYZ
    // → target character = (talentId - 200000) / 10000 → then 1000 + hundreds*100
    // We simplify: a talent 2XCCCC targets character 1XCC (heuristic).
    const handHasTalentFor = (charDefId: number): boolean => {
      // Talent IDs: 21xxyy → targets character 11xx (if same element family)
      // Most talent cards follow: talentId - 100000 = characterId (in same element family)
      for (const equipId of handEquipDefIds) {
        if (equipId >= 210000 && equipId < 290000) {
          // Check element match: talent's hundreds digit vs character's hundreds digit
          const talentElem = Math.floor((equipId % 10000) / 100) || Math.floor((equipId % 1000) / 100)
          const charElem = Math.floor((charDefId % 1000) / 100)
          if (talentElem === charElem) return true
        }
      }
      return false
    }

    // Opponent active character HP
    let oppActiveHp = 999
    if (opponentPlayer) {
      for (const oc of opponentPlayer.character) {
        if (opponentPlayer.activeCharacterId === oc.id) {
          oppActiveHp = oc.health
          break
        }
      }
    }

    let bestId = candidateIds[0] ?? 0
    let bestScore = Number.NEGATIVE_INFINITY

    // Bucket dice counts by element for dice-matching
    const diceCountByElement = new Map<number, number>()
    for (const d of selfDice) {
      if (d > 0 && d < 8) diceCountByElement.set(d, (diceCountByElement.get(d) ?? 0) + 1)
    }

    for (const charId of candidateIds) {
      const ch = selfPlayer.character.find((c) => c.id === charId)
      if (!ch || ch.defeated) continue

      const hpRatio = ch.maxHealth > 0 ? ch.health / ch.maxHealth : 0
      const energyRatio = ch.maxEnergy > 0 ? ch.energy / ch.maxEnergy : 0

      let score = 0

      if (isGameStart) {
        // ── Game start: all chars at full HP/0 energy → use tactical priority ──
        // Base: everyone gets the same baseline
        score = 2.0
        // Character skill profile priority (summoner > self-buff > other)
        if (ch.definitionId) {
          const profile = getCharacterSkillProfile(ch.definitionId)
          if (profile) {
            score += profile.openingPriority * 1.0  // was 0.01 — now meaningful
          }
        }
      } else {
        // ── Mid-game (post-death): use full context ──
        // Energy: closer to burst = better
        score += energyRatio * 3.0
        if (ch.energy >= ch.maxEnergy) score += 2.0

        // HP: healthier = better, but don't penalize too hard
        score += hpRatio * 2.0
        if (hpRatio < 0.3) score -= 1.5

        // Dice matching: prefer character whose element we have dice for
        const charElem = Math.floor((ch.definitionId % 1000) / 100)
        if (charElem >= 1 && charElem <= 7) {
          const matchingDice = diceCountByElement.get(charElem) ?? 0
          score += Math.min(3, matchingDice) * 0.5  // up to +1.5 for 3+ matching dice
        }

        // Equipment in hand: prefer character with matching talent/weapon
        if (handHasTalentFor(ch.definitionId)) {
          score += 1.5
        }

        // Kill potential: prefer character who can finish low-HP opponent
        // (heuristic: if opponent HP ≤ 3 and char has energy ≥1, bonus)
        if (oppActiveHp <= 3 && ch.energy >= 1) {
          score += 1.0
        }
      }

      if (score > bestScore) {
        bestScore = score
        bestId = charId
      }
    }
    return bestId
  }

  private async chooseActionWithSearch(
    validActions: Array<{ action: RpcAction; index: number }>,
    decision: PolicyDecision,
  ): Promise<{ action: RpcAction; index: number } | null> {
    if (
      !this.searchOptions.enabled ||
      !this.searcher ||
      !this.stateProvider ||
      validActions.length < this.searchOptions.minCandidateCount
    ) {
      return null
    }

    const state = this.stateProvider()
    if (state.phase !== "action" || state.currentTurn !== this.side) {
      return null
    }

    // ── ML-guided expansion: feed policy scores into the searcher ──
    const scoreByIndex = new Map<number, number>()
    for (const ranked of decision.ranked) {
      const idx = Number(ranked.candidateId)
      if (Number.isFinite(idx)) {
        scoreByIndex.set(idx, ranked.finalScore)
      }
    }
    // scorer receives the action's index in the *current* legal action list,
    // which matches the original action index when the state is fresh.
    this.searcher?.setExpansionScorer((_action, actionIdx) => {
      return scoreByIndex.get(actionIdx) ?? expansionActionHeuristicScore(_action, actionIdx)
    })

    const searchResults = await this.searcher.search(state, this.searchOptions.topK)
    const chosenIndex = chooseSearchGuidedActionIndex(
      validActions
        .map(({ action, index }) => {
          const comparable = rpcActionToSearchComparable(
            action,
            this.latestNotificationState?.player[this.side],
          )
          return comparable ? { action: comparable, index } : null
        })
        .filter((entry): entry is { action: SearchComparableAction; index: number } => Boolean(entry)),
      decision,
      searchResults,
      this.searchOptions.rerankWeight,
    )
    if (chosenIndex == null) {
      return null
    }
    return validActions.find((entry) => entry.index === chosenIndex) ?? null
  }

  /**
   * Smart mulligan: use learned priors if available, otherwise fall back to cost heuristic.
   * Replaces cards with low keep-winrate or high dice cost.
   */
  private getCardsToMulligan(handDefIds: number[], handEntityIds: number[]): number[] {
    if (handEntityIds.length === 0) return []

    // Extract deck characters from state
    const state = this.latestNotificationState
    const self = state?.player[this.side]
    const charDefIds = (self?.character ?? []).map((c: any) => c.definitionId ?? c.id ?? 0).filter((id: number) => id > 0)
    const deckHash = charDefIds.length > 0 ? [...charDefIds].sort((a, b) => a - b).join(",") : null

    // Try learned priors
    const priors = loadMulliganPriors()
    const deckPriors = deckHash ? priors?.perDeck[deckHash] : undefined

    if (deckPriors) {
      const cardScores: Array<{ entityId: number; defId: number; score: number; keep: boolean }> = []
      const keptDefIds = new Set<number>()

      // Phase 1: keep cards with positive delta from learned priors
      for (let i = 0; i < handDefIds.length; i++) {
        const defId = handDefIds[i]
        const entityId = handEntityIds[i]
        const cs = deckPriors.cards[defId]
        let keep = false
        let score = 0

        if (cs && cs.confident && cs.delta > 0) {
          keep = true
          score = cs.delta
        }

        if (keep) keptDefIds.add(defId)
        cardScores.push({ entityId, defId, score, keep })
      }

      // Phase 2: combo synergy — boost cards paired with already-kept cards
      for (const combo of deckPriors.combos) {
        if (!combo.confident || combo.synergy <= 0) continue
        const [a, b] = combo.cardIds
        if (keptDefIds.has(a) || keptDefIds.has(b)) {
          const targetDefId = keptDefIds.has(a) ? b : a
          const entry = cardScores.find(c => c.defId === targetDefId)
          if (entry && !entry.keep) {
            entry.score += combo.synergy
            if (entry.score > 0) {
              entry.keep = true
              keptDefIds.add(targetDefId)
            }
          }
        }
      }

      const toRemove: number[] = []
      for (const c of cardScores) {
        if (!c.keep) toRemove.push(c.entityId)
      }

      if (toRemove.length > 0) return toRemove
    }

    // Fallback: cost >= 3 heuristic
    const entities = this.gameData?.entities
    if (!entities) return handEntityIds

    const toRemove: number[] = []
    for (let i = 0; i < handDefIds.length; i++) {
      const entityDef = entities.get(handDefIds[i])
      if (!entityDef) continue
      const diceCost = (entityDef.skills[0] as any)?.computed$diceCostSize ?? 0
      if (diceCost >= 3) {
        toRemove.push(handEntityIds[i])
      }
    }
    return toRemove
  }
}

type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number];

export function chooseSearchGuidedActionIndex(
  validActions: Array<{ action: SearchComparableAction; index: number }>,
  decision: PolicyDecision,
  searchResults: readonly SearchResult[],
  rerankWeight: number,
): number | null {
  if (validActions.length === 0 || searchResults.length === 0) {
    return null
  }

  const baseScores = new Map<number, number>()
  for (const ranked of decision.ranked) {
    const index = Number(ranked.candidateId)
    if (Number.isFinite(index)) {
      baseScores.set(index, ranked.finalScore)
    }
  }

  const finiteScores = searchResults
    .map((result) => result.score)
    .filter((score) => Number.isFinite(score))
  const maxScore = finiteScores.length > 0 ? Math.max(...finiteScores) : 0
  const minScore = finiteScores.length > 0 ? Math.min(...finiteScores) : 0
  const searchBonusByIndex = new Map<number, number>()

  for (const result of searchResults) {
    const firstAction = result.path[0]
    if (!firstAction) {
      continue
    }
    const matched = validActions.find(({ action }) =>
      actionMatchesDescription(action, firstAction),
    )
    if (!matched) {
      continue
    }
    const normalized =
      maxScore === minScore
        ? 1
        : (result.score - minScore) / Math.max(1e-6, maxScore - minScore)
    const bonus = normalized * rerankWeight + Math.max(0, result.feasibility - 0.5) * 0.2
    const previous = searchBonusByIndex.get(matched.index) ?? Number.NEGATIVE_INFINITY
    if (bonus > previous) {
      searchBonusByIndex.set(matched.index, bonus)
    }
  }

  if (searchBonusByIndex.size === 0) {
    return null
  }

  let bestIndex: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const { index } of validActions) {
    const total =
      (baseScores.get(index) ?? Number.NEGATIVE_INFINITY) +
      (searchBonusByIndex.get(index) ?? 0)
    if (total > bestScore) {
      bestScore = total
      bestIndex = index
    }
  }
  return bestIndex
}

function actionMatchesDescription(
  action: SearchComparableAction,
  description: SearchResult["path"][number],
): boolean {
  if (action.type !== description.type) {
    return false
  }
  switch (description.type) {
    case "useSkill":
      return action.skill?.definition.id === description.definitionId
    case "playCard":
      return action.skill?.caller?.definition.id === description.definitionId
    case "switchActive":
      return action.to?.definition.id === description.definitionId
    case "elementalTuning":
      return (
        action.card?.definition.id === description.tuningCardDefinitionId &&
        (action.result == null || action.result === description.definitionId)
      )
    case "declareEnd":
      return true
    default:
      return false
  }
}

function rpcActionToSearchComparable(
  action: RpcAction,
  playerState: NonNullable<Notification["state"]>["player"][number] | undefined,
): SearchComparableAction | null {
  const actionCase = action.action?.$case
  switch (actionCase) {
    case "useSkill": {
      const payload = action.action?.$case === "useSkill" ? action.action.value : null
      if (!payload) {
        return null
      }
      return {
        type: "useSkill",
        fast: action.isFast,
        skill: {
          definition: {
            id: payload.skillDefinitionId,
          },
        },
      }
    }
    case "playCard": {
      const payload = action.action?.$case === "playCard" ? action.action.value : null
      if (!payload) {
        return null
      }
      return {
        type: "playCard",
        fast: action.isFast,
        skill: {
          definition: {
            id: payload.cardDefinitionId,
          },
          caller: {
            definition: {
              id: payload.cardDefinitionId,
            },
          },
        },
      }
    }
    case "switchActive": {
      const payload = action.action?.$case === "switchActive" ? action.action.value : null
      if (!payload) {
        return null
      }
      return {
        type: "switchActive",
        fast: action.isFast,
        to: {
          definition: {
            id: payload.characterDefinitionId,
          },
        },
      }
    }
    case "elementalTuning": {
      const payload = action.action?.$case === "elementalTuning" ? action.action.value : null
      if (!payload) {
        return null
      }
      const removedCardDefinitionId =
        playerState?.handCard.find((card) => card.id === payload.removedCardId)
          ?.definitionId ?? 0
      return {
        type: "elementalTuning",
        fast: true,
        card: {
          definition: {
            id: removedCardDefinitionId,
          },
        },
        result: payload.targetDice,
      }
    }
    case "declareEnd":
      return {
        type: "declareEnd",
        fast: false,
      }
    default:
      return null
  }
}

/**
 * 从角色 definition_id 推断元素类型（简化版）。
 * TCG 角色 ID 编码: 1XYZ，其中 X 表示元素系列。
 * 1 = Cryo, 2 = Hydro, 3 = Pyro, 4 = Electro, 5 = Anemo, 6 = Geo, 7 = Dendro
 */
function inferElementFromDefinitionId(definitionId: number): string {
  const elementDigit = Math.floor((definitionId % 1000) / 100)
  switch (elementDigit) {
    case 1: return "cryo"
    case 2: return "hydro"
    case 3: return "pyro"
    case 4: return "electro"
    case 5: return "anemo"
    case 6: return "geo"
    case 7: return "dendro"
    default: return "unknown"
  }
}

// ── SPL helpers ──

/**
 * Build a PlanUpdateInput from the raw notification state for the PlanStateMachine.
 */
function buildPlanUpdateInput(
  notificationState: Notification["state"],
  side: 0 | 1,
): PlanUpdateInput {
  const self = notificationState?.player[side]
  const opponent = notificationState?.player[side === 0 ? 1 : 0]

  const selfChars = (self?.character ?? []).map((ch) => ({
    id: ch.id,
    hp: ch.health,
    maxHp: ch.maxHealth,
    energy: ch.energy,
    maxEnergy: ch.maxEnergy,
    defeated: ch.defeated,
    definitionId: ch.definitionId,
  }))

  const oppChars = (opponent?.character ?? []).map((ch) => ({
    id: ch.id,
    hp: ch.health,
    maxHp: ch.maxHealth,
    energy: ch.energy,
    maxEnergy: ch.maxEnergy,
    defeated: ch.defeated,
    definitionId: ch.definitionId,
  }))

  // Gather summons from self side (EntityState[] with definitionId)
  const summons = (self?.summon ?? []).map((s) => ({ characterId: s.definitionId }))

  // Gather dice
  const dice: Record<string, number> = {}
  for (const d of self?.dice ?? []) {
    const key = String(d)
    dice[key] = (dice[key] ?? 0) + 1
  }

  // Gather hand card IDs
  const handCardIds = (self?.handCard ?? []).map((c) => c.definitionId)

  return {
    round: notificationState?.roundNumber ?? 1,
    selfCharacters: selfChars,
    opponentCharacters: oppChars,
    summons,
    dice,
    handCardIds,
  }
}

/**
 * Filter valid RPC actions by SPL ban list.
 * Returns the filtered list, but never empties it (at least one action is kept).
 */
function filterValidActionsBySPL(
  validActions: Array<{ action: RpcAction; index: number }>,
  notificationState: Notification["state"],
  _side: 0 | 1,
  banList: readonly ActionPattern[],
): Array<{ action: RpcAction; index: number }> {
  if (!banList || banList.length === 0) return validActions

  // Build candidate-like objects for pattern matching
  const filtered = validActions.filter(({ action }) => {
    const candidate = rpcActionToCandidate(action, notificationState)
    if (!candidate) return true  // keep if unknown
    return !matchAnyPattern(banList, candidate)
  })

  // Never empty the candidate set
  return filtered.length > 0 ? filtered : validActions
}

/**
 * Convert an RPC action to a minimal PolicyCandidateAction for pattern matching.
 */
function rpcActionToCandidate(
  action: RpcAction,
  _notificationState: Notification["state"],
): PolicyCandidateAction | null {
  if (!action.action) return null

  const candidate: Record<string, unknown> = {
    action_case: action.action.$case,
  }

  switch (action.action.$case) {
    case "useSkill": {
      const skill = action.action.value
      candidate.target_ids = skill?.targetIds ? [...skill.targetIds] : undefined
      break
    }
    case "switchActive": {
      const sw = action.action.value
      candidate.target_ids = sw?.characterId ? [sw.characterId] : undefined
      break
    }
    case "playCard": {
      const card = action.action.value
      candidate.card_id = card?.cardId
      break
    }
  }

  return candidate as PolicyCandidateAction
}
