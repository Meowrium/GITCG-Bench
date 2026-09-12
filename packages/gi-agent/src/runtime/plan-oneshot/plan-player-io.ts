// Copyright (C) 2026 Piovium Labs
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

/**
 * PlanPlayerIO — 执行 GamePlanV1 的 PlayerIO（设计文档 §3）。
 *
 * - 只读 notify() 送达的本玩家视角 state，绝不触碰上帝视角 GameState
 *   （不实现 attachGameContext）；
 * - 规则链语义：命中阶段（首个 when 全真的 phase）的 rules 前置到全局
 *   rules 之前，各自按 priority 升序；首条 when 全真且 then 命中 ≥1 合法
 *   候选的规则胜出；多候选按 preview 伤害降序、原 index 升序 tie-break；
 * - 两层组合模式（D1=A，options.single 设置时）：执行链 = Single 层整体前置
 *   + General 层（options.plan），层内维持上述构造与排序；每层独立判定命中
 *   phase；matchedRule/thenMiss 键带层前缀（rule-key.ts）。fallback 与 opening
 *   三节归属 Single（D2）；options.layered（portfolio 批跑恒开）使无 single 的
 *   general-only 路由同样全程带 layer="general" 标注（D6 跨组可归并）；
 *   两者皆无时一切行为与旧单树模式逐字节一致；
 * - 全部未命中 → fallback.policy；任何内部异常 → 兜底 + trace note，
 *   绝不向引擎抛错；
 * - 每个 rpc 决策点写一条 PlanTraceEntry。
 */

import type { GameData, PlayerIO } from "@gi-tcg/core"
import {
  ActionValidity,
  PbDiceType,
  PbPhaseType,
  createRpcResponse,
  type Notification,
  type RpcRequest,
  type RpcResponse,
} from "@gi-tcg/typings"
import { BaselinePolicy } from "../policy/baseline-policy.js"
import type { PolicyLike } from "../io/policy-player-io.js"
import { buildPolicyTurnDigest } from "../policy/candidate-semantics.js"
import type { GamePlanV1 } from "./game-plan-v1.js"
import {
  evaluateWhenAll,
  planStateSignature,
  type PlanFieldContext,
  type PbViewState,
  DICE_TYPE_BY_ELEMENT,
  ELEMENT_NAMES,
  elementOfCharacterDefId,
  type ElementName,
} from "./fields.js"
import {
  buildSkillTypeIndex,
  candidateMatchesSpec,
  candidateTieBreakScore,
  summarizeAction,
  type RpcAction,
  type ActionMatchContext,
} from "./action-match.js"
import { PlanTraceCollector, sigHashOf, type PlanTraceFile, type PlanTraceMeta, type PlanTraceEntry } from "./trace.js"
import { formatRuleKey, type RuleLayer } from "./rule-key.js"
import { combinedChain, type ChainLayerSpec, type ChainScopedRule } from "./rule-chain.js"
import { loadSkillDamageMap, resolveThreatField } from "./threat.js"

export interface PlanPlayerIOOptions {
  side: 0 | 1
  /** General 计划（两层组合模式）或旧单树模式的唯一计划 */
  plan: GamePlanV1
  /**
   * 两层组合模式的 Single 层（batch-runner 按对手 deckCode 路由命中后注入）：
   * 规则链整体前置（D1=A），fallback/opening 三节取自该计划（D2），
   * trace 条目带 layer="single" / layerLabel=label 标注
   */
  single?: { plan: GamePlanV1; label: string }
  /**
   * 层化键模式（任务 0 口径修正）：portfolio 批跑恒开启——即便路由未命中
   * single（general-only），所有条目也带 layer="general" 标注、汇总键带
   * `general:` 前缀，保证同一条 general 规则在各对手组的 D6 跨组计数可归并。
   * 纯旧单树模式（无 portfolio）保持缺省（键无前缀、逐字节不变）；
   * single 在场时本标志冗余（组合链本就全程带层）。
   */
  layered?: boolean
  gameData: GameData
  /** fallback.policy === "baseline" 时注入；缺省则内部 new BaselinePolicy() */
  fallbackBaselinePolicy?: PolicyLike
  /**
   * 对手本局实际牌表（defId → 携带张数，赛前明牌信息）；
   * 缺省时 opp.hand.hasCardP.* 条件恒 undefined
   */
  opponentDeckCards?: ReadonlyMap<number, number>
  trace: PlanTraceMeta
  /**
   * trace 签名模式（默认 "full"）：full = 条目内嵌整份 stateSignature（既有行为，
   * 逐字节不变）；lean = 条目省略整份签名、改带 16 hex 短哈希（sigHash，trace.ts
   * sigHashOf），消费侧经 sig-backfill.ts 从同局 game_state_log.json 反查回填。
   * 锦标赛产物瘦身开关（impl-spec-1 件 1）；缺省路径零变化。
   */
  traceSignatures?: "full" | "lean"
}

