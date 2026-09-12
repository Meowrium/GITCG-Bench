// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type {
  BenchmarkMatchupResult,
  BenchmarkSuiteResult,
} from "./benchmark-suite.js";

export interface BenchmarkSummary {
  totalMatchups: number;
  totalGames: number;
  meanWinRateA: number;
  meanRounds: number;
  meanElapsedMs: number;
}

export interface BenchmarkComparisonRow {
  matchupId: string;
  baselineWinRateA: number;
  candidateWinRateA: number;
  deltaWinRateA: number;
}

export interface BenchmarkComparison {
  summary: {
    baselineMeanWinRateA: number;
    candidateMeanWinRateA: number;
    deltaMeanWinRateA: number;
  };
  rows: BenchmarkComparisonRow[];
}

export function summarizeBenchmark(result: BenchmarkSuiteResult): BenchmarkSummary {
  if (result.results.length === 0) {
    return {
      totalMatchups: 0,
      totalGames: 0,
      meanWinRateA: 0,
      meanRounds: 0,
      meanElapsedMs: 0,
    };
  }

  let totalWinRate = 0;
  let totalRounds = 0;
  let totalElapsedMs = 0;

  for (const row of result.results) {
    totalWinRate += row.batch.winRateP0;
    totalRounds += row.batch.avgRounds;
    totalElapsedMs += row.batch.avgElapsedMs;
  }

  return {
    totalMatchups: result.totalMatchups,
    totalGames: result.totalGames,
    meanWinRateA: totalWinRate / result.results.length,
    meanRounds: totalRounds / result.results.length,
    meanElapsedMs: totalElapsedMs / result.results.length,
  };
}

export function compareBenchmarks(
  baseline: BenchmarkSuiteResult,
  candidate: BenchmarkSuiteResult,
): BenchmarkComparison {
  const baselineMap = new Map<string, BenchmarkMatchupResult>(
    baseline.results.map((r) => [r.matchupId, r]),
  );
  const candidateMap = new Map<string, BenchmarkMatchupResult>(
    candidate.results.map((r) => [r.matchupId, r]),
  );

  const allIds = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])];
  const rows: BenchmarkComparisonRow[] = allIds.map((id) => {
    const base = baselineMap.get(id)?.batch.winRateP0 ?? 0;
    const cand = candidateMap.get(id)?.batch.winRateP0 ?? 0;
    return {
      matchupId: id,
      baselineWinRateA: base,
      candidateWinRateA: cand,
      deltaWinRateA: cand - base,
    };
  });

  const baselineSummary = summarizeBenchmark(baseline);
  const candidateSummary = summarizeBenchmark(candidate);

  return {
    summary: {
      baselineMeanWinRateA: baselineSummary.meanWinRateA,
      candidateMeanWinRateA: candidateSummary.meanWinRateA,
      deltaMeanWinRateA:
        candidateSummary.meanWinRateA - baselineSummary.meanWinRateA,
    },
    rows,
  };
}

export function formatBenchmarkComparisonMarkdown(
  comparison: BenchmarkComparison,
): string {
  const lines = [
    "# Benchmark Comparison",
    "",
    `- Baseline mean win rate A: ${(comparison.summary.baselineMeanWinRateA * 100).toFixed(2)}%`,
    `- Candidate mean win rate A: ${(comparison.summary.candidateMeanWinRateA * 100).toFixed(2)}%`,
    `- Delta mean win rate A: ${(comparison.summary.deltaMeanWinRateA * 100).toFixed(2)}%`,
    "",
    "| Matchup | Baseline | Candidate | Delta |",
    "|---|---:|---:|---:|",
    ...comparison.rows.map(
      (row) =>
        `| ${row.matchupId} | ${(row.baselineWinRateA * 100).toFixed(2)}% | ${(row.candidateWinRateA * 100).toFixed(2)}% | ${(row.deltaWinRateA * 100).toFixed(2)}% |`,
    ),
  ];

  return lines.join("\n");
}
