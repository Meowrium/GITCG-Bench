// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { DeckConfig, GameData, PlayerIO, Version } from "@gi-tcg/core";
import { SandboxRunner, type BatchResult } from "./sandbox-runner.js";

export interface BenchmarkSide {
  name: string;
  createPlayerIO: () => PlayerIO;
}

export interface BenchmarkMatchup {
  id: string;
  decks: readonly [DeckConfig, DeckConfig];
  games: number;
  sideA: BenchmarkSide;
  sideB: BenchmarkSide;
  sampleReplay?: {
    directory: string;
    maxGames: number;
    version: Version;
  };
}

export interface BenchmarkSuiteConfig {
  data: GameData;
  matchups: BenchmarkMatchup[];
}

export interface BenchmarkMatchupResult {
  matchupId: string;
  sideAName: string;
  sideBName: string;
  batch: BatchResult;
}

export interface BenchmarkSuiteResult {
  totalMatchups: number;
  totalGames: number;
  results: BenchmarkMatchupResult[];
}

export async function runBenchmarkSuite(
  config: BenchmarkSuiteConfig,
  runner: SandboxRunner = new SandboxRunner(),
): Promise<BenchmarkSuiteResult> {
  const results: BenchmarkMatchupResult[] = [];
  let totalGames = 0;

  for (const matchup of config.matchups) {
    const batch = await runner.runBatch({
      decks: matchup.decks,
      data: config.data,
      createPlayerIO: [
        matchup.sideA.createPlayerIO,
        matchup.sideB.createPlayerIO,
      ],
      games: matchup.games,
      replayLogCapture: matchup.sampleReplay
        ? {
            directory: matchup.sampleReplay.directory,
            matchupId: matchup.id,
            maxGames: matchup.sampleReplay.maxGames,
            version: matchup.sampleReplay.version,
          }
        : undefined,
    });

    totalGames += batch.total;
    results.push({
      matchupId: matchup.id,
      sideAName: matchup.sideA.name,
      sideBName: matchup.sideB.name,
      batch,
    });
  }

  return {
    totalMatchups: results.length,
    totalGames,
    results,
  };
}
