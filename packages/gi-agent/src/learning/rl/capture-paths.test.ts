import { expect, test } from "vitest"
import { resolveDatasetCapturePaths } from "./capture-paths.js"

test("resolveDatasetCapturePaths prefers captures from the current run", () => {
  const resolved = resolveDatasetCapturePaths({
    currentRunCapturePaths: ["c:\\run\\b.rl.json", "c:\\run\\a.rl.json", "c:\\run\\a.rl.json"],
    fallbackCapturePaths: ["c:\\old\\z.rl.json"],
  })

  expect(resolved).toEqual(["c:\\run\\a.rl.json", "c:\\run\\b.rl.json"])
})

test("resolveDatasetCapturePaths falls back to directory scan when needed", () => {
  const resolved = resolveDatasetCapturePaths({
    currentRunCapturePaths: [],
    fallbackCapturePaths: ["c:\\old\\b.rl.json", "c:\\old\\a.rl.json", "c:\\old\\a.rl.json"],
  })

  expect(resolved).toEqual(["c:\\old\\a.rl.json", "c:\\old\\b.rl.json"])
})
