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

/**
 * 启发式分析层：在 deck-context 纯数据基础上，计算 trigger chain、
 * combo clock、zone pressure 等启发式中间产物，并产出 baseline 分析
 * (buildLocalDeckAnalysis / buildLocalMatchupAnalysis)。
 *
 * 这些启发式结果仅供 V2 特征提取 (features/extractor.ts) 和
 * DeckAnalyzer.analyzeDeck (向后兼容) 使用，不再注入 LLM prompt。
 * LLM 分析路径使用 deck-context + prompt-builder 的纯数据 prompt。
 */

import type { AssetsManager } from "@gi-tcg/assets-manager"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { DeckAnalysis, MatchupAnalysis } from "./types"
import {
  createDeckContext as createBaseDeckContext,
  createMatchupContext,
  clamp,
  type DeckContext,
  type MatchupContext,
  type DeckCharacterInfo,
  type DeckCharacterFullInfo,
  type CharacterSkillData,
  type DeckCardInfo,
  type PlayCostData,
} from "./deck-context"
export {
  createDeckContext,
  createMatchupContext,
  clamp,
  type DeckContext,
  type MatchupContext,
  type DeckCharacterInfo,
  type DeckCharacterFullInfo,
  type CharacterSkillData,
  type DeckCardInfo,
  type PlayCostData,
} from "./deck-context"

import {
  type CardEffectData,
  type ParsedSkill,
  type ParsedTrigger,
  type ParsedEffect,
  type InternalEventName,
  type TriggerKind,
  detectDeckCombos,
} from "./effect-extractor"

import {
  detectStateDependencies,
  computeAllEffectiveCosts,
  estimateDrawExpectation,
  estimateComboClock,
  detectResourceCycles,
  analyzeZonePressure,
  computeSkillEfficiency,
} from "./analysis"
import type {
  StateDependencyEdge,
  EffectiveCost,
  DrawEstimate,
  ComboClockResult,
  ResourceCycle,
  ZonePressureReport,
  SkillEfficiency,
} from "./analysis"
import {
  getDslSourcesByIds,
  getCharacterSkillSources,
} from "./dsl-source-extractor"
import { parseEffectFromDslSource } from "./dsl-effect-parser"

// ---------------------------------------------------------------------------
// Rich context (data + heuristic analysis)
// ---------------------------------------------------------------------------

/** Brief representation of a trigger chain edge for inclusion in DeckContext */
export interface ChainEdgeBrief {
  from: string
  to: string
  signal: string
  trigger: string
  edgeType: string
  probability: string
  description: string
}

/** Brief representation of a multi-step trigger chain */
export interface ChainBrief {
  steps: Array<{ card: string; effectKind: string; targetCard?: string; triggerKind?: string }>
  description: string
  involvedCards: string[]
  chainLength: number
}

export interface RichDeckContext extends DeckContext {
  /** Detected trigger chain edges and combos (from effect extraction) */
  triggerChainEdges?: ChainEdgeBrief[]
  /** Detected multi-step trigger chains */
  triggerChains?: ChainBrief[]
  /** P0-1: State dependency edges (counter-based) */
  stateDependencyEdges?: StateDependencyEdge[]
  /** P0-2: Effective costs for all cards */
  effectiveCosts?: Map<string, EffectiveCost>
  /** P0-3: Combo clock estimates */
  comboTimings?: ComboClockResult[]
  /** P1-1: Per-round draw expectation */
  drawEstimate?: DrawEstimate
  /** P1-2: Resource cycles detected */
  resourceCycles?: ResourceCycle[]
  /** P2-1: Support zone pressure analysis */
  zonePressure?: ZonePressureReport
  /** P2-2: Skill efficiency scores */
  skillEfficiency?: SkillEfficiency[]
}

/**
 * 创建 RichDeckContext：在纯数据基础上附加启发式分析层
 * (trigger chains, combo clock, zone pressure 等)。
 * 仅供 V2 特征提取和 DeckAnalyzer 向后兼容使用。
 */
export async function createRichDeckContext(
  deckCode: string,
  manager: AssetsManager = DEFAULT_ASSETS_MANAGER,
): Promise<RichDeckContext> {
  const base = await createBaseDeckContext(deckCode, manager)

  const { triggerChainEdges, triggerChains } = buildTriggerChainInfo(
    base.cards,
    base.characterFullInfo,
    base.entityDescriptions,
    base.generatedHandCardDescriptions,
    base.cardDslSources ?? new Map(),
    base.characterDslSources ?? new Map(),
  )

  const stateDependencyEdges = detectStateDependencies(base.cards, base.characterFullInfo)
  const effectiveCosts = computeAllEffectiveCosts(base.cards)
  const drawEstimate = estimateDrawExpectation(base.cards)
  const comboTimings = estimateComboClock(base.cards, base.characterFullInfo, drawEstimate)
  const resourceCycles = detectResourceCycles(base.cards)
  const zonePressure = analyzeZonePressure(base.cards)
  const skillEfficiency = computeSkillEfficiency(base.characterFullInfo, base.cards)

  return {
    ...base,
    triggerChainEdges,
    triggerChains,
    stateDependencyEdges,
    effectiveCosts,
    comboTimings,
    drawEstimate,
    resourceCycles,
    zonePressure,
    skillEfficiency,
  }
}

