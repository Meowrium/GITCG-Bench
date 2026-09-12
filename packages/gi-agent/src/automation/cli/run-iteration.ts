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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Version } from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index";
import type { BatchResult } from "../../evaluation/benchmark/sandbox-runner.js";
import {
  runBenchmarkSuite,
  type BenchmarkMatchup,
  type BenchmarkSuiteResult,
} from "../../evaluation/benchmark/benchmark-suite.js";
import { summarizeBenchmark } from "../../evaluation/benchmark/benchmark-report.js";
import {
  createBenchmarkSide,
  createBaselineSide,
  createPolicyFromConfig,
  createEvaluatorSide,
  loadBenchmarkCliConfig,
  readJsonFile,
  type BenchmarkCliMatchup,
  type BenchmarkPolicyConfig,
} from "../../evaluation/benchmark/cli-config.js";
import { DataLake } from "../../db/data-lake.js";
import { ReplayBuffer } from "../../learning/al/replay-buffer.js";
import { DeckPriorProvider } from "../../learning/features/deck-prior-provider.js";
import {
  SelfPlayCollector,
  type SelfPlayCollectionResult,
  type SelfPlayMatchup,
} from "../../learning/self-play/self-play-collector.js";
import {
  trainEvaluatorFromDataLake,
  type TrainEvaluatorConfig,
  type TrainEvaluatorResult,
} from "../../learning/training/train-evaluator.js";
import type { BaselinePolicyOptions } from "../../runtime/policy/baseline-policy.js";
import type { EvaluatorPolicyOptions } from "../../runtime/policy/evaluator-policy.js";

interface CliArgs {
  configPath: string;
  outputPath?: string;
  markdownPath?: string;
}

interface IterationCliConfig {
  benchmarkPath: string;
  targetSide?: "A" | "B";
  selfPlay?: {
    gamesMultiplier?: number;
    replayLogCapture?: {
      directory: string;
      maxGamesPerMatchup: number;
      version?: Version;
    };
    sideA?: BenchmarkPolicyConfig;
    sideB?: BenchmarkPolicyConfig;
  };
  training: TrainEvaluatorConfig;
  baselinePolicy?: {
    name?: string;
    options?: BaselinePolicyOptions;
  };
  candidatePolicy?: {
    name?: string;
    options?: EvaluatorPolicyOptions;
  };
  promoteRules?: PromotionRules;
  output?: {
    jsonPath?: string;
    markdownPath?: string;
  };
}

interface PromotionRules {
  minSampleCount?: number;
  minDeltaWinRate?: number;
  maxAllowedMatchupDrop?: number;
}

interface IterationComparisonRow {
  matchupId: string;
  baselineWinRate: number;
  candidateWinRate: number;
  deltaWinRate: number;
}

interface IterationComparison {
  targetSide: "A" | "B";
  baselineMeanWinRate: number;
  candidateMeanWinRate: number;
  deltaMeanWinRate: number;
  rows: IterationComparisonRow[];
}

interface PromotionDecision {
  recommend: "promote" | "reject";
  reasons: string[];
  rules: Required<PromotionRules>;
}

interface IterationReport {
  version: Version;
  benchmarkPath: string;
  targetSide: "A" | "B";
  selfPlay?: SelfPlayCollectionResult;
  training: TrainEvaluatorResult & {
    dbPath: string;
    stats: Record<string, number>;
  };
  baseline: {
    summary: ReturnType<typeof summarizeBenchmark>;
    targetSummary: { meanWinRate: number };
    result: BenchmarkSuiteResult;
  };
  candidate: {
    summary: ReturnType<typeof summarizeBenchmark>;
    targetSummary: { meanWinRate: number };
    result: BenchmarkSuiteResult;
  };
  comparison: IterationComparison;
  decision: PromotionDecision;
}

