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

import getData from "@gi-tcg/data";
import {
  Game,
  exposeState,
  serializeGameStateLog,
  type GameState,
  type GameStateLogEntry,
  type Mutation,
  type Version,
  CURRENT_VERSION,
  type CancellablePlayerIO,
} from "@gi-tcg/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Action } from "@gi-tcg/typings";
import { AIClientPlayerIO, GameStateListener } from "../index";
import {
  updateMcpBridgeSnapshot,
  setPendingMcpCommand,
  getPendingMcpCommand,
  resolvePendingMcpCommand,
  markGameOver,
  resetMcpBridgeForNewGame,
  recordMcpIoError,
  getActionEffects,
  clearActionEffects,
  type McpBridgeSnapshot,
  type Who,
} from "../../../standalone/src/mcpState";
import {
  validatePendingActionPayload,
  validatePendingSelectCardPayload,
} from "../../../standalone/src/mcpCommandGuards";
import {
  McpActionEffectTracker,
  type ActionEffectV1,
} from "../../../standalone/src/mcpActionEffects";
import { AssetsManager, DEFAULT_ASSETS_MANAGER, getNameSync } from "@gi-tcg/assets-manager";

type PlayerType = "user" | "ai";

interface DeckInfoPlayer {
  who: Who;
  deck_code: string;
  characters: Array<{ definition_id: number; name: string | null }>;
  cards: Array<{ definition_id: number; name: string | null; count: number }>;
  total_cards: number;
}

type PendingBridgeCommand = {
  id: string;
  who?: Who;
  method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard";
  payload: unknown;
};

const MCP_SYNC_INTERVAL_MS = 1200;
const MCP_COMMAND_POLL_INTERVAL_MS = 300;

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item));
}

function validateBridgePayload(
  method: PendingBridgeCommand["method"],
  payload: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "Payload must be an object" };
  }
  const record = payload as Record<string, unknown>;
  switch (method) {
    case "action": {
      if (!Number.isInteger(record.chosenActionIndex) || (record.chosenActionIndex as number) < 0)
        return { ok: false, reason: "Invalid action payload: chosenActionIndex must be a non-negative integer" };
      if (!isIntegerArray(record.usedDice ?? []))
        return { ok: false, reason: "Invalid action payload: usedDice must be an integer array" };
      return { ok: true };
    }
    case "chooseActive": {
      if (!Number.isInteger(record.activeCharacterId))
        return { ok: false, reason: "Invalid chooseActive payload: activeCharacterId must be an integer" };
      return { ok: true };
    }
    case "rerollDice": {
      if (!isIntegerArray(record.diceToReroll ?? []))
        return { ok: false, reason: "Invalid rerollDice payload: diceToReroll must be an integer array" };
      return { ok: true };
    }
    case "switchHands": {
      if (!isIntegerArray(record.removedHandIds ?? []))
        return { ok: false, reason: "Invalid switchHands payload: removedHandIds must be an integer array" };
      return { ok: true };
    }
    case "selectCard": {
      if (!Number.isInteger(record.selectedDefinitionId))
        return { ok: false, reason: "Invalid selectCard payload: selectedDefinitionId must be an integer" };
      return { ok: true };
    }
  }
  return { ok: false, reason: "Unknown method" };
}

function toRpcResponseEnvelope(
  method: PendingBridgeCommand["method"],
  payload: unknown,
) {
  return {
    response: {
      $case: method,
      value: payload,
    },
  };
}

function formatAiCommand(
  method: PendingBridgeCommand["method"],
  payload: unknown,
  pendingRequest: unknown,
): string {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  switch (method) {
    case "action": {
      const chosenActionIndex = Number(record.chosenActionIndex);
      const request =
        pendingRequest && typeof pendingRequest === "object"
          ? (pendingRequest as Record<string, unknown>)
          : null;
      const actions = Array.isArray(
        (request?.value as Record<string, unknown> | undefined)?.action,
      )
        ? (request!.value as { action: Action[] }).action
        : [];
      const action = actions[chosenActionIndex];
      if (!action) return `Action #${chosenActionIndex + 1}`;
      const actionType = action.action?.$case;
      switch (actionType) {
        case "useSkill": {
          const name =
            getNameSync(action.action.value.skillDefinitionId) ??
            `Skill${action.action.value.skillDefinitionId}`;
          return `Use ${name}`;
        }
        case "playCard": {
          const name =
            getNameSync(action.action.value.cardDefinitionId) ??
            `Card${action.action.value.cardDefinitionId}`;
          return `Play ${name}`;
        }
        case "switchActive": {
          const name =
            getNameSync(action.action.value.characterDefinitionId) ??
            `Char${action.action.value.characterDefinitionId}`;
          return `Switch to ${name}`;
        }
        case "elementalTuning":
          return "Elemental Tuning";
        case "declareEnd":
          return "Declare End";
        default:
          return `Action #${chosenActionIndex + 1}`;
      }
    }
    case "chooseActive": {
      const id = Number(record.activeCharacterId);
      return `Choose active (ID=${id})`;
    }
    case "rerollDice": {
      const dice = Array.isArray(record.diceToReroll) ? (record.diceToReroll as number[]) : [];
      return `Reroll ${dice.length} dice`;
    }
    case "switchHands": {
      const ids = Array.isArray(record.removedHandIds) ? (record.removedHandIds as number[]) : [];
      return `Switch ${ids.length} cards`;
    }
    case "selectCard": {
      const defId = Number(record.selectedDefinitionId);
      const name = getNameSync(defId) ?? `Card${defId}`;
      return `Select ${name}`;
    }
    default:
      return method;
  }
}