// ---------------------------------------------------------------------------
// Local heuristic analysis (baseline for V2 features + DeckAnalyzer compat)
// ---------------------------------------------------------------------------

export function buildLocalDeckAnalysis(context: RichDeckContext, deckName?: string): DeckAnalysis {
  const archetype = inferArchetype(context)
  const strength = scoreDeckStrength(context, archetype)
  const keyCards = inferKeyCards(context)
  const commonLines = inferCommonLines(context, archetype)
  const strengths = inferStrengths(context, archetype)
  const weaknesses = inferWeaknesses(context, archetype)

  return {
    deckCode: context.deckCode,
    deckName,
    characters: context.characterNames,
    strength,
    winCondition: archetype.winCondition,
    gamePlan: {
      earlyGame: archetype.earlyGame,
      midGame: archetype.midGame,
      lateGame: archetype.lateGame,
    },
    keyCards,
    commonLines,
    strengths,
    weaknesses,
    matchupNotes: {
      快攻: archetype.tempoNote,
      资源局: archetype.resourceNote,
    },
  }
}

export function buildLocalMatchupAnalysis(
  context: MatchupContext,
  deckAAnalysis: DeckAnalysis,
  deckBAnalysis: DeckAnalysis,
): MatchupAnalysis {
  const pressureA = matchupPressure(context.deckA)
  const pressureB = matchupPressure(context.deckB)
  const resourceA = matchupResource(context.deckA)
  const resourceB = matchupResource(context.deckB)
  const score = Math.max(
    -10,
    Math.min(
      10,
      Math.round(
        (deckAAnalysis.strength - deckBAnalysis.strength) * 0.8 +
          (pressureA - pressureB) * 3 +
          (resourceA - resourceB) * 2,
      ),
    ),
  )
  const winRateA = clamp(0.5 + score * 0.035, 0.2, 0.8)

  return {
    deckA: context.deckA.deckCode,
    deckB: context.deckB.deckCode,
    advantage: {
      deckA: score,
      deckB: -score,
      reason: buildAdvantageReason(context, score),
    },
    keyInteractions: inferKeyInteractions(context).slice(0, 4),
    strategy: {
      deckAPlaying: buildMatchupPlan(context.deckA, context.deckB, "A"),
      deckBPlaying: buildMatchupPlan(context.deckB, context.deckA, "B"),
    },
    predictedWinRates: {
      deckA: winRateA,
      deckB: 1 - winRateA,
    },
  }
}

// ---------------------------------------------------------------------------
// Archetype inference
// ---------------------------------------------------------------------------

function inferArchetype(context: RichDeckContext) {
  const { summary } = context
  const dominantElements = Object.entries(summary.elementCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([element]) => element)

  const dualElement = dominantElements.slice(0, 2).join("/")
  const hasTalentPackage = summary.talentCount >= 2
  const hasSupportEngine = summary.supportCount >= 8
  const hasReactionPackage = Object.keys(summary.elementCounts).length >= 2 && summary.resonanceCount > 0
  const hasEquipmentPackage = summary.weaponCount + summary.artifactCount >= 4

  // Use zone pressure to detect potential OTK
  const potentialOTK = context.zonePressure
    ? context.zonePressure.expectedDiscards >= 6 && context.zonePressure.discardBeneficiaries.length > 0
    : false
  // Use combo clock for timing
  const fastestComboRound = context.comboTimings
    ? Math.min(...context.comboTimings.map(c => c.earliestTurn))
    : 99
  const isFastCombo = fastestComboRound <= 2

  let winCondition = `${dualElement || "多元素"}角色站场压制`
  let earlyGame = "前期优先完成骰子与站场准备，尽量让核心角色安全启动。"
  let midGame = "中期围绕核心角色连续行动，利用事件与支援牌维持节奏优势。"
  let lateGame = "后期保留关键爆发回合，靠资源差或伤害阈值完成收割。"
  let tempoNote = "面对快攻时要优先保证站场角色血量与切人节奏。"
  let resourceNote = "进入资源局时，这套牌更依赖持续收益和关键牌轮转。"

  if (hasReactionPackage) {
    winCondition = `${dualElement}元素反应滚雪球后完成终结`
    midGame = "中期围绕元素附着与切人衔接打出高质量反应回合。"
  }

  if (hasSupportEngine) {
    earlyGame = "前期先铺设支援体系与过牌/资源点，避免无收益换血。"
    lateGame = "后期依靠累计的手牌与骰子优势压缩对手操作空间。"
    resourceNote = "拖到资源局时通常会因为支援体系更完整而更从容。"
  }

  if (hasTalentPackage || hasEquipmentPackage) {
    winCondition = `${dualElement || "核心"}角色借助装备与天赋形成持续站场输出`
    midGame = "中期集中资源给主 C 角色，利用装备与天赋提高单回合质量。"
    tempoNote = "面对快攻时要尽快把资源集中到主力角色，避免被拆散节奏。"
  }

  // OTK detection: support churn + early combo
  if (potentialOTK && isFastCombo) {
    winCondition = `高速铺场→支援区churn累积→核心牌兑现单回合终结（OTK）`
    earlyGame = "前期极限铺场填充支援区，利用降费牌加速部署。"
    midGame = "中期通过支援区自然到期+主动弃置推进核心计数器，准备爆发回合。"
    lateGame = "" // OTK decks don't have a late game
  }

  return {
    winCondition,
    earlyGame,
    midGame,
    lateGame,
    tempoNote,
    resourceNote,
  }
}

