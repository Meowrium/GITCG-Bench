// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { describe, expect, it } from "vitest"
import type { Notification } from "@gi-tcg/typings"
import type { Action as RpcAction } from "@gi-tcg/typings"
import { StateExporter } from "./state-exporter.js"
import { STATE_OBSERVATION_SCHEMA_VERSION } from "./state-observation.js"

const fakeNotificationState: NonNullable<Notification["state"]> = {
  phase: 3,
  roundNumber: 4,
  currentTurn: 7,
  player: [
    {
      character: [
        {
          id: 1001,
          definitionId: 1101,
          entity: [],
          defeated: false,
          health: 7,
          maxHealth: 10,
          energy: 1,
          maxEnergy: 3,
          aura: 1,
          tags: 0,
        },
        {
          id: 1002,
          definitionId: 1102,
          entity: [],
          defeated: true,
          health: 0,
          maxHealth: 10,
          energy: 0,
          maxEnergy: 3,
          aura: 0,
          tags: 0,
        },
      ],
      combatStatus: [{ id: 9001, definitionId: 117031, tags: 0 } as any],
      summon: [{ id: 9100, definitionId: 116072, hasUsagePerRound: true } as any],
      support: [],
      dice: [1, 1, 8],
      pileCard: [{ id: 1, definitionId: 311101 } as any],
      handCard: [
        { id: 2, definitionId: 311101 } as any,
        { id: 3, definitionId: 312023 } as any,
      ],
      status: 0,
      declaredEnd: false,
      legendUsed: false,
      initiativeSkill: [],
    },
    {
      character: [
        {
          id: 2001,
          definitionId: 1201,
          entity: [],
          defeated: false,
          health: 5,
          maxHealth: 10,
          energy: 0,
          maxEnergy: 2,
          aura: 0,
          tags: 0,
        },
      ],
      combatStatus: [],
      summon: [],
      support: [],
      dice: [],
      pileCard: [],
      handCard: [{ id: 5, definitionId: 311102 } as any],
      status: 0,
      declaredEnd: true,
      legendUsed: false,
      initiativeSkill: [],
    },
  ],
} as any

const fakeAction = (skillId: number): RpcAction =>
  ({
    action: { $case: "useSkill", value: { skillDefinitionId: skillId, targetIds: [] } },
    preview: [],
    requiredCost: [
      { type: 1, count: 1 },
      { type: 8, count: 1 },
    ],
    autoSelectedDice: [],
    validity: 1,
    isFast: false,
  }) as RpcAction

