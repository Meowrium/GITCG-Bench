import { expect, test } from "vitest"

import { shouldIncludeDatasetKey } from "./holdout.js"

test("shouldIncludeDatasetKey produces deterministic, disjoint train and holdout membership", () => {
  const keys = Array.from({ length: 32 }, (_, index) => `dp-${index + 1}`)
  const train = keys.filter((key) =>
    shouldIncludeDatasetKey(key, {
      subset: "train",
      holdoutFraction: 0.25,
      holdoutSeed: "seed-a",
    }))
  const holdout = keys.filter((key) =>
    shouldIncludeDatasetKey(key, {
      subset: "holdout",
      holdoutFraction: 0.25,
      holdoutSeed: "seed-a",
    }))

  expect(train.length).toBeGreaterThan(0)
  expect(holdout.length).toBeGreaterThan(0)
  expect(new Set([...train, ...holdout]).size).toBe(keys.length)
  expect(train.some((key) => holdout.includes(key))).toBe(false)
})
