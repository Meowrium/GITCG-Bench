from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, UTC
from typing import Any

JsonDict = dict[str, Any]


@dataclass(slots=True)
class PairwisePreference:
    query_id: str
    candidate_a_id: str
    candidate_b_id: str
    preference_label: int
    confidence: float | None = None
    evidence_ref: str | None = None
    preference_slots: JsonDict | None = None

    @classmethod
    def from_dict(cls, value: JsonDict) -> "PairwisePreference":
        return cls(
            query_id=str(value["query_id"]),
            candidate_a_id=str(value["candidate_a_id"]),
            candidate_b_id=str(value["candidate_b_id"]),
            preference_label=int(value["preference_label"]),
            confidence=_optional_float(value.get("confidence")),
            evidence_ref=_optional_str(value.get("evidence_ref")),
            preference_slots=_optional_dict(value.get("preference_slots")),
        )


@dataclass(slots=True)
class CandidateAction:
    candidate_id: str
    query_id: str
    action_case: str
    action_definition_ref: str | None = None
    raw_feature_ref: str | None = None
    tree_match_ref: str | None = None
    branch_eval_ref: str | None = None
    runtime_slots: JsonDict | None = None

    @classmethod
    def from_dict(cls, value: JsonDict) -> "CandidateAction":
        return cls(
            candidate_id=str(value["candidate_id"]),
            query_id=str(value["query_id"]),
            action_case=str(value["action_case"]),
            action_definition_ref=_optional_str(value.get("action_definition_ref")),
            raw_feature_ref=_optional_str(value.get("raw_feature_ref")),
            tree_match_ref=_optional_str(value.get("tree_match_ref")),
            branch_eval_ref=_optional_str(value.get("branch_eval_ref")),
            runtime_slots=_optional_dict(value.get("runtime_slots")),
        )


@dataclass(slots=True)
class RankingQueryGroup:
    query_id: str
    source: str | None = None
    state_ref: str | None = None
    context_slots: JsonDict | None = None
    candidates: list[CandidateAction] = field(default_factory=list)
    pairwise_preferences: list[PairwisePreference] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: JsonDict) -> "RankingQueryGroup":
        return cls(
            query_id=str(value["query_id"]),
            source=_optional_str(value.get("source")),
            state_ref=_optional_str(value.get("state_ref")),
            context_slots=_optional_dict(value.get("context_slots")),
            candidates=[
                CandidateAction.from_dict(item)
                for item in value.get("candidates", [])
                if isinstance(item, dict)
            ],
            pairwise_preferences=[
                PairwisePreference.from_dict(item)
                for item in value.get("pairwise_preferences", [])
                if isinstance(item, dict)
            ],
        )


@dataclass(slots=True)
class RankingDataset:
    dataset_id: str
    created_at: str | None = None
    metadata: JsonDict | None = None
    query_groups: list[RankingQueryGroup] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: JsonDict) -> "RankingDataset":
        return cls(
            dataset_id=str(value["dataset_id"]),
            created_at=_optional_str(value.get("created_at")),
            metadata=_optional_dict(value.get("metadata")),
            query_groups=[
                RankingQueryGroup.from_dict(item)
                for item in value.get("query_groups", [])
                if isinstance(item, dict)
            ],
        )


@dataclass(slots=True)
class SlotLinearRankerArtifact:
    artifact_type: str
    artifact_version: str
    created_at: str
    compatibility: JsonDict | None
    config: JsonDict

    def to_dict(self) -> JsonDict:
        return {
            "artifact_type": self.artifact_type,
            "artifact_version": self.artifact_version,
            "created_at": self.created_at,
            "compatibility": self.compatibility,
            "config": self.config,
        }


@dataclass(slots=True)
class ValueSample:
    sample_id: str
    source: str
    state_ref: str | None = None
    target_value: float = 0.0
    weight: float | None = None
    context_slots: JsonDict | None = None
    feature_slots: JsonDict | None = None

    @classmethod
    def from_dict(cls, value: JsonDict) -> "ValueSample":
        return cls(
            sample_id=str(value["sample_id"]),
            source=str(value.get("source") or "unknown"),
            state_ref=_optional_str(value.get("state_ref")),
            target_value=float(value.get("target_value", 0.0)),
            weight=_optional_float(value.get("weight")),
            context_slots=_optional_dict(value.get("context_slots")),
            feature_slots=_optional_dict(value.get("feature_slots")),
        )


@dataclass(slots=True)
class ValueDataset:
    dataset_id: str
    created_at: str | None = None
    metadata: JsonDict | None = None
    samples: list[ValueSample] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: JsonDict) -> "ValueDataset":
        return cls(
            dataset_id=str(value["dataset_id"]),
            created_at=_optional_str(value.get("created_at")),
            metadata=_optional_dict(value.get("metadata")),
            samples=[
                ValueSample.from_dict(item)
                for item in value.get("samples", [])
                if isinstance(item, dict)
            ],
        )


@dataclass(slots=True)
class LinearValueArtifact:
    artifact_type: str
    artifact_version: str
    created_at: str
    bias: float
    feature_weights: JsonDict
    metadata: JsonDict | None = None

    def to_dict(self) -> JsonDict:
        return {
            "artifact_type": self.artifact_type,
            "artifact_version": self.artifact_version,
            "created_at": self.created_at,
            "bias": self.bias,
            "feature_weights": self.feature_weights,
            "metadata": self.metadata,
        }


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _optional_dict(value: Any) -> JsonDict | None:
    return value if isinstance(value, dict) else None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None