const DEFAULT_PROMOTION_RULES: Required<PromotionRules> = {
  minSampleCount: 500,
  minDeltaWinRate: 0.02,
  maxAllowedMatchupDrop: 0.03,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(process.cwd(), args.configPath);
  const configDir = dirname(configPath);
  const config = (await readJsonFile(configPath)) as IterationCliConfig;
  const loadedBenchmark = await loadBenchmarkCliConfig(
    resolve(configDir, config.benchmarkPath),
  );
  const data = getData(loadedBenchmark.version);
  const targetSide = config.targetSide ?? "A";
  const selfPlay = config.selfPlay
    ? await runSelfPlayCollection({
        configDir,
        loadedBenchmark,
        dbPath: resolve(configDir, config.training.dbPath),
        selfPlay: config.selfPlay,
        data,
      })
    : undefined;

  const trainingConfig = resolveTrainConfig(config.training, configDir);
  const dataLakeStats = readDataLakeStats(trainingConfig.dbPath);
  const training = trainEvaluatorFromDataLake(trainingConfig);

  // Update replay buffer with new samples after training
  if (trainingConfig.outputPath) {
    const replayPath = trainingConfig.replayBufferPath
      ? resolve(configDir, trainingConfig.replayBufferPath)
      : trainingConfig.outputPath.replace(/\.json$/, ".replay.json");
    updateReplayBuffer(trainingConfig.dbPath, replayPath, 100_000);
  }

  const baselineMatchups = buildIterationMatchups({
    matchups: loadedBenchmark.config.matchups,
    configDir: loadedBenchmark.configDir,
    targetSide,
    variant: "baseline",
    baselinePolicy: config.baselinePolicy,
  });
  const baselineResult = await runBenchmarkSuite({
    data,
    matchups: await baselineMatchups,
  });

  const candidateResult = await runBenchmarkSuite({
    data,
    matchups: await buildIterationMatchups({
      matchups: loadedBenchmark.config.matchups,
      configDir: loadedBenchmark.configDir,
      targetSide,
      variant: "evaluator",
      baselinePolicy: config.baselinePolicy,
      candidatePolicy: config.candidatePolicy,
      trained: training,
    }),
  });

  const comparison = compareForTargetSide(
    baselineResult,
    candidateResult,
    targetSide,
  );
  const decision = decidePromotion(training.sampleCount, comparison, config.promoteRules);

  const report: IterationReport = {
    version: loadedBenchmark.version,
    benchmarkPath: loadedBenchmark.configPath,
    targetSide,
    selfPlay,
    training: {
      ...training,
      dbPath: trainingConfig.dbPath,
      stats: dataLakeStats,
    },
    baseline: {
      summary: summarizeBenchmark(baselineResult),
      targetSummary: {
        meanWinRate: summarizeTargetSideWinRate(baselineResult, targetSide),
      },
      result: baselineResult,
    },
    candidate: {
      summary: summarizeBenchmark(candidateResult),
      targetSummary: {
        meanWinRate: summarizeTargetSideWinRate(candidateResult, targetSide),
      },
      result: candidateResult,
    },
    comparison,
    decision,
  };

  const jsonPath = args.outputPath ?? config.output?.jsonPath;
  const markdownPath = args.markdownPath ?? config.output?.markdownPath;

  console.log(formatIterationSummary(report));

  if (jsonPath) {
    const resolvedJsonPath = resolve(configDir, jsonPath);
    mkdirSync(dirname(resolvedJsonPath), { recursive: true });
    await writeFile(`${resolvedJsonPath}`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (markdownPath) {
    const resolvedMarkdownPath = resolve(configDir, markdownPath);
    mkdirSync(dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedMarkdownPath, `${formatIterationMarkdown(report)}\n`, "utf8");
  }
}

function parseArgs(argv: string[]): CliArgs {
  const configPath = argv[0];
  if (!configPath) {
    throw new Error(
      "Usage: pnpm exec gnx src/automation/cli/run-iteration.ts <config.json> [--output report.json] [--markdown report.md]",
    );
  }

  const args: CliArgs = { configPath };
  for (let i = 1; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--output" && next) {
      args.outputPath = next;
      i++;
      continue;
    }
    if (current === "--markdown" && next) {
      args.markdownPath = next;
      i++;
    }
  }
  return args;
}

function resolveTrainConfig(
  config: TrainEvaluatorConfig,
  configDir: string,
): TrainEvaluatorConfig {
  return {
    ...config,
    dbPath: resolve(configDir, config.dbPath),
    outputPath: config.outputPath ? resolve(configDir, config.outputPath) : undefined,
  };
}

function readDataLakeStats(dbPath: string): Record<string, number> {
  const lake = new DataLake(dbPath);
  try {
    return lake.stats();
  } finally {
    lake.close();
  }
}

async function runSelfPlayCollection(args: {
  configDir: string;
  loadedBenchmark: Awaited<ReturnType<typeof loadBenchmarkCliConfig>>;
  dbPath: string;
  selfPlay: NonNullable<IterationCliConfig["selfPlay"]>;
  data: ReturnType<typeof getData>;
}): Promise<SelfPlayCollectionResult> {
  const collector = new SelfPlayCollector();
  const matchups: SelfPlayMatchup[] = [];
  const priorProvider = new DeckPriorProvider();

  for (const matchup of args.loadedBenchmark.config.matchups) {
    if ("priorMatrix" in matchup || "priorMatrixBatch" in matchup) {
      throw new Error("Iteration self-play does not support benchmark priorMatrix or priorMatrixBatch matchups");
    }
    const sideAConfig = args.selfPlay.sideA ?? matchup.sideA;
    const sideBConfig = args.selfPlay.sideB ?? matchup.sideB;
    const policyA = await createPolicyFromConfig(
      sideAConfig,
      args.loadedBenchmark.configDir,
      {
        selfDeckCode: matchup.deck0,
        opponentDeckCode: matchup.deck1,
        priorProvider,
      },
    );
    const policyB = await createPolicyFromConfig(
      sideBConfig,
      args.loadedBenchmark.configDir,
      {
        selfDeckCode: matchup.deck1,
        opponentDeckCode: matchup.deck0,
        priorProvider,
      },
    );

    matchups.push({
      id: matchup.id,
      decks: [
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck0),
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck1),
      ],
      games: Math.max(
        1,
        Math.round(matchup.games * (args.selfPlay.gamesMultiplier ?? 1)),
      ),
      sideA: {
        name: sideAConfig.name,
        createPolicy: () => policyA,
      },
      sideB: {
        name: sideBConfig.name,
        createPolicy: () => policyB,
      },
    });
  }

  return collector.collect({
    dbPath: args.dbPath,
    data: args.data,
    matchups,
    source: "self_play",
    replayLogCapture: args.selfPlay.replayLogCapture
      ? {
          directory: resolve(args.configDir, args.selfPlay.replayLogCapture.directory),
          maxGamesPerMatchup: args.selfPlay.replayLogCapture.maxGamesPerMatchup,
          version: args.selfPlay.replayLogCapture.version ?? args.loadedBenchmark.version,
        }
      : undefined,
  });
}