function inferKeyCards(context: RichDeckContext): DeckAnalysis["keyCards"] {
  const characterIds = new Set(context.characters.map((character) => character.id))
  const uniqueCards = [...new Map(context.cards.map((card) => [card.id, card])).values()]

  const comboCards = new Set<string>()
  if (context.triggerChainEdges) {
    for (const edge of context.triggerChainEdges) {
      comboCards.add(edge.from)
      comboCards.add(edge.to)
    }
  }
  if (context.triggerChains) {
    for (const chain of context.triggerChains) {
      for (const name of chain.involvedCards) {
        comboCards.add(name)
      }
    }
  }

  const prioritized = prioritizeCards(uniqueCards, characterIds)

  return prioritized.slice(0, 6).map((card, index) => {
    const comboBonus = comboCards.has(card.name) ? 1 : 0
    return {
      name: card.name,
      importance: clamp(9 - index + comboBonus, 6, 9),
      usage: comboCards.has(card.name) ? `${describeCardUsage(card)}；参与联动组合` : describeCardUsage(card),
    }
  })
}

function inferCommonLines(
  context: RichDeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): DeckAnalysis["commonLines"] {
  const carry = context.characters[0]?.name || "核心角色"

  if (context.triggerChains && context.triggerChains.length > 0) {
    const comboLines: DeckAnalysis["commonLines"] = context.triggerChains
      .slice(0, 4)
      .map((chain) => ({
        sequence: chain.steps.map((s) => {
          const triggerDesc = s.triggerKind ? `触发${triggerKindBriefLabel(s.triggerKind)}` : s.effectKind
          return `${s.card}(${triggerDesc})`
        }),
        description: chain.description,
        winRateImpact: Math.min(0.12 + chain.involvedCards.length * 0.03 + chain.chainLength * 0.02, 0.25),
      }))

    return comboLines
  }

  if (context.triggerChainEdges && context.triggerChainEdges.length > 0) {
    const edgeLines: DeckAnalysis["commonLines"] = context.triggerChainEdges
      .slice(0, 4)
      .map((edge) => ({
        sequence: [edge.from, edge.to],
        description: edge.description,
        winRateImpact: 0.12,
      }))

    const supportCard = context.cards.find((card) => card.type === "support")
    if (supportCard) {
      edgeLines.push({
        sequence: [supportCard.name, `切到${carry}`, "关键回合"],
        description: "先完成资源启动，再把资源集中到主力角色。",
        winRateImpact: 0.12,
      })
    }

    return edgeLines
  }

  const supportCard = context.cards.find((card) => card.type === "support")
  const talentCard = context.cards.find((card) => card.subtype === "天赋")
  const eventCard = context.cards.find((card) => card.type === "event")

  const lines: DeckAnalysis["commonLines"] = [
    {
      sequence: [
        supportCard?.name || "前期支援牌",
        `切到${carry}`,
        talentCard?.name || "关键装备/天赋",
      ],
      description: "先完成资源启动，再把资源集中到主力角色。",
      winRateImpact: 0.12,
    },
    {
      sequence: [
        `${carry}使用技能`,
        eventCard?.name || "功能事件",
        "继续压制或安全切人",
      ],
      description: archetype.midGame,
      winRateImpact: 0.18,
    },
  ]

  if (context.summary.supportCount >= 8) {
    lines.push({
      sequence: ["连续铺支援", "过牌/补骰", `${carry}完成爆发回合`],
      description: "资源体系成型后再进入高收益输出回合。",
      winRateImpact: 0.15,
    })
  }

  return lines
}

function triggerKindBriefLabel(kind: string): string {
  const labels: Record<string, string> = {
    on_damaged: "受击",
    on_damage_dealt: "造伤",
    on_defeated: "击倒",
    on_round_end: "回合末",
    on_round_begin: "回合初",
    on_swap: "切人",
    on_skill_use: "用技",
    on_play_card: "出牌",
    on_discard: "弃牌",
    on_dispose: "弃置",
    on_draw: "抽牌",
    on_reaction: "反应",
    on_damage_increase: "增伤",
    on_damage_decrease: "减伤",
    on_heal: "治疗",
    on_enter: "进场",
    on_generate_dice: "生骰",
    on_battle_begin: "开局",
    initiative: "打出",
  }
  return labels[kind] ?? kind
}