export interface HeadlessGameRunnerOptions {
  deck0: string;
  deck1: string;
  version?: Version;
  player0Type?: PlayerType;
  player1Type?: PlayerType;
}

export class HeadlessGameRunner {
  private game: Game | null = null;
  private aiPlayerIos: Record<Who, AIClientPlayerIO | null> = { 0: null, 1: null };
  private stateListener = GameStateListener.getInstance();
  private effectTracker: McpActionEffectTracker;
  private bridgeDeckInfoCache: { players: [DeckInfoPlayer, DeckInfoPlayer] } | null = null;
  private commandPollTimers: NodeJS.Timeout[] = [];
  private snapshotSyncTimer: NodeJS.Timeout | null = null;
  private aiDecisionLogs: Array<{ who: Who; text: string; time: number; reasoning?: string }> = [];
  private stateLog: GameStateLogEntry[] = [];
  private gameEnded = false;
  private readonly assetsManager: AssetsManager;

  constructor(private options: HeadlessGameRunnerOptions) {
    this.assetsManager = options.version
      ? new AssetsManager({ version: options.version })
      : DEFAULT_ASSETS_MANAGER;
    this.effectTracker = new McpActionEffectTracker(
      (id) => this.assetsManager.getNameSync(id) ?? null,
    );
  }

  private get p0isAi(): boolean {
    return (this.options.player0Type ?? "ai") === "ai";
  }
  private get p1isAi(): boolean {
    return (this.options.player1Type ?? "ai") === "ai";
  }
  private aiPlayers(): Who[] {
    const result: Who[] = [];
    if (this.p0isAi) result.push(0);
    if (this.p1isAi) result.push(1);
    return result;
  }

  private createDeckInfoPlayer(who: Who, deckCode: string): DeckInfoPlayer {
    const deck = DEFAULT_ASSETS_MANAGER.decode(deckCode);
    const cardCounter = new Map<number, number>();
    for (const defId of deck.cards) cardCounter.set(defId, (cardCounter.get(defId) ?? 0) + 1);
    return {
      who,
      deck_code: deckCode,
      characters: deck.characters.map((did) => ({ definition_id: did, name: getNameSync(did) ?? null })),
      cards: [...cardCounter.entries()].map(([did, count]) => ({ definition_id: did, name: getNameSync(did) ?? null, count })),
      total_cards: deck.cards.length,
    };
  }

  private getDeckInfo() {
    if (this.bridgeDeckInfoCache) return this.bridgeDeckInfoCache;
    try {
      this.bridgeDeckInfoCache = {
        players: [
          this.createDeckInfoPlayer(0, this.options.deck0),
          this.createDeckInfoPlayer(1, this.options.deck1),
        ],
      };
    } catch (e) {
      console.warn("Failed to build deck info", e);
    }
    return this.bridgeDeckInfoCache;
  }

