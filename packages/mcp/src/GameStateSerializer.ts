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

import {
  type GameState,
  exposeState,
  type EntityState,
  type CharacterState,
  type PbGameState,
} from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import {
  DEFAULT_ASSETS_MANAGER,
  getNameSync,
} from "@gi-tcg/assets-manager";

export class GameStateSerializer {
  private static characterShareIdMapPromise: Promise<Map<number, number>> | null = null;
  private static actionCardShareIdMapPromise: Promise<Map<number, number>> | null = null;

  static getCommunicationState(
    who: 0 | 1,
    state: GameState | null
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {};

    if (state) {
      response.game_state = this.serializeGameState(who, state);
    }

    return response;
  }

  static getScreenOnlyState(
    who: 0 | 1,
    state: GameState | null
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {};

    if (state) {
      const exposed = exposeState(who, state);
      response.phase = exposed.phase;
      response.current_turn = exposed.currentTurn;
      response.round_number = exposed.roundNumber;
      response.winner = exposed.winner;
      response.player = exposed.player;
    }

    return response;
  }

  private static serializeGameState(
    who: 0 | 1,
    state: GameState
  ): PbGameState {
    return exposeState(who, state);
  }

  private static findCharacterByDefinitionId(
    state: GameState,
    definitionId: number
  ): CharacterState | null {
    for (const player of state.players) {
      for (const character of player.characters) {
        if (character.definition.id === definitionId) {
          return character;
        }
      }
    }
    return null;
  }

  private static findCharacterByEntityId(
    state: GameState,
    entityId: number
  ): CharacterState | null {
    for (const player of state.players) {
      for (const character of player.characters) {
        if (character.id === entityId) {
          return character;
        }
      }
    }
    return null;
  }

  private static findCardByDefinitionId(
    state: GameState,
    definitionId: number
  ): { card: EntityState; zone: "hand" | "pile" } | null {
    for (const player of state.players) {
      for (const card of player.hands) {
        if (card.definition.id === definitionId) {
          return { card, zone: "hand" };
        }
      }
      for (const card of player.pile) {
        if (card.definition.id === definitionId) {
          return { card, zone: "pile" };
        }
      }
    }
    return null;
  }

  private static findCardByEntityId(
    state: GameState,
    entityId: number
  ): { card: EntityState; zone: "hand" | "pile" } | null {
    for (const player of state.players) {
      for (const card of player.hands) {
        if (card.id === entityId) {
          return { card, zone: "hand" };
        }
      }
      for (const card of player.pile) {
        if (card.id === entityId) {
          return { card, zone: "pile" };
        }
      }
    }
    return null;
  }

  private static async getCharacterShareIdMap(): Promise<Map<number, number>> {
    if (!this.characterShareIdMapPromise) {
      this.characterShareIdMapPromise = DEFAULT_ASSETS_MANAGER.getCategory("characters")
        .then((characters) => {
          const map = new Map<number, number>();
          for (const character of characters as Array<Record<string, any>>) {
            const shareId = character.shareId;
            const id = character.id;
            if (typeof shareId === "number" && typeof id === "number") {
              map.set(shareId, id);
            }
          }
          return map;
        })
        .catch(() => new Map<number, number>());
    }
    return this.characterShareIdMapPromise;
  }

  private static async getActionCardShareIdMap(): Promise<Map<number, number>> {
    if (!this.actionCardShareIdMapPromise) {
      this.actionCardShareIdMapPromise = DEFAULT_ASSETS_MANAGER.getCategory("action_cards")
        .then((cards) => {
          const map = new Map<number, number>();
          for (const card of cards as Array<Record<string, any>>) {
            const shareId = card.shareId;
            const id = card.id;
            if (typeof shareId === "number" && typeof id === "number") {
              map.set(shareId, id);
            }
          }
          return map;
        })
        .catch(() => new Map<number, number>());
    }
    return this.actionCardShareIdMapPromise;
  }

  private static async getAssetData(definitionId: number): Promise<Record<string, any> | null> {
    try {
      const data = await DEFAULT_ASSETS_MANAGER.getData(definitionId);
      return data as Record<string, any>;
    } catch {
      return null;
    }
  }

  private static mapSkillDetailsFromDefinition(skills: readonly any[]) {
    return skills.map((skill) => {
      const initiativeConfig = skill?.initiativeSkillConfig;
      const requiredCost = Array.isArray(initiativeConfig?.requiredCost)
        ? initiativeConfig.requiredCost.map((entry: any) => ({
            dice_type: entry?.[0] ?? null,
            count: entry?.[1] ?? null,
          }))
        : [];

      return {
        id: skill?.id ?? null,
        name: typeof skill?.id === "number" ? (getNameSync(skill.id) ?? null) : null,
        skill_type: initiativeConfig?.skillType ?? "passive",
        hidden: initiativeConfig?.hidden ?? false,
        cost: requiredCost,
      };
    });
  }

