import { expect, test } from "vitest"
import { extractStaticEffectSeedConceptsFromRankingDataset } from "./static-effect-seeds.js"

test("extractStaticEffectSeedConceptsFromRankingDataset emits static-effect seeds", () => {
  const concepts = extractStaticEffectSeedConceptsFromRankingDataset({
    dataset_id: "ranking_static_seed",
    query_groups: [
      {
        query_id: "q1",
        candidates: [
          {
            candidate_id: "c1",
            query_id: "q1",
            action_case: "playCard",
            runtime_slots: {
              candidate_tags: ["card", "support_create", "entity:support"],
              candidate_numeric_slots: {
                meta_effect_slots: {
                  setup_dependency: 1,
                },
              },
            },
          },
        ],
      },
      {
        query_id: "q2",
        candidates: [
          {
            candidate_id: "c2",
            query_id: "q2",
            action_case: "playCard",
            runtime_slots: {
              candidate_tags: ["card", "support_create", "entity:support"],
              candidate_numeric_slots: {
                meta_effect_slots: {
                  setup_dependency: 2,
                },
              },
            },
          },
        ],
      },
    ],
  })

  const supportSeed = concepts.find((concept) => concept.concept_id === "concept:static-effect:support_create")
  const metaSeed = concepts.find((concept) =>
    concept.concept_id === "concept:static-meta:candidate_numeric_slots_meta_effect_slots_setup_dependency",
  )

  expect(supportSeed?.source).toBe("static_effect_seed")
  expect(supportSeed?.status).toBe("draft")
  expect(supportSeed?.tags).toContain("support_create")
  expect(metaSeed?.ranking_slot).toEqual({
    source_kind: "static_effect_seed",
    seed_support_count: 2,
    seed_meta_slot_paths: ["candidate_numeric_slots.meta_effect_slots.setup_dependency"],
  })
})
