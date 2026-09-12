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

import {
  buildLocalDeckAnalysis,
  buildLocalMatchupAnalysis,
  createDeckContext,
  createMatchupContext,
  type DeckCardInfo,
  type DeckContext,
} from "../heuristics"
import type { ActionCardRawData } from "@gi-tcg/assets-manager"
import actionCardsData from "../../../assets-manager/src/data/action_cards.json"
import type {
  ActionCardFeatureBlock,
  DeckDenseFeatures,
  DeckFeaturesV2,
  DeckGraphEdge,
  DeckGraphNode,
  DeckLabels,
  FeatureDiagnostics,
  MatchupDenseFeatures,
  MatchupFeaturesV2,
  MatchupGraphEdge,
  MatchupGraphNode,
  MatchupLabels,
  SparseFeature,
} from "./types"
import { ACTION_CARD_FUNCTION_TAGS, ACTION_CARD_PACKAGES } from "./vocabulary"
import { DeckFeaturesV2Schema, MatchupFeaturesV2Schema } from "./schemas"

const EXTRACTOR_VERSION = "v2-skeleton.1"
type ActionCardFunctionTag = (typeof ACTION_CARD_FUNCTION_TAGS)[number]
type ActionCardPackageTag = (typeof ACTION_CARD_PACKAGES)[number]
const ACTION_CARD_DATA_BY_ID = new Map<number, ActionCardRawData>(
  (actionCardsData as ActionCardRawData[]).map((card) => [card.id, card]),
)

export async function extractDeckFeaturesV2(deckCode: string): Promise<DeckFeaturesV2> {
  const context = await createDeckContext(deckCode)
  const analysis = buildLocalDeckAnalysis(context)
  const actionCards = extractActionCardFeatureBlock(context)
  const dense = buildDeckDenseFeatures(context, actionCards)
  const sparse = buildDeckSparseFeatures(context, actionCards, analysis.winCondition)
  const labels = buildDeckLabels(context, actionCards, analysis.winCondition)
  const graph = buildDeckGraph(context, actionCards, labels)
  const diagnostics = buildDeckDiagnostics(context, graph)

  return DeckFeaturesV2Schema.parse({
    deckCode,
    version: "v2",
    dense,
    sparse,
    actionCards,
    graph,
    labels,
    diagnostics,
  })
}

export async function extractMatchupFeaturesV2(
  deckA: string,
  deckB: string,
): Promise<MatchupFeaturesV2> {
  const [featuresA, featuresB] = await Promise.all([
    extractDeckFeaturesV2(deckA),
    extractDeckFeaturesV2(deckB),
  ])
  const [contextA, contextB] = await Promise.all([createDeckContext(deckA), createDeckContext(deckB)])
  const matchupContext = createMatchupContext(contextA, contextB)
  const matchupAnalysis = buildLocalMatchupAnalysis(
    matchupContext,
    buildLocalDeckAnalysis(contextA, "Deck A"),
    buildLocalDeckAnalysis(contextB, "Deck B"),
  )

  const dense = buildMatchupDenseFeatures(featuresA, featuresB)
  const sparse = buildMatchupSparseFeatures(featuresA, featuresB, contextA, contextB)
  const labels = buildMatchupLabels(featuresA, featuresB, matchupAnalysis)
  const graph = buildMatchupGraph(featuresA, featuresB, labels)
  const diagnostics = buildMatchupDiagnostics(featuresA, featuresB, graph, sparse.length)

  return MatchupFeaturesV2Schema.parse({
    deckA,
    deckB,
    version: "v2",
    dense,
    sparse,
    graph,
    labels,
    diagnostics,
  })
}