  private static mapSkillDetailsFromAsset(data: Record<string, any> | null) {
    const skills = Array.isArray(data?.skills) ? data!.skills : [];
    return skills.map((skill: any) => ({
      id: skill?.id ?? null,
      name: skill?.name ?? (typeof skill?.id === "number" ? (getNameSync(skill.id) ?? null) : null),
      type: skill?.type ?? null,
      raw_description: skill?.rawDescription ?? null,
      description: skill?.description ?? null,
      play_cost: skill?.playCost ?? [],
      hidden: skill?.hidden ?? false,
      target_list: skill?.targetList ?? [],
    }));
  }

  private static resolveDisplayName(definitionId: number, assetData: Record<string, any> | null) {
    if (typeof assetData?.name === "string" && assetData.name.length > 0) {
      return assetData.name;
    }
    return getNameSync(definitionId) ?? null;
  }

  static async getCharacterInfo(state: GameState, characterId: number) {
    const data = getData((state as any).versionBehavior);

    const byDefinition = this.findCharacterByDefinitionId(state, characterId);
    if (byDefinition) {
      const assetData = await this.getAssetData(byDefinition.definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: byDefinition.id,
        definition_id: byDefinition.definition.id,
        name: this.resolveDisplayName(byDefinition.definition.id, assetData),
        health: byDefinition.variables.health,
        max_health: byDefinition.variables.maxHealth,
        energy: byDefinition.variables.energy,
        max_energy: byDefinition.variables.maxEnergy,
        alive: byDefinition.variables.alive,
        tags: byDefinition.definition.tags,
        matched_by: "definition_id",
        details: {
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(byDefinition.definition.skills),
          story_title: assetData?.storyTitle ?? null,
          story_text: assetData?.storyText ?? null,
        },
      };
    }

    const byEntity = this.findCharacterByEntityId(state, characterId);
    if (byEntity) {
      const assetData = await this.getAssetData(byEntity.definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: byEntity.id,
        definition_id: byEntity.definition.id,
        name: this.resolveDisplayName(byEntity.definition.id, assetData),
        health: byEntity.variables.health,
        max_health: byEntity.variables.maxHealth,
        energy: byEntity.variables.energy,
        max_energy: byEntity.variables.maxEnergy,
        alive: byEntity.variables.alive,
        tags: byEntity.definition.tags,
        matched_by: "entity_id",
        details: {
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(byEntity.definition.skills),
          story_title: assetData?.storyTitle ?? null,
          story_text: assetData?.storyText ?? null,
        },
      };
    }

    const definition = data.characters.get(characterId);
    if (definition) {
      const assetData = await this.getAssetData(definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: null,
        definition_id: definition.id,
        name: this.resolveDisplayName(definition.id, assetData),
        health: null,
        max_health: null,
        energy: null,
        max_energy: null,
        alive: null,
        tags: definition.tags,
        matched_by: "definition_id",
        source: "data_definition",
        details: {
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(definition.skills),
          story_title: assetData?.storyTitle ?? null,
          story_text: assetData?.storyText ?? null,
        },
      };
    }

    const characterShareIdMap = await this.getCharacterShareIdMap();
    const mappedCharacterId = characterShareIdMap.get(characterId);
    if (mappedCharacterId) {
      const mappedDefinition = data.characters.get(mappedCharacterId);
      if (!mappedDefinition) {
        return null;
      }
      const stateCharacter = this.findCharacterByDefinitionId(state, mappedDefinition.id);
      const assetData = await this.getAssetData(mappedDefinition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);

      return {
        id: stateCharacter?.id ?? null,
        definition_id: mappedDefinition.id,
        name: this.resolveDisplayName(mappedDefinition.id, assetData),
        health: stateCharacter?.variables.health ?? null,
        max_health: stateCharacter?.variables.maxHealth ?? null,
        energy: stateCharacter?.variables.energy ?? null,
        max_energy: stateCharacter?.variables.maxEnergy ?? null,
        alive: stateCharacter?.variables.alive ?? null,
        tags: mappedDefinition.tags,
        matched_by: "share_id",
        source: stateCharacter ? "state_entity" : "data_definition",
        share_id: characterId,
        details: {
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(mappedDefinition.skills),
          story_title: assetData?.storyTitle ?? null,
          story_text: assetData?.storyText ?? null,
        },
      };
    }

    return null;
  }

