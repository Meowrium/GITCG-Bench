from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gitcg_ml.ranking_dataset_stream import (
    iter_ranking_query_group_dicts,
    read_ranking_dataset_id,
)


class RankingDatasetStreamTests(unittest.TestCase):
    def test_stream_reader_extracts_dataset_id_and_query_groups(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "ranking-dataset.json"
            path.write_text(
                json.dumps(
                    {
                        "dataset_id": "stream_dataset",
                        "created_at": "2026-04-03T00:00:00Z",
                        "metadata": {"source": "test"},
                        "query_groups": [
                            {"query_id": "q1", "candidates": [], "pairwise_preferences": []},
                            {"query_id": "q2", "candidates": [], "pairwise_preferences": []},
                        ],
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(read_ranking_dataset_id(path), "stream_dataset")
            groups = list(iter_ranking_query_group_dicts(path))
            self.assertEqual(len(groups), 2)
            self.assertEqual(groups[0]["query_id"], "q1")
            self.assertEqual(groups[1]["query_id"], "q2")


if __name__ == "__main__":
    unittest.main()