function extractActionCardFeatureBlock(context: DeckContext): ActionCardFeatureBlock {
  const cards = context.cards
  const frequencies = countNumbers(cards.map((card) => card.id))
  const presence = uniqueCards(cards).map((card) => sparse(`deck.card.${card.id}`, 1))
  const counts = Object.entries(frequencies).map(([id, count]) =>
    sparse(`deck.card_count.${id}`, count),
  )
  const functionCounts = createZeroRecord(ACTION_CARD_FUNCTION_TAGS)
  const packageCounts = createZeroRecord(ACTION_CARD_PACKAGES)
  const dependencyMap = new Map<string, number>()
  const thresholdMap = new Map<string, number>()

  for (const card of uniqueCards(cards)) {
    const rawCard = ACTION_CARD_DATA_BY_ID.get(card.id)
    const cardFunctions = inferActionCardFunctions(card, rawCard)
    for (const tag of cardFunctions) {
      functionCounts[tag] += frequencies[card.id] || 1
    }

    const cardPackages = inferActionCardPackages(cardFunctions, card, rawCard)
    for (const tag of cardPackages) {
      packageCounts[tag] += frequencies[card.id] || 1
    }

    if (card.relatedCharacterId) {
      incrementMap(
        dependencyMap,
        `deck.action.dependency.card_${card.id}__char_${card.relatedCharacterId}`,
      )
    }
    if (card.relatedCharacterTag) {
      incrementMap(
        dependencyMap,
        `deck.action.dependency.card_${card.id}__tag_${normalizeTag(card.relatedCharacterTag)}`,
      )
    }
  }

  if (packageCounts.support_engine_package >= 4) {
    thresholdMap.set("deck.action.threshold.support_engine_online", 1)
  }
  if (packageCounts.fast_start_package >= 3) {
    thresholdMap.set("deck.action.threshold.fast_start_online", 1)
  }
  if (packageCounts.equipment_carry_package + packageCounts.talent_core_package >= 4) {
    thresholdMap.set("deck.action.threshold.carry_package_online", 1)
  }
  if (packageCounts.reaction_enable_package + packageCounts.reaction_payoff_package >= 3) {
    thresholdMap.set("deck.action.threshold.reaction_package_online", 1)
  }

  return {
    presence,
    counts,
    functionTags: Object.entries(functionCounts)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => sparse(`deck.action.function.${key}`, value)),
    packages: Object.entries(packageCounts)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => sparse(`deck.action.package.${key}`, value)),
    dependencies: [...dependencyMap.entries()].map(([key, value]) => sparse(key, value)),
    thresholds: [...thresholdMap.entries()].map(([key, value]) => sparse(key, value)),
    tempoProfile: {
      lowCostStarters: sumByKeys(functionCounts, ["dice_fix", "dice_gain", "fast_swap", "card_draw"]),
      diceFixers: functionCounts.dice_fix + functionCounts.dice_gain,
      burstAmplifiers: functionCounts.burst_amplifier + functionCounts.finisher_setup,
      defensiveTools:
        functionCounts.shield + functionCounts.heal + functionCounts.revive + functionCounts.stall_tool,
      longGameEngines:
        functionCounts.support_engine + functionCounts.hand_engine + functionCounts.card_draw,
    },
  }
}

function buildDeckDenseFeatures(
  context: DeckContext,
  actionCards: ActionCardFeatureBlock,
): DeckDenseFeatures {
  const subtypeCounts = countStrings(context.cards.map((card) => card.subtype))
  const typeCounts = countStrings(context.cards.map((card) => card.type))
  const weaponCounts = countStrings(
    context.characters.map((character) => character.weapon).filter((value): value is string => !!value),
  )
  const nationCounts = countStrings(context.characters.flatMap((character) => character.nations))
  const estimatedCosts = context.cards.map((card) =>
    estimateCardCost(card, ACTION_CARD_DATA_BY_ID.get(card.id)),
  )
  const costCounts = bucketCosts(estimatedCosts)

  return {
    characterCount: context.characters.length,
    elementCounts: context.summary.elementCounts,
    nationCounts,
    weaponCounts,
    actionCardTypeCounts: typeCounts,
    actionCardSubtypeCounts: subtypeCounts,
    costCurve: {
      ...costCounts,
      averageCost:
        estimatedCosts.reduce((sum, cost) => sum + cost, 0) / Math.max(estimatedCosts.length, 1),
    },
    tempoProfile: {
      setupSpeed: normalize(actionCards.tempoProfile.lowCostStarters, 8),
      tempoPush: normalize(
        getActionTagValue(actionCards, "tempo_push") + getActionTagValue(actionCards, "fast_swap"),
        8,
      ),
      longGameValue: normalize(actionCards.tempoProfile.longGameEngines, 10),
      defensiveStability: normalize(actionCards.tempoProfile.defensiveTools, 8),
      finisherDensity: normalize(actionCards.tempoProfile.burstAmplifiers, 6),
    },
    strategyProfile: {
      reactionReliance: normalize(
        getActionTagValue(actionCards, "reaction_enable") +
          getActionTagValue(actionCards, "reaction_payoff"),
        6,
      ),
      supportReliance: normalize(context.summary.supportCount, 12),
      talentReliance: normalize(context.summary.talentCount, 3),
      equipmentReliance: normalize(context.summary.weaponCount + context.summary.artifactCount, 6),
      summonReliance: normalize(
        getActionTagValue(actionCards, "summon_create") +
          getActionTagValue(actionCards, "summon_scale"),
        4,
      ),
      dependencyRisk: normalize(actionCards.dependencies.length + context.summary.talentCount, 8),
    },
  }
}

