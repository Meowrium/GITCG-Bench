import { describe, expect, test } from "vitest";

import { normalizeCliPathForPlatform } from "./cli-path";

describe("normalizeCliPathForPlatform", () => {
  test("maps WSL mount paths to Windows drive paths", () => {
    expect(
      normalizeCliPathForPlatform(
        "/mnt/d/projects/gitcg/packages/gi-agent/output/file.json",
        "win32",
      ),
    ).toBe("D:\\projects\\gitcg\\packages\\gi-agent\\output\\file.json");
  });

  test("keeps Windows-native paths unchanged", () => {
    expect(
      normalizeCliPathForPlatform(
        "D:\\projects\\gitcg\\packages\\gi-agent\\output\\file.json",
        "win32",
      ),
    ).toBe("D:\\projects\\gitcg\\packages\\gi-agent\\output\\file.json");
  });

  test("keeps paths unchanged on non-Windows platforms", () => {
    expect(
      normalizeCliPathForPlatform(
        "/mnt/d/projects/gitcg/packages/gi-agent/output/file.json",
        "linux",
      ),
    ).toBe("/mnt/d/projects/gitcg/packages/gi-agent/output/file.json");
  });
});