function inferStrengths(
  context: RichDeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): string[] {
  const strengths = [
    "角色元素组合明确，主计划较容易围绕核心角色展开。",
  ]

  if (context.summary.supportCount >= 8) {
    strengths.push("支援牌密度较高，长局中的资源与过牌稳定性更好。")
  }
  if (context.summary.talentCount >= 2) {
    strengths.push("天赋投入较足，核心角色在成型后的上限更高。")
  }
  if (context.summary.resonanceCount > 0) {
    strengths.push("具备元素共鸣组件，能强化队伍整体节奏或伤害效率。")
  }
  if (archetype.winCondition.includes("反应")) {
    strengths.push("中期反应回合威胁较高，容易通过连动形成滚雪球。")
  }

  return strengths.slice(0, 5)
}

function inferWeaknesses(
  context: RichDeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): string[] {
  const weaknesses = [
    "如果前期抽不到关键资源牌，启动节奏会明显放缓。",
  ]

  if (context.summary.supportCount < 6) {
    weaknesses.push("支援密度偏低，拖入长局后续航能力一般。")
  }
  if (context.summary.talentCount >= 3) {
    weaknesses.push("对核心角色依赖较重，主力被限制时回合质量容易下滑。")
  }
  if (!archetype.winCondition.includes("反应")) {
    weaknesses.push("主要依靠站场与单点质量，面对高频切人或控制时容错有限。")
  }
  if (Object.keys(context.summary.elementCounts).length === 3) {
    weaknesses.push("三元素配置对骰子和切人管理要求更高，失误成本偏高。")
  }

  return weaknesses.slice(0, 5)
}

function scoreDeckStrength(context: RichDeckContext, archetype: ReturnType<typeof inferArchetype>): number {
  let score = 5.6
  score += Math.min(context.summary.supportCount, 10) * 0.12
  score += Math.min(context.summary.talentCount, 3) * 0.28
  score += Math.min(context.summary.resonanceCount, 2) * 0.25
  score += Math.min(context.summary.weaponCount + context.summary.artifactCount, 4) * 0.1

  if (archetype.winCondition.includes("反应")) score += 0.35
  if (archetype.winCondition.includes("资源")) score += 0.2

  return clamp(Number(score.toFixed(1)), 4.5, 8.8)
}

function matchupPressure(context: DeckContext): number {
  return clamp(
    context.summary.talentCount * 0.2 +
      context.summary.weaponCount * 0.15 +
      context.summary.resonanceCount * 0.25,
    0,
    2,
  )
}

function matchupResource(context: DeckContext): number {
  return clamp(
    context.summary.supportCount * 0.12 +
      (context.summary.supportSubtypes.伙伴 || 0) * 0.1 +
      (context.summary.supportSubtypes.场地 || 0) * 0.1,
    0,
    2,
  )
}

function inferKeyInteractions(context: MatchupContext): MatchupAnalysis["keyInteractions"] {
  const aKey = context.deckA.cards.slice(0, 2)
  const bKey = context.deckB.cards.slice(0, 2)
  const interactions: MatchupAnalysis["keyInteractions"] = []

  for (let index = 0; index < Math.min(aKey.length, bKey.length); index++) {
    const cardA = aKey[index]
    const cardB = bKey[index]
    if (!cardA || !cardB) {
      continue
    }
    interactions.push({
      cardA: cardA.name,
      cardB: cardB.name,
      impact: `${cardA.subtype}组件与${cardB.subtype}组件的节奏对抗会直接影响中期回合质量。`,
    })
  }

  if (interactions.length === 0) {
    interactions.push({
      cardA: context.deckA.characters[0]?.name || "卡组 A 核心角色",
      cardB: context.deckB.characters[0]?.name || "卡组 B 核心角色",
      impact: "双方核心角色的站场时机与资源保护，会决定谁先进入优势回合。",
    })
  }

  return interactions
}

function buildAdvantageReason(context: MatchupContext, score: number): string {
  if (score >= 3) {
    return `${context.deckA.characters[0]?.name || "卡组 A"} 的资源成型更快，中期更容易先打出优势回合。`
  }
  if (score <= -3) {
    return `${context.deckB.characters[0]?.name || "卡组 B"} 对节奏和资源的掌控更稳定，A 需要更顺的启动。`
  }
  return "双方都有可执行的主计划，胜负更多取决于前中期启动顺序与关键牌命中。"
}

function buildMatchupPlan(self: DeckContext, opponent: DeckContext, label: string): string {
  const selfCarry = self.characters[0]?.name || `卡组 ${label}`
  const opponentCarry = opponent.characters[0]?.name || "对手核心"
  if (self.summary.supportCount >= opponent.summary.supportCount) {
    return `优先稳住前期资源，等支援体系成型后再围绕${selfCarry}打高质量回合，尽量压缩${opponentCarry}的爆发窗口。`
  }
  return `尽量缩短铺垫时间，利用切人与功能牌牵制${opponentCarry}，不要让对手顺利进入资源滚雪球阶段。`
}

function prioritizeCards(cards: DeckCardInfo[], characterIds: Set<number>): DeckCardInfo[] {
  return [...cards].sort((left, right) => scoreCard(right, characterIds) - scoreCard(left, characterIds))
}