type IndexedAction = { action: RpcAction; index: number }

/**
 * [P0-2 未实现，默认关] reroll 前后骰面 / action 落选候选 preview 采集开关。
 * 打开后应：chooseRerollDice 记录 reroll 前后骰面、choosePlanAction 记录落选
 * 候选 preview 摘要（PlanTraceEntry 增 candidatePreview 字段，动作级 preview，
 * 注意与 A 案"计划级 candidates"消歧——整合稿 §3.3）。需求细节见
 * docs/plans/2026-09-05-impl-spec-2-write-side.md §2（件 2）。
 * 本次只落 feature flag 不实现：采集点在 trace 条目内，动了会改 trace 形状，
 * 需与消费方（oracle 对齐、反思语料）同步评审后再开。
 */
export const CAPTURE_REROLL_AND_CANDIDATE_PREVIEW = false as const
// TODO(P0-2): 实现时在 chooseRerollDice / choosePlanAction 的 addTrace 处接入采集，
// 并同步 docs/oracle-free-harness-metrics.md §3.2 的 PlanTraceEntry 字段表。

/** 组合链规则（scope/层标注由 rule-chain.ts 统一构造，与 plan-replay 共用同一排序语义） */
type ScopedRule = ChainScopedRule

export class PlanPlayerIO implements PlayerIO {
  private readonly side: 0 | 1
  private readonly plan: GamePlanV1
  /** 组合模式的 Single 层（null = 旧单树模式） */
  private readonly single: { plan: GamePlanV1; label: string } | null
  /** 层化键模式（options.layered；portfolio 批跑恒 true，见 options 注） */
  private readonly layered: boolean
  private readonly gameData: GameData
  private readonly skillTypeIndex: ReadonlyMap<number, "normal_attack" | "elemental_skill" | "burst">
  private readonly fallbackBaseline: PolicyLike | null
  private readonly opponentDeckCards: ReadonlyMap<number, number> | undefined
  private readonly collector: PlanTraceCollector
  /** lean 签名模式（默认 full）：true = 条目以 sigHash 指针代替整份 stateSignature */
  private readonly leanTrace: boolean

  private latestState: PbViewState | undefined
  private turnKey = ""
  private actionsTakenThisTurn = 0
  private finished: { winner: 0 | 1 | null; rounds: number } | null = null

  constructor(options: PlanPlayerIOOptions) {
    this.side = options.side
    this.plan = options.plan
    this.single = options.single ?? null
    this.layered = options.layered === true
    this.gameData = options.gameData
    this.skillTypeIndex = buildSkillTypeIndex(options.gameData)
    // D2：fallback 归属生效计划（路由命中 Single → Single 的，否则 General 的）
    this.fallbackBaseline = this.effectivePlan().fallback.policy === "baseline"
      ? options.fallbackBaselinePolicy ?? new BaselinePolicy()
      : null
    this.opponentDeckCards = options.opponentDeckCards
    this.collector = new PlanTraceCollector(options.trace)
    this.leanTrace = options.traceSignatures === "lean"
  }

  /** 生效计划（D2）：fallback 与 opening 三节的来源——Single 优先，否则 General（旧单树模式 = 唯一计划） */
  private effectivePlan(): GamePlanV1 {
    return this.single?.plan ?? this.plan
  }

  /** opening 决策点的层标注（组合模式 = single 层；层化 general-only = general 层；旧单树模式不设，键无前缀） */
  private openingLayerTag(): { layer?: RuleLayer; layerLabel?: string } {
    if (this.single !== null) return { layer: "single", layerLabel: this.single.label }
    return this.layered ? { layer: "general" } : {}
  }