async function buildIterationMatchups(args: {
  matchups: BenchmarkCliMatchup[];
  configDir: string;
  targetSide: "A" | "B";
  variant: "baseline" | "evaluator";
  baselinePolicy?: IterationCliConfig["baselinePolicy"];
  candidatePolicy?: IterationCliConfig["candidatePolicy"];
  trained?: TrainEvaluatorResult;
}): Promise<BenchmarkMatchup[]> {
  const sideToReplace = args.targetSide === "A" ? 0 : 1;
  const result: BenchmarkMatchup[] = [];
  const priorProvider = new DeckPriorProvider();

  for (const matchup of args.matchups) {
    if ("priorMatrix" in matchup || "priorMatrixBatch" in matchup) {
      throw new Error("Iteration benchmark comparison does not support benchmark priorMatrix or priorMatrixBatch matchups");
    }
    const sideA =
      sideToReplace === 0
        ? buildTargetSide(matchup.sideA, {
            side: 0,
            variant: args.variant,
            baselinePolicy: args.baselinePolicy,
            candidatePolicy: args.candidatePolicy,
            trained: args.trained,
          })
        : await createSideFromPolicy(matchup.sideA, args.configDir, 0, {
            selfDeckCode: matchup.deck0,
            opponentDeckCode: matchup.deck1,
            priorProvider,
          });

    const sideB =
      sideToReplace === 1
        ? buildTargetSide(matchup.sideB, {
            side: 1,
            variant: args.variant,
            baselinePolicy: args.baselinePolicy,
            candidatePolicy: args.candidatePolicy,
            trained: args.trained,
          })
        : await createSideFromPolicy(matchup.sideB, args.configDir, 1, {
            selfDeckCode: matchup.deck1,
            opponentDeckCode: matchup.deck0,
            priorProvider,
          });

    result.push({
      id: matchup.id,
      decks: [
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck0),
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck1),
      ],
      games: matchup.games,
      sideA,
      sideB,
    });
  }

  return result;
}