function buildDeckSparseFeatures(
  context: DeckContext,
  actionCards: ActionCardFeatureBlock,
  winCondition: string,
): SparseFeature[] {
  const result: SparseFeature[] = []
  const sortedCharacterIds = context.characters.map((character) => character.id).sort((left, right) => left - right)

  for (const id of sortedCharacterIds) {
    result.push(sparse(`deck.char.${id}`, 1))
  }
  for (const pair of combinations(sortedCharacterIds, 2)) {
    result.push(sparse(`deck.char_pair.${pair.join("_")}`, 1))
  }
  if (sortedCharacterIds.length === 3) {
    result.push(sparse(`deck.char_trio.${sortedCharacterIds.join("_")}`, 1))
  }

  result.push(...actionCards.presence)
  result.push(...actionCards.counts)
  result.push(...actionCards.functionTags)
  result.push(...actionCards.packages)
  result.push(...actionCards.dependencies)
  result.push(...actionCards.thresholds)

  const routes = inferRouteTags(context, winCondition)
  for (const route of routes) {
    result.push(sparse(`deck.synergy.${route}`, 1))
  }

  if (context.summary.supportCount >= 8) {
    result.push(sparse("deck.dependency.support_core", 1))
  }
  if (context.summary.talentCount >= 2) {
    result.push(sparse("deck.dependency.talent_core", 1))
  }

  return dedupeSparse(result)
}

function buildDeckLabels(
  context: DeckContext,
  actionCards: ActionCardFeatureBlock,
  winCondition: string,
): DeckLabels {
  return {
    archetypes: [
      winCondition.includes("反应") ? "reaction_midrange" : "carry_midrange",
      context.summary.supportCount >= 8 ? "support_engine" : "lean_support",
    ],
    plans: [
      context.summary.talentCount >= 2 ? "invest_carry" : "distributed_pressure",
      actionCards.tempoProfile.longGameEngines >= 4 ? "scale_long_game" : "contest_mid_game",
    ],
    risks: [
      context.summary.talentCount >= 3 ? "high_core_dependency" : "moderate_core_dependency",
      context.summary.supportCount < 6 ? "low_resource_redundancy" : "adequate_resource_redundancy",
    ],
    routes: inferRouteTags(context, winCondition),
    packages: actionCards.packages
      .filter((feature) => feature.value > 0)
      .map((feature) => feature.key.replace("deck.action.package.", "")),
  }
}

