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

import { describe, expect, it } from "vitest"
import {
  PbDamageType,
  PbEntityArea,
  PbEntityType,
  PbModifyDirection,
  PbMoveEntityReason,
  type PreviewData,
} from "@gi-tcg/typings"
import {
  DAMAGE_TYPE_SLOTS,
  PREVIEW_VECTOR_SCALAR_DIM,
  REACTION_FAMILY_SLOTS,
  extractPreviewVector,
  flatVectorFeatureNames,
  flattenPreviewVector,
} from "./preview-vector.js"

const SELF_IDS = new Set([100, 101, 102, 200, 201])
const OPP_IDS = new Set([900, 901, 902, 1000, 1001])
const CTX = { perspective: 0 as const, selfIds: SELF_IDS, opponentIds: OPP_IDS }

function dmg(opts: {
  type?: number
  value: number
  targetId: number
  reaction?: number
  defeated?: boolean
}): PreviewData {
  return {
    mutation: {
      $case: "damage",
      value: {
        damageType: opts.type ?? PbDamageType.PYRO,
        value: opts.value,
        targetId: opts.targetId,
        targetDefinitionId: 0,
        sourceId: 0,
        sourceDefinitionId: 0,
        isSkillMainDamage: true,
        reactionType: (opts.reaction ?? 0) as never,
        causeDefeated: opts.defeated ?? false,
        oldAura: 0 as never,
        newAura: 0 as never,
        oldHealth: 10,
        newHealth: 10 - opts.value,
      } as never,
    },
  }
}

describe("PreviewMutationVector", () => {
  it("returns zeroed vector when no preview data", () => {
    const v = extractPreviewVector([], CTX)
    expect(v.has_preview).toBe(false)
    expect(v.damage_total_opp).toBe(0)
  })

  it("scalar dim matches flatten output length", () => {
    const v = extractPreviewVector([dmg({ value: 3, targetId: 900 })], CTX)
    const flat = flattenPreviewVector(v)
    expect(flat.length).toBe(PREVIEW_VECTOR_SCALAR_DIM)
    expect(flatVectorFeatureNames().length).toBe(PREVIEW_VECTOR_SCALAR_DIM)
  })

  it("aggregates damage to opponent and tracks max", () => {
    const v = extractPreviewVector(
      [
        dmg({ value: 3, targetId: 900, type: PbDamageType.PYRO }),
        dmg({ value: 5, targetId: 901, type: PbDamageType.PYRO }),
        dmg({ value: 2, targetId: 100, type: PbDamageType.PYRO }),
      ],
      CTX,
    )
    expect(v.damage_total_opp).toBe(8)
    expect(v.damage_max_opp).toBe(5)
    expect(v.damage_total_self).toBe(2)
    expect(v.hit_count).toBe(3)
    expect(v.damage_by_type.pyro).toBe(8)
  })

  it("breaks down damage by element type", () => {
    const v = extractPreviewVector(
      [
        dmg({ value: 2, targetId: 900, type: PbDamageType.CRYO }),
        dmg({ value: 3, targetId: 900, type: PbDamageType.HYDRO }),
        dmg({ value: 1, targetId: 901, type: PbDamageType.PIERCING }),
      ],
      CTX,
    )
    expect(v.damage_by_type.cryo).toBe(2)
    expect(v.damage_by_type.hydro).toBe(3)
    expect(v.damage_by_type.piercing).toBe(1)
    expect(v.damage_by_type.pyro).toBe(0)
  })

  it("counts kills with cause_defeated and per-side flags", () => {
    const v = extractPreviewVector(
      [
        dmg({ value: 9, targetId: 900, defeated: true }),
        dmg({ value: 12, targetId: 100, defeated: true }),
      ],
      CTX,
    )
    expect(v.opp_killed).toBe(true)
    expect(v.self_killed).toBe(true)
    expect(v.opp_kill_count).toBe(1)
    expect(v.cause_defeated_count).toBe(2)
  })

  it("aggregates reactions into families", () => {
    const v = extractPreviewVector(
      [
        dmg({ value: 5, targetId: 900, reaction: 101 }),
        dmg({ value: 6, targetId: 901, reaction: 102 }),
        dmg({ value: 3, targetId: 902, reaction: 108 }),
        dmg({ value: 4, targetId: 901, reaction: 109 }),
      ],
      CTX,
    )
    expect(v.reactions_total).toBe(4)
    expect(v.reactions_by_family.melt).toBe(1)
    expect(v.reactions_by_family.vaporize).toBe(1)
    expect(v.reactions_by_family.swirl).toBe(2)
  })
})