function scoreCard(card: DeckCardInfo, characterIds: Set<number>): number {
  let score = 0
  if (card.subtype === "天赋") score += 5
  if (card.subtype === "元素共鸣") score += 4
  if (card.type === "support") score += 3
  if (card.subtype === "武器" || card.subtype === "圣遗物") score += 2
  if (card.relatedCharacterId && characterIds.has(card.relatedCharacterId)) score += 4
  if (card.relatedCharacterTag) score += 1
  return score
}

function describeCardUsage(card: DeckCardInfo): string {
  switch (card.subtype) {
    case "天赋":
      return "强化对应角色的核心回合，是主计划成型的重要组件。"
    case "元素共鸣":
      return "提升队伍整体节奏或伤害效率，帮助卡组更稳定地执行主计划。"
    case "武器":
    case "圣遗物":
      return "提高主力角色站场质量，增强持续输出或交换效率。"
    case "伙伴":
    case "场地":
    case "道具":
      return "提供持续资源或功能收益，支撑中后期的运营回合。"
    default:
      return "承担补资源、修节奏或衔接连动的功能作用。"
  }
}

// ---------------------------------------------------------------------------
// Trigger chain info (effect extraction from DSL + description fallback)
// ---------------------------------------------------------------------------

/**
 * Build trigger chain information for a deck by extracting effect data
 * from card descriptions and detecting combos.
 */
function buildTriggerChainInfo(
  cards: DeckCardInfo[],
  characterFullInfo: DeckCharacterFullInfo[],
  entityDescriptions: Map<string, string>,
  generatedHandCardDescriptions: Map<string, string>,
  cardDslSources: Map<number, string>,
  characterDslSources: Map<number, string[]>,
): {
  triggerChainEdges: ChainEdgeBrief[]
  triggerChains: ChainBrief[]
} {
  const allCardEffects: CardEffectData[] = []

  for (const card of cards) {
    // 优先用 DSL 源码提取（精确），回退到描述文本正则
    const dslSrc = cardDslSources.get(card.id)
    let effectData: CardEffectData | null = null
    if (dslSrc) {
      effectData = parseEffectFromDslSource(
        dslSrc, card.id, card.name,
        card.type === "event" ? "eventCard" : card.type === "support" ? "support" : "equipment",
        card.meaningfulTags,
      )
    }
    if (!effectData) {
      effectData = extractEffectFromCardDescription(card, entityDescriptions, generatedHandCardDescriptions)
    }
    if (effectData) {
      allCardEffects.push(effectData)
    }
  }

  // 角色：优先用 DSL 源码提取技能效果
  for (const ch of characterFullInfo) {
    const charSrcs = characterDslSources.get(ch.id)
    if (charSrcs && charSrcs.length > 0) {
      // 合并角色所有技能的 DSL 源码块为一个 CardEffectData
      const allSkills: ParsedSkill[] = []
      for (const src of charSrcs) {
        const parsed = parseEffectFromDslSource(
          src, 0, ch.name, "status", ch.elements.map(e => e.toLowerCase()),
        )
        if (parsed) allSkills.push(...parsed.skills)
      }
      if (allSkills.length > 0) {
        allCardEffects.push({
          id: ch.id,
          name: ch.name,
          type: "status",
          tags: ch.elements.map(e => e.toLowerCase()),
          isGenerated: false,
          skills: allSkills,
          generatedBy: [],
        })
        continue // DSL 提取成功，跳过描述文本
      }
    }
    // 回退到描述文本
    for (const skill of ch.skills) {
      const passiveEffects = extractEffectFromSkillDescription(ch, skill)
      if (passiveEffects.length > 0) {
        const charEffect: CardEffectData = {
          id: ch.id,
          name: ch.name,
          type: "status",
          tags: ch.elements.map(e => e.toLowerCase()),
          isGenerated: false,
          skills: passiveEffects,
          generatedBy: [],
        }
        allCardEffects.push(charEffect)
      }
    }
  }

  const generatedCards = new Map<string, CardEffectData>()
  for (const [name, desc] of generatedHandCardDescriptions) {
    const genEffect = extractEffectFromGeneratedCardDescription(name, desc)
    if (genEffect) {
      generatedCards.set(name, genEffect)
    }
  }

  const { edges, chains } = detectDeckCombos(allCardEffects, generatedCards)

  const triggerChainEdges: ChainEdgeBrief[] = edges.map((e) => ({
    from: e.fromCardName,
    to: e.toCardName,
    signal: e.signal,
    trigger: e.trigger,
    edgeType: e.edgeType,
    probability: e.probability,
    description: e.description,
  }))

  const triggerChains: ChainBrief[] = chains.map((c) => ({
    steps: c.steps.map((s) => ({
      card: s.cardName,
      effectKind: s.effectKind,
      targetCard: s.targetCardId != null ? String(s.targetCardId) : undefined,
      triggerKind: s.triggerKind,
    })),
    description: c.description,
    involvedCards: c.involvedEntityNames,
    chainLength: c.chainLength,
  }))

  return { triggerChainEdges, triggerChains }
}

/**
 * Extract CardEffectData from a deck card's description text.
 * This is the description-based fallback when AST data is not available.
 */
