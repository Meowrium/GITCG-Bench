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

import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Version } from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import {
  formatBenchmarkComparisonMarkdown,
  summarizeBenchmark,
} from "../benchmark-report.js";
import type { BenchmarkSuiteResult } from "../benchmark-suite.js";
import { runBenchmarkSuite } from "../benchmark-suite.js";
import {
  buildBenchmarkExecutionPlans,
  buildBenchmarkMatchups,
  buildBenchmarkMatchupsFromPlans,
  loadBenchmarkCliConfig,
  type BenchmarkCliDeckEntry,
  type BenchmarkCliMatchup,
  type BenchmarkCliPriorMatrixBatchMatchup,
  type BenchmarkCliPriorMatrixMatchup,
} from "../cli-config.js";
import { resolveCliPath } from "../cli-path";

interface CliArgs {
  configPath: string;
  outputPath?: string;
  outputDir?: string;
  markdownPath?: string;
  concurrency: number;
  sampleLogsDir?: string;
  sampleLogsPerMatchup?: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadBenchmarkCliConfig(resolveCliPath(args.configPath));
  const version = loaded.version;
  const plans = buildBenchmarkExecutionPlans(loaded.config).map((plan) => ({
    ...plan,
    ...(args.sampleLogsDir && args.sampleLogsPerMatchup && args.sampleLogsPerMatchup > 0
      ? {
          sampleReplay: {
            directory: args.sampleLogsDir,
            maxGames: args.sampleLogsPerMatchup,
            version,
          },
        }
      : {}),
  }));
  const result = await runBenchmarkWithConcurrency({
    version,
    configDir: loaded.configDir,
    plans,
    concurrency: args.concurrency,
  });
  const summary = summarizeBenchmark(result);
  const generatedAt = new Date().toISOString();
  const matchups = flattenMatchups(result);
  const priorMatrix = buildPriorMatrixReport(loaded.config.matchups, result);
  const output = {
    generatedAt,
    version,
    summary,
    matchups,
    result,
    priorMatrix,
  };

  console.log(formatSuiteSummary(result, version, summary, priorMatrix));

  // ── Machine-parseable JSON block for watchdog scripts ──
  const machineJson = { generatedAt, version, summary, matchups, priorMatrix };
  console.log("\n===RESULT_START===");
  console.log(JSON.stringify(machineJson));
  console.log("===RESULT_END===\n");

  // Resolve output path: --output takes priority, then --output-dir, then none (console only)
  const resolvedOutputPath = (() => {
    if (args.outputPath) return resolveCliPath(args.outputPath);
    if (args.outputDir) {
      const dir = resolveCliPath(args.outputDir);
      const ts = generatedAt.replace(/[:.]/g, "-");
      return join(dir, `benchmark-${ts}.json`);
    }
    return undefined;
  })();

  if (resolvedOutputPath) {
    await mkdir(join(resolvedOutputPath, ".."), { recursive: true });
    await writeFile(
      resolvedOutputPath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
  }

  if (args.markdownPath) {
    await writeFile(
      resolveCliPath(args.markdownPath),
      `${formatSuiteMarkdown(result, version, summary, priorMatrix)}\n`,
      "utf8",
    );
  }
}

function parseArgs(argv: string[]): CliArgs {
  const configPath = argv[0];
  if (!configPath) {
    throw new Error(
      "Usage: pnpm exec gnx src/evaluation/benchmark/cli/run-benchmark.ts <config.json> [--output result.json] [--output-dir bench-results/] [--markdown report.md] [--concurrency N] [--sample-logs-dir DIR] [--sample-logs-per-matchup N]",
    );
  }

  const args: CliArgs = {
    configPath,
    concurrency: 1,
    // Default: persist results to bench-results/ for host machine access
    outputDir: "bench-results",
    // Default: always save sample logs for debug analysis
    sampleLogsDir: "output/benchmark-logs",
    sampleLogsPerMatchup: 3,
  };
  for (let i = 1; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--output" && next) {
      args.outputPath = next;
      i++;
      continue;
    }
    if (current === "--output-dir" && next) {
      args.outputDir = next;
      i++;
      continue;
    }
    if (current === "--markdown" && next) {
      args.markdownPath = next;
      i++;
      continue;
    }
    if (current === "--concurrency" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --concurrency value: ${next}`);
      }
      args.concurrency = parsed;
      i++;
      continue;
    }
    if (current === "--sample-logs-dir" && next) {
      args.sampleLogsDir = resolveCliPath(next);
      i++;
      continue;
    }
    if (current === "--sample-logs-per-matchup" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --sample-logs-per-matchup value: ${next}`);
      }
      args.sampleLogsPerMatchup = parsed;
      i++;
      continue;
    }
  }

  return args;
}

