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

import type { ToolDefinition } from "./MCPProtocol";
import {
  buildToolCallResult,
  buildToolCallResultJson,
  createToolDefinition,
  createInputSchema,
  createProperty,
} from "./MCPProtocol";
import { GameStateListener } from "../GameStateListener";
import { GameStateSerializer } from "../GameStateSerializer";
import { AIClientPlayerIO } from "../AIClientPlayerIO";
import { CardIndexStore } from "../card-index/CardIndexStore";
import { createRpcResponse } from "@gi-tcg/typings";
import { getNameSync } from "@gi-tcg/assets-manager";
import type { Game, GameState } from "@gi-tcg/core";

const OPPONENT_DECK_ENV = "MCP_ALLOW_OPP_DECK";
const isOpponentDeckAllowed = (): boolean => {
  const raw = process.env[OPPONENT_DECK_ENV];
  if (!raw) {
    return true;
  }
  const normalized = raw.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
};

const READ_ONLY_TOOLS = new Set([
  "get_game_state",
  "get_screen_state",
  "get_available_commands",
  "get_player0_deck",
  "get_player1_deck",
  "get_card_info",
  "get_character_info",
  "list_cards",
  "get_card_by_id",
  "resolve_card",
  "validate_card_mapping",
]);

const HTTP_THREAD_SAFE_TOOLS = new Set([
  "get_player0_deck",
  "get_player1_deck",
  "get_card_info",
  "get_character_info",
  "list_cards",
  "get_card_by_id",
  "resolve_card",
  "validate_card_mapping",
]);

export class MCPToolHandler {
  private game: Game | null = null;
  private aiPlayerIO: AIClientPlayerIO | null = null;
  private currentWho: 0 | 1 = 0;
  private cardIndexStore: CardIndexStore;

  constructor() {
    this.cardIndexStore = new CardIndexStore();
  }

  private buildStructuredError(
    errorCode: string,
    message: string,
    recoverHint: string,
    extra: Record<string, unknown> = {}
  ) {
    return buildToolCallResult(
      JSON.stringify({
        ok: false,
        error_code: errorCode,
        message,
        recover_hint: recoverHint,
        ...extra,
      }),
      true
    );
  }

  private getWaitStateMeta() {
    const hasPending = this.aiPlayerIO?.hasPendingRpc() ?? false;
    const pendingMethod = this.aiPlayerIO?.getPendingRpc()?.method ?? null;
    return {
      has_pending_rpc: hasPending,
      pending_method: pendingMethod,
      can_act: hasPending,
      wait_hint: hasPending
        ? "Pending RPC is ready. Use get_available_commands then execute exactly one action tool."
        : "No pending RPC. Wait for state changes and poll get_available_commands at low frequency.",
      retry_after_ms: hasPending ? 0 : 800,
    };
  }

  setGame(game: Game, aiPlayerIO: AIClientPlayerIO, who: 0 | 1) {
    this.game = game;
    this.aiPlayerIO = aiPlayerIO;
    this.currentWho = who;
  }

  isReadOnlyTool(toolName: string): boolean {
    return READ_ONLY_TOOLS.has(toolName);
  }

  isHttpThreadSafeTool(toolName: string): boolean {
    return HTTP_THREAD_SAFE_TOOLS.has(toolName);
  }

  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    tools.push(
      createToolDefinition(
        "get_game_state",
        "Get complete game state for the AI player",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_screen_state",
        "Get lightweight current screen state (recommended for most use cases)",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_available_commands",
        "Get context-aware list of available tools for current state",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_player0_deck",
        "Get initial deck list for player 0",
        createInputSchema({})
      )
    );
    if (isOpponentDeckAllowed()) {
      tools.push(
        createToolDefinition(
          "get_player1_deck",
          "Get initial deck list for player 1",
          createInputSchema({})
        )
      );
    }

