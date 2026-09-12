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
import { resolve } from "node:path"
import { GiMlPolicy } from "../../runtime/policy/gi-ml-policy.js"
import {
  buildBenchmarkExecutionPlans,
  createPolicyFromConfig,
  loadBenchmarkCliConfig,
  type BenchmarkCliConfig,
} from "./cli-config.js"

test("buildBenchmarkExecutionPlans preserves planner-side search options", () => {
  const config: BenchmarkCliConfig = {
    matchups: [
      {
        id: "planner-smoke",
        deck0: "deck-a",
        deck1: "deck-b",
        games: 2,
        sideA: {
          name: "planner-a",
          kind: "gi-ml-runtime",
          rankerArtifactPath: "./ranker.json",
          valueArtifactPath: "./value.json",
          combatWindowLibraryPath: "./library.json",
          searchOptions: {
            enabled: true,
            beamWidth: 5,
          },
        },
        sideB: {
          name: "runtime-b",
          kind: "baseline",
        },
      },
    ],
  }

  const [plan] = buildBenchmarkExecutionPlans(config)
  expect(plan?.sideA.kind).toBe("gi-ml-runtime")
  if (plan?.sideA.kind !== "gi-ml-runtime") {
    throw new Error("expected gi-ml-runtime sideA")
  }
  expect(plan.sideA.combatWindowLibraryPath).toBe("./library.json")
  expect(plan.sideA.searchOptions?.enabled).toBe(true)
  expect(plan.sideA.searchOptions?.beamWidth).toBe(5)
})

test("createPolicyFromConfig loads planner benchmark resources from generated preset paths", async () => {
  const configDir = resolve(
    process.cwd(),
    "output/generated-rl-004",
  )

  const policy = await createPolicyFromConfig(
    {
      name: "planner-a",
      kind: "gi-ml-runtime",
      rankerArtifactPath:
        "../../../gi-ml/output/rl-formal-train-trio-004/rl_trio_004.ranker-artifact.python.json",
      valueArtifactPath:
        "../../../gi-ml/output/rl-formal-train-trio-004/rl_trio_004.value-artifact.python.json",
      combatWindowLibraryPath: "../combat-windows/library.sample.json",
      options: {
        endTurnPenalty: 5,
      },
    },
    configDir,
  )

  expect(policy).toBeInstanceOf(GiMlPolicy)
  if (!(policy instanceof GiMlPolicy)) {
    throw new Error("expected GiMlPolicy")
  }
  expect(policy.valueArtifact).not.toBeNull()
  expect(policy.combatWindowLibrary?.entry_count).toBeGreaterThan(0)
  expect(policy.combatWindowLibrary?.entries[0]?.canonical_key).toBe(
    "sample_r1_setup_support",
  )
})

test("loadBenchmarkCliConfig reads the search-only formal benchmark preset", async () => {
  const loaded = await loadBenchmarkCliConfig(
    resolve(
      process.cwd(),
      "output/generated-rl-004/benchmark.trio.rl-trio-004-search-only-formal.generated.json",
    ),
  )

  const plans = buildBenchmarkExecutionPlans(loaded.config)
  expect(plans).toHaveLength(8)
  expect(plans[0]?.id).toBe("hydroning-vs-cryohe-p0-search")
  expect(plans[1]?.id).toBe("hydroning-vs-cryohe-p1-search")
  if (plans[0]?.sideA.kind !== "gi-ml-runtime" || plans[0]?.sideB.kind !== "gi-ml-runtime") {
    throw new Error("expected gi-ml-runtime sides in formal preset")
  }
  expect(plans[0].sideA.searchOptions?.enabled).toBe(true)
  expect(plans[0].sideB.searchOptions?.enabled).toBeUndefined()
  expect(plans[1].sideA.searchOptions?.enabled).toBeUndefined()
  expect(plans[1].sideB.searchOptions?.enabled).toBe(true)
})
