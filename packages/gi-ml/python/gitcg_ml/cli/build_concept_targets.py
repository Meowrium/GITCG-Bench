from __future__ import annotations

import argparse

from ..concept_targets import build_concept_target_dataset
from ..contracts import RankingDataset
from ..json_io import read_json, write_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build concept target annotations from a concept bank and ranking dataset.",
    )
    parser.add_argument("--dataset", required=True, help="Path to MlRankingDataset JSON")
    parser.add_argument("--concept-bank", required=True, help="Path to concept bank JSON")
    parser.add_argument("--output", required=True, help="Path to output concept target dataset JSON")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    ranking_dataset = RankingDataset.from_dict(read_json(args.dataset))
    concept_bank = read_json(args.concept_bank)
    target_dataset = build_concept_target_dataset(ranking_dataset, concept_bank)
    output_path = write_json(args.output, target_dataset.to_dict())
    print(f"Concept target dataset written: {output_path}")
    print(f"annotation_count={len(target_dataset.annotations)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