  private buildBridgeSnapshot(who: Who, extraEffects?: readonly ActionEffectV1[]) {
    const aiIo = this.aiPlayerIos[who];
    const pendingRpc = aiIo?.getPendingRpc() ?? null;
    const pendingMethod = aiIo?.getPendingMethod() ?? null;
    const latestState = this.stateListener.getLastState();
    const exposed = latestState ? exposeState(who, latestState) : null;

    const latestNotification = aiIo?.getLatestNotification() ?? null;
    const notificationState = latestNotification?.state ?? null;
    const effectiveExposed = (pendingRpc && notificationState) ? notificationState : exposed;

    let stateForBridge: any = effectiveExposed;
    let screenForBridge: any = effectiveExposed;
    if (effectiveExposed && Array.isArray(effectiveExposed.player)) {
      const players = effectiveExposed.player;
      stateForBridge = { ...effectiveExposed, player: players[who] ?? null, players };
      screenForBridge = { ...effectiveExposed, player: players[who] ?? null, players };
    }

    const isGameEndPhase = !!latestState && latestState.phase === "gameEnd";
    const winnerValue =
      isGameEndPhase && latestState
        ? (latestState.winner === 0 || latestState.winner === 1
          ? latestState.winner
          : null)
        : null;

    return {
      who,
      hasPendingRpc: !!pendingRpc,
      pendingMethod,
      pendingRequest: pendingRpc?.request?.request ?? null,
      gamePhase: effectiveExposed ? String(effectiveExposed.phase) : this.game ? "running" : "not_started",
      gameOver: isGameEndPhase,
      winner: winnerValue,
      currentPlayer: effectiveExposed?.currentTurn ?? -1,
      round: effectiveExposed?.roundNumber ?? 0,
      state: stateForBridge,
      screen: screenForBridge,
      deckInfo: this.getDeckInfo(),
      actionEffects: extraEffects ?? [],
    };
  }

  private syncBridgeSnapshot(who: Who, pendingEffects?: readonly ActionEffectV1[]) {
    if (!this.aiPlayerIos[who]) return;
    try {
      const snapshot = this.buildBridgeSnapshot(who, pendingEffects);
      updateMcpBridgeSnapshot(who, snapshot);
    } catch (e) {
      console.warn(`[Headless] Failed to sync snapshot for player ${who}`, e);
    }
  }

  private reportCommandResult(who: Who, id: string, success: boolean, message?: string) {
    resolvePendingMcpCommand(id, success, message);
  }

  private pushGameOverSignal(who: Who, winner: number | null) {
    if (!this.aiPlayerIos[who]) return;
    try {
      markGameOver(who, winner);
    } catch (e) {
      console.warn(`[Headless] Failed to push game-over signal for player ${who}`, e);
    }
  }

  private pollNextCommand = async (who: Who) => {
    const aiIo = this.aiPlayerIos[who];
    if (!aiIo) return;

    try {
      const command = getPendingMcpCommand(who);
      if (!command) return;

      const pendingMethod = aiIo.getPendingMethod();
      if (!pendingMethod) {
        this.reportCommandResult(who, command.id, false, "No pending RPC in AI player IO");
        return;
      }
      const pendingRequest = aiIo.getPendingRpc()?.request?.request ?? null;
      if (command.method !== pendingMethod) {
        this.reportCommandResult(who, command.id, false,
          `Pending RPC is '${pendingMethod}', command is '${command.method}'`);
        return;
      }

      const payloadValidation = validateBridgePayload(command.method, command.payload);
      if (!payloadValidation.ok) {
        this.reportCommandResult(who, command.id, false, payloadValidation.reason);
        return;
      }

      if (command.method === "action") {
        const actionValidation = validatePendingActionPayload(pendingRequest, command.payload);
        if (!actionValidation.ok) {
          this.reportCommandResult(who, command.id, false, "stale action payload");
          return;
        }
      }
      if (command.method === "selectCard") {
        const selectCardValidation = validatePendingSelectCardPayload(pendingRequest, command.payload);
        if (!selectCardValidation.ok) {
          this.reportCommandResult(who, command.id, false, "stale selectCard payload");
          return;
        }
      }

      const pendingRequestForLog = aiIo.getPendingRpc()?.request?.request ?? null;

      const applied = aiIo.respondToRpc(toRpcResponseEnvelope(command.method, command.payload) as any);
      if (!applied) {
        this.reportCommandResult(who, command.id, false, "Failed to apply command payload");
        return;
      }

      const logText = formatAiCommand(command.method, command.payload, pendingRequestForLog);
      const reasoning = typeof (command.payload as any)?.explanation === "string"
        ? (command.payload as any).explanation
        : undefined;
      this.aiDecisionLogs.push({ who, text: logText, time: Date.now(), reasoning });
      if (this.aiDecisionLogs.length > 40) this.aiDecisionLogs = this.aiDecisionLogs.slice(-40);
      console.log(`[Headless] P${who}: ${logText}`);

      this.stateListener.registerCommandExecution();
      this.reportCommandResult(who, command.id, true, "Command applied");
      this.syncBridgeSnapshot(who);
    } catch (e) {
      console.warn(`[Headless] Failed to poll command for player ${who}`, e);
    }
  };