function buildDeckGraph(
  context: DeckContext,
  actionCards: ActionCardFeatureBlock,
  labels: DeckLabels,
): {
  nodes: DeckGraphNode[]
  edges: DeckGraphEdge[]
} {
  const nodes: DeckGraphNode[] = []
  const edges: DeckGraphEdge[] = []

  nodes.push({ id: `deck:${context.deckCode}`, type: "plan_phase", label: "deck_root" })

  for (const character of context.characters) {
    nodes.push({
      id: `char:${character.id}`,
      type: "character",
      label: character.name,
      metadata: {
        elements: character.elements,
        nations: character.nations,
        weapon: character.weapon || "none",
      },
    })
    edges.push({
      from: `deck:${context.deckCode}`,
      to: `char:${character.id}`,
      type: "includes",
      weight: 1,
    })
  }

  for (const card of uniqueCards(context.cards)) {
    nodes.push({
      id: `card:${card.id}`,
      type: "action_card",
      label: card.name,
      metadata: {
        subtype: card.subtype,
        kind: card.type,
      },
    })
    edges.push({
      from: `deck:${context.deckCode}`,
      to: `card:${card.id}`,
      type: "includes",
      weight: getCardCopies(context, card.id),
    })
    if (card.relatedCharacterId) {
      edges.push({
        from: `card:${card.id}`,
        to: `char:${card.relatedCharacterId}`,
        type: "requires",
        weight: 1,
      })
    }
  }

  for (const phase of ["early", "mid", "late"] as const) {
    nodes.push({
      id: `phase:${phase}`,
      type: "plan_phase",
      label: phase,
    })
    edges.push({
      from: `deck:${context.deckCode}`,
      to: `phase:${phase}`,
      type: "converts_to",
      weight: 1,
    })
  }

  for (const route of labels.routes) {
    nodes.push({
      id: `route:${route}`,
      type: "reaction_route",
      label: route,
    })
    edges.push({
      from: "phase:mid",
      to: `route:${route}`,
      type: "enables",
      weight: 1,
    })
  }

  for (const pkg of labels.packages) {
    nodes.push({
      id: `package:${pkg}`,
      type: "package",
      label: pkg,
    })
    edges.push({
      from: `deck:${context.deckCode}`,
      to: `package:${pkg}`,
      type: "includes",
      weight: 1,
    })
  }

  for (const feature of actionCards.dependencies) {
    nodes.push({
      id: `dependency:${feature.key}`,
      type: "dependency",
      label: feature.key.replace("deck.action.dependency.", ""),
      weight: feature.value,
    })
    edges.push({
      from: `deck:${context.deckCode}`,
      to: `dependency:${feature.key}`,
      type: "requires",
      weight: feature.value,
    })
  }

  return {
    nodes: dedupeNodes(nodes),
    edges: dedupeEdges(edges),
  }
}

function buildDeckDiagnostics(
  context: DeckContext,
  graph: {
    nodes: DeckGraphNode[]
    edges: DeckGraphEdge[]
  },
): FeatureDiagnostics {
  return {
    extractorVersion: EXTRACTOR_VERSION,
    warnings: [],
    assumptions: [
      "action-card functional tagging is heuristic and based on subtype plus lightweight naming rules",
      "cost curve is estimated rather than derived from raw play cost data",
    ],
    coverage: {
      characterCoverage: context.characters.length === 3 ? 1 : normalize(context.characters.length, 3),
      actionCardCoverage: normalize(context.cards.length, 30),
      graphCoverage: graph.nodes.length > 0 && graph.edges.length > 0 ? 1 : 0.5,
    },
  }
}

function buildMatchupDenseFeatures(
  deckA: DeckFeaturesV2,
  deckB: DeckFeaturesV2,
): MatchupDenseFeatures {
  return {
    setupSpeedDelta: deckA.dense.tempoProfile.setupSpeed - deckB.dense.tempoProfile.setupSpeed,
    longGameValueDelta: deckA.dense.tempoProfile.longGameValue - deckB.dense.tempoProfile.longGameValue,
    supportGreedDelta: deckA.dense.strategyProfile.supportReliance - deckB.dense.strategyProfile.supportReliance,
    defensiveStabilityDelta:
      deckA.dense.tempoProfile.defensiveStability - deckB.dense.tempoProfile.defensiveStability,
    finisherDensityDelta:
      deckA.dense.tempoProfile.finisherDensity - deckB.dense.tempoProfile.finisherDensity,
    punishGreedySetupDelta:
      getActionTagValue(deckA.actionCards, "anti_greedy_setup") -
      getActionTagValue(deckB.actionCards, "anti_greedy_setup"),
    antiSummonDelta:
      getActionTagValue(deckA.actionCards, "anti_summon") -
      getActionTagValue(deckB.actionCards, "anti_summon"),
    antiSupportDelta:
      getActionTagValue(deckA.actionCards, "anti_support") -
      getActionTagValue(deckB.actionCards, "anti_support"),
    routeConflictScore: routeConflictScore(deckA.labels.routes, deckB.labels.routes),
    dependencyPunishScore:
      deckA.dense.strategyProfile.dependencyRisk - deckB.dense.strategyProfile.dependencyRisk,
  }
}

