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
  buildRankingDatasetFromBranchEvalReport,
  extractDecisionPointsFromBranchEvalReport,
  type BranchEvalReportLike,
} from "./branch-eval.js"

test("extractDecisionPointsFromBranchEvalReport creates stable query metadata", () => {
  const report: BranchEvalReportLike = {
    matchupId: "ShuiNing-mirror",
    replayDir: "./replays",
    featureVersion: "gi-agent.feature-extractor.v1",
    candidateFeatureNames: ["healingEstimate", "isFastAction"],
    queryFeatureNames: ["diceCount", "cardsInHand"],
    points: [
      {
        replayFile: "D:/replays/game-0001-p0.json",
        replayEntryIndex: 7,
        replayNextStateIndex: 8,
        actor: 0,
        round: 2,
        legalActionCount: 3,
        replayActionIndex: 0,
        replayActionType: "useSkill",
        replayActionDefinitionKind: "skill",
        replayActionDefinitionId: 2102,
        replayActionSkillDefinitionId: 2102,
        replayActionCardDefinitionId: null,
        replayActionCharacterDefinitionId: null,
        replayActorCharacterDefinitionId: 1411,
        replayActionTags: ["useSkill", "reaction"],
        selfActiveCharacterDefinitionId: 1411,
        oppActiveCharacterDefinitionId: 2304,
        queryNumericSlots: {
          diceCount: 7,
          cardsInHand: 3,
        },
        policySelectedActionIndex: 1,
        policySelectedActionType: "playCard",
        branches: [
          {
            actionIndex: 0,
            actionType: "useSkill",
            actionDefinitionKind: "skill",
            definitionId: 2102,
            skillDefinitionId: 2102,
            actorCharacterDefinitionId: 1411,
            candidateTags: ["reaction"],
            candidateNumericSlots: {
              healingEstimate: 0,
              isFastAction: 0,
            },
            isPolicyChoice: false,
            isReplayChoice: true,
            continuation: { winRate: 0.65 },
          },
          {
            actionIndex: 1,
            actionType: "playCard",
            actionDefinitionKind: "card",
            definitionId: 3301,
            cardDefinitionId: 3301,
            actorCharacterDefinitionId: 1411,
            candidateTags: ["draw"],
            candidateNumericSlots: {
              healingEstimate: 2,
              isFastAction: 1,
            },
            isPolicyChoice: true,
            isReplayChoice: false,
            continuation: { winRate: 0.52 },
          },
        ],
      },
    ],
  }

  const [point] = extractDecisionPointsFromBranchEvalReport(report)
  expect(point?.query_id).toContain("branch_eval:ShuiNing-mirror:game-0001-p0.json")
  expect(point?.candidate_ids).toEqual([
    `${point?.query_id}:candidate_0`,
    `${point?.query_id}:candidate_1`,
  ])
  expect(point?.context_slots).toMatchObject({
    round: 2,
    actor: 0,
    replay_action_index: 0,
    replay_action_definition_kind: "skill",
    replay_action_skill_definition_id: 2102,
    replay_actor_character_definition_id: 1411,
    self_active_character_definition_id: 1411,
    opp_active_character_definition_id: 2304,
    policy_selected_action_index: 1,
    query_numeric_slots: {
      diceCount: 7,
      cardsInHand: 3,
    },
  })
})

