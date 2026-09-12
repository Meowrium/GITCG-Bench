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

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "vitest"
import type { MlRankingDataset, MlRankingQueryGroup, MlValueDataset } from "../contracts/index.js"
import {
  readJsonFile,
  visitRankingDatasetQueryGroups,
  writeRankingDatasetFile,
  writeValueDatasetFile,
} from "./index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("writeRankingDatasetFile", () => {
  test("writes a readable dataset without materializing the full file string", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gi-ml-json-ranking-"))
    tempDirs.push(tempDir)

    const dataset: MlRankingDataset = {
      dataset_id: "ranking-fixture",
      created_at: "2026-04-04T12:00:00.000Z",
      metadata: {
        source: "test",
        count: 2,
      },
      query_groups: [
        {
          query_id: "q1",
          source: "rl",
          state_ref: "state-1",
          context_slots: { phase: "combat" },
          candidates: [
            {
              candidate_id: "c1",
              query_id: "q1",
              action_case: "play_card",
              runtime_slots: { card: "skill_a" },
            },
          ],
          pairwise_preferences: [
            {
              query_id: "q1",
              candidate_a_id: "c1",
              candidate_b_id: "c2",
              preference_label: 1,
            },
          ],
        },
        {
          query_id: "q2",
          candidates: [
            {
              candidate_id: "c3",
              query_id: "q2",
              action_case: "switch_active",
            },
          ],
        },
      ],
    }

    const outputPath = join(tempDir, "ranking.json")
    await writeRankingDatasetFile(outputPath, dataset)

    expect(await readJsonFile<MlRankingDataset>(outputPath)).toEqual(dataset)
  })

  test("streams query_groups back from disk without loading the full dataset", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gi-ml-json-ranking-stream-"))
    tempDirs.push(tempDir)

    const dataset: MlRankingDataset = {
      dataset_id: "ranking-stream-fixture",
      created_at: "2026-04-04T12:00:00.000Z",
      metadata: {
        note: "stream",
      },
      query_groups: [
        {
          query_id: "q1",
          source: "rl",
          candidates: [
            {
              candidate_id: "c1",
              query_id: "q1",
              action_case: "play_card",
              runtime_slots: {
                candidate_tags: ["support_create"],
              },
            },
          ],
        },
        {
          query_id: "q2",
          candidates: [
            {
              candidate_id: "c2",
              query_id: "q2",
              action_case: "switch_active",
            },
          ],
        },
      ],
    }

    const outputPath = join(tempDir, "ranking-stream.json")
    await writeRankingDatasetFile(outputPath, dataset)

    const queryGroups: MlRankingQueryGroup[] = []
    const header = await visitRankingDatasetQueryGroups(outputPath, (group) => {
      queryGroups.push(group)
    })

    expect(header).toEqual({ dataset_id: dataset.dataset_id })
    expect(queryGroups).toEqual(dataset.query_groups)
  })
})

describe("writeValueDatasetFile", () => {
  test("writes a readable dataset without materializing the full file string", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gi-ml-json-value-"))
    tempDirs.push(tempDir)

    const dataset: MlValueDataset = {
      dataset_id: "value-fixture",
      metadata: {
        source: "test",
      },
      samples: [
        {
          sample_id: "s1",
          source: "rl",
          state_ref: "state-1",
          target_value: 1,
          weight: 0.5,
          context_slots: { deck: "pyroke" },
          feature_slots: { hp: 6 },
        },
        {
          sample_id: "s2",
          source: "rl",
          state_ref: null,
          target_value: 0.25,
        },
      ],
    }

    const outputPath = join(tempDir, "value.json")
    await writeValueDatasetFile(outputPath, dataset)

    expect(await readJsonFile<MlValueDataset>(outputPath)).toEqual(dataset)
  })
})
