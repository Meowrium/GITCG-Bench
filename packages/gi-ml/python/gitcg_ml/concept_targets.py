from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contracts import CandidateAction, RankingDataset, utc_now_iso


@dataclass(slots=True)
class ConceptTargetAnnotation:
    annotation_id: str
    concept_id: str
    target_ref: str
    label_slot: dict[str, Any]
    confidence: float | None
    source: str
    annotation_slots: dict[str, Any] | None
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "annotation_id": self.annotation_id,
            "concept_id": self.concept_id,
            "target_ref": self.target_ref,
            "label_slot": self.label_slot,
            "confidence": self.confidence,
            "source": self.source,
            "annotation_slots": self.annotation_slots,
            "created_at": self.created_at,
        }


@dataclass(slots=True)
class ConceptTargetDataset:
    dataset_id: str
    bank_version: str
    created_at: str
    annotations: list[ConceptTargetAnnotation]
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "bank_version": self.bank_version,
            "created_at": self.created_at,
            "annotations": [annotation.to_dict() for annotation in self.annotations],
            "metadata": self.metadata,
        }


def build_concept_target_dataset(
    ranking_dataset: RankingDataset,
    concept_bank: dict[str, Any],
) -> ConceptTargetDataset:
    annotations: list[ConceptTargetAnnotation] = []
    created_at = utc_now_iso()
    bank_version = normalize_concept_collection_version(concept_bank)
    concepts = [
        concept
        for concept in concept_bank.get("concepts", [])
        if isinstance(concept, dict) and concept.get("status") != "deprecated"
    ]

    for concept in concepts:
        for group in ranking_dataset.query_groups:
            annotations.extend(
                build_annotations_for_group(
                    concept=concept,
                    group=group,
                    ranking_dataset=ranking_dataset,
                    created_at=created_at,
                )
            )

    return ConceptTargetDataset(
        dataset_id=f"concept_targets__{ranking_dataset.dataset_id}__{bank_version}",
        bank_version=bank_version,
        created_at=created_at,
        annotations=annotations,
        metadata={
            "ranking_dataset_id": ranking_dataset.dataset_id,
            "concept_count": len(concepts),
            "annotation_count": len(annotations),
            "builder": "python_rule_concept_targets.v1",
        },
    )


def normalize_concept_collection_version(concept_bank: dict[str, Any]) -> str:
    bank_version = concept_bank.get("bank_version")
    if isinstance(bank_version, str) and bank_version:
        return bank_version

    dataset_id = concept_bank.get("dataset_id")
    if isinstance(dataset_id, str) and dataset_id:
        return f"concept_export__{dataset_id}"

    generated_at = concept_bank.get("generated_at")
    if isinstance(generated_at, str) and generated_at:
        return f"concept_export__{sanitize(generated_at)}"

    return "concept_export__unknown"


def build_annotations_for_group(
    concept: dict[str, Any],
    group: Any,
    ranking_dataset: RankingDataset,
    created_at: str,
) -> list[ConceptTargetAnnotation]:
    scope = concept.get("scope")
    concept_id = str(concept["concept_id"])
    estimator_slot = concept.get("estimator_slot")
    if not isinstance(estimator_slot, dict):
        return []

    if scope in ("state", "window"):
        label = evaluate_rule(
            estimator_slot,
            query_slots=group.context_slots or {},
            candidate=None,
            group=group,
            ranking_dataset=ranking_dataset,
        )
        if label is None:
            return []
        target_ref = group.state_ref or group.query_id
        return [
            build_annotation(
                concept_id=concept_id,
                target_ref=target_ref,
                label=label,
                estimator_slot=estimator_slot,
                created_at=created_at,
            )
        ]

    if scope == "state_action":
        annotations: list[ConceptTargetAnnotation] = []
        for candidate in group.candidates:
            label = evaluate_rule(
                estimator_slot,
                query_slots=group.context_slots or {},
                candidate=candidate,
                group=group,
                ranking_dataset=ranking_dataset,
            )
            if label is None:
                continue
            annotations.append(
                build_annotation(
                    concept_id=concept_id,
                    target_ref=candidate.candidate_id,
                    label=label,
                    estimator_slot=estimator_slot,
                    created_at=created_at,
                )
            )
        return annotations

    return []


