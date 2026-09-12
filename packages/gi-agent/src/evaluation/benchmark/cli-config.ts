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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CURRENT_VERSION, type Version } from "@gi-tcg/core";
import type { CalibratedWeights } from "../../learning/scoring/logistic-reg.js";
import { DeckPriorProvider } from "../../learning/features/deck-prior-provider.js";
import { LlmDeckPriorProvider } from "../../learning/features/llm-deck-prior-provider.js";
import type { DeckPriorFeatureVector } from "../../runtime/policy/prior-types.js";
import type { BenchmarkMatchup, BenchmarkSide } from "./benchmark-suite.js";
import { PolicyPlayerIO } from "../../runtime/io/policy-player-io.js";
import type { PolicyPlayerSearchOptions } from "../../runtime/io/policy-player-io.js";
import type { PlanPhase } from "../../runtime/plan/types.js";
import {
  BaselinePolicy,
  type BaselinePolicyOptions,
} from "../../runtime/policy/baseline-policy.js";
import {
  EvaluatorPolicy,
  type EvaluatorPolicyOptions,
} from "../../runtime/policy/evaluator-policy.js";
import {
  NeuralEvaluatorPolicy,
  type NeuralEvaluatorPolicyOptions,
} from "../../runtime/policy/neural-evaluator-policy.js";
import {
  GiMlPolicy,
  type GiMlPolicyOptions,
} from "../../runtime/policy/gi-ml-policy.js";
import { MctsPolicy } from "../../runtime/policy/mcts-policy.js";
import { GiMlMctsPolicy, type GiMlMctsPolicyOptions } from "../../runtime/policy/gi-ml-mcts-policy.js";
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index";
import { resolveCliPath } from "./cli-path";

export interface BenchmarkCliConfig {
  version?: Version;
  matchups: BenchmarkCliMatchup[];
}

export interface BenchmarkCliDeckEntry {
  id: string;
  deckCode: string;
  name?: string;
}

interface BenchmarkCliMatchupBase {
  id: string;
  deck0: string;
  deck1: string;
  deck0Name?: string;
  deck1Name?: string;
  games: number;
}

export interface BenchmarkCliDirectMatchup extends BenchmarkCliMatchupBase {
  sideA: BenchmarkPolicyConfig;
  sideB: BenchmarkPolicyConfig;
}

export interface BenchmarkCliPriorMatrixConfig {
  weightsPath: string;
  baselineOptions?: BaselinePolicyOptions;
  evaluatorOptions?: EvaluatorPolicyOptions;
  priorLabel?: string;
}

export interface BenchmarkCliPriorMatrixMatchup extends BenchmarkCliMatchupBase {
  priorMatrix: BenchmarkCliPriorMatrixConfig;
}

export interface BenchmarkCliPriorMatrixBatchConfig extends BenchmarkCliPriorMatrixConfig {
  decks: BenchmarkCliDeckEntry[];
  includeMirrors?: boolean;
  includeReverse?: boolean;
}

export interface BenchmarkCliPriorMatrixBatchMatchup {
  id: string;
  games: number;
  priorMatrixBatch: BenchmarkCliPriorMatrixBatchConfig;
}

export type BenchmarkCliMatchup =
  | BenchmarkCliDirectMatchup
  | BenchmarkCliPriorMatrixMatchup
  | BenchmarkCliPriorMatrixBatchMatchup;

