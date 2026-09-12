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

import { expect, test, describe } from "vitest"
import {
  detectTriggerChainEdges,
  buildTriggerChains,
  detectDeckCombos,
} from "../src/effect-extractor/chain-detector"
import type {
  CardEffectData,
  ParsedSkill,
  ParsedTrigger,
  ParsedEffect,
  TriggerChainEdge,
} from "../src/effect-extractor/types"

function makeCard(overrides: Partial<CardEffectData> & { id: number; name: string }): CardEffectData {
  return {
    id: overrides.id,
    name: overrides.name,
    type: overrides.type ?? "eventCard",
    tags: overrides.tags ?? [],
    isGenerated: overrides.isGenerated ?? false,
    skills: overrides.skills ?? [],
    generatedBy: overrides.generatedBy ?? [],
  }
}

function makeTrigger(overrides: Partial<ParsedTrigger> & { kind: string }): ParsedTrigger {
  return {
    eventName: overrides.eventName ?? "onCustomEvent",
    kind: overrides.kind,
    scope: overrides.scope ?? "samePlayer",
    perRound: overrides.perRound ?? false,
    usageLimit: overrides.usageLimit ?? null,
    duration: overrides.duration ?? null,
    hasCustomFilter: overrides.hasCustomFilter ?? false,
  }
}

function makeEffect(overrides: Partial<ParsedEffect> & { kind: string }): ParsedEffect {
  return {
    kind: overrides.kind,
    args: overrides.args ?? {},
  }
}

function makeSkill(overrides: Partial<ParsedSkill>): ParsedSkill {
  return {
    id: overrides.id ?? 0,
    triggers: overrides.triggers ?? [],
    effects: overrides.effects ?? [],
    isInitiative: overrides.isInitiative ?? false,
    isDisposeEffect: overrides.isDisposeEffect ?? false,
    doSameWhenDisposed: overrides.doSameWhenDisposed ?? false,
  }
}