async function runBenchmarkWithConcurrency(args: {
  version: Version;
  configDir: string;
  plans: ReturnType<typeof buildBenchmarkExecutionPlans>;
  concurrency: number;
}): Promise<BenchmarkSuiteResult> {
  if (args.concurrency <= 1 || args.plans.length <= 1) {
    const data = getData(args.version);
    const matchups = await buildBenchmarkMatchupsFromPlans(args.plans, args.configDir);
    return runBenchmarkSuite({
      data,
      matchups,
    });
  }

  const workerCount = Math.max(
    1,
    Math.min(args.concurrency, args.plans.length, availableParallelism()),
  );
  if (workerCount === 1) {
    const data = getData(args.version);
    const matchups = await buildBenchmarkMatchupsFromPlans(args.plans, args.configDir);
    return runBenchmarkSuite({
      data,
      matchups,
    });
  }

  const workerModule = new URL("./run-benchmark-worker.ts", import.meta.url);
  const { Worker } = await import("node:worker_threads");
  const shards = shardPlans(args.plans, workerCount);
  const results = await Promise.all(
    shards.map(
      (plans) =>
        new Promise<BenchmarkSuiteResult>((resolveWorker, rejectWorker) => {
          const worker = new Worker(workerModule, {
            workerData: {
              version: args.version,
              configDir: args.configDir,
              plans,
            },
          });
          worker.once("message", (message: BenchmarkSuiteResult) => resolveWorker(message));
          worker.once("error", rejectWorker);
          worker.once("exit", (code) => {
            if (code !== 0) {
              rejectWorker(new Error(`Benchmark worker exited with code ${code}`));
            }
          });
        }),
    ),
  );

  return mergeBenchmarkSuiteResults(results);
}

function shardPlans(
  plans: ReturnType<typeof buildBenchmarkExecutionPlans>,
  shardCount: number,
) {
  const shards = Array.from({ length: shardCount }, () => [] as typeof plans);
  for (let i = 0; i < plans.length; i++) {
    shards[i % shardCount]?.push(plans[i]!);
  }
  return shards.filter((shard) => shard.length > 0);
}

function mergeBenchmarkSuiteResults(results: BenchmarkSuiteResult[]): BenchmarkSuiteResult {
  const mergedRows = results.flatMap((result) => result.results);
  return {
    totalMatchups: mergedRows.length,
    totalGames: results.reduce((sum, result) => sum + result.totalGames, 0),
    results: mergedRows,
  };
}

function flattenMatchups(
  result: BenchmarkSuiteResult,
): Array<{
  matchupId: string;
  sideAName: string;
  sideBName: string;
  total: number;
  winsP0: number;
  winsP1: number;
  draws: number;
  winRateP0: number;
  avgRounds: number;
  avgElapsedMs: number;
}> {
  return result.results.map((r) => ({
    matchupId: r.matchupId,
    sideAName: r.sideAName,
    sideBName: r.sideBName,
    total: r.batch.total,
    winsP0: r.batch.winsP0,
    winsP1: r.batch.winsP1,
    draws: r.batch.draws,
    winRateP0: r.batch.winRateP0,
    avgRounds: r.batch.avgRounds,
    avgElapsedMs: r.batch.avgElapsedMs,
  }));
}