def build_annotation(
    concept_id: str,
    target_ref: str,
    label: bool,
    estimator_slot: dict[str, Any],
    created_at: str,
) -> ConceptTargetAnnotation:
    label_value = 1.0 if label else 0.0
    return ConceptTargetAnnotation(
        annotation_id=f"annotation:{concept_id}:{sanitize(target_ref)}",
        concept_id=concept_id,
        target_ref=target_ref,
        label_slot={
            "binary": label,
            "value": label_value,
        },
        confidence=1.0,
        source="runtime",
        annotation_slots={
            "rule": estimator_slot,
        },
        created_at=created_at,
    )


def evaluate_rule(
    estimator_slot: dict[str, Any],
    query_slots: dict[str, Any],
    candidate: CandidateAction | None,
    group: Any,
    ranking_dataset: RankingDataset,
) -> bool | None:
    kind = estimator_slot.get("kind")
    if kind == "combo_pattern.v1":
        return evaluate_combo_pattern(
            estimator_slot,
            group=group,
            candidate=candidate,
            ranking_dataset=ranking_dataset,
        )

    all_of = estimator_slot.get("all_of")
    if isinstance(all_of, list):
        results = []
        for item in all_of:
            if not isinstance(item, dict):
                return None
            result = evaluate_rule(
                item,
                query_slots=query_slots,
                candidate=candidate,
                group=group,
                ranking_dataset=ranking_dataset,
            )
            if result is None:
                return None
            results.append(result)
        return all(results)

    any_of = estimator_slot.get("any_of")
    if isinstance(any_of, list):
        results = []
        for item in any_of:
            if not isinstance(item, dict):
                return None
            result = evaluate_rule(
                item,
                query_slots=query_slots,
                candidate=candidate,
                group=group,
                ranking_dataset=ranking_dataset,
            )
            if result is None:
                continue
            results.append(result)
        return any(results) if results else None

    action_case = estimator_slot.get("action_case")
    if isinstance(action_case, str):
        if candidate is None:
            return None
        return candidate.action_case == action_case

    candidate_tag = estimator_slot.get("candidate_tag")
    if isinstance(candidate_tag, str):
        if candidate is None:
            return None
        tags = (candidate.runtime_slots or {}).get("candidate_tags")
        return isinstance(tags, list) and candidate_tag in tags

    for key in (
        "action_definition_kind",
        "skill_definition_id",
        "card_definition_id",
        "character_definition_id",
        "actor_character_definition_id",
    ):
        expected = estimator_slot.get(key)
        if expected is None:
            continue
        if candidate is None:
            return None
        runtime = candidate.runtime_slots or {}
        actual = runtime.get(key)
        return actual == expected

    candidate_numeric_path = estimator_slot.get("candidate_numeric_path")
    if isinstance(candidate_numeric_path, str):
        if candidate is None:
            return None
        value = numeric_at_path(candidate.runtime_slots or {}, candidate_numeric_path)
        return compare_numeric(value, estimator_slot)

    query_numeric_path = estimator_slot.get("query_numeric_path")
    if isinstance(query_numeric_path, str):
        value = numeric_at_path(query_slots, query_numeric_path)
        return compare_numeric(value, estimator_slot)

    for key in (
        "self_active_character_definition_id",
        "opp_active_character_definition_id",
        "replay_action_definition_kind",
        "replay_action_skill_definition_id",
        "replay_action_card_definition_id",
        "replay_action_character_definition_id",
        "replay_actor_character_definition_id",
    ):
        expected = estimator_slot.get(key)
        if expected is None:
            continue
        return query_slots.get(key) == expected

    return None


