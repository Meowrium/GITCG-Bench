// Copyright (C) 2025 Guyutongxue
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

/**
 * Scorer - 100-point scoring system for pre-game deck analysis.
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md §4.
 *
 * | Category                       | Points | Method |
 * |--------------------------------|-------:|--------|
 * | Input Fidelity                 | 20     | schema, ID existence, no cross-side, evidence entailment |
 * | Deck Profile                   | 20     | Brier score for archetypeWeights, macro-F1 for primaryArchetypes, IoU for pace |
 * | Win Conditions & Key Pieces    | 25     | weighted set F1 for kind/role/necessity + evidence entailment |
 * | Lines & Resource Reasoning     | 20     | rubric for step deps, preconditions, payoff, fragility |
 * | Matchup                        | 10     | weighted set F1 for threat/source/window/counterplay |
 * | Calibration & Abstention       | 5      | Brier/ECE for confidence, correct abstention not penalized |
 *
 * For single-deck tasks (no opponent), matchup's 10 points are redistributed:
 *   Input Fidelity +2, Deck Profile +3, Lines & Resources +5.
 */

import type {
  AnalysisOutput,
  DeckProfile,
  WinCondition,
  KeyPiece,
  Line,
  OpponentThreat,
} from "./analysis-v2-schema"
import type { EvidenceValidationResult } from "./evidence-validator"
import type { DeckVariant } from "./variant-generator"

// ─── Types ────────────────────────────────────────────────────────────────

export interface Subscore {
  category: string
  score: number
  maxScore: number
  details: Record<string, unknown>
}

export interface ScoreResult {
  total: number
  maxTotal: number
  subscores: Subscore[]
  /** True if this is a matchup task (opponent deck provided) */
  isMatchup: boolean
  /** Variant info if the deck is a variant */
  variantInfo?: DeckVariant
  /** Issues found during scoring */
  issues: string[]
}

export interface GoldAnalysis {
  analysisV2: {
    deckProfile: {
      archetypeWeights: Record<string, number>
      primaryArchetypes: string[]
      pace: {
        setupRounds: { min: number; max: number }
        pressurePeakRounds: number[]
        lateGameReliance: number
      }
      winConditions: Array<{
        id: string
        kind: string
        description: string
        requiredPieces: string[]
        evidence: string[]
        confidence: number
      }>
      keyPieces: Array<{
        id: string
        role: string
        necessity: string
        evidence: string[]
        confidence: number
      }>
      lines: Array<{
        id: string
        kind: string
        steps: Array<{ actor: string; effect: string; evidence: string[] }>
        preconditions: string[]
        payoff: string
        fragility: string[]
        confidence: number
      }>
      resourcePlan: {
        priority: string[]
        bottlenecks: Array<{ resource: string; reason: string; evidence: string[] }>
      }
    }
    matchup: {
      opponentThreats: Array<{
        id: string
        source: string
        window: { minRound: number; maxRound: number }
        severity: string
        counterplay: string[]
        evidence: string[]
        confidence: number
      }>
      relativePlan: {
        advantageAxes: string[]
        targetPace: string
        confidence: number
      }
    }
    abstentions: Array<{ field: string; reason: string }>
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────

/**
 * Brier score for a predicted probability distribution vs. gold distribution.
 * Returns a score in [0, 1] where 1 is perfect (0 Brier score).
 */
function brierScore(
  predicted: Record<string, number>,
  gold: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(predicted), ...Object.keys(gold)])
  let sumSqDiff = 0
  for (const key of allKeys) {
    const p = predicted[key] ?? 0
    const g = gold[key] ?? 0
    sumSqDiff += (p - g) ** 2
  }
  const brier = sumSqDiff / allKeys.size
  // Convert Brier to score: 1 - brier (perfect = 1, worst = 1)
  return Math.max(0, 1 - brier)
}

/**
 * Macro-F1 for set membership (used for primaryArchetypes).
 * Returns F1 score in [0, 1].
 */
function macroF1(predicted: string[], gold: string[]): number {
  const predSet = new Set(predicted)
  const goldSet = new Set(gold)
  const allLabels = new Set([...predicted, ...gold])

  if (allLabels.size === 0) return 1 // both empty = perfect

  let totalF1 = 0
  for (const label of allLabels) {
    const tp = predSet.has(label) && goldSet.has(label) ? 1 : 0
    const fp = predSet.has(label) && !goldSet.has(label) ? 1 : 0
    const fn = !predSet.has(label) && goldSet.has(label) ? 1 : 0
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    totalF1 += f1
  }
  return totalF1 / allLabels.size
}

