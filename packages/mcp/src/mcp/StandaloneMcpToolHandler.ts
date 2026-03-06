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

/**
 * MCP Tool Handler for Standalone Game Control
 * 
 * This handler connects to a running standalone game via HTTP API
 * and exposes MCP tools for AI control.
 */

import type { ToolDefinition } from "./MCPProtocol";
import {
  buildToolCallResult,
  buildToolCallResultJson,
  createToolDefinition,
  createInputSchema,
  createProperty,
} from "./MCPProtocol";
import { StandaloneMcpClient, getStandaloneMcpClient } from "../StandaloneMcpClient";
import { CardIndexStore } from "../card-index/CardIndexStore";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const OPPONENT_DECK_ENV = "MCP_ALLOW_OPP_DECK";
const isOpponentDeckAllowed = (): boolean => {
  const raw = process.env[OPPONENT_DECK_ENV];
  if (!raw) {
    return true;
  }
  const normalized = raw.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
};

type PlanV1 = {
  plan_id: string;
  session_id: string;
  deck_fingerprint: string;
  source_skills: string[];
  global_goal: string;
  turn1_3_priorities: string[];
  risk_rules: string[];
  pivot_rules: string[];
  created_at: string;
  updated_at: string;
  version: string;
};

export class StandaloneMcpToolHandler {
  private client: StandaloneMcpClient;
  private baseUrl: string;
  private cardIndexStore: CardIndexStore;
  private sessionId: string | null = null;

  private static readonly PLAN_V1_VERSION = "PlanV1";

