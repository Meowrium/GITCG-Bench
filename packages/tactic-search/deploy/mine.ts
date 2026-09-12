#!/usr/bin/env bun
/**
 * mine.ts — tactic-search 全卡池离线挖掘入口（v2）
 *
 * 特性：
 * - 全角色组合（3 人去重组合，不计角色排列）
 * - 全卡池合法构筑生成（角色绑定、双同标签、Legend/Card Blessing 单卡）
 * - 多线程 worker 并行挖掘
 * - checkpoint 断点续跑（记录已完成 task id）
 */

import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { parseArgs } from "util";
import { availableParallelism } from "os";

import { type DeckConfig } from "@gi-tcg/core";
import type { DeckDataActionCardInfo } from "@gi-tcg/assets-manager";
import { getStaticDeckData } from "../../assets-manager/src/static_deck_data";

import { ComboRegistry } from "../src/combo-registry";
import type { SearchConfig, ComboEntry } from "../src/types";

// ─── CLI 参数 ───

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    resume: { type: "boolean", default: false },
    decks: { type: "string" },
    "deck-source": { type: "string" },
    "deck-variants": { type: "string" },
    "pair-mode": { type: "string" },
    workers: { type: "string" },
    "max-pairs": { type: "string" },
    checkpoint: { type: "string" },
    seed: { type: "string" },
    "max-decks": { type: "string" },
    samples: { type: "string" },
    "beam-width": { type: "string" },
    "max-depth": { type: "string" },
    "score-threshold": { type: "string" },
    "top-k": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

function getArgString(
  value: string | boolean | undefined,
  fallback: string,
): string {
  return typeof value === "string" ? value : fallback;
}

