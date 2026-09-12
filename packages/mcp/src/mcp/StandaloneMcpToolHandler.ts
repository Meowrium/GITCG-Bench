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
} from "./MCPProtocol";
import { StandaloneMcpClient } from "../StandaloneMcpClient";
import { CardIndexStore } from "../card-index/CardIndexStore";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { FragmentResolver } from "../scoring/FragmentResolver";
import type {
  TurnDigestV1,
  DecisionFragmentV1,
  ExecutionFeedbackV1,
  ActionSpecV1,
} from "../scoring/types";
import {
  buildStructuredError,
  isOpponentDeckAllowed,
} from "./shared-utils";

import { OpeningPlanStore } from "./OpeningPlanStore";
import { DeckAnalysisService } from "./DeckAnalysisService";
import { TurnDigestBuilder } from "./TurnDigestBuilder";
import { StandaloneActionExecutor } from "./StandaloneActionExecutor";
import { StandaloneToolRegistry } from "./StandaloneToolRegistry";

export class StandaloneMcpToolHandler {
  private client: StandaloneMcpClient;
  private who: 0 | 1;
  private cardIndexStore: CardIndexStore;
  private fragmentedStateBySession: Map<string, { digest: TurnDigestV1; candidateActionMap: Map<string, { tool: string; args: Record<string, unknown> }> }> = new Map();
  private lastFeedbackBySession: Map<string, ExecutionFeedbackV1> = new Map();
  private fragmentResolver: FragmentResolver;

  private planStore: OpeningPlanStore;
  private deckAnalysisService: DeckAnalysisService;
  private digestBuilder: TurnDigestBuilder;
  private actionExecutor: StandaloneActionExecutor;
  private toolRegistry: StandaloneToolRegistry;

  constructor(
    baseUrl: string = "http://localhost:3901",
    options: {
      who?: 0 | 1;
      toolExposureMode?: "direct-action" | "fragmented-decision";
      /** Inject a pre-built client (e.g. MemoryStandaloneMcpClient for headless mode).
       *  When provided, baseUrl is ignored. */
      client?: StandaloneMcpClient;
    } = {},
  ) {
    this.who = (options.who ?? 0) as 0 | 1;
    this.client = options.client ?? new StandaloneMcpClient(baseUrl, this.who);
    this.cardIndexStore = new CardIndexStore();
    this.fragmentResolver = new FragmentResolver();

    this.planStore = new OpeningPlanStore(this.client);
    this.deckAnalysisService = new DeckAnalysisService();
    this.digestBuilder = new TurnDigestBuilder(this.client, this.cardIndexStore, this.who);
    this.actionExecutor = new StandaloneActionExecutor(this.client);
    this.toolRegistry = new StandaloneToolRegistry(options.toolExposureMode ?? "fragmented-decision");
  }

  getWho(): 0 | 1 {
    return this.who;
  }

  getClient(): StandaloneMcpClient {
    return this.client;
  }

  setSessionId(sessionId: string) {
    this.planStore.setSessionId(sessionId);
  }

