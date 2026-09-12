/**
 * V30 Stage 3 — KPI-B verdict and overfitting diagnosis.
 *
 * Reads the encoder report JSON produced by `gitcg_ml.train_v30_encoder`,
 * picks the best-val epoch, and judges against the V30 §4.1 / §20.6 KPI-B
 * threshold relative to the stage-2 baseline (logistic on 47k holdout):
 *   accuracy delta ≥ +2.0 pp
 *   log-loss reduction ≥ 5%
 *
 * Also prints the train/val gap at the best epoch — > 10 pp means the
 * encoder is memorising rather than generalising and the recommended fix
 * is more unique games (V30 §20.7).
 *
 * Usage:
 *   pnpm exec gnx scripts/v30_kpib_verdict.ts <report.json>
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

interface EpochRecord {
  epoch: number
  elapsed_s: number
  train: { loss: number; bce: number; v_loss: number; acc: number }
  val: { loss: number; bce: number; v_loss: number; acc: number }
}

interface Report {
  schema_version: number
  n_params: number
  hyperparams: Record<string, unknown>
  history: EpochRecord[]
  best_val_loss: number
  vocab_sizes: Record<string, number>
}

const STAGE2_BASELINE = {
  acc: 0.6264,
  loss: 0.6070,
}

const KPI_B_DELTA_ACC_PP = 2.0
const KPI_B_DELTA_LOSS_PCT = 5.0

function main() {
  const reportPath = process.argv[2]
  if (!reportPath) {
    console.error("Usage: pnpm exec gnx scripts/v30_kpib_verdict.ts <encoder-report.json>")
    process.exit(1)
  }
  const path = resolve(process.cwd(), reportPath)
  const r = JSON.parse(readFileSync(path, "utf8")) as Report

  const sortedByVal = [...r.history].sort((a, b) => a.val.loss - b.val.loss)
  const best = sortedByVal[0]
  const last = r.history[r.history.length - 1]

  console.log(`\n── V30 Stage 3 KPI-B verdict — ${reportPath} ──`)
  console.log(`Model size  : ${r.n_params} params`)
  console.log(`Vocab sizes : ${JSON.stringify(r.vocab_sizes)}`)
  console.log(`Total epochs: ${r.history.length}`)

  console.log("\nTop-5 epochs by val.loss:")
  for (const e of sortedByVal.slice(0, 5)) {
    console.log(
      `  epoch ${String(e.epoch).padStart(3)}  ` +
        `train.acc=${e.train.acc.toFixed(4)}  val.acc=${e.val.acc.toFixed(4)}  ` +
        `val.bce=${e.val.bce.toFixed(4)}  val.loss=${e.val.loss.toFixed(4)}`,
    )
  }

  console.log("\nLast epoch:")
  console.log(
    `  epoch ${last.epoch}  train.acc=${last.train.acc.toFixed(4)}  ` +
      `val.acc=${last.val.acc.toFixed(4)}  val.bce=${last.val.bce.toFixed(4)}`,
  )

  // Overfitting check: best gap + late-epoch trend
  const bestGap = best.train.acc - best.val.acc
  const lastGap = last.train.acc - last.val.acc
  console.log(`\nOverfitting check (best epoch ${best.epoch}):`)
  console.log(`  best gap (train.acc - val.acc) = ${(bestGap * 100).toFixed(2)} pp`)
  console.log(`  last gap (epoch ${last.epoch})              = ${(lastGap * 100).toFixed(2)} pp`)
  if (lastGap > 0.1) {
    console.log("  ⚠ last gap > 10 pp → strong overfitting at end of training.")
    console.log("    best checkpoint already saved is fine, but more epochs won't help.")
  } else if (lastGap > 0.07) {
    console.log("  ⚠ last gap 7-10 pp → mild overfitting. Consider stopping earlier.")
  } else {
    console.log("  ✓ moderate gap — model isn't memorising the training set.")
  }
  // Calibration diagnosis: ranking ↑ but BCE ↓ is the classic signal that
  // V30 §17.4 calls "loss-only fail" — encoder learns ranking but its logit
  // scale is poorly calibrated. Recommend temperature scaling.
  let calibrationProblem = false
  if (r.history.length >= 3) {
    const lastBce = last.val.bce
    const minBce = Math.min(...r.history.map((e) => e.val.bce))
    const lastAcc = last.val.acc
    const maxAcc = Math.max(...r.history.map((e) => e.val.acc))
    if (lastBce > minBce * 1.02 && lastAcc >= maxAcc - 0.005) {
      calibrationProblem = true
      console.log("\n  ⓘ Detected calibration drift: val.acc still rising while val.bce no longer falls.")
      console.log("    → Temperature scaling (calibrate_v30_encoder.py) likely improves Δloss without retrain.")
    }
  }

  // KPI-B verdict
  const deltaAccPp = (best.val.acc - STAGE2_BASELINE.acc) * 100
  const deltaLossPct = (1 - best.val.bce / STAGE2_BASELINE.loss) * 100
  console.log("\nKPI-B verdict (vs Stage 2 logistic baseline):")
  console.log(
    `  Stage2 baseline : acc=${STAGE2_BASELINE.acc.toFixed(4)}  loss=${STAGE2_BASELINE.loss.toFixed(4)}`,
  )
  console.log(
    `  Stage3 best     : acc=${best.val.acc.toFixed(4)}  loss=${best.val.bce.toFixed(4)}`,
  )
  console.log(
    `  Δ accuracy      : ${deltaAccPp >= 0 ? "+" : ""}${deltaAccPp.toFixed(2)} pp ` +
      `(target ≥ +${KPI_B_DELTA_ACC_PP}) ${deltaAccPp >= KPI_B_DELTA_ACC_PP ? "✓" : "✗"}`,
  )
  console.log(
    `  Δ log-loss      : ${deltaLossPct >= 0 ? "+" : ""}${deltaLossPct.toFixed(2)} % ` +
      `(target ≥ +${KPI_B_DELTA_LOSS_PCT}) ${deltaLossPct >= KPI_B_DELTA_LOSS_PCT ? "✓" : "✗"}`,
  )

  const passed =
    deltaAccPp >= KPI_B_DELTA_ACC_PP && deltaLossPct >= KPI_B_DELTA_LOSS_PCT
  if (passed) {
    console.log("\n🎉 KPI-B PASSED — proceed to α-mix benchmark vs baseline (V30 §20.7).")
  } else if (deltaLossPct >= KPI_B_DELTA_LOSS_PCT && deltaAccPp >= 0) {
    console.log(
      "\n⚠ Loss-only pass — encoder helps probability calibration but not top-1.",
    )
    console.log("  V30 §17.4: this is the expected trigger to scale data or use stronger sample policy.")
  } else {
    console.log("\n✗ KPI-B FAILED — see above. Recommended next steps:")
    if (calibrationProblem) {
      console.log("  ★ STRONGEST signal: temperature scaling — costs 30s, no retraining.")
      console.log("    python -m gitcg_ml.calibrate_v30_encoder \\")
      console.log("      --weights <weights.json> --val <test.ndjson> \\")
      console.log("      --out <weights.calibrated.json> --report <calibration.json>")
    }
    if (lastGap > 0.07) {
      console.log("  1. Increase unique games (target 5k+; current too few).")
      console.log("  2. Retry with stronger regularization (--dropout 0.3 --weight-decay 1e-3).")
      console.log("  3. Reduce model capacity (--hidden-dim 64 --embed-dim 16).")
    } else {
      console.log("  1. Re-export with `--reweight gi-v30` to apply credit decay + R1 penalty.")
      console.log("  2. Try --v-head-weight 0.0 to isolate ranking from V-head BCE pollution.")
      console.log("  3. TD(λ) target instead of terminal label (needs trajectory replay).")
    }
  }
}

main()
