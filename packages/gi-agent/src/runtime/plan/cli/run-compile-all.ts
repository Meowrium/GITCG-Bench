// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Batch compiler: DeckAnalysis → PlanPhase[] JSON files.
 *
 * Reads a benchmark JSON, collects all unique deck codes, runs
 * heuristic DeckAnalyzer for each, compiles PlanPhase[] via
 * compileDeckAnalysisToPlan(), and writes {deckFingerprint}.plan.json
 * to the output directory.
 *
 * The LLM API key is read from the environment variable DECK_ANALYZER_API_KEY
 * (or OPENAI_API_KEY as fallback). If neither is set, only heuristic baseline
 * analysis is used (no LLM enhancement).
 *
 * Usage:
 *   pnpm exec gnx packages/gi-agent/src/runtime/plan/cli/run-compile-all.ts \
 *     --benchmark benchmark.training-v3.json \
 *     --output ./output/plan-phases/
 *
 *   # With LLM enhancement:
 *   DECK_ANALYZER_API_KEY=sk-... \
 *   pnpm exec gnx packages/gi-agent/src/runtime/plan/cli/run-compile-all.ts \
 *     --benchmark benchmark.training-v3.json \
 *     --output ./output/plan-phases/ \
 *     --llm-enhance
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  DeckAnalyzer,
  buildDeckAnalysisPrompt,
  parseJsonAnalysisResult,
  decodeDeck,
  createDeckContext,
  type DeckAnalysis,
} from "@gi-tcg/llm-deck-analyzer"
import { classifyDeck, compileDeckAnalysisToPlan } from "../compiler.js"
import type { DeckMeta } from "../types.js"
import type { PlanPhase } from "../types.js"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  benchmark: string
  output: string
  llmEnhance: boolean
  apiKey?: string
  model?: string
  baseUrl?: string
}

function parseArgs(args: string[]): CliArgs {
  const positional: string[] = []
  const flags: Record<string, string> = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2)
        flags[k] = v ?? "true"
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i]
      } else {
        flags[key] = "true"
      }
    } else {
      positional.push(args[i])
    }
  }

  const benchmark = flags["benchmark"] ?? positional[0]
  if (!benchmark) {
    console.error("Usage: run-compile-all.ts --benchmark <path> --output <dir> [--llm-enhance] [--api-key <key>]")
    process.exit(1)
  }

  return {
    benchmark: resolve(process.cwd(), benchmark),
    output: resolve(process.cwd(), flags["output"] ?? "./output/plan-phases"),
    llmEnhance: flags["llm-enhance"] === "true" || false,
    apiKey: flags["api-key"] ?? process.env["DECK_ANALYZER_API_KEY"] ?? process.env["OPENAI_API_KEY"],
    model: flags["model"] ?? process.env["DECK_ANALYZER_MODEL"] ?? process.env["OPENAI_MODEL"],
    baseUrl: flags["base-url"] ?? process.env["DECK_ANALYZER_BASE_URL"] ?? process.env["OPENAI_BASE_URL"],
  }
}

// ---------------------------------------------------------------------------
// Benchmark deck code extraction
// ---------------------------------------------------------------------------

interface BenchmarkConfig {
  version?: string
  matchups?: Array<{
    deck0: string
    deck1: string
    priorMatrixBatch?: { decks?: Array<{ deckCode: string }> }
  }>
}

function extractDeckCodes(benchmarkPath: string): string[] {
  const raw = JSON.parse(
    require("node:fs").readFileSync(benchmarkPath, "utf-8"),
  ) as BenchmarkConfig

  const codes = new Set<string>()

  for (const mu of raw.matchups ?? []) {
    if (mu.deck0) codes.add(mu.deck0)
    if (mu.deck1) codes.add(mu.deck1)
    for (const deck of mu.priorMatrixBatch?.decks ?? []) {
      if (deck.deckCode) codes.add(deck.deckCode)
    }
  }

  return [...codes]
}

// ---------------------------------------------------------------------------
// LLM enhancement (optional)
// ---------------------------------------------------------------------------