describe("StateExporter", () => {
  it("hides opponent hand contents but keeps hand_size", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    expect(r.observation.meta.schema_version).toBe(STATE_OBSERVATION_SCHEMA_VERSION)
    expect(r.observation.meta.perspective).toBe(0)
    expect(r.observation.self.hand.length).toBeGreaterThan(0)
    expect(r.observation.opponent.hand).toEqual([])
    expect(r.observation.opponent.hand_size).toBe(1)
  })

  it("marks the first non-defeated character as active", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const chars = r.observation.self.characters
    expect(chars[0].is_active).toBe(true)
    expect(chars[1].is_active).toBe(false)
    expect(chars[1].defeated).toBe(true)
  })

  it("flips perspective: side=1 swaps self/opp meta", () => {
    const r0 = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const r1 = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 1,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    expect(r0.observation.self.declared_end).toBe(false)
    expect(r1.observation.self.declared_end).toBe(true)
    expect(r0.observation.opponent.declared_end).toBe(true)
    expect(r1.observation.opponent.declared_end).toBe(false)
  })

  it("encodes candidate cost histogram correctly", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const a = r.observation.candidate_actions[0]
    expect(a.action_case).toBe("useSkill")
    expect(a.primary_definition_id).toBe(11011)
    expect(a.cost_by_type[1]).toBe(1) // CRYO
    expect(a.cost_by_type[8]).toBe(1) // ALIGNED
    expect(a.cost_total_dice).toBe(2)
    expect(a.cost_energy).toBe(0)
    expect(a.is_fast).toBe(false)
  })

  it("counts dice in 9-bucket histogram", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    expect(r.observation.self.dice_counts).toHaveLength(9)
    expect(r.observation.self.dice_counts[1]).toBe(2) // 2 cryo
    expect(r.observation.self.dice_counts[8]).toBe(1) // 1 omni
  })

  it("returns candidate_id matching engine action index", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [
        { action: fakeAction(11011), index: 5 },
        { action: fakeAction(11012), index: 7 },
      ],
      gameId: "g1",
      sampleIndex: 0,
    })
    const ids = r.observation.candidate_actions.map((a) => a.candidate_id)
    expect(ids).toEqual(["5", "7"])
    expect(r.candidateIndexById.get("5")).toBe(0)
    expect(r.candidateIndexById.get("7")).toBe(1)
  })

  // V31 F4 (P5): risk must be absorbed by V(s), NOT injected as hand-engineered
  // scalars into the encoder input. This guard fails if anyone adds a derived
  // risk feature (collapseDistance / threatScore / damageCapacity / reaction
  // amplifier) to StateObservation, which would re-introduce the "engineered
  // risk channel" the encoder is meant to learn end-to-end.
  it("StateObservation carries no hand-engineered risk scalars (P5)", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const blob = JSON.stringify(r.observation).toLowerCase()
    const forbidden = [
      "collapse",
      "threatscore",
      "threat_score",
      "damagecapacity",
      "damage_capacity",
      "reactionamplifier",
      "reaction_amplifier",
      "gamephaseestimate",
      "game_phase_estimate",
    ]
    for (const key of forbidden) {
      expect(blob.includes(key), `StateObservation must not contain "${key}"`).toBe(false)
    }
  })

  it("schema version is bumped to v4 (V31 F9 CSF)", () => {
    expect(STATE_OBSERVATION_SCHEMA_VERSION).toBe(4)
  })

  it("V31 F6/D7: is_first_player carries the coin-flip signal", () => {
    // firstPlayer=0 with perspective=0 → self is first, opp is not.
    const rSelfFirst = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
      firstPlayer: 0,
    })
    expect(rSelfFirst.observation.self.is_first_player).toBe(true)
    expect(rSelfFirst.observation.opponent.is_first_player).toBe(false)

    // firstPlayer=1 with perspective=0 → self is NOT first, opp is.
    const rOppFirst = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
      firstPlayer: 1,
    })
    expect(rOppFirst.observation.self.is_first_player).toBe(false)
    expect(rOppFirst.observation.opponent.is_first_player).toBe(true)

    // Perspective-symmetric: same firstPlayer, two perspectives swap flags.
    const r0 = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
      firstPlayer: 1,
    })
    const r1 = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 1,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
      firstPlayer: 1,
    })
    expect(r0.observation.self.is_first_player).toBe(r1.observation.opponent.is_first_player)
    expect(r0.observation.opponent.is_first_player).toBe(r1.observation.self.is_first_player)
  })

  // ── V31 F3: P1 decision dimensions ──

  it("exposes active character as tier-0 resource (active_definition_id + element)", () => {
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: fakeAction(11011), index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    // self side active is the first non-defeated character (defId 1101 = cryo → element 1).
    expect(r.observation.self.active_definition_id).toBe(1101)
    expect(r.observation.self.active_element).toBe(1)
    // consistency with characters[].is_active
    const activeChar = r.observation.self.characters.find((c) => c.is_active)
    expect(activeChar?.definition_id).toBe(r.observation.self.active_definition_id)
  })

  it("captures elementalTuning target element (tuning_target)", () => {
    const tuningAction = {
      action: { $case: "elementalTuning", value: { removedCardId: 5, targetDice: 3 } },
      preview: [],
      requiredCost: [],
      autoSelectedDice: [],
      validity: 1,
      isFast: false,
    } as unknown as RpcAction
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: tuningAction, index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const a = r.observation.candidate_actions[0]
    expect(a.action_case).toBe("elementalTuning")
    expect(a.tuning_target).toBe(3) // PYRO DiceType
  })

  it("flags LEGEND-consuming actions (consumes_legend)", () => {
    const legendAction = {
      action: { $case: "playCard", value: { cardId: 9, cardDefinitionId: 332001, targetIds: [], willBeEffectless: false } },
      preview: [],
      requiredCost: [{ type: 10 /* LEGEND */, count: 1 }],
      autoSelectedDice: [],
      validity: 1,
      isFast: false,
    } as unknown as RpcAction
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: legendAction, index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    const a = r.observation.candidate_actions[0]
    expect(a.consumes_legend).toBe(true)
  })

  it("flags switchActive as changes_active", () => {
    const switchAction = {
      action: { $case: "switchActive", value: { characterId: 1002, characterDefinitionId: 1102 } },
      preview: [],
      requiredCost: [],
      autoSelectedDice: [],
      validity: 1,
      isFast: false,
    } as unknown as RpcAction
    const r = StateExporter.export({
      notificationState: fakeNotificationState,
      perspective: 0,
      validActions: [{ action: switchAction, index: 0 }],
      gameId: "g1",
      sampleIndex: 0,
    })
    expect(r.observation.candidate_actions[0].changes_active).toBe(true)
  })
})
