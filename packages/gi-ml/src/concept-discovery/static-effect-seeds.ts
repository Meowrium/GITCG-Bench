import type {
  MlCandidateAction,
  MlConceptHypothesis,
  MlRankingDataset,
  MlRankingQueryGroup,
  SlotValue,
} from "../contracts/index.js"

export interface StaticEffectSeedOptions {
  minSupport?: number
  maxEvidenceRefsPerConcept?: number
}

interface SeedRecord {
  concept_id: string
  name: string
  description: string
  tags: Set<string>
  evidence_refs: Set<string>
  ranking_paths: Set<string>
  support_count: number
}

export function extractStaticEffectSeedConceptsFromRankingDataset(
  dataset: MlRankingDataset,
  options: StaticEffectSeedOptions = {},
): MlConceptHypothesis[] {
  return extractStaticEffectSeedConceptsFromRankingQueryGroups(dataset.query_groups, options)
}

export function extractStaticEffectSeedConceptsFromRankingQueryGroups(
  queryGroups: Iterable<MlRankingQueryGroup>,
  options: StaticEffectSeedOptions = {},
): MlConceptHypothesis[] {
  const collector = createStaticEffectSeedCollector(options)
  for (const group of queryGroups) {
    collector.addQueryGroup(group)
  }
  return collector.build()
}

export function createStaticEffectSeedCollector(options: StaticEffectSeedOptions = {}) {
  const minSupport = options.minSupport ?? 2
  const maxEvidenceRefs = options.maxEvidenceRefsPerConcept ?? 8
  const seeds = new Map<string, SeedRecord>()

  return {
    addQueryGroup(group: MlRankingQueryGroup) {
      collectSeedsFromQueryGroup(group, seeds)
    },
    build(): MlConceptHypothesis[] {
      return buildConceptsFromSeeds(seeds, minSupport, maxEvidenceRefs)
    },
  }
}

function collectSeedsFromQueryGroup(
  group: MlRankingQueryGroup,
  seeds: Map<string, SeedRecord>,
): void {
  for (const candidate of group.candidates) {
    const candidateTags = extractStringArray(candidate.runtime_slots?.candidate_tags)
    const staticTags = candidateTags.filter((tag) =>
      isStaticSeedTag(tag),
    )
    const metaSlotPaths = flattenNumericPaths(candidate.runtime_slots?.candidate_numeric_slots, "candidate_numeric_slots")
      .filter((path) =>
        path.includes("meta_effect_slots.") || path.includes("synergy_slots."),
      )

    for (const tag of staticTags) {
      const conceptId = `concept:static-effect:${normalizeSeedId(tag)}`
      const record = getOrCreateSeed(seeds, conceptId, {
        name: `static-effect:${tag}`,
        description: `Static effect seed derived from candidate tag '${tag}'.`,
        defaultTags: ["static_effect_seed", "effect_family", tag],
      })
      record.support_count += 1
      record.evidence_refs.add(`query:${group.query_id}`)
      record.tags.add(`action_case:${candidate.action_case}`)
    }

    for (const path of metaSlotPaths) {
      const conceptId = `concept:static-meta:${normalizeSeedId(path)}`
      const record = getOrCreateSeed(seeds, conceptId, {
        name: `static-meta:${path}`,
        description: `Static effect seed derived from numeric slot '${path}'.`,
        defaultTags: ["static_effect_seed", "meta_effect_slot"],
      })
      record.support_count += 1
      record.evidence_refs.add(`query:${group.query_id}`)
      record.ranking_paths.add(path)
      record.tags.add(`action_case:${candidate.action_case}`)
    }
  }
}

function buildConceptsFromSeeds(
  seeds: ReadonlyMap<string, SeedRecord>,
  minSupport: number,
  maxEvidenceRefs: number,
): MlConceptHypothesis[] {
  return [...seeds.values()]
    .filter((record) => record.support_count >= minSupport)
    .map((record): MlConceptHypothesis => ({
      concept_id: record.concept_id,
      name: record.name,
      scope: "state_action",
      description: record.description,
      evidence_refs: [...record.evidence_refs].sort().slice(0, maxEvidenceRefs),
      tags: [...record.tags].sort(),
      ranking_slot: buildRankingSlot(record),
      validation_slot: {
        source_kind: "static_effect_seed",
        min_support: minSupport,
        observed_support: record.support_count,
      },
      status: "draft",
      source: "static_effect_seed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    .sort((left, right) => left.concept_id.localeCompare(right.concept_id))
}

function getOrCreateSeed(
  seeds: Map<string, SeedRecord>,
  conceptId: string,
  input: {
    name: string
    description: string
    defaultTags: string[]
  },
): SeedRecord {
  const existing = seeds.get(conceptId)
  if (existing) {
    return existing
  }
  const created: SeedRecord = {
    concept_id: conceptId,
    name: input.name,
    description: input.description,
    tags: new Set(input.defaultTags),
    evidence_refs: new Set<string>(),
    ranking_paths: new Set<string>(),
    support_count: 0,
  }
  seeds.set(conceptId, created)
  return created
}

function buildRankingSlot(record: SeedRecord): SlotValue {
  return {
    source_kind: "static_effect_seed",
    seed_support_count: record.support_count,
    seed_meta_slot_paths: [...record.ranking_paths].sort(),
  }
}

function extractStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
}

function flattenNumericPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return []
  }
  const result: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === "number" && Number.isFinite(child)) {
      result.push(path)
      continue
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      result.push(...flattenNumericPaths(child, path))
    }
  }
  return result
}

function isStaticSeedTag(tag: string): boolean {
  return !tag.startsWith("action:") &&
    !tag.startsWith("family:") &&
    !tag.startsWith("pending:") &&
    !tag.startsWith("route:") &&
    !tag.startsWith("actor_character_definition_id::") &&
    !tag.startsWith("card_definition_id::") &&
    !tag.startsWith("skill_definition_id::") &&
    !tag.startsWith("character_definition_id::")
}

function normalizeSeedId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}