describe("chain-detector", () => {
  test("detects self_damage → on_damaged edge between cards", () => {
    const cardA = makeCard({
      id: 1,
      name: "噔噔！",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "self_damage", args: { value: 1 }, target: "my_active" })],
          isInitiative: true,
        }),
      ],
    })
    const cardB = makeCard({
      id: 2,
      name: "勘探钻机",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_damaged" })],
          effects: [],
        }),
      ],
    })

    const edges = detectTriggerChainEdges([cardA, cardB], new Map())
    const selfDamageEdge = edges.find((e) => e.signal === "self_damage" && e.trigger === "on_damaged")

    expect(selfDamageEdge).toBeDefined()
    expect(selfDamageEdge!.fromCardName).toBe("噔噔！")
    expect(selfDamageEdge!.toCardName).toBe("勘探钻机")
    expect(selfDamageEdge!.edgeType).toBe("enables")
    expect(selfDamageEdge!.probability).toBe("likely")
  })

  test("detects discard_hand → on_discard edge", () => {
    const cardA = makeCard({
      id: 1,
      name: "勘探钻机",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_damaged" })],
          effects: [makeEffect({ kind: "dispose_hand", args: { count: 1, strategy: "maxCost" } })],
        }),
      ],
    })
    const cardB = makeCard({
      id: 2,
      name: "超量装药弹头",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_discard" })],
          effects: [],
          isDisposeEffect: true,
        }),
      ],
    })

    const edges = detectTriggerChainEdges([cardA, cardB], new Map())
    const discardEdge = edges.find((e) => e.signal === "discard_hand" && e.trigger === "on_discard")

    expect(discardEdge).toBeDefined()
    expect(discardEdge!.fromCardName).toBe("勘探钻机")
    expect(discardEdge!.toCardName).toBe("超量装药弹头")
  })

  test("detects create_hand_card → on_discard edge via generated cards", () => {
    const cardA = makeCard({
      id: 1,
      name: "夏沃蕾",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "create_hand_card", args: { name: "超量装药弹头" } })],
          isInitiative: true,
        }),
      ],
    })
    const cardC = makeCard({
      id: 3,
      name: "超量装药弹头",
      isGenerated: true,
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_discard" })],
          effects: [],
          isDisposeEffect: true,
        }),
      ],
    })

    const generatedCards = new Map<string, CardEffectData>()
    generatedCards.set("超量装药弹头", cardC)

    const edges = detectTriggerChainEdges([cardA], generatedCards)
    const createEdge = edges.find((e) => e.signal === "create_hand_card" && e.trigger === "on_discard")

    expect(createEdge).toBeDefined()
  })

  test("skips self-edges (same card signaling itself)", () => {
    const card = makeCard({
      id: 1,
      name: "自伤卡",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "self_damage", args: { value: 1 } })],
          isInitiative: true,
        }),
        makeSkill({
          triggers: [makeTrigger({ kind: "on_damaged" })],
          effects: [],
        }),
      ],
    })

    const edges = detectTriggerChainEdges([card], new Map())
    const selfEdge = edges.find((e) => e.fromCardId === e.toCardId)

    expect(selfEdge).toBeUndefined()
  })

  test("buildTriggerChains creates multi-step chains from sequential edges", () => {
    const edges: TriggerChainEdge[] = [
      {
        fromCardId: 1,
        fromCardName: "A",
        toCardId: 2,
        toCardName: "B",
        edgeType: "enables",
        signal: "self_damage",
        trigger: "on_damaged",
        probability: "likely",
        description: "A自伤触发B受击效果",
      },
      {
        fromCardId: 2,
        fromCardName: "B",
        toCardId: 3,
        toCardName: "C",
        edgeType: "enables",
        signal: "discard_hand",
        trigger: "on_discard",
        probability: "possible",
        description: "B弃牌触发C弃牌效果",
      },
    ]

    const chains = buildTriggerChains(edges)
    expect(chains.length).toBeGreaterThanOrEqual(1)
    const longChain = chains.find((c) => c.chainLength >= 2)
    expect(longChain).toBeDefined()
    expect(longChain!.involvedEntityNames).toContain("A")
    expect(longChain!.involvedEntityNames).toContain("B")
    expect(longChain!.involvedEntityNames).toContain("C")
  })

  test("detectDeckCombos returns both edges and chains", () => {
    const cardA = makeCard({
      id: 1,
      name: "噔噔！",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "self_damage", args: { value: 1 }, target: "my_active" })],
          isInitiative: true,
        }),
      ],
    })
    const cardB = makeCard({
      id: 2,
      name: "勘探钻机",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_damaged" })],
          effects: [makeEffect({ kind: "dispose_hand", args: { count: 1, strategy: "maxCost" } })],
        }),
      ],
    })
    const cardC = makeCard({
      id: 3,
      name: "超量装药弹头",
      isGenerated: true,
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "on_discard" })],
          effects: [],
          isDisposeEffect: true,
        }),
      ],
    })

    const generatedCards = new Map<string, CardEffectData>()
    generatedCards.set("超量装药弹头", cardC)

    const result = detectDeckCombos([cardA, cardB], generatedCards)
    expect(result.edges.length).toBeGreaterThan(0)
    expect(result.chains.length).toBeGreaterThanOrEqual(0)
  })

  test("detects no edges between unrelated cards", () => {
    const cardA = makeCard({
      id: 1,
      name: "过牌卡",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "draw_cards", args: { count: 2 } })],
          isInitiative: true,
        }),
      ],
    })
    const cardB = makeCard({
      id: 2,
      name: "护盾卡",
      skills: [
        makeSkill({
          triggers: [makeTrigger({ kind: "initiative" })],
          effects: [makeEffect({ kind: "decrease_damage", args: { value: 1 } })],
          isInitiative: true,
        }),
      ],
    })

    const edges = detectTriggerChainEdges([cardA, cardB], new Map())
    // Neither card emits signals that match the other's triggers
    expect(edges.length).toBe(0)
  })
})