function buildMatchupSparseFeatures(
  deckA: DeckFeaturesV2,
  deckB: DeckFeaturesV2,
  contextA: DeckContext,
  contextB: DeckContext,
): SparseFeature[] {
  const sparseFeatures: SparseFeature[] = []
  sparseFeatures.push(
    sparse(
      `matchup.a_char_trio__b_char_trio.${sortedTrio(contextA)}__${sortedTrio(contextB)}`,
      1,
    ),
  )

  for (const left of topCrossKeys(deckA.actionCards.packages, 4)) {
    for (const right of topCrossKeys(deckB.actionCards.packages, 4)) {
      sparseFeatures.push(sparse(`matchup.a_package__b_package.${left}__${right}`, 1))
    }
  }

  for (const left of deckA.labels.routes) {
    for (const right of deckB.labels.routes) {
      sparseFeatures.push(sparse(`matchup.a_route__b_route.${left}__${right}`, 1))
    }
  }

  for (const left of topCrossKeys(deckA.actionCards.dependencies, 3)) {
    for (const right of topCounterKeys(deckB.actionCards.functionTags, 3)) {
      sparseFeatures.push(sparse(`matchup.a_dependency__b_pressure.${left}__${right}`, 1))
    }
  }

  for (const left of topCrossKeys(deckA.actionCards.presence, 3)) {
    for (const right of topCrossKeys(deckB.actionCards.presence, 3)) {
      sparseFeatures.push(sparse(`matchup.a_card__b_card.${left}__${right}`, 1))
    }
  }

  for (const phase of ["setup", "mid", "finish"] as const) {
    sparseFeatures.push(
      sparse(
        `matchup.a_phase__b_phase.${phase}_${phaseForDeck(deckA)}__${phase}_${phaseForDeck(deckB)}`,
        1,
      ),
    )
  }

  return dedupeSparse(sparseFeatures)
}

function buildMatchupLabels(
  deckA: DeckFeaturesV2,
  deckB: DeckFeaturesV2,
  matchupAnalysis: ReturnType<typeof buildLocalMatchupAnalysis>,
): MatchupLabels {
  return {
    tempoAxes: [
      deckA.dense.tempoProfile.setupSpeed >= deckB.dense.tempoProfile.setupSpeed
        ? "a_faster_setup"
        : "b_faster_setup",
      deckA.dense.tempoProfile.longGameValue >= deckB.dense.tempoProfile.longGameValue
        ? "a_stronger_long_game"
        : "b_stronger_long_game",
    ],
    pressureAxes: [
      matchupAnalysis.advantage.deckA >= 0 ? "a_has_mid_game_pressure" : "b_has_mid_game_pressure",
      deckA.dense.tempoProfile.finisherDensity >= deckB.dense.tempoProfile.finisherDensity
        ? "a_finisher_edge"
        : "b_finisher_edge",
    ],
    routeConflicts: deckA.labels.routes.flatMap((left) =>
      deckB.labels.routes.map((right) => `${left}_vs_${right}`),
    ),
    keyPackages: [
      ...topCrossKeys(deckA.actionCards.packages, 2).map((key) => `a:${key}`),
      ...topCrossKeys(deckB.actionCards.packages, 2).map((key) => `b:${key}`),
    ],
    risks: [
      deckA.dense.strategyProfile.dependencyRisk > deckB.dense.strategyProfile.dependencyRisk
        ? "a_dependency_risk"
        : "b_dependency_risk",
      Math.abs(matchupAnalysis.advantage.deckA) <= 2 ? "close_matchup" : "swingy_matchup",
    ],
  }
}