/**
 * Intersection-over-Union for integer intervals.
 */
function intervalIoU(
  pred: { min: number; max: number },
  gold: { min: number; max: number },
): number {
  const lo = Math.max(pred.min, gold.min)
  const hi = Math.min(pred.max, gold.max)
  const intersection = Math.max(0, hi - lo + 1)
  const union = Math.max(pred.max, gold.max) - Math.min(pred.min, gold.min) + 1
  return union > 0 ? intersection / union : 0
}

/**
 * Intersection-over-Union for sets of integers (pressurePeakRounds).
 */
function setIoU(pred: number[], gold: number[]): number {
  const predSet = new Set(pred)
  const goldSet = new Set(gold)
  let intersection = 0
  for (const v of predSet) {
    if (goldSet.has(v)) intersection++
  }
  const union = predSet.size + goldSet.size - intersection
  return union > 0 ? intersection / union : (pred.length === 0 && gold.length === 0 ? 1 : 0)
}

/**
 * Weighted set F1 for matching predicted items to gold items.
 * Items are matched by a key function; the score combines precision and recall.
 */
function weightedSetF1<T>(
  predicted: T[],
  gold: T[],
  keyFn: (item: T) => string,
): number {
  if (gold.length === 0 && predicted.length === 0) return 1
  if (gold.length === 0) return 0 // predicted something when shouldn't have
  if (predicted.length === 0) return 0 // didn't predict anything

  const goldKeys = new Set(gold.map(keyFn))
  const predKeys = new Set(predicted.map(keyFn))

  let truePositives = 0
  for (const k of predKeys) {
    if (goldKeys.has(k)) truePositives++
  }
  const precision = truePositives / predKeys.size
  const recall = truePositives / goldKeys.size
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
}

/**
 * Compute Expected Calibration Error (ECE) for confidence scores.
 * Groups confidences into bins and measures the gap between confidence and accuracy.
 */
function expectedCalibrationError(
  confidences: number[],
  accuracies: number[],
  numBins = 5,
): number {
  if (confidences.length === 0) return 0
  const binSize = 1 / numBins
  let ece = 0
  const n = confidences.length

  for (let b = 0; b < numBins; b++) {
    const lo = b * binSize
    const hi = (b + 1) * binSize
    const indices = confidences
      .map((c, i) => ({ c, a: accuracies[i]!, i }))
      .filter((x) => x.c > lo && (x.c <= hi || (b === numBins - 1 && x.c >= hi)))

    if (indices.length === 0) continue
    const binCount = indices.length
    const avgConf = indices.reduce((s, x) => s + x.c, 0) / binCount
    const avgAcc = indices.reduce((s, x) => s + x.a, 0) / binCount
    ece += (binCount / n) * Math.abs(avgConf - avgAcc)
  }
  return ece
}

// ─── Main scorer ───────────────────────────────────────────────────────────

export interface ScorerInput {
  /** The model's output */
  output: AnalysisOutput
  /** Gold analysis (may be partial for smoke tests) */
  gold?: GoldAnalysis
  /** Evidence validation result */
  evidenceValidation: EvidenceValidationResult
  /** Whether an opponent deck was provided */
  hasOpponent: boolean
  /** Variant info (if the deck is a variant) */
  variant?: DeckVariant
}

/**
 * Score an analysis output against gold.
 *
 * If no gold is provided (smoke test), only input fidelity and calibration
 * are scored; other categories get full marks as a placeholder.
 */
