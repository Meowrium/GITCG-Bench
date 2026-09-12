from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gitcg_ml.value_dataset_stream import (
    iter_value_sample_dicts,
    read_value_dataset_id,
)


class ValueDatasetStreamTests(unittest.TestCase):
    def test_stream_reader_extracts_dataset_id_and_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "value-dataset.json"
            path.write_text(
                json.dumps(
                    {
                        "dataset_id": "stream_value_dataset",
                        "created_at": "2026-04-04T00:00:00Z",
                        "metadata": {"source": "test"},
                        "samples": [
                            {"sample_id": "s1", "source": "self_play", "target_value": 1},
                            {"sample_id": "s2", "source": "self_play", "target_value": 0},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(read_value_dataset_id(path), "stream_value_dataset")
            samples = list(iter_value_sample_dicts(path))
            self.assertEqual(len(samples), 2)
            self.assertEqual(samples[0]["sample_id"], "s1")
            self.assertEqual(samples[1]["sample_id"], "s2")


if __name__ == "__main__":
    unittest.main()
