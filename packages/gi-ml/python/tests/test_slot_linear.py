from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from gitcg_ml.contracts import RankingDataset
from gitcg_ml.slot_linear import (
    TrainSlotLinearRankerOptions,
    train_slot_linear_ranker,
    train_slot_linear_ranker_from_path,
)


class TrainSlotLinearRankerTests(unittest.TestCase):
    def test_trainer_learns_action_case_and_query_numeric_weights(self) -> None:
        dataset = RankingDataset.from_dict(
            {
                "dataset_id": "dataset_py_train",
                "query_groups": [
                    {
                        "query_id": "q1",
                        "context_slots": {
                            "round": 4,
                            "self_active_character_definition_id": 1411,
                            "query_numeric_slots": {
                                "late_game": 1,
                            },
                        },
                        "candidates": [
                            {
                                "candidate_id": "q1:c1",
                                "query_id": "q1",
                                "action_case": "useSkill",
                                "runtime_slots": {
                                    "candidate_tags": ["burst"],
                                    "action_definition_kind": "skill",
                                    "skill_definition_id": 2103,
                                    "actor_character_definition_id": 1411,
                                    "candidate_numeric_slots": {
                                        "energy_gap": 2,
                                    },
                                    "continuation": {
                                        "win_rate": 0.8,
                                        "score": 0.8,
                                    },
                                },
                            },
                            {
                                "candidate_id": "q1:c2",
                                "query_id": "q1",
                                "action_case": "declareEnd",
                                "runtime_slots": {
                                    "candidate_tags": ["end_turn"],
                                    "action_definition_kind": "none",
                                    "actor_character_definition_id": 1411,
                                    "candidate_numeric_slots": {
                                        "energy_gap": -1,
                                    },
                                    "continuation": {
                                        "win_rate": 0.2,
                                        "score": 0.2,
                                    },
                                },
                            },
                        ],
                        "pairwise_preferences": [
                            {
                                "query_id": "q1",
                                "candidate_a_id": "q1:c1",
                                "candidate_b_id": "q1:c2",
                                "preference_label": 1,
                                "confidence": 1,
                            }
                        ],
                    }
                ],
            }
        )

        artifact = train_slot_linear_ranker(
            dataset,
            TrainSlotLinearRankerOptions(
                epochs=60,
                learning_rate=0.1,
                l2=0.0001,
                top_candidate_tag_count=8,
                top_candidate_numeric_slot_count=8,
                top_query_numeric_slot_count=8,
            ),
        )

        self.assertEqual(artifact.artifact_type, "slot_linear_ranker.v1")
        action_case_bias = artifact.config["action_case_bias"]
        self.assertGreater(action_case_bias["useSkill"], 0)
        self.assertLess(action_case_bias["declareEnd"], 0)

        tag_bias = artifact.config["candidate_tag_bias"]
        self.assertGreater(tag_bias["burst"], 0)
        self.assertLess(tag_bias["end_turn"], 0)
        self.assertIn("skill_definition_id::2103", tag_bias)

        numeric_weights = artifact.config["candidate_numeric_slot_weights"]
        self.assertIn("continuation.win_rate", numeric_weights)
        self.assertIn("candidate_numeric_slots.energy_gap", numeric_weights)

    def test_streaming_trainer_learns_from_dataset_file(self) -> None:
        dataset_dict = {
            "dataset_id": "dataset_py_train_stream",
            "query_groups": [
                {
                    "query_id": "q1",
                    "context_slots": {
                        "round": 4,
                        "query_numeric_slots": {
                            "late_game": 1,
                        },
                    },
                    "candidates": [
                        {
                            "candidate_id": "q1:c1",
                            "query_id": "q1",
                            "action_case": "useSkill",
                            "runtime_slots": {
                                "candidate_tags": ["burst"],
                                "candidate_numeric_slots": {
                                    "energy_gap": 2,
                                },
                                "continuation": {
                                    "win_rate": 0.8,
                                },
                            },
                        },
                        {
                            "candidate_id": "q1:c2",
                            "query_id": "q1",
                            "action_case": "declareEnd",
                            "runtime_slots": {
                                "candidate_tags": ["end_turn"],
                                "candidate_numeric_slots": {
                                    "energy_gap": -1,
                                },
                                "continuation": {
                                    "win_rate": 0.2,
                                },
                            },
                        },
                    ],
                    "pairwise_preferences": [
                        {
                            "query_id": "q1",
                            "candidate_a_id": "q1:c1",
                            "candidate_b_id": "q1:c2",
                            "preference_label": 1,
                            "confidence": 1,
                        }
                    ],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_path = Path(temp_dir) / "ranking-dataset.json"
            dataset_path.write_text(json.dumps(dataset_dict), encoding="utf-8")

            artifact = train_slot_linear_ranker_from_path(
                str(dataset_path),
                TrainSlotLinearRankerOptions(
                    epochs=60,
                    learning_rate=0.1,
                    l2=0.0001,
                    top_candidate_tag_count=8,
                    top_candidate_numeric_slot_count=8,
                    top_query_numeric_slot_count=8,
                    shuffle_buffer_size=8,
                ),
            )

        self.assertEqual(artifact.artifact_type, "slot_linear_ranker.v1")
        action_case_bias = artifact.config["action_case_bias"]
        self.assertGreater(action_case_bias["useSkill"], 0)
        self.assertLess(action_case_bias["declareEnd"], 0)
        self.assertEqual(
            artifact.config["metadata"]["trainer"],
            "python_pairwise_logistic_stream.v1",
        )


if __name__ == "__main__":
    unittest.main()