  notify(notification: Notification) {
    const state = notification.state
    if (!state) return
    this.latestState = state
    const key = `${state.roundNumber}:${state.currentTurn}`
    if (key !== this.turnKey) {
      this.turnKey = key
      this.actionsTakenThisTurn = 0
    }
    if (state.winner !== undefined || state.phase === PbPhaseType.GAME_END) {
      this.finished = {
        winner: state.winner === undefined ? null : (state.winner as 0 | 1),
        rounds: state.roundNumber,
      }
    }
  }

  /** 当前玩家视角 state 的签名（oracle 对齐用）；无 state 时为 undefined */
  private sig(): string | undefined {
    return this.latestState ? planStateSignature(this.latestState) : undefined
  }

  /** 统一注入 stateSignature 后写入 collector（lean 模式改注 sigHash 指针） */
  private addTrace(entry: Parameters<PlanTraceCollector["add"]>[0]): void {
    if (this.leanTrace) {
      // lean：整份签名压缩为短哈希指针（消费侧经 sig-backfill 从 state log 反查）。
      // 签名照常计算（对齐基准不变），只是不内嵌进条目——省 ~85% trace 字节。
      const sig = this.sig()
      this.collector.add({ ...(sig !== undefined ? { sigHash: sigHashOf(sig) } : {}), ...entry })
      return
    }
    this.collector.add({ stateSignature: this.sig(), ...entry })
  }

  /**
   * 决策时刻的 opp.threat.* 读数快照（仅 action 条目使用）。
   * 铁律沿用：任何异常或无数据都返回 undefined（条目省略该字段），
   * 绝不向引擎抛错；纯查表计算，不影响确定性。
   */
  private threatSnapshot(): PlanTraceEntry["threat"] | undefined {
    try {
      const state = this.latestState
      if (!state) return undefined
      const self = state.player[this.side]
      const opponent = state.player[this.side === 0 ? 1 : 0]
      if (!self || !opponent) return undefined
      const damageMap = loadSkillDamageMap()
      const threat: NonNullable<PlanTraceEntry["threat"]> = {}
      const maxDamage = resolveThreatField("maxDamage", self, opponent, this.gameData, damageMap)
      if (typeof maxDamage === "number") threat.maxDamage = maxDamage
      const lethal = resolveThreatField("lethal", self, opponent, this.gameData, damageMap)
      if (typeof lethal === "boolean") threat.lethal = lethal
      const lethalP = resolveThreatField("lethalP", self, opponent, this.gameData, damageMap)
      if (typeof lethalP === "number") threat.lethalP = lethalP
      const burstReady = resolveThreatField("burstReady", self, opponent, this.gameData, damageMap)
      if (typeof burstReady === "boolean") threat.burstReady = burstReady
      const burstP = resolveThreatField("burstP", self, opponent, this.gameData, damageMap)
      if (typeof burstP === "number") threat.burstP = burstP
      const maxDamageAfterSwitch = resolveThreatField("maxDamageAfterSwitch", self, opponent, this.gameData, damageMap)
      if (typeof maxDamageAfterSwitch === "number") threat.maxDamageAfterSwitch = maxDamageAfterSwitch
      return Object.keys(threat).length > 0 ? threat : undefined
    } catch {
      return undefined
    }
  }

  async rpc(request: RpcRequest): Promise<RpcResponse> {
    const rpc = request.request
    if (!rpc) {
      throw new Error("Missing RPC request envelope")
    }
    switch (rpc.$case) {
      case "action":
        return createRpcResponse("action", await this.choosePlanAction(rpc.value.action))
      case "chooseActive":
        return createRpcResponse("chooseActive", {
          activeCharacterId: this.chooseActiveCharacter(rpc.value.candidateIds),
        })
      case "switchHands":
        return createRpcResponse("switchHands", {
          removedHandIds: this.chooseMulligan(
            rpc.value.handCardDefinitionIds,
            rpc.value.handCardEntityIds,
          ),
        })
      case "rerollDice":
        return createRpcResponse("rerollDice", { diceToReroll: this.chooseRerollDice() })
      case "selectCard":
        return createRpcResponse("selectCard", {
          selectedDefinitionId: this.chooseCard(rpc.value.candidateDefinitionIds),
        })
      default: {
        const _exhaustive: never = rpc
        throw new Error(`Unsupported RPC method: ${String(_exhaustive)}`)
      }
    }
  }

