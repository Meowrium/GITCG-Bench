/**
 * LogisticCalibrator — Logistic Regression for scoring weight calibration.
 *
 * Pure TypeScript implementation (no Python / external ML lib dependency).
 *
 * Given labeled samples [(features, win=0|1)], fit a logistic regression model
 * that predicts P(win | features).  The learned coefficients replace the
 * hardcoded magic numbers in FragmentResolver's scoring formula.
 *
 * Training: mini-batch gradient descent with L2 regularization.
 * Inference: sigmoid(w · x + b) → win probability ∈ [0, 1].
 */

import { FeatureExtractor, type ScoringFeatureVector, type LabeledSample } from "./feature-extractor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Trained model weights: one coefficient per feature + intercept. */
export interface CalibratedWeights {
  /** Feature names in order (matches FeatureExtractor.featureNames()). */
  featureNames: string[];
  /** Learned coefficients, one per feature. */
  coefficients: number[];
  /** Bias / intercept term. */
  intercept: number;
  /** Per-coefficient variance estimates (diagonal Fisher approximation), for Thompson sampling. */
  coefficientVariances?: number[];
  /** Training metadata. */
  meta: {
    samples: number;
    epochs: number;
    finalLoss: number;
    accuracy: number;
    timestamp: string;
  };
}

export interface TrainOptions {
  /** Learning rate (default 0.01). */
  lr?: number;
  /** L2 regularization strength (default 0.001). */
  lambda?: number;
  /** Number of full passes over the data (default 100). */
  epochs?: number;
  /** Log progress every N epochs (0 = silent, default 0). */
  logEvery?: number;
}

