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

// StandaloneParent with MCP Integration
// This file shows how to integrate MCP into the standalone simulator

import getData from "@gi-tcg/data";
import {
  CancellablePlayerIO,
  DetailLogEntry,
  Game,
  GameState,
  GameStateLogEntry,
  Version,
  exposeState,
  serializeGameStateLog,
} from "@gi-tcg/core";

import { createClient, StandaloneChessboard } from "@gi-tcg/web-ui-core";
import "@gi-tcg/web-ui-core/style.css";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { DetailLogViewer } from "@gi-tcg/detail-log-viewer";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";

// MCP Integration imports
import {
  initMCP,
  setupGameIntegration,
} from "@gi-tcg/mcp";

export interface StandaloneParentProps {
  logs?: GameStateLogEntry[];
  deck0: string;
  deck1: string;
  version: Version;
  // MCP configuration
  enableMCP?: boolean;
  aiPlayerWho?: 0 | 1; // Which player is controlled by AI (0 = first, 1 = second)
}

const CHILD_WHO = 0;
const PARENT_WHO = 1;

export function StandaloneParentWithMCP(props: StandaloneParentProps) {
  // Initialize MCP server
  const mcpServer = initMCP();
  
  const [uiIo, Chessboard] = createClient(1, {
    onGiveUp: () => {
      game?.giveUp(PARENT_WHO);
    },
  });

  const [popupWindow, setPopupWindow] = createSignal<Window | null>(null);

  const showPopup = async () => {
    if (popupWindow() !== null) {
      return;
    }
    const newWindow = window.open(
      window.location.href,
      "_blank",
      "popup=yes, depended=yes, height=750, width=750",
    );
    setPopupWindow(newWindow);
    const autoGiveupWhenChildCloseInterval = window.setInterval(() => {
      if (newWindow?.closed && autoGiveupWhenChildCloseInterval !== null) {
        window.clearInterval(autoGiveupWhenChildCloseInterval);
        game?.giveUp(CHILD_WHO);
        setPopupWindow(null);
      }
    }, 1000);
    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const { data } = e;
        if (typeof data !== "object" || data === null) {
          return;
        }
        if (data.giTcg !== "1.0") {
          return;
        }
        if (!("method" in data)) {
          return;
        }
        if (data.method === "initialized") {
          window?.removeEventListener("message", handler);
          resolve();
        }
      };
      window?.addEventListener("message", handler);
    });
  };

  const childIo: CancellablePlayerIO = {
    notify: (...params) => {
      popupWindow()?.postMessage({
        giTcg: "1.0",
        method: "notify",
        params,
      });
    },
    rpc: async (...params): Promise<any> => {
      const id = Math.random().toString(36).slice(2);
      const result = new Promise((resolve) => {
        const handler = (e: MessageEvent) => {
          const { data } = e;
          if (typeof data !== "object" || data === null) {
            return;
          }
          if (data.giTcg !== "1.0") {
            return;
          }
          if (!("method" in data)) {
            return;
          }
          if (data.method === "rpc" && data.id === id) {
            window?.removeEventListener("message", handler);
            resolve(data.result);
          }
        };
        window?.addEventListener("message", handler);
      });
      popupWindow()?.postMessage({
        giTcg: "1.0",
        method: "rpc",
        params,
        id,
      });
      return result;
    },
    cancelRpc: () => {
      popupWindow()?.postMessage({
        giTcg: "1.0",
        method: "cancelRpc",
      });
    },
  };

  const [stateLog, setStateLog] = createSignal<GameStateLogEntry[]>([]);
  const [fromImport, setFromImport] = createSignal(false);
  const [viewingLogIndex, setViewingLogIndex] = createSignal<number>(-1);
  const [viewingWho, setViewingWho] = createSignal<0 | 1>(1);
  const viewingState = (): GameStateLogEntry | undefined => {
    const index = viewingLogIndex();
    return stateLog()[index];
  };
  const enableLog = () => {
    setViewingWho(1);
    setViewingLogIndex(stateLog().length - 2);
  };
  const maxLogIndex = () => {
    return stateLog().length - (fromImport() ? 1 : 2);
  };

  const exportLog = () => {
    const logs = serializeGameStateLog(stateLog());
    const blob = new Blob([JSON.stringify({ ...logs, gv: props.version })], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gameLog.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  let game: Game | null = null;
  let aiPlayerIO: any = null;
  let stateListener: any = null;

  const pause = async (
    state: GameState,
    mutations: unknown,
    canResume: boolean,
  ) => {
    if (game !== null) {
      setStateLog((logs) => [...logs, { state, canResume }]);
    }
    // Notify MCP state listener
    if (stateListener) {
      stateListener.onPause(state, mutations as any, canResume);
    }
  };

  const onGameError = (e: unknown, from?: Game) => {
    if (!from || from === game) {
      console.error(e);
      alert(
        `游戏出现了内部错误！请点击主窗口下方"导出日志"按钮生成日志文件，并反馈至 GitHub Issue，thanks~\n${
          e instanceof Error ? e.message : String(e)
        }`,
      );
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
    const game = new Game(state);
    game.onPause = pause;
    
    // MCP Integration
    const enableMCP = props.enableMCP ?? false;
    const aiPlayerWho = props.aiPlayerWho ?? 0;
    
    if (enableMCP) {
      // Set up MCP integration
      const integration = setupGameIntegration(game, aiPlayerWho);
      aiPlayerIO = integration.aiPlayerIO;
      stateListener = integration.stateListener;
      
      // Assign AI IO to the specified player
      game.players[aiPlayerWho].io = aiPlayerIO;
      // Assign UI IO to the other player
      game.players[1 - aiPlayerWho].io = aiPlayerWho === 0 ? uiIo : childIo;
      
      console.log(`MCP enabled: Player ${aiPlayerWho} is AI-controlled`);
    } else {
      // Original behavior: Player 0 in popup, Player 1 in main window
      game.players[0].io = childIo;
      game.players[1].io = uiIo;
    }
    
    return game;
  };

  const startGame = async () => {
    try {
      await showPopup();
      const initialGame = createGame();
      game = initialGame;
      initialGame.start().catch((e) => onGameError(e, initialGame));
    } catch (e) {
      onGameError(e);
    }
  };

  const resumeGame = async () => {
    await showPopup();
    const logs = stateLog().slice(0, viewingLogIndex() + 1);
    childIo.cancelRpc?.();
    uiIo.cancelRpc?.();
    game?.terminate();
    const latestState = logs[logs.length - 1];
    const newGame = createGame(latestState.state);
    game = newGame;
    newGame.start().catch((e) => onGameError(e, newGame));
    setStateLog(logs);
    setViewingLogIndex(-1);
    setFromImport(false);
  };

  const childGiveUpHandler = (e: MessageEvent) => {
    const { data } = e;
    if (typeof data !== "object" || data === null) {
      return;
    }
    if (data.giTcg !== "1.0") {
      return;
    }
    if (!("method" in data)) {
      return;
    }
    if (data.method === "giveUp") {
      game?.giveUp(CHILD_WHO);
    }
  };
  let detailDialog!: HTMLDialogElement;
  const [detailLog, setDetailLog] = createSignal<readonly DetailLogEntry[]>([]);
  const showDetail = () => {
    setDetailLog(game?.detailLog ?? []);
    detailDialog.showModal();
    detailDialog.scrollIntoView({ block: "end" });
  };
  const closeDetail = () => {
    detailDialog.close();
    setDetailLog([]);
  };

  onMount(() => {
    window.addEventListener("beforeunload", () => {
      popupWindow()?.close();
    });
    window.addEventListener("message", childGiveUpHandler);
    if (Array.isArray(props.logs)) {
      setStateLog(props.logs);
      setViewingLogIndex(props.logs.length - 2);
      setFromImport(true);
    } else {
      startGame();
    }
  });
  onCleanup(() => {
    window.removeEventListener("message", childGiveUpHandler);
  });

  return (
    <div>
      <Show
        when={viewingState()}
        fallback={
          <>
            <div class="title-row">
              <span class="title">后手方棋盘</span>
              <button disabled={stateLog().length <= 1} onClick={enableLog}>
                查看历史
              </button>
            </div>
            <Chessboard />
          </>
        }
      >
        {(state) => (
          <>
            <div class="title-row">
              <span class="title">
                {viewingWho() ? "后" : "先"}手方棋盘（查看历史中）
              </span>
              <Show
                when={viewingLogIndex() <= maxLogIndex() && state().canResume}
              >
                <button onClick={resumeGame}>从此处继续</button>
              </Show>
              <button onClick={() => setViewingWho((i) => (1 - i) as 0 | 1)}>
                切换玩家
              </button>
              <button
                disabled={viewingLogIndex() <= 0}
                onClick={() => setViewingLogIndex((i) => i - 1)}
              >
                后退一步
              </button>
              <span>
                {viewingLogIndex() + 1} / {stateLog().length}
              </span>
              <button
                disabled={viewingLogIndex() >= maxLogIndex()}
                onClick={() => setViewingLogIndex((i) => i + 1)}
              >
                前进一步
              </button>
              <button
                disabled={fromImport()}
                onClick={() => setViewingLogIndex(-1)}
              >
                返回游戏
              </button>
            </div>
            <StandaloneChessboard
              class="grayscale"
              who={viewingWho()}
              state={exposeState(viewingWho(), state().state)}
              mutations={[]}
            />
          </>
        )}
      </Show>
      <button disabled={stateLog().length === 0} onClick={exportLog}>
        导出日志
      </button>
      <button onClick={showDetail}>显示细节</button>
      <Show when={props.enableMCP}>
        <div style={{ "margin-top": "10px", padding: "10px", "background-color": "#f0f0f0", "border-radius": "5px" }}>
          <strong>MCP 模式已启用</strong>
          <div>AI 控制玩家: {props.aiPlayerWho === 0 ? "先手 (Player 0)" : "后手 (Player 1)"}</div>
          <div>您控制玩家: {props.aiPlayerWho === 0 ? "后手 (Player 1)" : "先手 (Player 0)"}</div>
        </div>
      </Show>
      <dialog ref={detailDialog!}>
        <DetailLogViewer logs={detailLog()} />
        <button onClick={closeDetail}>关闭</button>
      </dialog>
    </div>
  );
}
