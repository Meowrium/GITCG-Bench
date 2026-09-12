from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import math
import random
from typing import Any, Callable, Iterable, Iterator

from .contracts import (
    CandidateAction,
    PairwisePreference,
    RankingDataset,
    RankingQueryGroup,
    SlotLinearRankerArtifact,
    utc_now_iso,
)
from .ranking_dataset_stream import (
    iter_ranking_query_group_dicts,
    read_ranking_dataset_id,
)


@dataclass(slots=True)
class TrainSlotLinearRankerOptions:
    artifact_version: str | None = None
    epochs: int = 25
    learning_rate: float = 0.08
    l2: float = 0.0005
    seed: int = 17
    top_candidate_tag_count: int = 48
    top_candidate_numeric_slot_count: int = 48
    top_query_numeric_slot_count: int = 24
    shuffle_buffer_size: int = 4096


@dataclass(slots=True)
class PairwiseExample:
    features: dict[str, float]
    confidence: float


def train_slot_linear_ranker(
    dataset: RankingDataset,
    options: TrainSlotLinearRankerOptions | None = None,
) -> SlotLinearRankerArtifact:
    options = options or TrainSlotLinearRankerOptions()
    examples = build_pairwise_examples(dataset)
    weights = fit_pairwise_logistic(examples, options)

    action_case_bias: dict[str, float] = {}
    candidate_tag_bias: dict[str, float] = {}
    candidate_numeric_slot_weights: dict[str, float] = {}
    query_numeric_slot_weights: dict[str, float] = {}

    for key, weight in weights.items():
        if weight == 0:
            continue
        if key.startswith("action_case::"):
            action_case_bias[key.removeprefix("action_case::")] = weight
        elif key.startswith("candidate_tag::"):
            candidate_tag_bias[key.removeprefix("candidate_tag::")] = weight
        elif key.startswith("candidate_numeric::"):
            candidate_numeric_slot_weights[key.removeprefix("candidate_numeric::")] = weight
        elif key.startswith("query_numeric::"):
            query_numeric_slot_weights[key.removeprefix("query_numeric::")] = weight

    candidate_tag_bias = trim_weight_map(candidate_tag_bias, options.top_candidate_tag_count)
    candidate_numeric_slot_weights = trim_weight_map(
        candidate_numeric_slot_weights,
        options.top_candidate_numeric_slot_count,
    )
    query_numeric_slot_weights = trim_weight_map(
        query_numeric_slot_weights,
        options.top_query_numeric_slot_count,
    )

    config: dict[str, Any] = {
        "action_case_bias": sort_weight_map(action_case_bias),
        "candidate_tag_bias": sort_weight_map(candidate_tag_bias),
        "candidate_numeric_slot_weights": sort_weight_map(candidate_numeric_slot_weights),
        "query_numeric_slot_weights": sort_weight_map(query_numeric_slot_weights),
        "metadata": {
            "dataset_id": dataset.dataset_id,
            "query_count": len(dataset.query_groups),
            "pairwise_example_count": len(examples),
            "trainer": "python_pairwise_logistic.v1",
            "epochs": options.epochs,
            "learning_rate": options.learning_rate,
            "l2": options.l2,
            "seed": options.seed,
        },
    }

    return SlotLinearRankerArtifact(
        artifact_type="slot_linear_ranker.v1",
        artifact_version=options.artifact_version or f"python_{dataset.dataset_id}",
        created_at=utc_now_iso(),
        compatibility=None,
        config=config,
    )


