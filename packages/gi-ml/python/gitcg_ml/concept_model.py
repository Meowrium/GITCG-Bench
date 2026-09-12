from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import math
import random
from typing import Any

from .contracts import CandidateAction, RankingDataset, utc_now_iso
from .concept_targets import normalize_concept_collection_version


@dataclass(slots=True)
class TrainConceptModelOptions:
    artifact_version: str | None = None
    epochs: int = 25
    learning_rate: float = 0.08
    l2: float = 0.0005
    seed: int = 17
    top_feature_count: int = 24


@dataclass(slots=True)
class ConceptExample:
    concept_id: str
    scope: str
    features: dict[str, float]
    label: float
    target_ref: str


def train_concept_model(
    concept_target_dataset: dict[str, Any],
    ranking_dataset: RankingDataset,
    concept_bank: dict[str, Any],
    options: TrainConceptModelOptions | None = None,
) -> dict[str, Any]:
    options = options or TrainConceptModelOptions()
    examples_by_concept = build_concept_examples(concept_target_dataset, ranking_dataset, concept_bank)
    concepts_payload: list[dict[str, Any]] = []

    for concept in concept_bank.get("concepts", []):
        if not isinstance(concept, dict) or concept.get("status") == "deprecated":
            continue
        concept_id = str(concept["concept_id"])
        examples = examples_by_concept.get(concept_id, [])
        model = fit_binary_model(examples, options)
        concepts_payload.append(
            {
                "concept_id": concept_id,
                "scope": concept.get("scope"),
                "bias": model["bias"],
                "feature_weights": model["feature_weights"],
                "positive_rate": model["positive_rate"],
                "training_example_count": len(examples),
            }
        )

    return {
        "artifact_type": "concept_model.linear.v1",
        "artifact_version": options.artifact_version
        or f"concept_model__{concept_target_dataset['dataset_id']}",
        "created_at": utc_now_iso(),
        "bank_version": concept_target_dataset.get("bank_version")
        or normalize_concept_collection_version(concept_bank),
        "compatibility": None,
        "concepts": concepts_payload,
        "metadata": {
            "concept_target_dataset_id": concept_target_dataset["dataset_id"],
            "ranking_dataset_id": ranking_dataset.dataset_id,
            "trainer": "python_binary_logistic.v1",
            "epochs": options.epochs,
            "learning_rate": options.learning_rate,
            "l2": options.l2,
            "seed": options.seed,
        },
    }


def build_concept_examples(
    concept_target_dataset: dict[str, Any],
    ranking_dataset: RankingDataset,
    concept_bank: dict[str, Any],
) -> dict[str, list[ConceptExample]]:
    group_by_query = {group.query_id: group for group in ranking_dataset.query_groups}
    candidate_index: dict[str, tuple[Any, CandidateAction]] = {}
    for group in ranking_dataset.query_groups:
        for candidate in group.candidates:
            candidate_index[candidate.candidate_id] = (group, candidate)

    scope_by_concept = {
        str(concept["concept_id"]): str(concept.get("scope", "state"))
        for concept in concept_bank.get("concepts", [])
        if isinstance(concept, dict)
    }

    result: dict[str, list[ConceptExample]] = defaultdict(list)
    for annotation in concept_target_dataset.get("annotations", []):
        if not isinstance(annotation, dict):
            continue
        concept_id = str(annotation["concept_id"])
        label_slot = annotation.get("label_slot") or {}
        label = 1.0 if bool(label_slot.get("binary")) else 0.0
        scope = scope_by_concept.get(concept_id, "state")
        target_ref = str(annotation["target_ref"])

        if scope == "state_action":
            pair = candidate_index.get(target_ref)
            if pair is None:
                continue
            group, candidate = pair
            features = extract_features(group.context_slots or {}, candidate)
        else:
            group = next(
                (
                    group
                    for group in group_by_query.values()
                    if (group.state_ref or group.query_id) == target_ref
                ),
                None,
            )
            if group is None:
                continue
            features = extract_features(group.context_slots or {}, None)

        result[concept_id].append(
            ConceptExample(
                concept_id=concept_id,
                scope=scope,
                features=features,
                label=label,
                target_ref=target_ref,
            )
        )

    return result


