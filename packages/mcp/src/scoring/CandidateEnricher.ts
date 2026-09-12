/**
 * CandidateEnricher — populates candidate_actions with real game data.
 *
 * Replaces hardcoded-zero fields (damage_estimate, reaction_value, tempo_value,
 * survival_risk) and enriches tags[] using the action's preview mutations,
 * skill/card definitions, and current player state.
 */

import type { CardIndexStore } from "../card-index/CardIndexStore";

// ── Element type enum (matches protobuf DiceType / DamageType) ──────────────
export const ELEMENT_NAMES: Record<number, string> = {
  0: "void",
  1: "cryo",
  2: "hydro",
  3: "pyro",
  4: "electro",
  5: "anemo",
  6: "geo",
  7: "dendro",
  8: "omni",
  9: "heal",         // pseudo-element for heal damage type
  10: "piercing",
};

// ── Reaction types from protobuf ────────────────────────────────────────────
export const REACTION_NAMES: Record<number, string> = {
  0: "none",
  1: "melt",
  2: "vaporize",
  3: "overloaded",
  4: "superconduct",
  5: "electroCharged",
  6: "frozen",
  7: "burning",
  8: "bloom",
  9: "quicken",
  10: "swirl",
  11: "crystallize",
};

const REACTION_VALUE_MAP: Record<string, number> = {
  melt: 3,
  vaporize: 3,
  overloaded: 3,
  superconduct: 2,
  electroCharged: 2,
  frozen: 2,
  burning: 2,
  bloom: 2,
  quicken: 2,
  swirl: 2,
  crystallize: 1,
  none: 0,
};

// ── Preview mutation helpers ────────────────────────────────────────────────

export type PreviewMutation = {
  mutation: {
    $case: string;
    value: Record<string, unknown>;
  };
};

export function extractPreviewMutations(action: Record<string, unknown>): PreviewMutation[] {
  const preview = Array.isArray(action.preview) ? action.preview : [];
  return preview.filter(
    (entry): entry is PreviewMutation =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as any).mutation?.$case === "string",
  );
}

export function sumDamageFromPreview(mutations: PreviewMutation[]): {
  totalDamage: number;
  totalHeal: number;
  reactionTypes: string[];
  damageElements: string[];
} {
  let totalDamage = 0;
  let totalHeal = 0;
  const reactionTypes: string[] = [];
  const damageElements: string[] = [];

  for (const entry of mutations) {
    if (entry.mutation.$case === "damage") {
      const v = entry.mutation.value;
      const damageType = typeof v.damageType === "number" ? v.damageType : -1;
      const dmgValue = typeof v.value === "number" ? v.value : 0;
      const healKind = typeof v.healKind === "number" ? v.healKind : 0;
      const reactionType = typeof v.reactionType === "number" ? v.reactionType : 0;

      if (healKind > 0 || damageType === 9) {
        // Heal mutation
        totalHeal += dmgValue;
      } else {
        totalDamage += dmgValue;
      }

      const elemName = ELEMENT_NAMES[damageType];
      if (elemName && elemName !== "void" && elemName !== "heal" && elemName !== "piercing" && elemName !== "omni") {
        if (!damageElements.includes(elemName)) {
          damageElements.push(elemName);
        }
      }

      if (reactionType > 0) {
        const name = REACTION_NAMES[reactionType] ?? `reaction_${reactionType}`;
        if (!reactionTypes.includes(name)) {
          reactionTypes.push(name);
        }
      }
    }
  }

  return { totalDamage, totalHeal, reactionTypes, damageElements };
}

function countEntityCreations(mutations: PreviewMutation[]): { summons: number; statuses: number } {
  let summons = 0;
  let statuses = 0;
  for (const entry of mutations) {
    if (entry.mutation.$case === "createEntity") {
      const entityType = typeof entry.mutation.value?.entity === "object"
        ? (entry.mutation.value.entity as Record<string, unknown>)?.type
        : undefined;
      if (entityType === 3) {
        summons++;
      } else {
        statuses++;
      }
    }
  }
  return { summons, statuses };
}

// ── Player / character helpers ──────────────────────────────────────────────

function getCharacterById(
  player: Record<string, unknown> | null,
  characterId: number,
): Record<string, unknown> | null {
  if (!player) return null;
  const characters = Array.isArray(player.character) ? player.character : [];
  return (
    characters.find(
      (ch: any) =>
        (ch?.id === characterId || ch?.definition?.id === characterId),
    ) ?? null
  ) as Record<string, unknown> | null;
}