  private pause = async (state: GameState, mutations: unknown, canResume: boolean) => {
    this.stateLog.push({ state, canResume });
    const typedMutations = Array.isArray(mutations) ? (mutations as Mutation[]) : [];
    this.effectTracker.feed(typedMutations, canResume, state.phase, state.roundNumber, state.currentTurn);
    this.stateListener.onPause(state, typedMutations, canResume);
    const pendingEffects = this.effectTracker.takeSegments();

    for (const who of this.aiPlayers()) {
      this.syncBridgeSnapshot(who, pendingEffects);
    }

    if (state.phase === "gameEnd") {
      const winner = state.winner === 0 || state.winner === 1 ? state.winner : null;
      for (const who of this.aiPlayers()) {
        this.pushGameOverSignal(who, winner);
      }
      this.gameEnded = true;
      this.exportGameLog();
      console.log(`[Headless] Game over! Winner: ${winner === null ? "draw" : `Player ${winner}`}`);
    }
  };

  private onGameError = (e: unknown, from?: Game) => {
    if (!from || from === this.game) {
      console.error("[Headless] Game error:", e);
    }
  };

  private createGame(state?: GameState): Game {
    if (!state) {
      const version = this.options.version ?? CURRENT_VERSION;
      const deck0 = this.assetsManager.decode(this.options.deck0);
      const deck1 = this.assetsManager.decode(this.options.deck1);
      state = Game.createInitialState({
        decks: [deck0, deck1],
        data: getData(version),
        versionBehavior: version,
      });
    }
    const currentGame = new Game(state);
    currentGame.onPause = this.pause;
    currentGame.onIoError = (e) => {
      const pendingMethod = this.aiPlayerIos[e.who ?? 0]?.getPendingMethod() ?? null;
      recordMcpIoError(e.who ?? 0, {
        who: e.who,
        message: e.message || "Unknown IoError",
        phase: currentGame.state?.phase ?? null,
        pendingMethod,
      });
      console.error("[Headless][IoError]", { who: e.who, message: e.message, phase: currentGame.state?.phase, pendingMethod });
    };

    this.stateListener.reset();
    resetMcpBridgeForNewGame();

    for (const who of [0, 1] as Who[]) {
      const isAi = (who === 0 ? this.p0isAi : this.p1isAi);
      if (isAi) {
        const aiIo = new AIClientPlayerIO();
        const origRpc = aiIo.rpc.bind(aiIo);
        aiIo.rpc = async (request) => {
          const promise = origRpc(request);
          this.syncBridgeSnapshot(who);
          return promise;
        };
        this.aiPlayerIos[who] = aiIo;
        currentGame.players[who].io = aiIo;
      } else {
        this.aiPlayerIos[who] = null;
        // In headless mode, human players use a no-op IO that blocks forever.
        currentGame.players[who].io = {
          notify: () => {},
          rpc: () => new Promise(() => {}),
        } as CancellablePlayerIO;
      }
    }

    return currentGame;
  }

  async start(): Promise<void> {
    const initialGame = this.createGame();
    this.game = initialGame;

    for (const who of this.aiPlayers()) {
      this.syncBridgeSnapshot(who);
    }

    for (const who of this.aiPlayers()) {
      this.commandPollTimers.push(
        setInterval(() => this.pollNextCommand(who).catch(console.error), MCP_COMMAND_POLL_INTERVAL_MS),
      );
    }
    this.snapshotSyncTimer = setInterval(() => {
      for (const who of this.aiPlayers()) {
        this.syncBridgeSnapshot(who);
      }
    }, MCP_SYNC_INTERVAL_MS);

    initialGame.start().catch((e) => this.onGameError(e, initialGame));
    console.log(`[Headless] Game started. P0=${this.p0isAi ? "AI" : "Human"}, P1=${this.p1isAi ? "AI" : "Human"}`);
  }

  stop(): void {
    for (const t of this.commandPollTimers) clearInterval(t);
    if (this.snapshotSyncTimer) clearInterval(this.snapshotSyncTimer);
    this.commandPollTimers = [];
    this.snapshotSyncTimer = null;
    if (!this.gameEnded) {
      this.exportGameLog();
    }
    this.game?.terminate();
    console.log("[Headless] Game stopped.");
  }

  getDecisionLogs(): Array<{ who: Who; text: string; time: number; reasoning?: string }> {
    return [...this.aiDecisionLogs];
  }

  private exportGameLog(): void {
    if (this.stateLog.length === 0) return;
    try {
      const logs = serializeGameStateLog(this.stateLog);
      const payload = {
        ...logs,
        gv: this.options.version ?? CURRENT_VERSION,
        decision_logs: this.aiDecisionLogs.map((d) => ({
          who: d.who,
          action: d.text,
          reasoning: d.reasoning,
          time: d.time,
        })),
      };
      const dir = resolve(process.cwd(), "headless-logs");
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `game_${ts}.json`;
      const filepath = join(dir, filename);
      writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf-8");
      console.log(`[Headless] Game log exported: ${filepath}`);
    } catch (e) {
      console.warn("[Headless] Failed to export game log:", e);
    }
  }
}