async function createSideFromPolicy(
  config: BenchmarkPolicyConfig,
  configDir: string,
  side: 0 | 1,
  priorOptions?: Parameters<typeof createPolicyFromConfig>[2],
) {
  return createBenchmarkSide(config, configDir, side, priorOptions);
}

function buildTargetSide(
  config: BenchmarkPolicyConfig,
  args: {
    side: 0 | 1;
    variant: "baseline" | "evaluator";
    baselinePolicy?: IterationCliConfig["baselinePolicy"];
    candidatePolicy?: IterationCliConfig["candidatePolicy"];
    trained?: TrainEvaluatorResult;
  },
) {
  const baselineOptions = {
    ...extractBaselineOptions(config),
    ...args.baselinePolicy?.options,
  };
  const baselineName = args.baselinePolicy?.name ?? `${config.name}-baseline`;

  if (args.variant === "baseline") {
    return createBaselineSide(baselineName, args.side, baselineOptions);
  }

  if (!args.trained) {
    throw new Error("Evaluator run requires trained weights");
  }

  return createEvaluatorSide(
    args.candidatePolicy?.name ?? `${config.name}-evaluator`,
    args.side,
    args.trained.weights,
    {
      ...baselineOptions,
      ...config.options,
      ...args.candidatePolicy?.options,
    },
  );
}

function extractBaselineOptions(
  config: BenchmarkPolicyConfig,
): BaselinePolicyOptions {
  return (config.options ?? {}) as BaselinePolicyOptions;
}

function summarizeTargetSideWinRate(
  result: BenchmarkSuiteResult,
  targetSide: "A" | "B",
): number {
  if (result.results.length === 0) return 0;

  const total = result.results.reduce((sum, row) => {
    const winRate =
      targetSide === "A"
        ? rateForSide(row.batch, 0)
        : rateForSide(row.batch, 1);
    return sum + winRate;
  }, 0);

  return total / result.results.length;
}

function compareForTargetSide(
  baseline: BenchmarkSuiteResult,
  candidate: BenchmarkSuiteResult,
  targetSide: "A" | "B",
): IterationComparison {
  const baselineMap = new Map(baseline.results.map((row) => [row.matchupId, row.batch]));
  const candidateMap = new Map(candidate.results.map((row) => [row.matchupId, row.batch]));
  const matchupIds = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])];

  const rows = matchupIds.map((matchupId) => {
    const baselineBatch = baselineMap.get(matchupId);
    const candidateBatch = candidateMap.get(matchupId);
    const baselineWinRate = baselineBatch
      ? rateForSide(baselineBatch, targetSide === "A" ? 0 : 1)
      : 0;
    const candidateWinRate = candidateBatch
      ? rateForSide(candidateBatch, targetSide === "A" ? 0 : 1)
      : 0;

    return {
      matchupId,
      baselineWinRate,
      candidateWinRate,
      deltaWinRate: candidateWinRate - baselineWinRate,
    };
  });

  const baselineMeanWinRate = summarizeTargetSideWinRate(baseline, targetSide);
  const candidateMeanWinRate = summarizeTargetSideWinRate(candidate, targetSide);

  return {
    targetSide,
    baselineMeanWinRate,
    candidateMeanWinRate,
    deltaMeanWinRate: candidateMeanWinRate - baselineMeanWinRate,
    rows,
  };
}

function rateForSide(batch: BatchResult, side: 0 | 1): number {
  if (batch.total === 0) return 0;
  return side === 0 ? batch.winsP0 / batch.total : batch.winsP1 / batch.total;
}

function decidePromotion(
  sampleCount: number,
  comparison: IterationComparison,
  rules?: PromotionRules,
): PromotionDecision {
  const mergedRules = { ...DEFAULT_PROMOTION_RULES, ...rules };
  const reasons: string[] = [];
  let recommend: PromotionDecision["recommend"] = "promote";

  if (sampleCount < mergedRules.minSampleCount) {
    recommend = "reject";
    reasons.push(
      `sampleCount ${sampleCount} < minSampleCount ${mergedRules.minSampleCount}`,
    );
  }

  if (comparison.deltaMeanWinRate < mergedRules.minDeltaWinRate) {
    recommend = "reject";
    reasons.push(
      `deltaMeanWinRate ${(comparison.deltaMeanWinRate * 100).toFixed(2)}% < minDeltaWinRate ${(mergedRules.minDeltaWinRate * 100).toFixed(2)}%`,
    );
  }

  const worstDrop = Math.min(...comparison.rows.map((row) => row.deltaWinRate), 0);
  if (Math.abs(worstDrop) > mergedRules.maxAllowedMatchupDrop) {
    recommend = "reject";
    reasons.push(
      `worstMatchupDrop ${(worstDrop * 100).toFixed(2)}% exceeds maxAllowedMatchupDrop ${(mergedRules.maxAllowedMatchupDrop * 100).toFixed(2)}%`,
    );
  }

  if (reasons.length === 0) {
    reasons.push("all promotion gates passed");
  }

  return {
    recommend,
    reasons,
    rules: mergedRules,
  };
}