function getActiveCharacter(
  player: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!player) return null;
  const activeId = player.activeCharacterId;
  if (typeof activeId !== "number") return null;
  return getCharacterById(player, activeId);
}

function getCharacterHpRatio(character: Record<string, unknown> | null): number | null {
  if (!character) return null;
  const ch = character as any;
  const vars = ch?.variable ?? ch?.variables;
  const hp = typeof ch?.health === "number" ? ch.health
    : typeof vars?.health === "number" ? vars.health : null;
  const maxHp = typeof ch?.maxHealth === "number" ? ch.maxHealth
    : typeof vars?.maxHealth === "number" ? vars.maxHealth : null;
  if (hp === null || maxHp === null || maxHp <= 0) return null;
  return hp / maxHp;
}

function getCharacterEnergy(character: Record<string, unknown> | null): {
  energy: number;
  maxEnergy: number;
} {
  const ch = character as any;
  const vars = ch?.variable ?? ch?.variables;
  return {
    energy: typeof ch?.energy === "number" ? ch.energy
      : typeof vars?.energy === "number" ? vars.energy : 0,
    maxEnergy: typeof ch?.maxEnergy === "number" ? ch.maxEnergy
      : typeof vars?.maxEnergy === "number" ? vars.maxEnergy : 0,
  };
}

// ── Public enricher ─────────────────────────────────────────────────────────

export interface EnrichmentContext {
  selfPlayer: Record<string, unknown> | null;
  opponentPlayer: Record<string, unknown> | null;
  /** The raw actions from pendingRequest.value.action */
  rawActions: Array<Record<string, unknown>>;
}

export class CandidateEnricher {
  constructor(private cardIndexStore: CardIndexStore) {}

  /**
   * Enrich candidate_actions in-place with real game data.
   * `candidateActions` is the array that will become digest.candidate_actions.
   * `ctx` provides the raw action objects and player state.
   */
  async enrichActionCandidates(
    candidateActions: Array<Record<string, unknown>>,
    ctx: EnrichmentContext,
  ): Promise<void> {
    for (let i = 0; i < candidateActions.length; i++) {
      const candidate = candidateActions[i];
      const actionCase = String(candidate.action_case ?? "unknown");
      const rawAction = ctx.rawActions[i] as Record<string, unknown> | undefined;

      if (!rawAction) continue;

      if (actionCase === "useSkill") {
        await this.enrichUseSkill(candidate, rawAction, ctx);
      } else if (actionCase === "playCard") {
        await this.enrichPlayCard(candidate, rawAction, ctx);
      } else if (actionCase === "switchActive") {
        this.enrichSwitchActive(candidate, rawAction, ctx);
      } else if (actionCase === "elementalTuning") {
        this.enrichElementalTuning(candidate, rawAction, ctx);
      } else if (actionCase === "declareEnd") {
        this.enrichDeclareEnd(candidate, ctx);
      }

      // Common: survival_risk from self active character HP
      this.enrichSurvivalRisk(candidate, ctx);
    }
  }