export function scoreAnalysis(input: ScorerInput): ScoreResult {
  const { output, gold, evidenceValidation, hasOpponent, variant } = input
  const issues: string[] = []
  const subscores: Subscore[] = []

  const isMatchup = hasOpponent
  // Score redistribution for single-deck tasks
  const matchupPoints = isMatchup ? 10 : 0
  const inputFidelityMax = 20 + (isMatchup ? 0 : 2)
  const deckProfileMax = 20 + (isMatchup ? 0 : 3)
  const linesMax = 20 + (isMatchup ? 0 : 5)
  const winCondMax = 25
  const calibrationMax = 5

  // ── 1. Input Fidelity (20 or 22) ──
  let inputFidelityScore = 0
  const evStats = evidenceValidation.stats

  // Schema valid (8 pts)
  inputFidelityScore += 8

  // No hallucinated IDs (7 pts)
  const hallucinationDeduction = Math.min(7, evStats.hallucinated * 2)
  inputFidelityScore += 7 - hallucinationDeduction
  if (evStats.hallucinated > 0) {
    issues.push(`${evStats.hallucinated} hallucinated evidence IDs`)
  }

  // No cross-side violations (5 pts)
  const crossSideDeduction = Math.min(5, evStats.crossSide * 2)
  inputFidelityScore += 5 - crossSideDeduction
  if (evStats.crossSide > 0) {
    issues.push(`${evStats.crossSide} cross-side evidence violations`)
  }

  // Bonus for single-deck redistribution (+2 pts)
  if (!isMatchup) {
    // Extra check: no opponent data referenced when none provided
    if (output.analysisV2.matchup.opponentThreats.length > 0 && !hasOpponent) {
      inputFidelityScore -= 2
      issues.push("Referenced opponent threats when no opponent deck was provided")
    } else {
      inputFidelityScore += 2
    }
  }

  inputFidelityScore = Math.max(0, Math.min(inputFidelityMax, inputFidelityScore))
  subscores.push({
    category: "Input Fidelity",
    score: inputFidelityScore,
    maxScore: inputFidelityMax,
    details: { hallucinated: evStats.hallucinated, crossSide: evStats.crossSide },
  })

  // ── 2. Deck Profile (20 or 23) ──
  let deckProfileScore = 0
  const dp = output.analysisV2.deckProfile

  if (gold) {
    const goldDp = gold.analysisV2.deckProfile

    // Archetype weights Brier (7 pts)
    const brier = brierScore(dp.archetypeWeights, goldDp.archetypeWeights)
    deckProfileScore += brier * 7

    // primaryArchetypes macro-F1 (6 pts)
    const f1 = macroF1(dp.primaryArchetypes, goldDp.primaryArchetypes)
    deckProfileScore += f1 * 6

    // Pace: setupRounds IoU (3) + pressurePeakRounds set IoU (2) + lateGameReliance (2)
    const setupIoU = intervalIoU(dp.pace.setupRounds, goldDp.pace.setupRounds)
    const peakIoU = setIoU(dp.pace.pressurePeakRounds, goldDp.pace.pressurePeakRounds)
    const relianceDiff = 1 - Math.abs(dp.pace.lateGameReliance - goldDp.pace.lateGameReliance)
    deckProfileScore += setupIoU * 3 + peakIoU * 2 + relianceDiff * 2

    // Bonus for single-deck redistribution (+3 pts)
    if (!isMatchup) {
      deckProfileScore += 3 // Full marks for completing profile on single-deck
    }
  } else {
    // No gold: award full marks as placeholder
    deckProfileScore = deckProfileMax
  }

  deckProfileScore = Math.max(0, Math.min(deckProfileMax, deckProfileScore))
  subscores.push({
    category: "Deck Profile",
    score: deckProfileScore,
    maxScore: deckProfileMax,
    details: gold ? { compared: true } : { compared: false, reason: "no gold" },
  })

  // ── 3. Win Conditions & Key Pieces (25) ──
  let winCondScore = 0
  if (gold) {
    const goldDp = gold.analysisV2.deckProfile

    // Win conditions: kind matching via weighted set F1 (10 pts)
    const wcF1 = weightedSetF1(
      dp.winConditions as WinCondition[],
      goldDp.winConditions as WinCondition[],
      (wc) => `${wc.kind}:${wc.id}`,
    )
    winCondScore += wcF1 * 10

    // Key pieces: role + necessity matching (10 pts)
    const kpF1 = weightedSetF1(
      dp.keyPieces as KeyPiece[],
      goldDp.keyPieces as KeyPiece[],
      (kp) => `${kp.role}:${kp.necessity}:${kp.id}`,
    )
    winCondScore += kpF1 * 10

    // Evidence entailment for matched claims (5 pts)
    // For each gold win condition that was predicted, check evidence overlap
    let evidenceScore = 0
    let goldCount = 0
    for (const gwc of goldDp.winConditions) {
      goldCount++
      const matched = dp.winConditions.find(
        (pwc: WinCondition) => pwc.id === gwc.id || pwc.kind === gwc.kind,
      )
      if (matched) {
        const goldEv = new Set<string>(gwc.evidence)
        const predEv = new Set<string>(matched.evidence)
        let overlap = 0
        for (const e of predEv) {
          if (goldEv.has(e)) overlap++
        }
        evidenceScore += overlap / Math.max(goldEv.size, predEv.size)
      }
    }
    if (goldCount > 0) {
      evidenceScore = (evidenceScore / goldCount) * 5
    } else {
      evidenceScore = 5
    }
    winCondScore += evidenceScore
  } else {
    winCondScore = winCondMax
  }

  winCondScore = Math.max(0, Math.min(winCondMax, winCondScore))
  subscores.push({
    category: "Win Conditions & Key Pieces",
    score: winCondScore,
    maxScore: winCondMax,
    details: gold ? { compared: true } : { compared: false, reason: "no gold" },
  })

  // ── 4. Lines & Resource Reasoning (20 or 25) ──
  let linesScore = 0
  if (gold) {
    const goldDp = gold.analysisV2.deckProfile

    // Lines: kind + step count matching (10 pts)
    const lineF1 = weightedSetF1(
      dp.lines as Line[],
      goldDp.lines as Line[],
      (l) => `${l.kind}:${l.steps.length}`,
    )
    linesScore += lineF1 * 10

    // Resource plan: priority order match (5 pts)
    const goldPriority = goldDp.resourcePlan.priority
    const predPriority = dp.resourcePlan.priority
    let priorityMatch = 0
    for (let i = 0; i < Math.min(goldPriority.length, predPriority.length); i++) {
      if (goldPriority[i] === predPriority[i]) priorityMatch++
    }
    linesScore += (priorityMatch / Math.max(goldPriority.length, 1)) * 5

    // Bottleneck matching (5 pts)
    const bpF1 = weightedSetF1(
      dp.resourcePlan.bottlenecks,
      goldDp.resourcePlan.bottlenecks,
      (b) => b.resource,
    )
    linesScore += bpF1 * 5

    // Bonus for single-deck redistribution (+5 pts)
    if (!isMatchup) {
      // Check line validity: preconditions and payoff exist
      const validLines = dp.lines.filter(
        (l: Line) => l.preconditions.length > 0 && l.payoff.length > 0,
      ).length
      linesScore += (validLines / Math.max(dp.lines.length, 1)) * 5
    }
  } else {
    linesScore = linesMax
  }

  linesScore = Math.max(0, Math.min(linesMax, linesScore))
  subscores.push({
    category: "Lines & Resource Reasoning",
    score: linesScore,
    maxScore: linesMax,
    details: gold ? { compared: true } : { compared: false, reason: "no gold" },
  })

  // ── 5. Matchup (10, only for matchup tasks) ──
  if (isMatchup && gold) {
    const goldMatchup = gold.analysisV2.matchup
    let matchupScore = 0

    // Opponent threats: source + severity F1 (6 pts)
    const threatF1 = weightedSetF1(
      output.analysisV2.matchup.opponentThreats as OpponentThreat[],
      goldMatchup.opponentThreats as OpponentThreat[],
      (t) => `${t.source}:${t.severity}`,
    )
    matchupScore += threatF1 * 6

    // Window overlap (2 pts)
    let windowScore = 0
    for (const gt of goldMatchup.opponentThreats) {
      const matched = output.analysisV2.matchup.opponentThreats.find(
        (pt: OpponentThreat) => pt.source === gt.source,
      )
      if (matched) {
        const wIoU = intervalIoU(
          { min: matched.window.minRound, max: matched.window.maxRound },
          { min: gt.window.minRound, max: gt.window.maxRound },
        )
        windowScore += wIoU
      }
    }
    if (goldMatchup.opponentThreats.length > 0) {
      windowScore = (windowScore / goldMatchup.opponentThreats.length) * 2
    } else {
      windowScore = 2
    }
    matchupScore += windowScore

    // Relative plan: targetPace match (2 pts)
    if (output.analysisV2.matchup.relativePlan.targetPace === goldMatchup.relativePlan.targetPace) {
      matchupScore += 2
    }

    matchupScore = Math.max(0, Math.min(10, matchupScore))
    subscores.push({
      category: "Matchup",
      score: matchupScore,
      maxScore: 10,
      details: { compared: true, threatF1, windowScore },
    })
  } else if (!isMatchup) {
    // Skip matchup for single-deck tasks
  }

  // ── 6. Calibration & Abstention (5) ──
  let calibrationScore = 0

  // Collect all confidence values
  const confidences: number[] = []
  for (const wc of dp.winConditions) confidences.push(wc.confidence)
  for (const kp of dp.keyPieces) confidences.push(kp.confidence)
  for (const l of dp.lines) confidences.push(l.confidence)
  if (isMatchup) {
    for (const t of output.analysisV2.matchup.opponentThreats) confidences.push(t.confidence)
    confidences.push(output.analysisV2.matchup.relativePlan.confidence)
  }

  // Check abstentions: correct abstention not penalized
  const abstentions = output.analysisV2.abstentions
  let abstentionBonus = 0

  if (!isMatchup) {
    // For single-deck, if matchup fields are abstained, that's correct
    const matchupAbstained = abstentions.some((a: { field: string; reason: string }) => a.field.startsWith("matchup"))
    if (matchupAbstained) {
      abstentionBonus += 2
    } else if (output.analysisV2.matchup.opponentThreats.length > 0) {
      // Should have abstained but didn't
      issues.push("Matchup fields filled without opponent deck - should abstain")
      abstentionBonus -= 2
    }
  }

  // Confidence spread: avoid all-same (e.g., all 0.5)
  if (confidences.length > 1) {
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length
    const variance = confidences.reduce((s, c) => s + (c - mean) ** 2, 0) / confidences.length
    if (variance < 0.001) {
      // All confidences are the same - suspicious
      calibrationScore += 1
      issues.push("All confidence values are identical - lacks calibration")
    } else {
      calibrationScore += 3
    }
  } else {
    calibrationScore += 3
  }

  // Abstention bonus
  calibrationScore += Math.max(0, abstentionBonus)
  calibrationScore = Math.max(0, Math.min(calibrationMax, calibrationScore))
  subscores.push({
    category: "Calibration & Abstention",
    score: calibrationScore,
    maxScore: calibrationMax,
    details: {
      confidenceCount: confidences.length,
      abstentionCount: abstentions.length,
      abstentionBonus,
    },
  })

  // ── Variant hallucination check ──
  if (variant) {
    const removedId = String(variant.removedCardId)
    const removedName = variant.removedCardName
    // Check if the removed card is still referenced in evidence
    let stillReferenced = false
    for (const wc of dp.winConditions) {
      if (wc.evidence.includes(removedId) || wc.requiredPieces.includes(removedId)) {
        stillReferenced = true
        break
      }
    }
    for (const kp of dp.keyPieces) {
      if (kp.id === removedId || kp.evidence.includes(removedId)) {
        stillReferenced = true
        break
      }
    }
    if (stillReferenced) {
      issues.push(
        `Variant hallucination: references removed card "${removedName}" (id=${removedId})`,
      )
      // Deduct from input fidelity
      const deduction = 4
      const ifSub = subscores.find((s) => s.category === "Input Fidelity")!
      ifSub.score = Math.max(0, ifSub.score - deduction)
    }
  }

  // ── Total ──
  const total = subscores.reduce((s, sub) => s + sub.score, 0)
  const maxTotal = subscores.reduce((s, sub) => s + sub.maxScore, 0)

  return {
    total,
    maxTotal,
    subscores,
    isMatchup,
    variantInfo: variant,
    issues,
  }
}