function buildMatchupGraph(
  deckA: DeckFeaturesV2,
  deckB: DeckFeaturesV2,
  labels: MatchupLabels,
): {
  nodes: MatchupGraphNode[]
  edges: MatchupGraphEdge[]
} {
  const nodes: MatchupGraphNode[] = []
  const edges: MatchupGraphEdge[] = []

  for (const node of deckA.graph.nodes) {
    nodes.push({
      id: `A:${node.id}`,
      type: node.type,
      label: node.label,
      side: "A",
      weight: node.weight,
      metadata: node.metadata,
    })
  }
  for (const node of deckB.graph.nodes) {
    nodes.push({
      id: `B:${node.id}`,
      type: node.type,
      label: node.label,
      side: "B",
      weight: node.weight,
      metadata: node.metadata,
    })
  }

  for (const label of labels.tempoAxes) {
    nodes.push({
      id: `cross:${label}`,
      type: "matchup_axis",
      label,
      side: "cross",
    })
  }

  for (const route of labels.routeConflicts.slice(0, 8)) {
    nodes.push({
      id: `cross:${route}`,
      type: "cross_feature",
      label: route,
      side: "cross",
    })
  }

  for (const edge of deckA.graph.edges) {
    edges.push({
      from: `A:${edge.from}`,
      to: `A:${edge.to}`,
      type: edge.type,
      weight: edge.weight,
      metadata: edge.metadata,
    })
  }
  for (const edge of deckB.graph.edges) {
    edges.push({
      from: `B:${edge.from}`,
      to: `B:${edge.to}`,
      type: edge.type,
      weight: edge.weight,
      metadata: edge.metadata,
    })
  }

  if (labels.tempoAxes.includes("a_faster_setup")) {
    edges.push({
      from: "cross:a_faster_setup",
      to: "B:phase:early",
      type: "outraces",
      weight: 1,
    })
  }
  if (labels.tempoAxes.includes("b_faster_setup")) {
    edges.push({
      from: "cross:b_faster_setup",
      to: "A:phase:early",
      type: "outraces",
      weight: 1,
    })
  }

  for (const route of labels.routeConflicts.slice(0, 6)) {
    const [left, right] = route.split("_vs_")
    edges.push({
      from: `A:route:${left}`,
      to: `B:route:${right}`,
      type: "checks",
      weight: 1,
    })
  }

  return {
    nodes: dedupeMatchupNodes(nodes),
    edges: dedupeMatchupEdges(edges),
  }
}

function buildMatchupDiagnostics(
  deckA: DeckFeaturesV2,
  deckB: DeckFeaturesV2,
  graph: {
    nodes: MatchupGraphNode[]
    edges: MatchupGraphEdge[]
  },
  crossFeatureCount: number,
): FeatureDiagnostics {
  return {
    extractorVersion: EXTRACTOR_VERSION,
    warnings: [],
    assumptions: [
      "matchup sparse layer currently emphasizes package, route, dependency and selected card cross products",
    ],
    coverage: {
      characterCoverage: Math.min(
        deckA.diagnostics.coverage.characterCoverage,
        deckB.diagnostics.coverage.characterCoverage,
      ),
      actionCardCoverage: Math.min(
        deckA.diagnostics.coverage.actionCardCoverage,
        deckB.diagnostics.coverage.actionCardCoverage,
      ),
      graphCoverage: graph.nodes.length > 0 && graph.edges.length > 0 ? 1 : 0.5,
      matchupCrossCoverage: normalize(crossFeatureCount, 32),
    },
  }
}

