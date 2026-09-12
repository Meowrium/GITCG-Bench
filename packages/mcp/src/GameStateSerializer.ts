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
        name: typeof skill?.id === "number" ? (getNameSync("CHS", skill.id) ?? null) : null,
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
      name: skill?.name ?? (typeof skill?.id === "number" ? (getNameSync("CHS", skill.id) ?? null) : null),
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
    return getNameSync("CHS", definitionId) ?? null;
  }

  private static isEntityHiddenFromViewer(state: GameState, entityId: number, viewer: 0 | 1): boolean {
    const opponent = state.players[1 - viewer];
    return opponent.hands.some((c) => c.id === entityId) || opponent.pile.some((c) => c.id === entityId);
  }

  private static buildCharacterSkillsDetails(
    character: CharacterState | null,
    definitionSkills: readonly any[],
    assetData: Record<string, any> | null,
  ) {
    const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
    return {
      skills: skillsFromAsset.length > 0
        ? skillsFromAsset
        : this.mapSkillDetailsFromDefinition(definitionSkills),
      story_title: assetData?.storyTitle ?? null,
      story_text: assetData?.storyText ?? null,
    };
  }

  private static buildCharacterResult(
    character: CharacterState | null,
    definitionId: number,
    assetData: Record<string, any> | null,
    matchedBy: string,
    definitionSkills: readonly any[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      id: character?.id ?? null,
      definition_id: definitionId,
      name: this.resolveDisplayName(definitionId, assetData),
      health: character?.variables.health ?? null,
      max_health: character?.variables.maxHealth ?? null,
      energy: character?.variables.energy ?? null,
      max_energy: character?.variables.maxEnergy ?? null,
      alive: character?.variables.alive ?? null,
      tags: extra.tags ?? [],
      matched_by: matchedBy,
      ...extra,
      details: this.buildCharacterSkillsDetails(character, definitionSkills, assetData),
    };
  }

  private static buildCardDetails(assetData: Record<string, any> | null, definitionSkills: readonly any[]) {
    const skillsFromAsset = this.mapSkillDetailsFromAsset(assetData);
    return {
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
        : this.mapSkillDetailsFromDefinition(definitionSkills),
    };
  }

  private static buildCardResult(
    card: EntityState | null,
    definitionId: number,
    definitionType: any,
    definitionTags: any,
    definitionSkills: readonly any[],
    zone: "hand" | "pile" | null,
    assetData: Record<string, any> | null,
    matchedBy: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      id: card?.id ?? null,
      definition_id: definitionId,
      name: this.resolveDisplayName(definitionId, assetData),
      type: definitionType,
      tags: definitionTags,
      zone,
      matched_by: matchedBy,
      ...extra,
      details: this.buildCardDetails(assetData, definitionSkills),
    };
  }

  static async getCharacterInfo(state: GameState, characterId: number, _viewer: 0 | 1) {
    const data = getData((state as any).versionBehavior);

    const byDefinition = this.findCharacterByDefinitionId(state, characterId);
    if (byDefinition) {
      const assetData = await this.getAssetData(byDefinition.definition.id);
      return this.buildCharacterResult(
        byDefinition,
        byDefinition.definition.id,
        assetData,
        "definition_id",
        byDefinition.definition.skills,
        { tags: byDefinition.definition.tags },
      );
    }

    const byEntity = this.findCharacterByEntityId(state, characterId);
    if (byEntity) {
      const assetData = await this.getAssetData(byEntity.definition.id);
      return this.buildCharacterResult(
        byEntity,
        byEntity.definition.id,
        assetData,
        "entity_id",
        byEntity.definition.skills,
        { tags: byEntity.definition.tags },
      );
    }

    const definition = data.characters.get(characterId);
    if (definition) {
      const assetData = await this.getAssetData(definition.id);
      return this.buildCharacterResult(
        null,
        definition.id,
        assetData,
        "definition_id",
        definition.skills,
        { tags: definition.tags, source: "data_definition" },
      );
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
      return this.buildCharacterResult(
        stateCharacter,
        mappedDefinition.id,
        assetData,
        "share_id",
        mappedDefinition.skills,
        {
          tags: mappedDefinition.tags,
          source: stateCharacter ? "state_entity" : "data_definition",
          share_id: characterId,
        },
      );
    }

    return null;
  }

  static async getCardInfo(state: GameState, cardId: number, viewer: 0 | 1) {
    const data = getData((state as any).versionBehavior);

    const byDefinition = this.findCardByDefinitionId(state, cardId);
    if (byDefinition) {
      if (this.isEntityHiddenFromViewer(state, byDefinition.card.id, viewer)) {
        const assetData = await this.getAssetData(byDefinition.card.definition.id);
        return this.buildCardResult(
          null,
          byDefinition.card.definition.id,
          byDefinition.card.definition.type,
          byDefinition.card.definition.tags,
          byDefinition.card.definition.skills,
          null,
          assetData,
          "definition_id",
          { source: "data_definition", hidden: true },
        );
      }
      const assetData = await this.getAssetData(byDefinition.card.definition.id);
      return this.buildCardResult(
        byDefinition.card,
        byDefinition.card.definition.id,
        byDefinition.card.definition.type,
        byDefinition.card.definition.tags,
        byDefinition.card.definition.skills,
        byDefinition.zone,
        assetData,
        "definition_id",
      );
    }

    const byEntity = this.findCardByEntityId(state, cardId);
    if (byEntity) {
      if (this.isEntityHiddenFromViewer(state, cardId, viewer)) {
        return {
          error_code: "HIDDEN_INFORMATION",
          message: `Card entity ${cardId} is in an opponent hidden zone and cannot be inspected.`,
          card_id: cardId,
        };
      }
      const assetData = await this.getAssetData(byEntity.card.definition.id);
      return this.buildCardResult(
        byEntity.card,
        byEntity.card.definition.id,
        byEntity.card.definition.type,
        byEntity.card.definition.tags,
        byEntity.card.definition.skills,
        byEntity.zone,
        assetData,
        "entity_id",
      );
    }

    const definition = data.entities.get(cardId);
    if (definition && ["eventCard", "equipment", "support"].includes(definition.type)) {
      const assetData = await this.getAssetData(definition.id);
      return this.buildCardResult(
        null,
        definition.id,
        definition.type,
        definition.tags,
        definition.skills,
        null,
        assetData,
        "definition_id",
        { source: "data_definition" },
      );
    }

    const actionCardShareIdMap = await this.getActionCardShareIdMap();
    const mappedCardId = actionCardShareIdMap.get(cardId);
    if (mappedCardId) {
      const mappedDefinition = data.entities.get(mappedCardId);
      if (!mappedDefinition || !["eventCard", "equipment", "support"].includes(mappedDefinition.type)) {
        return null;
      }

      const stateCard = this.findCardByDefinitionId(state, mappedDefinition.id);
      const isStateCardHidden = stateCard && this.isEntityHiddenFromViewer(state, stateCard.card.id, viewer);
      const effectiveCard = isStateCardHidden ? null : stateCard;
      const assetData = await this.getAssetData(mappedDefinition.id);
      return this.buildCardResult(
        effectiveCard?.card ?? null,
        mappedDefinition.id,
        mappedDefinition.type,
        mappedDefinition.tags,
        mappedDefinition.skills,
        effectiveCard?.zone ?? null,
        assetData,
        "share_id",
        {
          source: effectiveCard ? "state_entity" : "data_definition",
          share_id: cardId,
        },
      );
    }

    return null;
  }
}
