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

import { access, readFile } from "node:fs/promises";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import type { CardIndexStore } from "../card-index/CardIndexStore";
import type { StandaloneMcpClient } from "../StandaloneMcpClient";
import type { TurnDigestV1 } from "../scoring/types";
import {
  extractPreviewMutations,
  sumDamageFromPreview,
} from "../scoring/CandidateEnricher";
const ACTION_CASE_NAMES = ["useSkill", "playCard", "switchActive", "elementalTuning", "declareEnd"];

export class TurnDigestBuilder {
  private client: StandaloneMcpClient;
  private cardIndexStore: CardIndexStore;
  private who: 0 | 1;

  constructor(client: StandaloneMcpClient, cardIndexStore: CardIndexStore, who: 0 | 1) {
    this.client = client;
    this.cardIndexStore = cardIndexStore;
    this.who = who;
  }

  private extractIntArray(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((v) => Number.isInteger(v)) : [];
  }

  private extractOneofValue(pendingRequest: unknown, caseName: string): Record<string, unknown> | null {
    if (!pendingRequest || typeof pendingRequest !== "object") return null;
    const pr = pendingRequest as Record<string, unknown>;
    if (pr.$case === caseName && pr.value && typeof pr.value === "object") {
      return pr.value as Record<string, unknown>;
    }
    const inline = pr[caseName];
    if (inline && typeof inline === "object") {
      return inline as Record<string, unknown>;
    }
    return null;
  }

  private extractOneofCase(envelope: unknown, knownNames: string[]): string | null {
    if (!envelope || typeof envelope !== "object") return null;
    const obj = envelope as Record<string, unknown>;
    if (typeof obj.$case === "string" && knownNames.includes(obj.$case)) {
      return obj.$case;
    }
    for (const name of knownNames) {
      if (name in obj) return name;
    }
    return null;
  }

  private normalizePendingMethod(method: string | null | undefined): string | null {
    if (!method) return null;
    const valid = ["action", "chooseActive", "rerollDice", "switchHands", "selectCard"];
    return valid.includes(method) ? method : null;
  }

  private extractCharacterSummaries(
    player: Record<string, unknown> | null,
  ): Array<Record<string, unknown>> {
    if (!player) return [];
    const characters = Array.isArray((player as any).character)
      ? (player as any).character
      : [];
    return characters.map((c: any) => {
      const v = c?.variable ?? c?.variables ?? {};
      const hp = typeof c?.health === "number" ? c.health
        : typeof v.health === "number" ? v.health : 0;
      const maxHp = typeof c?.maxHealth === "number" ? c.maxHealth
        : typeof v.maxHealth === "number" ? v.maxHealth : 10;
      const energy = typeof c?.energy === "number" ? c.energy
        : typeof v.energy === "number" ? v.energy : 0;
      const maxEnergy = typeof c?.maxEnergy === "number" ? c.maxEnergy
        : typeof v.maxEnergy === "number" ? v.maxEnergy : 0;
      const defeated = c?.defeated;
      const alive = typeof defeated === "boolean" ? !defeated
        : typeof v.alive === "number" ? v.alive > 0 : hp > 0;
      const aura = c?.aura ?? v?.aura ?? null;
      const auraType = typeof aura === "number" ? aura : null;
      return {
        id: typeof c?.id === "number" ? c.id : 0,
        hp,
        max_hp: maxHp,
        energy,
        max_energy: maxEnergy,
        alive,
        aura: auraType,
      };
    });
  }

  private resolveScreenPlayers(
    screen: Record<string, unknown> | null,
  ): { selfPlayer: Record<string, unknown> | null; opponentPlayer: Record<string, unknown> | null } {
    const s = screen as any;
    if (Array.isArray(s?.player)) {
      const players = s.player;
      return {
        selfPlayer: players[this.who] ?? null,
        opponentPlayer: players[this.who === 0 ? 1 : 0] ?? null,
      };
    }
    if (Array.isArray(s?.players)) {
      return {
        selfPlayer: s?.player ?? s.players[this.who] ?? null,
        opponentPlayer: s.players[this.who === 0 ? 1 : 0] ?? null,
      };
    }
    return {
      selfPlayer: s?.player ?? null,
      opponentPlayer: s?.opponent ?? null,
    };
  }

  private diceTypeLabel(type: number): string {
    const labels: Record<number, string> = {
      1: "cryo", 2: "hydro", 3: "pyro", 4: "electro",
      5: "anemo", 6: "geo", 7: "dendro", 8: "omni",
    };
    return labels[type] ?? `dice_${type}`;
  }

  private diceCostLabel(type: number): string {
    const labels: Record<number, string> = {
      0: "void", 1: "cryo", 2: "hydro", 3: "pyro", 4: "electro",
      5: "anemo", 6: "geo", 7: "dendro", 8: "aligned", 9: "energy", 10: "legend",
    };
    return labels[type] ?? `cost_${type}`;
  }

  private getDiceMapping(): Record<string, string> {
    return {
      "1": "cryo", "2": "hydro", "3": "pyro", "4": "electro",
      "5": "anemo", "6": "geo", "7": "dendro", "8": "omni",
    };
  }

  private resolveSkillTypeFromAsset(data: Record<string, unknown> | null): string | null {
    if (!data) return null;
    const gcgType = String(data.type ?? "");
    if (gcgType.endsWith("_A")) return "normal_attack";
    if (gcgType.endsWith("_E")) return "elemental_skill";
    if (gcgType.endsWith("_Q")) return "burst";
    return null;
  }