function inferActionCardFunctions(
  card: DeckCardInfo,
  rawCard?: ActionCardRawData,
): ActionCardFunctionTag[] {
  const tags = new Set<ActionCardFunctionTag>()
  const description = `${rawCard?.description || ""}\n${rawCard?.rawDescription || ""}`
  const playCost = rawCard?.playCost || []
  const totalCost = playCost.reduce((sum, cost) => sum + cost.count, 0)

  if (card.subtype === "天赋") {
    tags.add("talent_enable")
    tags.add("damage_boost")
  }
  if (card.subtype === "武器" || card.subtype === "圣遗物") {
    tags.add("equipment_enable")
    tags.add("damage_boost")
  }
  if (card.subtype === "伙伴" || card.subtype === "场地") {
    tags.add("support_engine")
    tags.add("hand_engine")
  }
  if (card.subtype === "道具") {
    tags.add("dice_fix")
    tags.add("support_engine")
  }
  if (card.subtype === "料理") {
    tags.add("heal")
    tags.add("stall_tool")
  }
  if (card.subtype === "元素共鸣") {
    tags.add("reaction_enable")
    tags.add("dice_fix")
  }
  if (card.subtype === "秘传") {
    tags.add("finisher_setup")
    tags.add("tempo_push")
  }
  if (card.type === "event") {
    tags.add("tempo_push")
  }

  if (description.includes("生成") && description.includes("元素")) {
    tags.add("dice_gain")
  }
  if (description.includes("抓") || description.includes("抽") || description.includes("手牌")) {
    tags.add("card_draw")
  }
  if (description.includes("调和") || description.includes("重投") || description.includes("万能元素")) {
    tags.add("dice_fix")
  }
  if (description.includes("充能") || description.includes("元素能量")) {
    tags.add("energy_gain")
  }
  if (description.includes("少花费") || description.includes("减少") && description.includes("费用")) {
    tags.add("cost_discount")
  }
  if (description.includes("视为") && description.includes("元素骰")) {
    tags.add("cost_conversion")
  }
  if (description.includes("下一次") && description.includes("元素爆发") && description.includes("伤害")) {
    tags.add("burst_amplifier")
  }
  if (description.includes("下一次") && description.includes("普通攻击") && description.includes("伤害")) {
    tags.add("normal_attack_amplifier")
  }
  if (description.includes("护盾") || description.includes("伤害减少")) {
    tags.add("shield")
  }
  if (description.includes("治疗")) {
    tags.add("heal")
  }
  if (description.includes("复苏") || description.includes("复活")) {
    tags.add("revive")
  }
  if (description.includes("切换") && (description.includes("少花费") || description.includes("视为"))) {
    tags.add("fast_swap")
  }
  if (description.includes("切换到场上") || description.includes("切换为出战角色")) {
    tags.add("forced_swap")
  }
  if (description.includes("造成的伤害+") || description.includes("伤害+")) {
    tags.add("damage_boost")
  }
  if (description.includes("召唤")) {
    tags.add("summon_create")
  }
  if (description.includes("支援") && (description.includes("弃置") || description.includes("破坏"))) {
    tags.add("anti_support")
  }
  if (description.includes("召唤物") && (description.includes("减少") || description.includes("移除"))) {
    tags.add("anti_summon")
  }
  if (card.name.includes("共鸣")) {
    tags.add("reaction_payoff")
  }
  if (card.name.includes("终") || card.name.includes("决")) {
    tags.add("burst_amplifier")
    tags.add("finisher_setup")
  }
  if (totalCost === 0 || totalCost === 1) {
    tags.add("tempo_push")
  }
  if (rawCard?.type === "GCG_CARD_ASSIST") {
    tags.add("support_engine")
  }

  return [...tags]
}

function inferActionCardPackages(
  functions: ActionCardFunctionTag[],
  card: DeckCardInfo,
  rawCard?: ActionCardRawData,
): ActionCardPackageTag[] {
  const tags = new Set<ActionCardPackageTag>()

  if (functions.some((tag) => ["dice_fix", "dice_gain", "card_draw"].includes(tag))) {
    tags.add("universal_resource_package")
  }
  if (functions.some((tag) => ["fast_swap", "tempo_push"].includes(tag))) {
    tags.add("fast_start_package")
  }
  if (functions.some((tag) => ["support_engine", "hand_engine"].includes(tag))) {
    tags.add("support_engine_package")
    tags.add("long_game_value_package")
  }
  if (functions.includes("equipment_enable") || card.subtype === "武器" || card.subtype === "圣遗物") {
    tags.add("equipment_carry_package")
  }
  if (functions.includes("talent_enable")) {
    tags.add("talent_core_package")
  }
  if (functions.includes("reaction_enable")) {
    tags.add("reaction_enable_package")
  }
  if (functions.includes("reaction_payoff")) {
    tags.add("reaction_payoff_package")
  }
  if (functions.includes("summon_create")) {
    tags.add("summon_pressure_package")
  }
  if (functions.some((tag) => ["heal", "shield", "stall_tool"].includes(tag))) {
    tags.add("control_stall_package")
  }
  if (functions.some((tag) => ["burst_amplifier", "finisher_setup"].includes(tag))) {
    tags.add("burst_finish_package")
  }
  if (functions.some((tag) => ["anti_summon", "anti_support", "anti_greedy_setup"].includes(tag))) {
    tags.add("anti_tempo_package")
  }
  if ((rawCard?.playCost || []).reduce((sum, cost) => sum + cost.count, 0) <= 1) {
    tags.add("fast_start_package")
  }

  return [...tags]
}

function inferRouteTags(context: DeckContext, winCondition: string): string[] {
  const routes = new Set<string>()
  const elements = Object.keys(context.summary.elementCounts)
  if (elements.length >= 2) routes.add("dual_element")
  if (context.summary.resonanceCount > 0) routes.add("resonance_route")
  if (winCondition.includes("反应")) routes.add("reaction_route")
  if (context.summary.supportCount >= 8) routes.add("resource_route")
  if (context.summary.talentCount >= 2 || context.summary.weaponCount >= 2) routes.add("carry_route")
  return [...routes]
}

