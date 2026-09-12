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

import { For, Match, Show, Switch, createSignal } from "solid-js";
import getData from "@gi-tcg/data";
import {
  CURRENT_VERSION,
  GameStateLogEntry,
  Version,
  deserializeGameStateLog,
  VERSIONS,
  Deck,
  Game,
  GameState,
} from "@gi-tcg/core";
import { StandaloneChild } from "./StandaloneChild";
import { StandaloneParent } from "./StandaloneParent";
import { IS_BETA, SERVER_HOST, WEB_CLIENT_BASE_PATH } from "@gi-tcg/config";
import { DeckBuilder } from "@gi-tcg/deck-builder";
import "@gi-tcg/deck-builder/style.css";
import "@gi-tcg/state-editor/style.css";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import { GameStateEditor } from "@gi-tcg/state-editor";
import { ReplayFolderPlayer, type ReplayFile } from "./ReplayFolderPlayer";
import { StandaloneParentWithMCP } from "./StandaloneParentWithMCP";

enum GameMode {
  NotStarted = 0,
  Standalone = 1,
  Editor = 2,
  ReplayFolder = 3,
  StandaloneWithMCP = 4,
}

const INIT_DECK0 =
  "FZDByRUNGRCB0WoNFlGgWpEPE0AB9TAPFGCB9kgWGIERCoEQDLFADcQQDPFgacYWDJAA";
const INIT_DECK1 =
  "FdHxNj8TAWDQxFkMFkAhyWIYCYDA45wOCUDQ5J0PGEAh9IIPGWDh9p4YC6FgirYRCxAA";

if (import.meta.env.DEV) {
  // Debug here!
}

