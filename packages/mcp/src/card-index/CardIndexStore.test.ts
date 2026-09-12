import { describe, expect, test, beforeEach } from "bun:test";
import { CardIndexStore } from "./CardIndexStore";
import type { CardIndexFile, CardIndexItem } from "./types";

function makeItem(overrides: Partial<CardIndexItem> = {}): CardIndexItem {
  return {
    definitionId: 1001,
    canonicalName: "Test Card",
    effectText: "Deal 2 damage",
    type: "event",
    tags: ["fastAction"],
    cost: 1,
    definitionKind: "card",
    sourcePath: "cards/event/test.ts",
    sourceExcerpt: "card(...)",
    contentHash: "abc123",
    version: "latest",
    ...overrides,
  };
}

function makeIndex(items: CardIndexItem[]): CardIndexFile {
  return {
    version: "latest",
    builtAt: new Date().toISOString(),
    sourceRoot: "/test",
    total: items.length,
    items,
    warnings: [],
  };
}

function createStore(items: CardIndexItem[]): CardIndexStore {
  const store = new CardIndexStore();
  (store as any).cache = makeIndex(items);
  return store;
}

describe("CardIndexStore", () => {
  describe("listCards", () => {
    const items = [
      makeItem({ definitionId: 1, canonicalName: "Fireball", type: "event", tags: ["damage", "pyro"], cost: 2 }),
      makeItem({ definitionId: 2, canonicalName: "Ice Shield", type: "equipment", tags: ["shield", "cryo"], cost: 1 }),
      makeItem({ definitionId: 3, canonicalName: "Heal Potion", type: "event", tags: ["heal"], cost: 0 }),
      makeItem({ definitionId: 4, canonicalName: "Sword of Flame", type: "equipment", tags: ["weapon", "pyro"], cost: 3 }),
      makeItem({ definitionId: 5, canonicalName: "Draw Card", type: "support", tags: ["draw"], cost: 1 }),
    ];

    test("returns all items without filter", async () => {
      const store = createStore(items);
      const result = await store.listCards({});
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(5);
      expect(result.version).toBe("latest");
    });

    test("filters by type", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { type: "event" } });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.type === "event")).toBe(true);
    });

    test("filters by type case-insensitive", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { type: "EVENT" } });
      expect(result.total).toBe(2);
    });

    test("filters by tags (all must match)", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { tags: ["pyro"] } });
      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.definitionId).sort()).toEqual([1, 4]);
    });

    test("filters by multiple tags", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { tags: ["pyro", "weapon"] } });
      expect(result.total).toBe(1);
      expect(result.items[0].definitionId).toBe(4);
    });

    test("filters by nameLike", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { nameLike: "fire" } });
      expect(result.total).toBe(1);
      expect(result.items[0].canonicalName).toBe("Fireball");
    });

    test("filters by nameLike case-insensitive", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { nameLike: "SWORD" } });
      expect(result.total).toBe(1);
      expect(result.items[0].definitionId).toBe(4);
    });

    test("combines type and tag filters", async () => {
      const store = createStore(items);
      const result = await store.listCards({ filter: { type: "equipment", tags: ["pyro"] } });
      expect(result.total).toBe(1);
      expect(result.items[0].definitionId).toBe(4);
    });

    test("pagination: page 1 with pageSize 2", async () => {
      const store = createStore(items);
      const result = await store.listCards({ page: 1, pageSize: 2 });
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(2);
      expect(result.items[0].definitionId).toBe(1);
      expect(result.items[1].definitionId).toBe(2);
    });

    test("pagination: page 2 with pageSize 2", async () => {
      const store = createStore(items);
      const result = await store.listCards({ page: 2, pageSize: 2 });
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(2);
      expect(result.items[0].definitionId).toBe(3);
    });

    test("pagination: last page with remaining items", async () => {
      const store = createStore(items);
      const result = await store.listCards({ page: 3, pageSize: 2 });
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(1);
      expect(result.items[0].definitionId).toBe(5);
    });

    test("pagination: page beyond range returns empty", async () => {
      const store = createStore(items);
      const result = await store.listCards({ page: 10, pageSize: 2 });
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(0);
    });

    test("pageSize is clamped to max 200", async () => {
      const manyItems = Array.from({ length: 250 }, (_, i) =>
        makeItem({ definitionId: i + 1, canonicalName: `Card ${i}` }),
      );
      const store = createStore(manyItems);
      const result = await store.listCards({ pageSize: 999 });
      expect(result.items.length).toBe(200);
    });

    test("pageSize minimum is 1", async () => {
      const store = createStore(items);
      const result = await store.listCards({ pageSize: 0 });
      expect(result.items.length).toBe(1);
    });

    test("page minimum is 1", async () => {
      const store = createStore(items);
      const result = await store.listCards({ page: -5 });
      expect(result.items.length).toBe(5);
    });

    test("empty index returns empty result", async () => {
      const store = createStore([]);
      const result = await store.listCards({});
      expect(result.total).toBe(0);
      expect(result.items.length).toBe(0);
    });
  });

  describe("getCardById", () => {
    const items = [
      makeItem({ definitionId: 100, canonicalName: "Alpha" }),
      makeItem({ definitionId: 200, canonicalName: "Beta" }),
    ];

    test("returns card when found", async () => {
      const store = createStore(items);
      const card = await store.getCardById(100);
      expect(card).not.toBeNull();
      expect(card!.canonicalName).toBe("Alpha");
      expect(card!.definitionId).toBe(100);
    });

    test("returns null when not found", async () => {
      const store = createStore(items);
      const card = await store.getCardById(999);
      expect(card).toBeNull();
    });

    test("returns exact match only", async () => {
      const store = createStore(items);
      const card = await store.getCardById(10);
      expect(card).toBeNull();
    });
  });

  describe("resolveCard", () => {
    const items = [
      makeItem({ definitionId: 1001, canonicalName: "Strategic Reserve", effectText: "Draw 2 cards" }),
      makeItem({ definitionId: 1002, canonicalName: "Leave It to Me!", effectText: "Switch to next character" }),
      makeItem({ definitionId: 1003, canonicalName: "Starsigns", effectText: "Draw 1 card" }),
      makeItem({ definitionId: 2001, canonicalName: "Calx's Arts", effectText: "Switch character and draw" }),
      makeItem({ definitionId: 3001, canonicalName: "Elemental Resonance", effectText: "Heal 2" }),
    ];

    test("exact name match scores highest", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("Strategic Reserve");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].canonicalName).toBe("Strategic Reserve");
      expect(results[0].score).toBeGreaterThanOrEqual(80);
    });

    test("partial name match returns results", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("Reserve");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].canonicalName).toBe("Strategic Reserve");
      expect(results[0].score).toBeGreaterThanOrEqual(45);
    });

    test("definitionId exact match scores highest", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("1001");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].definitionId).toBe(1001);
      expect(results[0].score).toBeGreaterThanOrEqual(100);
    });

    test("effect text match returns results", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("draw");
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.canonicalName);
      expect(names).toContain("Strategic Reserve");
      expect(names).toContain("Starsigns");
    });

    test("case insensitive search", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("STRATEGIC");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].canonicalName).toBe("Strategic Reserve");
    });

    test("no match returns empty array", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("xyznonexistent");
      expect(results.length).toBe(0);
    });

    test("topK limits results", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("a", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("topK is clamped to max 20", async () => {
      const manyItems = Array.from({ length: 30 }, (_, i) =>
        makeItem({ definitionId: i + 1, canonicalName: `Card ${i}`, effectText: "common text" }),
      );
      const store = createStore(manyItems);
      const results = await store.resolveCard("common", 100);
      expect(results.length).toBeLessThanOrEqual(20);
    });

    test("empty query returns empty", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("");
      expect(results.length).toBe(0);
    });

    test("whitespace-only query returns empty", async () => {
      const store = createStore(items);
      const results = await store.resolveCard("   ");
      expect(results.length).toBe(0);
    });
  });

  describe("validateCardMapping", () => {
    const items = [
      makeItem({ definitionId: 100, canonicalName: "Alpha Card", contentHash: "hash_a" }),
      makeItem({ definitionId: 200, canonicalName: "Beta Card", contentHash: "hash_b" }),
    ];

    test("matched card returns OK", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 100, name: "Alpha Card" },
      ]);
      expect(results.length).toBe(1);
      expect(results[0].matched).toBe(true);
      expect(results[0].reason).toBe("OK");
      expect(results[0].canonicalName).toBe("Alpha Card");
      expect(results[0].contentHash).toBe("hash_a");
    });

    test("name mismatch returns NAME_MISMATCH", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 100, name: "Wrong Name" },
      ]);
      expect(results.length).toBe(1);
      expect(results[0].matched).toBe(false);
      expect(results[0].reason).toBe("NAME_MISMATCH");
      expect(results[0].canonicalName).toBe("Alpha Card");
    });

    test("name comparison is case-insensitive", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 100, name: "ALPHA CARD" },
      ]);
      expect(results[0].matched).toBe(true);
    });

    test("name comparison trims whitespace", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 100, name: "  Alpha Card  " },
      ]);
      expect(results[0].matched).toBe(true);
    });

    test("missing card returns CARD_NOT_FOUND", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 999, name: "Nonexistent" },
      ]);
      expect(results.length).toBe(1);
      expect(results[0].matched).toBe(false);
      expect(results[0].reason).toBe("CARD_NOT_FOUND");
      expect(results[0].canonicalName).toBeNull();
      expect(results[0].contentHash).toBeNull();
    });

    test("multiple items validated independently", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([
        { definitionId: 100, name: "Alpha Card" },
        { definitionId: 200, name: "Wrong" },
        { definitionId: 999, name: "Missing" },
      ]);
      expect(results.length).toBe(3);
      expect(results[0].matched).toBe(true);
      expect(results[0].reason).toBe("OK");
      expect(results[1].matched).toBe(false);
      expect(results[1].reason).toBe("NAME_MISMATCH");
      expect(results[2].matched).toBe(false);
      expect(results[2].reason).toBe("CARD_NOT_FOUND");
    });

    test("empty input returns empty output", async () => {
      const store = createStore(items);
      const results = await store.validateCardMapping([]);
      expect(results.length).toBe(0);
    });
  });

  describe("caching", () => {
    test("cache is populated after first call", async () => {
      const store = createStore([makeItem()]);
      await store.listCards({});
      expect((store as any).cache).not.toBeNull();
    });

    test("subsequent calls use cache", async () => {
      const store = createStore([
        makeItem({ definitionId: 1, canonicalName: "First" }),
      ]);
      const result1 = await store.getCardById(1);
      expect(result1!.canonicalName).toBe("First");

      (store as any).cache.items.push(
        makeItem({ definitionId: 2, canonicalName: "Second" }),
      );
      const result2 = await store.getCardById(2);
      expect(result2!.canonicalName).toBe("Second");
    });
  });
});
