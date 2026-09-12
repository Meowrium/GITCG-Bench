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

import type {
  StandaloneStatus,
  StandaloneGameState,
  StandaloneActionEffectsResponse,
  StandaloneDeckInfo,
  StandaloneRpcResponse,
  StandaloneCommandContext,
  WaitForMyTurnResult,
} from "../StandaloneMcpClient";
import {
  getMcpBridgeStatus,
  getPendingMcpCommand,
  setPendingMcpCommand,
  resolvePendingMcpCommand,
  getActionEffects,
  clearActionEffects,
  getSnapshot,
  type Who,
  type PendingMcpCommand,
} from "../../../standalone/src/mcpState";

type Who0or1 = 0 | 1;

const STATUS_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

export class MemoryStandaloneMcpClient {
  private who: Who0or1;

  constructor(who: Who0or1 = 0) {
    this.who = who;
  }

  getWho(): Who0or1 {
    return this.who;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async getStatus(): Promise<StandaloneStatus> {
    const bridge = getMcpBridgeStatus(this.who as Who);
    const snapshot = bridge.snapshot;
    return {
      hasPendingRpc: snapshot.hasPendingRpc,
      pendingMethod: snapshot.pendingMethod,
      pendingRequest: snapshot.pendingRequest,
      gamePhase: snapshot.gamePhase,
      currentPlayer: snapshot.currentPlayer,
      gameOver: snapshot.gameOver,
      winner: snapshot.winner,
    } as StandaloneStatus;
  }

  async getGameState(): Promise<StandaloneGameState> {
    const snapshot = getSnapshot(this.who as Who);
    return snapshot.state as StandaloneGameState;
  }

  async getScreenState(): Promise<StandaloneGameState> {
    const snapshot = getSnapshot(this.who as Who);
    return snapshot.screen as StandaloneGameState;
  }

  async getAvailableCommands(): Promise<{
    available_tools: Array<{ tool: string; description: string }>;
    has_pending_rpc: boolean;
  }> {
    const bridge = getMcpBridgeStatus(this.who as Who);
    const snapshot = bridge.snapshot;
    const availableTools: Array<{ tool: string; description: string }> = [
      { tool: "wait_for_my_turn", description: "Wait (blocking) until it's your turn to act" },
    ];
    if (snapshot.hasPendingRpc && snapshot.pendingMethod) {
      switch (snapshot.pendingMethod) {
        case "action":
          availableTools.push({ tool: "choose_action", description: "Choose an action from available options" });
          break;
        case "chooseActive":
          availableTools.push({ tool: "choose_active", description: "Choose active character" });
          break;
        case "rerollDice":
          availableTools.push({ tool: "reroll_dice", description: "Reroll selected dice" });
          break;
        case "switchHands":
          availableTools.push({ tool: "switch_hands", description: "Switch initial hand cards" });
          break;
        case "selectCard":
          availableTools.push({ tool: "select_card", description: "Select a card" });
          break;
      }
    }
    return {
      available_tools: availableTools,
      has_pending_rpc: snapshot.hasPendingRpc,
    };
  }

  async getActionEffects(): Promise<StandaloneActionEffectsResponse> {
    const effects = getActionEffects(this.who as Who);
    clearActionEffects(this.who as Who);
    return { who: this.who, effects };
  }

  private async getDeck(path: "deck0" | "deck1"): Promise<StandaloneDeckInfo> {
    const targetWho: Who = path === "deck0" ? 0 : 1;
    const snapshot = getSnapshot(targetWho);
    const deckInfoAny = (snapshot as any).deckInfo;
    const players = deckInfoAny?.players;
    if (!Array.isArray(players) || !players[targetWho]) {
      throw new Error("Deck info not available");
    }
    return players[targetWho] as StandaloneDeckInfo;
  }

  async getDeck0(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck0");
  }

  async getDeck1(): Promise<StandaloneDeckInfo> {
    return this.getDeck("deck1");
  }

  async waitForMyTurn(
    pollIntervalMs: number = STATUS_POLL_INTERVAL_MS,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<WaitForMyTurnResult> {
    const startedAt = Date.now();
    while (true) {
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        throw new Error(`waitForMyTurn timed out after ${timeoutMs}ms for player ${this.who}`);
      }
      const status = await this.getStatus();
      if (status.hasPendingRpc) {
        let actionEffects: unknown[] = [];
        try {
          const effectsResponse = await this.getActionEffects();
          actionEffects = effectsResponse.effects;
        } catch {
          // Non-fatal
        }
        return { status, actionEffects };
      }
      const isGameOverPhase =
        status.gamePhase === "finished" ||
        status.gamePhase === "terminated" ||
        status.gamePhase === "gameEnd" ||
        status.gamePhase === "5";
      if (status.gameOver === true || isGameOverPhase) {
        const winner = status.winner ?? null;
        const err = new Error(
          `Game ended while waiting for turn (player ${this.who}). ${winner === this.who ? "You won" : winner === null ? "Winner unknown" : "You lost"}. winner=${winner === null ? "null" : winner}`,
        ) as Error & { game_over?: boolean; winner?: number | null };
        err.game_over = true;
        err.winner = winner;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async isMyTurn(): Promise<boolean> {
    try {
      const status = await this.getStatus();
      return status.hasPendingRpc;
    } catch {
      return false;
    }
  }

  private createIdempotencyKey(method: string, payload: unknown): string {
    const payloadText = (() => {
      try { return JSON.stringify(payload); } catch { return String(payload); }
    })();
    return `${method}:${payloadText}`;
  }

  private queueCommand(
    method: string,
    payload: unknown,
    context?: StandaloneCommandContext,
  ): StandaloneRpcResponse {
    const idempotencyKey =
      context?.idempotencyKey ??
      this.createIdempotencyKey(method, payload);
    const queued = setPendingMcpCommand(this.who as Who, method, payload, idempotencyKey);
    return {
      success: queued.ok,
      message: queued.ok
        ? queued.alreadyResolved ? "Already resolved (idempotent)"
        : queued.idempotentHit ? "Already queued (idempotent)"
        : "Queued"
        : queued.reason,
      commandId: queued.command?.id ?? null,
      idempotencyKey,
      idempotentHit: !!queued.idempotentHit,
      alreadyResolved: !!queued.alreadyResolved,
      lastCommandResult: queued.lastResult ?? null,
    } as StandaloneRpcResponse;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async chooseAction(
    actionIndex: number,
    usedDice: number[] = [],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    const payload: Record<string, unknown> = { chosenActionIndex: actionIndex - 1, usedDice };
    if (context?.explanation) {
      payload.explanation = context.explanation;
    }
    const skipPolling = context?.skipStatePoll === true;
    if (!skipPolling) {
      const before = await this.getStatus().catch(() => null);
      const result = this.queueCommand("action", payload, context);
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
            return result;
          }
        }
        return {
          ...result,
          success: false,
          error: "State did not advance after command (engine may be stuck — retry with fresh idempotency key)",
        };
      }
      return result;
    }
    return this.queueCommand("action", payload, context);
  }

  async chooseActive(
    activeCharacterId: number,
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.queueCommand("chooseActive", { activeCharacterId }, context);
  }

  async rerollDice(
    diceToReroll: number[],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.queueCommand("rerollDice", { diceToReroll }, context);
  }

  async switchHands(
    removedHandIds: number[],
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.queueCommand("switchHands", { removedHandIds }, context);
  }

  async selectCard(
    selectedDefinitionId: number,
    context?: StandaloneCommandContext,
  ): Promise<StandaloneRpcResponse> {
    return this.queueCommand("selectCard", { selectedDefinitionId }, context);
  }
}