  private countEntityCreationsFromPreview(
    mutations: ReturnType<typeof extractPreviewMutations>,
  ): { summons: number; statuses: number } {
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

  private computeCandidateEnrichment(
    action: any,
    actionCase: string,
    selfChars: any[],
    oppChars: any[],
    selfActiveChar: any | undefined,
    oppActiveChar: any | undefined,
    diceArr: number[],
    characterIndex: Map<number, any>,
    skillTypeMap: Map<number, string>,
  ): {
    damage_estimate: number;
    reaction_type: string | null;
    reaction_bonus: number;
    total_damage: number;
    target_char_name: string;
    target_hp_after: number;
    kills: boolean;
    dice_cost_detail: { required: Record<string, number>; available: Record<string, number>; affordable: boolean; omni_needed: number };
    self_energy_after: number | null;
    aura_change: string | null;
    enriched_tags: string[];
    enriched_notes: string[];
  } {
    const defaults = {
      damage_estimate: 0,
      reaction_type: null as string | null,
      reaction_bonus: 0,
      total_damage: 0,
      target_char_name: "none",
      target_hp_after: 0,
      kills: false,
      dice_cost_detail: { required: {} as Record<string, number>, available: {} as Record<string, number>, affordable: true, omni_needed: 0 },
      self_energy_after: null as number | null,
      aura_change: null as string | null,
      enriched_tags: [] as string[],
      enriched_notes: [] as string[],
    };

    const requiredCost: Array<{ type?: number; count?: number }> = Array.isArray(action.requiredCost) ? action.requiredCost : [];
    const diceReq: Record<string, number> = {};
    for (const entry of requiredCost) {
      const t = entry.type;
      const n = entry.count ?? 0;
      if (Number.isInteger(t) && n > 0) {
        const label = this.diceCostLabel(t!);
        diceReq[label] = (diceReq[label] ?? 0) + n;
      }
    }
    const diceAvail: Record<string, number> = {};
    let omniCount = 0;
    for (const d of diceArr) {
      const label = this.diceTypeLabel(d);
      if (d === 8) { omniCount++; continue; }
      diceAvail[label] = (diceAvail[label] ?? 0) + 1;
    }

    let omniNeeded = 0;
    let affordable = true;
    const diceAvailCopy: Record<string, number> = {};
    for (const k of Object.keys(diceAvail)) diceAvailCopy[k] = diceAvail[k];
    let omniAvail = omniCount;

    for (const entry of requiredCost) {
      const t = entry.type;
      const n = entry.count ?? 0;
      if (!Number.isInteger(t) || n <= 0) continue;
      if (t === 0 || t === 9) continue;
      const label = this.diceTypeLabel(t!);
      const have = diceAvailCopy[label] ?? 0;
      const need = n;
      if (have >= need) {
        diceAvailCopy[label] = have - need;
      } else {
        const shortfall = need - have;
        diceAvailCopy[label] = 0;
        if (omniAvail >= shortfall) {
          omniAvail -= shortfall;
          omniNeeded += shortfall;
        } else {
          affordable = false;
          omniNeeded += shortfall;
        }
      }
    }

    defaults.dice_cost_detail = { required: diceReq, available: diceAvail, affordable, omni_needed: omniNeeded };

    const auraLabel = (v: number): string => {
      const auras: Record<number, string> = { 1: "cryo", 2: "hydro", 3: "pyro", 4: "electro", 5: "anemo", 6: "geo", 7: "dendro" };
      return auras[v] ?? "none";
    };
    const charAura = (c: any): number | null => {
      const a = c?.aura ?? c?.variable?.aura ?? c?.variables?.aura;
      return typeof a === "number" ? a : null;
    };
    const charDefId = (c: any): number =>
      typeof c?.definitionId === "number" ? c.definitionId : typeof c?.definition_id === "number" ? c.definition_id : 0;
    const charHp = (c: any): number => {
      const v = c?.variable ?? c?.variables ?? {};
      return typeof c?.health === "number" ? c.health : typeof v.health === "number" ? v.health : 0;
    };
    const charEnergy = (c: any): number => {
      const v = c?.variable ?? c?.variables ?? {};
      return typeof c?.energy === "number" ? c.energy : typeof v.energy === "number" ? v.energy : 0;
    };
    const charMaxEnergy = (c: any): number => {
      const v = c?.variable ?? c?.variables ?? {};
      return typeof v.maxEnergy === "number" ? v.maxEnergy : 3;
    };
    const charName = (c: any): string => {
      const did = charDefId(c);
      const entry = characterIndex.get(did);
      return entry?.canonicalName ?? `Character ${did}`;
    };

    const reactionTable: Record<string, { name: string; bonus: number }> = {
      "pyro_cryo": { name: "melt", bonus: 2 }, "cryo_pyro": { name: "melt_reverse", bonus: 1 },
      "hydro_pyro": { name: "vaporize", bonus: 2 }, "pyro_hydro": { name: "vaporize_reverse", bonus: 1 },
      "cryo_hydro": { name: "freeze", bonus: 0 }, "hydro_cryo": { name: "freeze", bonus: 0 },
      "pyro_electro": { name: "overloaded", bonus: 2 }, "electro_pyro": { name: "overloaded", bonus: 2 },
      "hydro_electro": { name: "electro_charged", bonus: 1 }, "electro_hydro": { name: "electro_charged", bonus: 1 },
      "cryo_electro": { name: "superconduct", bonus: 1 }, "electro_cryo": { name: "superconduct", bonus: 1 },
      "pyro_dendro": { name: "burning", bonus: 1 }, "dendro_pyro": { name: "burning", bonus: 1 },
      "hydro_dendro": { name: "bloom", bonus: 0 }, "dendro_hydro": { name: "bloom", bonus: 0 },
      "electro_dendro": { name: "quicken", bonus: 0 }, "dendro_electro": { name: "quicken", bonus: 0 },
    };

    switch (actionCase) {
      case "useSkill": {
        const isFast = action?.isFast === true;
        const skillVal = this.extractOneofValue(action?.action, "useSkill") ?? action?.action?.value;
        const skillDefId = skillVal?.skill?.definition?.id ?? skillVal?.skillDefinitionId ?? 0;
        const callerDefId = skillVal?.caller?.definition?.id ?? skillVal?.callerDefinitionId ?? 0;

        const caller = selfChars.find((c) => charDefId(c) === callerDefId) ?? selfActiveChar;
        const callerElement = (() => {
          if (!caller) return "unknown";
          const entry = characterIndex.get(charDefId(caller));
          if (entry?.tags) {
            const elTypes = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"];
            return entry.tags.find((t: string) => elTypes.includes(t)) ?? "unknown";
          }
          return "unknown";
        })();
        const callerName = caller ? charName(caller) : "unknown";

        const skillEntry = characterIndex.get(skillDefId);
        const skillText = skillEntry?.effectText ?? "";
        const skillName = skillEntry?.canonicalName ?? `Skill ${skillDefId}`;

        const previewMutations = extractPreviewMutations(action);
        const preview = sumDamageFromPreview(previewMutations);
        const hasPreview = preview.totalDamage > 0 || preview.totalHeal > 0;
        const entityCreations = this.countEntityCreationsFromPreview(previewMutations);

        let baseDmg = hasPreview ? preview.totalDamage : 3;
        if (!hasPreview) {
          const dmgMatch = skillText.match(/造成(\d+)点/);
          if (dmgMatch) baseDmg = parseInt(dmgMatch[1], 10);
        }

        const hasEnergyCost = Array.isArray(action.requiredCost)
          ? action.requiredCost.some((c: any) => (c.type ?? c.diceType) === 9)
          : false;
        const isBurst = hasEnergyCost;
        let skillTypeTag: string;
        const resolved = skillTypeMap.get(skillDefId);
        if (resolved) {
          skillTypeTag = resolved;
        } else {
          const isNormalAttack = !isBurst && (
            skillText.includes("普通攻击") || skillText.includes("Normal Attack") ||
            skillName.includes("普通攻击")
          );
          skillTypeTag = isBurst ? "burst"
            : isNormalAttack ? "normal_attack"
            : "elemental_skill";
        }
        if (skillTypeTag === "normal_attack") baseDmg = baseDmg > 2 ? 2 : baseDmg;
        if (isBurst && baseDmg < 5) baseDmg = 6;

        const callerWeaponType = (() => {
          if (!caller) return "unknown";
          const entry = characterIndex.get(charDefId(caller));
          if (entry?.tags) {
            const wpTypes = ["sword", "claymore", "pole", "catalyst", "bow", "otherWeapon"];
            return entry.tags.find((t: string) => wpTypes.includes(t)) ?? "unknown";
          }
          return "unknown";
        })();
        const isNormalPhysical = skillTypeTag === "normal_attack" && callerWeaponType !== "catalyst";
        const effectiveCallerElement = isNormalPhysical ? "physical" : callerElement;
        const appliesElement = !isNormalPhysical && callerElement !== "unknown";

        const target = oppActiveChar;
        const targetAura = target ? charAura(target) : null;
        const targetHp = target ? charHp(target) : 0;
        const targetName = target ? charName(target) : "unknown";

        let reactionType: string | null = null;
        let reactionBonus = 0;
        if (hasPreview && preview.reactionTypes.length > 0) {
          reactionType = preview.reactionTypes.join(",");
          const REACTION_BONUS: Record<string, number> = {
            melt: 2, vaporize: 2, overloaded: 2, superconduct: 1,
            electroCharged: 1, frozen: 0, burning: 1, bloom: 0,
            quicken: 0, swirl: 1, crystallize: 0,
          };
          for (const rt of preview.reactionTypes) {
            reactionBonus += REACTION_BONUS[rt] ?? 0;
          }
        } else if (targetAura != null && targetAura > 0 && appliesElement) {
          const auraEl = auraLabel(targetAura);
          const key = `${callerElement}_${auraEl}`;
          const reaction = reactionTable[key];
          if (reaction) {
            reactionType = reaction.name;
            reactionBonus = reaction.bonus;
          }
        }

        const totalDmg = baseDmg + reactionBonus;
        const targetHpAfter = Math.max(0, targetHp - totalDmg);
        const kills = targetHp > 0 && totalDmg >= targetHp;

        const currentEnergy = caller ? charEnergy(caller) : 0;
        const maxEnergy = caller ? charMaxEnergy(caller) : 3;
        const energyGain = isBurst ? -maxEnergy : 1;
        const energyAfter = Math.max(0, Math.min(maxEnergy, currentEnergy + energyGain));

        const auraChange = appliesElement ? `apply_${callerElement}` : null;

        const extraTags: string[] = [];
        const extraNotes: string[] = [];
        if (entityCreations.summons > 0) {
          extraTags.push("summon");
          extraNotes.push(`creates ${entityCreations.summons} summon(s)`);
        }
        if (entityCreations.statuses > 0) {
          extraTags.push("status");
          extraNotes.push(`creates ${entityCreations.statuses} status(es)`);
        }
        if (preview.totalHeal > 0) {
          extraTags.push("heal");
          extraNotes.push(`heal ${preview.totalHeal}`);
        }

        return {
          ...defaults,
          damage_estimate: baseDmg,
          reaction_type: reactionType,
          reaction_bonus: reactionBonus,
          total_damage: totalDmg,
          target_char_name: targetName,
          target_hp_after: targetHpAfter,
          kills,
          self_energy_after: isBurst ? 0 : energyAfter,
          aura_change: auraChange,
          enriched_tags: [
            skillTypeTag,
            isFast ? "fast_action" : "combat_action",
            effectiveCallerElement,
            reactionType ?? "no_reaction",
            kills ? "lethal" : "non_lethal",
            ...extraTags,
          ].filter(Boolean),
          enriched_notes: [
            `${callerName} uses ${skillName}`,
            `${skillTypeTag}: ${baseDmg} dmg${isNormalPhysical ? " (physical — no element application)" : ""}${isFast ? " [fast action — you will act again]" : " [combat action — turn passes]"}`,
            `skill_def_id=${skillDefId}`,
            reactionType ? `reaction: ${reactionType} (+${reactionBonus}) → total ${totalDmg} dmg` : `no reaction → ${totalDmg} dmg`,
            kills ? `KILLS ${targetName} (${targetHp}→0)` : `${targetName}: ${targetHp}→${targetHpAfter} HP`,
            energyAfter < maxEnergy ? `${callerName} energy: ${currentEnergy}→${energyAfter}/${maxEnergy}` : `${callerName} burst ready!`,
            ...extraNotes,
          ],
        };
      }

      case "switchActive": {
        const isFast = action?.isFast === true;
        const switchVal = this.extractOneofValue(action?.action, "switchActive") ?? action?.action?.value;
        const toDefId = switchVal?.to?.definition?.id ?? switchVal?.to?.definitionId ?? 0;
        const targetChar = selfChars.find((c) => charDefId(c) === toDefId);
        const targetName = targetChar ? charName(targetChar) : `Char ${toDefId}`;
        const targetHp = targetChar ? charHp(targetChar) : 0;
        const targetEnergy = targetChar ? charEnergy(targetChar) : 0;
        const targetMaxEnergy = targetChar ? charMaxEnergy(targetChar) : 3;
        const targetAura = targetChar ? charAura(targetChar) : null;

        return {
          ...defaults,
          target_char_name: targetName,
          target_hp_after: targetHp,
          aura_change: `self_aura_${targetAura != null ? auraLabel(targetAura) : "none"}`,
          enriched_tags: ["switch", isFast ? "fast_action" : "combat_action", "valid"],
          enriched_notes: [
            `Switch to ${targetName}`,
            `HP: ${targetHp}, Energy: ${targetEnergy}/${targetMaxEnergy}`,
            targetAura != null ? `Self aura: ${auraLabel(targetAura)}` : "No self aura",
            isFast ? "⏩ Fast action — you will act again" : "⏳ Combat action — turn passes to opponent",
          ],
        };
      }

      case "playCard": {
        const isFast = action?.isFast === true;
        const cardVal = this.extractOneofValue(action?.action, "playCard") ?? action?.action?.value;
        const cardDefId = cardVal?.card?.definition?.id ?? cardVal?.cardDefinitionId ?? 0;
        const cardEntry = characterIndex.get(cardDefId);
        const cardName = cardEntry?.canonicalName ?? `Card ${cardDefId}`;
        const cardType = cardEntry?.type ?? "unknown";
        const cardEffect = cardEntry?.effectText ?? "";

        const previewMutations = extractPreviewMutations(action);
        const preview = sumDamageFromPreview(previewMutations);
        const hasPreview = preview.totalDamage > 0 || preview.totalHeal > 0;
        const entityCreations = this.countEntityCreationsFromPreview(previewMutations);

        let cardDmg = hasPreview ? preview.totalDamage : 0;
        let cardHeal = hasPreview ? preview.totalHeal : 0;

        if (!hasPreview) {
          const dmgPatterns = [
            /造成(\d+)点/g,
            /造成([^，,]*?)点(?:伤害|物理伤害|元素伤害)/g,
            /伤害[值数量]+[为]*(\d+)/g,
            /回复.*?(\d+)点/g,
            /治疗.*?(\d+)点/g,
          ];
          for (const pat of dmgPatterns) {
            let m: RegExpExecArray | null;
            while ((m = pat.exec(cardEffect)) !== null) {
              const val = parseInt(m[1], 10);
              if (!isNaN(val) && val > 0) {
                if (pat.source.includes("回复") || pat.source.includes("治疗")) {
                  cardHeal += val;
                } else {
                  cardDmg += val;
                }
              }
            }
          }
        }

        const tags = [
          "card", cardType, isFast ? "fast_action" : "combat_action",
          cardDmg > 0 ? "damage_card" : "",
          cardHeal > 0 ? "heal_card" : "",
          cardDmg === 0 && cardHeal === 0 ? "utility_card" : "",
        ].filter(Boolean);
        if (entityCreations.summons > 0) tags.push("summon");
        if (entityCreations.statuses > 0) tags.push("status");
        const notes = [
          `${cardName} (${cardType})`,
          isFast ? "⏩ Fast action — play then act again" : "⏳ Combat action — turn passes to opponent",
          `definition_id=${cardDefId}`,
          cardDmg > 0 ? `est. damage: ${cardDmg}` : "",
          cardHeal > 0 ? `est. heal: ${cardHeal}` : "",
          entityCreations.summons > 0 ? `creates ${entityCreations.summons} summon(s)` : "",
          entityCreations.statuses > 0 ? `creates ${entityCreations.statuses} status(es)` : "",
          cardEffect.substring(0, 80),
        ].filter(Boolean);

        return {
          ...defaults,
          damage_estimate: cardDmg,
          total_damage: cardDmg,
          enriched_tags: tags,
          enriched_notes: notes,
        };
      }

      case "declareEnd": {
        return {
          ...defaults,
          enriched_tags: ["declareEnd", "end_turn", "consumes_turn"],
          enriched_notes: ["End turn — conserve remaining dice and pass priority"],
        };
      }

      case "elementalTuning": {
        const isFast = action?.isFast === true;
        return {
          ...defaults,
          enriched_tags: ["elementalTuning", "dice_fix", isFast ? "fast_action" : "combat_action"],
          enriched_notes: [
            isFast
              ? "⏩ Elemental tuning — discard 1 card to convert 1 die, then act again"
              : "⏳ Elemental tuning — discard 1 card to convert 1 die (combat action)",
          ],
        };
      }

      default:
        defaults.enriched_notes.push(`unknown action case: ${actionCase}`);
        return defaults;
    }
  }

  private async buildCharacterDefinitions(
    selfPlayer: Record<string, unknown> | null,
    opponentPlayer: Record<string, unknown> | null,
  ): Promise<TurnDigestV1["character_definitions"]> {
    const defs: TurnDigestV1["character_definitions"] = [];
    const cardIndex = (this.cardIndexStore as any).characters as Map<number, any> | undefined;

    const processPlayer = async (player: Record<string, unknown> | null, _isOpponent: boolean) => {
      if (!player) return;
      const cardIndexMap = cardIndex ?? new Map();
      const chars = Array.isArray((player as any).character) ? (player as any).character : [];
      for (const c of chars) {
        const id = typeof c?.id === "number" ? c.id : 0;
        const defId = typeof c?.definitionId === "number" ? c.definitionId
          : typeof c?.definition_id === "number" ? c.definition_id : 0;
        if (defId > 0 && !defs.some((d) => d.definition_id === defId)) {
          const indexed = cardIndexMap.get(defId);
          const name = indexed?.canonicalName ?? `Character ${defId}`;
          let element = "unknown";
          let weaponType = "unknown";
          if (indexed?.tags) {
            const elTypes = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"];
            const wpTypes = ["sword", "claymore", "pole", "catalyst", "bow", "otherWeapon"];
            for (const tag of indexed.tags) {
              if (elTypes.includes(tag)) element = tag;
              if (wpTypes.includes(tag)) weaponType = tag;
            }
          }
          defs.push({
            id,
            definition_id: defId,
            name,
            element,
            weapon_type: weaponType,
            skills: (indexed?.skills ?? []).map((sk: any) => ({
              name: `Skill ${sk.id}`,
              description: sk.description ?? `Skill ID: ${sk.id}`,
              cost: sk.cost ?? 0,
              damage_type: (() => {
                const skillTypeTag = (() => {
                  const gcgType = String(sk.type ?? "");
                  if (gcgType.endsWith("_A")) return "normal_attack";
                  if (gcgType.endsWith("_E")) return "elemental_skill";
                  if (gcgType.endsWith("_Q")) return "burst";
                  return sk.cost > 0 ? "burst" : "elemental_skill";
                })();
                if (skillTypeTag === "normal_attack" && weaponType !== "catalyst") return "physical";
                return element;
              })(),
            })),
          });
        }
      }
    };

    await processPlayer(selfPlayer, false);
    await processPlayer(opponentPlayer, true);
    return defs;
  }

  private async buildCardDefinitions(
    player: Record<string, unknown> | null,
  ): Promise<TurnDigestV1["card_definitions"]> {
    const defs: TurnDigestV1["card_definitions"] = [];
    if (!player) return defs;
    const handCards = Array.isArray((player as any).handCard) ? (player as any).handCard : [];
    // Count occurrences of each definitionId in hand
    const handCountMap = new Map<number, number>();
    for (const card of handCards) {
      const defId = typeof card?.definitionId === "number" ? card.definitionId
        : typeof card?.definition_id === "number" ? card.definition_id : 0;
      if (defId > 0) {
        handCountMap.set(defId, (handCountMap.get(defId) ?? 0) + 1);
      }
    }
    const seen = new Set<number>();
    for (const card of handCards) {
      const defId = typeof card?.definitionId === "number" ? card.definitionId
        : typeof card?.definition_id === "number" ? card.definition_id : 0;
      if (defId > 0 && !seen.has(defId)) {
        seen.add(defId);
        const indexed = await this.cardIndexStore.getCardById(defId);
        if (indexed) {
          const cost = (Array.isArray(card.definitionCost) ? card.definitionCost : [])
            .reduce((sum: number, e: any) => sum + (typeof e.count === "number" ? e.count : 0), 0);
          defs.push({
            definition_id: defId,
            name: indexed.canonicalName,
            type: indexed.type,
            tags: [indexed.type, ...indexed.tags.filter((t: string) => t !== indexed.type)],
            cost,
            effect_text: indexed.effectText ?? "",
            count_in_hand: handCountMap.get(defId) ?? 0,
            duration: (() => {
              const type = indexed.type;
              const tags = indexed.tags ?? [];
              if (type === "event") return "immediate";
              if (tags.some((t: string) => t.toLowerCase() === "food")) return "this_round";
              if (type === "support") return "permanent";
              if (type === "equipment") return "permanent";
              if (tags.some((t: string) => t === "weapon" || t === "artifact")) return "permanent";
              return "this_round";
            })(),
          });
        }
      }
    }
    return defs;
  }

  private computeKillThreats(
    selfPlayer: Record<string, unknown> | null,
    opponentPlayer: Record<string, unknown> | null,
    diceCount: number,
  ): {
    my_kill_threats: Array<{
      target: string;
      target_definition_id: number;
      target_hp: number;
      max_possible_damage: number;
      likely_kill: boolean;
      requires_reaction: boolean;
      shield_estimate: number;
    }>;
    opponent_kill_threats: Array<{
      my_character: string;
      my_character_id: number;
      my_hp: number;
      max_possible_damage: number;
      likely_kill: boolean;
      shield_estimate: number;
    }>;
  } {
    const result = {
      my_kill_threats: [] as Array<{
        target: string;
        target_definition_id: number;
        target_hp: number;
        max_possible_damage: number;
        likely_kill: boolean;
        requires_reaction: boolean;
        shield_estimate: number;
      }>,
      opponent_kill_threats: [] as Array<{
        my_character: string;
        my_character_id: number;
        my_hp: number;
        max_possible_damage: number;
        likely_kill: boolean;
        shield_estimate: number;
      }>,
    };

    if (!selfPlayer || !opponentPlayer) return result;

    const selfChars = Array.isArray((selfPlayer as any).character) ? (selfPlayer as any).character : [];
    const oppChars = Array.isArray((opponentPlayer as any).character) ? (opponentPlayer as any).character : [];

    const estimatePlayerShields = (player: Record<string, unknown>): number => {
      let total = 0;
      // Combat statuses with shield (e.g. Crystallize shields)
      const combatStatuses = Array.isArray((player as any).combatStatus)
        ? (player as any).combatStatus : [];
      for (const cs of combatStatuses) {
        const shield = typeof cs?.shield === "number" ? cs.shield : 0;
        if (shield > 0) total += shield;
      }
      // Character entity shields (equipment/statuses that grant shield)
      const chars = Array.isArray((player as any).character) ? (player as any).character : [];
      for (const ch of chars) {
        const entities = Array.isArray(ch?.entity) ? ch.entity : [];
        for (const ent of entities) {
          const shield = typeof ent?.shield === "number" ? ent.shield : 0;
          if (shield > 0) total += shield;
        }
      }
      return total;
    };

    const oppShields = estimatePlayerShields(opponentPlayer as Record<string, unknown>);
    const selfShields = estimatePlayerShields(selfPlayer as Record<string, unknown>);

    const getCharHp = (c: any): number =>
      typeof c?.health === "number" ? c.health
        : typeof c?.variable?.health === "number" ? c.variable.health : 10;

    const getCharAlive = (c: any): boolean => {
      if (typeof c?.defeated === "boolean") return !c.defeated;
      const vhp = typeof c?.variable?.alive === "number" ? c.variable.alive : -1;
      if (vhp >= 0) return vhp > 0;
      return getCharHp(c) > 0;
    };

    const getCharEnergy = (c: any): number =>
      typeof c?.energy === "number" ? c.energy
        : typeof c?.variable?.energy === "number" ? c.variable.energy : 0;

    const getCharMaxEnergy = (c: any): number =>
      typeof c?.maxEnergy === "number" ? c.maxEnergy
        : typeof c?.variable?.maxEnergy === "number" ? c.variable.maxEnergy : 3;

    const getCharAura = (c: any): number | null => {
      const aura = c?.aura ?? c?.variable?.aura ?? null;
      return typeof aura === "number" ? aura : null;
    };

    const getCharDefId = (c: any): number =>
      typeof c?.definitionId === "number" ? c.definitionId
        : typeof c?.definition_id === "number" ? c.definition_id : 0;

    const estimateReactionBonus = (_atkElement: string, defAura: number | null): number => {
      if (defAura == null) return 0;
      return defAura > 0 ? 1 : 0;
    };

    const estimateKillDamage = (attacker: any): number => {
      const energy = getCharEnergy(attacker);
      const maxEnergy = getCharMaxEnergy(attacker);
      if (energy >= maxEnergy && maxEnergy > 0) return 7;
      return 3;
    };

    const selfActiveId = (selfPlayer as any).activeCharacterId;
    const selfActive = selfChars.find((c: any) => c?.id === selfActiveId) ?? selfChars[0];

    if (selfActive && diceCount >= 3) {
      const myDmg = estimateKillDamage(selfActive);
      for (const opp of oppChars) {
        if (!getCharAlive(opp)) continue;
        const oppHp = getCharHp(opp);
        const oppAura = getCharAura(opp);
        const bonus = estimateReactionBonus("", oppAura);
        const totalDmg = myDmg + bonus;
        result.my_kill_threats.push({
          target: `character_${getCharDefId(opp)}`,
          target_definition_id: getCharDefId(opp),
          target_hp: oppHp,
          max_possible_damage: totalDmg,
          likely_kill: totalDmg >= (oppHp + oppShields),
          requires_reaction: bonus > 0,
          shield_estimate: oppShields,
        });
      }
    }

    const oppActiveId = (opponentPlayer as any).activeCharacterId;
    const oppActive = oppChars.find((c: any) => c?.id === oppActiveId) ?? oppChars[0];

    if (oppActive) {
      const oppDmg = estimateKillDamage(oppActive);
      for (const c of selfChars) {
        if (!getCharAlive(c)) continue;
        const hp = getCharHp(c);
        result.opponent_kill_threats.push({
          my_character: `character_${c?.id ?? 0}`,
          my_character_id: c?.id ?? 0,
          my_hp: hp,
          max_possible_damage: oppDmg,
          likely_kill: hp <= (oppDmg - selfShields),
          shield_estimate: selfShields,
        });
      }
    }

    return result;
  }

  async buildDigestArtifacts(
    sessionId: string,
    status: Record<string, unknown> | any,
    getPlanFilePath: (sessionId: string) => string,
  ): Promise<{
    digest: TurnDigestV1;
    candidateActionMap: Map<string, { tool: string; args: Record<string, unknown> }>;
  } | null> {
    const pendingMethod = this.normalizePendingMethod((status as any).pendingMethod);
    if (!pendingMethod) return null;

    const now = Date.now();
    const digestRef = `digest_${sessionId}_${now}`;
    const pendingRequest = (status as any).pendingRequest;
    const candidateActionMap = new Map<string, { tool: string; args: Record<string, unknown> }>();
    const candidates: Array<Record<string, unknown>> = [];

    const screen = await this.client.getScreenState().catch(() => null);
    const { selfPlayer, opponentPlayer } = this.resolveScreenPlayers(screen as any);

    const selfCharsRaw = Array.isArray((selfPlayer as any)?.character) ? (selfPlayer as any).character as any[] : [];
    const oppCharsRaw = Array.isArray((opponentPlayer as any)?.character) ? (opponentPlayer as any).character as any[] : [];

    const charDefId = (c: any): number =>
      typeof c?.definitionId === "number" ? c.definitionId : typeof c?.definition_id === "number" ? c.definition_id : 0;

    const selfCharIds = selfCharsRaw.map(charDefId).filter((id: number) => id > 0);
    const oppCharIds = oppCharsRaw.map(charDefId).filter((id: number) => id > 0);
    const allCharIds = [...new Set([...selfCharIds, ...oppCharIds])];
    const characterIndex = new Map<number, any>();
    for (const defId of allCharIds) {
      const entry = await this.cardIndexStore.getCardById(defId);
      if (entry) characterIndex.set(defId, entry);
    }

    const selfActiveId = (selfPlayer as any)?.activeCharacterId;
    const oppActiveId = (opponentPlayer as any)?.activeCharacterId;
    const selfActiveChar = selfCharsRaw.find((c) => c?.id === selfActiveId) ?? selfCharsRaw[0];
    const oppActiveChar = oppCharsRaw.find((c) => c?.id === oppActiveId) ?? oppCharsRaw[0];

    const extractDiceArray = (player: any): number[] => {
      const dice = player?.dice;
      if (Array.isArray(dice)) return dice as number[];
      return [];
    };
    const diceArr = extractDiceArray(selfPlayer as any);

    const skillTypeMap = new Map<number, string>();
    if (pendingMethod === "action") {
      const actionData = this.extractOneofValue(pendingRequest, "action");
      const actions = actionData && Array.isArray(actionData.action)
        ? (actionData.action as any[])
        : [];
      for (const action of actions) {
        const innerCase = this.extractOneofCase(action?.action, ACTION_CASE_NAMES);
        if (innerCase !== "useSkill") continue;
        const skillVal = this.extractOneofValue(action?.action, "useSkill") ?? action?.action?.value;
        const skillDefId = skillVal?.skill?.definition?.id ?? skillVal?.skillDefinitionId ?? 0;
        if (skillDefId > 0 && !skillTypeMap.has(skillDefId)) {
          try {
            const data = await DEFAULT_ASSETS_MANAGER.getData(skillDefId);
            const tag = this.resolveSkillTypeFromAsset(data as any);
            if (tag) skillTypeMap.set(skillDefId, tag);
          } catch { /* skill data not found */ }
        }
      }
    }

    if (pendingMethod === "action") {
      const actionData = this.extractOneofValue(pendingRequest, "action");
      const actions = actionData && Array.isArray(actionData.action)
        ? (actionData.action as any[])
        : [];
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const candidateId = `cand_${i + 1}`;
        const actionCase = this.extractOneofCase(action?.action, ACTION_CASE_NAMES) ?? "unknown";
        const requiredCost = Array.isArray(action.requiredCost) ? action.requiredCost : [];
        const autoSelectedDice = this.extractIntArray(action.autoSelectedDice);

        const enrichment = this.computeCandidateEnrichment(
          action, actionCase,
          selfCharsRaw, oppCharsRaw,
          selfActiveChar, oppActiveChar,
          diceArr, characterIndex, skillTypeMap,
        );

        candidates.push({
          candidate_id: candidateId,
          action_case: actionCase,
          is_fast: action?.isFast === true,
          cost: { required_cost: requiredCost },
          damage_estimate: enrichment.damage_estimate,
          reaction_type: enrichment.reaction_type,
          reaction_bonus: enrichment.reaction_bonus,
          total_damage: enrichment.total_damage,
          target_char_name: enrichment.target_char_name,
          target_hp_after: enrichment.target_hp_after,
          kills: enrichment.kills,
          dice_cost_detail: enrichment.dice_cost_detail,
          self_energy_after: enrichment.self_energy_after,
          aura_change: enrichment.aura_change,
          tempo_value: 0,
          survival_risk: 0,
          tags: [
            ...new Set([
              actionCase,
              action.validity === 0 ? "valid" : "invalid",
              ...enrichment.enriched_tags,
            ]),
          ],
          notes: [
            ...enrichment.enriched_notes,
            `validity=${String(action.validity)}`,
          ],
        });
        candidateActionMap.set(candidateId, {
          tool: "choose_action",
          args: { action_index: i + 1, used_dice: autoSelectedDice, expected_action_case: actionCase },
        });
      }
    } else if (pendingMethod === "chooseActive") {
      const chooseActiveData = this.extractOneofValue(pendingRequest, "chooseActive");
      for (const charId of this.extractIntArray(chooseActiveData?.candidateIds)) {
        const candidateId = `cand_choose_active_${charId}`;
        const selfChars = Array.isArray((selfPlayer as any)?.character) ? (selfPlayer as any).character as any[] : [];
        const charEntity = selfChars.find((c: any) => c?.id === charId);
        const charDefIdVal = charEntity ? (typeof charEntity.definitionId === "number" ? charEntity.definitionId : typeof charEntity.definition_id === "number" ? charEntity.definition_id : 0) : 0;
        const charName = charDefIdVal > 0 ? (characterIndex.get(charDefIdVal)?.canonicalName ?? `Character ${charDefIdVal}`) : `Entity ${charId}`;
        candidates.push({
          candidate_id: candidateId,
          action_case: "chooseActive",
          cost: {},
          damage_estimate: 0,
          reaction_value: 0,
          tempo_value: 0,
          survival_risk: 0,
          tags: ["chooseActive", "valid"],
          notes: [
            `character_id=${charId}`,
            `name=${charName}`,
            `definition_id=${charDefIdVal}`,
            `hp=${charEntity?.health ?? charEntity?.variable?.health ?? "?"}`,
            `energy=${charEntity?.energy ?? charEntity?.variable?.energy ?? "?"}`,
          ],
        });
        candidateActionMap.set(candidateId, {
          tool: "choose_active",
          args: { character_id: charId },
        });
      }
    } else if (pendingMethod === "rerollDice") {
      const dice = this.extractIntArray((selfPlayer as any)?.dice);
      const candidateId = "cand_reroll_none";
      candidates.push({
        candidate_id: candidateId,
        action_case: "rerollDice",
        cost: {},
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
        tags: ["rerollDice", "valid"],
        notes: ["Default conservative reroll strategy: keep current dice."],
      });
      candidateActionMap.set(candidateId, {
        tool: "reroll_dice",
        args: { dice_to_reroll: dice.filter((_, i) => i % 2 === 0).slice(0, 2) },
      });
    } else if (pendingMethod === "switchHands") {
      const handCards = Array.isArray((selfPlayer as any)?.handCard)
        ? (selfPlayer as any).handCard
        : [];
      const allIds: number[] = handCards
        .map((c: any) => c.id)
        .filter((id: any) => Number.isInteger(id));
      const cardInfos = await Promise.all(
        handCards.map(async (card: any) => {
          const id = typeof card.id === "number" ? card.id : 0;
          const defId = typeof card.definitionId === "number"
            ? card.definitionId
            : typeof card.definition_id === "number" ? card.definition_id : 0;
          const indexed = defId > 0
            ? await this.cardIndexStore.getCardById(defId).catch(() => null)
            : null;
          const cost = (Array.isArray(card.definitionCost) ? card.definitionCost : [])
            .reduce((sum: number, e: any) => sum + (typeof e.count === "number" ? e.count : 0), 0);
          return {
            id, definitionId: defId,
            name: indexed?.canonicalName ?? `card_${defId}`,
            type: indexed?.type ?? "unknown",
            tags: indexed?.tags ?? [],
            cost,
          };
        }),
      );
      const handNotes = `hand_cards=${JSON.stringify(cardInfos.map((c) => ({
        id: c.id, def: c.definitionId, name: c.name, type: c.type, cost: c.cost,
      })))}`;

      const keepAllId = "cand_switch_hands_keep_all";
      candidates.push({
        candidate_id: keepAllId,
        action_case: "switchHands",
        cost: {},
        damage_estimate: 0, reaction_value: 0, tempo_value: 0, survival_risk: 0,
        tags: ["switchHands", "valid", "keep_all"],
        notes: [handNotes, "strategy=keep_all"],
      });
      candidateActionMap.set(keepAllId, { tool: "switch_hands", args: { removed_hand_ids: [] } });

      for (const ci of cardInfos) {
        const cid = `cand_switch_hands_remove_${ci.id}`;
        const tags = ["switchHands", "valid", "remove_single"];
        if (ci.cost >= 4) tags.push("high_cost");
        if (ci.cost <= 1) tags.push("low_cost");
        if (ci.type) tags.push(ci.type);
        candidates.push({
          candidate_id: cid,
          action_case: "switchHands",
          cost: {},
          damage_estimate: 0, reaction_value: 0, tempo_value: 0, survival_risk: 0,
          tags,
          notes: [handNotes, "strategy=remove_single", `remove_card_id=${ci.id}`,
            `remove_card_def=${ci.definitionId}`, `remove_card_name=${ci.name}`, `remove_card_cost=${ci.cost}`],
        });
        candidateActionMap.set(cid, { tool: "switch_hands", args: { removed_hand_ids: [ci.id] } });
      }
      if (allIds.length > 1) {
        const removeAllId = "cand_switch_hands_remove_all";
        candidates.push({
          candidate_id: removeAllId,
          action_case: "switchHands",
          cost: {},
          damage_estimate: 0, reaction_value: 0, tempo_value: 0, survival_risk: 0,
          tags: ["switchHands", "valid", "remove_all", "aggressive_mulligan"],
          notes: [handNotes, "strategy=remove_all"],
        });
        candidateActionMap.set(removeAllId, { tool: "switch_hands", args: { removed_hand_ids: [...allIds] } });
      }
    } else if (pendingMethod === "selectCard") {
      for (const defId of this.extractIntArray(pendingRequest?.value?.candidateDefinitionIds)) {
        const candidateId = `cand_select_card_${defId}`;
        let targetName: string | null = null;
        let targetTags: string[] = [];
        let targetKind = "unknown";
        let charContext = "";
        try {
          const entry = await this.cardIndexStore.getCardById(defId);
          if (entry) {
            targetName = entry.canonicalName ?? null;
            targetTags = [entry.type, ...(entry.tags ?? [])];
            const elTypes = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"];
            const isChar = elTypes.some((t) => entry.tags?.includes(t));
            targetKind = isChar ? "character" : entry.type || "card";
          }
        } catch { /* best-effort */ }
        if (targetKind === "character") {
          const selfChar = selfCharsRaw.find(
            (c: any) => (typeof c.definitionId === "number" ? c.definitionId : c.definition_id) === defId,
          );
          if (selfChar) {
            const hp = typeof selfChar.health === "number" ? selfChar.health
              : typeof selfChar.variable?.health === "number" ? selfChar.variable.health : "?";
            const energy = typeof selfChar.energy === "number" ? selfChar.energy
              : typeof selfChar.variable?.energy === "number" ? selfChar.variable.energy : "?";
            const maxHp = typeof selfChar.maxHealth === "number" ? selfChar.maxHealth
              : typeof selfChar.variable?.maxHealth === "number" ? selfChar.variable.maxHealth : "?";
            const aura = selfChar.aura ?? selfChar.variable?.aura ?? null;
            charContext = `hp=${hp}/${maxHp} energy=${energy} aura=${aura ?? "none"}`;
          }
        }
        candidates.push({
          candidate_id: candidateId,
          action_case: "selectCard",
          cost: {},
          damage_estimate: 0, reaction_value: 0, tempo_value: 0, survival_risk: 0,
          tags: ["selectCard", "valid", `selectCard_${targetKind}`, ...targetTags],
          notes: [
            `selected_definition_id=${defId}`,
            targetName ? `target=${targetName}` : "",
            charContext,
          ].filter(Boolean),
        });
        candidateActionMap.set(candidateId, {
          tool: "select_card",
          args: { selected_definition_id: defId },
        });
      }
    }

    const characterDefinitions = await this.buildCharacterDefinitions(selfPlayer as any, opponentPlayer as any);
    const cardDefinitions = await this.buildCardDefinitions(selfPlayer as any);

    const selfCharacters = this.extractCharacterSummaries(selfPlayer as any);
    const oppCharacters = this.extractCharacterSummaries(opponentPlayer as any);

    const handCards = Array.isArray((selfPlayer as any)?.handCard)
      ? (selfPlayer as any).handCard : [];
    const handCardIds = handCards
      .map((c: any) => typeof c.definitionId === "number" ? c.definitionId : typeof c.definition_id === "number" ? c.definition_id : 0)
      .filter((id: number) => id > 0);
    const handCardIdSet = new Set(handCardIds);

    const extractActiveEffects = async (player: Record<string, unknown> | null): Promise<Array<{
      zone: string;
      definition_id: number;
      name: string;
      description: string;
      usage: number | null;
      shield: number | null;
    }>> => {
      if (!player) return [];
      const effects: Array<{ zone: string; definition_id: number; name: string; description: string; usage: number | null; shield: number | null }> = [];

      const extractShield = (e: any): number | null => {
        const s = e?.shield;
        return typeof s === "number" && s > 0 ? s : null;
      };

      const supports = Array.isArray((player as any).support) ? (player as any).support : [];
      for (const s of supports) {
        const defId = typeof s.definitionId === "number" ? s.definitionId : typeof s.definition_id === "number" ? s.definition_id : 0;
        if (defId > 0) {
          const entry = await this.cardIndexStore.getCardById(defId).catch(() => null);
          const usage = typeof s.variableValue === "number" ? s.variableValue : null;
          effects.push({ zone: "support", definition_id: defId, name: entry?.canonicalName ?? `support_${defId}`, description: entry?.effectText ?? "", usage, shield: extractShield(s) });
        }
      }

      const summons = Array.isArray((player as any).summon) ? (player as any).summon : [];
      for (const s of summons) {
        const defId = typeof s.definitionId === "number" ? s.definitionId : typeof s.definition_id === "number" ? s.definition_id : 0;
        if (defId > 0) {
          const entry = await this.cardIndexStore.getCardById(defId).catch(() => null);
          const usage = typeof s.variableValue === "number" ? s.variableValue : null;
          effects.push({ zone: "summon", definition_id: defId, name: entry?.canonicalName ?? `summon_${defId}`, description: entry?.effectText ?? "", usage, shield: extractShield(s) });
        }
      }

      const combatStatuses = Array.isArray((player as any).combatStatus) ? (player as any).combatStatus : [];
      for (const cs of combatStatuses) {
        const defId = typeof cs.definitionId === "number" ? cs.definitionId : typeof cs.definition_id === "number" ? cs.definition_id : 0;
        if (defId > 0) {
          const entry = await this.cardIndexStore.getCardById(defId).catch(() => null);
          const usage = typeof cs.variableValue === "number" ? cs.variableValue : null;
          effects.push({ zone: "combat_status", definition_id: defId, name: entry?.canonicalName ?? `status_${defId}`, description: entry?.effectText ?? "", usage, shield: extractShield(cs) });
        }
      }

      const characters = Array.isArray((player as any).character) ? (player as any).character : [];
      for (const ch of characters) {
        const chDefId = typeof ch.definitionId === "number" ? ch.definitionId : typeof ch.definition_id === "number" ? ch.definition_id : 0;
        const entities = Array.isArray(ch.entity) ? ch.entity : [];
        for (const ent of entities) {
          const defId = typeof ent.definitionId === "number" ? ent.definitionId : typeof ent.definition_id === "number" ? ent.definition_id : 0;
          if (defId > 0) {
            const entry = await this.cardIndexStore.getCardById(defId).catch(() => null);
            const type = entry?.type ?? "entity";
            const isEquipment = type.includes("equipment") || typeof ent.equipment !== "undefined";
            const usage = typeof ent.variableValue === "number" ? ent.variableValue : null;
            effects.push({
              zone: isEquipment ? `equipment_on_${chDefId}` : `status_on_${chDefId}`,
              definition_id: defId,
              name: entry?.canonicalName ?? `entity_${defId}`,
              description: entry?.effectText ?? "",
              usage,
              shield: extractShield(ent),
            });
          }
        }
      }
      return effects;
    };

    const selfActiveEffects = await extractActiveEffects(selfPlayer as any);
    const oppActiveEffects = await extractActiveEffects(opponentPlayer as any);

    const COST_MODIFIER_DSL_KEYWORDS = [
      "deductOmniDiceCard", "deductOmniDiceSwitch", "deductOmniDiceSkill",
      "deductOmniDiceTechnique", "deductElementDice", "deductVoidDiceSkill",
      "deductAllDiceCard", "deductOmniCost", "deductVoidCost", "deductCost",
      "addCost",
    ];
    const costModifierHints: string[] = [];
    for (const eff of selfActiveEffects) {
      let isCostModifier = false;
      const cardEntry = await this.cardIndexStore.getCardById(eff.definition_id).catch(() => null);
      if (cardEntry?.sourceExcerpt) {
        isCostModifier = COST_MODIFIER_DSL_KEYWORDS.some((kw) => cardEntry.sourceExcerpt.includes(kw));
      }
      if (!isCostModifier) {
        const lower = eff.description.toLowerCase();
        isCostModifier = lower.includes("少花费") || lower.includes("费用") || lower.includes("cost");
      }
      if (isCostModifier) {
        costModifierHints.push(`${eff.name} (${eff.zone}): ${eff.description.slice(0, 120)}`);
      }
    }

    const selfPileCards = Array.isArray((selfPlayer as any)?.pileCard) ? (selfPlayer as any).pileCard : [];
    const oppPileCards = Array.isArray((opponentPlayer as any)?.pileCard) ? (opponentPlayer as any).pileCard : [];
    const oppHandCards = Array.isArray((opponentPlayer as any)?.handCard) ? (opponentPlayer as any).handCard : [];

    const initiativeSkills: Array<{ definition_id: number; cost: Array<{ type: number; count: number }> }> = [];
    const selfInitSkills = Array.isArray((selfPlayer as any)?.initiativeSkill)
      ? (selfPlayer as any).initiativeSkill : [];
    for (const sk of selfInitSkills) {
      const defId = typeof sk.definitionId === "number" ? sk.definitionId : 0;
      const costArr = Array.isArray(sk.definitionCost) ? sk.definitionCost : [];
      if (defId > 0) {
        initiativeSkills.push({
          definition_id: defId,
          cost: costArr.map((c: any) => ({ type: c.type, count: c.count ?? 0 })),
        });
      }
    }

    const diceDistribution: Record<string, number> = {};
    for (const d of diceArr) {
      const label = d === 8 ? "omni" : this.diceTypeLabel(d);
      diceDistribution[label] = (diceDistribution[label] ?? 0) + 1;
    }

    // Read opening plan (if exists) so the LLM actually gets strategy context.
    const planFilePath = getPlanFilePath(sessionId);
    let openingPlan: TurnDigestV1["opening_plan"] = null;
    try {
      await access(planFilePath);
      const planRaw = await readFile(planFilePath, "utf-8");
      const plan = JSON.parse(planRaw);
      if (plan && typeof plan === "object") {
        openingPlan = {
          plan_id: String(plan.plan_id ?? ""),
          deck_fingerprint: String(plan.deck_fingerprint ?? ""),
          source_skills: Array.isArray(plan.source_skills) ? plan.source_skills : [],
          global_goal: String(plan.global_goal ?? ""),
          turn1_3_priorities: Array.isArray(plan.turn1_3_priorities) ? plan.turn1_3_priorities : [],
          risk_rules: Array.isArray(plan.risk_rules) ? plan.risk_rules : [],
          pivot_rules: Array.isArray(plan.pivot_rules) ? plan.pivot_rules : [],
        };
      }
    } catch {
      // Plan file missing or unreadable — LLM proceeds without opening strategy.
      console.error(`[TurnDigestBuilder] No opening plan at ${planFilePath} (session=${sessionId})`);
    }

    const digest: TurnDigestV1 = {
      version: "TurnDigestV1",
      digest_ref: digestRef,
      session_id: sessionId,
      round: Number.isInteger((screen as any)?.roundNumber) ? (screen as any).roundNumber : 0,
      turn: Number.isInteger((screen as any)?.currentTurn) ? (screen as any).currentTurn : 0,
      pending_method: pendingMethod as TurnDigestV1["pending_method"],
      strategic_profile_ref: planFilePath,
      opening_plan: openingPlan,
      self_summary: {
        active_character_id: (selfPlayer as any)?.activeCharacterId ?? null,
        hand_count: handCards.length,
        deck_remaining_count: selfPileCards.length,
        characters: selfCharacters,
        hand_card_definition_ids: handCardIds,
        active_effects: selfActiveEffects,
        initiative_skills: initiativeSkills,
        legend_used: !!(selfPlayer as any)?.legendUsed,
      },
      opponent_summary: {
        active_character_id: (opponentPlayer as any)?.activeCharacterId ?? null,
        hand_count: oppHandCards.length,
        deck_remaining_count: oppPileCards.length,
        characters: oppCharacters,
        active_effects: oppActiveEffects,
        declared_end: !!(opponentPlayer as any)?.declaredEnd,
        legend_used: !!(opponentPlayer as any)?.legendUsed,
      },
      resource_summary: {
        dice: diceArr,
        dice_count: diceArr.length,
        omni_count: diceArr.filter((d) => d === 8).length,
        dice_mapping: this.getDiceMapping(),
        dice_distribution: diceDistribution,
        dice_lifecycle: "discarded_on_declareEnd",
        cards_in_hand: handCards.length,
        round_phase: (screen as any)?.phase ?? null,
        cost_modifiers: costModifierHints,
      },
      candidate_actions: candidates,
      hard_constraints: [
        "Do not output action_index directly.",
        "Do not output used_dice directly.",
      ],
      character_definitions: characterDefinitions,
      card_definitions: cardDefinitions.map((cd) => ({
        ...cd,
        in_hand: handCardIdSet.has(cd.definition_id),
      })),
      generated_at: new Date(now).toISOString(),
      lethal_info: this.computeKillThreats(selfPlayer as any, opponentPlayer as any, diceArr.length),
    };

    return { digest, candidateActionMap };
  }
}
