// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DataLake } from "../../db/data-lake.js";
import { ReplayBuffer } from "../al/replay-buffer.js";
import type { LabeledSample } from "../scoring/feature-extractor.js";
import {
  LogisticCalibrator,
  type CalibratedWeights,
  type TrainOptions,
  type FineTuneOptions,
} from "../scoring/logistic-reg.js";
import { FeatureExtension } from "../scoring/feature-extension.js";

export interface TrainEvaluatorConfig {
  dbPath: string;
  outputPath?: string;
  options?: TrainOptions;
  /** Path to previous weights JSON for fine-tuning (online learning). */
  fineTuneFrom?: string;
  /** Path to replay buffer JSON for mixing historical data. */
  replayBufferPath?: string;
  /** Fraction of replay samples in training mix (default 0.3). */
  replayFraction?: number;
  /** Options for fine-tune training. */
  fineTuneOptions?: FineTuneOptions;
  /**
   * V30 Stage 2.E — When true, train weights with the FeatureExtension channel
   * concatenated to base features. Requires DataLake samples to carry
   * `featuresExt`; samples without are zero-padded.
   */
  useFeatureExtension?: boolean;
}

export interface TrainEvaluatorResult {
  sampleCount: number;
  weights: CalibratedWeights;
  outputPath?: string;
  /** Whether fine-tuning was used. */
  fineTuned: boolean;
  /** Number of replay buffer samples mixed in. */
  replaySamplesUsed: number;
  /** V30 Stage 2.E — number of trailing extension dims in the trained weights. */
  extensionDim: number;
}

export function trainEvaluatorFromDataLake(
  config: TrainEvaluatorConfig,
): TrainEvaluatorResult {
  const lake = new DataLake(config.dbPath);
  try {
    const samples = lake.loadAll();
    if (samples.length === 0) {
      throw new Error(`No training samples found in ${config.dbPath}`);
    }

    const calibrator = new LogisticCalibrator();
    let weights: CalibratedWeights;
    let fineTuned = false;
    let replaySamplesUsed = 0;
    let extensionDim = 0;

    // V30 Stage 2.E — detect ext samples
    const samplesWithExt = samples.filter(
      (s) => s.featuresExt && s.featuresExt.length > 0,
    );
    const useExt = config.useFeatureExtension === true;
    if (useExt && samplesWithExt.length === 0) {
      console?.warn?.(
        "[trainEvaluator] useFeatureExtension=true but no samples have featuresExt — falling back to base-only",
      );
    }
    if (!useExt && samplesWithExt.length > 0 && samplesWithExt.length === samples.length) {
      console?.warn?.(
        `[trainEvaluator] DataLake has ${samplesWithExt.length} samples with featuresExt but useFeatureExtension=false — extension features ignored`,
      );
    }

    if (useExt && samplesWithExt.length > 0) {
      // Determine ext dim from first ext-bearing sample
      const inferredExtDim = samplesWithExt[0].featuresExt!.length;
      for (const s of samplesWithExt) {
        if ((s.featuresExt?.length ?? 0) !== inferredExtDim) {
          throw new Error(
            `[trainEvaluator] inconsistent featuresExt length: expected ${inferredExtDim}, got ${s.featuresExt?.length ?? 0}`,
          );
        }
      }
      const extNames = FeatureExtension.featureNames();
      if (extNames.length !== inferredExtDim) {
        throw new Error(
          `[trainEvaluator] DataLake featuresExt length ${inferredExtDim} differs from FeatureExtension.featureNames().length ${extNames.length}; regenerate samples`,
        );
      }
      weights = calibrator.trainWithExtension(samples, extNames, config.options);
      extensionDim = inferredExtDim;
    } else if (config.fineTuneFrom && existsSync(config.fineTuneFrom)) {
      // Fine-tune mode: warm-start from previous weights
      const baseWeights = JSON.parse(readFileSync(config.fineTuneFrom, "utf-8")) as CalibratedWeights

      // Mix with replay buffer if available
      let trainingSamples = samples
      if (config.replayBufferPath && existsSync(config.replayBufferPath)) {
        const replayData = JSON.parse(readFileSync(config.replayBufferPath, "utf-8")) as LabeledSample[]
        const replay = ReplayBuffer.fromJSON(replayData)
        const replayFraction = config.replayFraction ?? 0.3
        const replayCount = Math.floor(
          (replayFraction / (1 - replayFraction)) * samples.length,
        )
        const replaySamples = replay.sample(Math.min(replayCount, replay.size))
        trainingSamples = [...samples, ...replaySamples]
        replaySamplesUsed = replaySamples.length
      }

      weights = calibrator.fineTune(trainingSamples, baseWeights, config.fineTuneOptions)
      fineTuned = true
    } else {
      // Full training from scratch (base only)
      weights = calibrator.train(samples, config.options)
    }

    let outputPath: string | undefined;
    if (config.outputPath) {
      outputPath = resolve(config.outputPath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, calibrator.serialize(), "utf-8");
    }

    return {
      sampleCount: samples.length,
      weights,
      outputPath,
      fineTuned,
      replaySamplesUsed,
      extensionDim,
    };
  } finally {
    lake.close();
  }
}