export type BenchmarkPolicyConfig =
  | {
      name: string;
      kind: "baseline";
      options?: BaselinePolicyOptions;
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    }
  | {
      name: string;
      kind: "evaluator";
      weightsPath: string;
      options?: EvaluatorPolicyOptions;
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    }
  | {
      name: string;
      /**
       * V30 Stage 3 — Logistic baseline + neural encoder α-mix.
       * Inherits all `evaluator` semantics; adds encoder weights and α.
       */
      kind: "neural-evaluator";
      weightsPath: string;
      encoderWeightsPath: string;
      neuralAlpha?: number;
      neuralScoreScale?: number;
      options?: EvaluatorPolicyOptions;
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    }
  | {
      name: string;
      kind: "gi-ml-runtime";
      rankerArtifactPath: string;
      /** Optional GBDT ranker artifact path (used as primary scorer when available). */
      gbdtRankerArtifactPath?: string;
      valueArtifactPath?: string;
      conceptModelPath?: string;
      combatWindowLibraryPath?: string;
      options?: GiMlPolicyOptions;
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    }
  | {
      name: string;
      kind: "mcts";
      options?: BaselinePolicyOptions & {
        mctsIterations?: number;
        mctsMaxDepth?: number;
        mctsTemperature?: number;
      };
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    }
  | {
      name: string;
      kind: "mcts-gi-ml";
      rankerArtifactPath: string;
      gbdtRankerArtifactPath?: string;
      valueArtifactPath?: string;
      conceptModelPath?: string;
      options?: GiMlMctsPolicyOptions;
      searchOptions?: PolicyPlayerSearchOptions;
      v2Enabled?: boolean;
    };

export interface LoadedBenchmarkCliConfig {
  version: Version;
  configPath: string;
  configDir: string;
  config: BenchmarkCliConfig;
}

export interface BenchmarkExecutionPlan {
  id: string;
  deck0: string;
  deck1: string;
  games: number;
  sideA: BenchmarkPolicyConfig;
  sideB: BenchmarkPolicyConfig;
  sampleReplay?: {
    directory: string;
    maxGames: number;
    version: Version;
  };
}

export async function loadBenchmarkCliConfig(
  configPath: string,
): Promise<LoadedBenchmarkCliConfig> {
  const resolvedPath = resolveCliPath(configPath);
  const config = (await readJsonFile(resolvedPath)) as BenchmarkCliConfig;

  return {
    version: config.version ?? CURRENT_VERSION,
    configPath: resolvedPath,
    configDir: dirname(resolvedPath),
    config,
  };
}

export async function buildBenchmarkMatchups(
  loaded: LoadedBenchmarkCliConfig,
): Promise<BenchmarkMatchup[]> {
  const plans = buildBenchmarkExecutionPlans(loaded.config);
  return buildBenchmarkMatchupsFromPlans(plans, loaded.configDir);
}

export function buildBenchmarkExecutionPlans(
  config: BenchmarkCliConfig,
): BenchmarkExecutionPlan[] {
  const plans: BenchmarkExecutionPlan[] = [];

  for (const matchup of config.matchups) {
    if ("priorMatrixBatch" in matchup) {
      plans.push(...buildPriorMatrixBatchPlans(matchup));
      continue;
    }

    if ("priorMatrix" in matchup) {
      plans.push(...buildPriorMatrixPlans(matchup));
      continue;
    }

    plans.push({
      id: matchup.id,
      deck0: matchup.deck0,
      deck1: matchup.deck1,
      games: matchup.games,
      sideA: matchup.sideA,
      sideB: matchup.sideB,
    });
  }

  return plans;
}

export async function buildBenchmarkMatchupsFromPlans(
  plans: BenchmarkExecutionPlan[],
  configDir: string,
): Promise<BenchmarkMatchup[]> {
  const matchups: BenchmarkMatchup[] = [];
  const llmCacheDir = process.env.LLM_CACHE_DIR;
  const priorProvider = llmCacheDir
    ? new LlmDeckPriorProvider({ llmCacheDir })
    : new DeckPriorProvider();

  for (const plan of plans) {
    matchups.push(await buildDirectBenchmarkMatchup(plan, configDir, priorProvider));
  }

  return matchups;
}