def evaluate_combo_pattern(
    estimator_slot: dict[str, Any],
    group: Any,
    candidate: CandidateAction | None,
    ranking_dataset: RankingDataset,
) -> bool | None:
    steps = estimator_slot.get("in_order")
    if not isinstance(steps, list) or len(steps) < 2:
        return None
    normalized_steps = [step for step in steps if isinstance(step, dict)]
    if len(normalized_steps) != len(steps):
        return None
    max_step_gap = estimator_slot.get("max_step_gap")
    step_gap = int(max_step_gap) if isinstance(max_step_gap, (int, float)) else 1
    step_gap = max(1, step_gap)

    if candidate is not None:
        first_match = evaluate_rule(
            normalized_steps[0],
            query_slots=group.context_slots or {},
            candidate=candidate,
            group=group,
            ranking_dataset=ranking_dataset,
        )
        if first_match is None:
            return None
        if not first_match:
            return False
    else:
        first_match = match_group_selected_action(
            group=group,
            rule=normalized_steps[0],
            ranking_dataset=ranking_dataset,
        )
        if first_match is None:
            return None
        if not first_match:
            return False

    current_group = group
    for step in normalized_steps[1:]:
        next_group = find_next_matching_group(
            group=current_group,
            rule=step,
            ranking_dataset=ranking_dataset,
            max_step_gap=step_gap,
        )
        if next_group is None:
            return False
        current_group = next_group
    return True


def match_group_selected_action(
    group: Any,
    rule: dict[str, Any],
    ranking_dataset: RankingDataset,
) -> bool | None:
    context_slots = group.context_slots or {}
    selected_index = context_slots.get("policy_selected_action_index")
    selected_type = context_slots.get("policy_selected_action_type")

    candidate = next(
        (
            item
            for item in group.candidates
            if isinstance(item.runtime_slots, dict)
            and item.runtime_slots.get("branch_action_index") == selected_index
        ),
        None,
    )
    if candidate is None and isinstance(selected_type, str):
        candidate = next(
            (item for item in group.candidates if item.action_case == selected_type),
            None,
        )
    if candidate is None:
        return None

    return evaluate_rule(
        rule,
        query_slots=context_slots,
        candidate=candidate,
        group=group,
        ranking_dataset=ranking_dataset,
    )


def find_next_matching_group(
    group: Any,
    rule: dict[str, Any],
    ranking_dataset: RankingDataset,
    max_step_gap: int,
) -> Any | None:
    current = parse_branch_eval_query_ref(group.query_id)
    if current is None:
        return None

    for candidate_group in ranking_dataset.query_groups:
        parsed = parse_branch_eval_query_ref(candidate_group.query_id)
        if parsed is None:
            continue
        if (
            parsed["matchup_id"] == current["matchup_id"]
            and parsed["replay_file"] == current["replay_file"]
            and parsed["point_index"] > current["point_index"]
            and parsed["point_index"] - current["point_index"] <= max_step_gap
        ):
            matched = match_group_selected_action(
                group=candidate_group,
                rule=rule,
                ranking_dataset=ranking_dataset,
            )
            if matched:
                return candidate_group
    return None


def parse_branch_eval_query_ref(query_id: str) -> dict[str, Any] | None:
    parts = query_id.split(":")
    if len(parts) < 5 or parts[0] != "branch_eval":
        return None

    point_part = parts[-1]
    replay_file = parts[2]
    matchup_id = parts[1]
    if not point_part.startswith("point_"):
        return None

    try:
        point_index = int(point_part.removeprefix("point_"))
    except ValueError:
        return None

    return {
        "matchup_id": matchup_id,
        "replay_file": replay_file,
        "point_index": point_index,
    }


def compare_numeric(value: float | None, estimator_slot: dict[str, Any]) -> bool | None:
    if value is None:
        return None
    threshold = estimator_slot.get("threshold")
    if not isinstance(threshold, (int, float)):
        return None
    comparison = estimator_slot.get("comparison", "gte")
    if comparison == "gt":
        return value > float(threshold)
    if comparison == "lte":
        return value <= float(threshold)
    if comparison == "lt":
        return value < float(threshold)
    return value >= float(threshold)


def numeric_at_path(value: dict[str, Any], path: str) -> float | None:
    current: Any = value
    for part in [part for part in path.split(".") if part]:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    if isinstance(current, bool):
        return 1.0 if current else 0.0
    if isinstance(current, (int, float)):
        return float(current)
    return None


def sanitize(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-:" else "_" for ch in value)