  /** 对局结束后取完整 trace；未结束则 result = "unfinished" */
  getTraceFile(): PlanTraceFile {
    const result = this.finished === null
      ? "unfinished"
      : this.finished.winner === null
        ? "draw"
        : this.finished.winner === this.side ? "win" : "loss"
    return this.collector.finalize(result, this.finished?.rounds ?? this.latestState?.roundNumber ?? 0)
  }

  // ── action ─────────────────────────────────────────────────────────────

  private async choosePlanAction(actions: readonly RpcAction[]): Promise<{
    chosenActionIndex: number
    usedDice: PbDiceType[]
  }> {
    const allActions: IndexedAction[] = actions.map((action, index) => ({ action, index }))
    const validActions = allActions.filter(({ action }) => action.validity === ActionValidity.VALID)
    const method = "action" as const
    if (validActions.length === 0) {
      const fallback = actions[0]
      this.addTrace({
        round: this.latestState?.roundNumber ?? 0,
        turn: this.latestState?.currentTurn ?? 0,
        method,
        phaseId: null,
        candidateCount: 0,
        matchedRule: null,
        fallbackUsed: true,
        fallbackPolicy: "no_valid_action",
        chosen: null,
        threat: this.threatSnapshot(),
      })
      return { chosenActionIndex: 0, usedDice: (fallback?.autoSelectedDice ?? []) as PbDiceType[] }
    }

    try {
      const state = this.requireState()
      // 1-based（含本次决策）；仅在动作真正被消费时提交计数，
      // 避免异常路径计数泄漏导致后续规则看到偏大值
      const actionsSoFar = this.actionsTakenThisTurn + 1
      const matchCtx = this.buildMatchContext(state)

      // 组合链（D1=A）：Single 层整体前置 + General 层；排序语义 = 层主序 +
      // 层内 priority 升序 + 同 priority 保原顺序（rule-chain.ts combinedChain，
      // 与 plan-replay 静态回放共用同一构造，保证键/命中面口径一致）。
      // 每层的"命中 phase"独立判定（各用各计划的 activePhase）；无 single
      // 时退化为单层——layered 开启（portfolio 批跑恒开，任务 0）时该层
      // 带 layer="general"（键带 general: 前缀），否则与旧单树模式逐字节一致。
      const layers: Array<{ plan: GamePlanV1; layer?: RuleLayer; layerLabel?: string }> = this.single
        ? [
            { plan: this.single.plan, layer: "single", layerLabel: this.single.label },
            { plan: this.plan, layer: "general" },
          ]
        : this.layered
          ? [{ plan: this.plan, layer: "general" }]
          : [{ plan: this.plan }]
      // 每层独立判定命中 phase 并构造该层的求值上下文（ctx.phaseId = 该层 activePhase）
      const layerCtxs: PlanFieldContext[] = []
      const specs: ChainLayerSpec[] = layers.map((spec) => {
        const activePhase = this.selectActivePhase(spec.plan, state)
        const layerCtx: PlanFieldContext = {
          state,
          side: this.side,
          phaseId: activePhase?.phaseId ?? null,
          actionsTakenThisTurn: actionsSoFar,
          gameData: this.gameData,
          opponentDeckCards: this.opponentDeckCards,
        }
        layerCtxs.push(layerCtx)
        return {
          plan: spec.plan,
          ...(spec.layer !== undefined ? { layer: spec.layer, layerLabel: spec.layerLabel } : {}),
          activePhase: activePhase?.phaseId ?? null,
        }
      })
      // 组合链构造 + 规则→所属层 ctx 绑定（fallback/未命中条目的 phaseId = 首层 ctx 的 phaseId，现状口径）
      const effectivePhaseId = layerCtxs[0]?.phaseId ?? null
      const ordered: Array<{ rule: ScopedRule; ctx: PlanFieldContext }> = combinedChain(specs)
        .map(({ rule, layerIndex }) => ({ rule, ctx: layerCtxs[layerIndex] }))

      const thenMiss: string[] = []
      for (const { rule, ctx } of ordered) {
        if (!evaluateWhenAll(rule.when, ctx)) continue
        const matches = validActions.filter(({ action }) =>
          candidateMatchesSpec(rule.then, action, matchCtx, this.skillTypeIndex))
        if (matches.length === 0) {
          thenMiss.push(ruleKeyOf(rule))
          continue
        }
        const best = matches
          .map((m) => ({ m, score: candidateTieBreakScore(rule.then, m.action, matchCtx) }))
          .sort((a, b) => b.score - a.score || a.m.index - b.m.index)[0].m
        this.actionsTakenThisTurn = actionsSoFar
        this.addTrace({
          round: state.roundNumber,
          turn: state.currentTurn,
          method,
          // 命中 phase 规则时 = 该规则所属层的 phaseId（旧模式下与现状一致）；
          // 命中 global 规则时 = 该规则所属层的 activePhase
          phaseId: rule.scope === "phase" ? (rule.phaseId ?? null) : ctx.phaseId,
          candidateCount: validActions.length,
          matchedRule: {
            scope: rule.scope,
            priority: rule.priority,
            reason: rule.reason,
            ...(rule.layer !== undefined ? { layer: rule.layer } : {}),
            ...(rule.layerLabel !== undefined ? { layerLabel: rule.layerLabel } : {}),
          },
          fallbackUsed: false,
          chosen: summarizeAction(best.action, matchCtx),
          thenMiss,
          threat: this.threatSnapshot(),
        })
        return { chosenActionIndex: best.index, usedDice: best.action.autoSelectedDice as PbDiceType[] }
      }

      this.actionsTakenThisTurn = actionsSoFar
      return this.applyActionFallback(method, allActions, validActions, effectivePhaseId, [], thenMiss)
    } catch (e) {
      return this.applyActionFallback(method, allActions, validActions, null, [
        `exception: ${e instanceof Error ? e.message : String(e)}`,
      ])
    }
  }