function formatSuiteSummary(
  result: BenchmarkSuiteResult,
  version: Version,
  summary: ReturnType<typeof summarizeBenchmark>,
  priorMatrix: ReturnType<typeof buildPriorMatrixReport>,
): string {
  const lines = [
    `Benchmark version: ${version}`,
    `Matchups: ${summary.totalMatchups}`,
    `Games: ${summary.totalGames}`,
    `Mean win rate A: ${(summary.meanWinRateA * 100).toFixed(2)}%`,
    `Mean rounds: ${summary.meanRounds.toFixed(2)}`,
    `Mean elapsed ms: ${summary.meanElapsedMs.toFixed(2)}`,
    "",
    ...result.results.map(
      (row) =>
        `${row.matchupId}: ${row.sideAName} vs ${row.sideBName} -> ${(row.batch.winRateP0 * 100).toFixed(2)}% (${row.batch.winsP0}-${row.batch.winsP1}-${row.batch.draws})`,
    ),
  ];

  if (priorMatrix.length > 0) {
    lines.push("", ...priorMatrix.flatMap(formatPriorMatrixSummary));
  }

  return lines.join("\n");
}

function formatSuiteMarkdown(
  result: BenchmarkSuiteResult,
  version: Version,
  summary: ReturnType<typeof summarizeBenchmark>,
  priorMatrix: ReturnType<typeof buildPriorMatrixReport>,
): string {
  const matchupRows = result.results.map(
    (row) =>
      `| ${row.matchupId} | ${row.sideAName} | ${row.sideBName} | ${(row.batch.winRateP0 * 100).toFixed(2)}% | ${row.batch.winsP0}-${row.batch.winsP1}-${row.batch.draws} | ${row.batch.avgRounds.toFixed(2)} | ${row.batch.avgElapsedMs.toFixed(2)} |`,
  )

  return [
    `# Benchmark Suite (${version})`,
    "",
    `- Matchups: ${summary.totalMatchups}`,
    `- Games: ${summary.totalGames}`,
    `- Mean win rate A: ${(summary.meanWinRateA * 100).toFixed(2)}%`,
    `- Mean rounds: ${summary.meanRounds.toFixed(2)}`,
    `- Mean elapsed ms: ${summary.meanElapsedMs.toFixed(2)}`,
    "",
    "## Matchup Results",
    "",
    "| Matchup | Side A | Side B | Win Rate A | Record | Avg Rounds | Avg Elapsed Ms |",
    "|---|---|---|---:|---:|---:|---:|",
    ...matchupRows,
    ...(priorMatrix.length > 0
      ? priorMatrix.flatMap((matrix) => ["", ...formatPriorMatrixMarkdown(matrix)])
      : []),
  ].join("\n");
}

function buildPriorMatrixReport(
  matchups: BenchmarkCliMatchup[],
  result: Awaited<ReturnType<typeof runBenchmarkSuite>>,
) {
  const rowsById = new Map(result.results.map((row) => [row.matchupId, row]));
  const descriptors = matchups.flatMap((matchup) => buildPriorMatrixDescriptors(matchup));

  return descriptors.map((matrix) => {
    const priorLabel = matrix.priorMatrix.priorLabel ?? "prior";
    const deck0Name = matrix.deck0Name;
    const deck1Name = matrix.deck1Name;
    const cells = {
      none_none: 0,
      prior_none: 0,
      none_prior: 0,
      prior_prior: 0,
    };

    for (const [keyA, labelA] of [["none", "none"], ["prior", priorLabel]] as const) {
      for (const [keyB, labelB] of [["none", "none"], ["prior", priorLabel]] as const) {
        const matchupId = `${matrix.id}::A-${labelA}::B-${labelB}`;
        const winRate = rowsById.get(matchupId)?.batch.winRateP0 ?? 0;
        const key = `${keyA}_${keyB}` as keyof typeof cells;
        cells[key] = winRate;
      }
    }

    return {
      matchupId: matrix.id,
      deck0Name,
      deck1Name,
      priorLabel,
      cells,
    };
  });
}

function buildPriorMatrixDescriptors(
  matchup: BenchmarkCliMatchup,
): Array<{
  id: string;
  deck0Name: string;
  deck1Name: string;
  priorMatrix: BenchmarkCliPriorMatrixMatchup["priorMatrix"];
}> {
  if ("priorMatrix" in matchup) {
    return [
      {
        id: matchup.id,
        deck0Name: matchup.deck0Name ?? "Deck 0",
        deck1Name: matchup.deck1Name ?? "Deck 1",
        priorMatrix: matchup.priorMatrix,
      },
    ];
  }

  if (!("priorMatrixBatch" in matchup)) {
    return [];
  }

  return buildDeckEntryPairs(matchup.priorMatrixBatch.decks, {
    includeMirrors: matchup.priorMatrixBatch.includeMirrors,
    includeReverse: matchup.priorMatrixBatch.includeReverse,
  }).map((pair) => ({
    id: `${matchup.id}::${pair.deck0.id}-vs-${pair.deck1.id}`,
    deck0Name: pair.deck0.name ?? pair.deck0.id,
    deck1Name: pair.deck1.name ?? pair.deck1.id,
    priorMatrix: matchup.priorMatrixBatch,
  }));
}

