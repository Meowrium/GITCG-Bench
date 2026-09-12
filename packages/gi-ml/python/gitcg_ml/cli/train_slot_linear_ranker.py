from __future__ import annotations

import argparse

from ..json_io import write_json
from ..slot_linear import (
    TrainSlotLinearRankerOptions,
    train_slot_linear_ranker_from_path,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train a slot-linear ranker artifact from an MlRankingDataset JSON file.",
    )
    parser.add_argument("--input", required=True, help="Path to MlRankingDataset JSON")
    parser.add_argument("--output", required=True, help="Path to output artifact JSON")
    parser.add_argument("--version", default="", help="Artifact version override")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--learning-rate", type=float, default=0.08)
    parser.add_argument("--l2", type=float, default=0.0005)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--top-tags", type=int, default=48)
    parser.add_argument("--top-candidate-slots", type=int, default=48)
    parser.add_argument("--top-query-slots", type=int, default=24)
    parser.add_argument("--shuffle-buffer-size", type=int, default=4096)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    artifact = train_slot_linear_ranker_from_path(
        args.input,
        TrainSlotLinearRankerOptions(
            artifact_version=args.version or None,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            l2=args.l2,
            seed=args.seed,
            top_candidate_tag_count=args.top_tags,
            top_candidate_numeric_slot_count=args.top_candidate_slots,
            top_query_numeric_slot_count=args.top_query_slots,
            shuffle_buffer_size=args.shuffle_buffer_size,
        ),
    )
    output_path = write_json(args.output, artifact.to_dict())
    print(f"Python slot-linear ranker artifact written: {output_path}")
    print(f"artifact_version={artifact.artifact_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