describe("PreviewMutationVector - mutations", () => {
  it("treats damageType=HEAL as healing", () => {
    const v = extractPreviewVector(
      [
        {
          mutation: {
            $case: "damage",
            value: {
              damageType: PbDamageType.HEAL,
              value: 4,
              targetId: 100,
              targetDefinitionId: 0,
              sourceId: 0,
              sourceDefinitionId: 0,
              isSkillMainDamage: false,
              reactionType: 0 as never,
              causeDefeated: false,
              oldAura: 0 as never,
              newAura: 0 as never,
              oldHealth: 6,
              newHealth: 10,
            } as never,
          },
        },
      ],
      CTX,
    )
    expect(v.heal_total_self).toBe(4)
    expect(v.damage_total_opp).toBe(0)
  })

  it("counts self draws and creates", () => {
    const previews: PreviewData[] = [
      {
        mutation: {
          $case: "moveEntity",
          value: {
            fromWho: 0,
            fromWhere: PbEntityArea.PILE,
            toWho: 0,
            toWhere: PbEntityArea.HAND,
            reason: PbMoveEntityReason.DRAW,
            entity: undefined,
          } as never,
        },
      },
      {
        mutation: {
          $case: "createEntity",
          value: {
            who: 0,
            where: PbEntityArea.SUMMON,
            entity: { id: 0, definitionId: 0, type: PbEntityType.SUMMON } as never,
          } as never,
        },
      },
      {
        mutation: {
          $case: "createEntity",
          value: {
            who: 0,
            where: PbEntityArea.SUPPORT,
            entity: { id: 0, definitionId: 0, type: PbEntityType.SUPPORT } as never,
          } as never,
        },
      },
    ]
    const v = extractPreviewVector(previews, CTX)
    expect(v.draws_self).toBe(1)
    expect(v.creates_summon_self).toBe(1)
    expect(v.creates_support_self).toBe(1)
  })

  it("counts switches per side", () => {
    const previews: PreviewData[] = [
      {
        mutation: {
          $case: "switchActive",
          value: { who: 0, fromCharacterId: 100, characterDefinitionId: 0, characterId: 101, viaSkillId: 0 } as never,
        },
      },
      {
        mutation: {
          $case: "switchActive",
          value: { who: 1, fromCharacterId: 900, characterDefinitionId: 0, characterId: 901, viaSkillId: 0 } as never,
        },
      },
    ]
    const v = extractPreviewVector(previews, CTX)
    expect(v.switches_self).toBe(1)
    expect(v.forced_switches_opp).toBe(1)
  })

  it("captures self energy delta from modifyEntityVar", () => {
    const previews: PreviewData[] = [
      {
        mutation: {
          $case: "modifyEntityVar",
          value: {
            entityId: 100,
            entityDefinitionId: 0,
            variableName: "energy",
            variableValue: 1,
            direction: PbModifyDirection.INCREASE,
          } as never,
        },
      },
      {
        mutation: {
          $case: "modifyEntityVar",
          value: {
            entityId: 100,
            entityDefinitionId: 0,
            variableName: "energy",
            variableValue: 3,
            direction: PbModifyDirection.DECREASE,
          } as never,
        },
      },
    ]
    const v = extractPreviewVector(previews, CTX)
    expect(v.energy_gain_events_self).toBe(2)
    expect(v.energy_self_active_delta).toBe(-2)
  })

  it("flatten layout matches feature names order", () => {
    const v = extractPreviewVector(
      [dmg({ value: 7, targetId: 900, type: PbDamageType.HYDRO, reaction: 102 })],
      CTX,
    )
    const flat = flattenPreviewVector(v)
    const names = flatVectorFeatureNames()
    const idxDmgHydro = names.indexOf("preview_dmg_hydro")
    const idxReactVap = names.indexOf("preview_react_vaporize")
    expect(flat[idxDmgHydro]).toBe(7)
    expect(flat[idxReactVap]).toBe(1)
    expect(flat[names.indexOf("preview_dmg_pyro")]).toBe(0)
  })

  it("DAMAGE_TYPE_SLOTS and REACTION_FAMILY_SLOTS are exhaustive enough", () => {
    expect(DAMAGE_TYPE_SLOTS.length).toBeGreaterThanOrEqual(9)
    expect(REACTION_FAMILY_SLOTS.length).toBeGreaterThanOrEqual(8)
  })

  // ── V31 F5: immune-to-defeat (K_immune_break) ──

  it("detects opponent immune-triggered (HP→0 but survived) distinct from kill", () => {
    const immuneHit: PreviewData = {
      mutation: {
        $case: "damage",
        value: {
          damageType: PbDamageType.PYRO,
          value: 10,
          targetId: 900,
          targetDefinitionId: 0,
          sourceId: 0,
          sourceDefinitionId: 0,
          isSkillMainDamage: true,
          reactionType: 0 as never,
          causeDefeated: true,
          oldAura: 0 as never,
          newAura: 0 as never,
          oldHealth: 10,
          newHealth: 0,
          healKind: 2 /* HealKind.IMMUNE_DEFEATED */,
        } as never,
      },
    }
    const v = extractPreviewVector([immuneHit], CTX)
    expect(v.opp_immune_triggered).toBe(1)
    expect(v.self_immune_triggered).toBe(0)
    // immunity break is NOT a kill
    expect(v.opp_killed).toBe(true) // causeDefeated still true (engine semantics)
    // but the immune flag distinguishes it for K_immune_break
    const flat = flattenPreviewVector(v)
    const names = flatVectorFeatureNames()
    expect(flat[names.indexOf("preview_opp_immune_triggered")]).toBe(1)
  })

  it("non-immune kill leaves immune counters at zero", () => {
    const v = extractPreviewVector([dmg({ value: 10, targetId: 900, defeated: true })], CTX)
    expect(v.opp_immune_triggered).toBe(0)
    expect(v.self_immune_triggered).toBe(0)
  })
})
