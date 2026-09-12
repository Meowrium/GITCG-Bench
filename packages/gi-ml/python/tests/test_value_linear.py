from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from gitcg_ml.contracts import ValueDataset
from gitcg_ml.value_linear import (
    TrainLinearValueModelOptions,
    predict_value_artifact,
    train_linear_value_model,
    train_linear_value_model_from_path,
)


class TrainLinearValueModelTests(unittest.TestCase):
    def test_trainer_learns_positive_and_negative_feature_weights(self) -> None:
        dataset = ValueDataset.from_dict(
            {
                "dataset_id": "value_py_train",
                "samples": [
                    {
                        "sample_id": "s1",
                        "source": "self_play",
                        "target_value": 1,
                        "feature_slots": {
                            "self": {"hand_count": 5, "dice_count": 8},
                            "derived": {"self_resource_score": 7, "opp_resource_score": 1},
                        },
                    },
                    {
                        "sample_id": "s2",
                        "source": "self_play",
                        "target_value": 0,
                        "feature_slots": {
                            "self": {"hand_count": 1, "dice_count": 1},
                            "derived": {"self_resource_score": 1, "opp_resource_score": 6},
                        },
                    },
                    {
                        "sample_id": "s3",
                        "source": "self_play",
                        "target_value": 0.9,
                        "feature_slots": {
                            "self": {"hand_count": 4, "dice_count": 6},
                            "derived": {"self_resource_score": 5, "opp_resource_score": 2},
                        },
                    },
                ],
            }
        )

        artifact = train_linear_value_model(
            dataset,
            TrainLinearValueModelOptions(
                epochs=80,
                learning_rate=0.08,
                l2=0.0001,
                top_feature_count=8,
            ),
        )

        self.assertEqual(artifact.artifact_type, "linear_value_baseline.v1")
        weights = artifact.feature_weights
        self.assertGreater(weights["self.hand_count"], 0)
        self.assertGreater(weights["derived.self_resource_score"], 0)
        self.assertLess(weights["derived.opp_resource_score"], 0)

        sample_a = dataset.samples[0].feature_slots or {}
        sample_b = dataset.samples[1].feature_slots or {}
        self.assertGreater(
            predict_value_artifact(artifact, sample_a),
            predict_value_artifact(artifact, sample_b),
        )

    def test_streaming_trainer_learns_from_dataset_file(self) -> None:
        dataset_dict = {
            "dataset_id": "value_py_train_stream",
            "samples": [
                {
                    "sample_id": "s1",
                    "source": "self_play",
                    "target_value": 1,
                    "feature_slots": {
                        "self": {"hand_count": 5, "dice_count": 8},
                        "derived": {"self_resource_score": 7, "opp_resource_score": 1},
                    },
                },
                {
                    "sample_id": "s2",
                    "source": "self_play",
                    "target_value": 0,
                    "feature_slots": {
                        "self": {"hand_count": 1, "dice_count": 1},
                        "derived": {"self_resource_score": 1, "opp_resource_score": 6},
                    },
                },
                {
                    "sample_id": "s3",
                    "source": "self_play",
                    "target_value": 0.9,
                    "feature_slots": {
                        "self": {"hand_count": 4, "dice_count": 6},
                        "derived": {"self_resource_score": 5, "opp_resource_score": 2},
                    },
                },
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_path = Path(temp_dir) / "value-dataset.json"
            dataset_path.write_text(json.dumps(dataset_dict), encoding="utf-8")

            artifact = train_linear_value_model_from_path(
                str(dataset_path),
                TrainLinearValueModelOptions(
                    epochs=80,
                    learning_rate=0.08,
                    l2=0.0001,
                    top_feature_count=8,
                ),
            )

        self.assertEqual(artifact.artifact_type, "linear_value_baseline.v1")
        self.assertEqual(
            artifact.metadata["trainer"],
            "python_logistic_value_stream.v1",
        )
        weights = artifact.feature_weights
        self.assertGreater(weights["self.hand_count"], 0)
        self.assertGreater(weights["derived.self_resource_score"], 0)
        self.assertLess(weights["derived.opp_resource_score"], 0)


if __name__ == "__main__":
    unittest.main()
