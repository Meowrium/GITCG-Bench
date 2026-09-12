import { describe, it, expect } from "bun:test";
import { CandidateEnricher, type EnrichmentContext } from "./CandidateEnricher";

// ── Mock CardIndexStore ──────────────────────────────────────────────────────

class MockCardIndexStore {
  private items: Map<number, { definitionId: number; canonicalName: string; effectText: string; type: string; tags: string[]; definitionKind: string; sourceExcerpt: string }> = new Map();

  addCard(id: number, data: Partial<{ canonicalName: string; effectText: string; type: string; tags: string[]; definitionKind: string; sourceExcerpt: string }>) {
    this.items.set(id, {
      definitionId: id,
      canonicalName: data.canonicalName ?? `Card_${id}`,
      effectText: data.effectText ?? "",
      type: data.type ?? "character",
      tags: data.tags ?? [],
      definitionKind: data.definitionKind ?? "skill",
      sourceExcerpt: data.sourceExcerpt ?? "",
    });
  }

  async getCardById(definitionId: number) {
    return this.items.get(definitionId) ?? null;
  }

  async listCards() { return { total: 0, items: [], version: "mock" }; }
  async resolveCard() { return []; }
  async validateCardMapping() { return []; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    candidate_id: "cand_1",
    action_case: "useSkill",
    cost: { required_cost: [] },
    damage_estimate: 0,
    reaction_value: 0,
    tempo_value: 0,
    survival_risk: 0,
    tags: ["useSkill", "valid"],
    notes: ["validity=0", "required_cost_entries=0"],
    ...overrides,
  };
}

function makeRawAction(
  $case: string,
  value: Record<string, unknown>,
  overrides: Partial<{
    preview: Array<{ mutation: { $case: string; value: Record<string, unknown> } }>;
    isFast: boolean;
    requiredCost: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    action: { $case, value },
    requiredCost: overrides.requiredCost ?? [],
    preview: overrides.preview ?? [],
    isFast: overrides.isFast ?? false,
    autoSelectedDice: [],
    validity: 0,
  };
}

function makeDamageMutation(dmgValue: number, damageType = 3, reactionType = 0) {
  return {
    mutation: {
      $case: "damage",
      value: { damageType, value: dmgValue, reactionType, healKind: 0, isSkillMainDamage: true },
    },
  };
}

function makeHealMutation(healValue: number) {
  return {
    mutation: {
      $case: "damage",
      value: { damageType: 9, value: healValue, reactionType: 0, healKind: 1 },
    },
  };
}

function makeCreateEntityMutation(entityType: number) {
  return {
    mutation: {
      $case: "createEntity",
      value: { entity: { type: entityType } },
    },
  };
}

function makePlayer(opts: {
  activeCharacterId?: number;
  characters?: Array<{
    id: number;
    variable?: { health: number; maxHealth: number; energy: number; maxEnergy: number };
  }>;
  dice?: number[];
  handCard?: unknown[];
} = {}): Record<string, unknown> {
  return {
    activeCharacterId: opts.activeCharacterId ?? -500001,
    character: (opts.characters ?? []).map((ch) => ({
      id: ch.id,
      definition: { id: ch.id },
      variable: ch.variable ?? { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3 },
    })),
    dice: opts.dice ?? [8, 8, 3, 3, 1, 1, 2, 2],
    handCard: opts.handCard ?? [],
  };
}