  getToolExposureMode(): "direct-action" | "fragmented-decision" {
    return this.toolRegistry.getToolExposureMode();
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.toolRegistry.getToolDefinitions();
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      if (this.toolRegistry.isToolHiddenInFragmentedMode(toolName)) {
        return buildToolCallResult(JSON.stringify({
          ok: false,
          error_code: this.toolRegistry.isActionTool(toolName)
            ? "ACTION_TOOL_HIDDEN_IN_FRAGMENTED_MODE"
            : "TOOL_HIDDEN_IN_FRAGMENTED_MODE",
          tool_name: toolName,
          message: this.toolRegistry.isActionTool(toolName)
            ? "Direct action tools are hidden in fragmented-decision mode. Use get_turn_digest_v1 and submit_decision_fragment_v1."
            : "This state tool is hidden in fragmented-decision mode. Use get_turn_digest_v1 for decision context.",
        }), true);
      }

      switch (toolName) {
        case "standalone_ping":
          return await this.executePing();
        case "wait_for_my_turn":
          return await this.executeWaitForMyTurn(args);
        case "get_game_status":
          return await this.executeGetStatus();
        case "get_game_result":
          return await this.executeGetGameResult();
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
        case "analyze_deck":
          return await this.executeAnalyzeDeck(args);
        case "analyze_matchup":
          return await this.executeAnalyzeMatchup(args);
        case "strategy_store":
          return await this.executeStrategyStore(args);
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
        case "get_cards_by_ids":
          return await this.executeGetCardsByIds(args);
        case "get_turn_digest_v1":
          return await this.executeGetTurnDigestV1();
        case "submit_decision_fragment_v1":
          return await this.executeSubmitDecisionFragmentV1(args);
        case "get_execution_feedback_v1":
          return await this.executeGetExecutionFeedbackV1();
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

  private isGameOver(gamePhase: string | null | undefined): boolean {
    // Legacy string markers ("finished"/"terminated") plus the actual values
    // the standalone bridge surfaces: the protobuf PbPhaseType.GAME_END enum
    // serialized as the string "5", and the internal literal "gameEnd".
    return gamePhase === "finished"
      || gamePhase === "terminated"
      || gamePhase === "gameEnd"
      || gamePhase === "5";
  }

  /**
   * Resolve game-over info from a bridge status object. Prefers the explicit
   * `gameOver` / `winner` fields pushed by the standalone bridge (set the
   * moment the underlying Game reaches its `gameEnd` phase); falls back to
   * fetching the full game state to read `state.winner` for bridges that
   * only surface the legacy phase-string markers.
   */
  private async resolveGameOver(status: {
    gameOver?: boolean;
    gamePhase?: string | null;
    winner?: number | null;
  } | null): Promise<{ game_over: true; winner: number | null; you_won: boolean | null; message: string } | null> {
    if (!status) return null;
    const phaseGameOver = this.isGameOver(status.gamePhase);
    if (status.gameOver !== true && !phaseGameOver) return null;

    // Prefer the winner attached to the status snapshot; fall back to a
    // state fetch for bridges that don't populate it.
    let winner: number | null = null;
    if (status.winner === 0 || status.winner === 1) {
      winner = status.winner;
    } else {
      const fetched = await this.tryFetchGameOverInfo();
      winner = fetched?.winner ?? null;
    }
    const youWon = winner === this.who;
    const message = winner === null
      ? "Game over. Winner unknown."
      : youWon ? "Game over. You won!" : "Game over. You lost.";
    return { game_over: true, winner, you_won: youWon, message };
  }

  private async tryFetchGameOverInfo(): Promise<{
    winner: number | null;
    you_won: boolean | null;
  } | null> {
    try {
      const state = await this.client.getGameState().catch(() => null);
      if (state && typeof state.winner === "number") {
        return { winner: state.winner, you_won: state.winner === this.who };
      }
      return { winner: null, you_won: null };
    } catch {
      return null;
    }
  }

  private async executeWaitForMyTurn(args: Record<string, unknown>) {
    const pollIntervalMs =
      typeof args.poll_interval_ms === "number" && args.poll_interval_ms > 0
        ? args.poll_interval_ms
        : 500;
    const timeoutMs =
      typeof args.timeout_ms === "number" && args.timeout_ms >= 0
        ? args.timeout_ms
        : 300_000;

    try {
      const { status, actionEffects } = await this.client.waitForMyTurn(pollIntervalMs, timeoutMs);
      const sessionId = this.planStore.resolveSessionId();

      // Enrich raw action effects with resolved names/labels
      const enrichedEffects = await this.enrichActionEffects(actionEffects).catch(() => null);

      let digest: TurnDigestV1 | null = null;
      try {
        const fullStatus = await this.client.getStatus().catch(() => null);
        if (fullStatus && (fullStatus as any).hasPendingRpc && this.normalizePendingMethod(fullStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, fullStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            digest = artifacts.digest;
          }
        }
      } catch {
        // Best-effort
      }

      return buildToolCallResultJson({
        ok: true,
        your_turn: true,
        pending_method: status.pendingMethod,
        game_phase: status.gamePhase,
        current_player: status.currentPlayer,
        message: `It's your turn! Digest included — analyze candidate_actions[] and submit via choose_action (or submit_decision_fragment_v1 in fragmented mode).`,
        ...(digest ? { digest } : {}),
        ...(enrichedEffects ? { action_effects: enrichedEffects } : {}),
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Game ended while waiting — return a clear game-over signal instead of an opaque error.
      // The structured error thrown by StandaloneMcpClient.waitForMyTurn carries
      // `game_over` + `winner` properties (populated from the bridge's explicit
      // game-over signal). Fall back to fetching the info if absent.
      if (/game ended/i.test(msg) || /game (is )?over/i.test(msg) || e?.game_over === true) {
        const winnerFromErr =
          e?.winner === 0 || e?.winner === 1 ? (e.winner as number) : null;
        let winner: number | null = winnerFromErr;
        let youWon: boolean | null = winner === this.who;
        if (typeof winner !== "number") {
          const gameOver = await this.tryFetchGameOverInfo();
          winner = gameOver?.winner ?? null;
          youWon = gameOver?.you_won ?? null;
        }
        return buildToolCallResultJson({
          ok: true,
          your_turn: false,
          game_over: true,
          game_phase: "finished",
          winner,
          you_won: youWon,
          message: `Game over while waiting for your turn. ${youWon === true ? "You won!" : youWon === false ? "You lost." : "Winner unknown."} No further actions needed.`,
        });
      }
      return buildToolCallResultJson({
        ok: false,
        your_turn: false,
        error: msg,
        message: `Failed waiting for turn: ${msg}`,
      });
    }
  }

  private async executeGetStatus() {
    const status = await this.client.getStatus();
    return buildToolCallResultJson(status);
  }

  private async executeGetGameResult() {
    const status = await this.client.getStatus();
    const gameOver = (status as any).gameOver === true || this.isGameOver(status.gamePhase);
    if (!gameOver) {
      return buildToolCallResultJson({
        game_over: false,
        game_phase: status.gamePhase,
        current_player: status.currentPlayer,
        has_pending_rpc: status.hasPendingRpc,
        message: `Game is still in progress (phase: ${status.gamePhase}). No result yet.`,
      });
    }
    // Prefer the winner attached to the status snapshot (set atomically by
    // the bridge's game-over push); fall back to fetching the full state.
    let winner: number | null = null;
    if ((status as any).winner === 0 || (status as any).winner === 1) {
      winner = (status as any).winner as number;
    } else {
      const fetched = await this.tryFetchGameOverInfo();
      winner = fetched?.winner ?? null;
    }
    const youWon = winner === this.who;
    const message = winner === null
      ? "Game over. Winner unknown."
      : youWon ? "Game over. You won!" : "Game over. You lost.";
    return buildToolCallResultJson({
      game_over: true,
      game_phase: status.gamePhase,
      winner,
      you_won: youWon,
      message: `${message} No further actions needed.`,
    });
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
    const actionData = this.extractOneofValue(pendingRequest, "action");
    const actions = actionData && Array.isArray(actionData.action)
      ? (actionData.action as any[])
      : [];
    const hasValidElementalTuning = actions.some(
      (action) => action?.validity === 0 && String(action?.action?.$case ?? (action?.action?.elementalTuning != null ? "elementalTuning" : "")) === "elementalTuning",
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

  private async executeAnalyzeDeck(args: Record<string, unknown>) {
    const result = await this.deckAnalysisService.analyzeDeck(args);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Failed to analyze deck", true);
    }
    return buildToolCallResultJson({ ok: true, analysis: result.analysis });
  }

  private async executeAnalyzeMatchup(args: Record<string, unknown>) {
    const result = await this.deckAnalysisService.analyzeMatchup(args);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Failed to analyze matchup", true);
    }
    return buildToolCallResultJson({ ok: true, matchup: result.matchup });
  }

  private getStrategyFilePath(sessionId: string): string {
    return join(this.planStore.getRuntimePlansDir(), `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}_strategy.json`);
  }

  private async executeStrategyStore(args: Record<string, unknown>) {
    const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
    const key = typeof args.key === "string" ? args.key.trim() : "";
    const sessionId = this.planStore.resolveSessionId();
    const filePath = this.getStrategyFilePath(sessionId);

    if (!key) {
      return buildToolCallResult("Missing required parameter: key", true);
    }

    switch (action) {
      case "save": {
        const value = args.value;
        if (value === undefined || value === null) {
          return buildToolCallResult("Missing required parameter: value (for 'save' action)", true);
        }
        try {
          let store: Record<string, unknown> = {};
          try {
            const existing = await readFile(filePath, "utf-8");
            store = JSON.parse(existing);
          } catch {
            // File doesn't exist yet
          }
          store[key] = value;
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
          return buildToolCallResultJson({
            ok: true,
            action: "save",
            key,
            stored: true,
          });
        } catch (e: any) {
          return buildToolCallResult(`Failed to save strategy: ${e?.message ?? String(e)}`, true);
        }
      }

      case "load": {
        try {
          const raw = await readFile(filePath, "utf-8");
          const store = JSON.parse(raw) as Record<string, unknown>;
          const found = key in store;
          return buildToolCallResultJson({
            ok: found,
            action: "load",
            key,
            found,
            value: found ? store[key] : null,
          });
        } catch {
          return buildToolCallResultJson({
            ok: false,
            action: "load",
            key,
            found: false,
            value: null,
            message: "Strategy store not found or empty",
          });
        }
      }

      case "delete": {
        try {
          const raw = await readFile(filePath, "utf-8");
          const store = JSON.parse(raw) as Record<string, unknown>;
          const had = key in store;
          delete store[key];
          await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
          return buildToolCallResultJson({
            ok: true,
            action: "delete",
            key,
            deleted: had,
          });
        } catch {
          return buildToolCallResultJson({
            ok: true,
            action: "delete",
            key,
            deleted: false,
            message: "Strategy store not found (nothing to delete)",
          });
        }
      }

      default:
        return buildToolCallResult(`Unknown action: '${action}'. Valid actions: save, load, delete`, true);
    }
  }

  private async executeCreateOpeningPlanV1(args: Record<string, unknown>) {
    try {
      const plan = await this.planStore.buildPlanV1(args);
      const planPath = await this.planStore.writePlanV1(plan);
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

  private async executeGetCardsByIds(args: Record<string, unknown>) {
    const rawIds = args.definition_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return buildToolCallResult("Invalid definition_ids: must be a non-empty array of integers", true);
    }
    const ids = rawIds.filter((id): id is number => Number.isInteger(id));
    if (ids.length === 0) {
      return buildToolCallResult("Invalid definition_ids: no valid integers found", true);
    }
    const uniqueIds = [...new Set(ids)];
    const cardMap = await this.cardIndexStore.getCardsByIds(uniqueIds);
    const cards: Record<string, unknown>[] = [];
    const notFound: number[] = [];
    for (const id of uniqueIds) {
      const card = cardMap.get(id);
      if (card) {
        cards.push({
          definitionId: card.definitionId,
          canonicalName: card.canonicalName,
          definitionKind: card.definitionKind,
          type: card.type,
          tags: card.tags,
          cost: card.cost,
          effectText: card.effectText,
          contentHash: card.contentHash,
          ...(card.since ? { since: card.since } : {}),
        });
      } else {
        notFound.push(id);
      }
    }
    return buildToolCallResultJson({
      ok: true,
      total: uniqueIds.length,
      found: cards.length,
      not_found: notFound.length > 0 ? notFound : undefined,
      cards,
    });
  }

  private extractRawCharacterInfo(
    player: Record<string, unknown> | null,
  ): Array<{ id: number; definitionId: number; hp: number; maxHp: number; energy: number; maxEnergy: number; aura: number | null; alive: boolean; shield: number }> {
    if (!player) return [];
    const characters = Array.isArray((player as any).character) ? (player as any).character : [];
    return characters.map((c: any) => {
      const v = c?.variable ?? c?.variables ?? {};
      const id = typeof c?.id === "number" ? c.id : 0;
      const definitionId = typeof c?.definitionId === "number" ? c.definitionId
        : typeof c?.definition_id === "number" ? c.definition_id : 0;
      const hp = typeof c?.health === "number" ? c.health : typeof v.health === "number" ? v.health : 0;
      const maxHp = typeof c?.maxHealth === "number" ? c.maxHealth : typeof v.maxHealth === "number" ? v.maxHealth : 10;
      const energy = typeof c?.energy === "number" ? c.energy : typeof v.energy === "number" ? v.energy : 0;
      const maxEnergy = typeof c?.maxEnergy === "number" ? c.maxEnergy : typeof v.maxEnergy === "number" ? v.maxEnergy : 0;
      const aura = (c?.aura ?? v?.aura ?? null) as number | null;
      const alive = c?.defeated ? false : (typeof v.alive === "number" ? v.alive > 0 : hp > 0);
      // Sum shield values from this character's entity statuses
      const entities = Array.isArray(c.entity) ? c.entity : [];
      const shield = entities.reduce((sum: number, e: any) => {
        const s = typeof e.shield === "number" ? e.shield : 0;
        return sum + s;
      }, 0);
      return { id, definitionId, hp, maxHp, energy, maxEnergy, aura, alive, shield };
    });
  }

  private async buildActionFeedback(
    beforeScreen: Record<string, unknown> | null,
    afterScreen: Record<string, unknown> | null,
    actionEffects: unknown[] | null,
  ): Promise<Record<string, unknown>> {
    try {
      const feedback: Record<string, unknown> = {};
      const allDefIds = new Set<number>();

      // 1. Per-character state deltas (before → after)
      if (beforeScreen && afterScreen) {
        const { selfPlayer: spB, opponentPlayer: opB } = this.digestBuilder["resolveScreenPlayers"](beforeScreen as any);
        const { selfPlayer: spA, opponentPlayer: opA } = this.digestBuilder["resolveScreenPlayers"](afterScreen as any);
        const beforeAll = [...this.extractRawCharacterInfo(spB), ...this.extractRawCharacterInfo(opB)];
        const afterAll = [...this.extractRawCharacterInfo(spA), ...this.extractRawCharacterInfo(opA)];
        const beforeMap = new Map(beforeAll.map((c) => [c.id, c]));
        const afterMap = new Map(afterAll.map((c) => [c.id, c]));
        for (const c of [...beforeAll, ...afterAll]) {
          if (c.definitionId > 0) allDefIds.add(c.definitionId);
        }
        const cardMap = await this.cardIndexStore.getCardsByIds([...allDefIds]).catch(() => new Map());
        const allIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
        const deltas: Record<string, unknown>[] = [];
        for (const id of allIds) {
          const before = beforeMap.get(id);
          const after = afterMap.get(id);
          if (!before || !after) continue;
          const card = cardMap.get(after.definitionId);
          const hpDelta = after.hp - before.hp;
          const energyDelta = after.energy - before.energy;
          const auraDelta = (after.aura ?? 0) !== (before.aura ?? 0)
            ? { before: before.aura, after: after.aura }
            : undefined;
          deltas.push({
            id,
            definition_id: after.definitionId,
            name: card?.canonicalName ?? null,
            alive: after.alive,
            hp_before: before.hp,
            hp_after: after.hp,
            hp_delta: hpDelta,
            max_hp: after.maxHp,
            energy_before: before.energy,
            energy_after: after.energy,
            energy_delta: energyDelta,
            max_energy: after.maxEnergy,
            aura_before: before.aura,
            aura_after: after.aura,
            aura_changed: auraDelta,
            shield_after: after.shield,
          });
        }
        if (deltas.length > 0) feedback.character_deltas = deltas;
      }

      // 2. Enrich action effects with resolved character/skill names
      const enrichedEffects = await this.enrichActionEffects(actionEffects, allDefIds);
      if (enrichedEffects) feedback.action_effects = enrichedEffects;

      return feedback;
    } catch {
      return {};
    }
  }

  private async enrichActionEffects(
    actionEffects: unknown[] | null,
    allDefIds?: Set<number>,
  ): Promise<unknown[] | null> {
    if (!Array.isArray(actionEffects) || actionEffects.length === 0) {
      return null;
    }
    const defIds = allDefIds ?? new Set<number>();
    for (const eff of actionEffects as any[]) {
      if (eff.skillUsed?.callerDefinitionId) defIds.add(eff.skillUsed.callerDefinitionId);
      if (eff.skillUsed?.skillDefinitionId) defIds.add(eff.skillUsed.skillDefinitionId);
      for (const dmg of (eff.damageDealt ?? []) as any[]) {
        if (dmg.targetDefinitionId) defIds.add(dmg.targetDefinitionId);
      }
      if (eff.switchActiveToDefinitionId) defIds.add(eff.switchActiveToDefinitionId);
    }
    const cardMap = await this.cardIndexStore.getCardsByIds([...defIds]).catch(() => new Map());

    const DAMAGE_TYPE_LABELS: Record<number, string> = {
      0: "Physical", 1: "Cryo", 2: "Hydro", 3: "Pyro", 4: "Electro",
      5: "Anemo", 6: "Geo", 7: "Dendro", 8: "Piercing", 9: "Heal",
    };
    const REACTION_TYPE_LABELS: Record<number, string> = {
      101: "Melt", 102: "Vaporize", 103: "Overloaded", 104: "Superconduct",
      105: "ElectroCharged", 106: "Frozen", 107: "SwirlCryo", 108: "SwirlHydro",
      109: "SwirlPyro", 110: "SwirlElectro", 111: "CrystallizeCryo",
      112: "CrystallizeHydro", 113: "CrystallizePyro", 114: "CrystallizeElectro",
      115: "Burning", 116: "Bloom", 117: "Quicken",
      3001: "LunarElectroCharged", 3002: "LunarBloom", 3003: "LunarCrystallizeHydro",
    };
    return (actionEffects as any[]).map((eff) => ({
      actionType: eff.actionType,
      description: eff.description,
      skillUsed: eff.skillUsed
        ? {
            callerDefinitionId: eff.skillUsed.callerDefinitionId,
            skillDefinitionId: eff.skillUsed.skillDefinitionId,
            callerName: cardMap.get(eff.skillUsed.callerDefinitionId)?.canonicalName ?? null,
            skillName: cardMap.get(eff.skillUsed.skillDefinitionId)?.canonicalName ?? null,
          }
        : null,
      damageDealt: (eff.damageDealt ?? []).map((dmg: any) => ({
        targetDefinitionId: dmg.targetDefinitionId,
        targetName: cardMap.get(dmg.targetDefinitionId)?.canonicalName ?? null,
        value: dmg.value,
        damageType: dmg.type,
        damageTypeLabel: DAMAGE_TYPE_LABELS[dmg.type] ?? `Type${dmg.type}`,
        causeDefeated: dmg.causeDefeated === true,
      })),
      reactions: (eff.reactions ?? []).map((rxn: any) => ({
        type: rxn.type,
        label: REACTION_TYPE_LABELS[rxn.type] ?? `Reaction${rxn.type}`,
      })),
      switchActiveToDefinitionId: eff.switchActiveToDefinitionId ?? null,
      switchActiveToName: eff.switchActiveToDefinitionId
        ? (cardMap.get(eff.switchActiveToDefinitionId)?.canonicalName ?? null)
        : null,
      declaredEnd: eff.declaredEnd === true,
    }));
  }

  private async executeActionWithFeedback(
    args: Record<string, unknown>,
    status: any,
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    const actionIndex = args.action_index;
    const isFast = typeof actionIndex === "number"
      && this.actionExecutor.isActionFast(status.pendingRequest, actionIndex);

    // Capture state before action
    const beforeScreen = await this.client.getScreenState().catch(() => null);

    const execResult = await this.actionExecutor.executeChooseAction(
      args,
      status,
      () => this.planStore.ensurePlanV1BeforeAction(),
    );

    if (!execResult.ok) {
      return { ok: false, error: execResult.error ?? "Unknown execution error" };
    }

    console.error(
      `[StandaloneMcpToolHandler] ACTION_SUBMIT session=${this.planStore.resolveSessionId()} action_index=${actionIndex}`,
    );

    if (isFast) {
      await new Promise((r) => setTimeout(r, 300));
    }

    // Capture state after action + effects
    const [afterScreen, effectsResponse] = await Promise.all([
      this.client.getScreenState().catch(() => null),
      this.client.getActionEffects().catch(() => null),
    ]);

    const actionEffects = effectsResponse?.effects ?? null;
    const feedback = await this.buildActionFeedback(beforeScreen, afterScreen, actionEffects);
    const enrichedResult = {
      ...execResult.result,
      action_feedback: Object.keys(feedback).length > 0 ? feedback : undefined,
    };
    return { ok: true, result: enrichedResult };
  }

  private async executeChooseAction(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("action");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.executeActionWithFeedback(args, guard.status);
    if (!result.ok) {
      return buildStructuredError(
        "EXECUTION_ERROR",
        result.error ?? "Unknown error",
        "Use get_available_commands and choose a valid action.",
      );
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        const gameOverInfo = await this.resolveGameOver(nextStatus as any);
        if (gameOverInfo) {
          Object.assign(response, gameOverInfo);
        } else if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort digest refresh */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeElementalTuning(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("action");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.actionExecutor.executeElementalTuning(
      args,
      guard.status,
      (a) => this.executeActionWithFeedback(a, guard.status),
    );

    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Unknown error", true);
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        const gameOverInfo = await this.resolveGameOver(nextStatus as any);
        if (gameOverInfo) {
          Object.assign(response, gameOverInfo);
        } else if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort digest refresh */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeChooseActive(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("chooseActive");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.actionExecutor.executeChooseActive(args, guard.status);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Unknown error", true);
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeRerollDice(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("rerollDice");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.actionExecutor.executeRerollDice(args, guard.status);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Unknown error", true);
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeSwitchHands(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("switchHands");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.actionExecutor.executeSwitchHands(args, guard.status);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Unknown error", true);
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeSelectCard(args: Record<string, unknown>) {
    const guard = await this.ensurePendingMethod("selectCard");
    if (!guard.ok) {
      return guard.result;
    }

    const result = await this.actionExecutor.executeSelectCard(args, guard.status);
    if (!result.ok) {
      return buildToolCallResult(result.error ?? "Unknown error", true);
    }

    const response: Record<string, unknown> = { ...(result.result as any) };
    if (result.result?.success) {
      try {
        const sessionId = this.planStore.resolveSessionId();
        const nextStatus = await this.client.getStatus().catch(() => null);
        if (nextStatus && (nextStatus as any).hasPendingRpc && this.normalizePendingMethod(nextStatus.pendingMethod)) {
          const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
          if (artifacts) {
            this.fragmentedStateBySession.set(sessionId, artifacts);
            response.digest = artifacts.digest;
          }
        }
      } catch { /* best-effort */ }
    }
    return buildToolCallResultJson(response);
  }

  private async executeGetTurnDigestV1() {
    const sessionId = this.planStore.resolveSessionId();
    const status = await this.client.getStatus();

    if (!(status as any).hasPendingRpc || !this.normalizePendingMethod((status as any).pendingMethod)) {
      return buildToolCallResultJson({
        ok: false,
        error_code: "NO_PENDING_RPC",
        message: "No pending RPC available for digest generation.",
        recover_hint: "Wait for has_pending_rpc=true and retry get_turn_digest_v1.",
      });
    }

    const artifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, status, (id) => this.planStore.getPlanFilePath(id));
    if (!artifacts) {
      return buildToolCallResultJson({
        ok: false,
        error_code: "DIGEST_BUILD_FAILED",
        message: "Failed to build digest from current state.",
        recover_hint: "Retry get_turn_digest_v1 after state refresh.",
      });
    }

    this.fragmentedStateBySession.set(sessionId, artifacts);
    const digestPath = this.getRuntimeArtifactPath(sessionId, "digest", Date.now());
    await this.writeRuntimeArtifact(digestPath, artifacts.digest);

    return buildToolCallResultJson({
      ok: true,
      digest: artifacts.digest,
      digest_path: digestPath,
    });
  }

  private getRuntimeArtifactPath(sessionId: string, kind: string, ts: number): string {
    return join(this.planStore.getRuntimePlansDir(), `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}_${kind}_${ts}.json`);
  }

  private async writeRuntimeArtifact(path: string, data: unknown): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  }

  private async executeSubmitDecisionFragmentV1(args: Record<string, unknown>) {
    const sessionId = typeof args.session_id === "string" && args.session_id.trim().length > 0
      ? args.session_id
      : this.planStore.resolveSessionId();
    this.planStore.setSessionId(sessionId);

    const state = this.fragmentedStateBySession.get(sessionId);
    if (!state) {
      return buildToolCallResultJson({
        ok: false,
        error_code: "MISSING_DIGEST",
        message: "No digest context found. Each digest is consumed after one successful fragment submission (game state advances).",
        recover_hint: "Call get_turn_digest_v1 to get a fresh digest, then submit_decision_fragment_v1 with the new digest_ref.",
      });
    }

    const digestRef = typeof args.digest_ref === "string" && args.digest_ref.trim().length > 0
      ? args.digest_ref
      : state.digest.digest_ref;

    if (digestRef !== state.digest.digest_ref) {
      return buildToolCallResultJson({
        ok: false,
        error_code: "DIGEST_REF_MISMATCH",
        message: `digest_ref mismatch, expected ${state.digest.digest_ref}`,
        recover_hint: "Use the digest_ref returned by get_turn_digest_v1.",
      });
    }

    const fragment: DecisionFragmentV1 = {
      version: "DecisionFragmentV1",
      fragment_ref: `fragment_${sessionId}_${Date.now()}`,
      session_id: sessionId,
      digest_ref: digestRef,
      intent: typeof args.intent === "string" ? args.intent : "stabilize_tempo",
      must_do: Array.isArray(args.must_do)
        ? args.must_do.filter((v): v is string => typeof v === "string")
        : [],
      avoid: Array.isArray(args.avoid)
        ? args.avoid.filter((v): v is string => typeof v === "string")
        : [],
      preference_order: Array.isArray(args.preference_order)
        ? args.preference_order.filter((v): v is string => typeof v === "string")
        : [],
      resource_policy: (args.resource_policy === "strict" || args.resource_policy === "balanced" || args.resource_policy === "aggressive")
        ? args.resource_policy as "strict" | "balanced" | "aggressive"
        : "balanced",
      target_policy: typeof args.target_policy === "string" ? args.target_policy : "maximize_legal_value",
      fallback_rule: typeof args.fallback_rule === "string" ? args.fallback_rule : "pick_highest_valid_candidate",
      explanation: typeof args.explanation === "string" ? args.explanation : "",
      anchor_candidate_id: typeof args.anchor_candidate_id === "string" && args.anchor_candidate_id.trim().length > 0
        ? args.anchor_candidate_id.trim()
        : undefined,
      rules: Array.isArray(args.rules) && args.rules.length > 0
        ? (() => {
            const rawRules = args.rules as any[];
            const dropped: string[] = [];
            const parsed = rawRules
              .filter((r: any) => {
                if (!r || typeof r !== "object") { dropped.push("not an object"); return false; }
                if (typeof r.priority !== "number") { dropped.push(`priority=${r.priority} not a number`); return false; }
                if (!r.then || typeof r.then !== "object") { dropped.push("then missing or not an object"); return false; }
                if (typeof r.then.action_case !== "string") {
                  dropped.push(`priority=${r.priority} missing action_case (got: ${JSON.stringify(r.then.action_case)})`);
                  return false;
                }
                return true;
              })
              .map((r: any) => ({
                priority: r.priority as number,
                when: Array.isArray(r.when) ? (r.when as any[]).filter((c: any) => c && typeof c.field === "string") : undefined,
                then: {
                  action_case: String(r.then.action_case) as ActionSpecV1["action_case"],
                  skill_type: typeof r.then.skill_type === "string" ? (r.then.skill_type as ActionSpecV1["skill_type"]) : undefined,
                  target: r.then.target as ActionSpecV1["target"],
                  prefer_reaction: Array.isArray(r.then.prefer_reaction) ? (r.then.prefer_reaction as ActionSpecV1["prefer_reaction"]) : undefined,
                  damage_min: typeof r.then.damage_min === "number" ? r.then.damage_min : undefined,
                  kills: r.then.kills === true ? true : undefined,
                  card_tag: typeof r.then.card_tag === "string" ? r.then.card_tag : undefined,
                  card_def_id: typeof r.then.card_def_id === "number" ? r.then.card_def_id : undefined,
                  require_tag: typeof r.then.require_tag === "string" ? r.then.require_tag : undefined,
                },
                reason: typeof r.reason === "string" ? r.reason : "No reason",
              }));
            if (dropped.length > 0 && parsed.length > 0) {
              parsed[0].reason = `[parser dropped ${dropped.length} rule(s): ${dropped.join("; ")}] ${parsed[0].reason}`;
            }
            return parsed.length > 0 ? parsed : undefined;
          })()
        : undefined,
      resource: args.resource && typeof args.resource === "object"
        ? {
            max_dice: typeof (args.resource as any).max_dice === "number" ? (args.resource as any).max_dice : undefined,
            allow_tuning: (args.resource as any).allow_tuning === true ? true : undefined,
            tuning_target: typeof (args.resource as any).tuning_target === "string" ? (args.resource as any).tuning_target : undefined,
          }
        : undefined,
      created_at: new Date().toISOString(),
    };

    const resolution = this.fragmentResolver.resolve({ digest: state.digest, candidateActionMap: state.candidateActionMap }, fragment);

    const selectedCandidateId = resolution.selectedCandidateId;
    let executed = false;
    let executedTool: string | null = null;
    let executionError: string | null = null;

    if (selectedCandidateId) {
      const actionRecord = state.candidateActionMap.get(selectedCandidateId);
      if (actionRecord) {
        const selectedCandidate = state.digest.candidate_actions.find(
          (c) => String(c.candidate_id) === selectedCandidateId,
        );
        // Authoritative fast/slow flag comes from core's `action.isFast`,
        // propagated into the digest as `is_fast` by TurnDigestBuilder.
        // `choose_action` maps to a combat/skill action; only fast actions
        // (playCard/switchActive/elementalTuning with isFast=true) can skip
        // post-execution state polling.
        const isFastAction = (selectedCandidate as any)?.is_fast === true;
        const dispatchContext = actionRecord.tool === "choose_action"
          ? { skipStatePoll: isFastAction }
          : undefined;

        try {
          const execResult = await this.actionExecutor.executeActionDispatch(actionRecord.tool, actionRecord.args, dispatchContext);
          executed = true;
          executedTool = actionRecord.tool;
          if (!execResult.ok) {
            executionError = execResult.error ?? "Unknown execution error";
            executed = false;
          }
        } catch (e: any) {
          executionError = e?.message ?? String(e);
        }
      }
    }

    let selfCharsAfter: Array<Record<string, unknown>> | undefined;
    let oppCharsAfter: Array<Record<string, unknown>> | undefined;
    if (executed) {
      try {
        const postScreen = await this.client.getScreenState().catch(() => null);
        const { selfPlayer: sp, opponentPlayer: op } = this.digestBuilder["resolveScreenPlayers"](postScreen as any);
        selfCharsAfter = this.digestBuilder["extractCharacterSummaries"](sp as any);
        oppCharsAfter = this.digestBuilder["extractCharacterSummaries"](op as any);
      } catch {
        // Non-critical
      }
    }

    const feedback: ExecutionFeedbackV1 = {
      version: "ExecutionFeedbackV1",
      session_id: sessionId,
      digest_ref: digestRef,
      fragment_ref: fragment.fragment_ref,
      selected_candidate_id: selectedCandidateId,
      executed_tool: executedTool,
      execution_ok: executed,
      resolver_reason: resolution.resolverReason || "No reasoning provided",
      score_breakdown: resolution.scoreBreakdown ?? {},
      fallback_used: resolution.fallbackUsed || !executed,
      self_characters_after: selfCharsAfter,
      opponent_characters_after: oppCharsAfter,
      notes: (() => {
        const base = [
          ...(resolution.debugNotes ?? []),
          executionError ? `execution_error=${executionError}` : "",
        ];
        if (executed) {
          base.push("DIGEST_CONSUMED: This digest has been consumed. Call get_turn_digest_v1 for the next action.");
        }
        if (fragment.rules && fragment.rules.length > 0) {
          if (!executed || resolution.fallbackUsed) {
            base.push("── DSL RULE DIAGNOSTICS ──");
            if (!executed) {
              base.push(`Submitted ${fragment.rules.length} rule(s), none matched any candidate.`);
            } else if (resolution.fallbackUsed) {
              base.push(`⚠️  Submitted ${fragment.rules.length} rule(s), NONE matched any candidate. System fell back to tag-based scoring and selected a candidate automatically. Your DSL rules were IGNORED.`);
            }
            base.push("Rules submitted:");
            for (const r of fragment.rules) {
              const when = r.when?.map((c: any) => `${c.field} ${c.op} ${c.value}`).join(", ") || "always";
              base.push(`  priority=${r.priority} | when=[${when}] | then=${r.then.action_case}${r.then.skill_type ? "/"+r.then.skill_type : ""}${r.then.require_tag ? " require="+r.then.require_tag : ""} | ${r.reason}`);
            }
            base.push("Available candidates (candidate_id | action_case | tags):");
            for (const c of state.digest.candidate_actions) {
              const tags = Array.isArray(c.tags) ? (c.tags as string[]).join(", ") : "";
              base.push(`  ${c.candidate_id} | ${c.action_case} | [${tags}]`);
            }
            base.push("── Ensure rules have correct action_case matching candidate action_case values above ──");
          }
        }
        return base.filter(Boolean);
      })(),
      created_at: new Date().toISOString(),
    };

    this.lastFeedbackBySession.set(sessionId, feedback);

    let nextDigest: TurnDigestV1 | undefined;
    let gameOverInfo: { game_over: true; winner: number | null; you_won: boolean | null; message: string } | undefined;
    if (executed) {
      this.fragmentedStateBySession.delete(sessionId);

      try {
        const nextStatus = await this.client.getStatus().catch(() => null);
        gameOverInfo = (await this.resolveGameOver(nextStatus as any)) ?? undefined;
        if (!gameOverInfo) {
          const hasPending = (nextStatus as any)?.hasPendingRpc;
          const pendingMethod = this.normalizePendingMethod((nextStatus as any)?.pendingMethod);
          if (hasPending && pendingMethod) {
            const nextArtifacts = await this.digestBuilder.buildDigestArtifacts(sessionId, nextStatus, (id) => this.planStore.getPlanFilePath(id));
            if (nextArtifacts) {
              this.fragmentedStateBySession.set(sessionId, nextArtifacts);
              nextDigest = nextArtifacts.digest;
              const consumeIdx = feedback.notes.indexOf("DIGEST_CONSUMED: This digest has been consumed. Call get_turn_digest_v1 for the next action.");
              if (consumeIdx >= 0) {
                feedback.notes[consumeIdx] = "DIGEST_AUTO_REFRESHED: Next digest is included in this response — use it directly for the next submit_decision_fragment_v1.";
              }
            }
          }
        }
      } catch {
        // Auto-re-digest is best-effort
      }
    }

    return buildToolCallResultJson({
      ok: executed,
      fragment,
      feedback,
      ...(nextDigest ? { next_digest: nextDigest } : {}),
      ...(gameOverInfo ?? {}),
    });
  }

  private async executeGetExecutionFeedbackV1() {
    const sessionId = this.planStore.resolveSessionId();
    const feedback = this.lastFeedbackBySession.get(sessionId);
    if (!feedback) {
      return buildToolCallResultJson({
        ok: false,
        error_code: "MISSING_EXECUTION_FEEDBACK",
        message: "No execution feedback found for current session.",
        recover_hint: "Call submit_decision_fragment_v1 first.",
      });
    }
    return buildToolCallResultJson({
      ok: true,
      feedback,
    });
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

  private normalizePendingMethod(method: string | null | undefined): string | null {
    if (!method) return null;
    const valid = ["action", "chooseActive", "rerollDice", "switchHands", "selectCard"];
    return valid.includes(method) ? method : null;
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
      // If the game is over, surface a clear game-over signal instead of a
      // generic NO_PENDING_RPC error — the AI should stop issuing actions.
      if ((status as any).gameOver === true || this.isGameOver(status.gamePhase)) {
        const gameOverInfo = await this.resolveGameOver(status as any);
        if (gameOverInfo) {
          return {
            ok: false,
            result: buildToolCallResultJson({
              ok: false,
              ...gameOverInfo,
              error_code: "GAME_OVER",
              message: `${gameOverInfo.message} No further actions are accepted.`,
            }),
          };
        }
      }
      return {
        ok: false,
        result: buildStructuredError(
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
        result: buildStructuredError(
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
}
