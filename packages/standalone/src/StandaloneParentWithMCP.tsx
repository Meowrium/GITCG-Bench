// Copyright (C) 2024-2025 Guyutongxue
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
  CancellablePlayerIO,
  DetailLogEntry,
  Game,
  GameState,
  GameStateLogEntry,
  Mutation,
  Version,
  exposeState,
  serializeGameStateLog,
} from "@gi-tcg/core";
import type { Action } from "@gi-tcg/typings";
import { createClient, StandaloneChessboard } from "@gi-tcg/web-ui-core";
import "@gi-tcg/web-ui-core/style.css";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { DetailLogViewer } from "@gi-tcg/detail-log-viewer";
import { DEFAULT_ASSETS_MANAGER, getNameSync } from "@gi-tcg/assets-manager";
import { AIClientPlayerIO, GameStateListener } from "@gi-tcg/mcp";
import { LOCAL_ASSETS_MANAGER } from "./localAssetsManager";
import {
  validatePendingActionPayload,
  validatePendingSelectCardPayload,
} from "./mcpCommandGuards";
import {
  McpActionEffectTracker,
  type ActionEffectV1,
} from "./mcpActionEffects";

type AiDecisionLog = {
  who: 0 | 1;
  text: string;
  time: number;
};

const formatAiCommand = (
  method: PendingBridgeCommand["method"],
  payload: unknown,
  pendingRequest: unknown,
): string => {
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
      if (!action) return `执行动作 #${chosenActionIndex + 1}`;
      const actionType = action.action?.$case;
      switch (actionType) {
        case "useSkill": {
          const name =
            getNameSync(action.action.value.skillDefinitionId) ??
            `技能${action.action.value.skillDefinitionId}`;
          return `使用技能「${name}」`;
        }
        case "playCard": {
          const name =
            getNameSync(action.action.value.cardDefinitionId) ??
            `卡牌${action.action.value.cardDefinitionId}`;
          return `打出「${name}」`;
        }
        case "switchActive": {
          const name =
            getNameSync(action.action.value.characterDefinitionId) ??
            `角色${action.action.value.characterDefinitionId}`;
          return `切换「${name}」`;
        }
        case "elementalTuning":
          return "元素调和";
        case "declareEnd":
          return "宣布结束";
        default:
          return `执行动作 #${chosenActionIndex + 1}`;
      }
    }
    case "chooseActive": {
      const activeCharacterId = Number(record.activeCharacterId);
      return `选择出战角色 (ID=${activeCharacterId})`;
    }
    case "rerollDice": {
      const diceToReroll = Array.isArray(record.diceToReroll)
        ? (record.diceToReroll as number[])
        : [];
      return `重掷 ${diceToReroll.length} 个骰子`;
    }
    case "switchHands": {
      const removedHandIds = Array.isArray(record.removedHandIds)
        ? (record.removedHandIds as number[])
        : [];
      return `换牌 (弃 ${removedHandIds.length} 张)`;
    }
    case "selectCard": {
      const selectedDefinitionId = Number(record.selectedDefinitionId);
      const name =
        getNameSync(selectedDefinitionId) ?? `卡牌${selectedDefinitionId}`;
      return `选择「${name}」`;
    }
    default:
      return method;
  }
};

export interface StandaloneParentWithMCPProps {
  logs?: GameStateLogEntry[];
  deck0: string;
  deck1: string;
  version: Version;
  enableMCP?: boolean;
  player0Type?: "user" | "ai";
  player1Type?: "user" | "ai";
}

type PendingBridgeCommand = {
  id: string;
  who?: 0 | 1;
  method: "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard";
  payload: unknown;
};

type Who = 0 | 1;

const isIntegerArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

