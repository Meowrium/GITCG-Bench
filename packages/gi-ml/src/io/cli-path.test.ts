import { describe, expect, test } from "vitest"

import { normalizeCliPathForPlatform } from "./cli-path.js"

describe("normalizeCliPathForPlatform", () => {
  test("maps WSL mount paths to Windows drive paths", () => {
    expect(
      normalizeCliPathForPlatform(
        "/mnt/d/projects/gitcg/packages/gi-ml/output/file.json",
        "win32",
      ),
    ).toBe("D:\\projects\\gitcg\\packages\\gi-ml\\output\\file.json")
  })

  test("keeps non-WSL Windows paths unchanged", () => {
    expect(
      normalizeCliPathForPlatform(
        "D:\\projects\\gitcg\\packages\\gi-ml\\output\\file.json",
        "win32",
      ),
    ).toBe("D:\\projects\\gitcg\\packages\\gi-ml\\output\\file.json")
  })

  test("keeps paths unchanged on non-Windows platforms", () => {
    expect(
      normalizeCliPathForPlatform(
        "/mnt/d/projects/gitcg/packages/gi-ml/output/file.json",
        "linux",
      ),
    ).toBe("/mnt/d/projects/gitcg/packages/gi-ml/output/file.json")
  })
})
