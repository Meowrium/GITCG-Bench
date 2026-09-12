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

import { expect, test } from "vitest"
import {
  ActionValidity,
  PbDamageType,
  PbDiceRequirementType,
  PbDiceType,
  PbEntityArea,
  PbEntityType,
  PbEquipmentType,
  type Notification,
  type RpcRequest,
} from "@gi-tcg/typings"
import { buildPolicyTurnDigest } from "../../runtime/policy/candidate-semantics.js"
import {
  BRANCH_EVAL_CANDIDATE_FEATURE_NAMES,
  BRANCH_EVAL_QUERY_FEATURE_NAMES,
  buildBranchEvalCandidateNumericSlots,
  buildBranchEvalQueryNumericSlots,
} from "./report-slots.js"

type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number]

function createState(): NonNullable<Notification["state"]> {
  return {
    phase: 3,
    roundNumber: 1,
    currentTurn: 0,
    winner: undefined,
    player: [
      {
        activeCharacterId: 1001,
        character: [
          {
            id: 1001,
            definitionId: 1101,
            defeated: false,
            entity: [],
            health: 4,
            energy: 1,
            maxHealth: 10,
            maxEnergy: 2,
            aura: 0,
            tags: 0,
            specialEnergyName: undefined,
          },
        ],
        combatStatus: [],
        summon: [],
        support: [],
        dice: [PbDiceType.OMNI, PbDiceType.CRYO, PbDiceType.CRYO],
        pileCard: [],
        handCard: [
          {
            id: 2001,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333015,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [{ type: PbDiceRequirementType.CRYO, count: 2 }],
            tags: 0,
            attachment: [],
          },
          {
            id: 2002,
            type: PbEntityType.SUPPORT,
            definitionId: 321011,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [],
            tags: 0,
            attachment: [],
          },
        ],
        status: 4,
        declaredEnd: false,
        legendUsed: false,
        initiativeSkill: [],
      },
      {
        activeCharacterId: 3001,
        character: [
          {
            id: 3001,
            definitionId: 1201,
            defeated: false,
            entity: [],
            health: 10,
            energy: 0,
            maxHealth: 10,
            maxEnergy: 2,
            aura: 0,
            tags: 0,
            specialEnergyName: undefined,
          },
        ],
        combatStatus: [],
        summon: [],
        support: [],
        dice: [],
        pileCard: [],
        handCard: [],
        status: 4,
        declaredEnd: false,
        legendUsed: false,
        initiativeSkill: [],
      },
    ],
  }
}

function createHealAction(): RpcAction {
  return {
    action: {
      $case: "playCard",
      value: {
        cardId: 2001,
        cardDefinitionId: 333015,
        targetIds: [1001],
        willBeEffectless: false,
      },
    },
    requiredCost: [{ type: PbDiceRequirementType.CRYO, count: 2 }],
    autoSelectedDice: [PbDiceType.CRYO, PbDiceType.OMNI],
    validity: ActionValidity.VALID,
    preview: [
      {
        mutation: {
          $case: "damage",
          value: {
            damageType: PbDamageType.HEAL,
            value: 2,
            targetId: 1001,
            targetDefinitionId: 1101,
            sourceId: 2001,
            sourceDefinitionId: 333015,
            isSkillMainDamage: false,
            reactionType: 0,
            causeDefeated: false,
            oldAura: 0,
            newAura: 0,
            oldHealth: 4,
            newHealth: 6,
            healKind: 1,
          },
        },
      },
    ],
    isFast: true,
  }
}

function createSupportAction(): RpcAction {
  return {
    action: {
      $case: "playCard",
      value: {
        cardId: 2002,
        cardDefinitionId: 321011,
        targetIds: [],
        willBeEffectless: false,
      },
    },
    requiredCost: [],
    autoSelectedDice: [],
    validity: ActionValidity.VALID,
    preview: [
      {
        mutation: {
          $case: "createEntity",
          value: {
            who: 0,
            where: PbEntityArea.SUPPORT,
            entity: {
              id: 5001,
              type: PbEntityType.SUPPORT,
              definitionId: 321011,
              variableValue: undefined,
              variableName: undefined,
              hasUsagePerRound: false,
              hintIcon: undefined,
              hintText: undefined,
              equipment: PbEquipmentType.OTHER,
              descriptionDictionary: {},
              definitionCost: [],
              tags: 0,
              attachment: [],
            },
            masterCharacterId: undefined,
          },
        },
      },
    ],
    isFast: false,
  }
}

test("branch-eval report slots split query and candidate numeric features", () => {
  const digest = buildPolicyTurnDigest(createState(), 0, [
    { action: createHealAction(), index: 0 },
    { action: createSupportAction(), index: 1 },
  ])

  const queryNumericSlots = buildBranchEvalQueryNumericSlots(digest)
  const candidateNumericSlots = buildBranchEvalCandidateNumericSlots(
    digest,
    digest.candidate_actions[0],
  )

  expect(BRANCH_EVAL_QUERY_FEATURE_NAMES).toContain("diceCount")
  expect(BRANCH_EVAL_CANDIDATE_FEATURE_NAMES).toContain("healingEstimate")
  expect(queryNumericSlots).toMatchObject({
    diceCount: 3,
    omniCount: 1,
    cardsInHand: 2,
  })
  expect(candidateNumericSlots).toMatchObject({
    healingEstimate: 2,
    selfHealValue: 2,
    totalCost: 2,
    isEventCard: 1,
    isFastAction: 1,
  })
  expect(queryNumericSlots).not.toHaveProperty("healingEstimate")
  expect(candidateNumericSlots).not.toHaveProperty("diceCount")
})