test("buildRankingDatasetFromBranchEvalReport exports candidates and pairwise preferences", () => {
  const report: BranchEvalReportLike = {
    matchupId: "ShuiNing-mirror",
    replayDir: "./replays",
    benchmarkPath: "./benchmark.json",
    continuationGamesPerBranch: 5,
    featureVersion: "gi-agent.feature-extractor.v1",
    candidateFeatureNames: ["healingEstimate", "isFastAction"],
    queryFeatureNames: ["diceCount", "cardsInHand"],
    points: [
      {
        pointIndex: 3,
        replayFile: "D:/replays/game-0001-p0.json",
        replayEntryIndex: 7,
        replayNextStateIndex: 8,
        actor: 0,
        round: 2,
        legalActionCount: 3,
        replayActionIndex: 0,
        replayActionType: "useSkill",
        replayActionDefinitionKind: "skill",
        replayActionDefinitionId: 2102,
        replayActionSkillDefinitionId: 2102,
        replayActorCharacterDefinitionId: 1411,
        replayActionTags: ["useSkill", "reaction"],
        selfActiveCharacterDefinitionId: 1411,
        oppActiveCharacterDefinitionId: 2304,
        queryNumericSlots: {
          diceCount: 7,
          cardsInHand: 3,
        },
        policySelectedActionIndex: 1,
        policySelectedActionType: "playCard",
        branches: [
          {
            actionIndex: 0,
            actionType: "useSkill",
            actionDefinitionKind: "skill",
            definitionId: 2102,
            skillDefinitionId: 2102,
            actorCharacterDefinitionId: 1411,
            candidateTags: ["reaction"],
            candidateNumericSlots: {
              healingEstimate: 0,
              isFastAction: 0,
            },
            isPolicyChoice: false,
            isReplayChoice: true,
            continuation: { winRate: 0.65, wins: 13, losses: 7, draws: 0 },
          },
          {
            actionIndex: 1,
            actionType: "playCard",
            actionDefinitionKind: "card",
            definitionId: 3301,
            cardDefinitionId: 3301,
            actorCharacterDefinitionId: 1411,
            candidateTags: ["draw"],
            candidateNumericSlots: {
              healingEstimate: 2,
              isFastAction: 1,
            },
            isPolicyChoice: true,
            isReplayChoice: false,
            continuation: { winRate: 0.52, wins: 10, losses: 9, draws: 1 },
          },
          {
            actionIndex: 2,
            actionType: "declareEnd",
            actionDefinitionKind: "none",
            definitionId: 0,
            actorCharacterDefinitionId: 1411,
            candidateTags: ["end_turn"],
            candidateNumericSlots: {
              healingEstimate: 0,
              isFastAction: 0,
            },
            isPolicyChoice: false,
            isReplayChoice: false,
            continuation: { winRate: 0.52, wins: 10, losses: 9, draws: 1 },
          },
        ],
      },
    ],
  }

  const dataset = buildRankingDatasetFromBranchEvalReport(report, {
    datasetId: "branch_eval_test",
  })

  expect(dataset.dataset_id).toBe("branch_eval_test")
  expect(dataset.metadata).toMatchObject({
    source: "branch_eval",
    matchup_id: "ShuiNing-mirror",
    feature_version: "gi-agent.feature-extractor.v1",
  })
  expect(dataset.query_groups).toHaveLength(1)

  const [group] = dataset.query_groups
  expect(group?.candidates).toHaveLength(3)
  expect(group?.candidates[0]).toMatchObject({
    action_case: "useSkill",
    action_definition_ref: "2102",
  })
  expect(group?.candidates[1]?.runtime_slots).toMatchObject({
    branch_action_index: 1,
    action_definition_kind: "card",
    card_definition_id: 3301,
    actor_character_definition_id: 1411,
    candidate_numeric_slots: {
      healingEstimate: 2,
      isFastAction: 1,
    },
    is_policy_choice: true,
  })
  expect(group?.context_slots).toMatchObject({
    self_active_character_definition_id: 1411,
    opp_active_character_definition_id: 2304,
    query_numeric_slots: {
      diceCount: 7,
      cardsInHand: 3,
    },
  })

  expect(group?.pairwise_preferences).toHaveLength(2)
  expect(group?.pairwise_preferences?.[0]).toMatchObject({
    preference_label: 1,
  })
  expect(group?.pairwise_preferences?.[0]?.preference_slots).toMatchObject({
    continuation_score_a: 0.65,
    continuation_score_b: 0.525,
  })
  expect(group?.pairwise_preferences?.map((item) => item.candidate_a_id)).toContain(
    `${group?.query_id}:candidate_0`,
  )
})

test("buildRankingDatasetFromBranchEvalReport prefers draws over losses when win rates tie", () => {
  const report: BranchEvalReportLike = {
    matchupId: "ShuiNing-mirror",
    replayDir: "./replays",
    points: [
      {
        replayFile: "D:/replays/game-0002-p0.json",
        replayEntryIndex: 11,
        replayNextStateIndex: 12,
        replayActionIndex: null,
        policySelectedActionIndex: 0,
        branches: [
          {
            actionIndex: 0,
            actionType: "useSkill",
            definitionId: 2102,
            isPolicyChoice: true,
            isReplayChoice: false,
            continuation: { winRate: 0, wins: 0, losses: 0, draws: 5 },
          },
          {
            actionIndex: 1,
            actionType: "switchActive",
            definitionId: 1205,
            isPolicyChoice: false,
            isReplayChoice: false,
            continuation: { winRate: 0, wins: 0, losses: 5, draws: 0 },
          },
        ],
      },
    ],
  }

  const dataset = buildRankingDatasetFromBranchEvalReport(report)
  const [group] = dataset.query_groups
  const [preference] = group?.pairwise_preferences ?? []

  expect(preference).toMatchObject({
    candidate_a_id: `${group?.query_id}:candidate_0`,
    candidate_b_id: `${group?.query_id}:candidate_1`,
    preference_label: 1,
    confidence: 0.5,
  })
  expect(group?.candidates[0]?.runtime_slots).toMatchObject({
    continuation: {
      score: 0.5,
      sample_count: 5,
    },
  })
  expect(group?.candidates[1]?.runtime_slots).toMatchObject({
    continuation: {
      score: 0,
      sample_count: 5,
    },
  })
})
