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
 * Standalone MCP Client
 *
 * Connects to a running standalone game via the HTTP bridge API.
 * Each client instance controls exactly one player (who: 0 or 1).
 * Base URL should be the standalone server root, e.g. "http://localhost:3901".
 */

const DEFAULT_BASE_URL = "http://localhost:3901";
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const STATUS_FETCH_TIMEOUT_MS = 5_000;
const COMMAND_FETCH_TIMEOUT_MS = 10_000;

export interface StandaloneStatus {
  hasPendingRpc: boolean;
  pendingMethod: string | null;
  pendingRequest?: unknown | null;
  snapshotUpdatedAt?: number;
  gamePhase: string;
  currentPlayer: number;
  /** Explicit game-over flag set by the standalone bridge the moment the
   *  underlying Game reaches its `gameEnd` phase. When true, no further RPC
   *  will ever be issued and the AI should stop calling wait_for_my_turn. */
  gameOver?: boolean;
  /** Winner (0 | 1) when `gameOver` is true; null for a draw / unknown. */
  winner?: number | null;
}

export interface StandaloneGameState {
  phase: string;
  currentTurn: number;
  roundNumber: number;
  winner: number | null;
  player: unknown;
  players: unknown[];
}

export interface StandaloneActionEffectsResponse {
  who: number;
  effects: unknown[];
}

export interface WaitForMyTurnResult {
  status: StandaloneStatus;
  actionEffects: unknown[];
}

export interface StandaloneDeckInfo {
  who: number;
  deck_code: string;
  characters: Array<{ definition_id: number; name: string | null }>;
  cards: Array<{ definition_id: number; name: string | null; count: number }>;
  total_cards: number;
}

export interface StandaloneRpcResponse {
  success: boolean;
  message?: string;
  error?: string;
  errorCode?: string;
  commandId?: string | null;
  idempotencyKey?: string;
  idempotentHit?: boolean;
  alreadyResolved?: boolean;
  lastCommandResult?: unknown;
}

export interface StandaloneCommandContext {
  expectedPendingMethod?: string;
  expectedSnapshotUpdatedAt?: number;
  idempotencyKey?: string;
  /** Skip the post-execution state-polling loop. Set to true for fast actions
   *  (playCard / switchActive / elementalTuning) whose execution does not change
   *  pendingMethod/gamePhase/currentPlayer.  Leave unset for turn-ending actions
   *  (useSkill / declareEnd). */
  skipStatePoll?: boolean;
  /** Optional reasoning text from the LLM agent for this action. */
  explanation?: string;
}

type Who = 0 | 1;

export class StandaloneMcpClient {
  private baseUrl: string;
  private who: Who;

  /**
   * @param baseUrl Standalone server root, e.g. "http://localhost:3901"
   * @param who Which player this client controls: 0 = first-player, 1 = second-player
   */
  constructor(baseUrl: string = DEFAULT_BASE_URL, who: Who = 0) {
    this.baseUrl = baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.who = who;
  }

  /** Which player this client controls */
  getWho(): Who {
    return this.who;
  }