def train_slot_linear_ranker_from_path(
    dataset_path: str,
    options: TrainSlotLinearRankerOptions | None = None,
) -> SlotLinearRankerArtifact:
    options = options or TrainSlotLinearRankerOptions()
    dataset_id = read_ranking_dataset_id(dataset_path)

    def query_group_factory() -> Iterator[RankingQueryGroup]:
        for value in iter_ranking_query_group_dicts(dataset_path):
            yield RankingQueryGroup.from_dict(value)

    weights, query_count, pairwise_example_count = fit_pairwise_logistic_streaming(
        query_group_factory,
        options,
    )

    action_case_bias: dict[str, float] = {}
    candidate_tag_bias: dict[str, float] = {}
    candidate_numeric_slot_weights: dict[str, float] = {}
    query_numeric_slot_weights: dict[str, float] = {}

    for key, weight in weights.items():
        if weight == 0:
            continue
        if key.startswith("action_case::"):
            action_case_bias[key.removeprefix("action_case::")] = weight
        elif key.startswith("candidate_tag::"):
            candidate_tag_bias[key.removeprefix("candidate_tag::")] = weight
        elif key.startswith("candidate_numeric::"):
            candidate_numeric_slot_weights[key.removeprefix("candidate_numeric::")] = weight
        elif key.startswith("query_numeric::"):
            query_numeric_slot_weights[key.removeprefix("query_numeric::")] = weight

    candidate_tag_bias = trim_weight_map(candidate_tag_bias, options.top_candidate_tag_count)
    candidate_numeric_slot_weights = trim_weight_map(
        candidate_numeric_slot_weights,
        options.top_candidate_numeric_slot_count,
    )
    query_numeric_slot_weights = trim_weight_map(
        query_numeric_slot_weights,
        options.top_query_numeric_slot_count,
    )

    config: dict[str, Any] = {
        "action_case_bias": sort_weight_map(action_case_bias),
        "candidate_tag_bias": sort_weight_map(candidate_tag_bias),
        "candidate_numeric_slot_weights": sort_weight_map(candidate_numeric_slot_weights),
        "query_numeric_slot_weights": sort_weight_map(query_numeric_slot_weights),
        "metadata": {
            "dataset_id": dataset_id,
            "query_count": query_count,
            "pairwise_example_count": pairwise_example_count,
            "trainer": "python_pairwise_logistic_stream.v1",
            "epochs": options.epochs,
            "learning_rate": options.learning_rate,
            "l2": options.l2,
            "seed": options.seed,
            "shuffle_buffer_size": options.shuffle_buffer_size,
        },
    }

    return SlotLinearRankerArtifact(
        artifact_type="slot_linear_ranker.v1",
        artifact_version=options.artifact_version or f"python_{dataset_id}",
        created_at=utc_now_iso(),
        compatibility=None,
        config=config,
    )


def build_pairwise_examples(dataset: RankingDataset) -> list[PairwiseExample]:
    result: list[PairwiseExample] = []

    for group in dataset.query_groups:
        candidate_by_id = {candidate.candidate_id: candidate for candidate in group.candidates}
        query_features = extract_query_features(group)
        for preference in group.pairwise_preferences:
            example = build_example_from_preference(preference, candidate_by_id, query_features)
            if example is not None:
                result.append(example)

    return result


def build_example_from_preference(
    preference: PairwisePreference,
    candidate_by_id: dict[str, CandidateAction],
    query_features: dict[str, float],
) -> PairwiseExample | None:
    if preference.preference_label == 0:
        return None

    preferred = (
        candidate_by_id.get(preference.candidate_a_id)
        if preference.preference_label > 0
        else candidate_by_id.get(preference.candidate_b_id)
    )
    other = (
        candidate_by_id.get(preference.candidate_b_id)
        if preference.preference_label > 0
        else candidate_by_id.get(preference.candidate_a_id)
    )
    if preferred is None or other is None:
        return None

    preferred_features = extract_candidate_features(preferred, query_features)
    other_features = extract_candidate_features(other, query_features)

    delta: dict[str, float] = {}
    for key in set(preferred_features) | set(other_features):
        value = preferred_features.get(key, 0.0) - other_features.get(key, 0.0)
        if value != 0.0:
            delta[key] = value

    if not delta:
        return None

    return PairwiseExample(
        features=delta,
        confidence=max(float(preference.confidence or 1.0), 0.05),
    )


def fit_pairwise_logistic(
    examples: list[PairwiseExample],
    options: TrainSlotLinearRankerOptions,
) -> dict[str, float]:
    if not examples:
        return {}

    rng = random.Random(options.seed)
    weights: dict[str, float] = defaultdict(float)

    shuffled = examples[:]
    for _ in range(options.epochs):
        rng.shuffle(shuffled)
        for example in shuffled:
            margin = sum(weights.get(key, 0.0) * value for key, value in example.features.items())
            gradient_scale = (1.0 - sigmoid(margin)) * example.confidence
            for key, value in example.features.items():
                current = weights.get(key, 0.0)
                updated = current + options.learning_rate * (
                    gradient_scale * value - options.l2 * current
                )
                if updated != 0.0:
                    weights[key] = updated

    return dict(weights)


def fit_pairwise_logistic_streaming(
    query_group_factory: Callable[[], Iterator[RankingQueryGroup]],
    options: TrainSlotLinearRankerOptions,
) -> tuple[dict[str, float], int, int]:
    rng = random.Random(options.seed)
    weights: dict[str, float] = defaultdict(float)
    query_count = 0
    pairwise_example_count = 0

    for epoch in range(options.epochs):
        epoch_query_count = 0
        epoch_pairwise_example_count = 0
        example_stats = {"query_count": 0, "pairwise_example_count": 0}
        examples = iter_pairwise_examples_from_groups(query_group_factory(), example_stats)
        shuffled_examples = iter_buffer_shuffled_examples(
            examples,
            options.shuffle_buffer_size,
            rng,
        )
        for example in shuffled_examples:
            margin = sum(weights.get(key, 0.0) * value for key, value in example.features.items())
            gradient_scale = (1.0 - sigmoid(margin)) * example.confidence
            for key, value in example.features.items():
                current = weights.get(key, 0.0)
                updated = current + options.learning_rate * (
                    gradient_scale * value - options.l2 * current
                )
                if updated != 0.0:
                    weights[key] = updated
        epoch_query_count = example_stats["query_count"]
        epoch_pairwise_example_count = example_stats["pairwise_example_count"]
        if epoch == 0:
            query_count = epoch_query_count
            pairwise_example_count = epoch_pairwise_example_count

    return dict(weights), query_count, pairwise_example_count