  constructor(baseUrl: string = "http://localhost:3001") {
    this.baseUrl = baseUrl;
    // Create a new client instance instead of using singleton
    this.client = new StandaloneMcpClient(baseUrl);
    this.cardIndexStore = new CardIndexStore();
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  private resolveSessionId(): string {
    if (typeof this.sessionId === "string" && this.sessionId.trim().length > 0) {
      return this.sessionId;
    }
    this.sessionId = `sess_${randomUUID()}`;
    return this.sessionId;
  }

  private sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private getRuntimePlansDir(): string {
    return resolve(process.cwd(), "runtime-plans");
  }

  private getPlanFilePath(sessionId: string): string {
    return join(this.getRuntimePlansDir(), `${this.sanitizeSessionId(sessionId)}.json`);
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async findWorkspaceRoot(startDir: string): Promise<string | null> {
    let cursor = resolve(startDir);
    while (true) {
      const opencodePath = join(cursor, ".opencode");
      if (await this.pathExists(opencodePath)) {
        return cursor;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
    return null;
  }

  private async loadSelectedSkillsFromActiveSkills(): Promise<string[]> {
    const root = await this.findWorkspaceRoot(process.cwd());
    if (!root) {
      return ["base-skill"];
    }
    const selectedSkillsPath = join(root, ".opencode", "active-skills", "selected_skills.json");
    if (!(await this.pathExists(selectedSkillsPath))) {
      return ["base-skill"];
    }

    try {
      const raw = await readFile(selectedSkillsPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const skills = this.normalizeStringArray(parsed);
        return skills.length > 0 ? skills : ["base-skill"];
      }
      if (typeof parsed === "object" && parsed !== null) {
        const selectedSkills = this.normalizeStringArray(
          (parsed as { selected_skills?: unknown }).selected_skills,
        );
        if (selectedSkills.length > 0) {
          return selectedSkills;
        }
      }
    } catch (e) {
      console.error("[StandaloneMcpToolHandler] Failed to read selected_skills.json:", e);
    }

    return ["base-skill"];
  }

  private async resolveDeckFingerprint(): Promise<string> {
    try {
      const deck = await this.client.getDeck0();
      const ids = deck.characters
        .map((character) => character.definition_id)
        .filter((id) => Number.isInteger(id))
        .sort((a, b) => a - b);
      if (ids.length === 0) {
        return "unknown-deck";
      }
      return ids.join("-");
    } catch {
      return "unknown-deck";
    }
  }

  private async buildPlanV1(args: Record<string, unknown>): Promise<PlanV1> {
    const sessionId =
      typeof args.session_id === "string" && args.session_id.trim().length > 0
        ? args.session_id
        : this.resolveSessionId();
    this.sessionId = sessionId;

    const sourceSkillsArg = this.normalizeStringArray(args.source_skills);
    const sourceSkills =
      sourceSkillsArg.length > 0 ? sourceSkillsArg : await this.loadSelectedSkillsFromActiveSkills();

    const deckFingerprint =
      typeof args.deck_fingerprint === "string" && args.deck_fingerprint.trim().length > 0
        ? args.deck_fingerprint
        : await this.resolveDeckFingerprint();

    const now = new Date().toISOString();
    return {
      plan_id: typeof args.plan_id === "string" && args.plan_id.trim().length > 0
        ? args.plan_id
        : `plan_${sessionId}_${Date.now()}`,
      session_id: sessionId,
      deck_fingerprint: deckFingerprint,
      source_skills: sourceSkills,
      global_goal: typeof args.global_goal === "string" && args.global_goal.trim().length > 0
        ? args.global_goal
        : "优先建立前 3 回合节奏优势，避免无效换血。",
      turn1_3_priorities: (() => {
        const value = this.normalizeStringArray(args.turn1_3_priorities);
        return value.length > 0
          ? value
          : ["建立元素附着", "争取高价值反应", "保留关键换人窗口"]; 
      })(),
      risk_rules: (() => {
        const value = this.normalizeStringArray(args.risk_rules);
        return value.length > 0
          ? value
          : ["避免为低收益动作透支骰子", "避免暴露核心角色于可斩杀线"]; 
      })(),
      pivot_rules: (() => {
        const value = this.normalizeStringArray(args.pivot_rules);
        return value.length > 0
          ? value
          : ["未达成开局目标时转入保守换血", "关键组件缺失时优先保资源与血线"]; 
      })(),
      created_at: now,
      updated_at: now,
      version: StandaloneMcpToolHandler.PLAN_V1_VERSION,
    };
  }

  private async writePlanV1(plan: PlanV1): Promise<string> {
    const runtimePlansDir = this.getRuntimePlansDir();
    await mkdir(runtimePlansDir, { recursive: true });
    const planPath = this.getPlanFilePath(plan.session_id);
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf-8");
    return planPath;
  }

  private async ensurePlanV1BeforeAction(): Promise<{ ok: true } | { ok: false; result: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
    const sessionId = this.resolveSessionId();
    const planPath = this.getPlanFilePath(sessionId);
    if (await this.pathExists(planPath)) {
      console.error(`[StandaloneMcpToolHandler] OPENING_PLAN_READY session=${sessionId} path=${planPath} source=existing`);
      return { ok: true };
    }

    try {
      const plan = await this.buildPlanV1({ session_id: sessionId });
      await this.writePlanV1(plan);
      console.error(`[StandaloneMcpToolHandler] OPENING_PLAN_READY session=${sessionId} path=${planPath} source=auto-created`);
      return { ok: true };
    } catch (e) {
      const error = e as Error;
      return {
        ok: false,
        result: this.buildStructuredError(
          "PLAN_V1_CREATE_FAILED",
          `Failed to create PlanV1 before action: ${error.message}`,
          "Call create_opening_plan_v1 and retry choose_action.",
        ),
      };
    }
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
      true,
    );
  }

  private buildWaitStateMeta(status: any) {
    const hasPendingRpc = Boolean(status?.hasPendingRpc);
    const pendingMethod = typeof status?.pendingMethod === "string" ? status.pendingMethod : null;
    return {
      has_pending_rpc: hasPendingRpc,
      pending_method: pendingMethod,
      can_act: hasPendingRpc,
      wait_hint: hasPendingRpc
        ? "Pending RPC is ready. Use get_available_commands then execute exactly one action tool."
        : "No pending RPC. Wait for state changes and poll get_available_commands at low frequency.",
      retry_after_ms: hasPendingRpc ? 0 : 800,
    };
  }

  private async ensurePendingMethod(expected: string): Promise<{ ok: true; status: any } | { ok: false; result: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
    const status = await this.client.getStatus();
    if (!status.hasPendingRpc || !status.pendingMethod) {
      return {
        ok: false,
        result: this.buildStructuredError(
          "NO_PENDING_RPC",
          "No pending RPC to respond to",
          "Call get_available_commands. If has_pending_rpc=false, wait and retry later.",
          this.buildWaitStateMeta(status),
        ),
      };
    }
    if (status.pendingMethod !== expected) {
      return {
        ok: false,
        result: this.buildStructuredError(
          "MISMATCH_PENDING_METHOD",
          `Pending RPC is '${status.pendingMethod}', expected '${expected}'`,
          "Call get_available_commands and use one of available_tools matching pending_method.",
          {
            expected_method: expected,
            ...this.buildWaitStateMeta(status),
          },
        ),
      };
    }
    return { ok: true, status };
  }

  private buildCommandContext(status: any, expectedMethod: string) {
    return {
      expectedPendingMethod: expectedMethod,
      expectedSnapshotUpdatedAt:
        typeof status?.snapshotUpdatedAt === "number" ? status.snapshotUpdatedAt : undefined,
    };
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

  private validateDiceSelection(availableDice: number[] | null, selectedDice: number[], fieldName: string): string | null {
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

  private validateCardSelection(availableIds: number[] | null, selectedIds: number[], fieldName: string): string | null {
    if (!Array.isArray(availableIds)) {
      return null;
    }
    const remaining = [...availableIds];
    for (const id of selectedIds) {
      const idx = remaining.indexOf(id);
      if (idx === -1) {
        return `Invalid ${fieldName}: id ${id} is not available`;
      }
      remaining.splice(idx, 1);
    }
    return null;
  }

  /**
   * Get tool definitions for standalone game control
   */
  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // Connection check
    tools.push(
      createToolDefinition(
        "standalone_ping",
        "Check connection to the standalone game",
        createInputSchema({})
      )
    );

    // Status query
    tools.push(
      createToolDefinition(
        "get_game_status",
        "Get current game status including pending RPC and game phase",
        createInputSchema({})
      )
    );

    // State queries
    tools.push(
      createToolDefinition(
        "get_game_state",
        "Get complete game state from the standalone game",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_screen_state",
        "Get lightweight screen state (recommended for most use cases)",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_available_commands",
        "Get context-aware list of available commands for current state",
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

    tools.push(
      createToolDefinition(
        "create_opening_plan_v1",
        "Create or update PlanV1 and save to runtime-plans/{session_id}.json before opening actions",
        createInputSchema({
          session_id: createProperty("string", "Session ID used for plan file name"),
          source_skills: {
            type: "array",
            items: { type: "string" },
            description: "Selected skills from pre-filter stage",
          },
          deck_fingerprint: createProperty("string", "Deck fingerprint string"),
          global_goal: createProperty("string", "Global opening goal"),
          turn1_3_priorities: {
            type: "array",
            items: { type: "string" },
            description: "Turn 1-3 priorities",
          },
          risk_rules: {
            type: "array",
            items: { type: "string" },
            description: "Risk control rules",
          },
          pivot_rules: {
            type: "array",
            items: { type: "string" },
            description: "Pivot/transition rules when behind",
          },
        })
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

    // Game actions
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
              "Array of dice types to use for the action (optional)"
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

  /**
   * Execute a tool by name
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      switch (toolName) {
        case "standalone_ping":
          return await this.executePing();
        case "get_game_status":
          return await this.executeGetStatus();
        case "get_game_state":
          return await this.executeGetGameState();
        case "get_screen_state":
          return await this.executeGetScreenState();
        case "get_available_commands":
          return await this.executeGetAvailableCommands();
        case "get_player0_deck":
          return await this.executeGetPlayerDeck(0);
        case "get_player1_deck":
          if (!isOpponentDeckAllowed()) {
            return buildToolCallResult("Opponent deck access is disabled", true);
          }
          return await this.executeGetPlayerDeck(1);
        case "create_opening_plan_v1":
          return await this.executeCreateOpeningPlanV1(args);
        case "list_cards":
          return await this.executeListCards(args);
        case "get_card_by_id":
          return await this.executeGetCardById(args);
        case "resolve_card":
          return await this.executeResolveCard(args);
        case "validate_card_mapping":
          return await this.executeValidateCardMapping(args);
        case "choose_action":
          return await this.executeChooseAction(args);
        case "elemental_tuning":
          return await this.executeElementalTuning(args);
        case "choose_active":
          return await this.executeChooseActive(args);
        case "reroll_dice":
          return await this.executeRerollDice(args);
        case "switch_hands":
          return await this.executeSwitchHands(args);
        case "select_card":
          return await this.executeSelectCard(args);
        default:
          return buildToolCallResult(`Unknown tool: ${toolName}`, true);
      }
    } catch (e) {
      const error = e as Error;
      return buildToolCallResult(`Error: ${error.message}`, true);
    }
  }

  private async executePing() {
    const connected = await this.client.ping();
    return buildToolCallResultJson({ 
      connected, 
      message: connected ? "Connected to standalone game" : "Failed to connect to standalone game" 
    });
  }

  private async executeGetStatus() {
    const status = await this.client.getStatus();
    return buildToolCallResultJson(status);
  }

  private async executeGetGameState() {
    try {
      const state = await this.client.getGameState();
      return buildToolCallResultJson(state);
    } catch (e) {
      const error = e as Error;
      console.error("[StandaloneMcpToolHandler] Failed to get game state:", error);
      return buildToolCallResult(`Failed to get game state: ${error.message}`, true);
    }
  }

  private async executeGetScreenState() {
    try {
      const state = await this.client.getScreenState();
      return buildToolCallResultJson(state);
    } catch (e) {
      const error = e as Error;
      console.error("[StandaloneMcpToolHandler] Failed to get screen state:", error);
      return buildToolCallResult(`Failed to get screen state: ${error.message}`, true);
    }
  }

  private async executeGetAvailableCommands() {
    const commands = await this.client.getAvailableCommands();
    const status = await this.client.getStatus().catch(() => null);
    const pendingRequest = (status as any)?.pendingRequest;
    const actions = pendingRequest?.$case === "action" && Array.isArray(pendingRequest?.value?.action)
      ? (pendingRequest.value.action as any[])
      : [];
    const hasValidElementalTuning = actions.some(
      (action) => action?.validity === 0 && action?.action?.$case === "elementalTuning",
    );
    const waitState = this.buildWaitStateMeta(status);

    if (hasValidElementalTuning) {
      const availableTools = Array.isArray((commands as any)?.available_tools)
        ? ([...(commands as any).available_tools] as Array<{ tool: string; description: string }>)
        : [];
      if (!availableTools.some((tool) => tool.tool === "elemental_tuning")) {
        availableTools.push({
          tool: "elemental_tuning",
          description: "Perform elemental tuning using explicit card/dice semantics",
        });
      }
      return buildToolCallResultJson({
        ...(commands as Record<string, unknown>),
        available_tools: availableTools,
        ...waitState,
        why_empty: availableTools.length === 0 ? "No valid action tools available for current pending RPC" : null,
      });
    }
    const availableTools = Array.isArray((commands as any)?.available_tools)
      ? ((commands as any).available_tools as Array<{ tool: string; description: string }>)
      : [];
    return buildToolCallResultJson({
      ...(commands as Record<string, unknown>),
      ...waitState,
      why_empty:
        availableTools.length > 0
          ? null
          : waitState.has_pending_rpc
            ? "Pending RPC exists but no mapped action tool is available for current method"
            : "No pending RPC available for AI action",
    });
  }

  private async executeGetPlayerDeck(who: 0 | 1) {
    try {
      const deckInfo = who === 0 ? await this.client.getDeck0() : await this.client.getDeck1();
      return buildToolCallResultJson(deckInfo);
    } catch (e) {
      const error = e as Error;
      return buildToolCallResult(`Failed to get deck info: ${error.message}`, true);
    }
  }

  private async executeCreateOpeningPlanV1(args: Record<string, unknown>) {
    try {
      const plan = await this.buildPlanV1(args);
      const planPath = await this.writePlanV1(plan);
      console.error(`[StandaloneMcpToolHandler] OPENING_PLAN_READY session=${plan.session_id} path=${planPath} source=tool-call`);
      return buildToolCallResultJson({
        ok: true,
        plan,
        plan_path: planPath,
      });
    } catch (e) {
      const error = e as Error;
      return buildToolCallResult(`Failed to create opening plan: ${error.message}`, true);
    }
  }

  private resolveElementalTuningAction(
    actions: any[],
    removedCardId?: number,
    targetDice?: number,
  ): { actionIndex: number; action: any } | null {
    const candidates = actions
      .map((action, actionIndex) => ({ action, actionIndex }))
      .filter(({ action }) => action?.action?.$case === "elementalTuning" && action?.validity === 0)
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

  private async executeChooseAction(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("action");
    if (!guard.ok) {
      return guard.result;
    }
    const planGuard = await this.ensurePlanV1BeforeAction();
    if (!planGuard.ok) {
      return planGuard.result;
    }
    const actionIndex = args.action_index;
    if (!Number.isInteger(actionIndex) || (actionIndex as number) <= 0) {
      return this.buildStructuredError(
        "INVALID_ACTION_INDEX",
        "Invalid action_index: must be an integer starting from 1",
        "Use get_available_commands and choose a valid 1-indexed action from pendingRequest.action list.",
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
        "Pass used_dice as integer array.",
      );
    }
    const usedDice = (usedDiceRaw as number[]) || [];

    const pendingRequest = guard.status.pendingRequest as any;
    if (pendingRequest?.$case === "action" && Array.isArray(pendingRequest?.value?.action)) {
      const actions = pendingRequest.value.action as any[];
      const selectedAction = actions[(actionIndex as number) - 1];
      if (!selectedAction) {
        return this.buildStructuredError(
          "INVALID_ACTION_INDEX",
          `Invalid action_index: must be between 1 and ${actions.length}`,
          "Re-read pending action list and choose index in valid range.",
          {
            action_index_range: {
              min: 1,
              max: actions.length,
            },
          },
        );
      }
      if (selectedAction.validity !== 0) {
        return this.buildStructuredError(
          "INVALID_ACTION",
          `Invalid action_index: selected action is not valid (validity=${selectedAction.validity})`,
          "Select an action with validity=0.",
          {
            action_index: actionIndex,
            validity: selectedAction.validity,
          },
        );
      }
      if (!this.checkDiceRequirement(selectedAction.requiredCost ?? [], usedDice)) {
        return this.buildStructuredError(
          "INVALID_USED_DICE",
          "Invalid used_dice: selected dice do not satisfy the required cost of chosen action",
          "Adjust used_dice to satisfy requiredCost or omit used_dice when auto-selected dice is acceptable.",
          {
            action_index: actionIndex,
          },
        );
      }
    }

    const screen = await this.client.getScreenState().catch(() => null);
    const currentDice = (screen as any)?.player?.dice;
    const diceValidationError = this.validateDiceSelection(
      Array.isArray(currentDice) ? (currentDice as number[]) : null,
      usedDice,
      "used_dice",
    );
    if (diceValidationError) {
      return this.buildStructuredError(
        "INVALID_USED_DICE",
        diceValidationError,
        "Use only dice currently available in your dice pool.",
      );
    }

    const result = await this.client.chooseAction(
      actionIndex as number,
      usedDice,
      this.buildCommandContext(guard.status, "action"),
    );
    console.error(
      `[StandaloneMcpToolHandler] ACTION_SUBMIT session=${this.resolveSessionId()} action_index=${actionIndex} used_dice=${JSON.stringify(usedDice)}`,
    );
    return buildToolCallResultJson(result);
  }

  private async executeElementalTuning(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("action");
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

    const pendingRequest = guard.status.pendingRequest as any;
    const actions = pendingRequest?.$case === "action" && Array.isArray(pendingRequest?.value?.action)
      ? (pendingRequest.value.action as any[])
      : [];

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

  private async executeChooseActive(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("chooseActive");
    if (!guard.ok) {
      return guard.result;
    }
    const characterId = args.character_id;
    if (!Number.isInteger(characterId)) {
      return buildToolCallResult("Invalid character_id: must be an integer", true);
    }

    const pendingRequest = guard.status.pendingRequest as any;
    if (pendingRequest?.$case === "chooseActive") {
      const candidateIds = pendingRequest?.value?.candidateIds;
      if (Array.isArray(candidateIds) && !candidateIds.includes(characterId)) {
        return buildToolCallResult(
          `Invalid character_id: must be one of candidate ids ${JSON.stringify(candidateIds)}`,
          true,
        );
      }
    }

    const result = await this.client.chooseActive(
      characterId as number,
      this.buildCommandContext(guard.status, "chooseActive"),
    );
    return buildToolCallResultJson(result);
  }

  private async executeRerollDice(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("rerollDice");
    if (!guard.ok) {
      return guard.result;
    }
    const diceToRerollRaw = args.dice_to_reroll;
    if (!Array.isArray(diceToRerollRaw) || diceToRerollRaw.some((d) => !Number.isInteger(d))) {
      return buildToolCallResult("Invalid dice_to_reroll: must be an integer array of dice types", true);
    }
    const diceToReroll = diceToRerollRaw as number[];
    const screen = await this.client.getScreenState().catch(() => null);
    const currentDice = (screen as any)?.player?.dice;
    const diceValidationError = this.validateDiceSelection(
      Array.isArray(currentDice) ? (currentDice as number[]) : null,
      diceToReroll,
      "dice_to_reroll",
    );
    if (diceValidationError) {
      return buildToolCallResult(diceValidationError, true);
    }
    const result = await this.client.rerollDice(
      diceToReroll,
      this.buildCommandContext(guard.status, "rerollDice"),
    );
    return buildToolCallResultJson(result);
  }

  private async executeSwitchHands(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("switchHands");
    if (!guard.ok) {
      return guard.result;
    }
    const removedHandIdsRaw = args.removed_hand_ids;
    if (!Array.isArray(removedHandIdsRaw) || removedHandIdsRaw.some((id) => !Number.isInteger(id))) {
      return buildToolCallResult("Invalid removed_hand_ids: must be an integer array", true);
    }
    const removedHandIds = removedHandIdsRaw as number[];

    const screen = await this.client.getScreenState().catch(() => null);
    const handCards = (screen as any)?.player?.handCard;
    const handCardIds = Array.isArray(handCards)
      ? handCards
          .map((card: any) => card?.id)
          .filter((id: any) => Number.isInteger(id))
      : null;
    const handValidationError = this.validateCardSelection(
      Array.isArray(handCardIds) ? (handCardIds as number[]) : null,
      removedHandIds,
      "removed_hand_ids",
    );
    if (handValidationError) {
      return buildToolCallResult(handValidationError, true);
    }

    const result = await this.client.switchHands(
      removedHandIds,
      this.buildCommandContext(guard.status, "switchHands"),
    );
    return buildToolCallResultJson(result);
  }

  private async executeSelectCard(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("selectCard");
    if (!guard.ok) {
      return guard.result;
    }
    const selectedDefinitionId = args.selected_definition_id;
    if (!Number.isInteger(selectedDefinitionId)) {
      return buildToolCallResult("Invalid selected_definition_id: must be an integer", true);
    }

    const pendingRequest = guard.status.pendingRequest as any;
    if (pendingRequest?.$case === "selectCard") {
      const candidateDefinitionIds = pendingRequest?.value?.candidateDefinitionIds;
      if (Array.isArray(candidateDefinitionIds) && !candidateDefinitionIds.includes(selectedDefinitionId)) {
        return buildToolCallResult(
          `Invalid selected_definition_id: must be one of candidate definition ids ${JSON.stringify(candidateDefinitionIds)}`,
          true,
        );
      }
    }

    const result = await this.client.selectCard(
      selectedDefinitionId as number,
      this.buildCommandContext(guard.status, "selectCard"),
    );
    return buildToolCallResultJson(result);
  }
}
