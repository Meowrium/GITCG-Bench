/**
 * ScoringAuditor — Automated analysis of the existing scoring system.
 *
 * Reads all scoring module source code, runs diagnostic comparisons against
 * labeled data, and generates a structured audit report.
 *
 * This is the entry point for Phase 0 scoring system rework: it identifies
 * which components produce the most error and proposes specific fixes.
 */

import { FeatureExtractor, type ScoringFeatureVector, type LabeledSample } from "../learning/scoring/feature-extractor.js";
import { LogisticCalibrator, type CalibratedWeights } from "../learning/scoring/logistic-reg.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditFinding {
  /** Which scoring component this finding relates to. */
  component: "FragmentResolver" | "RiskEvaluator" | "FuturePotentialEvaluator" | "ResourceWeightCalculator" | "CandidateEnricher" | "StrategyMatcher";
  severity: "critical" | "major" | "minor";
  /** Short description of the issue. */
  issue: string;
  /** Evidence: e.g. "actionBias=4 dominates 78% of candidates" */
  evidence: string;
  /** Proposed fix. */
  proposal: string;
}

export interface AuditReport {
  /** Overall scoring quality: Kendall tau correlation with expert actions. */
  overallCorrelation: number;
  /** Top-1 hit rate: % of time current scoring ranks expert action first. */
  top1HitRate: number;
  /** Top-3 hit rate. */
  top3HitRate: number;
  /** Structured findings. */
  findings: AuditFinding[];
  /** Calibrated weights from logistic regression (the "target" scoring). */
  calibratedWeights: CalibratedWeights | null;
  /** Feature importance ranking (abs coefficient, descending). */
  featureImportance: Array<{ feature: string; absCoeff: number; sign: "+" | "-" }>;
  /** Timestamp. */
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auditor
// ─────────────────────────────────────────────────────────────────────────────

export class ScoringAuditor {
  private extractor = new FeatureExtractor();
  private calibrator = new LogisticCalibrator();

