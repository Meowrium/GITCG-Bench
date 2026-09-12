from __future__ import annotations

import argparse

from ..json_io import write_json
from ..value_linear import (
    TrainLinearValueModelOptions,
    train_linear_value_model_from_path,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train a linear value artifact from an MlValueDataset JSON file.",
    )
    parser.add_argument("--input", required=True, help="Path to MlValueDataset JSON")
    parser.add_argument("--output", required=True, help="Path to output artifact JSON")
    parser.add_argument("--version", default="", help="Artifact version override")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--l2", type=float, default=0.0005)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--top-features", type=int, default=64)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    artifact = train_linear_value_model_from_path(
        args.input,
        TrainLinearValueModelOptions(
            artifact_version=args.version or None,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            l2=args.l2,
            seed=args.seed,
            top_feature_count=args.top_features,
        ),
    )
    output_path = write_json(args.output, artifact.to_dict())
    print(f"Python linear value artifact written: {output_path}")
    print(f"artifact_version={artifact.artifact_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