function formatIterationSummary(report: IterationReport): string {
  return [
    `Iteration benchmark: ${report.benchmarkPath}`,
    `Target side: ${report.targetSide}`,
    `Samples: ${report.training.sampleCount}`,
    ...(report.selfPlay
      ? [`Self-play inserted samples: ${report.selfPlay.insertedSamples}`]
      : []),
    `Baseline mean win rate: ${(report.comparison.baselineMeanWinRate * 100).toFixed(2)}%`,
    `Candidate mean win rate: ${(report.comparison.candidateMeanWinRate * 100).toFixed(2)}%`,
    `Delta: ${(report.comparison.deltaMeanWinRate * 100).toFixed(2)}%`,
    `Decision: ${report.decision.recommend}`,
  ].join("\n");
}

function formatIterationMarkdown(report: IterationReport): string {
  const lines = [
    `# Iteration Report (${report.version})`,
    "",
    `- Benchmark config: ${report.benchmarkPath}`,
    `- Target side: ${report.targetSide}`,
    ...(report.selfPlay
      ? [
          `- Self-play games: ${report.selfPlay.totalGames}`,
          `- Self-play inserted samples: ${report.selfPlay.insertedSamples}`,
          `- Self-play skipped samples: ${report.selfPlay.skippedSamples}`,
        ]
      : []),
    `- Samples: ${report.training.sampleCount}`,
    `- DataLake stats: ${formatStats(report.training.stats)}`,
    `- Decision: ${report.decision.recommend}`,
    `- Reasons: ${report.decision.reasons.join("; ")}`,
    "",
    "## Training",
    "",
    `- Weights output: ${report.training.outputPath ?? "(not written)"}`,
    `- Accuracy: ${(report.training.weights.meta.accuracy * 100).toFixed(2)}%`,
    `- Final loss: ${report.training.weights.meta.finalLoss.toFixed(6)}`,
    "",
    "## Comparison",
    "",
    `- Baseline mean win rate: ${(report.comparison.baselineMeanWinRate * 100).toFixed(2)}%`,
    `- Candidate mean win rate: ${(report.comparison.candidateMeanWinRate * 100).toFixed(2)}%`,
    `- Delta mean win rate: ${(report.comparison.deltaMeanWinRate * 100).toFixed(2)}%`,
    "",
    "| Matchup | Baseline | Candidate | Delta |",
    "|---|---:|---:|---:|",
    ...report.comparison.rows.map(
      (row) =>
        `| ${row.matchupId} | ${(row.baselineWinRate * 100).toFixed(2)}% | ${(row.candidateWinRate * 100).toFixed(2)}% | ${(row.deltaWinRate * 100).toFixed(2)}% |`,
    ),
  ];

  return lines.join("\n");
}

function formatStats(stats: Record<string, number>): string {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function updateReplayBuffer(
  dbPath: string,
  replayPath: string,
  maxSize: number,
): void {
  const lake = new DataLake(dbPath)
  try {
    let existing: ReplayBuffer
    if (existsSync(replayPath)) {
      const data = JSON.parse(readFileSync(replayPath, "utf-8"))
      existing = ReplayBuffer.fromJSON(data, maxSize)
    } else {
      existing = new ReplayBuffer(maxSize)
    }
    const newSamples = lake.loadAll()
    existing.add(newSamples)
    mkdirSync(dirname(replayPath), { recursive: true })
    writeFileSync(replayPath, JSON.stringify(existing.toJSON(), null, 2), "utf-8")
    console.log(`[iterate] Replay buffer updated: ${existing.size} total samples`)
  } finally {
    lake.close()
  }
}

await main();