function getArgOptionalString(
  value: string | boolean | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

if (args.help) {
  console.log(`
Usage: bun run deploy/mine.ts [options]

Options:
  --resume                  Resume from last progress checkpoint
  --decks <file>            JSON file with deck configs (array of {characters, cards})
  --deck-source <mode>      Deck source: full-pool | sample (default: full-pool)
  --deck-variants <n>       Legal card builds per character trio (default: 1)
  --pair-mode <mode>        Pair generation: self | all (default: self)
  --workers <n>             Worker thread count (default: CPU/2, min 1)
  --max-decks <n>           Max number of decks to mine (default: all)
  --max-pairs <n>           Max number of pair tasks to mine (default: all)
  --samples <n>             Samples per task (default: 10)
  --beam-width <n>          Beam search width (default: 10)
  --max-depth <n>           Beam search depth (default: 5)
  --score-threshold <n>     Minimum combo score (default: 5.0)
  --top-k <n>               Top-K results per search (default: 5)
  --checkpoint <n>          Save checkpoint every N finished tasks (default: 20)
  --seed <n>                Random seed for full-pool deck construction (default: 20260311)
  -h, --help             Show this help
`);
  process.exit(0);
}

// ─── 配置 ───

const DECK_SOURCE = (args["deck-source"] ?? "full-pool") as
  | "full-pool"
  | "sample";
const PAIR_MODE = (args["pair-mode"] ?? "self") as "self" | "all";
const SAMPLES_PER_DECK = parseInt(getArgString(args.samples, "10"), 10);
const MAX_DECKS = args["max-decks"] ? parseInt(getArgString(args["max-decks"], "0"), 10) : Infinity;
const MAX_PAIRS = args["max-pairs"] ? parseInt(getArgString(args["max-pairs"], "0"), 10) : Infinity;
const BEAM_WIDTH = parseInt(getArgString(args["beam-width"], "10"), 10);
const MAX_DEPTH = parseInt(getArgString(args["max-depth"], "5"), 10);
const SCORE_THRESHOLD = parseFloat(getArgString(args["score-threshold"], "5.0"));
const TOP_K = parseInt(getArgString(args["top-k"], "5"), 10);
const DECK_VARIANTS = parseInt(getArgString(args["deck-variants"], "1"), 10);
const CHECKPOINT_INTERVAL = parseInt(getArgString(args.checkpoint, "20"), 10);
const SEED = parseInt(getArgString(args.seed, "20260311"), 10);
const WORKERS = Math.max(
  1,
  parseInt(getArgString(args.workers, `${Math.max(1, Math.floor(availableParallelism() / 2))}`), 10),
);

const OUTPUT_DIR = resolve(import.meta.dirname!, "../output");
mkdirSync(OUTPUT_DIR, { recursive: true });

const PROGRESS_FILE = join(OUTPUT_DIR, "progress.json");
const GAME_VERSION = "6.4.0";
const CHECKPOINT_VERSION = 2;

const searchConfig: SearchConfig = {
  maxDepth: MAX_DEPTH,
  beamWidth: BEAM_WIDTH,
  perspective: 0,
  enableMinimax: true,
  minimaxDepth: 1,
};

const registry = new ComboRegistry();

// ─── 加载牌组 ───

interface DeckEntry {
  characters: number[];
  cards: number[];
}

function loadDecks(): DeckEntry[] {
  const decksArg = getArgOptionalString(args.decks);
  if (decksArg) {
    const file = resolve(decksArg);
    if (!existsSync(file)) {
      console.error(`❌ Deck file not found: ${file}`);
      process.exit(1);
    }
    const loaded: DeckEntry[] = JSON.parse(readFileSync(file, "utf-8"));
    return loaded.filter((d) => isDeckShapeValid(d));
  }

  if (DECK_SOURCE === "sample") {
    console.log("⚠️  Using built-in sample decks");
    return generateSampleDecks();
  }

  console.log("🌐 Building full-pool legal decks from static deck data...");
  return generateFullPoolDecks(DECK_VARIANTS, SEED);
}

function generateSampleDecks(): DeckEntry[] {
  const deckData = getStaticDeckData();
  const characters = Array.from(deckData.characters.keys());
  characters.sort();

  const sampleChars = characters.slice(0, 9);
  const decks: DeckEntry[] = [];

  for (let i = 0; i < sampleChars.length - 2; i += 3) {
    const team = [sampleChars[i], sampleChars[i + 1], sampleChars[i + 2]];
    decks.push({
      characters: team,
      cards: buildLegalDeckCards(team, getStaticDeckData(), SEED + i),
    });
  }

  return decks;
}

function generateFullPoolDecks(deckVariants: number, seed: number): DeckEntry[] {
  const deckData = getStaticDeckData();
  const characterIds = Array.from(deckData.characters.keys()).sort((a, b) => a - b);
  const result: DeckEntry[] = [];

  let comboIndex = 0;
  for (let i = 0; i < characterIds.length - 2; i++) {
    for (let j = i + 1; j < characterIds.length - 1; j++) {
      for (let k = j + 1; k < characterIds.length; k++) {
        const team = [characterIds[i], characterIds[j], characterIds[k]];
        for (let v = 0; v < deckVariants; v++) {
          const cards = buildLegalDeckCards(team, deckData, seed + comboIndex * 7919 + v * 379);
          if (cards.length !== 30) {
            continue;
          }
          result.push({ characters: team, cards });
        }
        comboIndex++;
      }
    }
  }

  return result;
}

function buildLegalDeckCards(
  characters: number[],
  deckData: ReturnType<typeof getStaticDeckData>,
  seed: number,
): number[] {
  const characterTagBag = characters.flatMap(
    (id) => deckData.characters.get(id)?.tags ?? [],
  );

  const cardPool: number[] = [];
  for (const card of deckData.actionCards.values()) {
    if (!isActionCardLegalForTeam(card, characters, characterTagBag)) {
      continue;
    }
    const maxCopies = getCardMaxCopies(card);
    for (let i = 0; i < maxCopies; i++) {
      cardPool.push(card.id);
    }
  }

  if (cardPool.length < 30) {
    return [];
  }

  const rng = mulberry32(seed);
  shuffleInPlace(cardPool, rng);
  return cardPool.slice(0, 30);
}

function isActionCardLegalForTeam(
  actionCard: DeckDataActionCardInfo,
  characters: number[],
  characterTagBag: string[],
): boolean {
  if (
    typeof actionCard.relatedCharacterId === "number" &&
    !characters.includes(actionCard.relatedCharacterId)
  ) {
    return false;
  }

  if (typeof actionCard.relatedCharacterTag === "string") {
    const count = characterTagBag.filter((t) => t === actionCard.relatedCharacterTag).length;
    if (count < 2) {
      return false;
    }
  }

  return true;
}

function getCardMaxCopies(card: DeckDataActionCardInfo): number {
  const singletonRequired = card.tags.includes("GCG_TAG_LEGEND") ||
    card.tags.includes("GCG_TAG_CARD_BLESSING");
  return singletonRequired ? 1 : 2;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function isDeckShapeValid(deck: DeckEntry): boolean {
  return Array.isArray(deck.characters) && Array.isArray(deck.cards) && deck.characters.length === 3;
}

// ─── 任务生成 ───

interface PairTask {
  taskId: number;
  pairKey: string;
  deck0: DeckEntry;
  deck1: DeckEntry;
}

function createTasks(decks: DeckEntry[], mode: "self" | "all", maxPairs: number): PairTask[] {
  const tasks: PairTask[] = [];
  let id = 0;

  if (mode === "self") {
    for (const d of decks) {
      tasks.push({
        taskId: id++,
        pairKey: `${deckHash(d)}_vs_${deckHash(d)}`,
        deck0: d,
        deck1: d,
      });
      if (tasks.length >= maxPairs) break;
    }
    return tasks;
  }

  for (let i = 0; i < decks.length; i++) {
    for (let j = i; j < decks.length; j++) {
      tasks.push({
        taskId: id++,
        pairKey: `${deckHash(decks[i])}_vs_${deckHash(decks[j])}`,
        deck0: decks[i],
        deck1: decks[j],
      });
      if (tasks.length >= maxPairs) return tasks;
    }
  }

  return tasks;
}

// ─── 进度管理 ───

interface ProgressV2 {
  version: number;
  completedTaskIds: number[];
  completedPairs: string[];
  totalTasks: number;
  totalCombosFound: number;
  lastTimestamp: string;
}

function loadProgress(totalTasks: number): ProgressV2 {
  if (args.resume && existsSync(PROGRESS_FILE)) {
    const loaded = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    if (loaded.version === CHECKPOINT_VERSION) {
      return loaded as ProgressV2;
    }
  }
  return {
    version: CHECKPOINT_VERSION,
    completedTaskIds: [],
    completedPairs: [],
    totalTasks,
    totalCombosFound: 0,
    lastTimestamp: new Date().toISOString(),
  };
}

function saveProgress(progress: ProgressV2) {
  progress.lastTimestamp = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function deckHash(deck: DeckEntry): string {
  const chars = [...deck.characters].sort((a, b) => a - b);
  return chars.join("-");
}

// ─── worker 协议 ───

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

async function main() {
  const decks = loadDecks().slice(0, MAX_DECKS);
  const tasks = createTasks(decks, PAIR_MODE, MAX_PAIRS);
  const progress = loadProgress(tasks.length);

  console.log(`\n📊 Mining config:`);
  console.log(`   Deck source: ${args.decks ? "file" : DECK_SOURCE}`);
  console.log(`   Decks: ${decks.length}`);
  console.log(`   Pair mode: ${PAIR_MODE}`);
  console.log(`   Tasks: ${tasks.length}`);
  console.log(`   Samples/task: ${SAMPLES_PER_DECK}`);
  console.log(`   Beam: width=${BEAM_WIDTH}, depth=${MAX_DEPTH}`);
  console.log(`   Workers: ${WORKERS}`);
  console.log(`   Score threshold: ${SCORE_THRESHOLD}`);
  console.log(`   Output: ${OUTPUT_DIR}`);

  if (args.resume && progress.completedTaskIds.length > 0) {
    console.log(`   📂 Resuming: ${progress.completedTaskIds.length} tasks already done`);
    await loadExistingCombosToRegistry();
    console.log(`   📦 Loaded ${registry.size} existing combos`);
  }

  const startTime = Date.now();
  const doneIds = new Set(progress.completedTaskIds);
  const pending = tasks.filter((t) => !doneIds.has(t.taskId));

  if (pending.length === 0) {
    console.log("   ✅ No pending tasks, nothing to mine.");
  } else {
    console.log(`   ⏳ Pending tasks: ${pending.length}`);
    await runWithWorkers(pending, progress, doneIds);
  }

  saveResults("final");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const stats = {
    totalDeckPairs: tasks.length,
    completedTasks: progress.completedTaskIds.length,
    totalCombosDiscovered: registry.size,
    samplesPerDeck: SAMPLES_PER_DECK,
    searchConfig,
    scoreThreshold: SCORE_THRESHOLD,
    elapsedSeconds: parseFloat(elapsed),
    gameVersion: GAME_VERSION,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(join(OUTPUT_DIR, "stats.json"), JSON.stringify(stats, null, 2));

  console.log(`\n✅ Mining complete!`);
  console.log(`   Duration: ${elapsed}s`);
  console.log(`   Deck pairs: ${tasks.length}`);
  console.log(`   Combos found: ${registry.size}`);
  console.log(`   Output: ${OUTPUT_DIR}/`);
}

async function runWithWorkers(
  pendingTasks: PairTask[],
  progress: ProgressV2,
  doneIds: Set<number>,
): Promise<void> {
  const workerCount = Math.min(WORKERS, pendingTasks.length);
  let cursor = 0;
  let finished = 0;

  await Promise.all(
    Array.from({ length: workerCount }).map(async (_, workerIdx) => {
      const worker = new Worker(new URL("./mine-worker.ts", import.meta.url).href, {
        type: "module",
      });

      try {
        while (cursor < pendingTasks.length) {
          const task = pendingTasks[cursor++];
          const result = await runTaskOnWorker(worker, task);

          if (result.type === "error") {
            console.warn(`   ⚠️  task=${task.taskId} failed: ${result.message}`);
            continue;
          }

          registry.importAll(result.comboEntries);
          doneIds.add(result.taskId);
          progress.completedTaskIds = Array.from(doneIds.values()).sort((a, b) => a - b);
          progress.completedPairs.push(result.pairKey);
          progress.totalCombosFound = registry.size;

          finished++;
          if (finished % CHECKPOINT_INTERVAL === 0) {
            saveProgress(progress);
            saveResults("checkpoint");
            console.log(`   💾 checkpoint: ${finished}/${pendingTasks.length} pending done`);
          }

          if (finished % Math.max(1, Math.floor(CHECKPOINT_INTERVAL / 2)) === 0) {
            console.log(
              `   🧵 worker-${workerIdx} finished task=${result.taskId} (${finished}/${pendingTasks.length}) combos=${registry.size}`,
            );
          }
        }
      } finally {
        worker.terminate();
      }
    }),
  );

  saveProgress(progress);
}

function runTaskOnWorker(
  worker: Worker,
  task: PairTask,
): Promise<WorkerResultMessage | WorkerErrorMessage> {
  return new Promise((resolve) => {
    const handler = (ev: MessageEvent<WorkerResultMessage | WorkerErrorMessage>) => {
      const msg = ev.data;
      if (msg.taskId !== task.taskId) return;
      worker.removeEventListener("message", handler as EventListener);
      resolve(msg);
    };

    worker.addEventListener("message", handler as EventListener);
    const payload: WorkerTaskMessage = {
      type: "task",
      task,
      cfg: {
        samples: SAMPLES_PER_DECK,
        topK: TOP_K,
        scoreThreshold: SCORE_THRESHOLD,
        searchConfig,
        gameVersion: GAME_VERSION,
      },
    };
    worker.postMessage(payload);
  });
}

async function loadExistingCombosToRegistry(): Promise<void> {
  const existingFiles = readdirSync(OUTPUT_DIR)
    .filter((f: string) => f.startsWith("combos-") && f.endsWith(".json"));
  for (const file of existingFiles) {
    try {
      const entries: ComboEntry[] = JSON.parse(readFileSync(join(OUTPUT_DIR, file), "utf-8"));
      registry.importAll(entries);
    } catch {
      // Ignore malformed historical files.
    }
  }
}

function saveResults(tag: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `combos-${tag}-${timestamp}.json`;
  const entries = registry.exportAll();
  writeFileSync(join(OUTPUT_DIR, filename), JSON.stringify(entries, null, 2));
  console.log(`   💾 Saved ${entries.length} combos → ${filename}`);
}

main().catch((e) => {
  console.error("❌ Fatal error:", e);
  try {
    saveResults("crash-recovery");
    const fallbackProgress: ProgressV2 = {
      version: CHECKPOINT_VERSION,
      completedTaskIds: [],
      completedPairs: [],
      totalTasks: 0,
      totalCombosFound: registry.size,
      lastTimestamp: new Date().toISOString(),
    };
    saveProgress(fallbackProgress);
    console.log("   💾 Crash recovery: saved current results");
  } catch {}
  process.exit(1);
});
