/**
 * SandboxRunner — Batch game runner using @gi-tcg/core Game class directly.
 *
 * Runs headless games between two PlayerIO implementations for:
 * - Self-play data collection
 * - Strategy evaluation (win-rate benchmarking)
 * - Regression testing of scoring changes
 *
 * Games run in the main thread (Worker Threads can be added later for
 * parallelism, but single-threaded perf is typically sufficient).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_VERSION, Game, serializeGameStateLog } from "@gi-tcg/core";
import type { GameStateLogEntry, PlayerIO, Version } from "@gi-tcg/core";
import type { CreateInitialStateConfig, DeckConfig } from "@gi-tcg/core";
import type { GameData } from "@gi-tcg/core";
import type { PolicyPlayerGameContext } from "../runtime/io/policy-player-io.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RunConfig {
  /** Decks for both players. */
  decks: readonly [DeckConfig, DeckConfig];
  /** Game data (card definitions etc). */
  data: GameData;
  /** PlayerIO factories — called fresh per game. */
  createPlayerIO: readonly [() => PlayerIO, () => PlayerIO];
  /** Number of games to run. */
  games: number;
  /** 若设置，第 i 局的随机种子 = seedBase + i（确定性复跑用）。 */
  seedBase?: number;
  /** Optional: callback after each game for progress tracking. */
  onGameComplete?: (result: GameResult, index: number) => void;
  /** Optional: save the first N games as standalone-compatible gameLog.json files. */
  replayLogCapture?: {
    directory: string;
    matchupId: string;
    maxGames: number;
    version: Version;
  };
}

export interface GameResult {
  /** Which player won: 0, 1, or null for draw/error. */
  winner: 0 | 1 | null;
  /** Total rounds played. */
  rounds: number;
  /** Elapsed time in ms. */
  elapsedMs: number;
  /** Optional path to a saved standalone-compatible replay log. */
  replayPath?: string;
}

export interface BatchResult {
  /** Total games run. */
  total: number;
  /** Wins for player 0. */
  winsP0: number;
  /** Wins for player 1. */
  winsP1: number;
  /** Draws or errors. */
  draws: number;
  /** Win rate of player 0. */
  winRateP0: number;
  /** Average rounds per game. */
  avgRounds: number;
  /** Average game duration in ms. */
  avgElapsedMs: number;
  /** Individual results. */
  results: GameResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

export class SandboxRunner {
  /**
   * Run a single headless game.
   */
  async runOne(
    decks: readonly [DeckConfig, DeckConfig],
    data: GameData,
    ios: readonly [PlayerIO, PlayerIO],
    options?: {
      captureReplay?: boolean;
      replayVersion?: Version;
      /** 开局机制行为版本（CreateInitialStateConfig.versionBehavior，接受 Version 字符串）；
          缺省不传 = CURRENT_VERSION，与现状完全一致。 */
      versionBehavior?: Version;
      /** 固定随机性：randomSeed = seed，两副牌 shuffleSeed = seed+1 / seed+2 */
      seed?: number;
    },
  ): Promise<GameResult & { replayLogJson?: ReturnType<typeof serializeGameStateLog> & { gv: Version } }> {
    const start = performance.now();
    const stateLog: GameStateLogEntry[] = [];

    const seededDecks = options?.seed !== undefined
      ? ([
          { ...decks[0], shuffleSeed: options.seed + 1 },
          { ...decks[1], shuffleSeed: options.seed + 2 },
        ] as const)
      : decks;
    const initialState = Game.createInitialState({
      decks: seededDecks,
      data,
      ...(options?.seed !== undefined ? { randomSeed: options.seed } : {}),
      ...(options?.versionBehavior !== undefined ? { versionBehavior: options.versionBehavior } : {}),
    });

    const game = new Game(initialState);
    const gameContext: PolicyPlayerGameContext = {
      data,
      stateProvider: () => game.state,
    }
    if (options?.captureReplay) {
      game.onPause = async (state, mutations, canResume) => {
        // P0-1 写入端补采（WP2）：mutations 一并进 state log（序列化为 `e` 字段）。
        // 纯写入端：只落盘，不触碰任何决策路径（PlanPlayerIO.notify 仍只读 state）。
        stateLog.push({ state, canResume, mutations });
      };
    }
    attachGameContextIfSupported(ios[0], gameContext)
    attachGameContextIfSupported(ios[1], gameContext)
    game.players[0].io = ios[0];
    game.players[1].io = ios[1];

    const winner = await game.start();
    const elapsed = performance.now() - start;

    return {
      winner: winner as 0 | 1 | null,
      rounds: game.state.roundNumber ?? 0,
      elapsedMs: Math.round(elapsed),
      ...(options?.captureReplay
        ? {
            replayLogJson: {
              ...serializeGameStateLog(stateLog),
              gv: options.replayVersion ?? CURRENT_VERSION,
            },
          }
        : {}),
    };
  }

  /**
   * Run a batch of games and aggregate statistics.
   */
  async runBatch(config: RunConfig): Promise<BatchResult> {
    const results: GameResult[] = [];
    let winsP0 = 0;
    let winsP1 = 0;
    let draws = 0;
    let totalRounds = 0;
    let totalMs = 0;

    for (let i = 0; i < config.games; i++) {
      const io0 = config.createPlayerIO[0]();
      const io1 = config.createPlayerIO[1]();

      const shouldCaptureReplay = i < (config.replayLogCapture?.maxGames ?? 0);
      const result = await this.runOne(config.decks, config.data, [io0, io1], {
        captureReplay: shouldCaptureReplay,
        replayVersion: config.replayLogCapture?.version,
        ...(config.seedBase !== undefined ? { seed: config.seedBase + i } : {}),
      });
      let replayPath: string | undefined;
      if (shouldCaptureReplay && result.replayLogJson && config.replayLogCapture) {
        const matchupDir = join(
          config.replayLogCapture.directory,
          sanitizePathSegment(config.replayLogCapture.matchupId),
        );
        await mkdir(matchupDir, { recursive: true });
        replayPath = join(
          matchupDir,
          `game-${String(i + 1).padStart(4, "0")}-${formatWinner(result.winner)}.json`,
        );
        await writeFile(replayPath, `${JSON.stringify(result.replayLogJson)}\n`, "utf8");
      }

      const publicResult: GameResult = {
        winner: result.winner,
        rounds: result.rounds,
        elapsedMs: result.elapsedMs,
        ...(replayPath ? { replayPath } : {}),
      };
      results.push(publicResult);

      if (publicResult.winner === 0) winsP0++;
      else if (publicResult.winner === 1) winsP1++;
      else draws++;

      totalRounds += publicResult.rounds;
      totalMs += publicResult.elapsedMs;

      config.onGameComplete?.(publicResult, i);
    }

    const total = config.games;
    return {
      total,
      winsP0,
      winsP1,
      draws,
      winRateP0: total > 0 ? winsP0 / total : 0,
      avgRounds: total > 0 ? totalRounds / total : 0,
      avgElapsedMs: total > 0 ? totalMs / total : 0,
      results,
    };
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function formatWinner(winner: 0 | 1 | null): string {
  if (winner === 0) return "p0";
  if (winner === 1) return "p1";
  return "draw";
}

function attachGameContextIfSupported(
  io: PlayerIO,
  context: PolicyPlayerGameContext,
) {
  const candidate = io as PlayerIO & {
    attachGameContext?: (context: PolicyPlayerGameContext) => void
  }
  candidate.attachGameContext?.(context)
}