  private applyActionFallback(
    method: "action",
    allActions: IndexedAction[],
    validActions: IndexedAction[],
    phaseId: string | null,
    notes: string[],
    thenMiss: string[] = [],
  ): { chosenActionIndex: number; usedDice: PbDiceType[] } {
    const policy = this.effectivePlan().fallback.policy
    let selected: IndexedAction | undefined
    if (policy === "declare_end" || policy === "conservative") {
      selected = validActions.find(({ action }) => action.action?.$case === "declareEnd")
    }
    if (!selected && policy === "conservative") {
      selected = [...validActions].sort(
        (a, b) => costOf(a.action) - costOf(b.action) || a.index - b.index,
      )[0]
    }
    if (!selected && policy === "baseline" && this.latestState) {
      selected = this.applyBaselineFallback(allActions, validActions)
    }
    selected ??= validActions[0]

    this.addTrace({
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method,
      phaseId,
      candidateCount: validActions.length,
      matchedRule: null,
      fallbackUsed: true,
      fallbackPolicy: policy,
      chosen: this.latestState ? summarizeAction(selected.action, this.buildMatchContext(this.latestState)) : null,
      notes,
      thenMiss,
      threat: this.threatSnapshot(),
    })
    return {
      chosenActionIndex: selected.index,
      usedDice: selected.action.autoSelectedDice as PbDiceType[],
    }
  }

  private applyBaselineFallback(
    allActions: IndexedAction[],
    validActions: IndexedAction[],
  ): IndexedAction | undefined {
    if (!this.fallbackBaseline || !this.latestState) return undefined
    try {
      const digest = buildPolicyTurnDigest(this.latestState, this.side, allActions)
      const decision = this.fallbackBaseline.choose(digest)
      return validActions.find(({ index }) => String(index) === decision.selectedCandidateId)
        ?? undefined
    } catch {
      return undefined
    }
  }

  // ── chooseActive / switchHands / rerollDice / selectCard ──────────────

  private chooseActiveCharacter(candidateIds: readonly number[]): number {
    const method = "chooseActive" as const
    try {
      const state = this.latestState
      if (state && candidateIds.length > 1) {
        const ctx = this.fieldContext(state)
        const self = state.player[this.side]
        for (const rule of this.effectivePlan().opening.chooseActive) {
          if (!evaluateWhenAll(rule.when, ctx)) continue
          const target = self?.character.find(
            (c) => c.definitionId === rule.characterDefId && candidateIds.includes(c.id),
          )
          if (target) {
            this.addTrace({
              round: state.roundNumber, turn: state.currentTurn, method,
              phaseId: null, candidateCount: candidateIds.length,
              matchedRule: { scope: "opening", priority: 0, reason: rule.reason, ...this.openingLayerTag() },
              fallbackUsed: false,
              chosen: { actionCase: "switchActive", targetDefId: rule.characterDefId },
            })
            return target.id
          }
        }
      }
    } catch (e) {
      this.collector.add(this.exceptionEntry(method, candidateIds.length, e))
      return candidateIds[0] ?? 0
    }
    // 单候选无决策空间（规则无从评估）：不计 fallback，避免抬高兜底率统计
    const noDecisionSpace = candidateIds.length <= 1
    this.addTrace({
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method,
      phaseId: null,
      candidateCount: candidateIds.length,
      matchedRule: null,
      fallbackUsed: !noDecisionSpace,
      fallbackPolicy: noDecisionSpace ? undefined : "first_candidate",
      chosen: null,
    })
    return candidateIds[0] ?? 0
  }