function makeCtx(overrides: Partial<EnrichmentContext> = {}): EnrichmentContext {
  return {
    selfPlayer: makePlayer({
      activeCharacterId: -500001,
      characters: [
        { id: -500001, variable: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3 } },
        { id: -500002, variable: { health: 8, maxHealth: 10, energy: 2, maxEnergy: 3 } },
      ],
    }),
    opponentPlayer: makePlayer({
      activeCharacterId: -500033,
      characters: [
        { id: -500033, variable: { health: 6, maxHealth: 10, energy: 1, maxEnergy: 3 } },
      ],
    }),
    rawActions: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CandidateEnricher", () => {
  const mockStore = new MockCardIndexStore();
  mockStore.addCard(21021, {
    canonicalName: "Normal Attack",
    effectText: "造成 2 点物理伤害。",
    definitionKind: "skill",
  });
  mockStore.addCard(21022, {
    canonicalName: "Elemental Skill",
    effectText: "造成 3 点冰元素伤害。元素战技",
    definitionKind: "skill",
  });
  mockStore.addCard(21023, {
    canonicalName: "Elemental Burst",
    effectText: "造成 7 点冰元素伤害。元素爆发",
    definitionKind: "skill",
  });
  mockStore.addCard(312018, {
    canonicalName: "Sweet Madame",
    effectText: "治疗目标角色 1 点。",
    type: "action",
    definitionKind: "card",
  });
  mockStore.addCard(312099, {
    canonicalName: "Shield Card",
    effectText: "获得 2 层护盾。",
    type: "action",
    definitionKind: "card",
  });

  const enricher = new CandidateEnricher(mockStore as any);

  it("enriches useSkill with damage from preview", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(3, 3)],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.damage_estimate).toBe(3);
    expect(candidate.reaction_value).toBe(0);
  });

  it("computes reaction_value from preview reactions", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21022 }, {
      preview: [
        makeDamageMutation(5, 1, 1), // cryo damage + melt reaction
      ],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.reaction_value).toBe(3); // melt = 3
    const tags = candidate.tags as string[];
    expect(tags).toContain("cryo");
    expect(tags).toContain("melt");
  });

  it("adds isFast tempo bonus", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(2, 3)],
      isFast: true,
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.tempo_value).toBe(2);
    expect((candidate.tags as string[])).toContain("fast");
  });

  it("handles heal preview mutations", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [
        makeDamageMutation(1, 3),
        makeHealMutation(3),
      ],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // damage_estimate = totalDamage + totalHeal * 0.8 = 1 + 3*0.8 = 3.4
    expect(candidate.damage_estimate).toBeCloseTo(3.4, 5);
    expect((candidate.tags as string[])).toContain("heal");
  });

  it("enriches playCard with preview data and card lookup", async () => {
    const candidate = makeCandidate({ action_case: "playCard" });
    const rawAction = makeRawAction("playCard", { cardDefinitionId: 312018, willBeEffectless: false }, {
      preview: [makeHealMutation(2)],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.damage_estimate).toBeCloseTo(1.6, 5); // 0 + 2 * 0.8
    expect((candidate.tags as string[])).toContain("heal");
    expect((candidate.notes as string[])).toContain("card_def_id=312018");
  });

  it("tags effectless playCard", async () => {
    const candidate = makeCandidate({ action_case: "playCard" });
    const rawAction = makeRawAction("playCard", { cardDefinitionId: 312018, willBeEffectless: true }, {
      preview: [],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("effectless");
  });

  it("tags shield from card effectText", async () => {
    const candidate = makeCandidate({ action_case: "playCard" });
    const rawAction = makeRawAction("playCard", { cardDefinitionId: 312099, willBeEffectless: false }, {
      preview: [makeCreateEntityMutation(2)], // status
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("shield");
    expect((candidate.tags as string[])).toContain("status");
  });

  it("enriches switchActive with target HP data", async () => {
    const candidate = makeCandidate({ action_case: "switchActive" });
    const rawAction = makeRawAction("switchActive", { characterId: -500002, characterDefinitionId: 1510 });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // -500002 has 8/10 HP => not low_hp; energy=2, maxEnergy=3 => not burst_ready
    // switchActive only checks burst_ready when energy >= maxEnergy
    expect((candidate.notes as string[])).toContain("target_character_def_id=1510");
    expect((candidate.notes as string[])).toContain("target_character_def_id=1510");
  });

  it("flags switch to low HP character", async () => {
    const candidate = makeCandidate({ action_case: "switchActive" });
    const lowHpPlayer = makePlayer({
      activeCharacterId: -500001,
      characters: [
        { id: -500001, variable: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3 } },
        { id: -500002, variable: { health: 2, maxHealth: 10, energy: 3, maxEnergy: 3 } },
      ],
    });
    const rawAction = makeRawAction("switchActive", { characterId: -500002, characterDefinitionId: 1510 });
    const ctx = makeCtx({ selfPlayer: lowHpPlayer, rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("switch_to_low_hp");
    expect((candidate.tags as string[])).toContain("burst_ready"); // energy=3 >= maxEnergy=3
    expect(candidate.survival_risk as number).toBeGreaterThan(0);
  });

  it("assigns negative tempo for declareEnd", async () => {
    const candidate = makeCandidate({ action_case: "declareEnd" });
    const rawAction = makeRawAction("declareEnd", {});
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.tempo_value).toBe(-3);
  });

  it("adds survival_risk when self active character is low HP", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(2, 3)],
    });
    const lowHpSelf = makePlayer({
      activeCharacterId: -500001,
      characters: [
        { id: -500001, variable: { health: 2, maxHealth: 10, energy: 0, maxEnergy: 3 } },
      ],
    });
    const ctx = makeCtx({ selfPlayer: lowHpSelf, rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // HP ratio = 2/10 = 0.2 <= 0.3 => +2
    expect(candidate.survival_risk).toBe(2);
  });

  it("survival_risk medium when HP 50%", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, { preview: [] });
    const halfHpSelf = makePlayer({
      activeCharacterId: -500001,
      characters: [
        { id: -500001, variable: { health: 5, maxHealth: 10, energy: 0, maxEnergy: 3 } },
      ],
    });
    const ctx = makeCtx({ selfPlayer: halfHpSelf, rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // HP ratio = 5/10 = 0.5 <= 0.5 => +1
    expect(candidate.survival_risk).toBe(1);
  });

  it("no survival_risk when HP is healthy", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, { preview: [] });
    const healthySelf = makePlayer({
      activeCharacterId: -500001,
      characters: [
        { id: -500001, variable: { health: 9, maxHealth: 10, energy: 0, maxEnergy: 3 } },
      ],
    });
    const ctx = makeCtx({ selfPlayer: healthySelf, rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.survival_risk).toBe(0);
  });

  it("enriches multiple candidates in one call", async () => {
    const c1 = makeCandidate({ candidate_id: "cand_1", action_case: "useSkill" });
    const c2 = makeCandidate({ candidate_id: "cand_2", action_case: "playCard" });
    const r1 = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(4, 3)],
    });
    const r2 = makeRawAction("playCard", { cardDefinitionId: 312018 }, {
      preview: [makeHealMutation(3)],
    });
    const ctx = makeCtx({ rawActions: [r1, r2] });

    await enricher.enrichActionCandidates([c1, c2], ctx);

    expect(c1.damage_estimate).toBe(4);
    expect(c2.damage_estimate).toBeCloseTo(2.4, 5); // 3 * 0.8
  });

  it("summon tag from preview entity creation", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21022 }, {
      preview: [
        makeDamageMutation(2, 1),
        makeCreateEntityMutation(3), // summon
      ],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("summon");
  });

  it("enriches elementalTuning with fast tag", async () => {
    const candidate = makeCandidate({ action_case: "elementalTuning" });
    const rawAction = makeRawAction("elementalTuning", {}, { isFast: true });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.tempo_value).toBe(2);
    expect((candidate.tags as string[])).toContain("fast");
  });

  it("skips candidates without matching raw actions", async () => {
    const c1 = makeCandidate({ candidate_id: "cand_1", action_case: "useSkill" });
    const c2 = makeCandidate({ candidate_id: "cand_2", action_case: "useSkill" });
    // Only 1 raw action for 2 candidates
    const r1 = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(5, 3)],
    });
    const ctx = makeCtx({ rawActions: [r1] });

    await enricher.enrichActionCandidates([c1, c2], ctx);

    expect(c1.damage_estimate).toBe(5);
    expect(c2.damage_estimate).toBe(0); // not enriched, kept default
  });

  it("fallback damage from effectText when preview shows 0", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    // No damage in preview but card effectText has "造成 2 点"
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [], // no preview mutations
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // effectText of 21021 = "造成 2 点物理伤害。" => fallback damage = 2
    expect(candidate.damage_estimate).toBe(2);
  });

  it("adds burst tag from card effectText", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21023 }, {
      preview: [makeDamageMutation(7, 1)],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("burst");
    expect(candidate.damage_estimate).toBe(7);
  });

  it("adds skill tag from card effectText", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21022 }, {
      preview: [makeDamageMutation(3, 1)],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.tags as string[])).toContain("skill");
  });

  it("skill_def_id is recorded in notes", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [makeDamageMutation(2, 3)],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect((candidate.notes as string[])).toContain("skill_def_id=21021");
  });

  describe("chooseActive enrichment", () => {
    it("tags low HP character for chooseActive", () => {
      const candidate = makeCandidate({
        candidate_id: "cand_choose_active_-500002",
        action_case: "chooseActive",
        notes: ["character_id=-500002"],
      });
      const lowHpPlayer = makePlayer({
        activeCharacterId: -500001,
        characters: [
          { id: -500001, variable: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3 } },
          { id: -500002, variable: { health: 2, maxHealth: 10, energy: 0, maxEnergy: 3 } },
        ],
      });
      const ctx = makeCtx({ selfPlayer: lowHpPlayer });

      enricher.enrichChooseActiveCandidates([candidate], ctx);

      expect((candidate.tags as string[])).toContain("low_hp");
      expect(candidate.survival_risk).toBe(3);
    });

    it("tags burst_ready character for chooseActive", () => {
      const candidate = makeCandidate({
        candidate_id: "cand_choose_active_-500002",
        action_case: "chooseActive",
        notes: ["character_id=-500002"],
      });
      const burstPlayer = makePlayer({
        activeCharacterId: -500001,
        characters: [
          { id: -500001, variable: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3 } },
          { id: -500002, variable: { health: 8, maxHealth: 10, energy: 3, maxEnergy: 3 } },
        ],
      });
      const ctx = makeCtx({ selfPlayer: burstPlayer });

      enricher.enrichChooseActiveCandidates([candidate], ctx);

      expect((candidate.tags as string[])).toContain("burst_ready");
      expect(candidate.tempo_value).toBe(2);
    });

    it("tags healthy character for chooseActive", () => {
      const candidate = makeCandidate({
        candidate_id: "cand_choose_active_-500001",
        action_case: "chooseActive",
        notes: ["character_id=-500001"],
      });
      const ctx = makeCtx(); // default: -500001 has 10/10 HP

      enricher.enrichChooseActiveCandidates([candidate], ctx);

      expect((candidate.tags as string[])).toContain("healthy");
    });
  });

  it("multiple damage element tags from preview", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [
        makeDamageMutation(2, 1), // cryo
        makeDamageMutation(3, 3), // pyro
      ],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    expect(candidate.damage_estimate).toBe(5);
    expect((candidate.tags as string[])).toContain("cryo");
    expect((candidate.tags as string[])).toContain("pyro");
  });

  it("multiple reactions sum their values", async () => {
    const candidate = makeCandidate({ action_case: "useSkill" });
    const rawAction = makeRawAction("useSkill", { skillDefinitionId: 21021 }, {
      preview: [
        makeDamageMutation(3, 1, 1), // melt
        makeDamageMutation(2, 4, 5), // electro-charged
      ],
    });
    const ctx = makeCtx({ rawActions: [rawAction] });

    await enricher.enrichActionCandidates([candidate], ctx);

    // melt=3 + electroCharged=2 = 5
    expect(candidate.reaction_value).toBe(5);
    expect((candidate.tags as string[])).toContain("melt");
    expect((candidate.tags as string[])).toContain("electroCharged");
  });
});