  /**
   * Enrich chooseActive candidates.
   */
  enrichChooseActiveCandidates(
    candidateActions: Array<Record<string, unknown>>,
    ctx: EnrichmentContext,
  ): void {
    for (const candidate of candidateActions) {
      if (candidate.action_case !== "chooseActive") continue;

      const notes = Array.isArray(candidate.notes) ? candidate.notes as string[] : [];
      const characterIdMatch = notes
        .map((n) => n.match(/character_id=(-?\d+)/))
        .find((m) => m !== null);
      const characterId = characterIdMatch
        ? parseInt(characterIdMatch[1], 10)
        : null;

      if (characterId !== null && ctx.selfPlayer) {
        const char = getCharacterById(ctx.selfPlayer, characterId);
        if (char) {
          const hpRatio = getCharacterHpRatio(char);
          const { energy, maxEnergy } = getCharacterEnergy(char);
          const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];

          // HP-based evaluation
          if (hpRatio !== null && hpRatio < 0.3) {
            candidate.survival_risk = 3;
            tags.push("low_hp");
          }
          if (hpRatio !== null && hpRatio > 0.7) {
            tags.push("healthy");
          }

          // Energy evaluation
          if (maxEnergy > 0 && energy >= maxEnergy) {
            tags.push("burst_ready");
            candidate.tempo_value = 2;
          } else if (maxEnergy > 0 && maxEnergy - energy <= 1) {
            tags.push("near_burst");
            candidate.tempo_value = 1;
          }

          candidate.tags = tags;
        }
      }
    }
  }

  // ── Private enrichment methods ──────────────────────────────────────────

  private async enrichUseSkill(
    candidate: Record<string, unknown>,
    rawAction: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): Promise<void> {
    const mutations = extractPreviewMutations(rawAction);
    const { totalDamage, totalHeal, reactionTypes, damageElements } =
      sumDamageFromPreview(mutations);
    const { summons, statuses } = countEntityCreations(mutations);

    // damage_estimate from preview
    candidate.damage_estimate = totalDamage + totalHeal * 0.8;

    // reaction_value from preview
    let reactionValue = 0;
    for (const rt of reactionTypes) {
      reactionValue += REACTION_VALUE_MAP[rt] ?? 1;
    }
    candidate.reaction_value = reactionValue;

    // tempo_value: fast action bonus
    const isFast = rawAction.isFast === true;
    candidate.tempo_value = isFast ? 2 : 0;

    // Enrich tags
    const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];
    const actionValue = (rawAction as any)?.action?.value;
    const skillDefId = typeof actionValue?.skillDefinitionId === "number"
      ? actionValue.skillDefinitionId
      : null;

    // Element tags
    for (const elem of damageElements) {
      if (!tags.includes(elem)) tags.push(elem);
    }
    // Reaction tags
    for (const rt of reactionTypes) {
      if (!tags.includes(rt)) tags.push(rt);
    }
    // Summon / status tags
    if (summons > 0 && !tags.includes("summon")) tags.push("summon");
    if (statuses > 0 && !tags.includes("status")) tags.push("status");
    if (totalHeal > 0 && !tags.includes("heal")) tags.push("heal");
    if (isFast && !tags.includes("fast")) tags.push("fast");

    // Skill type tags from card index
    if (skillDefId !== null) {
      const card = await this.cardIndexStore.getCardById(skillDefId).catch(() => null);
      if (card) {
        // Add kind-based tags
        if (card.definitionKind === "skill") {
          const effectLower = card.effectText.toLowerCase();
          if (effectLower.includes("元素爆发") || effectLower.includes("elemental burst")) {
            if (!tags.includes("burst")) tags.push("burst");
          } else if (effectLower.includes("元素战技") || effectLower.includes("elemental skill")) {
            if (!tags.includes("skill")) tags.push("skill");
          } else if (effectLower.includes("普通攻击") || effectLower.includes("normal attack")) {
            if (!tags.includes("normal_attack")) tags.push("normal_attack");
          }
        }

        // Fallback damage estimate from effectText when preview gives 0
        if (totalDamage === 0 && totalHeal === 0) {
          const dmgMatch = card.effectText.match(/造成\s*(\d+)\s*点/);
          if (dmgMatch) {
            candidate.damage_estimate = parseInt(dmgMatch[1], 10);
          }
        }
      }
    }

    // Energy gain detection from preview
    for (const m of mutations) {
      if (
        m.mutation.$case === "modifyEntityVar" &&
        m.mutation.value.variableName === "energy" &&
        m.mutation.value.direction === 1
      ) {
        if (!tags.includes("energy")) tags.push("energy");
        break;
      }
    }

    // Notes enrichment
    const notesArr = Array.isArray(candidate.notes) ? candidate.notes as string[] : [];
    if (totalDamage > 0) notesArr.push(`preview_damage=${totalDamage}`);
    if (totalHeal > 0) notesArr.push(`preview_heal=${totalHeal}`);
    if (reactionTypes.length > 0) notesArr.push(`reactions=${reactionTypes.join(",")}`);
    if (damageElements.length > 0) notesArr.push(`elements=${damageElements.join(",")}`);
    if (skillDefId !== null) notesArr.push(`skill_def_id=${skillDefId}`);
    candidate.notes = notesArr;

    candidate.tags = tags;
  }

  private async enrichPlayCard(
    candidate: Record<string, unknown>,
    rawAction: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): Promise<void> {
    const mutations = extractPreviewMutations(rawAction);
    const { totalDamage, totalHeal, reactionTypes, damageElements } =
      sumDamageFromPreview(mutations);
    const { summons, statuses } = countEntityCreations(mutations);

    candidate.damage_estimate = totalDamage + totalHeal * 0.8;

    let reactionValue = 0;
    for (const rt of reactionTypes) {
      reactionValue += REACTION_VALUE_MAP[rt] ?? 1;
    }
    candidate.reaction_value = reactionValue;

    const isFast = rawAction.isFast === true;
    candidate.tempo_value = isFast ? 2 : 0;

    const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];
    const actionValue = (rawAction as any)?.action?.value;
    const willBeEffectless = actionValue?.willBeEffectless === true;

    if (willBeEffectless && !tags.includes("effectless")) tags.push("effectless");
    if (isFast && !tags.includes("fast")) tags.push("fast");
    for (const elem of damageElements) {
      if (!tags.includes(elem)) tags.push(elem);
    }
    for (const rt of reactionTypes) {
      if (!tags.includes(rt)) tags.push(rt);
    }
    if (summons > 0 && !tags.includes("summon")) tags.push("summon");
    if (statuses > 0 && !tags.includes("status")) tags.push("status");
    if (totalHeal > 0 && !tags.includes("heal")) tags.push("heal");

    // Card definition lookup for tags
    const cardDefId = typeof actionValue?.cardDefinitionId === "number"
      ? actionValue.cardDefinitionId
      : null;
    if (cardDefId !== null) {
      const card = await this.cardIndexStore.getCardById(cardDefId).catch(() => null);
      if (card) {
        const effectLower = card.effectText.toLowerCase();
        if (effectLower.includes("治疗") || effectLower.includes("heal")) {
          if (!tags.includes("heal")) tags.push("heal");
        }
        if (effectLower.includes("护盾") || effectLower.includes("shield")) {
          if (!tags.includes("shield")) tags.push("shield");
        }
        if (effectLower.includes("召唤") || effectLower.includes("summon")) {
          if (!tags.includes("summon")) tags.push("summon");
        }
      }
    }

    const notesArr = Array.isArray(candidate.notes) ? candidate.notes as string[] : [];
    if (totalDamage > 0) notesArr.push(`preview_damage=${totalDamage}`);
    if (totalHeal > 0) notesArr.push(`preview_heal=${totalHeal}`);
    if (cardDefId !== null) notesArr.push(`card_def_id=${cardDefId}`);
    if (willBeEffectless) notesArr.push("will_be_effectless=true");
    candidate.notes = notesArr;

    candidate.tags = tags;
  }

  private enrichSwitchActive(
    candidate: Record<string, unknown>,
    rawAction: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): void {
    const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];
    const actionValue = (rawAction as any)?.action?.value;
    const targetCharId = typeof actionValue?.characterId === "number"
      ? actionValue.characterId
      : null;
    const targetDefId = typeof actionValue?.characterDefinitionId === "number"
      ? actionValue.characterDefinitionId
      : null;

    if (targetCharId !== null && ctx.selfPlayer) {
      const char = getCharacterById(ctx.selfPlayer, targetCharId);
      if (char) {
        const hpRatio = getCharacterHpRatio(char);
        const { energy, maxEnergy } = getCharacterEnergy(char);

        if (hpRatio !== null && hpRatio < 0.3) {
          candidate.survival_risk = (candidate.survival_risk as number ?? 0) + 2;
          tags.push("switch_to_low_hp");
        }
        if (maxEnergy > 0 && energy >= maxEnergy) {
          tags.push("burst_ready");
          candidate.tempo_value = 1;
        }
      }
    }

    const isFast = rawAction.isFast === true;
    candidate.tempo_value = isFast ? 2 : (candidate.tempo_value as number ?? 0);

    const notesArr = Array.isArray(candidate.notes) ? candidate.notes as string[] : [];
    if (targetDefId !== null) notesArr.push(`target_character_def_id=${targetDefId}`);
    candidate.notes = notesArr;
    candidate.tags = tags;
  }

  private enrichElementalTuning(
    candidate: Record<string, unknown>,
    rawAction: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): void {
    const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : [];
    const isFast = rawAction.isFast === true;
    candidate.tempo_value = isFast ? 2 : 0;
    if (isFast && !tags.includes("fast")) tags.push("fast");
    candidate.tags = tags;
  }

  private enrichDeclareEnd(
    candidate: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): void {
    candidate.tempo_value = -3;
  }

  private enrichSurvivalRisk(
    candidate: Record<string, unknown>,
    ctx: EnrichmentContext,
  ): void {
    const activeChar = getActiveCharacter(ctx.selfPlayer);
    const hpRatio = getCharacterHpRatio(activeChar);
    const existing = typeof candidate.survival_risk === "number" ? candidate.survival_risk : 0;

    if (hpRatio !== null && hpRatio <= 0.3) {
      candidate.survival_risk = existing + 2;
    } else if (hpRatio !== null && hpRatio <= 0.5) {
      candidate.survival_risk = existing + 1;
    }
  }
}