async function buildDirectBenchmarkMatchup(
  plan: BenchmarkExecutionPlan,
  configDir: string,
  priorProvider: DeckPriorProvider,
): Promise<BenchmarkMatchup> {
  return {
    id: plan.id,
    decks: [
      DEFAULT_ASSETS_MANAGER.decode(plan.deck0),
      DEFAULT_ASSETS_MANAGER.decode(plan.deck1),
    ],
    games: plan.games,
    sampleReplay: plan.sampleReplay,
    sideA: await createBenchmarkSide(plan.sideA, configDir, 0, {
      selfDeckCode: plan.deck0,
      opponentDeckCode: plan.deck1,
      priorProvider,
    }),
    sideB: await createBenchmarkSide(plan.sideB, configDir, 1, {
      selfDeckCode: plan.deck1,
      opponentDeckCode: plan.deck0,
      priorProvider,
    }),
  };
}

function buildPriorMatrixPlans(
  matchup: BenchmarkCliPriorMatrixMatchup,
): BenchmarkExecutionPlan[] {
  return buildPriorMatrixPlansForPair(
    matchup.id,
    matchup.deck0,
    matchup.deck1,
    matchup.deck0Name,
    matchup.deck1Name,
    matchup.games,
    matchup.priorMatrix,
  );
}

function buildPriorMatrixBatchPlans(
  matchup: BenchmarkCliPriorMatrixBatchMatchup,
): BenchmarkExecutionPlan[] {
  const pairs = buildDeckEntryPairs(matchup.priorMatrixBatch.decks, {
    includeMirrors: matchup.priorMatrixBatch.includeMirrors,
    includeReverse: matchup.priorMatrixBatch.includeReverse,
  });
  const result: BenchmarkExecutionPlan[] = [];

  for (const pair of pairs) {
    const expanded = buildPriorMatrixPlansForPair(
      `${matchup.id}::${pair.deck0.id}-vs-${pair.deck1.id}`,
      pair.deck0.deckCode,
      pair.deck1.deckCode,
      pair.deck0.name ?? pair.deck0.id,
      pair.deck1.name ?? pair.deck1.id,
      matchup.games,
      matchup.priorMatrixBatch,
    );
    result.push(...expanded);
  }

  return result;
}

function buildPriorMatrixPlansForPair(
  matchupId: string,
  deck0Code: string,
  deck1Code: string,
  deck0Name: string | undefined,
  deck1Name: string | undefined,
  games: number,
  priorMatrix: BenchmarkCliPriorMatrixConfig,
): BenchmarkExecutionPlan[] {
  const deck0Label = deck0Name ?? "Deck 0";
  const deck1Label = deck1Name ?? "Deck 1";
  const priorLabel = priorMatrix.priorLabel ?? "prior";
  const noneLabel = "none";
  const modes: Array<{ key: "none" | "self-only"; label: string }> = [
    { key: "none", label: noneLabel },
    { key: "self-only", label: priorLabel },
  ];
  const result: BenchmarkExecutionPlan[] = [];

  for (const modeA of modes) {
    for (const modeB of modes) {
      const sideAConfig: BenchmarkPolicyConfig = {
        name: `${deck0Label} (${modeA.label})`,
        kind: "evaluator",
        weightsPath: priorMatrix.weightsPath,
        options: {
          ...priorMatrix.baselineOptions,
          ...priorMatrix.evaluatorOptions,
          priorMode: modeA.key,
        },
      };
      const sideBConfig: BenchmarkPolicyConfig = {
        name: `${deck1Label} (${modeB.label})`,
        kind: "evaluator",
        weightsPath: priorMatrix.weightsPath,
        options: {
          ...priorMatrix.baselineOptions,
          ...priorMatrix.evaluatorOptions,
          priorMode: modeB.key,
        },
      };

      result.push({
        id: `${matchupId}::A-${modeA.label}::B-${modeB.label}`,
        deck0: deck0Code,
        deck1: deck1Code,
        games,
        sideA: sideAConfig,
        sideB: sideBConfig,
      });
    }
  }

  return result;
}