function extractEffectFromCardDescription(
  card: DeckCardInfo,
  entityDescriptions: Map<string, string>,
  generatedHandCardDescriptions: Map<string, string>,
): CardEffectData | null {
  const skills: ParsedSkill[] = []
  const desc = card.description || ""
  const playingDesc = card.playingDescription || ""
  const fullText = `${desc}\n${playingDesc}`

  // Parse triggers from description text
  const triggerPatterns: Array<{ pattern: RegExp; kind: TriggerKind; eventName: InternalEventName; scope?: import("./effect-extractor/types").TriggerScope }> = [
    { pattern: /受到伤害时|受到伤害后/g, kind: "on_damaged", eventName: "modifyDamage3" },
    { pattern: /受到伤害或治疗后/g, kind: "on_damaged", eventName: "onDamageOrHeal" },
    { pattern: /被击倒后/g, kind: "on_defeated", eventName: "onDamageOrHeal" },
    { pattern: /回合结束时|结束阶段时|结束阶段：/g, kind: "on_round_end", eventName: "onRoundEnd" },
    { pattern: /回合开始时|行动阶段开始时/g, kind: "on_round_begin", eventName: "onRoundBegin" },
    { pattern: /切换角色后|切换到.*后/g, kind: "on_swap", eventName: "onSwitchActive" },
    { pattern: /被舍弃时|舍弃时/g, kind: "on_discard", eventName: "onDispose" },
    { pattern: /造成伤害时/g, kind: "on_damage_dealt", eventName: "modifyDamage1" },
    { pattern: /引发.*反应.*后|受到超载反应伤害后|反应伤害后/g, kind: "on_reaction", eventName: "onReaction" },
    { pattern: /出战角色造成伤害|使用技能后/g, kind: "on_skill_use", eventName: "onUseSkill" },
    { pattern: /战斗开始时/g, kind: "on_battle_begin", eventName: "onBattleBegin" },
    { pattern: /每回合\d*次/g, kind: "on_damaged", eventName: "modifyDamage3" },
    { pattern: /此牌被舍弃时/g, kind: "on_discard", eventName: "onDispose" },
    { pattern: /受到治疗时|治疗后/g, kind: "on_heal", eventName: "onDamageOrHeal" },
    { pattern: /打出.*后|打出噬骸能量块后/g, kind: "on_play_card", eventName: "onPlayCard" },
    { pattern: /入场时/g, kind: "on_enter", eventName: "onEnter" },
    { pattern: /抓牌后|抓\d+张牌后/g, kind: "on_draw", eventName: "onHandCardInserted" },
    { pattern: /生成骰子后|生成.*元素骰后/g, kind: "on_generate_dice", eventName: "onGenerateDice" },
  ]

  for (const { pattern, kind, eventName, scope } of triggerPatterns) {
    const matches = fullText.matchAll(pattern)
    for (const match of matches) {
      const triggerScope: import("./effect-extractor/types").TriggerScope = scope ?? (["on_play_card", "on_draw", "on_generate_dice", "on_discard", "on_swap", "on_round_begin", "on_round_end", "on_battle_begin", "on_end_phase", "on_action_phase"].includes(kind) ? "samePlayer" : "sameArea")
      skills.push({
        id: 0,
        triggers: [{
          eventName,
          kind,
          scope: triggerScope,
          perRound: /每回合/.test(match[0]),
          usageLimit: null,
          duration: null,
          hasCustomFilter: true,
          filterDescription: match[0],
        }],
        effects: [],
        isInitiative: false,
        isDisposeEffect: kind === "on_discard",
        doSameWhenDisposed: false,
      })
    }
  }

  // Parse effects from description text
  const effects: ParsedEffect[] = []

  if (/对我方.*造成\d+点/.test(fullText)) {
    const dmgMatch = fullText.match(/对我方.{0,10}造成(\d+)点(.{0,4})伤害/)
    if (dmgMatch) {
      effects.push({
        kind: "self_damage",
        args: { value: parseInt(dmgMatch[1], 10) },
        damageType: dmgMatch[2]?.includes("物理") ? "Physical" as DamageTypeSpecifier
          : dmgMatch[2]?.includes("火") ? "Pyro" as DamageTypeSpecifier
          : dmgMatch[2]?.includes("雷") ? "Electro" as DamageTypeSpecifier
          : undefined,
        target: "my_active",
      })
    }
  }

  if (/舍弃\d+张/.test(fullText)) {
    const discardMatch = fullText.match(/舍弃(\d+)张/)
    if (discardMatch) {
      effects.push({
        kind: "dispose_hand",
        args: { count: parseInt(discardMatch[1], 10) },
      })
    }
  }

  if (/舍弃1张当前元素骰费用最高的手牌/.test(fullText)) {
    effects.push({
      kind: "dispose_hand",
      args: { count: 1, strategy: "maxCost" },
    })
  }

  if (/生成\d+张.{1,20}(?:置入|加入).{0,4}手牌/.test(fullText) || /生成手牌/.test(fullText)) {
    const handCardMatch = fullText.match(/生成\d+张(.{1,20}?)(?:，|。|置入|加入)/) ?? fullText.match(/生成手牌([^\s，。、]+)/)
    if (handCardMatch) {
      effects.push({
        kind: "create_hand_card",
        args: { name: handCardMatch[1].trim() },
        target: "self",
      })
    }
  }

  if (/生成\d+个?万能元素/.test(fullText)) {
    const diceMatch = fullText.match(/生成(\d+)个?万能元素/)
    if (diceMatch) {
      effects.push({
        kind: "generate_dice",
        args: { count: parseInt(diceMatch[1], 10), diceType: "Omni" },
      })
    }
  }

  if (/抓\d+张牌/.test(fullText)) {
    const drawMatch = fullText.match(/抓(\d+)张牌/)
    if (drawMatch) {
      effects.push({
        kind: "draw_cards",
        args: { count: parseInt(drawMatch[1], 10) },
      })
    }
  }

  if (/连续行动|再次行动/.test(fullText)) {
    effects.push({ kind: "continue_next_turn", args: {} })
  }

  if (/伤害\+(\d+)/.test(fullText)) {
    const incMatch = fullText.match(/伤害\+(\d+)/)
    if (incMatch) {
      effects.push({
        kind: "increase_damage",
        args: { value: parseInt(incMatch[1], 10) },
      })
    }
  }

  if (/治疗.{0,10}\d+点/.test(fullText) && !effects.some(e => e.kind === "heal")) {
    const healMatch = fullText.match(/治疗.{0,10}(\d+)点/)
    if (healMatch) {
      effects.push({
        kind: "heal",
        args: { value: parseInt(healMatch[1], 10) },
      })
    }
  }

  if (/获得\d+点充能|充能\+\d+/.test(fullText) && !effects.some(e => e.kind === "gain_energy")) {
    const energyMatch = fullText.match(/(?:获得|充能\+)(\d+)点?充能/)
    if (energyMatch) {
      effects.push({
        kind: "gain_energy",
        args: { value: parseInt(energyMatch[1], 10) },
      })
    }
  }

  if (/护盾|提供\d+点护盾/.test(fullText) && !effects.some(e => e.kind === "shield")) {
    const shieldMatch = fullText.match(/(\d+)点护盾/)
    if (shieldMatch) {
      effects.push({
        kind: "shield",
        args: { value: parseInt(shieldMatch[1], 10) },
      })
    } else {
      effects.push({ kind: "shield", args: {} })
    }
  }

  if (/伤害翻倍/.test(fullText) && !effects.some(e => e.kind === "multiply_damage")) {
    effects.push({ kind: "multiply_damage", args: {} })
  }

  if (/附着元素|附着.{1,4}元素/.test(fullText) && !effects.some(e => e.kind === "apply_element")) {
    effects.push({ kind: "apply_element", args: {} })
  }

  if (/伤害-\d+/.test(fullText)) {
    const decMatch = fullText.match(/伤害-(\d+)/)
    if (decMatch) {
      effects.push({
        kind: "decrease_damage",
        args: { value: parseInt(decMatch[1], 10) },
      })
    }
  }

  if (/\[被动\]|被动技能/.test(fullText) || card.type === "equipment") {
    // Equipment and passives should have triggers
  }

  // If we have any triggers or effects, create a CardEffectData
if (effects.length > 0 || skills.length > 0) {
    // For event cards, the primary play effect is the initiative skill
    if (card.type === "event" && effects.length > 0) {
      const playEffects = effects.filter(e =>
        e.kind !== "draw_cards" || !skills.some(s => s.triggers.some(t => t.kind === "on_round_end"))
      )
      const triggerEffects = effects.filter(e =>
        e.kind === "draw_cards" && skills.some(s => s.triggers.some(t => t.kind === "on_round_end"))
      )

      // Assign effects to appropriate skills
      const playSkill: ParsedSkill = {
        id: 0,
        triggers: [{
          eventName: "onPlayCard" as InternalEventName,
          kind: "initiative" as TriggerKind,
          scope: "samePlayer",
          perRound: false,
          usageLimit: null,
          duration: null,
          hasCustomFilter: false,
        }],
        effects: playEffects,
        isInitiative: true,
        isDisposeEffect: false,
        doSameWhenDisposed: false,
      }

      // Add trigger effects to their respective trigger skills
      for (const skill of skills) {
        if (triggerEffects.length > 0 && skill.triggers.some(t => t.kind === "on_round_end")) {
          skill.effects.push(...triggerEffects)
        }
      }

      return {
        id: card.id,
        name: card.name,
        type: "eventCard" as const,
        tags: card.meaningfulTags,
        isGenerated: !card.meaningfulTags.includes("GCG_TAG_NON_DISCOVERABLE"),
        skills: [playSkill, ...skills],
        generatedBy: [],
      }
    }

    // For equipment/support, triggers are the passive effects
    // Attach any remaining effects to the first trigger skill
    if (skills.length > 0 && effects.length > 0) {
      // Distribute effects to the most relevant trigger skill
      for (const effect of effects) {
        // self_damage goes to initiative (not a trigger), others can attach to triggers
        if (effect.kind === "self_damage") {
          // Self-damage is a play effect for event cards, already handled above
          // For equipment, self-damage effects are unusual but possible
          skills[0].effects.push(effect)
        } else {
          // Try to find the best matching trigger skill
          const matchingSkill = skills.find(s =>
            s.triggers.some(t => isEffectTriggerMatch(effect, t))
          )
          if (matchingSkill) {
            matchingSkill.effects.push(effect)
          } else {
            // Default: attach to first trigger skill
            skills[0].effects.push(effect)
          }
        }
      }
    }

return {
      id: card.id,
      name: card.name,
      type: card.type === "event" ? "eventCard" as const : card.type === "support" ? "support" as const : "equipment" as const,
      tags: card.meaningfulTags,
      isGenerated: false,
      skills,
      generatedBy: [],
    }
  }

  return null
}

