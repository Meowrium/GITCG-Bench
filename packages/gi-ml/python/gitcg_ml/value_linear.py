from __future__ import annotations

from dataclasses import dataclass
import math
import random
from typing import Any, Callable, Iterable, Iterator

from .contracts import LinearValueArtifact, ValueDataset, ValueSample, utc_now_iso
from .value_dataset_stream import iter_value_sample_dicts, read_value_dataset_id


@dataclass(slots=True)
class TrainLinearValueModelOptions:
    artifact_version: str | None = None
    epochs: int = 40
    learning_rate: float = 0.05
    l2: float = 0.0005
    seed: int = 17
    top_feature_count: int = 64


@dataclass(slots=True)
class ValueExample:
    features: dict[str, float]
    target: float
    weight: float


def train_linear_value_model(
    dataset: ValueDataset,
    options: TrainLinearValueModelOptions | None = None,
) -> LinearValueArtifact:
    options = options or TrainLinearValueModelOptions()
    examples = build_value_examples(dataset)
    bias, weights = fit_logistic_value_model(examples, options)
    weights = trim_weight_map(weights, options.top_feature_count)

    return LinearValueArtifact(
        artifact_type="linear_value_baseline.v1",
        artifact_version=options.artifact_version or f"python_{dataset.dataset_id}",
        created_at=utc_now_iso(),
        bias=bias,
        feature_weights=sort_weight_map(weights),
        metadata={
            "dataset_id": dataset.dataset_id,
            "sample_count": len(dataset.samples),
            "trainer": "python_logistic_value.v1",
            "epochs": options.epochs,
            "learning_rate": options.learning_rate,
            "l2": options.l2,
            "seed": options.seed,
        },
    )


def train_linear_value_model_from_path(
    dataset_path: str,
    options: TrainLinearValueModelOptions | None = None,
) -> LinearValueArtifact:
    options = options or TrainLinearValueModelOptions()
    dataset_id = read_value_dataset_id(dataset_path)

    def sample_factory() -> Iterator[ValueSample]:
        for value in iter_value_sample_dicts(dataset_path):
            yield ValueSample.from_dict(value)

    bias, weights, sample_count = fit_logistic_value_model_streaming(
        sample_factory,
        options,
    )
    weights = trim_weight_map(weights, options.top_feature_count)

    return LinearValueArtifact(
        artifact_type="linear_value_baseline.v1",
        artifact_version=options.artifact_version or f"python_{dataset_id}",
        created_at=utc_now_iso(),
        bias=bias,
        feature_weights=sort_weight_map(weights),
        metadata={
            "dataset_id": dataset_id,
            "sample_count": sample_count,
            "trainer": "python_logistic_value_stream.v1",
            "epochs": options.epochs,
            "learning_rate": options.learning_rate,
            "l2": options.l2,
            "seed": options.seed,
        },
    )


def predict_value_artifact(artifact: LinearValueArtifact, feature_slots: dict[str, Any]) -> float:
    flattened = flatten_numeric_dict(feature_slots)
    margin = float(artifact.bias)
    for key, weight in artifact.feature_weights.items():
        numeric_weight = coerce_numeric(weight)
        if numeric_weight is None:
            continue
        margin += flattened.get(key, 0.0) * numeric_weight
    return sigmoid(margin)


def build_value_examples(dataset: ValueDataset) -> list[ValueExample]:
    return list(iter_value_examples_from_samples(dataset.samples))


def iter_value_examples_from_samples(samples: Iterable[ValueSample]) -> Iterator[ValueExample]:
    for sample in samples:
        feature_slots = sample.feature_slots or {}
        flattened = flatten_numeric_dict(feature_slots)
        if not flattened:
            continue
        yield ValueExample(
            features=flattened,
            target=max(0.0, min(1.0, float(sample.target_value))),
            weight=max(float(sample.weight or 1.0), 0.05),
        )


def fit_logistic_value_model(
    examples: list[ValueExample],
    options: TrainLinearValueModelOptions,
) -> tuple[float, dict[str, float]]:
    if not examples:
        return 0.0, {}

    rng = random.Random(options.seed)
    weights: dict[str, float] = {}
    bias = 0.0
    shuffled = examples[:]

    for _ in range(options.epochs):
        rng.shuffle(shuffled)
        for example in shuffled:
            margin = bias + sum(weights.get(key, 0.0) * value for key, value in example.features.items())
            prediction = sigmoid(margin)
            error = (prediction - example.target) * example.weight
            bias -= options.learning_rate * error
            for key, value in example.features.items():
                current = weights.get(key, 0.0)
                gradient = error * value + options.l2 * current
                updated = current - options.learning_rate * gradient
                if updated != 0.0:
                    weights[key] = updated

    return bias, weights


def fit_logistic_value_model_streaming(
    sample_factory: Callable[[], Iterator[ValueSample]],
    options: TrainLinearValueModelOptions,
) -> tuple[float, dict[str, float], int]:
    rng = random.Random(options.seed)
    weights: dict[str, float] = {}
    bias = 0.0
    sample_count = 0

    for epoch in range(options.epochs):
        examples = list(iter_value_examples_from_samples(sample_factory()))
        rng.shuffle(examples)
        if epoch == 0:
            sample_count = len(examples)
        for example in examples:
            margin = bias + sum(weights.get(key, 0.0) * value for key, value in example.features.items())
            prediction = sigmoid(margin)
            error = (prediction - example.target) * example.weight
            bias -= options.learning_rate * error
            for key, value in example.features.items():
                current = weights.get(key, 0.0)
                gradient = error * value + options.l2 * current
                updated = current - options.learning_rate * gradient
                if updated != 0.0:
                    weights[key] = updated

    return bias, weights, sample_count


def flatten_numeric_dict(value: dict[str, Any], prefix: str = "") -> dict[str, float]:
    result: dict[str, float] = {}
    for key, child in value.items():
        path = f"{prefix}.{key}" if prefix else key
        numeric = coerce_numeric(child)
        if numeric is not None:
            result[path] = numeric
            continue
        if isinstance(child, dict):
            result.update(flatten_numeric_dict(child, path))
    return result


def coerce_numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def sigmoid(value: float) -> float:
    if value >= 0:
        exp = math.exp(-value)
        return 1.0 / (1.0 + exp)
    exp = math.exp(value)
    return exp / (1.0 + exp)


def trim_weight_map(value: dict[str, float], top_count: int) -> dict[str, float]:
    if top_count <= 0:
        return {}
    ordered = sorted(
        value.items(),
        key=lambda item: (-abs(item[1]), item[0]),
    )[:top_count]
    return {key: weight for key, weight in ordered}


def sort_weight_map(value: dict[str, float]) -> dict[str, float]:
    return {key: value[key] for key in sorted(value)}