export function App() {
  if (window.opener !== null) {
    // eslint-disable-next-line solid/components-return-once
    return <StandaloneChild />;
  }
  const [mode, setMode] = createSignal<GameMode>(GameMode.NotStarted);
  const [logs, setLogs] = createSignal<GameStateLogEntry[]>();
  const [deck0, setDeck0] = createSignal(INIT_DECK0);
  const [deck1, setDeck1] = createSignal(INIT_DECK1);
  const [version, setVersion] = createSignal<Version>(CURRENT_VERSION);
  const [replayFiles, setReplayFiles] = createSignal<ReplayFile[]>([]);
  // MCP mode: each player can be independently "user" or "ai"
  const [player0Type, setPlayer0Type] = createSignal<"user" | "ai">("ai");
  const [player1Type, setPlayer1Type] = createSignal<"user" | "ai">("user");

  const importLog = async () => {
    return new Promise<GameStateLogEntry[]>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement)?.files?.[0];
        if (!file) {
          reject(`Failed to read uploaded file`);
          return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
          const contents = event.target?.result as string;
          try {
            const logs = JSON.parse(contents);
            const version = logs.gv;
            resolve(deserializeGameStateLog(getData(version), logs));
          } catch (error) {
            reject(error);
          }
        };
        reader.readAsText(file);
      };
      input.oncancel = () => {
        reject(`File upload canceled`);
      };
      input.click();
    });
  };

  const importFolder = async () => {
    const files: ReplayFile[] = [];
    const errors: string[] = [];

    return new Promise<ReplayFile[]>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.multiple = true;
      // webkitdirectory enables folder selection in Chromium-based browsers
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;

      input.onchange = async (e) => {
        const fileList = (e.target as HTMLInputElement)?.files;
        if (!fileList || fileList.length === 0) {
          reject("No files selected");
          return;
        }

        // Sort files by name for consistent ordering
        const sorted = Array.from(fileList).sort((a, b) =>
          a.name.localeCompare(b.name),
        );

        for (const file of sorted) {
          try {
            const contents = await file.text();
            const logs = JSON.parse(contents);
            const gv = logs.gv;
            const parsed = deserializeGameStateLog(getData(gv), logs);
            files.push({ name: file.name, logs: parsed });
          } catch (error) {
            errors.push(
              `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (files.length === 0) {
          reject(
            `No valid log files found. Errors:\n${errors.join("\n")}`,
          );
        } else {
          if (errors.length > 0) {
            console.warn("Some files failed to parse:", errors);
          }
          resolve(files);
        }
      };

      input.oncancel = () => {
        reject("Folder selection canceled");
      };

      input.click();
    });
  };

  let deckBuilderDialog!: HTMLDialogElement;
  const [loadDeckBuilder, setLoadDeckBuilder] = createSignal(false);
  const [deckBuilderValue, setDeckBuilderValue] = createSignal<Deck>({
    characters: [],
    cards: [],
  });
  const openDeckBuilder = () => {
    setLoadDeckBuilder(true);
    deckBuilderDialog.showModal();
  };
  const closeDeckBuilder = () => {
    deckBuilderDialog.close();
  };
  const loadDeckBuilderValue = async () => {
    const code = prompt(`Input share code:`);
    if (code === null) {
      return;
    }
    try {
      const deck = DEFAULT_ASSETS_MANAGER.decode(code);
      setDeckBuilderValue(deck);
    } catch (e) {
      if (e instanceof Error) {
        alert(e.message);
      }
      console.error(e);
    }
  };
  const saveDeckBuilderValue = async () => {
    const deck = deckBuilderValue();
    try {
      const code = DEFAULT_ASSETS_MANAGER.encode(deck);
      await navigator.clipboard.writeText(code);
      alert(`Deck code copied to clipboard: ${code}`);
    } catch (e) {
      if (e instanceof Error) {
        alert(e.message);
      }
      console.error(e);
    }
  };

  const editorInitialState = () => {
    const d0 = deck0();
    const d1 = deck1();
    try {
      const deck0 = DEFAULT_ASSETS_MANAGER.decode(d0);
      const deck1 = DEFAULT_ASSETS_MANAGER.decode(d1);
      return Game.createInitialState({
        decks: [deck0, deck1],
        data: getData(version()),
      });
    } catch (e) {
      if (e instanceof Error) {
        alert(e.message);
      }
      console.error(e);
    }
  };
  const onEditorSubmit = (state: GameState) => {
    console.log(state);
    setLogs([{ state, canResume: true }]);
    setMode(GameMode.Standalone);
  };

  return (
    <div>
      <Switch>
        <Match when={mode() === GameMode.NotStarted}>
          <div class="tabs">
            <input
              class="tab__input"
              type="radio"
              name="gameModeTab"
              id="standaloneInput"
              checked
            />
            <label class="tab__header" for="standaloneInput">
              本地模拟
            </label>
            <div class="tab__content config-panel">
              <div class="config-panel__title">牌组配置</div>
              <div class="config-panel__deck">
                <label>先手牌组</label>
                <input
                  type="text"
                  value={deck0()}
                  onInput={(e) => setDeck0(e.currentTarget.value)}
                />
              </div>
              <div class="config-panel__deck">
                <label>后手牌组</label>
                <input
                  type="text"
                  value={deck1()}
                  onInput={(e) => setDeck1(e.currentTarget.value)}
                />
              </div>
              <div class="config-panel__deck">
                <label>游戏版本</label>
                <select
                  value={version()}
                  onChange={(e) => setVersion(e.target.value as Version)}
                >
                  <For each={VERSIONS}>
                    {(ver) => <option value={ver}>{ver}</option>}
                  </For>
                </select>
              </div>
              <div class="config-panel__description">
                点击下方按钮开始对局；先手方棋盘会在弹出窗口显示，后手方棋盘在本页面显示。
                <br />
                （若弹窗不显示为浏览器阻止，请允许本页面使用弹出式窗口。）
                <Show when={IS_BETA}>
                  <br />
                  <strong>
                    请注意：本页面包含未发布的测试版卡牌；包含这些卡牌的分享码仅限在本页面内使用，它们可能是无效的正式版分享码。
                  </strong>
                </Show>
              </div>
              <div class="config-panel__button-group">
                <button onClick={() => setMode(1)}>开始对局</button>
                <button
                  onClick={async () => {
                    const logs = await importLog().catch(alert);
                    if (logs) {
                      setLogs(logs);
                      setMode(1);
                    }
                  }}
                >
                  导入日志
                </button>
                <button
                  onClick={async () => {
                    const files = await importFolder().catch(alert);
                    if (files && files.length > 0) {
                      setReplayFiles(files);
                      setMode(GameMode.ReplayFolder);
                    }
                  }}
                >
                  导入文件夹
                </button>
                <button onClick={() => setMode(GameMode.Editor)}>摆盘器</button>
              </div>
            </div>
            <input
              class="tab__input"
              type="radio"
              name="gameModeTab"
              id="multiplayerInput"
            />
            <label class="tab__header" for="multiplayerInput">
              <a href={`${SERVER_HOST}${WEB_CLIENT_BASE_PATH}`} target="_blank">
                多人对战
              </a>
            </label>
            <div class="tab__content config-panel" />
            <input
              class="tab__input"
              type="radio"
              name="gameModeTab"
              id="mcpInput"
            />
            <label class="tab__header" for="mcpInput">
              MCP模式
            </label>
            <div class="tab__content config-panel">
              <div class="config-panel__title">MCP AI 对局配置</div>
              <div class="config-panel__description">
                牌组配置请在「本地模拟」标签页中设置。
                <br />
                设置各玩家由用户还是 AI 控制。双方均为用户时将自动使用普通本地模拟模式。
              </div>
              <div class="config-panel__deck">
                <label>先手 (Player 0)</label>
                <select
                  value={player0Type()}
                  onChange={(e) => setPlayer0Type(e.target.value as "user" | "ai")}
                >
                  <option value="ai">AI</option>
                  <option value="user">用户</option>
                </select>
              </div>
              <div class="config-panel__deck">
                <label>后手 (Player 1)</label>
                <select
                  value={player1Type()}
                  onChange={(e) => setPlayer1Type(e.target.value as "user" | "ai")}
                >
                  <option value="ai">AI</option>
                  <option value="user">用户</option>
                </select>
              </div>
              <Show
                when={player0Type() === "user" && player1Type() === "user"}
              >
                <div class="config-panel__description text-danger">
                  ⚠ 双方均为用户，将使用普通本地模拟模式。
                </div>
              </Show>
              <div class="config-panel__button-group">
                <button
                  onClick={() => {
                    if (player0Type() === "user" && player1Type() === "user") {
                      setMode(GameMode.Standalone);
                    } else {
                      setMode(GameMode.StandaloneWithMCP);
                    }
                  }}
                >
                  开始对局
                  {player0Type() === "ai" || player1Type() === "ai"
                    ? " (MCP)"
                    : ""}
                </button>
              </div>
            </div>
            <div class="tab__spacer" />
          </div>
          <h3>友情链接</h3>
          <ul>
            <li>
              获取牌组码：
              <a
                href="https://webstatic.mihoyo.com/ys/event/bbs-lineup-qskp/index.html"
                target="_blank"
              >
                米游社「七圣召唤」卡牌广场
              </a>
            </li>
            <li>
              获取牌组码：
              <a href="https://www.summoners.top/teams" target="_blank">
                召唤之巅：原神赛事数据统计平台
              </a>
            </li>
            <li>
              获取牌组码：<button onClick={openDeckBuilder}>启动组牌器</button>
            </li>
            <li>
              此项目{" "}
              <a
                href="https://github.com/Guyutongxue/genius-invokation"
                target="_blank"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                href="https://jarvis-yu.github.io/Dottore-Genius-Invokation-TCG-PWA/"
                target="_blank"
              >
                Dottore 七圣召唤模拟器
              </a>
              （
              <a
                href="https://github.com/Jarvis-Yu/Dottore-Genius-Invokation-TCG-Simulator"
                target="_blank"
              >
                GitHub
              </a>
              ）
            </li>
            <li>
              <a href="https://7shengzhaohuan.online/lpsim" target="_blank">
                七圣召唤水皇模拟器 "LPSim"
              </a>
              （
              <a href="https://github.com/LPSim/backend" target="_blank">
                GitHub
              </a>
              ）
            </li>
            <li>
              <a
                href="https://flick-ai.github.io/Genius-Invokation"
                target="_blank"
              >
                flick-ai 七圣召唤模拟器
              </a>
              （
              <a
                href="https://github.com/flick-ai/Genius-Invokation"
                target="_blank"
              >
                GitHub
              </a>
              ）
            </li>
          </ul>
        </Match>
        <Match when={mode() === GameMode.Standalone}>
          <StandaloneParent
            logs={logs()}
            deck0={deck0()}
            deck1={deck1()}
            version={version()}
          />
        </Match>
        <Match when={mode() === GameMode.Editor}>
          <GameStateEditor
            initialValue={editorInitialState()}
            onSubmit={onEditorSubmit}
          >
            <button
              class="editor-back-button"
              type="button"
              onClick={() => setMode(GameMode.NotStarted)}
            >
              返回首页
            </button>
          </GameStateEditor>
        </Match>
        <Match when={mode() === GameMode.ReplayFolder}>
          <ReplayFolderPlayer files={replayFiles()} />
          <button
            onClick={() => {
              setReplayFiles([]);
              setMode(GameMode.NotStarted);
            }}
            style={{ margin: "1rem auto", display: "block" }}
          >
            返回首页
          </button>
        </Match>
        <Match when={mode() === GameMode.StandaloneWithMCP}>
          <StandaloneParentWithMCP
            logs={logs()}
            deck0={deck0()}
            deck1={deck1()}
            version={version()}
            enableMCP={true}
            player0Type={player0Type()}
            player1Type={player1Type()}
          />
        </Match>
      </Switch>
      <dialog ref={deckBuilderDialog!} class="deck-builder-dialog">
        <Show when={loadDeckBuilder()}>
          <DeckBuilder
            class="deck-builder"
            deck={deckBuilderValue()}
            onChangeDeck={setDeckBuilderValue}
          />
        </Show>
        <div class="deck-builder-actions">
          <button onClick={closeDeckBuilder}>Close</button>
          <button onClick={saveDeckBuilderValue}>Save</button>
          <button onClick={loadDeckBuilderValue}>Load from code</button>
        </div>
      </dialog>
    </div>
  );
}