    tools.push(
      createToolDefinition(
        "get_character_info",
        "Get detailed character information",
        createInputSchema(
          {
            character_id: createProperty(
              "integer",
              "Character ID to query (supports definition_id / entity_id / share_id)"
            ),
          },
          ["character_id"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "get_card_info",
        "Get detailed card information",
        createInputSchema(
          {
            card_id: createProperty(
              "integer",
              "Card ID to query (supports definition_id / entity_id / share_id)"
            ),
          },
          ["card_id"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "list_cards",
        "List indexed cards/characters with canonical info",
        createInputSchema({
          version: {
            type: "string",
            description: "Version label, defaults to latest",
          },
          language: {
            type: "string",
            enum: ["zh-CN", "en-US"],
            description: "Response language",
          },
          filter: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Filter by type, e.g. character:event:equip...",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Filter by tags (all tags must match)",
              },
              nameLike: {
                type: "string",
                description: "Case-insensitive fuzzy match by canonical name",
              },
            },
            additionalProperties: false,
            description: "Optional filter object",
          },
          page: {
            type: "integer",
            description: "Page index starting from 1",
          },
          pageSize: {
            type: "integer",
            description: "Page size, max 200",
          },
        })
      )
    );

    tools.push(
      createToolDefinition(
        "get_card_by_id",
        "Get canonical card/character content by definitionId",
        createInputSchema(
          {
            definitionId: createProperty("integer", "Definition ID"),
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            include_source: createProperty("boolean", "Include sourcePath/sourceExcerpt"),
          },
          ["definitionId"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "resolve_card",
        "Resolve card by id/name/effect text and return ranked candidates",
        createInputSchema(
          {
            query: createProperty("string", "Card query text, name or definitionId"),
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            topK: createProperty("integer", "Top-k candidates, max 20"),
          },
          ["query"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "validate_card_mapping",
        "Validate whether definitionId and name mappings are correct",
        createInputSchema(
          {
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            items: {
              type: "array",
              description: "Array of { definitionId, name } entries",
              items: {
                type: "object",
                required: ["definitionId", "name"],
                properties: {
                  definitionId: { type: "integer" },
                  name: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          ["items"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "choose_action",
        "Choose an action by index when it's your turn to act",
        createInputSchema(
          {
            action_index: createProperty(
              "integer",
              "1-indexed action index to choose"
            ),
            used_dice: createProperty(
              "array",
              "Array of dice types to use for the action"
            ),
          },
          ["action_index"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "elemental_tuning",
        "Perform elemental tuning explicitly (discard a hand card and convert one die)",
        createInputSchema({
          removed_card_id: createProperty(
            "integer",
            "Optional hand card entity ID to discard for tuning"
          ),
          target_dice: createProperty(
            "integer",
            "Optional target dice type after tuning"
          ),
          used_dice: createProperty(
            "array",
            "Optional source dice to consume; defaults to auto_selected_dice of matched tuning action"
          ),
        })
      )
    );

    tools.push(
      createToolDefinition(
        "choose_active",
        "Choose active character at the beginning of the game",
        createInputSchema(
          {
            character_id: createProperty(
              "integer",
              "Character ID to choose as active"
            ),
          },
          ["character_id"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "reroll_dice",
        "Choose which dice to reroll",
        createInputSchema(
          {
            dice_to_reroll: createProperty(
              "array",
              "Array of dice types to reroll"
            ),
          },
          ["dice_to_reroll"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "switch_hands",
        "Choose which cards to remove from initial hand",
        createInputSchema(
          {
            removed_hand_ids: createProperty(
              "array",
              "Array of card IDs to remove from hand"
            ),
          },
          ["removed_hand_ids"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "select_card",
        "Select a card from candidates",
        createInputSchema(
          {
            selected_definition_id: createProperty(
              "integer",
              "Card definition ID to select"
            ),
          },
          ["selected_definition_id"]
        )
      )
    );

    return tools;
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      const stateListener = GameStateListener.getInstance();
      const state = stateListener.getLastState();

      switch (toolName) {
        case "get_game_state":
          return this.executeGetGameState(state);
        case "get_screen_state":
          return this.executeGetScreenState(state);
        case "get_available_commands":
          return this.executeGetAvailableCommands(state);
        case "get_player0_deck":
          return this.executeGetDeckInfo(state, 0);
        case "get_player1_deck":
          if (!isOpponentDeckAllowed()) {
            return buildToolCallResult("Opponent deck access is disabled", true);
          }
          return this.executeGetDeckInfo(state, 1);
        case "get_character_info":
          return await this.executeGetCharacterInfo(state, args);
        case "get_card_info":
          return await this.executeGetCardInfo(state, args);
        case "list_cards":
          return await this.executeListCards(args);
        case "get_card_by_id":
          return await this.executeGetCardById(args);
        case "resolve_card":
          return await this.executeResolveCard(args);
        case "validate_card_mapping":
          return await this.executeValidateCardMapping(args);
        case "choose_action":
          return this.executeChooseAction(args);
        case "elemental_tuning":
          return this.executeElementalTuning(args);
        case "choose_active":
          return this.executeChooseActive(args);
        case "reroll_dice":
          return this.executeRerollDice(args);
        case "switch_hands":
          return this.executeSwitchHands(args);
        case "select_card":
          return this.executeSelectCard(args);
        default:
          return buildToolCallResult(`Unknown tool: ${toolName}`, true);
      }
    } catch (e) {
      const error = e as Error;
      return buildToolCallResult(`Error: ${error.message}`, true);
    }
  }

  private executeGetGameState(state: any) {
    const result = GameStateSerializer.getCommunicationState(
      this.currentWho,
      state
    );
    return buildToolCallResultJson(result);
  }

  private executeGetDeckInfo(state: GameState | null, who: 0 | 1) {
    if (!state) {
      return buildToolCallResult("No game state available", true);
    }
    const deckInfo = this.buildDeckInfo(state, who);
    return buildToolCallResultJson(deckInfo);
  }

  private buildDeckInfo(state: GameState, who: 0 | 1) {
    const player = state.players[who];
    const characters = player.characters.map((character) => ({
      definition_id: character.definition.id,
      name: getNameSync(character.definition.id) ?? null,
    }));
    const cardCounts = new Map<number, number>();
    for (const definition of player.initialPile) {
      cardCounts.set(definition.id, (cardCounts.get(definition.id) ?? 0) + 1);
    }
    const cards = [...cardCounts.entries()]
      .map(([definitionId, count]) => ({
        definition_id: definitionId,
        name: getNameSync(definitionId) ?? null,
        count,
      }))
      .sort((a, b) => a.definition_id - b.definition_id);

    return {
      who,
      characters,
      cards,
      total_cards: player.initialPile.length,
    };
  }

  private executeGetScreenState(state: any) {
    const result = GameStateSerializer.getScreenOnlyState(
      this.currentWho,
      state
    );
    return buildToolCallResultJson(result);
  }

  private executeGetAvailableCommands(state: any) {
    const availableTools: Array<{
      tool: string;
      description: string;
    }> = [];

    if (this.aiPlayerIO?.hasPendingRpc()) {
      const pendingRpc = this.aiPlayerIO.getPendingRpc();
      if (pendingRpc) {
        const method = pendingRpc.method;
        switch (method) {
          case "action":
            availableTools.push({
              tool: "choose_action",
              description: "Choose an action from available options",
            });
            if (this.hasValidElementalTuningAction()) {
              availableTools.push({
                tool: "elemental_tuning",
                description: "Perform elemental tuning using explicit card/dice semantics",
              });
            }
            break;
          case "chooseActive":
            availableTools.push({
              tool: "choose_active",
              description: "Choose active character",
            });
            break;
          case "rerollDice":
            availableTools.push({
              tool: "reroll_dice",
              description: "Reroll selected dice",
            });
            break;
          case "switchHands":
            availableTools.push({
              tool: "switch_hands",
              description: "Switch initial hand cards",
            });
            break;
          case "selectCard":
            availableTools.push({
              tool: "select_card",
              description: "Select a card",
            });
            break;
        }
      }
    }

    const waitState = this.getWaitStateMeta();
    const result = {
      available_tools: availableTools,
      ...waitState,
      why_empty:
        availableTools.length > 0
          ? null
          : waitState.has_pending_rpc
            ? "Pending RPC exists but no mapped action tool is available for current method"
            : "No pending RPC available for AI action",
    };

    return buildToolCallResultJson(result);
  }

  private async executeGetCharacterInfo(state: any, args: Record<string, unknown>) {
    const characterId = args.character_id;
    if (!Number.isInteger(characterId)) {
      return buildToolCallResult("Invalid character_id: must be an integer", true);
    }
    const info = await GameStateSerializer.getCharacterInfo(state, characterId as number);
    if (!info) {
      return buildToolCallResult("Character not found", true);
    }
    return buildToolCallResultJson(info);
  }

  private async executeGetCardInfo(state: any, args: Record<string, unknown>) {
    const cardId = args.card_id;
    if (!Number.isInteger(cardId)) {
      return buildToolCallResult("Invalid card_id: must be an integer", true);
    }
    const info = await GameStateSerializer.getCardInfo(state, cardId as number);
    if (!info) {
      return buildToolCallResult("Card not found", true);
    }
    return buildToolCallResultJson(info);
  }

  private async executeListCards(args: Record<string, unknown>) {
    const page = Number.isInteger(args.page) ? (args.page as number) : 1;
    const pageSize = Number.isInteger(args.pageSize) ? (args.pageSize as number) : 50;
    const filterRaw = args.filter;
    const filter = typeof filterRaw === "object" && filterRaw !== null
      ? {
          type: typeof (filterRaw as { type?: unknown }).type === "string"
            ? ((filterRaw as { type: string }).type)
            : undefined,
          tags: Array.isArray((filterRaw as { tags?: unknown }).tags)
            ? (filterRaw as { tags: unknown[] }).tags.filter((t): t is string => typeof t === "string")
            : undefined,
          nameLike: typeof (filterRaw as { nameLike?: unknown }).nameLike === "string"
            ? ((filterRaw as { nameLike: string }).nameLike)
            : undefined,
        }
      : undefined;

    const result = await this.cardIndexStore.listCards({
      version: typeof args.version === "string" ? args.version : undefined,
      language:
        args.language === "zh-CN" || args.language === "en-US"
          ? args.language
          : "zh-CN",
      filter,
      page,
      pageSize,
    });

    return buildToolCallResultJson({
      ok: true,
      version: result.version,
      page: Math.max(1, page),
      pageSize: Math.max(1, Math.min(200, pageSize)),
      total: result.total,
      items: result.items.map((item) => ({
        definitionId: item.definitionId,
        canonicalName: item.canonicalName,
        definitionKind: item.definitionKind,
        type: item.type,
        tags: item.tags,
        effectText: item.effectText,
        contentHash: item.contentHash,
      })),
    });
  }

  private async executeGetCardById(args: Record<string, unknown>) {
    const definitionId = args.definitionId;
    if (!Number.isInteger(definitionId)) {
      return buildToolCallResult("Invalid definitionId: must be an integer", true);
    }

    const includeSource = args.include_source === true;
    const card = await this.cardIndexStore.getCardById(definitionId as number);
    if (!card) {
      return buildToolCallResultJson({
        ok: false,
        error: "CARD_NOT_FOUND",
        definitionId,
      });
    }

    return buildToolCallResultJson({
      ok: true,
      card: {
        definitionId: card.definitionId,
        canonicalName: card.canonicalName,
        definitionKind: card.definitionKind,
        type: card.type,
        tags: card.tags,
        since: card.since,
        effectText: card.effectText,
        contentHash: card.contentHash,
        ...(includeSource
          ? {
              sourcePath: card.sourcePath,
              sourceExcerpt: card.sourceExcerpt,
            }
          : {}),
      },
    });
  }

  private async executeResolveCard(args: Record<string, unknown>) {
    const query = args.query;
    if (typeof query !== "string" || !query.trim()) {
      return buildToolCallResult("Invalid query: must be a non-empty string", true);
    }

    const topK = Number.isInteger(args.topK) ? (args.topK as number) : 5;
    const candidates = await this.cardIndexStore.resolveCard(query, topK);

    return buildToolCallResultJson({
      ok: true,
      query,
      candidates: candidates.map((item) => ({
        definitionId: item.definitionId,
        canonicalName: item.canonicalName,
        definitionKind: item.definitionKind,
        score: item.score,
        contentHash: item.contentHash,
      })),
    });
  }

  private async executeValidateCardMapping(args: Record<string, unknown>) {
    const rawItems = args.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return buildToolCallResult("Invalid items: must be a non-empty array", true);
    }

    const items = rawItems
      .filter((item): item is { definitionId: number; name: string } => {
        if (typeof item !== "object" || item === null) {
          return false;
        }
        const id = (item as { definitionId?: unknown }).definitionId;
        const name = (item as { name?: unknown }).name;
        return Number.isInteger(id) && typeof name === "string";
      });

    if (items.length !== rawItems.length) {
      return buildToolCallResult("Invalid items: each item must include integer definitionId and string name", true);
    }

    const results = await this.cardIndexStore.validateCardMapping(items);
    return buildToolCallResultJson({
      ok: true,
      total: results.length,
      matchedCount: results.filter((r) => r.matched).length,
      results,
    });
  }

  private ensurePendingMethod(expected: string): { ok: true } | { ok: false; result: { content: Array<{ type: string; text: string }>; isError?: boolean } } {
    if (!this.aiPlayerIO?.hasPendingRpc()) {
      return {
        ok: false,
        result: this.buildStructuredError(
          "NO_PENDING_RPC",
          "No pending RPC to respond to",
          "Call get_available_commands. If has_pending_rpc=false, wait and retry later.",
          this.getWaitStateMeta()
        ),
      };
    }
    const pendingRpc = this.aiPlayerIO.getPendingRpc();
    if (!pendingRpc) {
      return {
        ok: false,
        result: this.buildStructuredError(
          "NO_PENDING_RPC",
          "No pending RPC to respond to",
          "Call get_available_commands. If has_pending_rpc=false, wait and retry later.",
          this.getWaitStateMeta()
        ),
      };
    }
    if (pendingRpc.method !== expected) {
      return {
        ok: false,
        result: this.buildStructuredError(
          "MISMATCH_PENDING_METHOD",
          `Pending RPC is '${pendingRpc.method}', expected '${expected}'`,
          "Call get_available_commands and use one of available_tools matching pending_method.",
          {
            expected_method: expected,
            ...this.getWaitStateMeta(),
          }
        ),
      };
    }
    return { ok: true };
  }

  private validateDiceSelection(selectedDice: number[], fieldName: string): string | null {
    const availableDice = this.game?.state?.players?.[this.currentWho]?.dice;
    if (!Array.isArray(availableDice)) {
      return null;
    }
    const remaining = [...availableDice];
    for (const die of selectedDice) {
      const idx = remaining.indexOf(die);
      if (idx === -1) {
        return `Invalid ${fieldName}: dice type ${die} is not available in current dice pool`;
      }
      remaining.splice(idx, 1);
    }
    return null;
  }

  private validateHandCardSelection(removedHandIds: number[]): string | null {
    const handCards = this.game?.state?.players?.[this.currentWho]?.hands;
    if (!Array.isArray(handCards)) {
      return null;
    }
    const remaining = handCards.map((card) => card.id);
    for (const cardId of removedHandIds) {
      const index = remaining.indexOf(cardId);
      if (index === -1) {
        return `Invalid removed_hand_ids: card id ${cardId} is not available in current hand`;
      }
      remaining.splice(index, 1);
    }
    return null;
  }

  private getPendingActionList(): any[] {
    const pendingRequest = this.aiPlayerIO?.getPendingRpc()?.request?.request;
    if (pendingRequest?.$case !== "action") {
      return [];
    }
    const actions = pendingRequest.value?.action;
    return Array.isArray(actions) ? actions : [];
  }

  private isElementalTuningAction(action: any): boolean {
    return action?.action?.$case === "elementalTuning";
  }

  private hasValidElementalTuningAction(): boolean {
    return this.getPendingActionList().some(
      (action) => this.isElementalTuningAction(action) && action?.validity === 0,
    );
  }

  private resolveElementalTuningAction(
    actions: any[],
    removedCardId?: number,
    targetDice?: number,
  ): { actionIndex: number; action: any } | null {
    const candidates = actions
      .map((action, actionIndex) => ({ action, actionIndex }))
      .filter(({ action }) => this.isElementalTuningAction(action) && action?.validity === 0)
      .filter(({ action }) => {
        if (!Number.isInteger(removedCardId)) {
          return true;
        }
        return action?.action?.value?.removedCardId === removedCardId;
      })
      .filter(({ action }) => {
        if (!Number.isInteger(targetDice)) {
          return true;
        }
        return action?.action?.value?.targetDice === targetDice;
      });

    return candidates[0] ?? null;
  }

  private checkDiceRequirement(requiredCost: Array<{ type?: number; count?: number }>, usedDice: number[]): boolean {
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
      for (let i = 0; i < count; i++) {
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
        voidCount++;
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
  }

  private executeChooseAction(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("action");
    if (!guard.ok) {
      return guard.result;
    }

    const actionIndexRaw = args.action_index;
    if (!Number.isInteger(actionIndexRaw) || (actionIndexRaw as number) <= 0) {
      return this.buildStructuredError(
        "INVALID_ACTION_INDEX",
        "Invalid action_index: must be an integer starting from 1",
        "Use get_available_commands and choose a valid 1-indexed action from pendingRequest.action list."
      );
    }
    const usedDiceRaw = args.used_dice;
    if (
      typeof usedDiceRaw !== "undefined" &&
      (!Array.isArray(usedDiceRaw) || usedDiceRaw.some((d) => !Number.isInteger(d)))
    ) {
      return this.buildStructuredError(
        "INVALID_USED_DICE",
        "Invalid used_dice: must be an integer array",
        "Pass used_dice as integer array."
      );
    }

    const actionIndex = (actionIndexRaw as number) - 1;
    const usedDice = (usedDiceRaw as number[]) || [];

    const pendingRpc = this.aiPlayerIO.getPendingRpc();
    const pendingRequest = pendingRpc?.request?.request;
    if (pendingRequest?.$case === "action") {
      const actions = pendingRequest.value?.action ?? [];
      if (actionIndex < 0 || actionIndex >= actions.length) {
        return this.buildStructuredError(
          "INVALID_ACTION_INDEX",
          `Invalid action_index: must be between 1 and ${actions.length}`,
          "Re-read pending action list and choose index in valid range.",
          {
            action_index_range: {
              min: 1,
              max: actions.length,
            },
          }
        );
      }
      const selectedAction = actions[actionIndex];
      if (selectedAction?.validity !== 0) {
        return this.buildStructuredError(
          "INVALID_ACTION",
          `Invalid action_index: selected action is not valid (validity=${selectedAction?.validity})`,
          "Select an action with validity=0.",
          {
            action_index: actionIndex + 1,
            validity: selectedAction?.validity,
          }
        );
      }
      if (!this.checkDiceRequirement(selectedAction?.requiredCost ?? [], usedDice)) {
        return this.buildStructuredError(
          "INVALID_USED_DICE",
          "Invalid used_dice: selected dice do not satisfy the required cost of chosen action",
          "Adjust used_dice to satisfy requiredCost or omit used_dice when auto-selected dice is acceptable.",
          {
            action_index: actionIndex + 1,
          }
        );
      }
    }

    const diceValidationError = this.validateDiceSelection(usedDice, "used_dice");
    if (diceValidationError) {
      return this.buildStructuredError(
        "INVALID_USED_DICE",
        diceValidationError,
        "Use only dice currently available in your dice pool."
      );
    }

    const response = createRpcResponse("action", {
      chosenActionIndex: actionIndex,
      usedDice: usedDice,
    });

    const success = this.aiPlayerIO.respondToRpc(response);

    if (success) {
      GameStateListener.getInstance().registerCommandExecution();
      return buildToolCallResult("Action chosen successfully");
    }
    return buildToolCallResult("No pending RPC to respond to", true);
  }

  private executeElementalTuning(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("action");
    if (!guard.ok) {
      return guard.result;
    }

    const removedCardId = args.removed_card_id;
    if (typeof removedCardId !== "undefined" && !Number.isInteger(removedCardId)) {
      return buildToolCallResult("Invalid removed_card_id: must be an integer", true);
    }

    const targetDice = args.target_dice;
    if (typeof targetDice !== "undefined" && !Number.isInteger(targetDice)) {
      return buildToolCallResult("Invalid target_dice: must be an integer", true);
    }

    const usedDiceRaw = args.used_dice;
    if (
      typeof usedDiceRaw !== "undefined" &&
      (!Array.isArray(usedDiceRaw) || usedDiceRaw.some((d) => !Number.isInteger(d)))
    ) {
      return buildToolCallResult("Invalid used_dice: must be an integer array", true);
    }

    const actions = this.getPendingActionList();
    const resolved = this.resolveElementalTuningAction(
      actions,
      removedCardId as number | undefined,
      targetDice as number | undefined,
    );

    if (!resolved) {
      return buildToolCallResult(
        "No valid elemental tuning action matches the provided filters",
        true,
      );
    }

    const autoSelected = Array.isArray(resolved.action?.autoSelectedDice)
      ? (resolved.action.autoSelectedDice as unknown[]).filter((d): d is number => Number.isInteger(d))
      : [];
    const usedDice = Array.isArray(usedDiceRaw)
      ? (usedDiceRaw as number[])
      : autoSelected;

    return this.executeChooseAction({
      action_index: resolved.actionIndex + 1,
      used_dice: usedDice,
    });
  }

  private executeChooseActive(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("chooseActive");
    if (!guard.ok) {
      return guard.result;
    }

    const characterId = args.character_id;
    if (!Number.isInteger(characterId)) {
      return buildToolCallResult("Invalid character_id: must be an integer", true);
    }

    const pendingRequest = this.aiPlayerIO.getPendingRpc()?.request?.request;
    if (pendingRequest?.$case === "chooseActive") {
      const candidateIds = pendingRequest.value?.candidateIds ?? [];
      if (!candidateIds.includes(characterId as number)) {
        return buildToolCallResult(
          `Invalid character_id: must be one of candidate ids ${JSON.stringify(candidateIds)}`,
          true,
        );
      }
    }

    const response = createRpcResponse("chooseActive", {
      activeCharacterId: characterId as number,
    });

    const success = this.aiPlayerIO.respondToRpc(response);

    if (success) {
      GameStateListener.getInstance().registerCommandExecution();
      return buildToolCallResult("Active character chosen successfully");
    }
    return buildToolCallResult("No pending RPC to respond to", true);
  }

  private executeRerollDice(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("rerollDice");
    if (!guard.ok) {
      return guard.result;
    }

    const diceToRerollRaw = args.dice_to_reroll;
    if (!Array.isArray(diceToRerollRaw) || diceToRerollRaw.some((d) => !Number.isInteger(d))) {
      return buildToolCallResult("Invalid dice_to_reroll: must be an integer array of dice types", true);
    }

    const diceToReroll = diceToRerollRaw as number[];
    const availableDice = this.game?.state?.players?.[this.currentWho]?.dice;
    if (Array.isArray(availableDice)) {
      const remaining = [...availableDice];
      for (const die of diceToReroll) {
        const idx = remaining.indexOf(die);
        if (idx === -1) {
          return buildToolCallResult(
            `Invalid dice_to_reroll: dice type ${die} is not available in current dice pool`,
            true,
          );
        }
        remaining.splice(idx, 1);
      }
    }

    const response = createRpcResponse("rerollDice", {
      diceToReroll: diceToReroll,
    });

    const success = this.aiPlayerIO.respondToRpc(response);

    if (success) {
      GameStateListener.getInstance().registerCommandExecution();
      return buildToolCallResult("Dice reroll chosen successfully");
    }
    return buildToolCallResult("No pending RPC to respond to", true);
  }

  private executeSwitchHands(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("switchHands");
    if (!guard.ok) {
      return guard.result;
    }

    const removedHandIdsRaw = args.removed_hand_ids;
    if (!Array.isArray(removedHandIdsRaw) || removedHandIdsRaw.some((id) => !Number.isInteger(id))) {
      return buildToolCallResult("Invalid removed_hand_ids: must be an integer array", true);
    }

    const removedHandIds = removedHandIdsRaw as number[];

    const handValidationError = this.validateHandCardSelection(removedHandIds);
    if (handValidationError) {
      return buildToolCallResult(handValidationError, true);
    }

    const response = createRpcResponse("switchHands", {
      removedHandIds: removedHandIds,
    });

    const success = this.aiPlayerIO.respondToRpc(response);

    if (success) {
      GameStateListener.getInstance().registerCommandExecution();
      return buildToolCallResult("Hand switch chosen successfully");
    }
    return buildToolCallResult("No pending RPC to respond to", true);
  }

  private executeSelectCard(args: Record<string, unknown>) {
    if (!this.aiPlayerIO) {
      return buildToolCallResult("Game not initialized", true);
    }

    const guard = this.ensurePendingMethod("selectCard");
    if (!guard.ok) {
      return guard.result;
    }

    const selectedDefinitionId = args.selected_definition_id;
    if (!Number.isInteger(selectedDefinitionId)) {
      return buildToolCallResult("Invalid selected_definition_id: must be an integer", true);
    }

    const pendingRequest = this.aiPlayerIO.getPendingRpc()?.request?.request;
    if (pendingRequest?.$case === "selectCard") {
      const candidateDefinitionIds = pendingRequest.value?.candidateDefinitionIds ?? [];
      if (!candidateDefinitionIds.includes(selectedDefinitionId as number)) {
        return buildToolCallResult(
          `Invalid selected_definition_id: must be one of candidate definition ids ${JSON.stringify(candidateDefinitionIds)}`,
          true,
        );
      }
    }

    const response = createRpcResponse("selectCard", {
      selectedDefinitionId: selectedDefinitionId as number,
    });

    const success = this.aiPlayerIO.respondToRpc(response);

    if (success) {
      GameStateListener.getInstance().registerCommandExecution();
      return buildToolCallResult("Card selected successfully");
    }
    return buildToolCallResult("No pending RPC to respond to", true);
  }
}