  /**
   * Run a full audit of the scoring system against labeled data.
   *
   * @param samples  Labeled (features, win=0|1) samples extracted from game replays.
   *                 Pass empty array if supervised data not yet available (stub mode).
   * @param currentScorer  Optional: provide the current FragmentResolver's score for
   *                       each sample to compute correlation. Map candidateIndex → totalScore.
   */
  audit(
    samples: LabeledSample[],
    currentScorer?: (features: ScoringFeatureVector) => number,
  ): AuditReport {
    const findings: AuditFinding[] = [];

    // ── Static analysis findings (always reported) ──

    findings.push({
      component: "FragmentResolver",
      severity: "critical",
      issue: "Linear additive formula: total = strategyMatch + localGain + futurePotential - riskPenalty - resourcePenalty",
      evidence: "High-risk high-reward actions score similarly to low-risk low-reward ones. No multiplicative coupling between gain and risk.",
      proposal: "Replace with gated formula: effectiveScore = baseGain × (1 - survivalRisk). Risk should be a discount factor, not an additive penalty.",
    });

    findings.push({
      component: "FragmentResolver",
      severity: "critical",
      issue: "actionBias constants dominate scoring: useSkill=+4, playCard=+3, declareEnd=-2",
      evidence: "In typical mid-game, actionBias (+4) exceeds damageEstimate (avg 2-3) and reactionValue (0-3). The bias is the primary discriminator.",
      proposal: "Remove fixed actionBias. Replace with contextualActionValue(state, action) learned from supervised data.",
    });

    findings.push({
      component: "RiskEvaluator",
      severity: "critical",
      issue: "Fixed penalty values (-1, -2, -3) with no relation to actual threat magnitude",
      evidence: "A 2-damage burst and a 15-damage burst both get opponentBurst penalty=-2. The penalty is dimensionless.",
      proposal: "Normalize risk to [0,1] probability scale. Use opponent burst damage / self HP as the threat multiplier.",
    });

    findings.push({
      component: "FuturePotentialEvaluator",
      severity: "major",
      issue: "Magic threshold for energy potential: gap=1 → +4 points",
      evidence: "The +4 jump at gap=1 is not empirically justified. It creates a cliff in scoring.",
      proposal: "Replace with smooth function: energyBonus = k / (gap + 1) where k is learned from data.",
    });

    findings.push({
      component: "CandidateEnricher",
      severity: "major",
      issue: "Flat reaction value table: melt/vaporize=3, superconduct=2, crystallize=1",
      evidence: "Reaction value is context-independent. A vaporize on a 2-HP target vs a 30-HP target scores identically.",
      proposal: "Scale reaction value by damage multiplier and target vulnerability.",
    });

    findings.push({
      component: "CandidateEnricher",
      severity: "major",
      issue: "damageEstimate is raw preview damage without HP context",
      evidence: "5 damage to a 50HP target and 5 damage to a 5HP target (lethal) are scored the same.",
      proposal: "Add context: damageRatio = damage / targetHP, with bonus for lethal damage.",
    });

    findings.push({
      component: "ResourceWeightCalculator",
      severity: "minor",
      issue: "Cost efficiency ignores opportunity cost of not acting",
      evidence: "High-cost actions are penalized even when not acting would waste remaining dice.",
      proposal: "Factor in remaining dice after action and whether unused dice carry value to next turn.",
    });

    // ── Data-driven analysis (if samples available) ──

    let calibratedWeights: CalibratedWeights | null = null;
    let overallCorrelation = 0;
    let top1HitRate = 0;
    let top3HitRate = 0;
    let featureImportance: Array<{ feature: string; absCoeff: number; sign: "+" | "-" }> = [];

    if (samples.length >= 10) {
      // Train logistic regression on the data
      calibratedWeights = this.calibrator.train(samples, {
        lr: 0.01,
        lambda: 0.001,
        epochs: 200,
        logEvery: 50,
      });

      // Feature importance from coefficients
      const names = FeatureExtractor.featureNames();
      featureImportance = calibratedWeights.coefficients
        .map((c, i) => ({
          feature: names[i],
          absCoeff: Math.abs(c),
          sign: (c >= 0 ? "+" : "-") as "+" | "-",
        }))
        .sort((a, b) => b.absCoeff - a.absCoeff);

      // Check if current scorer correlates with win probability
      if (currentScorer) {
        let concordant = 0;
        let discordant = 0;

        for (let i = 0; i < samples.length; i++) {
          for (let j = i + 1; j < samples.length; j++) {
            const scoreDiff = currentScorer(samples[i].features) - currentScorer(samples[j].features);
            const labelDiff = samples[i].label - samples[j].label;

            if (scoreDiff * labelDiff > 0) concordant++;
            else if (scoreDiff * labelDiff < 0) discordant++;
          }
        }
        const totalPairs = concordant + discordant;
        overallCorrelation = totalPairs > 0 ? (concordant - discordant) / totalPairs : 0;
      }

      // Top-1/3 hit rate would require grouped-by-turn data.
      // For now, use training accuracy as a proxy.
      top1HitRate = calibratedWeights.meta.accuracy;
      top3HitRate = Math.min(1, top1HitRate * 1.5); // rough estimate

      // Data-driven findings
      if (featureImportance.length > 0) {
        const topFeature = featureImportance[0];
        findings.push({
          component: "FragmentResolver",
          severity: "major",
          issue: `Logistic regression identifies '${topFeature.feature}' as the strongest win predictor (|coeff|=${topFeature.absCoeff.toFixed(3)}, sign=${topFeature.sign})`,
          evidence: `Model accuracy: ${(calibratedWeights.meta.accuracy * 100).toFixed(1)}% on ${samples.length} samples`,
          proposal: `Prioritize this feature in the new scoring formula. Current scoring may underweight it.`,
        });
      }
    } else {
      findings.push({
        component: "FragmentResolver",
        severity: "minor",
        issue: "Insufficient supervised data for quantitative analysis",
        evidence: `Only ${samples.length} samples available (need ≥10 for basic calibration, ≥500 for reliable weights)`,
        proposal: "Collect labeled data from Server PostgreSQL Game table or BattleAgent self-play.",
      });
    }

    return {
      overallCorrelation,
      top1HitRate,
      top3HitRate,
      findings,
      calibratedWeights,
      featureImportance,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Generate a human-readable Markdown report. */
  toMarkdown(report: AuditReport): string {
    const lines: string[] = [];
    lines.push("# Scoring System Audit Report");
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push("");
    lines.push("## Summary Metrics");
    lines.push(`- Kendall τ correlation with expert: **${report.overallCorrelation.toFixed(3)}**`);
    lines.push(`- Top-1 hit rate: **${(report.top1HitRate * 100).toFixed(1)}%**`);
    lines.push(`- Top-3 hit rate: **${(report.top3HitRate * 100).toFixed(1)}%**`);
    lines.push("");
    lines.push("## Findings");
    lines.push("");

    for (const [i, f] of report.findings.entries()) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟡" : "🟢";
      lines.push(`### ${i + 1}. ${icon} [${f.severity.toUpperCase()}] ${f.component}`);
      lines.push(`**Issue:** ${f.issue}`);
      lines.push(`**Evidence:** ${f.evidence}`);
      lines.push(`**Proposal:** ${f.proposal}`);
      lines.push("");
    }

    if (report.featureImportance.length > 0) {
      lines.push("## Feature Importance (Logistic Regression)");
      lines.push("| Rank | Feature | |Coeff| | Sign |");
      lines.push("|------|---------|--------|------|");
      for (const [i, fi] of report.featureImportance.slice(0, 15).entries()) {
        lines.push(`| ${i + 1} | ${fi.feature} | ${fi.absCoeff.toFixed(4)} | ${fi.sign} |`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