  /** Build the API path for this player: /api/mcp/{who}/{path} */
  private apiPath(path: string): string {
    return `${this.baseUrl}/api/mcp/${this.who}/${path}`;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check connection to standalone bridge */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(this.apiPath("ping"), {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Get current game status for this player */
  async getStatus(): Promise<StandaloneStatus> {
    const response = await this.fetchWithTimeout(
      this.apiPath("status"),
      {},
      STATUS_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`Failed to get status: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneStatus>;
  }

  /** Get full game state (from this player's perspective) */
  async getGameState(): Promise<StandaloneGameState> {
    const response = await this.fetchWithTimeout(this.apiPath("state"));
    if (!response.ok) {
      throw new Error(`Failed to get game state: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneGameState>;
  }

  /** Get lightweight screen state (from this player's perspective) */
  async getScreenState(): Promise<StandaloneGameState> {
    const response = await this.fetchWithTimeout(this.apiPath("screen"));
    if (!response.ok) {
      throw new Error(`Failed to get screen state: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneGameState>;
  }

  /** Get available commands for current state */
  async getAvailableCommands(): Promise<{
    available_tools: Array<{ tool: string; description: string }>;
    has_pending_rpc: boolean;
  }> {
    const response = await this.fetchWithTimeout(this.apiPath("available-commands"));
    if (!response.ok) {
      throw new Error(`Failed to get commands: ${response.statusText}`);
    }
    return response.json() as Promise<{
      available_tools: Array<{ tool: string; description: string }>;
      has_pending_rpc: boolean;
    }>;
  }

  /** Get accumulated action effects since last read and clear them on bridge */
  async getActionEffects(): Promise<StandaloneActionEffectsResponse> {
    const response = await this.fetchWithTimeout(this.apiPath("action-effects"));
    if (!response.ok) {
      throw new Error(`Failed to get action effects: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneActionEffectsResponse>;
  }

  /** Get deck info for a specific player (opponent deck may be disabled) */
  private async getDeck(path: "deck0" | "deck1"): Promise<StandaloneDeckInfo> {
    // Retry with backoff — bridge may not have deck info synced yet
    const maxRetries = 10;
    const baseDelayMs = 300;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.fetchWithTimeout(this.apiPath(path));
      if (!response.ok) {
        throw new Error(`Failed to get ${path}: ${response.statusText}`);
      }
      const data = await response.json() as Record<string, unknown>;
      // Bridge returns { error: "Deck info not available" } when pre-sync hasn't completed
      if (typeof data.error === "string" && data.error.includes("not available")) {
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
          continue;
        }
        throw new Error(`Deck info not available after ${maxRetries} retries`);
      }
      // Successful response has .who / .characters / .cards fields
      if (typeof data.who === "number" && Array.isArray(data.characters) && Array.isArray(data.cards)) {
        return data as unknown as StandaloneDeckInfo;
      }
      throw new Error(`Unexpected deck response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    throw new Error(`Failed to get ${path} after ${maxRetries} retries`);
  }

  async getDeck0(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck0");
  }

  async getDeck1(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck1");
  }

  /**
   * Wait until it's this client's turn to act.
   *
   * Polls game status at the given interval. Returns immediately when
   * hasPendingRpc=true (i.e. the game is waiting for this player's decision).
   * Throws if the game ends while waiting.
   *
   * @param pollIntervalMs How often to poll status (default 500ms)
   * @param timeoutMs Maximum time to wait (default 5 minutes, 0 = no timeout)
   * @returns The status object when it's our turn
   */
  async waitForMyTurn(
    pollIntervalMs: number = 500,
    timeoutMs: number = 300_000,
  ): Promise<WaitForMyTurnResult> {
    const startedAt = Date.now();

    while (true) {
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        throw new Error(`waitForMyTurn timed out after ${timeoutMs}ms for player ${this.who}`);
      }

      const status = await this.getStatus();

      if (status.hasPendingRpc) {
        // Fetch action effects accumulated during opponent's turn
        let actionEffects: unknown[] = [];
        try {
          const effectsResponse = await this.getActionEffects();
          actionEffects = effectsResponse.effects;
        } catch {
          // Non-fatal: effects are best-effort
        }
        return { status, actionEffects };
      }

      // Prefer the explicit gameOver flag pushed by the standalone bridge
      // (set the moment the underlying Game reaches its `gameEnd` phase).
      // Fall back to legacy phase-string matching for bridges that only
      // surface the protobuf phase enum ("5" = PbPhaseType.GAME_END) or
      // the internal literal "gameEnd".
      const isGameOverPhase =
        status.gamePhase === "finished" ||
        status.gamePhase === "terminated" ||
        status.gamePhase === "gameEnd" ||
        status.gamePhase === "5";
      if (status.gameOver === true || isGameOverPhase) {
        const winner = status.winner ?? null;
        const winnerLabel =
          winner === this.who ? "You won"
          : winner === null ? "Winner unknown"
          : "You lost";
        const err = new Error(
          `Game ended while waiting for turn (player ${this.who}). ${winnerLabel}. winner=${winner === null ? "null" : winner}`,
        ) as Error & { game_over?: boolean; winner?: number | null };
        err.game_over = true;
        err.winner = winner;
        throw err;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Check if it's currently this player's turn to act.
   * Non-blocking version of waitForMyTurn.
   */
  async isMyTurn(): Promise<boolean> {
    try {
      const status = await this.getStatus();
      return status.hasPendingRpc;
    } catch {
      return false;
    }
  }

  private createDeterministicIdempotencyKey(method: string, payload: unknown): string {
    const payloadText = (() => {
      try { return JSON.stringify(payload); } catch { return String(payload); }
    })();
    return `${method}:${payloadText}`;
  }

  private async postRpcCommand(
    endpoint: string,
    payload: Record<string, unknown>,
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    const idempotencyKey =
      context?.idempotencyKey ??
      this.createDeterministicIdempotencyKey(endpoint, payload);

    const response = await this.fetchWithTimeout(
      this.apiPath(endpoint),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          idempotencyKey,
          expectedPendingMethod: context?.expectedPendingMethod,
          expectedSnapshotUpdatedAt: context?.expectedSnapshotUpdatedAt,
          explanation: context?.explanation,
        }),
      },
      COMMAND_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`Failed to ${endpoint}: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneRpcResponse>;
  }

  /** Choose an action by 1-indexed action index */
  async chooseAction(
    actionIndex: number,
    usedDice: number[] = [],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    const skipPolling = context?.skipStatePoll === true;

    if (!skipPolling) {
      const before = await this.getStatus().catch(() => null);
      const result = await this.postRpcCommand("action", { actionIndex, usedDice }, context);

      // After a successful turn-ending command (useSkill / declareEnd), poll to
      // verify the game actually advanced.  Complex skills with summons, reactions,
      // and animations can take 5-15 seconds — 60 iterations × 300ms = 18 seconds
      // gives enough headroom.  Fast actions (skipStatePoll=true) bypass this entirely.
      if (result.success && result.commandId && before) {
        for (let i = 0; i < 60; i++) {
          await this.sleep(300);
          const after = await this.getStatus().catch(() => null);
          if (!after) break;
          if (
            after.pendingMethod !== before.pendingMethod ||
            after.gamePhase !== before.gamePhase ||
            after.currentPlayer !== before.currentPlayer
          ) {
            return result; // state advanced — normal success
          }
        }
        // State unchanged after 18s — game engine likely didn't advance.
        return {
          ...result,
          success: false,
          error: "State did not advance after command (engine may be stuck — retry with fresh idempotency key)",
        };
      }

      return result;
    }

    // Fast action (playCard / switchActive / elementalTuning): no polling needed.
    // Fast actions don't change pendingMethod/gamePhase/currentPlayer, so polling
    // would always time out and poison the idempotency cache.
    return this.postRpcCommand("action", { actionIndex, usedDice }, context);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Choose active character */
  async chooseActive(
    activeCharacterId: number,
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("chooseActive", { activeCharacterId }, context);
  }

  /** Reroll dice */
  async rerollDice(
    diceToReroll: number[],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("rerollDice", { diceToReroll }, context);
  }

  /** Switch initial hand cards */
  async switchHands(
    removedHandIds: number[],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("switchHands", { removedHandIds }, context);
  }

  /** Select a card */
  async selectCard(
    selectedDefinitionId: number,
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("selectCard", { selectedDefinitionId }, context);
  }
}