  static async getCardInfo(state: GameState, cardId: number) {
    const data = getData((state as any).versionBehavior);

    const byDefinition = this.findCardByDefinitionId(state, cardId);
    if (byDefinition) {
      const assetData = await this.getAssetData(byDefinition.card.definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: byDefinition.card.id,
        definition_id: byDefinition.card.definition.id,
        name: this.resolveDisplayName(byDefinition.card.definition.id, assetData),
        type: byDefinition.card.definition.type,
        tags: byDefinition.card.definition.tags,
        zone: byDefinition.zone,
        matched_by: "definition_id",
        details: {
          raw_description: assetData?.rawDescription ?? null,
          description: assetData?.description ?? null,
          raw_playing_description: assetData?.rawPlayingDescription ?? null,
          playing_description: assetData?.playingDescription ?? null,
          raw_dynamic_description: assetData?.rawDynamicDescription ?? null,
          dynamic_description: assetData?.dynamicDescription ?? null,
          play_cost: assetData?.playCost ?? [],
          target_list: assetData?.targetList ?? [],
          related_character_id: assetData?.relatedCharacterId ?? null,
          related_character_tags: assetData?.relatedCharacterTags ?? [],
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(byDefinition.card.definition.skills),
        },
      };
    }

    const byEntity = this.findCardByEntityId(state, cardId);
    if (byEntity) {
      const assetData = await this.getAssetData(byEntity.card.definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: byEntity.card.id,
        definition_id: byEntity.card.definition.id,
        name: this.resolveDisplayName(byEntity.card.definition.id, assetData),
        type: byEntity.card.definition.type,
        tags: byEntity.card.definition.tags,
        zone: byEntity.zone,
        matched_by: "entity_id",
        details: {
          raw_description: assetData?.rawDescription ?? null,
          description: assetData?.description ?? null,
          raw_playing_description: assetData?.rawPlayingDescription ?? null,
          playing_description: assetData?.playingDescription ?? null,
          raw_dynamic_description: assetData?.rawDynamicDescription ?? null,
          dynamic_description: assetData?.dynamicDescription ?? null,
          play_cost: assetData?.playCost ?? [],
          target_list: assetData?.targetList ?? [],
          related_character_id: assetData?.relatedCharacterId ?? null,
          related_character_tags: assetData?.relatedCharacterTags ?? [],
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(byEntity.card.definition.skills),
        },
      };
    }

    const definition = data.entities.get(cardId);
    if (definition && ["eventCard", "equipment", "support"].includes(definition.type)) {
      const assetData = await this.getAssetData(definition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: null,
        definition_id: definition.id,
        name: this.resolveDisplayName(definition.id, assetData),
        type: definition.type,
        tags: definition.tags,
        zone: null,
        matched_by: "definition_id",
        source: "data_definition",
        details: {
          raw_description: assetData?.rawDescription ?? null,
          description: assetData?.description ?? null,
          raw_playing_description: assetData?.rawPlayingDescription ?? null,
          playing_description: assetData?.playingDescription ?? null,
          raw_dynamic_description: assetData?.rawDynamicDescription ?? null,
          dynamic_description: assetData?.dynamicDescription ?? null,
          play_cost: assetData?.playCost ?? [],
          target_list: assetData?.targetList ?? [],
          related_character_id: assetData?.relatedCharacterId ?? null,
          related_character_tags: assetData?.relatedCharacterTags ?? [],
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(definition.skills),
        },
      };
    }

    const actionCardShareIdMap = await this.getActionCardShareIdMap();
    const mappedCardId = actionCardShareIdMap.get(cardId);
    if (mappedCardId) {
      const mappedDefinition = data.entities.get(mappedCardId);
      if (!mappedDefinition || !["eventCard", "equipment", "support"].includes(mappedDefinition.type)) {
        return null;
      }

      const stateCard = this.findCardByDefinitionId(state, mappedDefinition.id);
      const assetData = await this.getAssetData(mappedDefinition.id);
      const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
      return {
        id: stateCard?.card.id ?? null,
        definition_id: mappedDefinition.id,
        name: this.resolveDisplayName(mappedDefinition.id, assetData),
        type: mappedDefinition.type,
        tags: mappedDefinition.tags,
        zone: stateCard?.zone ?? null,
        matched_by: "share_id",
        source: stateCard ? "state_entity" : "data_definition",
        share_id: cardId,
        details: {
          raw_description: assetData?.rawDescription ?? null,
          description: assetData?.description ?? null,
          raw_playing_description: assetData?.rawPlayingDescription ?? null,
          playing_description: assetData?.playingDescription ?? null,
          raw_dynamic_description: assetData?.rawDynamicDescription ?? null,
          dynamic_description: assetData?.dynamicDescription ?? null,
          play_cost: assetData?.playCost ?? [],
          target_list: assetData?.targetList ?? [],
          related_character_id: assetData?.relatedCharacterId ?? null,
          related_character_tags: assetData?.relatedCharacterTags ?? [],
          skills: skillsFromAsset.length > 0
            ? skillsFromAsset
            : this.mapSkillDetailsFromDefinition(mappedDefinition.skills),
        },
      };
    }

    return null;
  }
}
