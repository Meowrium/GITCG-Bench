// Copyright (C) 2026 Piovium Labs
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

/**
 * V31 F6 helper — convert engine `ActionInfoWithModification[]` into the
 * `{ action, index }[]` slate that `StateExporter.export` consumes.
 *
 * Builds the minimal `RpcAction` shape the exporter reads (`action.$case` +
 * value ids, `requiredCost`, `isFast`, `preview`) directly from the engine's
 * `ActionInfo`. We do **not** call the engine's internal `exposeAction` because
 * it is not part of `@gi-tcg/core`'s public API and we must not modify core
 * (V30 §9). Candidate ↔ observation order stays 1:1 so encoder Q aligns with
 * the action list passed to ISMCTS.
 */

import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"

/**
 * Minimal structural type matching the subset of the wire `Action` that
 * `StateExporter.export` reads. Declared locally to avoid importing the
 * deep `@gi-tcg/typings/gen/rpc` path (which tsc cannot resolve in this
 * workspace; see V31 F4 notes).
 */
export interface ExportedRpcAction {
  action:
    | { $case: "useSkill"; value: { skillDefinitionId: number; targetIds: number[] } }
    | { $case: "playCard"; value: { cardId: number; cardDefinitionId: number; targetIds: number[] } }
    | { $case: "switchActive"; value: { characterId: number; characterDefinitionId: number } }
    | { $case: "elementalTuning"; value: { removedCardId: number; targetDice: number } }
    | { $case: "declareEnd"; value: Record<string, never> }
  requiredCost: Array<{ type: number; count: number }>
  autoSelectedDice: number[]
  validity: number
  preview: unknown[]
  isFast: boolean
}

export function exposeActionsForObservation(
  actions: ActionInfoWithModification[],
): Array<{ action: ExportedRpcAction; index: number }> {
  const out: Array<{ action: ExportedRpcAction; index: number }> = []
  for (let i = 0; i < actions.length; i++) {
    const a = toRpcAction(actions[i])
    if (a) out.push({ action: a, index: i })
  }
  return out
}

function toRpcAction(a: ActionInfoWithModification): ExportedRpcAction | null {
  const requiredCost = costToRequirement(a.cost)
  const base = {
    requiredCost,
    autoSelectedDice: [] as number[],
    validity: a.validity,
    preview: ((a as { preview?: unknown[] }).preview ?? []) as unknown[],
    isFast: a.fast,
  }
  switch (a.type) {
    case "useSkill":
      return {
        action: {
          $case: "useSkill",
          value: {
            skillDefinitionId: a.skill.definition.id,
            targetIds: a.targets.map((t) => t.id),
          },
        },
        ...base,
      }
    case "playCard":
      return {
        action: {
          $case: "playCard",
          value: {
            cardId: a.skill.caller.id,
            cardDefinitionId: a.skill.caller.definition.id,
            targetIds: a.targets.map((t) => t.id),
          },
        },
        ...base,
      }
    case "switchActive":
      return {
        action: {
          $case: "switchActive",
          value: {
            characterId: a.to.id,
            characterDefinitionId: a.to.definition.id,
          },
        },
        ...base,
      }
    case "elementalTuning":
      return {
        action: {
          $case: "elementalTuning",
          value: {
            removedCardId: a.card.id,
            targetDice: a.result as number,
          },
        },
        ...base,
      }
    case "declareEnd":
      return {
        action: { $case: "declareEnd", value: {} },
        ...base,
      }
    default:
      return null
  }
}

/** Map a `DiceRequirement` (Map<type, count>) into the wire requirement array. */
function costToRequirement(
  cost: ActionInfoWithModification["cost"],
): Array<{ type: number; count: number }> {
  const out: Array<{ type: number; count: number }> = []
  if (!cost || typeof (cost as { entries?: unknown }).entries !== "function") {
    return out
  }
  for (const [type, count] of cost as Iterable<[number, number]>) {
    out.push({ type, count })
  }
  return out
}
