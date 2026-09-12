import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardIndexFromDataSource } from "./buildFromDataSource";

describe("buildCardIndexFromDataSource", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gi-card-index-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("builds index from character files", async () => {
    const charDir = join(tempDir, "characters", "pyro");
    await mkdir(charDir, { recursive: true });
    await writeFile(
      join(charDir, "diluc.ts"),
      `
/**
 * @id 1101
 * @name Diluc
 * @description 晨曦酒庄的老爷
 */
export const diluc = character(1101)
  .tags("pyro", "claymore")
  .costPyro(3)
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);

    expect(result.version).toBe("latest");
    expect(result.items.length).toBe(1);
    expect(result.items[0].definitionId).toBe(1101);
    expect(result.items[0].canonicalName).toBe("Diluc");
    expect(result.items[0].type).toBe("character:pyro");
    expect(result.items[0].tags).toContain("pyro");
    expect(result.items[0].tags).toContain("claymore");
    expect(result.items[0].definitionKind).toBe("character");
  });

  test("builds index from event card files", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "strategic_reserve.ts"),
      `
/**
 * @id 332001
 * @name Strategic Reserve
 * @description Draw 2 cards.
 */
export const strategicReserve = card(332001)
  .tags("fastAction")
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);

    expect(result.items.length).toBe(1);
    expect(result.items[0].definitionId).toBe(332001);
    expect(result.items[0].canonicalName).toBe("Strategic Reserve");
    expect(result.items[0].type).toBe("event");
    expect(result.items[0].definitionKind).toBe("card");
    expect(result.items[0].effectText).toBe("Draw 2 cards.");
  });

  test("builds index from equipment card files", async () => {
    const cardDir = join(tempDir, "cards", "equipment");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "magic_guide.ts"),
      `
/**
 * @id 311101
 * @name Magic Guide
 * @description +1 damage
 */
export const magicGuide = card(311101)
  .tags("weapon", "catalyst")
  .costSame(2)
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);

    expect(result.items.length).toBe(1);
    expect(result.items[0].type).toBe("equipment");
    expect(result.items[0].cost).toBe(2);
  });

  test("builds index from support card files", async () => {
    const cardDir = join(tempDir, "cards", "support");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "katheryne.ts"),
      `
/**
 * @id 322001
 * @name Katheryne
 * @description Switch character
 */
export const katheryne = card(322001)
  .tags("location")
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);

    expect(result.items.length).toBe(1);
    expect(result.items[0].type).toBe("support");
  });

  test("ignores files outside cards/ and characters/", async () => {
    const otherDir = join(tempDir, "utils");
    await mkdir(otherDir, { recursive: true });
    await writeFile(
      join(otherDir, "helper.ts"),
      `
/**
 * @id 9999
 * @name Should Not Appear
 */
export const helper = entity(9999).done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items.length).toBe(0);
  });

  test("ignores old_versions directory", async () => {
    const oldDir = join(tempDir, "old_versions", "cards", "event");
    await mkdir(oldDir, { recursive: true });
    await writeFile(
      join(oldDir, "old_card.ts"),
      `
/**
 * @id 8888
 * @name Old Card
 */
export const oldCard = card(8888).done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items.length).toBe(0);
  });

  test("warns on missing @name", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "no_name.ts"),
      `
/**
 * @id 7777
 */
export const noName = card(7777).done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items.length).toBe(0);
    expect(result.warnings.some((w) => w.includes("missing @name"))).toBe(true);
  });

  test("warns on duplicate definitionId", async () => {
    const cardDir1 = join(tempDir, "cards", "event");
    const cardDir2 = join(tempDir, "cards", "support");
    await mkdir(cardDir1, { recursive: true });
    await mkdir(cardDir2, { recursive: true });

    const content = `
/**
 * @id 5555
 * @name Duplicate Card
 */
export const dup = card(5555).done();
`;
    await writeFile(join(cardDir1, "dup1.ts"), content, "utf-8");
    await writeFile(join(cardDir2, "dup2.ts"), content, "utf-8");

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items.length).toBe(2);
    expect(result.warnings.some((w) => w.includes("duplicate definitionId 5555"))).toBe(true);
  });

  test("extracts cost from multiple cost calls", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "expensive.ts"),
      `
/**
 * @id 4444
 * @name Expensive Card
 * @description Costs a lot
 */
export const expensive = card(4444)
  .costPyro(2)
  .costVoid(1)
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].cost).toBe(3);
  });

  test("extracts .since() version", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "versioned.ts"),
      `
/**
 * @id 6666
 * @name Versioned Card
 */
export const versioned = card(6666)
  .since("v4.0")
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].since).toBe("v4.0");
  });

  test("generates contentHash", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "hash_test.ts"),
      `
/**
 * @id 7777
 * @name Hash Test
 */
export const hashTest = card(7777).done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].contentHash).toBeTruthy();
    expect(result.items[0].contentHash.length).toBe(64);
  });

  test("empty data source returns empty index", async () => {
    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items.length).toBe(0);
    expect(result.total).toBe(0);
    expect(result.warnings.length).toBe(0);
  });

  test("detects skill definition kind", async () => {
    const charDir = join(tempDir, "characters", "electro");
    await mkdir(charDir, { recursive: true });
    await writeFile(
      join(charDir, "raiden_skill.ts"),
      `
/**
 * @id 14012
 * @name Transcendence: Baleful Omen
 */
export const transcendence = skill(14012)
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].definitionKind).toBe("skill");
  });

  test("detects summon definition kind", async () => {
    const charDir = join(tempDir, "characters", "cryo");
    await mkdir(charDir, { recursive: true });
    await writeFile(
      join(charDir, "frostflake.ts"),
      `
/**
 * @id 111012
 * @name Frostflake Seki no To
 */
export const frostflake = summon(111012)
  .done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].definitionKind).toBe("summon");
  });

  test("normalizes sourcePath to forward slashes", async () => {
    const cardDir = join(tempDir, "cards", "event");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "path_test.ts"),
      `
/**
 * @id 9999
 * @name Path Test
 */
export const pathTest = card(9999).done();
`,
      "utf-8",
    );

    const result = await buildCardIndexFromDataSource(tempDir);
    expect(result.items[0].sourcePath).not.toContain("\\");
    expect(result.items[0].sourcePath).toContain("/");
  });
});