async function enhanceWithLLM(
  baseline: DeckAnalysis,
  deckCode: string,
  apiKey: string,
  model?: string,
  baseUrl?: string,
): Promise<DeckAnalysis> {
  const context = await createDeckContext(deckCode)
  const prompt = buildDeckAnalysisPrompt(context)

  const modelName = model ?? "gpt-4o-mini"
  const apiBaseUrl = baseUrl ?? "https://api.openai.com/v1"

  console.log(`    [LLM] Calling ${modelName} via ${apiBaseUrl}...`)

  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.warn(`    [LLM] API error (${response.status}): ${errorText.slice(0, 200)}`)
    console.warn(`    [LLM] Falling back to heuristic baseline.`)
    return baseline
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content

  if (!content) {
    console.warn("    [LLM] Empty response, falling back to baseline.")
    return baseline
  }

  try {
    const parsed = parseJsonAnalysisResult(content) as DeckAnalysis
    console.log(`    [LLM] Enhanced successfully.`)
    return parsed
  } catch (err) {
    console.warn(`    [LLM] Parse error: ${String(err)}. Falling back to baseline.`)
    return baseline
  }
}

// ---------------------------------------------------------------------------
// File naming
// ---------------------------------------------------------------------------

function deckFingerprint(deckCode: string): string {
  // Use the first 20 chars of the deck code as filename-safe fingerprint
  // (deck codes are already alphanumeric base64 without special chars)
  return deckCode.length <= 40 ? deckCode : deckCode.slice(0, 20) + "_" + simpleHash(deckCode)
}

function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 6)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log("=== SPL Plan Compiler (Batch) ===\n")
  console.log(`Benchmark: ${args.benchmark}`)
  console.log(`Output:    ${args.output}`)
  console.log(`LLM:       ${args.llmEnhance && args.apiKey ? "enabled" : "disabled"}`)
  if (args.llmEnhance) {
    console.log(`Model:     ${args.model ?? "gpt-4o-mini"}`)
    console.log(`Base URL:  ${args.baseUrl ?? "https://api.openai.com/v1"}`)
  }
  console.log()

  // Extract unique deck codes
  const deckCodes = extractDeckCodes(args.benchmark)
  console.log(`Found ${deckCodes.length} unique deck codes.\n`)

  // Create output dir
  mkdirSync(args.output, { recursive: true })

  const analyzer = new DeckAnalyzer()
  let successCount = 0
  let failCount = 0

  for (let i = 0; i < deckCodes.length; i++) {
    const code = deckCodes[i]
    const fingerprint = deckFingerprint(code)

    try {
      const parsed = decodeDeck(code)
      const deckLabel = parsed.characters.join("/") || fingerprint.slice(0, 20)

      console.log(`[${i + 1}/${deckCodes.length}] ${deckLabel}`)
      console.log(`  Code: ${fingerprint}`)

      // Heuristic baseline analysis
      let analysis = await analyzer.analyzeDeck(code, deckLabel)

      // Optional LLM enhancement
      if (args.llmEnhance && args.apiKey) {
        analysis = await enhanceWithLLM(analysis, code, args.apiKey, args.model, args.baseUrl)
      }

      // Compile to PlanPhase[]
      const phases = compileDeckAnalysisToPlan(analysis)

      // Write plan JSON
      const planPath = join(args.output, `${fingerprint}.plan.json`)
      const deckMeta = classifyDeck(analysis)
      const planOutput = {
        deckFingerprint: fingerprint,
        deckCode: code,
        deckName: deckLabel,
        compiledAt: new Date().toISOString(),
        source: args.llmEnhance && args.apiKey ? "llm_enhanced" : "heuristic",
        deckMeta,
        phases,
      }
      writeFileSync(planPath, JSON.stringify(planOutput, null, 2), "utf-8")
      console.log(`  → ${basename(planPath)} (${phases.length} phases)`)
      successCount++
    } catch (err) {
      console.error(`  ERROR: ${String(err)}`)
      failCount++
    }
    console.log()
  }

  // Write index file mapping deck fingerprints to deck names
  const indexPath = join(args.output, "_index.json")
  const index: Record<string, { deckCode: string; name: string }> = {}
  for (const code of deckCodes) {
    const fp = deckFingerprint(code)
    try {
      const parsed = decodeDeck(code)
      index[fp] = { deckCode: code, name: parsed.characters.join("/") }
    } catch {
      index[fp] = { deckCode: code, name: code.slice(0, 20) }
    }
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8")

  console.log(`=== Done: ${successCount} succeeded, ${failCount} failed ===`)
  console.log(`Plan files written to: ${args.output}`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