const validateBridgePayload = (
  method: PendingBridgeCommand["method"],
  payload: unknown,
): { ok: true } | { ok: false; reason: string } => {
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
      if (typeof record.candidateId !== "undefined" && typeof record.candidateId !== "string")
        return { ok: false, reason: "Invalid action payload: candidateId must be a string" };
      if (typeof record.candidateSignature !== "undefined" && typeof record.candidateSignature !== "string")
        return { ok: false, reason: "Invalid action payload: candidateSignature must be a string" };
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
      if (typeof record.candidateId !== "undefined" && typeof record.candidateId !== "string")
        return { ok: false, reason: "Invalid selectCard payload: candidateId must be a string" };
      if (typeof record.candidateSignature !== "undefined" && typeof record.candidateSignature !== "string")
        return { ok: false, reason: "Invalid selectCard payload: candidateSignature must be a string" };
      return { ok: true };
    }
  }
};

const toRpcResponseEnvelope = (
  method: PendingBridgeCommand["method"],
  payload: unknown,
) => ({
  response: {
    $case: method,
    value: payload,
  },
});

type DeckInfoPlayer = {
  who: 0 | 1;
  deck_code: string;
  characters: Array<{ definition_id: number; name: string | null }>;
  cards: Array<{ definition_id: number; name: string | null; count: number }>;
  total_cards: number;
};

const CHILD_WHO = 0;
const MCP_SYNC_INTERVAL_MS = 1200;
const MCP_COMMAND_POLL_INTERVAL_MS = 300;