function getActionTagValue(block: ActionCardFeatureBlock, tag: string): number {
  return (
    block.functionTags.find((feature) => feature.key === `deck.action.function.${tag}`)?.value || 0
  )
}

function estimateCardCost(card: DeckCardInfo, rawCard?: ActionCardRawData): number {
  if (rawCard?.playCost?.length) {
    return rawCard.playCost.reduce((sum, cost) => sum + cost.count, 0)
  }
  if (card.subtype === "秘传") return 0
  if (card.subtype === "料理" || card.subtype === "元素共鸣") return 1
  if (card.subtype === "伙伴" || card.subtype === "场地") return 2
  if (card.subtype === "天赋") return 2
  if (card.subtype === "武器" || card.subtype === "圣遗物") return 2
  return 1
}

function bucketCosts(costs: number[]) {
  return {
    cost0: costs.filter((cost) => cost === 0).length,
    cost1: costs.filter((cost) => cost === 1).length,
    cost2: costs.filter((cost) => cost === 2).length,
    cost3Plus: costs.filter((cost) => cost >= 3).length,
  }
}

function routeConflictScore(routesA: string[], routesB: string[]): number {
  const intersection = routesA.filter((route) => routesB.includes(route)).length
  return routesA.length + routesB.length - intersection
}

function topCrossKeys(features: SparseFeature[], count: number): string[] {
  return [...features]
    .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key))
    .slice(0, count)
    .map((feature) => feature.key.split(".").at(-1) || feature.key)
}

function topCounterKeys(features: SparseFeature[], count: number): string[] {
  return topCrossKeys(features, count)
}

function phaseForDeck(deck: DeckFeaturesV2): string {
  if (deck.dense.tempoProfile.setupSpeed >= 0.7) return "setup"
  if (deck.dense.tempoProfile.finisherDensity >= 0.5) return "finish"
  return "mid"
}

function sortedTrio(context: DeckContext): string {
  return context.characters
    .map((character) => character.id)
    .sort((left, right) => left - right)
    .join("_")
}

function sparse(key: string, value: number): SparseFeature {
  return { key, value, source: "rule" }
}

function normalize(value: number, max: number): number {
  return Math.max(0, Math.min(1, value / Math.max(max, 1)))
}

function combinations(values: number[], size: number): number[][] {
  if (size === 1) return values.map((value) => [value])
  const result: number[][] = []
  for (let index = 0; index <= values.length - size; index++) {
    const head = values[index]
    if (head === undefined) continue
    for (const tail of combinations(values.slice(index + 1), size - 1)) {
      result.push([head, ...tail])
    }
  }
  return result
}

function uniqueCards(cards: DeckCardInfo[]): DeckCardInfo[] {
  const seen = new Set<number>()
  return cards.filter((card) => {
    if (seen.has(card.id)) return false
    seen.add(card.id)
    return true
  })
}

function getCardCopies(context: DeckContext, id: number): number {
  return context.cards.filter((card) => card.id === id).length
}

function countStrings(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1
    return result
  }, {})
}

function countNumbers(values: number[]): Record<number, number> {
  return values.reduce<Record<number, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1
    return result
  }, {})
}

function createZeroRecord<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1)
}

function sumByKeys(record: Record<string, number>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (record[key] || 0), 0)
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")
}

function dedupeSparse(features: SparseFeature[]): SparseFeature[] {
  const merged = new Map<string, SparseFeature>()
  for (const feature of features) {
    const existing = merged.get(feature.key)
    if (existing) {
      existing.value += feature.value
    } else {
      merged.set(feature.key, { ...feature })
    }
  }
  return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function dedupeNodes(nodes: DeckGraphNode[]): DeckGraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
}

function dedupeEdges(edges: DeckGraphEdge[]): DeckGraphEdge[] {
  const merged = new Map<string, DeckGraphEdge>()
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (!merged.has(key)) {
      merged.set(key, edge)
    }
  }
  return [...merged.values()]
}

function dedupeMatchupNodes(nodes: MatchupGraphNode[]): MatchupGraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
}

function dedupeMatchupEdges(edges: MatchupGraphEdge[]): MatchupGraphEdge[] {
  const merged = new Map<string, MatchupGraphEdge>()
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (!merged.has(key)) {
      merged.set(key, edge)
    }
  }
  return [...merged.values()]
}
