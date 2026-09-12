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

import {
  GameStateLogEntry,
  exposeState,
} from "@gi-tcg/core";
import { StandaloneChessboard } from "@gi-tcg/web-ui-core";
import "@gi-tcg/web-ui-core/style.css";
import {
  Show,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { LOCAL_ASSETS_MANAGER } from "./localAssetsManager";

export interface ReplayFile {
  name: string;
  logs: GameStateLogEntry[];
}

export interface ReplayFolderPlayerProps {
  files: ReplayFile[];
}

const DEFAULT_STEP_MS = 800;
const MIN_STEP_MS = 100;
const MAX_STEP_MS = 5000;

export function ReplayFolderPlayer(props: ReplayFolderPlayerProps) {
  const [fileIndex, setFileIndex] = createSignal(0);
  const [stepIndex, setStepIndex] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [stepDelay, setStepDelay] = createSignal(DEFAULT_STEP_MS);
  const [viewingWho, setViewingWho] = createSignal<0 | 1>(1);

  let timer: ReturnType<typeof setInterval> | null = null;

  const currentFile = (): ReplayFile | undefined =>
    props.files[fileIndex()];
  const currentLogs = (): GameStateLogEntry[] =>
    currentFile()?.logs ?? [];
  const currentState = (): GameStateLogEntry | undefined =>
    currentLogs()[stepIndex()];
  const totalFiles = () => props.files.length;
  const totalSteps = () => currentLogs().length;

  const isLastStep = () => stepIndex() >= totalSteps() - 1;
  const isFirstStep = () => stepIndex() <= 0;
  const isLastFile = () => fileIndex() >= totalFiles() - 1;

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const advanceStep = () => {
    if (isLastStep()) {
      // Current file ended
      if (!isLastFile()) {
        // Advance to next file
        setFileIndex((i) => i + 1);
        setStepIndex(0);
      } else {
        // Last file done, stop playing
        stopTimer();
        setPlaying(false);
      }
    } else {
      setStepIndex((i) => i + 1);
    }
  };

  const togglePlay = () => {
    if (playing()) {
      stopTimer();
      setPlaying(false);
    } else {
      // If at end of last file, start from beginning
      if (isLastFile() && isLastStep()) {
        setFileIndex(0);
        setStepIndex(0);
      }
      setPlaying(true);
      timer = setInterval(advanceStep, stepDelay());
    }
  };

  const skipToNextFile = () => {
    const wasPlaying = playing();
    stopTimer();
    if (!isLastFile()) {
      setFileIndex((i) => i + 1);
      setStepIndex(0);
      if (wasPlaying) {
        timer = setInterval(advanceStep, stepDelay());
      }
    } else {
      setPlaying(false);
    }
  };

  const skipToPrevFile = () => {
    if (fileIndex() > 0) {
      const wasPlaying = playing();
      stopTimer();
      setFileIndex((i) => i - 1);
      setStepIndex(0);
      if (wasPlaying) {
        timer = setInterval(advanceStep, stepDelay());
      }
    }
  };

  const adjustSpeed = (delta: number) => {
    setStepDelay((d) => {
      const next = d + delta;
      return Math.max(MIN_STEP_MS, Math.min(MAX_STEP_MS, next));
    });
    // Restart timer with new speed if playing
    if (playing()) {
      stopTimer();
      timer = setInterval(advanceStep, stepDelay());
    }
  };

  // When fileIndex changes, ensure stepIndex is valid
  onMount(() => {
    // No auto-start; user clicks play
  });

  onCleanup(() => {
    stopTimer();
  });

  return (
    <div class="standalone-board-shell">
      <div class="replay-folder-controls">
        <div class="replay-folder-info">
          <span class="replay-folder-filename">
            {currentFile()?.name ?? "(无文件)"}
          </span>
          <span class="replay-folder-progress">
            文件 {fileIndex() + 1} / {totalFiles()}
            {" · "}
            步骤 {stepIndex() + 1} / {totalSteps()}
          </span>
        </div>

        <div class="replay-folder-buttons">
          <button
            disabled={fileIndex() <= 0}
            onClick={skipToPrevFile}
            title="上一个文件"
          >
            ⏮
          </button>
          <button
            disabled={isFirstStep()}
            onClick={() => setStepIndex((i) => i - 1)}
            title="后退一步"
          >
            ◀
          </button>
          <button onClick={togglePlay} class="play-button" title="播放/暂停">
            {playing() ? "⏸" : "▶"}
          </button>
          <button
            disabled={isLastStep()}
            onClick={advanceStep}
            title="前进一步"
          >
            ▶
          </button>
          <button
            disabled={isLastFile()}
            onClick={skipToNextFile}
            title="下一个文件"
          >
            ⏭
          </button>
          <button
            onClick={() => adjustSpeed(-200)}
            title="减速"
            disabled={stepDelay() >= MAX_STEP_MS}
          >
            🐢
          </button>
          <span class="speed-label">{stepDelay()}ms</span>
          <button
            onClick={() => adjustSpeed(200)}
            title="加速"
            disabled={stepDelay() <= MIN_STEP_MS}
          >
            🐇
          </button>
          <button
            onClick={() => setViewingWho((w) => (1 - w) as 0 | 1)}
            title="切换视角"
          >
            👁
          </button>
        </div>
      </div>

      <div class="title-row">
        <span class="title">
          {viewingWho() ? "后" : "先"}手方棋盘
          {playing() ? "（自动播放中）" : "（已暂停）"}
        </span>
      </div>

      <Show when={currentState()} keyed>
        {(state) => (
          <StandaloneChessboard
            class="grayscale"
            who={viewingWho()}
            state={exposeState(viewingWho(), state.state)}
            mutations={[]}
            assetsManager={LOCAL_ASSETS_MANAGER}
          />
        )}
      </Show>

      <Show when={!playing() && isLastFile() && isLastStep()}>
        <div class="replay-folder-end">
          🎉 所有对局已播放完毕！
          <button onClick={() => { setFileIndex(0); setStepIndex(0); }}>
            从头开始
          </button>
        </div>
      </Show>
    </div>
  );
}