  private chooseMulligan(
    handDefIds: readonly number[],
    handEntityIds: readonly number[],
  ): number[] {
    const method = "switchHands" as const
    try {
      const rules = this.effectivePlan().opening.mulligan
      if (rules.length > 0 && handDefIds.length === handEntityIds.length) {
        const kept = new Set<number>()
        const tossed = new Set<number>()
        handDefIds.forEach((defId, i) => {
          const entityId = handEntityIds[i]
          const tags = (this.gameData.entities.get(defId)?.tags ?? [])
            .map((t) => String(t).toLowerCase())
          for (const rule of rules) {
            if (rule.keep) {
              const hitDef = rule.keep.cardDefId !== undefined && rule.keep.cardDefId === defId
              const hitTag = rule.keep.cardTag !== undefined && tags.includes(rule.keep.cardTag.toLowerCase())
              if (hitDef || hitTag) kept.add(entityId)
            }
            if (rule.toss) {
              const hitDef = rule.toss.cardDefId !== undefined && rule.toss.cardDefId === defId
              const hitTag = rule.toss.cardTag !== undefined && tags.includes(rule.toss.cardTag.toLowerCase())
              if (hitDef || hitTag) tossed.add(entityId)
            }
          }
        })
        const removed = handEntityIds.filter((id) => tossed.has(id) && !kept.has(id))
        const anyRuleEngaged = removed.length > 0 || kept.size > 0
        this.addTrace({
          round: this.latestState?.roundNumber ?? 0,
          turn: this.latestState?.currentTurn ?? 0,
          method,
          phaseId: null,
          candidateCount: handDefIds.length,
          matchedRule: anyRuleEngaged
            ? { scope: "opening", priority: 0, reason: "mulligan rules applied", ...this.openingLayerTag() }
            : null,
          fallbackUsed: !anyRuleEngaged,
          fallbackPolicy: anyRuleEngaged ? undefined : "keep_all",
          chosen: { actionCase: "switchHands" },
          notes: removed.length > 0 ? [`removed: ${removed.join(",")}`] : [],
        })
        return removed
      }
    } catch (e) {
      this.collector.add(this.exceptionEntry(method, handDefIds.length, e))
      return []
    }
    this.addTrace({
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method,
      phaseId: null,
      candidateCount: handDefIds.length,
      matchedRule: null,
      fallbackUsed: true,
      fallbackPolicy: "keep_all",
      chosen: null,
    })
    return []
  }

  private chooseRerollDice(): PbDiceType[] {
    const method = "rerollDice" as const
    try {
      const state = this.latestState
      const dice = (state?.player[this.side]?.dice ?? []) as PbDiceType[]
      if (state && dice.length > 0) {
        const ctx = this.fieldContext(state)
        for (const rule of this.effectivePlan().opening.reroll) {
          if (!evaluateWhenAll(rule.when, ctx)) continue
          const keepTypes = new Set<number>([PbDiceType.UNSPECIFIED, PbDiceType.OMNI])
          for (const el of rule.keepElements) {
            const t = DICE_TYPE_BY_ELEMENT[el as ElementName | "omni"]
            if (t !== undefined) keepTypes.add(t)
          }
          const reroll = dice.filter((d) => !keepTypes.has(d as number))
          let keptCount = dice.length - reroll.length
          const finalReroll = [...reroll]
          // minKeep 不足时按骰序补留
          while (rule.minKeep !== undefined && keptCount < rule.minKeep && finalReroll.length > 0) {
            finalReroll.shift()
            keptCount++
          }
          this.addTrace({
            round: state.roundNumber, turn: state.currentTurn, method,
            phaseId: null, candidateCount: dice.length,
            matchedRule: { scope: "opening", priority: 0, reason: rule.reason, ...this.openingLayerTag() },
            fallbackUsed: false,
            chosen: { actionCase: "rerollDice" },
          })
          return finalReroll
        }
        // 默认策略：保留万能与存活角色元素骰（与 PolicyPlayerIO 相同）
        const needed = new Set<number>()
        for (const ch of state.player[this.side]?.character ?? []) {
          if (ch.defeated) continue
          const el = elementOfCharacterDefId(ch.definitionId)
          if (el) needed.add(DICE_TYPE_BY_ELEMENT[el])
        }
        const reroll = dice.filter(
          (d) => d !== PbDiceType.OMNI && d !== PbDiceType.UNSPECIFIED && !needed.has(d as number),
        )
        this.addTrace({
          round: state.roundNumber, turn: state.currentTurn, method,
          phaseId: null, candidateCount: dice.length,
          matchedRule: null, fallbackUsed: true, fallbackPolicy: "default_reroll",
          chosen: { actionCase: "rerollDice" },
        })
        return reroll
      }
    } catch (e) {
      this.collector.add(this.exceptionEntry(method, 0, e))
      return []
    }
    this.addTrace({
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method,
      phaseId: null,
      candidateCount: 0,
      matchedRule: null,
      fallbackUsed: true,
      fallbackPolicy: "keep_all",
      chosen: null,
    })
    return []
  }