def fit_binary_model(
    examples: list[ConceptExample],
    options: TrainConceptModelOptions,
) -> dict[str, Any]:
    if not examples:
        return {
            "bias": 0.0,
            "feature_weights": {},
            "positive_rate": None,
        }

    rng = random.Random(options.seed)
    weights: dict[str, float] = defaultdict(float)
    bias = 0.0
    shuffled = examples[:]

    for _ in range(options.epochs):
        rng.shuffle(shuffled)
        for example in shuffled:
            margin = bias + sum(weights.get(key, 0.0) * value for key, value in example.features.items())
            prob = sigmoid(margin)
            error = example.label - prob
            bias += options.learning_rate * error
            for key, value in example.features.items():
                current = weights.get(key, 0.0)
                updated = current + options.learning_rate * (error * value - options.l2 * current)
                if updated != 0.0:
                    weights[key] = updated

    ordered_features = {
        key: weights[key]
        for key, _ in sorted(
            weights.items(),
            key=lambda item: (-abs(item[1]), item[0]),
        )[: max(0, options.top_feature_count)]
    }
    positive_rate = sum(example.label for example in examples) / len(examples)
    return {
        "bias": bias,
        "feature_weights": ordered_features,
        "positive_rate": positive_rate,
    }


def extract_features(
    query_slots: dict[str, Any],
    candidate: CandidateAction | None,
) -> dict[str, float]:
    result: dict[str, float] = {}

    for key in ("round", "actor", "legal_action_count", "point_index", "policy_selected_action_index"):
        value = query_slots.get(key)
        if isinstance(value, bool):
            result[f"query::{key}"] = 1.0 if value else 0.0
        elif isinstance(value, (int, float)):
            result[f"query::{key}"] = float(value)

    for key in (
        "self_active_character_definition_id",
        "opp_active_character_definition_id",
        "replay_action_skill_definition_id",
        "replay_action_card_definition_id",
        "replay_action_character_definition_id",
        "replay_actor_character_definition_id",
    ):
        value = query_slots.get(key)
        if isinstance(value, (int, float)):
            result[f"query::{key}::{int(value)}"] = 1.0

    replay_kind = query_slots.get("replay_action_definition_kind")
    if isinstance(replay_kind, str) and replay_kind:
        result[f"query::replay_action_definition_kind::{replay_kind}"] = 1.0

    nested_query = query_slots.get("query_numeric_slots")
    if isinstance(nested_query, dict):
        for path, value in flatten_numeric(nested_query).items():
            result[f"query::query_numeric_slots.{path}"] = value

    if candidate is not None:
        result[f"candidate::action_case::{candidate.action_case}"] = 1.0
        runtime = candidate.runtime_slots or {}
        tags = runtime.get("candidate_tags")
        if isinstance(tags, list):
            for tag in tags:
                if isinstance(tag, str):
                    result[f"candidate::tag::{tag}"] = 1.0

        action_definition_kind = runtime.get("action_definition_kind")
        if isinstance(action_definition_kind, str) and action_definition_kind:
            result[f"candidate::action_definition_kind::{action_definition_kind}"] = 1.0

        for key in (
            "skill_definition_id",
            "card_definition_id",
            "character_definition_id",
            "actor_character_definition_id",
        ):
            value = runtime.get(key)
            if isinstance(value, (int, float)):
                result[f"candidate::{key}::{int(value)}"] = 1.0

        for key in ("is_policy_choice", "is_replay_choice"):
            value = runtime.get(key)
            if isinstance(value, bool):
                result[f"candidate::{key}"] = 1.0 if value else 0.0

        for nested_key in ("candidate_numeric_slots", "continuation"):
            nested = runtime.get(nested_key)
            if isinstance(nested, dict):
                for path, value in flatten_numeric(nested).items():
                    result[f"candidate::{nested_key}.{path}"] = value

    return result


def flatten_numeric(value: dict[str, Any], prefix: str = "") -> dict[str, float]:
    result: dict[str, float] = {}
    for key, child in value.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(child, bool):
            result[path] = 1.0 if child else 0.0
        elif isinstance(child, (int, float)) and math.isfinite(float(child)):
            result[path] = float(child)
        elif isinstance(child, dict):
            result.update(flatten_numeric(child, path))
    return result


def sigmoid(value: float) -> float:
    if value >= 0:
        exp = math.exp(-value)
        return 1.0 / (1.0 + exp)
    exp = math.exp(value)
    return exp / (1.0 + exp)
