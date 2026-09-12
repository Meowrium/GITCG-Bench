// Copyright (C) 2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

const stableSerialize = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item !== "undefined")
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
};

export const buildActionCandidateId = (actionIndex: number): string =>
  `cand_${actionIndex}`;

export const buildSelectCardCandidateId = (
  optionIndex: number,
  definitionId: number,
): string => `cand_select_card_${optionIndex}_${definitionId}`;

export const buildActionCandidateSignature = (action: unknown): string => {
  const record = action && typeof action === "object"
    ? action as Record<string, unknown>
    : {};
  const innerAction = record.action && typeof record.action === "object"
    ? record.action as Record<string, unknown>
    : {};

  return stableSerialize({
    kind: "action",
    action_case: typeof innerAction.$case === "string" ? innerAction.$case : null,
    action_value: innerAction.value ?? null,
    required_cost: Array.isArray(record.requiredCost) ? record.requiredCost : [],
    auto_selected_dice: Array.isArray(record.autoSelectedDice) ? record.autoSelectedDice : [],
    validity: Number.isInteger(record.validity) ? record.validity : null,
  });
};

export const buildSelectCardCandidateSignature = (
  optionIndex: number,
  definitionId: number,
): string => stableSerialize({
  kind: "selectCard",
  option_index: optionIndex,
  definition_id: definitionId,
});
