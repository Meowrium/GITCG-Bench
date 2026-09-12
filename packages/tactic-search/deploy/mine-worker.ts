#!/usr/bin/env bun
import getData from "@gi-tcg/data";
import type { DeckConfig, GameState } from "@gi-tcg/core";

import { SimAdapter } from "../src/sim-adapter";
import { StateEvaluator } from "../src/state-evaluator";
import { BoundedSearcher } from "../src/bounded-searcher";
import { ComboRegistry } from "../src/combo-registry";
import type { SearchConfig, ComboEntry } from "../src/types";

interface DeckEntry {
  characters: number[];
  cards: number[];
}

interface PairTask {
  taskId: number;
  pairKey: string;
  deck0: DeckEntry;
  deck1: DeckEntry;
}

interface WorkerTaskMessage {
  type: "task";
  task: PairTask;
  cfg: {
    samples: number;
    topK: number;
    scoreThreshold: number;
    searchConfig: SearchConfig;
    gameVersion: string;
  };
}

interface WorkerResultMessage {
  type: "result";
  taskId: number;
  pairKey: string;
  comboEntries: ComboEntry[];
}

interface WorkerErrorMessage {
  type: "error";
  taskId: number;
  pairKey: string;
  message: string;
}

const gameData = getData();
const sim = new SimAdapter(gameData);
const evaluator = new StateEvaluator();

const workerSelf = globalThis as unknown as {
  onmessage: ((ev: { data: WorkerTaskMessage }) => void | Promise<void>) | null;
  postMessage: (payload: WorkerResultMessage | WorkerErrorMessage) => void;
};

workerSelf.onmessage = async (ev: { data: WorkerTaskMessage }) => {
  const msg = ev.data;
  if (!msg || msg.type !== "task") return;

  const { task, cfg } = msg;
  try {
    const entries = await mineTask(task, cfg);
    const payload: WorkerResultMessage = {
      type: "result",
      taskId: task.taskId,
      pairKey: task.pairKey,
      comboEntries: entries,
    };
    workerSelf.postMessage(payload);
  } catch (e) {
    const payload: WorkerErrorMessage = {
      type: "error",
      taskId: task.taskId,
      pairKey: task.pairKey,
      message: String(e),
    };
    workerSelf.postMessage(payload);
  }
};

async function mineTask(
  task: PairTask,
  cfg: WorkerTaskMessage["cfg"],
): Promise<ComboEntry[]> {
  const registry = new ComboRegistry();

  const deck0: DeckConfig = task.deck0;
  const deck1: DeckConfig = task.deck1;

  const p0Searcher = new BoundedSearcher(sim, evaluator, {
    ...cfg.searchConfig,
    perspective: 0,
  });
  const p1Searcher = new BoundedSearcher(sim, evaluator, {
    ...cfg.searchConfig,
    perspective: 1,
  });

  for (let sample = 0; sample < cfg.samples; sample++) {
    let state: GameState;
    try {
      state = sim.createInitialState(deck0, deck1);
    } catch {
      continue;
    }

    await mineForPerspective(registry, state, 0, p0Searcher, cfg.topK, cfg.scoreThreshold, cfg.gameVersion);
    await mineForPerspective(registry, state, 1, p1Searcher, cfg.topK, cfg.scoreThreshold, cfg.gameVersion);
  }

  return registry.exportAll();
}

async function mineForPerspective(
  registry: ComboRegistry,
  state: GameState,
  who: 0 | 1,
  searcher: BoundedSearcher,
  topK: number,
  scoreThreshold: number,
  gameVersion: string,
): Promise<void> {
  try {
    const results = await searcher.search(state, topK);
    for (const result of results) {
      if (result.score < scoreThreshold) continue;
      registry.registerFromSearch(result, state, who, gameVersion);
    }
  } catch {
    // Ignore one perspective failure in a sample.
  }
}