type DamageTypeSpecifier = import("./effect-extractor/types").DamageTypeSpecifier

function extractEffectFromSkillDescription(
  character: DeckCharacterFullInfo,
  skill: CharacterSkillData,
): ParsedSkill[] {
  if (skill.type !== "被动技能") return []

  const desc = skill.description
  const triggers: ParsedTrigger[] = []
  const effects: ParsedEffect[] = []

  if (/受到超载反应伤害后/.test(desc)) {
    triggers.push({
      eventName: "onReaction" as InternalEventName,
      kind: "on_reaction" as TriggerKind,
      scope: "all",
      perRound: true,
      usageLimit: null,
      duration: null,
      hasCustomFilter: true,
      filterDescription: "超载反应伤害后",
    })
    if (/生成手牌/.test(desc)) {
      const match = desc.match(/生成手牌([^\s，。、]+)/)
      if (match) {
        effects.push({
          kind: "create_hand_card",
          args: { name: match[1] },
        })
      }
    }
  }

  if (/受到伤害后/.test(desc) && !/超载/.test(desc)) {
    triggers.push({
      eventName: "onDamageOrHeal" as InternalEventName,
      kind: "on_damaged" as TriggerKind,
      scope: "sameArea",
      perRound: false,
      usageLimit: null,
      duration: null,
      hasCustomFilter: true,
      filterDescription: "受伤害后",
    })
  }

  if (triggers.length > 0 || effects.length > 0) {
    return [{
      id: 0,
      triggers,
      effects,
      isInitiative: false,
      isDisposeEffect: false,
      doSameWhenDisposed: false,
    }]
  }

  return []
}

