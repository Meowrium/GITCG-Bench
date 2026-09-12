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
import type { MlDecisionPoint } from "../contracts/index.js"
import type { RuntimeConceptState } from "../runtime/index.js"
import { SlotLinearRanker } from "./slot-linear-ranker.js"
import type { SlotLinearRankerArtifact } from "./artifact.js"

test("SlotLinearRanker ranks by action case, tags, numeric slots, and concept boosts", async () => {
  const artifact: SlotLinearRankerArtifact = {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: "test_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    compatibility: null,
    config: {
      action_case_bias: {
        playCard: 0.2,
        useSkill: 0.1,
      },
      candidate_tag_bias: {
        burst: 0.8,
      },
      candidate_numeric_slot_weights: {
        "continuation.win_rate": 2,
      },
      query_numeric_slot_weights: {
        round: -0.1,
      },
      concept_presence_weights: {
        "concept:burst-window": 0.5,
      },
      concept_numeric_slot_weights: [
        {
          concept_id: "concept:burst-window",
          path: "strength",
          weight: 0.5,
        },
      ],
    },
  }

  const ranker = new SlotLinearRanker(artifact)
  const query: MlDecisionPoint = {
    query_id: "query_1",
    source: "branch_eval",
    state_ref: "state:1",
    matchup_ref: "matchup:1",
    deck_refs: null,
    candidate_ids: ["c1", "c2"],
    evidence_refs: ["e1"],
    context_slots: {
      round: 2,
    },
  }
  const conceptState: RuntimeConceptState = {
    query_id: "query_1",
    values: [
      {
        concept_id: "concept:burst-window",
        value_slot: {
          strength: 2,
        },
        confidence: 0.7,
      },
    ],
  }

  const result = await ranker.rank({
    query,
    concept_state: conceptState,
    candidates: [
      {
        candidate_id: "c1",
        query_id: "query_1",
        action_case: "useSkill",
        runtime_slots: {
          candidate_tags: ["setup"],
          continuation: {
            win_rate: 0.3,
          },
        },
      },
      {
        candidate_id: "c2",
        query_id: "query_1",
        action_case: "playCard",
        runtime_slots: {
          candidate_tags: ["burst"],
          continuation: {
            win_rate: 0.4,
          },
        },
      },
    ],
  })

  expect(result.ranked_actions).toHaveLength(2)
  expect(result.ranked_actions[0]?.candidate_id).toBe("c2")
  expect(result.ranked_actions[0]?.score).toBeGreaterThan(result.ranked_actions[1]!.score)
  expect(result.ranked_actions[0]?.explanation_slots).toMatchObject({
    action_case: "playCard",
  })
})