  private chooseCard(candidateDefinitionIds: readonly number[]): number {
    this.addTrace({
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method: "selectCard",
      phaseId: null,
      candidateCount: candidateDefinitionIds.length,
      matchedRule: null,
      fallbackUsed: true,
      fallbackPolicy: "first_candidate",
      chosen: candidateDefinitionIds.length > 0
        ? { actionCase: "selectCard", cardDefId: candidateDefinitionIds[0] }
        : null,
    })
    return candidateDefinitionIds[0] ?? 0
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private requireState(): PbViewState {
    if (!this.latestState) throw new Error("No state received via notify() yet")
    return this.latestState
  }

  private fieldContext(state: PbViewState): PlanFieldContext {
    return {
      state,
      side: this.side,
      phaseId: null,
      actionsTakenThisTurn: this.actionsTakenThisTurn,
      gameData: this.gameData,
      opponentDeckCards: this.opponentDeckCards,
    }
  }

  private selectActivePhase(plan: GamePlanV1, state: PbViewState) {
    // 阶段选取时 phase 字段视为 "none"（阶段 when 不应依赖 phase 自身）
    const ctx = this.fieldContext(state)
    return plan.phases.find((p) => evaluateWhenAll(p.when, ctx)) ?? null
  }

  private buildMatchContext(state: PbViewState): ActionMatchContext {
    const self = state.player[this.side]
    const opponent = state.player[this.side === 0 ? 1 : 0]
    const defIdByEntityId = new Map<number, number>()
    for (const p of [self, opponent]) {
      for (const c of p?.character ?? []) defIdByEntityId.set(c.id, c.definitionId)
    }
    return {
      gameData: this.gameData,
      opponentCharacterIds: new Set((opponent?.character ?? []).map((c) => c.id)),
      opponentActiveId: opponent?.activeCharacterId,
      defIdByEntityId,
    }
  }

  private exceptionEntry(method: PlanTraceEntryMethod, candidateCount: number, e: unknown) {    return {
      round: this.latestState?.roundNumber ?? 0,
      turn: this.latestState?.currentTurn ?? 0,
      method,
      phaseId: null,
      candidateCount,
      matchedRule: null,
      fallbackUsed: true,
      fallbackPolicy: "exception_default",
      chosen: null,
      notes: [`exception: ${e instanceof Error ? e.message : String(e)}`],
    }
  }
}

type PlanTraceEntryMethod = "action" | "chooseActive" | "switchHands" | "rerollDice" | "selectCard"

/** 与 trace perRuleHits / 反思 ruleRef 一致的规则键（组合模式带层前缀；拼键统一走 rule-key.ts） */
function ruleKeyOf(rule: ScopedRule): string {
  return formatRuleKey({
    scope: rule.scope,
    priority: rule.priority,
    phaseId: rule.phaseId ?? null,
    layer: rule.layer,
    layerLabel: rule.layerLabel,
  })
}

function costOf(action: RpcAction): number {
  return action.requiredCost.reduce((s, r) => s + (r.count ?? 0), 0)
}

export { ELEMENT_NAMES }