function extractEffectFromGeneratedCardDescription(
  name: string,
  desc: string,
): CardEffectData | null {
  const skills: ParsedSkill[] = []

  if (/被舍弃时/.test(desc)) {
    skills.push({
      id: 0,
      triggers: [{
        eventName: "onDispose" as InternalEventName,
        kind: "on_discard" as TriggerKind,
        scope: "samePlayer",
        perRound: false,
        usageLimit: null,
        duration: null,
        hasCustomFilter: true,
        filterDescription: "被舍弃时",
      }],
      effects: [],
      isInitiative: false,
      isDisposeEffect: true,
      doSameWhenDisposed: /此牌/.test(desc) && /被舍弃时/.test(desc) && /造成/.test(desc),
    })
  }

  // Check for play effect
  if (/战斗行动/.test(desc) || /造成\d+点/.test(desc)) {
    const mainEffects: ParsedEffect[] = []
    const dmgMatch = desc.match(/对敌方[^造成]*造成(\d+)点([物火冰水雷风岩草]+)伤害/)
    if (dmgMatch) {
      mainEffects.push({
        kind: "damage",
        args: { value: parseInt(dmgMatch[1], 10) },
        damageType: dmgMatch[2] as DamageTypeSpecifier,
        target: "opp_active",
      })
    }

    if (mainEffects.length > 0) {
      skills.push({
        id: 0,
        triggers: [{
          eventName: "onPlayCard" as InternalEventName,
          kind: "initiative" as TriggerKind,
          scope: "samePlayer",
          perRound: false,
          usageLimit: null,
          duration: null,
          hasCustomFilter: false,
        }],
        effects: mainEffects,
        isInitiative: true,
        isDisposeEffect: false,
        doSameWhenDisposed: false,
      })
    }
  }

  if (skills.length > 0) {
    return {
      id: 0,
      name,
      type: "eventCard" as const,
      tags: ["action"],
      isGenerated: true,
      skills,
      generatedBy: [],
    }
  }

  return null
}

/**
 * Check if an effect kind and trigger kind are semantically related.
 * Used to assign effects to the correct trigger skill.
 */
function isEffectTriggerMatch(
  effect: ParsedEffect,
  trigger: ParsedTrigger,
): boolean {
  const effectToTriggerMap: Record<string, TriggerKind[]> = {
    self_damage: ["on_damaged"],
    damage: ["on_damage_increase", "on_damaged", "on_defeated"],
    generate_dice: ["on_generate_dice"],
    create_hand_card: ["on_discard"],
    draw_cards: ["on_round_end", "on_round_begin"],
    continue_next_turn: ["on_skill_use"],
    switch_active: ["on_swap"],
  }

  const matchingTriggers = effectToTriggerMap[effect.kind]
  if (matchingTriggers) {
    return matchingTriggers.includes(trigger.kind)
  }
  return false
}