export function StandaloneParentWithMCP(props: StandaloneParentWithMCPProps) {
  const mcpEnabled = () => !!props.enableMCP;
  const player0Type = () => props.player0Type ?? "user";
  const player1Type = () => props.player1Type ?? "user";
  const p0isAi = () => player0Type() === "ai";
  const p1isAi = () => player1Type() === "ai";
  const bothAi = () => p0isAi() && p1isAi();
  const aiPlayers = (): Who[] => {
    const result: Who[] = [];
    if (p0isAi()) result.push(0);
    if (p1isAi()) result.push(1);
    return result;
  };

  const humanWho = (): Who => (p1isAi() && !p0isAi() ? 0 : 1);

  const [aiLogs, setAiLogs] = createSignal<AiDecisionLog[]>([]);

  const [uiIo, Chessboard] = createClient(humanWho(), {
    assetsManager: () => LOCAL_ASSETS_MANAGER,
    onGiveUp: () => game?.giveUp(humanWho()),
  });

  const [popupWindow, setPopupWindow] = createSignal<Window | null>(null);

  const showPopup = async () => {
    if (popupWindow() !== null) return;
    const newWindow = window.open(
      window.location.href, "_blank",
      "popup=yes, depended=yes, height=750, width=750",
    );
    setPopupWindow(newWindow);
    const autoGiveupInterval = window.setInterval(() => {
      if (newWindow?.closed && autoGiveupInterval !== null) {
        window.clearInterval(autoGiveupInterval);
        game?.giveUp(CHILD_WHO);
        setPopupWindow(null);
      }
    }, 1000);
    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const { data } = e;
        if (typeof data !== "object" || data === null) return;
        if (data.giTcg !== "1.0") return;
        if (!("method" in data)) return;
        if (data.method === "initialized") {
          window?.removeEventListener("message", handler);
          resolve();
        }
      };
      window?.addEventListener("message", handler);
    });
  };

  const childIo: CancellablePlayerIO = {
    notify: (...params) => popupWindow()?.postMessage({ giTcg: "1.0", method: "notify", params }),
    rpc: async (...params): Promise<any> => {
      const id = Math.random().toString(36).slice(2);
      const result = new Promise((resolve) => {
        const handler = (e: MessageEvent) => {
          const { data } = e;
          if (typeof data !== "object" || data === null) return;
          if (data.giTcg !== "1.0") return;
          if (!("method" in data)) return;
          if (data.method === "rpc" && data.id === id) {
            window?.removeEventListener("message", handler);
            resolve(data.result);
          }
        };
        window?.addEventListener("message", handler);
      });
      popupWindow()?.postMessage({ giTcg: "1.0", method: "rpc", params, id });
      return result;
    },
    cancelRpc: () => popupWindow()?.postMessage({ giTcg: "1.0", method: "cancelRpc" }),
  };

  const [stateLog, setStateLog] = createSignal<GameStateLogEntry[]>([]);
  const [fromImport, setFromImport] = createSignal(false);
  const [viewingLogIndex, setViewingLogIndex] = createSignal<number>(-1);
  const [viewingWho, setViewingWho] = createSignal<Who>(1);
  const viewingState = (): GameStateLogEntry | undefined => stateLog()[viewingLogIndex()];
  const enableLog = () => { setViewingWho(1); setViewingLogIndex(stateLog().length - 2); };
  const maxLogIndex = () => stateLog().length - (fromImport() ? 1 : 2);

  const exportLog = () => {
    const logs = serializeGameStateLog(stateLog());
    const blob = new Blob([JSON.stringify({ ...logs, gv: props.version })], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gameLog.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  let game: Game | null = null;
  const aiPlayerIos: Record<Who, AIClientPlayerIO | null> = { 0: null, 1: null };
  const stateListener = GameStateListener.getInstance();
  const effectTracker = new McpActionEffectTracker(
    (id) => DEFAULT_ASSETS_MANAGER.getNameSync(id) ?? null,
  );
  let bridgeDeckInfoCache: { players: [DeckInfoPlayer, DeckInfoPlayer] } | null = null;
  let commandPollTimers: ReturnType<typeof setInterval>[] = [];
  let snapshotSyncTimers: ReturnType<typeof setInterval>[] = [];
  const createDeckInfoPlayer = (who: Who, deckCode: string): DeckInfoPlayer => {
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
  };

  const getDeckInfo = () => {
    if (bridgeDeckInfoCache) return bridgeDeckInfoCache;
    try {
      bridgeDeckInfoCache = {
        players: [createDeckInfoPlayer(0, props.deck0), createDeckInfoPlayer(1, props.deck1)],
      };
    } catch (e) {
      console.warn("Failed to build MCP deck info", e);
      bridgeDeckInfoCache = null;
    }
    return bridgeDeckInfoCache;
  };

  const postBridgeJson = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
    return response.json() as Promise<any>;
  };

  // Build a bridge snapshot for a specific AI player, exposing only that player's perspective
  const buildBridgeSnapshot = (who: Who, extraEffects?: readonly ActionEffectV1[]) => {
    const aiIo = aiPlayerIos[who];
    const pendingRpc = aiIo?.getPendingRpc() ?? null;
    const pendingMethod = aiIo?.getPendingMethod() ?? null;
    const latestState = stateListener.getLastState();
    const exposed = latestState ? exposeState(who, latestState) : null;

    const latestNotification = aiIo?.getLatestNotification() ?? null;
    const notificationState = latestNotification?.state ?? null;
    const effectiveExposed = (pendingRpc && notificationState) ? notificationState : exposed;

    // Extract this player's data from the PbGameState.player array.
    // PbGameState.player is PlayerState[] (two players), but MCP tools
    // access screen.player.handCard / dice / character as a singular object.
    // Transform: { player: [p0, p1], ... } → { player: p_who, players: [p0, p1], ... }
    let stateForBridge: any = effectiveExposed;
    let screenForBridge: any = effectiveExposed;
    if (effectiveExposed && Array.isArray(effectiveExposed.player)) {
      const players = effectiveExposed.player;
      stateForBridge = { ...effectiveExposed, player: players[who] ?? null, players };
      screenForBridge = { ...effectiveExposed, player: players[who] ?? null, players };
    }

    // Derive explicit game-over signal from the underlying Game state.
    // `exposed.phase` is the protobuf PbPhaseType enum (GAME_END = 5), while
    // `latestState.phase` is the internal string literal "gameEnd". Either
    // marker indicates the game has concluded; the winner lives on
    // `latestState.winner` (0 | 1 | null). We forward both so MCP clients
    // can short-circuit wait_for_my_turn without parsing the enum.
    const isGameEndPhase =
      !!latestState && latestState.phase === "gameEnd";
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
      gamePhase: effectiveExposed ? String(effectiveExposed.phase) : game ? "running" : "not_started",
      gameOver: isGameEndPhase,
      winner: winnerValue,
      currentPlayer: effectiveExposed?.currentTurn ?? -1,
      round: effectiveExposed?.roundNumber ?? 0,
      state: stateForBridge,
      screen: screenForBridge,
      deckInfo: getDeckInfo(),
      actionEffects: extraEffects ?? [],
    };
  };

  const syncBridgeSnapshot = async (who: Who, pendingEffects?: readonly ActionEffectV1[]) => {
    if (!mcpEnabled() || !aiPlayerIos[who]) return;
    try {
      const snapshot = buildBridgeSnapshot(who, pendingEffects);
      await postBridgeJson(`/api/mcp/${who}/sync`, { snapshot });
    } catch (e) {
      console.warn(`[MCP] Failed to sync snapshot for player ${who}`, e);
    }
  };

  const reportCommandResult = async (who: Who, id: string, success: boolean, message?: string) => {
    try {
      await postBridgeJson(`/api/mcp/${who}/command-result`, { id, success, message });
    } catch (e) {
      console.warn(`[MCP] Failed to report command result for player ${who}`, e);
    }
  };

  const reportIoError = async (ioError: { who: number | null; message: string; phase: string | null; pendingMethod: string | null }) => {
    try {
      const targetWho = ioError.who === 0 || ioError.who === 1 ? ioError.who : 0;
      await postBridgeJson(`/api/mcp/${targetWho}/io-error`, ioError);
    } catch (e) {
      console.warn("Failed to report MCP io error", e);
    }
  };

  /**
   * Push an explicit game-over signal to a single AI player's bridge.
   * Called once per AI player when the underlying Game reaches its
   * `gameEnd` phase. This complements the implicit signal embedded in the
   * synced snapshot (gamePhase / winner) by atomically marking the bridge
   * as game-over + attaching the final result, so the AI's next
   * `wait_for_my_turn` poll (or any in-flight action tool) can short-circuit
   * immediately instead of waiting for the 1.2s periodic sync or parsing
   * protobuf phase enum values.
   */
  const pushGameOverSignal = async (who: Who, winner: number | null) => {
    if (!mcpEnabled() || !aiPlayerIos[who]) return;
    try {
      await postBridgeJson(`/api/mcp/${who}/game-over`, { winner });
    } catch (e) {
      console.warn(`[MCP] Failed to push game-over signal for player ${who}`, e);
    }
  };

  const pollNextCommand = async (who: Who) => {
    if (!mcpEnabled()) return;
    const aiIo = aiPlayerIos[who];
    if (!aiIo) return;

    try {
      const response = await fetch(`/api/mcp/${who}/next-command`);
      if (!response.ok) return;
      const payload = (await response.json()) as { command?: PendingBridgeCommand | null };
      const command = payload?.command;
      if (!command || typeof command.id !== "string") return;

      const pendingMethod = aiIo.getPendingMethod();
      if (!pendingMethod) {
        await reportCommandResult(who, command.id, false, "No pending RPC in AI player IO");
        return;
      }
      const pendingRequest = aiIo.getPendingRpc()?.request?.request ?? null;
      if (command.method !== pendingMethod) {
        await reportCommandResult(who, command.id, false,
          `Pending RPC is '${pendingMethod}', command is '${command.method}'`);
        return;
      }

      const payloadValidation = validateBridgePayload(command.method, command.payload);
      if (!payloadValidation.ok) {
        await reportCommandResult(who, command.id, false, payloadValidation.reason);
        return;
      }

      if (command.method === "action") {
        const actionValidation = validatePendingActionPayload(pendingRequest, command.payload);
        if (!actionValidation.ok) {
          await reportCommandResult(who, command.id, false, "stale action payload");
          return;
        }
      }
      if (command.method === "selectCard") {
        const selectCardValidation = validatePendingSelectCardPayload(pendingRequest, command.payload);
        if (!selectCardValidation.ok) {
          await reportCommandResult(who, command.id, false, "stale selectCard payload");
          return;
        }
      }

      const pendingRpcForLog = aiIo.getPendingRpc();
      const pendingRequestForLog = pendingRpcForLog?.request?.request ?? null;

      const applied = aiIo.respondToRpc(toRpcResponseEnvelope(command.method, command.payload) as any);
      if (!applied) {
        await reportCommandResult(who, command.id, false, "Failed to apply command payload");
        return;
      }

      const logText = formatAiCommand(command.method, command.payload, pendingRequestForLog);
      setAiLogs((prev) => [...prev.slice(-19), { who, text: logText, time: Date.now() }]);

      stateListener.registerCommandExecution();
      await reportCommandResult(who, command.id, true, "Command applied");
      await syncBridgeSnapshot(who);
    } catch (e) {
      console.warn(`[MCP] Failed to poll command for player ${who}`, e);
    }
  };

  const disconnectBridge = async () => {
    if (!mcpEnabled()) return;
    for (const who of aiPlayers()) {
      try { await postBridgeJson(`/api/mcp/${who}/disconnect`, {}); } catch (e) { /* ignore */ }
    }
  };

  const pause = async (state: GameState, mutations: unknown, canResume: boolean) => {
    if (game !== null) setStateLog((logs) => [...logs, { state, canResume }]);
    if (mcpEnabled()) {
      const typedMutations = Array.isArray(mutations) ? (mutations as Mutation[]) : [];
      effectTracker.feed(typedMutations, canResume, state.phase, state.roundNumber, state.currentTurn);
      stateListener.onPause(state, typedMutations, canResume);
      const pendingEffects = effectTracker.takeSegments();
      // Sync the regular snapshot for both AI players first — this carries
      // the final board state, phase, and (now) the gameOver/winner fields.
      await Promise.all(aiPlayers().map((who) => syncBridgeSnapshot(who, pendingEffects)));

      // When the game has just ended, additionally push a dedicated
      // game-over signal to both AI players. This is the "direct send"
      // path: it atomically marks each bridge as game-over + attaches the
      // final result, so the AI's polling loop (or any in-flight action
      // tool that re-checks status) receives the end-of-game notification
      // on its very next poll rather than relying on snapshot staleness
      // detection or protobuf phase-enum parsing.
      if (state.phase === "gameEnd") {
        const winner = state.winner === 0 || state.winner === 1 ? state.winner : null;
        await Promise.all(aiPlayers().map((who) => pushGameOverSignal(who, winner)));
      }
    }
  };

  const onGameError = (e: unknown, from?: Game) => {
    if (!from || from === game) {
      console.error(e);
      alert(`游戏出现了内部错误！请点击主窗口下方"导出日志"按钮生成日志文件，并反馈至 GitHub Issue，thanks~\n${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const createGame = (state?: GameState) => {
    if (!state) {
      const deck0 = DEFAULT_ASSETS_MANAGER.decode(props.deck0);
      const deck1 = DEFAULT_ASSETS_MANAGER.decode(props.deck1);
      state = Game.createInitialState({
        decks: [deck0, deck1],
        data: getData(props.version),
        versionBehavior: props.version,
      });
    }
    const currentGame = new Game(state);
    currentGame.onPause = pause;
    currentGame.onIoError = (e) => {
      const pendingMethod = aiPlayerIos[e.who ?? 0]?.getPendingMethod() ?? null;
      void reportIoError({ who: e.who, message: e.message || "Unknown IoError", phase: currentGame.state?.phase ?? null, pendingMethod });
      console.error("[MCP][IoError]", { who: e.who, message: e.message, phase: currentGame.state?.phase, pendingMethod });
    };

    stateListener.reset();

    if (mcpEnabled()) {
      // Assign player IOs based on configuration
      for (const who of [0, 1] as Who[]) {
        const isAi = (who === 0 ? p0isAi() : p1isAi());
        if (isAi) {
          const aiIo = new AIClientPlayerIO();
          // Wrap rpc to immediately sync bridge snapshot when the game engine
          // initiates an RPC. The game engine calls both players' rpc() simultaneously
          // via Promise.all, but onPause has already fired before the RPCs are initiated.
          // Without this sync, the bridge snapshot would only be updated by the periodic
          // timer (1200ms), which can be throttled to 60s in background browser tabs,
          // causing MCP wait_for_my_turn to time out at 15s.
          const origRpc = aiIo.rpc.bind(aiIo);
          aiIo.rpc = async (request) => {
            const promise = origRpc(request);
            // pendingRpc is set synchronously inside the Promise constructor.
            // Await the sync so the bridge snapshot reflects hasPendingRpc=true
            // before wait_for_my_turn polls — avoids a race where the MCP server
            // polls status before the snapshot update completes.
            await syncBridgeSnapshot(who).catch((e) =>
              console.warn(`[MCP] Failed to sync snapshot after rpc for player ${who}`, e),
            );
            return promise;
          };
          aiPlayerIos[who] = aiIo;
          currentGame.players[who].io = aiIo;
          // When both players are AI, the chessboard UI never receives
          // game state updates because uiIo is not connected to any player.
          // Forward notifications from player 1's AI IO to uiIo for display.
          if (who === 1 && bothAi()) {
            const origNotify = aiIo.notify.bind(aiIo);
            aiIo.notify = (notification) => {
              origNotify(notification);
              uiIo.notify(notification);
            };
          }
        } else {
          aiPlayerIos[who] = null;
          // Human player: use childIo for player 0 (popup), uiIo for player 1 (main)
          currentGame.players[who].io = who === 0 ? childIo : uiIo;
        }
      }
    } else {
      aiPlayerIos[0] = null;
      aiPlayerIos[1] = null;
      currentGame.players[0].io = childIo;
      currentGame.players[1].io = uiIo;
    }

    return currentGame;
  };

  const startGame = async () => {
    try {
      if (!mcpEnabled()) await showPopup();
      const initialGame = createGame();
      game = initialGame;
      if (mcpEnabled()) {
        for (const who of aiPlayers()) {
          await syncBridgeSnapshot(who);
        }
      }
      initialGame.start().catch((e) => onGameError(e, initialGame));
    } catch (e) {
      onGameError(e);
    }
  };

  const resumeGame = async () => {
    if (!mcpEnabled()) await showPopup();
    const logs = stateLog().slice(0, viewingLogIndex() + 1);
    childIo.cancelRpc?.();
    uiIo.cancelRpc?.();
    for (const who of aiPlayers()) aiPlayerIos[who]?.cancelRpc?.();
    game?.terminate();

    const latestState = logs[logs.length - 1];
    const newGame = createGame(latestState.state);
    game = newGame;
    if (mcpEnabled()) {
      for (const who of aiPlayers()) {
        await syncBridgeSnapshot(who);
      }
    }
    newGame.start().catch((e) => onGameError(e, newGame));
    setStateLog(logs);
    setViewingLogIndex(-1);
    setFromImport(false);
  };

  const childGiveUpHandler = (e: MessageEvent) => {
    const { data } = e;
    if (typeof data !== "object" || data === null) return;
    if (data.giTcg !== "1.0") return;
    if (!("method" in data)) return;
    if (data.method === "giveUp") game?.giveUp(CHILD_WHO);
  };

  let detailDialog!: HTMLDialogElement;
  const [detailLog, setDetailLog] = createSignal<readonly DetailLogEntry[]>([]);
  const showDetail = () => { setDetailLog(game?.detailLog ?? []); detailDialog.showModal(); detailDialog.scrollIntoView({ block: "end" }); };
  const closeDetail = () => { detailDialog.close(); setDetailLog([]); };

  onMount(async () => {
    window.addEventListener("beforeunload", () => popupWindow()?.close());
    window.addEventListener("message", childGiveUpHandler);

    if (mcpEnabled()) {
      // PRE-SYNC: push deck info to bridge BEFORE starting the game loop
      // and BEFORE the periodic timers fire.  Without this, agents that
      // query get_player{N}_deck before the first sync will receive
      // "Deck info not available".  Agents start asynchronously (OpenCode
      // processes) so there is always a window where the snapshot has not
      // been populated yet.
      for (const who of aiPlayers()) {
        await syncBridgeSnapshot(who);
      }

      for (const who of aiPlayers()) {
        commandPollTimers.push(window.setInterval(() => {
          pollNextCommand(who).catch((e) => console.warn(e));
        }, MCP_COMMAND_POLL_INTERVAL_MS));
        snapshotSyncTimers.push(window.setInterval(() => {
          syncBridgeSnapshot(who).catch((e) => console.warn(e));
        }, MCP_SYNC_INTERVAL_MS));
      }
    }

    if (Array.isArray(props.logs)) {
      setStateLog(props.logs);
      setViewingLogIndex(0);
      setFromImport(true);
    } else {
      await startGame();
    }
  });

  onCleanup(() => {
    window.removeEventListener("message", childGiveUpHandler);
    for (const t of commandPollTimers) window.clearInterval(t);
    for (const t of snapshotSyncTimers) window.clearInterval(t);
    disconnectBridge().catch((e) => console.warn(e));
  });

  return (
    <div class={bothAi() ? "ai-battle-mode" : ""}>
      <Show
        when={viewingState()}
        fallback={
          <>
            <div class="title-row">
              <span class="title">后手方棋盘</span>
              <button disabled={stateLog().length <= 1} onClick={enableLog}>查看历史</button>
            </div>
            <Chessboard autoHeight={bothAi() ? false : undefined} />
          </>
        }
      >
        {(state) => (
          <>
            <div class="title-row">
              <span class="title">{viewingWho() ? "后" : "先"}手方棋盘（查看历史中）</span>
              <Show when={viewingLogIndex() <= maxLogIndex() && state().canResume}>
                <button onClick={resumeGame}>从此处继续</button>
              </Show>
              <button onClick={() => setViewingWho((i) => (1 - i) as Who)}>切换玩家</button>
              <button disabled={viewingLogIndex() <= 0} onClick={() => setViewingLogIndex((i) => i - 1)}>后退一步</button>
              <span>{viewingLogIndex() + 1} / {stateLog().length}</span>
              <button disabled={viewingLogIndex() >= maxLogIndex()} onClick={() => setViewingLogIndex((i) => i + 1)}>前进一步</button>
              <button disabled={fromImport()} onClick={() => setViewingLogIndex(-1)}>返回游戏</button>
            </div>
            <StandaloneChessboard
              class="grayscale"
              who={viewingWho()}
              state={exposeState(viewingWho(), state().state)}
              mutations={[]}
              assetsManager={LOCAL_ASSETS_MANAGER}
              autoHeight={bothAi() ? false : undefined}
            />
          </>
        )}
      </Show>
      <button disabled={stateLog().length === 0} onClick={exportLog}>导出日志</button>
      <button onClick={showDetail}>显示细节</button>
      <Show when={mcpEnabled() && !bothAi()}>
        <div style={{ "margin-top": "10px", padding: "10px", "background-color": "#f0f0f0", "border-radius": "5px" }}>
          <strong>MCP 模式已启用</strong>
          <div>先手 (Player 0): {p0isAi() ? "AI" : "用户"}</div>
          <div>后手 (Player 1): {p1isAi() ? "AI" : "用户"}</div>
        </div>
      </Show>
      <Show when={bothAi()}>
        <div class="ai-battle-hud">
          <div class="ai-hud-column">
            <div class="ai-hud-header">P0 先手 AI</div>
            <div class="ai-hud-logs">
              <For each={aiLogs().filter((l) => l.who === 0).slice(-5)}>
                {(log) => <div class="ai-hud-log">{log.text}</div>}
              </For>
            </div>
          </div>
          <div class="ai-hud-column">
            <div class="ai-hud-header">P1 后手 AI</div>
            <div class="ai-hud-logs">
              <For each={aiLogs().filter((l) => l.who === 1).slice(-5)}>
                {(log) => <div class="ai-hud-log">{log.text}</div>}
              </For>
            </div>
          </div>
        </div>
      </Show>
      <dialog ref={detailDialog!}>
        <DetailLogViewer logs={detailLog()} />
        <button onClick={closeDetail}>关闭</button>
      </dialog>
    </div>
  );
}
