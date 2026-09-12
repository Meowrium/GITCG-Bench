// Copyright (C) 2024-2025 Guyutongxue
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

import {
  buildActionCandidateId,
  buildActionCandidateSignature,
  buildSelectCardCandidateId,
  buildSelectCardCandidateSignature,
} from "../../mcp/src/candidateSignature";

type GuardResult = { ok: true } | { ok: false; reason: string };

type ActionBridgePayload = {
  chosenActionIndex?: unknown;
  usedDice?: unknown;
  candidateId?: unknown;
  candidateSignature?: unknown;
};

type SelectCardBridgePayload = {
  selectedDefinitionId?: unknown;
  candidateId?: unknown;
  candidateSignature?: unknown;
};

const isIntegerArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

export const checkDiceRequirement = (
  requiredCost: Array<{ type?: number; count?: number }>,
  usedDice: number[],
): boolean => {
  const VOID = 0;
  const OMNI = 8;
  const ALIGNED = 8;
  const ENERGY = 9;

  const requirementEntries = requiredCost.filter(
    (entry) => Number.isInteger(entry.type) && Number.isInteger(entry.count) && (entry.count as number) > 0,
  );

  const alignedEntry = requirementEntries.find((entry) => entry.type === ALIGNED);
  if (alignedEntry) {
    const requiredCount = alignedEntry.count as number;
    if (requiredCount !== usedDice.length) {
      return false;
    }
    const chosenSet = new Set(usedDice);
    return (
      (chosenSet.size === 0 && requiredCount === 0) ||
      chosenSet.size === 1 ||
      (chosenSet.size === 2 && chosenSet.has(OMNI))
    );
  }

  const requiredList: number[] = [];
  for (const entry of requirementEntries) {
    const type = entry.type as number;
    const count = entry.count as number;
    for (let i = 0; i < count; i += 1) {
      requiredList.push(type);
    }
  }

  const chosen = [...usedDice];
  let voidCount = 0;
  for (const req of requiredList) {
    if (req === ENERGY) {
      continue;
    }
    if (req === VOID) {
      voidCount += 1;
      continue;
    }
    const sameTypeIndex = chosen.indexOf(req);
    if (sameTypeIndex !== -1) {
      chosen.splice(sameTypeIndex, 1);
      continue;
    }
    const omniIndex = chosen.indexOf(OMNI);
    if (omniIndex === -1) {
      return false;
    }
    chosen.splice(omniIndex, 1);
  }

  return chosen.length === voidCount;
};

export const validatePendingActionPayload = (
  pendingRequest: unknown,
  payload: unknown,
): GuardResult => {
  const request = pendingRequest && typeof pendingRequest === "object"
    ? pendingRequest as Record<string, unknown>
    : null;
  const record = payload && typeof payload === "object"
    ? payload as ActionBridgePayload
    : null;
  if (request?.$case !== "action" || !record) {
    return { ok: false, reason: "Missing pending action request" };
  }
  if (!Number.isInteger(record.chosenActionIndex) || (record.chosenActionIndex as number) < 0) {
    return { ok: false, reason: "Invalid chosenActionIndex" };
  }
  if (typeof record.usedDice !== "undefined" && !isIntegerArray(record.usedDice)) {
    return { ok: false, reason: "Invalid usedDice" };
  }

  const actions = Array.isArray((request.value as Record<string, unknown> | undefined)?.action)
    ? ((request.value as { action: Array<Record<string, unknown>> }).action)
    : [];
  const chosenActionIndex = record.chosenActionIndex as number;
  const action = actions[chosenActionIndex];
  if (!action || action.validity !== 0) {
    return { ok: false, reason: "Chosen action is stale or invalid" };
  }

  const expectedCandidateId = buildActionCandidateId(chosenActionIndex + 1);
  if (
    typeof record.candidateId === "string" &&
    record.candidateId.length > 0 &&
    record.candidateId !== expectedCandidateId
  ) {
    return { ok: false, reason: "Action candidateId no longer matches current candidate" };
  }

  const expectedSignature = buildActionCandidateSignature(action);
  if (
    typeof record.candidateSignature === "string" &&
    record.candidateSignature.length > 0 &&
    record.candidateSignature !== expectedSignature
  ) {
    return { ok: false, reason: "Action candidate signature mismatch" };
  }

  const usedDice = isIntegerArray(record.usedDice) ? record.usedDice : [];
  if (!checkDiceRequirement(Array.isArray(action.requiredCost) ? action.requiredCost : [], usedDice)) {
    return { ok: false, reason: "usedDice no longer satisfies current action cost" };
  }

  return { ok: true };
};

export const validatePendingSelectCardPayload = (
  pendingRequest: unknown,
  payload: unknown,
): GuardResult => {
  const request = pendingRequest && typeof pendingRequest === "object"
    ? pendingRequest as Record<string, unknown>
    : null;
  const record = payload && typeof payload === "object"
    ? payload as SelectCardBridgePayload
    : null;
  if (request?.$case !== "selectCard" || !record) {
    return { ok: false, reason: "Missing pending selectCard request" };
  }
  if (!Number.isInteger(record.selectedDefinitionId)) {
    return { ok: false, reason: "Invalid selectedDefinitionId" };
  }

  const definitionIds = Array.isArray((request.value as Record<string, unknown> | undefined)?.candidateDefinitionIds)
    ? ((request.value as { candidateDefinitionIds: number[] }).candidateDefinitionIds)
    : [];

  for (let index = 0; index < definitionIds.length; index += 1) {
    const definitionId = definitionIds[index];
    if (definitionId !== record.selectedDefinitionId) {
      continue;
    }
    const optionIndex = index + 1;
    const expectedCandidateId = buildSelectCardCandidateId(optionIndex, definitionId);
    const expectedSignature = buildSelectCardCandidateSignature(optionIndex, definitionId);
    if (
      typeof record.candidateId === "string" &&
      record.candidateId.length > 0 &&
      record.candidateId !== expectedCandidateId
    ) {
      continue;
    }
    if (
      typeof record.candidateSignature === "string" &&
      record.candidateSignature.length > 0 &&
      record.candidateSignature !== expectedSignature
    ) {
      continue;
    }
    return { ok: true };
  }

  return { ok: false, reason: "Selected card candidate no longer matches current options" };
};
