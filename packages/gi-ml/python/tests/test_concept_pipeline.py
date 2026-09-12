from __future__ import annotations

import unittest

from gitcg_ml.concept_model import TrainConceptModelOptions, train_concept_model
from gitcg_ml.concept_targets import build_concept_target_dataset
from gitcg_ml.contracts import RankingDataset


class ConceptPipelineTests(unittest.TestCase):
    def test_build_targets_and_train_concept_model(self) -> None:
        ranking_dataset = RankingDataset.from_dict(
            {
                "dataset_id": "dataset_concept",
                "query_groups": [
                    {
                        "query_id": "q1",
                        "state_ref": "state:q1",
                        "context_slots": {
                            "round": 5,
                            "query_numeric_slots": {
                                "pressure": 1,
                            },
                        },
                        "candidates": [
                            {
                                "candidate_id": "q1:c1",
                                "query_id": "q1",
                                "action_case": "useSkill",
                                "runtime_slots": {
                                    "action_definition_kind": "skill",
                                    "skill_definition_id": 2103,
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["burst"],
                                    "continuation": {"score": 0.8},
                                },
                            },
                            {
                                "candidate_id": "q1:c2",
                                "query_id": "q1",
                                "action_case": "declareEnd",
                                "runtime_slots": {
                                    "action_definition_kind": "none",
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["end_turn"],
                                    "continuation": {"score": 0.2},
                                },
                            },
                        ],
                    }
                ],
            }
        )
        concept_bank = {
            "bank_version": "bank_v1",
            "concepts": [
                {
                    "concept_id": "concept:burst-window",
                    "name": "burst-window",
                    "scope": "state_action",
                    "description": "burst action candidate",
                    "evidence_refs": ["ref:1"],
                    "status": "validated",
                    "estimator_slot": {
                        "all_of": [
                            {
                                "action_case": "useSkill",
                            },
                            {
                                "candidate_tag": "burst",
                            },
                        ],
                    },
                },
                {
                    "concept_id": "concept:late-round",
                    "name": "late-round",
                    "scope": "state",
                    "description": "late round state",
                    "evidence_refs": ["ref:2"],
                    "status": "validated",
                    "estimator_slot": {
                        "query_numeric_path": "round",
                        "comparison": "gte",
                        "threshold": 4,
                    },
                },
            ],
        }

        concept_targets = build_concept_target_dataset(ranking_dataset, concept_bank)
        self.assertEqual(len(concept_targets.annotations), 3)

        artifact = train_concept_model(
            concept_target_dataset=concept_targets.to_dict(),
            ranking_dataset=ranking_dataset,
            concept_bank=concept_bank,
            options=TrainConceptModelOptions(
                epochs=40,
                learning_rate=0.1,
                top_feature_count=8,
            ),
        )

        self.assertEqual(artifact["artifact_type"], "concept_model.linear.v1")
        self.assertEqual(len(artifact["concepts"]), 2)
        burst_payload = next(
            item for item in artifact["concepts"] if item["concept_id"] == "concept:burst-window"
        )
        self.assertGreater(burst_payload["training_example_count"], 0)
        self.assertTrue(any("tag::burst" in key for key in burst_payload["feature_weights"]))

    def test_build_targets_supports_two_step_combo_patterns(self) -> None:
        ranking_dataset = RankingDataset.from_dict(
            {
                "dataset_id": "dataset_combo",
                "query_groups": [
                    {
                        "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
                        "state_ref": "state:q0",
                        "context_slots": {
                            "policy_selected_action_index": 1,
                            "policy_selected_action_type": "elementalTuning",
                        },
                        "candidates": [
                            {
                                "candidate_id": "q0:c1",
                                "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
                                "action_case": "elementalTuning",
                                "runtime_slots": {
                                    "branch_action_index": 1,
                                    "action_definition_kind": "card",
                                    "card_definition_id": 215001,
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["dice_fix"],
                                },
                            },
                            {
                                "candidate_id": "q0:c2",
                                "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
                                "action_case": "useSkill",
                                "runtime_slots": {
                                    "branch_action_index": 2,
                                    "action_definition_kind": "skill",
                                    "skill_definition_id": 2102,
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["energy"],
                                },
                            },
                        ],
                    },
                    {
                        "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_11:point_1",
                        "state_ref": "state:q1",
                        "context_slots": {
                            "policy_selected_action_index": 3,
                            "policy_selected_action_type": "useSkill",
                        },
                        "candidates": [
                            {
                                "candidate_id": "q1:c1",
                                "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_11:point_1",
                                "action_case": "useSkill",
                                "runtime_slots": {
                                    "branch_action_index": 3,
                                    "action_definition_kind": "skill",
                                    "skill_definition_id": 2102,
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["energy"],
                                },
                            }
                        ],
                    },
                    {
                        "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_12:point_3",
                        "state_ref": "state:q2",
                        "context_slots": {
                            "policy_selected_action_index": 4,
                            "policy_selected_action_type": "useSkill",
                        },
                        "candidates": [
                            {
                                "candidate_id": "q2:c1",
                                "query_id": "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_12:point_3",
                                "action_case": "useSkill",
                                "runtime_slots": {
                                    "branch_action_index": 4,
                                    "action_definition_kind": "skill",
                                    "skill_definition_id": 2103,
                                    "actor_character_definition_id": 1411,
                                    "candidate_tags": ["burst"],
                                },
                            }
                        ],
                    },
                ],
            }
        )
        concept_bank = {
            "bank_version": "bank_combo_v1",
            "concepts": [
                {
                    "concept_id": "concept:combo-setup-burst",
                    "name": "combo-setup-burst",
                    "scope": "window",
                    "description": "dice fix into skill",
                    "evidence_refs": ["ref:combo"],
                    "status": "validated",
                    "estimator_slot": {
                        "kind": "combo_pattern.v1",
                        "in_order": [
                            {
                                "all_of": [
                                    {"action_case": "elementalTuning"},
                                    {"action_definition_kind": "card"},
                                    {"card_definition_id": 215001},
                                    {"actor_character_definition_id": 1411},
                                    {"candidate_tag": "dice_fix"},
                                ]
                            },
                            {
                                "all_of": [
                                    {"action_case": "useSkill"},
                                    {"action_definition_kind": "skill"},
                                    {"skill_definition_id": 2102},
                                    {"actor_character_definition_id": 1411},
                                    {"candidate_tag": "energy"},
                                ]
                            },
                            {
                                "all_of": [
                                    {"action_case": "useSkill"},
                                    {"action_definition_kind": "skill"},
                                    {"skill_definition_id": 2103},
                                    {"actor_character_definition_id": 1411},
                                    {"candidate_tag": "burst"},
                                ]
                            },
                        ],
                        "max_step_gap": 3,
                    },
                }
            ],
        }

        concept_targets = build_concept_target_dataset(ranking_dataset, concept_bank)

        self.assertEqual(len(concept_targets.annotations), 3)
        first_annotation = concept_targets.annotations[0]
        second_annotation = concept_targets.annotations[1]
        third_annotation = concept_targets.annotations[2]
        self.assertTrue(first_annotation.label_slot["binary"])
        self.assertFalse(second_annotation.label_slot["binary"])
        self.assertFalse(third_annotation.label_slot["binary"])

        artifact = train_concept_model(
            concept_target_dataset=concept_targets.to_dict(),
            ranking_dataset=ranking_dataset,
            concept_bank=concept_bank,
            options=TrainConceptModelOptions(
                epochs=20,
                learning_rate=0.1,
                top_feature_count=8,
            ),
        )

        self.assertEqual(artifact["artifact_type"], "concept_model.linear.v1")
        self.assertEqual(len(artifact["concepts"]), 1)
        combo_payload = artifact["concepts"][0]
        self.assertEqual(combo_payload["scope"], "window")
        self.assertGreater(combo_payload["training_example_count"], 0)


if __name__ == "__main__":
    unittest.main()