export interface FineTuneOptions {
  /** Learning rate (default 0.001 — lower than train() for stability). */
  lr?: number;
  /** L2 regularization strength (default 0.001). */
  lambda?: number;
  /** Number of epochs (default 20 — fewer than train()). */
  epochs?: number;
  /** Log progress every N epochs (0 = silent, default 0). */
  logEvery?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  // Numerically stable for large negative z
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// Box-Muller transform: generate a standard normal random variable
let boxMullerZ1: number | null = null
function boxMullerGaussian(): number {
  if (boxMullerZ1 !== null) {
    const z = boxMullerZ1
    boxMullerZ1 = null
    return z
  }
  const u1 = Math.random() || 1e-10
  const u2 = Math.random()
  const r = Math.sqrt(-2 * Math.log(u1))
  const theta = 2 * Math.PI * u2
  boxMullerZ1 = r * Math.sin(theta)
  return r * Math.cos(theta)
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibrator
// ─────────────────────────────────────────────────────────────────────────────

export class LogisticCalibrator {
  private weights: CalibratedWeights | null = null;

  /**
   * Train a logistic regression model on labeled samples.
   *
   * Each sample is (ScoringFeatureVector, label=0|1).
   * Features are z-score standardized before training.
   */
  train(samples: LabeledSample[], options: TrainOptions = {}): CalibratedWeights {
    const {
      lr = 0.01,
      lambda = 0.001,
      epochs = 100,
      logEvery = 0,
    } = options;

    if (samples.length === 0) {
      throw new Error("Cannot train on empty sample set");
    }

    const featureNames = FeatureExtractor.featureNames();
    const dim = featureNames.length;

    // ── Convert samples to arrays ──
    const X: number[][] = samples.map((s) => FeatureExtractor.toArray(s.features));
    const y: number[] = samples.map((s) => s.label);
    const sampleWeights: number[] = samples.map((s) => s.weight ?? 1.0);

    // ── Z-score standardization (weighted) ──
    let weightSum = 0;
    const mean = new Array(dim).fill(0);
    const std = new Array(dim).fill(0);

    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i];
      weightSum += wi;
      for (let j = 0; j < dim; j++) {
        mean[j] += wi * X[i][j];
      }
    }
    for (let j = 0; j < dim; j++) {
      mean[j] /= weightSum;
    }
    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i];
      for (let j = 0; j < dim; j++) {
        std[j] += wi * (X[i][j] - mean[j]) ** 2;
      }
    }
    for (let j = 0; j < dim; j++) {
      std[j] = Math.sqrt(std[j] / weightSum) || 1;
    }

    // Normalize in-place
    for (const row of X) {
      for (let j = 0; j < dim; j++) {
        row[j] = (row[j] - mean[j]) / std[j];
      }
    }

    // ── Initialize weights ──
    const w = new Array(dim).fill(0);
    let b = 0;
    const n = X.length;
    const meanWeight = weightSum / n;

    // ── Weighted gradient descent ──
    let finalLoss = Infinity;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      let totalWeightedLoss = 0;
      const gradW = new Array(dim).fill(0);
      let gradB = 0;

      for (let i = 0; i < n; i++) {
        const z = dot(w, X[i]) + b;
        const pred = sigmoid(z);
        const wi = sampleWeights[i];
        const err = (pred - y[i]) * wi;

        for (let j = 0; j < dim; j++) {
          gradW[j] += err * X[i][j];
        }
        gradB += err;

        // Weighted binary cross-entropy loss
        const clipped = Math.max(1e-7, Math.min(1 - 1e-7, pred));
        totalLoss += -(y[i] * Math.log(clipped) + (1 - y[i]) * Math.log(1 - clipped));
        totalWeightedLoss += -wi * (y[i] * Math.log(clipped) + (1 - y[i]) * Math.log(1 - clipped));
      }

      // Average (by weight sum) + L2 regularization (scaled by mean weight)
      const lambdaEff = lambda * meanWeight;
      for (let j = 0; j < dim; j++) {
        gradW[j] = gradW[j] / weightSum + lambdaEff * w[j];
        w[j] -= lr * gradW[j];
      }
      b -= lr * (gradB / weightSum);
      finalLoss = totalWeightedLoss / weightSum;

      if (logEvery > 0 && (epoch + 1) % logEvery === 0) {
        console.log(`[LogisticCalibrator] epoch ${epoch + 1}/${epochs}  loss=${finalLoss.toFixed(6)}  (unweighted=${(totalLoss / n).toFixed(6)})`);
      }
    }

    // ── Compute weighted accuracy ──
    let correct = 0;
    let correctWeighted = 0;
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(dot(w, X[i]) + b) >= 0.5 ? 1 : 0;
      if (pred === y[i]) {
        correct++;
        correctWeighted += sampleWeights[i];
      }
    }
    const accuracy = correctWeighted / weightSum;

    // ── Compute per-coefficient variance (diagonal Fisher approximation) ──
    // var_j = (1 / σ_j²) / Σ_i(p_i * (1-p_i) * x_std_ij²)
    // for Thompson sampling on raw-scale coefficients
    const fisherDiag = new Array(dim).fill(lambda * meanWeight)
    for (let i = 0; i < n; i++) {
      const z = dot(w, X[i]) + b
      const p = sigmoid(z)
      const infoWeight = p * (1 - p) * sampleWeights[i]
      for (let j = 0; j < dim; j++) {
        fisherDiag[j] += infoWeight * X[i][j] ** 2
      }
    }
    const stdVariances = fisherDiag.map((f) => (f > 0 ? 1 / f : 1))
    // Convert to raw-scale variances: var_raw = var_std / σ²
    const rawVariances = stdVariances.map((v, j) => v / (std[j] ** 2))

    // ── Un-standardize: convert to original-scale coefficients ──
    // Original: sigmoid(w_std · ((x - μ) / σ) + b_std)
    //         = sigmoid((w_std / σ) · x + (b_std - Σ w_std_j * μ_j / σ_j))
    const rawCoefficients = w.map((wj, j) => wj / std[j]);
    let rawIntercept = b;
    for (let j = 0; j < dim; j++) {
      rawIntercept -= w[j] * mean[j] / std[j];
    }

    this.weights = {
      featureNames: featureNames as string[],
      coefficients: rawCoefficients,
      intercept: rawIntercept,
      coefficientVariances: rawVariances,
      meta: {
        samples: n,
        epochs,
        finalLoss,
        accuracy,
        timestamp: new Date().toISOString(),
      },
    };

    return this.weights;
  }

  /**
   * Fine-tune an existing model on new data (online learning).
   *
   * Warm-starts from baseWeights and runs fewer epochs with lower learning rate.
   * Uses the same weighted training as train().
   */
  fineTune(
    samples: LabeledSample[],
    baseWeights: CalibratedWeights,
    options: FineTuneOptions = {},
  ): CalibratedWeights {
    const {
      lr = 0.001,
      lambda = 0.001,
      epochs = 20,
      logEvery = 0,
    } = options

    if (samples.length === 0) {
      this.weights = baseWeights
      return baseWeights
    }

    const featureNames = FeatureExtractor.featureNames()
    const dim = featureNames.length

    // Convert samples
    const X: number[][] = samples.map((s) => FeatureExtractor.toArray(s.features))
    const y: number[] = samples.map((s) => s.label)
    const sampleWeights: number[] = samples.map((s) => s.weight ?? 1.0)

    // Z-score standardization (weighted)
    let weightSum = 0
    const mean = new Array(dim).fill(0)
    const std = new Array(dim).fill(0)
    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i]
      weightSum += wi
      for (let j = 0; j < dim; j++) {
        mean[j] += wi * X[i][j]
      }
    }
    for (let j = 0; j < dim; j++) {
      mean[j] /= weightSum
    }
    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i]
      for (let j = 0; j < dim; j++) {
        std[j] += wi * (X[i][j] - mean[j]) ** 2
      }
    }
    for (let j = 0; j < dim; j++) {
      std[j] = Math.sqrt(std[j] / weightSum) || 1
    }

    // Normalize in-place
    for (const row of X) {
      for (let j = 0; j < dim; j++) {
        row[j] = (row[j] - mean[j]) / std[j]
      }
    }

    // Initialize from base weights (in standardized space)
    // base_w_raw → base_w_std = base_w_raw * σ
    const w = baseWeights.coefficients.map((cj, j) => cj * std[j])
    let b = baseWeights.intercept
    for (let j = 0; j < dim; j++) {
      b += baseWeights.coefficients[j] * mean[j]
    }

    const n = X.length
    const meanWeight = weightSum / n

    // Gradient descent
    let finalLoss = Infinity

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalWeightedLoss = 0
      const gradW = new Array(dim).fill(0)
      let gradB = 0

      for (let i = 0; i < n; i++) {
        const z = dot(w, X[i]) + b
        const pred = sigmoid(z)
        const wi = sampleWeights[i]
        const err = (pred - y[i]) * wi

        for (let j = 0; j < dim; j++) {
          gradW[j] += err * X[i][j]
        }
        gradB += err

        const clipped = Math.max(1e-7, Math.min(1 - 1e-7, pred))
        totalWeightedLoss += -wi * (y[i] * Math.log(clipped) + (1 - y[i]) * Math.log(1 - clipped))
      }

      const lambdaEff = lambda * meanWeight
      for (let j = 0; j < dim; j++) {
        gradW[j] = gradW[j] / weightSum + lambdaEff * w[j]
        w[j] -= lr * gradW[j]
      }
      b -= lr * (gradB / weightSum)
      finalLoss = totalWeightedLoss / weightSum

      if (logEvery > 0 && (epoch + 1) % logEvery === 0) {
        console.log(`[LogisticCalibrator] fineTune epoch ${epoch + 1}/${epochs}  loss=${finalLoss.toFixed(6)}`)
      }
    }

    // Un-standardize
    const rawCoefficients = w.map((wj, j) => wj / std[j])
    let rawIntercept = b
    for (let j = 0; j < dim; j++) {
      rawIntercept -= w[j] * mean[j] / std[j]
    }

    this.weights = {
      featureNames: featureNames as string[],
      coefficients: rawCoefficients,
      intercept: rawIntercept,
      meta: {
        samples: n + (baseWeights.meta?.samples ?? 0),
        epochs,
        finalLoss,
        accuracy: NaN, // not meaningful for fine-tune on new data
        timestamp: new Date().toISOString(),
      },
    }

    return this.weights
  }

  /**
   * V30 Stage 2.E — Train a logistic regression with concatenated base +
   * FeatureExtension features.
   *
   * Each sample contributes a concat vector `[base(83) || ext(EXT_DIM)]` where
   * `EXT_DIM` is inferred from the first sample with a non-empty `featuresExt`.
   * Samples without `featuresExt` are zero-padded so they still contribute
   * baseline-only learning signal.
   *
   * The output `CalibratedWeights.featureNames` includes both base and
   * extension names, and `coefficients` is the concatenation. This makes the
   * weights file natively compatible with `predictWithExtension` /
   * `EvaluatorPolicy` auto-detection.
   */
  trainWithExtension(
    samples: LabeledSample[],
    extensionFeatureNames: string[],
    options: TrainOptions = {},
  ): CalibratedWeights {
    const {
      lr = 0.01,
      lambda = 0.001,
      epochs = 100,
      logEvery = 0,
    } = options

    if (samples.length === 0) {
      throw new Error("Cannot train on empty sample set")
    }

    const baseNames = FeatureExtractor.featureNames() as string[]
    const baseDim = baseNames.length
    const extDim = extensionFeatureNames.length
    const totalDim = baseDim + extDim

    // Build concatenated [base || ext] feature matrix
    const X: number[][] = samples.map((s) => {
      const base = FeatureExtractor.toArray(s.features)
      const row = new Array(totalDim).fill(0)
      for (let j = 0; j < baseDim; j++) row[j] = base[j]
      const ext = s.featuresExt
      if (ext && ext.length > 0) {
        for (let j = 0; j < extDim && j < ext.length; j++) {
          row[baseDim + j] = ext[j]
        }
      }
      return row
    })
    const y: number[] = samples.map((s) => s.label)
    const sampleWeights: number[] = samples.map((s) => s.weight ?? 1.0)

    // Z-score standardization (weighted)
    let weightSum = 0
    const mean = new Array(totalDim).fill(0)
    const std = new Array(totalDim).fill(0)
    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i]
      weightSum += wi
      for (let j = 0; j < totalDim; j++) {
        mean[j] += wi * X[i][j]
      }
    }
    for (let j = 0; j < totalDim; j++) {
      mean[j] /= weightSum
    }
    for (let i = 0; i < X.length; i++) {
      const wi = sampleWeights[i]
      for (let j = 0; j < totalDim; j++) {
        std[j] += wi * (X[i][j] - mean[j]) ** 2
      }
    }
    for (let j = 0; j < totalDim; j++) {
      std[j] = Math.sqrt(std[j] / weightSum) || 1
    }
    for (const row of X) {
      for (let j = 0; j < totalDim; j++) {
        row[j] = (row[j] - mean[j]) / std[j]
      }
    }

    const w = new Array(totalDim).fill(0)
    let b = 0
    const n = X.length
    const meanWeight = weightSum / n
    let finalLoss = Infinity

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalWeightedLoss = 0
      const gradW = new Array(totalDim).fill(0)
      let gradB = 0
      for (let i = 0; i < n; i++) {
        const z = dot(w, X[i]) + b
        const pred = sigmoid(z)
        const wi = sampleWeights[i]
        const err = (pred - y[i]) * wi
        for (let j = 0; j < totalDim; j++) {
          gradW[j] += err * X[i][j]
        }
        gradB += err
        const clipped = Math.max(1e-7, Math.min(1 - 1e-7, pred))
        totalWeightedLoss += -wi * (y[i] * Math.log(clipped) + (1 - y[i]) * Math.log(1 - clipped))
      }
      const lambdaEff = lambda * meanWeight
      for (let j = 0; j < totalDim; j++) {
        gradW[j] = gradW[j] / weightSum + lambdaEff * w[j]
        w[j] -= lr * gradW[j]
      }
      b -= lr * (gradB / weightSum)
      finalLoss = totalWeightedLoss / weightSum
      if (logEvery > 0 && (epoch + 1) % logEvery === 0) {
        console?.log?.(
          `[LogisticCalibrator.ext] epoch ${epoch + 1}/${epochs}  loss=${finalLoss.toFixed(6)}  totalDim=${totalDim}`,
        )
      }
    }

    // Accuracy
    let correctWeighted = 0
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(dot(w, X[i]) + b) >= 0.5 ? 1 : 0
      if (pred === y[i]) correctWeighted += sampleWeights[i]
    }
    const accuracy = correctWeighted / weightSum

    // Fisher diagonal → variances on standardized scale
    const fisherDiag = new Array(totalDim).fill(lambda * meanWeight)
    for (let i = 0; i < n; i++) {
      const z = dot(w, X[i]) + b
      const p = sigmoid(z)
      const infoWeight = p * (1 - p) * sampleWeights[i]
      for (let j = 0; j < totalDim; j++) {
        fisherDiag[j] += infoWeight * X[i][j] ** 2
      }
    }
    const stdVariances = fisherDiag.map((f) => (f > 0 ? 1 / f : 1))
    const rawVariances = stdVariances.map((v, j) => v / (std[j] ** 2))

    // Un-standardize coefs
    const rawCoefficients = w.map((wj, j) => wj / std[j])
    let rawIntercept = b
    for (let j = 0; j < totalDim; j++) {
      rawIntercept -= w[j] * mean[j] / std[j]
    }

    this.weights = {
      featureNames: [...baseNames, ...extensionFeatureNames],
      coefficients: rawCoefficients,
      intercept: rawIntercept,
      coefficientVariances: rawVariances,
      meta: {
        samples: n,
        epochs,
        finalLoss,
        accuracy,
        timestamp: new Date().toISOString(),
      },
    }
    return this.weights
  }

  /** Predict P(win) for a single feature vector. */
  predict(features: ScoringFeatureVector): number {
    if (!this.weights) {
      throw new Error("Model not trained. Call train() first or load() weights.");
    }
    const x = FeatureExtractor.toArray(features);
    const z = dot(this.weights.coefficients, x) + this.weights.intercept;
    return sigmoid(z);
  }

  /**
   * V30 Stage 2.B — Predict P(win) using a *base* ScoringFeatureVector plus an
   * optional `extension` numeric array (PreviewMutationVector + Fingerprint).
   *
   * Behaviour:
   *   - If `weights.featureNames` length > base feature count, the trailing
   *     coefficients are applied to `extension` element-wise.
   *   - If `weights.featureNames` length matches base feature count, the
   *     extension is silently ignored — fully backward-compatible with weights
   *     trained before V30.
   *   - If `extension` is shorter than the trailing coefficient block, missing
   *     dimensions are treated as zero (graceful degradation when the runtime
   *     lacks fingerprint/preview data for some candidate).
   */
  predictWithExtension(
    features: ScoringFeatureVector,
    extension: number[] | null | undefined,
  ): number {
    if (!this.weights) {
      throw new Error("Model not trained. Call train() first or load() weights.");
    }
    const baseArr = FeatureExtractor.toArray(features);
    const baseDim = baseArr.length;
    const totalDim = this.weights.coefficients.length;
    let z = this.weights.intercept;
    for (let j = 0; j < baseDim && j < totalDim; j++) {
      z += this.weights.coefficients[j] * baseArr[j];
    }
    if (extension && totalDim > baseDim) {
      const extDim = totalDim - baseDim;
      for (let j = 0; j < extDim && j < extension.length; j++) {
        z += this.weights.coefficients[baseDim + j] * extension[j];
      }
    }
    return sigmoid(z);
  }

  /**
   * V30 Stage 2.B — Thompson-sampled prediction with extension. Mirrors
   * `predictWithExtension` semantics but samples coefficients from the
   * posterior. Falls back to deterministic prediction when variances are
   * absent.
   */
  predictThompsonWithExtension(
    features: ScoringFeatureVector,
    extension: number[] | null | undefined,
  ): number {
    if (!this.weights) {
      throw new Error("Model not trained. Call train() first or load() weights.");
    }
    const variances = this.weights.coefficientVariances;
    if (!variances || variances.length === 0) {
      return this.predictWithExtension(features, extension);
    }
    const baseArr = FeatureExtractor.toArray(features);
    const baseDim = baseArr.length;
    const totalDim = this.weights.coefficients.length;
    let z = 0;
    for (let j = 0; j < baseDim && j < totalDim; j++) {
      const wMean = this.weights.coefficients[j];
      const wVar = variances[j] ?? 0;
      const wSampled = wVar > 0 ? wMean + Math.sqrt(wVar) * boxMullerGaussian() : wMean;
      z += wSampled * baseArr[j];
    }
    if (extension && totalDim > baseDim) {
      const extDim = totalDim - baseDim;
      for (let j = 0; j < extDim && j < extension.length; j++) {
        const wMean = this.weights.coefficients[baseDim + j];
        const wVar = variances[baseDim + j] ?? 0;
        const wSampled = wVar > 0 ? wMean + Math.sqrt(wVar) * boxMullerGaussian() : wMean;
        z += wSampled * extension[j];
      }
    }
    const bMean = this.weights.intercept;
    const bVar = variances.reduce((a, b) => a + b, 0) / variances.length;
    const bSampled = bVar > 0 ? bMean + Math.sqrt(bVar) * boxMullerGaussian() : bMean;
    return sigmoid(z + bSampled);
  }

  /** Whether currently loaded weights include extension coefficients. */
  hasExtensionCoefficients(): boolean {
    if (!this.weights) return false;
    return this.weights.coefficients.length > FeatureExtractor.featureNames().length;
  }

  /** Number of extension dimensions in the loaded weights (0 if none). */
  extensionDim(): number {
    if (!this.weights) return 0;
    const baseDim = FeatureExtractor.featureNames().length;
    return Math.max(0, this.weights.coefficients.length - baseDim);
  }

  /**
   * Thompson-sampled prediction: sample coefficients from N(coeff, variance)
   * and compute prediction with sampled weights. Returns a stochastic estimate.
   * Uses Box-Muller for Gaussian sampling.
   */
  predictThompson(features: ScoringFeatureVector): number {
    if (!this.weights) {
      throw new Error("Model not trained. Call train() first or load() weights.");
    }
    const variances = this.weights.coefficientVariances
    const x = FeatureExtractor.toArray(features)
    const dim = this.weights.coefficients.length

    let z = 0
    for (let j = 0; j < dim; j++) {
      const wMean = this.weights.coefficients[j]
      const wVar = variances?.[j] ?? 0
      // Thompson sample: w ~ N(wMean, wVar)
      const wSampled = wVar > 0
        ? wMean + Math.sqrt(wVar) * boxMullerGaussian()
        : wMean
      z += wSampled * x[j]
    }
    // Also sample intercept
    const bMean = this.weights.intercept
    // Intercept variance: approximate as mean of coefficient variances
    const bVar = variances && variances.length > 0
      ? variances.reduce((a, b) => a + b, 0) / variances.length
      : 0
    const bSampled = bVar > 0
      ? bMean + Math.sqrt(bVar) * boxMullerGaussian()
      : bMean
    z += bSampled

    return sigmoid(z)
  }

  /** Predict P(win) for a batch. */
  predictBatch(featuresBatch: ScoringFeatureVector[]): number[] {
    return featuresBatch.map((f) => this.predict(f));
  }

  /**
   * Rank candidates by predicted win probability (descending).
   * Returns array of { candidateIndex, winProb }.
   */
  rankCandidates(
    featuresBatch: ScoringFeatureVector[],
  ): Array<{ candidateIndex: number; winProb: number }> {
    return featuresBatch
      .map((f, i) => ({ candidateIndex: i, winProb: this.predict(f) }))
      .sort((a, b) => b.winProb - a.winProb);
  }

  /** Load previously saved weights. */
  load(weights: CalibratedWeights): void {
    this.weights = weights;
  }

  /** Get current weights (null if not trained). */
  getWeights(): CalibratedWeights | null {
    return this.weights;
  }

  /** Serialize weights to JSON string. */
  serialize(): string {
    if (!this.weights) throw new Error("No weights to serialize");
    return JSON.stringify(this.weights, null, 2);
  }

  /** Deserialize weights from JSON string or object. */
  static fromJSON(json: string | CalibratedWeights): LogisticCalibrator {
    const cal = new LogisticCalibrator();
    const weights = typeof json === "string" ? (JSON.parse(json) as CalibratedWeights) : json;
    cal.load(weights);
    return cal;
  }
}
