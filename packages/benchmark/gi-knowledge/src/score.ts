// Copyright (C) 2026 Piovium Labs
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

import type { BenchmarkQuestion, EvaluationResult } from "./types"
/**
 * Score an LLM's answer against the ground truth.
 */
export function scoreAnswer(
  question: BenchmarkQuestion,
  llmAnswer: string,
): EvaluationResult {
  const gt = Array.isArray(question.groundTruth)
    ? question.groundTruth
    : [question.groundTruth]
  const answerLower = llmAnswer.toLowerCase().trim()
  const keywords = question.keywords

  let passed = false
  let score = 0
  const details: string[] = []

  // Strategy 1: Full ground truth containment (most reliable)
  for (const g of gt) {
    if (answerLower.includes(g.toLowerCase())) {
      score = 1
      passed = true
      details.push(`直接命中: "${g.slice(0, 50)}"`)
      break
    }
  }

  // Strategy 2: Longest keyword match (most distinctive)
  if (!passed && keywords.length > 0) {
    // Sort keywords by length descending, pick the longest
    const sorted = [...keywords].sort((a, b) => b.length - a.length)
    const longest = sorted[0]!
    if (longest.length >= 6 && answerLower.includes(longest.toLowerCase())) {
      score = 0.9
      passed = true
      details.push(`核心关键词命中: "${longest.slice(0, 50)}"`)
    }
  }

  // Strategy 3: Keyword majority (>= 4 keywords, require 2/3 majority)
  if (!passed && keywords.length >= 4) {
    const matched = keywords.filter((kw) =>
      answerLower.includes(kw.toLowerCase()),
    )
    const ratio = matched.length / keywords.length
    if (ratio >= 0.66) {
      score = ratio
      passed = true
      details.push(`关键词多数命中 ${matched.length}/${keywords.length}: ${matched.join(", ")}`)
    }
  }

  // Strategy 4: Multi-answer questions (any 3 items from ground truth)
  if (!passed && question.category === "multiple-answer") {
    const namedItems = gt.filter((g) => g.length > 1 && g.length < 20)
    const found = namedItems.filter((n) => answerLower.includes(n.toLowerCase()))
    if (found.length >= 3) {
      score = Math.min(1, found.length / namedItems.length)
      passed = true
      details.push(`多答案: 找到 ${found.length}/${namedItems.length} 个: ${found.join(", ")}`)
    }
  }

  if (!passed) {
    details.push(`未匹配。期望: "${gt[0]?.slice(0, 60)}"`)
  }

  return {
    questionId: question.id,
    category: question.category,
    question: question.question,
    groundTruth: question.groundTruth,
    llmAnswer,
    passed,
    score,
    details: details.join("；"),
  }
}

/**
 * Batch score multiple answers.
 */
export function scoreBatch(
  questions: BenchmarkQuestion[],
  llmAnswers: Map<string, string>,  // questionId -> answer
): EvaluationResult[] {
  const results: EvaluationResult[] = []
  for (const q of questions) {
    const answer = llmAnswers.get(q.id) ?? ""
    results.push(scoreAnswer(q, answer))
  }
  return results
}

/**
 * Generate a human-readable report from evaluation results.
 */
export function formatReport(results: EvaluationResult[], questions?: BenchmarkQuestion[]): string {
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0"

  // Overlap segregation
  let overlapTotal = 0, overlapPassed = 0
  let tcgTotal = 0, tcgPassed = 0
  if (questions) {
    for (let i = 0; i < results.length; i++) {
      const q = questions[i]
      if (!q) continue
      if (q.overlap) {
        overlapTotal++
        if (results[i]!.passed) overlapPassed++
      } else {
        tcgTotal++
        if (results[i]!.passed) tcgPassed++
      }
    }
  }

  const byCategory: Record<string, { total: number; passed: number }> = {}
  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, passed: 0 }
    }
    byCategory[r.category].total++
    if (r.passed) byCategory[r.category].passed++
  }

  const lines: string[] = []
  lines.push("=".repeat(60))
  lines.push(` 七圣召唤世界知识评测报告`)
  lines.push("=".repeat(60))
  lines.push(`总题数: ${total}`)
  lines.push(`通过: ${passed}`)
  lines.push(`通过率: ${passRate}%`)
  if (tcgTotal > 0) {
    const tcgRate = ((tcgPassed / tcgTotal) * 100).toFixed(1)
    lines.push(`──`)
    lines.push(`纯TCG知识: ${tcgPassed}/${tcgTotal} (${tcgRate}%)`)
  }
  if (overlapTotal > 0) {
    const ovRate = ((overlapPassed / overlapTotal) * 100).toFixed(1)
    lines.push(`与原神重合(元素/武器/阵营): ${overlapPassed}/${overlapTotal} (${ovRate}%)`)
  }
  lines.push("")
  lines.push("── 各分类表现 ──")
  lines.push("")

  const catOrder = Object.entries(byCategory).sort(
    (a, b) => b[1].total - a[1].total,
  )
  for (const [cat, stats] of catOrder) {
    const catRate = ((stats.passed / stats.total) * 100).toFixed(1)
    const barLen = Math.round((stats.passed / stats.total) * 20)
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen)
    lines.push(
      `  ${cat.padEnd(30)} ${String(stats.passed).padStart(3)}/${String(stats.total).padStart(3)} ${catRate.padStart(5)}% ${bar}`,
    )
  }

  lines.push("")
  lines.push("── 失败题详情 ──")
  const failed = results.filter((r) => !r.passed)
  for (const r of failed.slice(0, 20)) {
    lines.push("")
    lines.push(`  [${r.questionId}] ${r.category}`)
    lines.push(`  Q: ${r.question}`)
    lines.push(`  A: ${r.llmAnswer.slice(0, 120)}`)
    lines.push(`  GT: ${Array.isArray(r.groundTruth) ? r.groundTruth.join(" / ") : r.groundTruth}`)
    lines.push(`  Details: ${r.details}`)
  }
  if (failed.length > 20) {
    lines.push(`  ... 还有 ${failed.length - 20} 题失败详情未显示`)
  }

  lines.push("")
  lines.push("=".repeat(60))
  return lines.join("\n")
}