def iter_pairwise_examples_from_groups(
    groups: Iterable[RankingQueryGroup],
    stats: dict[str, int] | None = None,
) -> Iterator[PairwiseExample]:
    for group in groups:
        if stats is not None:
            stats["query_count"] = stats.get("query_count", 0) + 1
        candidate_by_id = {candidate.candidate_id: candidate for candidate in group.candidates}
        query_features = extract_query_features(group)
        for preference in group.pairwise_preferences:
            example = build_example_from_preference(preference, candidate_by_id, query_features)
            if example is not None:
                if stats is not None:
                    stats["pairwise_example_count"] = stats.get(
                        "pairwise_example_count",
                        0,
                    ) + 1
                yield example


def iter_buffer_shuffled_examples(
    examples: Iterable[PairwiseExample],
    buffer_size: int,
    rng: random.Random,
) -> Iterator[PairwiseExample]:
    resolved_buffer_size = max(1, buffer_size)
    buffer: list[PairwiseExample] = []

    for example in examples:
        buffer.append(example)
        if len(buffer) < resolved_buffer_size:
            continue
        index = rng.randrange(len(buffer))
        yield buffer.pop(index)

    while buffer:
        index = rng.randrange(len(buffer))
        yield buffer.pop(index)


def extract_candidate_features(
    candidate: CandidateAction,
    query_features: dict[str, float],
) -> dict[str, float]:
    features = dict(query_features)
    features[f"action_case::{candidate.action_case}"] = 1.0

    runtime = candidate.runtime_slots or {}
    tags = runtime.get("candidate_tags")
    if isinstance(tags, list):
        for item in tags:
            if isinstance(item, str):
                features[f"candidate_tag::{item}"] = 1.0

    action_definition_kind = runtime.get("action_definition_kind")
    if isinstance(action_definition_kind, str) and action_definition_kind:
        features[f"candidate_tag::action_kind::{action_definition_kind}"] = 1.0

    for key in (
        "skill_definition_id",
        "card_definition_id",
        "character_definition_id",
        "actor_character_definition_id",
    ):
        value = runtime.get(key)
        if isinstance(value, (int, float)):
            features[f"candidate_tag::{key}::{int(value)}"] = 1.0

    candidate_numeric = runtime.get("candidate_numeric_slots")
    if isinstance(candidate_numeric, dict):
        for path, value in flatten_numeric_dict(candidate_numeric).items():
            features[f"candidate_numeric::candidate_numeric_slots.{path}"] = value

    continuation = runtime.get("continuation")
    if isinstance(continuation, dict):
        for key in ("score", "win_rate", "sample_count"):
            numeric = coerce_numeric(continuation.get(key))
            if numeric is not None:
                features[f"candidate_numeric::continuation.{key}"] = numeric

    for scalar_key in ("is_policy_choice", "is_replay_choice"):
        value = runtime.get(scalar_key)
        numeric = coerce_numeric(value)
        if numeric is not None:
            features[f"candidate_numeric::{scalar_key}"] = numeric

    return features


def extract_query_features(group: RankingQueryGroup) -> dict[str, float]:
    result: dict[str, float] = {}
    context = group.context_slots or {}

    query_numeric = context.get("query_numeric_slots")
    if isinstance(query_numeric, dict):
        for path, value in flatten_numeric_dict(query_numeric).items():
            result[f"query_numeric::query_numeric_slots.{path}"] = value

    for scalar_key in ("round", "actor", "legal_action_count", "point_index", "policy_selected_action_index"):
        numeric = coerce_numeric(context.get(scalar_key))
        if numeric is not None:
            result[f"query_numeric::{scalar_key}"] = numeric

    replay_kind = context.get("replay_action_definition_kind")
    if isinstance(replay_kind, str) and replay_kind:
        result[f"query_numeric::replay_action_definition_kind::{replay_kind}"] = 1.0

    for key in (
        "self_active_character_definition_id",
        "opp_active_character_definition_id",
        "replay_action_skill_definition_id",
        "replay_action_card_definition_id",
        "replay_action_character_definition_id",
        "replay_actor_character_definition_id",
    ):
        value = context.get(key)
        if isinstance(value, (int, float)):
            result[f"query_numeric::{key}::{int(value)}"] = 1.0

    return result


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
