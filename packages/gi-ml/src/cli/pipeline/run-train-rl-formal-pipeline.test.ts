import { describe, expect, test } from "vitest"
import { basename } from "node:path"

import { buildBundle, choosePythonCommand } from "./run-train-rl-formal-pipeline.js"

describe("buildBundle", () => {
  test("assembles bundle from persisted outputs without large in-memory datasets", () => {
    const bundle = buildBundle({
      inputPath: "/tmp/rl-dataset.manifest.json",
      pythonExe: "python3",
      pythonCwd: "/tmp/python",
      rankingDatasetPath: "/tmp/rl.ranking.json",
      rankerArtifactPath: "/tmp/rl.ranker.json",
      rankingEvalPath: "/tmp/rl.ranker-eval.json",
      rankingEvaluation: {
        dataset_id: "ranking_ds",
        artifact_type: "slot_linear_ranking",
        artifact_version: "ranker.v1",
        query_count: 12,
        query_with_preferences_count: 10,
        pairwise_preference_count: 24,
        pairwise_supported_score: 16,
        pairwise_support_rate: 0.7,
        top1_not_contradicted_rate: 0.8,
        top1_not_contradicted_count: 8,
        query_diagnostics: [],
      },
      rankingTrainDatasetPath: "/tmp/rl.ranking-train.json",
      rankingHoldoutDatasetPath: "/tmp/rl.ranking-holdout.json",
      valueDatasetPath: "/tmp/rl.value.json",
      valueTrainDatasetPath: "/tmp/rl.value-train.json",
      valueHoldoutDatasetPath: "/tmp/rl.value-holdout.json",
      valueArtifactPath: "/tmp/rl.value-artifact.json",
      valueEvalPath: "/tmp/rl.value-eval.json",
      valueEvaluation: {
        dataset_id: "value_ds",
        artifact_type: "linear_value",
        artifact_version: "value.v1",
        sample_count: 34,
        mae: 0.2,
        mse: 0.09,
        rmse: 0.3,
        mean_prediction: 0.45,
        mean_target: 0.5,
        diagnostics: [],
      },
      holdoutFraction: 0.1,
      holdoutSeed: "seed-a",
      rankerArtifactVersion: "ranker.v1",
      valueArtifactVersion: "value.v1",
    })

    expect(basename(bundle.outputs.ranking_dataset)).toBe("rl.ranking.json")
    expect(basename(bundle.outputs.ranking_holdout_dataset)).toBe("rl.ranking-holdout.json")
    expect(bundle.metrics.ranking.query_count).toBe(12)
    expect(bundle.metrics.value.sample_count).toBe(34)
    expect(bundle.evaluation_split).toMatchObject({
      kind: "holdout",
      holdout_fraction: 0.1,
      holdout_seed: "seed-a",
    })
    expect(bundle.versions.ranker_artifact_version).toBe("ranker.v1")
    expect(bundle.versions.value_artifact_version).toBe("value.v1")
  })
})

describe("choosePythonCommand", () => {
  test("maps python3 to python on Windows when python exists", () => {
    expect(choosePythonCommand("python3", "win32", true)).toBe("python")
  })

  test("keeps python3 on non-Windows platforms", () => {
    expect(choosePythonCommand("python3", "linux", true)).toBe("python3")
  })
})
