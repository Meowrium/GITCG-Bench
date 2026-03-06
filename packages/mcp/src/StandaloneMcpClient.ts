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
 * This client connects to a running standalone game via HTTP API
 * and provides MCP tool functionality for AI control.
 */

const DEFAULT_BASE_URL = "http://localhost:3001";

export interface StandaloneStatus {
  hasPendingRpc: boolean;
  pendingMethod: string | null;
  pendingRequest?: unknown | null;
  snapshotUpdatedAt?: number;
  gamePhase: string;
  currentPlayer: number;
}

export interface StandaloneGameState {
  phase: string;
  currentTurn: number;
  roundNumber: number;
  winner: number | null;
  player: unknown;
  players: unknown[];
}

export interface StandaloneDeckInfo {
  who: number;
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
}

export class StandaloneMcpClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Check connection to standalone
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/mcp/ping`, { 
        method: "GET",
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<StandaloneStatus> {
    const response = await fetch(`${this.baseUrl}/api/mcp/status`);
    if (!response.ok) {
      throw new Error(`Failed to get status: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneStatus>;
  }

  /**
   * Get full game state
   */
  async getGameState(): Promise<StandaloneGameState> {
    const response = await fetch(`${this.baseUrl}/api/mcp/state`);
    if (!response.ok) {
      throw new Error(`Failed to get game state: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneGameState>;
  }

  /**
   * Get screen state (lightweight)
   */
  async getScreenState(): Promise<StandaloneGameState> {
    const response = await fetch(`${this.baseUrl}/api/mcp/screen`);
    if (!response.ok) {
      throw new Error(`Failed to get screen state: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneGameState>;
  }

  /**
   * Get available commands for current state
   */
  async getAvailableCommands(): Promise<{ available_tools: Array<{ tool: string; description: string }>; has_pending_rpc: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/mcp/commands`);
    if (!response.ok) {
      throw new Error(`Failed to get commands: ${response.statusText}`);
    }
    return response.json() as Promise<{ available_tools: Array<{ tool: string; description: string }>; has_pending_rpc: boolean }>;
  }

  private async getDeck(path: "deck0" | "deck1"): Promise<StandaloneDeckInfo> {
    const response = await fetch(`${this.baseUrl}/api/mcp/${path}`);
    if (!response.ok) {
      throw new Error(`Failed to get ${path}: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneDeckInfo>;
  }

  async getDeck0(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck0");
  }

  async getDeck1(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck1");
  }

  /**
   * Send action response
   */
  private createDeterministicIdempotencyKey(method: string, payload: unknown): string {
    const payloadText = (() => {
      try {
        return JSON.stringify(payload);
      } catch {
        return String(payload);
      }
    })();
    return `${method}:${payloadText}`;
  }

  private async postRpcCommand(
    endpoint: string,
    payload: Record<string, unknown>,
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    const idempotencyKey =
      context?.idempotencyKey ??
      this.createDeterministicIdempotencyKey(endpoint, payload);

    const response = await fetch(`${this.baseUrl}/api/mcp/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        idempotencyKey,
        expectedPendingMethod: context?.expectedPendingMethod,
        expectedSnapshotUpdatedAt: context?.expectedSnapshotUpdatedAt,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to ${endpoint}: ${response.statusText}`);
    }
    return response.json() as Promise<StandaloneRpcResponse>;
  }

  async chooseAction(
    actionIndex: number,
    usedDice: number[] = [],
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("action", { actionIndex, usedDice }, context);
  }

  /**
   * Send chooseActive response
   */
  async chooseActive(
    characterId: number,
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("chooseActive", { characterId }, context);
  }

  /**
   * Send rerollDice response
   */
  async rerollDice(
    diceToReroll: number[],
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("rerollDice", { diceToReroll }, context);
  }

  /**
   * Send switchHands response
   */
  async switchHands(
    removedHandIds: number[],
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("switchHands", { removedHandIds }, context);
  }

  /**
   * Send selectCard response
   */
  async selectCard(
    selectedDefinitionId: number,
    context?: StandaloneCommandContext
  ): Promise<StandaloneRpcResponse> {
    return this.postRpcCommand("selectCard", { selectedDefinitionId }, context);
  }
}

// Singleton instance
let clientInstance: StandaloneMcpClient | null = null;

export function getStandaloneMcpClient(baseUrl?: string): StandaloneMcpClient {
  if (!clientInstance) {
    clientInstance = new StandaloneMcpClient(baseUrl);
  }
  return clientInstance;
}

export function resetStandaloneMcpClient(): void {
  clientInstance = null;
}