function buildDeckEntryPairs(
  decks: BenchmarkCliDeckEntry[],
  options: {
    includeMirrors?: boolean;
    includeReverse?: boolean;
  },
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

export async function createBenchmarkSide(
  config: BenchmarkPolicyConfig,
  configDir: string,
  side: 0 | 1,
  priorOptions?: {
    selfDeckCode: string;
    opponentDeckCode: string;
    priorProvider: DeckPriorProvider;
  },
  planPhases?: PlanPhase[] | null,
): Promise<BenchmarkSide> {
  const policy = await createPolicyFromConfig(config, configDir, priorOptions, side);
  return {
    name: config.name,
    createPlayerIO: () =>
      new PolicyPlayerIO({
        side,
        policy,
        searchOptions: config.searchOptions,
        planPhases: planPhases ?? null,
        v2Enabled: config.v2Enabled ?? false,
      }),
  }
}

export function createBaselineSide(
  name: string,
  side: 0 | 1,
  options?: BaselinePolicyOptions,
  searchOptions?: PolicyPlayerSearchOptions,
): BenchmarkSide {
  return {
    name,
    createPlayerIO: () =>
      new PolicyPlayerIO({
        side,
        policy: new BaselinePolicy(options),
        searchOptions,
      }),
  };
}

export function createEvaluatorSide(
  name: string,
  side: 0 | 1,
  weights: CalibratedWeights,
  options?: EvaluatorPolicyOptions,
  searchOptions?: PolicyPlayerSearchOptions,
): BenchmarkSide {
  return {
    name,
    createPlayerIO: () =>
      new PolicyPlayerIO({
        side,
        policy: new EvaluatorPolicy(weights, options),
        searchOptions,
      }),
  };
}

export async function createPolicyFromConfig(
  config: BenchmarkPolicyConfig,
  configDir: string,
  priorOptions?: {
    selfDeckCode: string;
    opponentDeckCode: string;
    priorProvider: DeckPriorProvider;
  },
  /** V30 Stage 3 — required for `neural-evaluator` kind. Other kinds ignore. */
  side?: 0 | 1,
): Promise<BaselinePolicy | EvaluatorPolicy | MctsPolicy | GiMlMctsPolicy> {
  if (config.kind === "baseline") {
    return new BaselinePolicy(config.options)
  }

  if (config.kind === "mcts") {
    return new MctsPolicy(config.options)
  }

  if (config.kind === "gi-ml-runtime") {
    const rankerArtifactPath = resolve(configDir, config.rankerArtifactPath)
    const gbdtRankerArtifactPath = config.gbdtRankerArtifactPath
      ? resolve(configDir, config.gbdtRankerArtifactPath)
      : null
    const valueArtifactPath = config.valueArtifactPath
      ? resolve(configDir, config.valueArtifactPath)
      : null
    const conceptModelPath = config.conceptModelPath
      ? resolve(configDir, config.conceptModelPath)
      : null
    const combatWindowLibraryPath = config.combatWindowLibraryPath
      ? resolve(configDir, config.combatWindowLibraryPath)
      : null
    const [rankerArtifact, gbdtRankerArtifact, conceptModelArtifact, valueArtifact, combatWindowLibrary] = await Promise.all([
      readJsonFile(rankerArtifactPath) as Promise<import("@gi-tcg/ml/ranker").SlotLinearRankerArtifact>,
      gbdtRankerArtifactPath
        ? (readJsonFile(gbdtRankerArtifactPath) as Promise<import("@gi-tcg/ml/value").GbdtRankerArtifact>)
        : Promise.resolve(null),
      conceptModelPath
        ? (readJsonFile(conceptModelPath) as Promise<import("@gi-tcg/ml/runtime").LinearConceptModelArtifact>)
        : Promise.resolve(null),
      valueArtifactPath
        ? (readJsonFile(valueArtifactPath) as Promise<import("@gi-tcg/ml/value").AnyValueArtifact>)
        : Promise.resolve(null),
      combatWindowLibraryPath
        ? (readJsonFile(combatWindowLibraryPath) as Promise<import("../../learning/combat-windows/export-library.js").CombatWindowLibrary>)
        : Promise.resolve(null),
    ])

    // Fetch LLM-enhanced deck prior features if priorProvider is available
    let deckPriorFeatures: DeckPriorFeatureVector | undefined
    if (priorOptions) {
      try {
        const priorCtx = await priorOptions.priorProvider.getPolicyContext(
          priorOptions.selfDeckCode,
          priorOptions.opponentDeckCode,
        )
        deckPriorFeatures = priorCtx.priorFeatures
      } catch {
        // Silent fallback — LLM cache may be empty or unavailable
      }
    }

    return new GiMlPolicy(rankerArtifact, conceptModelArtifact, {
      ...config.options,
      valueArtifact,
      combatWindowLibrary,
      gbdtRankerArtifact,
      deckPriorFeatures,
    })
  }

  if (config.kind === "mcts-gi-ml") {
    const rankerArtifactPath = resolve(configDir, config.rankerArtifactPath)
    const gbdtRankerArtifactPath = config.gbdtRankerArtifactPath
      ? resolve(configDir, config.gbdtRankerArtifactPath)
      : null
    const valueArtifactPath = config.valueArtifactPath
      ? resolve(configDir, config.valueArtifactPath)
      : null
    const conceptModelPath = config.conceptModelPath
      ? resolve(configDir, config.conceptModelPath)
      : null
    const [rankerArtifact, gbdtRankerArtifact, conceptModelArtifact, valueArtifact] = await Promise.all([
      readJsonFile(rankerArtifactPath) as Promise<import("@gi-tcg/ml/ranker").SlotLinearRankerArtifact>,
      gbdtRankerArtifactPath
        ? (readJsonFile(gbdtRankerArtifactPath) as Promise<import("@gi-tcg/ml/value").GbdtRankerArtifact>)
        : Promise.resolve(null),
      conceptModelPath
        ? (readJsonFile(conceptModelPath) as Promise<import("@gi-tcg/ml/runtime").LinearConceptModelArtifact>)
        : Promise.resolve(null),
      valueArtifactPath
        ? (readJsonFile(valueArtifactPath) as Promise<import("@gi-tcg/ml/value").AnyValueArtifact>)
        : Promise.resolve(null),
    ])
    return new GiMlMctsPolicy(rankerArtifact, conceptModelArtifact, {
      ...config.options,
      valueArtifact,
      gbdtRankerArtifact,
    })
  }

  if (config.kind === "neural-evaluator") {
    if (side !== 0 && side !== 1) {
      throw new Error("kind='neural-evaluator' requires side=0|1 to be passed to createPolicyFromConfig")
    }
    const weightsPath = resolve(configDir, config.weightsPath)
    const encoderWeightsPath = resolve(configDir, config.encoderWeightsPath)
    const weights = (await readJsonFile(weightsPath)) as CalibratedWeights
    const priorContext =
      config.options?.priorMode && config.options.priorMode !== "none" && priorOptions
        ? await priorOptions.priorProvider.getPolicyContext(
            priorOptions.selfDeckCode,
            priorOptions.opponentDeckCode,
          )
        : undefined
    const opts: NeuralEvaluatorPolicyOptions = {
      ...config.options,
      priorContext,
      side,
      encoderWeightsPath,
      neuralAlpha: config.neuralAlpha,
      neuralScoreScale: config.neuralScoreScale,
    }
    return new NeuralEvaluatorPolicy(weights, opts)
  }

  const weightsPath = resolve(configDir, config.weightsPath)
  const weights = (await readJsonFile(weightsPath)) as CalibratedWeights
  const priorContext =
    config.options?.priorMode && config.options.priorMode !== "none" && priorOptions
      ? await priorOptions.priorProvider.getPolicyContext(
          priorOptions.selfDeckCode,
          priorOptions.opponentDeckCode,
        )
      : undefined;
  return new EvaluatorPolicy(weights, {
    ...config.options,
    priorContext,
  })
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}