/**
 * Macro-average scores across multiple deck results.
 * Variant lineages are weighted to 1 (as per doc §4).
 */
export function macroAverage(results: ScoreResult[]): {
  avgTotal: number
  avgByCategory: Record<string, { avg: number; max: number }>
  groupedByLineage: Record<string, ScoreResult[]>
} {
  if (results.length === 0) {
    return { avgTotal: 0, avgByCategory: {}, groupedByLineage: {} }
  }

  // Group by lineage
  const byLineage = new Map<string, ScoreResult[]>()
  for (const r of results) {
    const lineage = r.variantInfo?.lineage ?? "no_lineage"
    const list = byLineage.get(lineage) ?? []
    list.push(r)
    byLineage.set(lineage, list)
  }

  // Average each lineage group, then macro-average across lineages
  const lineageAverages: number[] = []
  const categoryAverages: Record<string, number[]> = {}

  for (const [, group] of byLineage) {
    const avg = group.reduce((s, r) => s + r.total, 0) / group.length
    lineageAverages.push(avg)

    for (const sub of group[0]!.subscores) {
      if (!categoryAverages[sub.category]) categoryAverages[sub.category] = []
      const subAvg = group.reduce((s, r) => {
        const match = r.subscores.find((x) => x.category === sub.category)
        return s + (match?.score ?? 0)
      }, 0) / group.length
      categoryAverages[sub.category]!.push(subAvg)
    }
  }

  const avgTotal = lineageAverages.reduce((a, b) => a + b, 0) / lineageAverages.length
  const avgByCategory: Record<string, { avg: number; max: number }> = {}
  for (const [cat, vals] of Object.entries(categoryAverages)) {
    const max = results[0]!.subscores.find((s) => s.category === cat)?.maxScore ?? 0
    avgByCategory[cat] = {
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      max,
    }
  }

  const groupedByLineage: Record<string, ScoreResult[]> = {}
  for (const [lineage, group] of byLineage) {
    groupedByLineage[lineage] = group
  }

  return { avgTotal, avgByCategory, groupedByLineage }
}