function buildDeckEntryPairs(
  decks: BenchmarkCliDeckEntry[],
  options: Pick<BenchmarkCliPriorMatrixBatchMatchup["priorMatrixBatch"], "includeMirrors" | "includeReverse">,
): Array<{
  deck0: BenchmarkCliDeckEntry;
  deck1: BenchmarkCliDeckEntry;
}> {
  const includeMirrors = options.includeMirrors ?? false;
  const includeReverse = options.includeReverse ?? true;
  const result: Array<{
    deck0: BenchmarkCliDeckEntry;
    deck1: BenchmarkCliDeckEntry;
  }> = [];

  for (let i = 0; i < decks.length; i++) {
    const deck0 = decks[i];
    if (!deck0) {
      continue;
    }

    const start = includeMirrors ? i : i + 1;
    for (let j = start; j < decks.length; j++) {
      const deck1 = decks[j];
      if (!deck1) {
        continue;
      }

      result.push({ deck0, deck1 });
      if (includeReverse && i !== j) {
        result.push({ deck0: deck1, deck1: deck0 });
      }
    }
  }

  return result;
}

function formatPriorMatrixSummary(matrix: ReturnType<typeof buildPriorMatrixReport>[number]): string[] {
  const rowHeader = `${matrix.deck0Name} \\ ${matrix.deck1Name}`;
  const noneValue = formatPercent(matrix.cells.none_none);
  const nonePriorValue = formatPercent(matrix.cells.none_prior);
  const priorNoneValue = formatPercent(matrix.cells.prior_none);
  const priorPriorValue = formatPercent(matrix.cells.prior_prior);
  const col1Width = Math.max(rowHeader.length, "none".length, matrix.priorLabel.length);
  const col2Width = Math.max("none".length, noneValue.length, priorNoneValue.length);
  const col3Width = Math.max(matrix.priorLabel.length, nonePriorValue.length, priorPriorValue.length);

  return [
    `Prior matrix: ${matrix.matchupId}`,
    `${matrix.deck0Name} vs ${matrix.deck1Name}`,
    "",
    formatAsciiRow([rowHeader, "none", matrix.priorLabel], [col1Width, col2Width, col3Width]),
    formatAsciiRule([col1Width, col2Width, col3Width]),
    formatAsciiRow(["none", noneValue, nonePriorValue], [col1Width, col2Width, col3Width]),
    formatAsciiRow([matrix.priorLabel, priorNoneValue, priorPriorValue], [col1Width, col2Width, col3Width]),
  ];
}

function formatPriorMatrixMarkdown(matrix: ReturnType<typeof buildPriorMatrixReport>[number]): string[] {
  return [
    `## Prior Matrix: ${matrix.matchupId}`,
    "",
    `- Deck A: ${matrix.deck0Name}`,
    `- Deck B: ${matrix.deck1Name}`,
    "",
    `| ${matrix.deck0Name} \\ ${matrix.deck1Name} | none | ${matrix.priorLabel} |`,
    "|---|---:|---:|",
    `| none | ${(matrix.cells.none_none * 100).toFixed(2)}% | ${(matrix.cells.none_prior * 100).toFixed(2)}% |`,
    `| ${matrix.priorLabel} | ${(matrix.cells.prior_none * 100).toFixed(2)}% | ${(matrix.cells.prior_prior * 100).toFixed(2)}% |`,
  ];
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatAsciiRow(values: string[], widths: number[]): string {
  return values
    .map((value, index) => ` ${value.padEnd(widths[index] ?? value.length)} `)
    .join("|");
}

function formatAsciiRule(widths: number[]): string {
  return widths.map((width) => "-".repeat(width + 2)).join("+");
}

await main();
