from __future__ import annotations

import argparse

from ..concept_model import TrainConceptModelOptions, train_concept_model
from ..contracts import RankingDataset
from ..json_io import read_json, write_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train a lightweight concept model from concept targets and ranking dataset.",
    )
    parser.add_argument("--dataset", required=True, help="Path to MlRankingDataset JSON")
    parser.add_argument("--concept-bank", required=True, help="Path to concept bank JSON")
    parser.add_argument("--concept-targets", required=True, help="Path to concept target dataset JSON")
    parser.add_argument("--output", required=True, help="Path to output concept model JSON")
    parser.add_argument("--version", default="", help="Artifact version override")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--learning-rate", type=float, default=0.08)
    parser.add_argument("--l2", type=float, default=0.0005)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--top-features", type=int, default=24)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    ranking_dataset = RankingDataset.from_dict(read_json(args.dataset))
    concept_bank = read_json(args.concept_bank)
    concept_targets = read_json(args.concept_targets)
    artifact = train_concept_model(
        concept_target_dataset=concept_targets,
        ranking_dataset=ranking_dataset,
        concept_bank=concept_bank,
        options=TrainConceptModelOptions(
            artifact_version=args.version or None,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            l2=args.l2,
            seed=args.seed,
            top_feature_count=args.top_features,
        ),
    )
    output_path = write_json(args.output, artifact)
    print(f"Concept model artifact written: {output_path}")
    print(f"artifact_version={artifact['artifact_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
