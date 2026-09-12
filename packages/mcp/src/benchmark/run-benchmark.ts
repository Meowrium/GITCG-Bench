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
 * Pre-Game Deck Analysis Benchmark Runner
 *
 * Runs the benchmark pipeline for a single deck or matchup:
 *   1. Generate deck context (createDeckContext, pure data)
 *   2. Send to LLM with pre-game-analysis-pure.md prompt
 *   3. Parse LLM output as JSON
 *   4. Validate against analysisV2 Zod schema
 *   5. Validate evidence IDs against input deck data
 *   6. Score against gold (if provided)
 *   7. Output results as JSON
 *
 * Does NOT start any headless game.
 *
 * Usage:
 *   gnx packages/mcp/src/benchmark/run-benchmark.ts \
 *     --deck "A0BQ9CEPA1..." \
 *     --opp-deck "APBw4CAOA..." \
 *     --model GLM-5 \
 *     --api-base https://api.example.com/v1 \
 *     --api-key sk-xxx \
 *     --prompt .opencode/prompts/pre-game-analysis-pure.md \
 *     --output .opencode/tmp/benchmark-results/
 */

/// <reference types="node" />

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { parseArgs } from "node:util"
import { createHash } from "node:crypto"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer"
import { generateVariants, makeLineageId, type DeckVariant } from "./variant-generator.js"
import { validateSchema, validateEvidence, buildValidIdSet } from "./evidence-validator.js"
import { scoreAnalysis, type ScoreResult, type GoldAnalysis } from "./scorer.js"
import { runBootstrap, formatCI } from "./bootstrap.js"

// ─── Types ────────────────────────────────────────────────────────────────

interface CliArgs {
  deckCode: string
  oppDeckCode: string
  version: string
  model: string
  apiBase: string
  apiKey: string
  promptTemplate: string
  outputDir: string
  track: "reasoning-pure" | "heuristic-assisted"
  goldPath: string
  generateVariants: boolean
  temperature: number
  maxTokens: number
  bootstrapIterations: number
}

interface BenchmarkResult {
  sampleId: string
  track: string
  model: string
  deckCode: string
  oppDeckCode: string | null
  version: string
  promptHash: string
  temperature: number
  timestamp: string
  schemaValid: boolean
  schemaErrors: string[]
  evidenceValid: boolean
  evidenceIssues: number
  hallucinatedIds: number
  crossSideViolations: number
  score?: ScoreResult
  goldAvailable: boolean
  rawOutput: unknown
  parsedOutput?: unknown
  variantInfo?: DeckVariant
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      "deck": { type: "string" },
      "opp-deck": { type: "string", default: "" },
      "version": { type: "string", default: "" },
      "model": { type: "string", default: "GLM-5" },
      "api-base": { type: "string", default: "" },
      "api-key": { type: "string", default: "" },
      "prompt": { type: "string", default: ".opencode/prompts/pre-game-analysis-pure.md" },
      "output": { type: "string", default: ".opencode/tmp/benchmark-results" },
      "track": { type: "string", default: "reasoning-pure" },
      "gold": { type: "string", default: "" },
      "variants": { type: "string", default: "0" },
      "temperature": { type: "string", default: "0.3" },
      "max-tokens": { type: "string", default: "8192" },
      "bootstrap-iterations": { type: "string", default: "1000" },
    },
    strict: false,
  })

  const deckCode = values["deck"] as string
  if (!deckCode) throw new Error("--deck is required")

  const apiBase = (values["api-base"] as string) || process.env.OPENAI_API_BASE || ""
  const apiKey = (values["api-key"] as string) || process.env.OPENAI_API_KEY || ""
  if (!apiBase || !apiKey) {
    throw new Error("--api-base and --api-key (or OPENAI_API_BASE/OPENAI_API_KEY) are required")
  }

  const track = values["track"] as string
  if (track !== "reasoning-pure" && track !== "heuristic-assisted") {
    throw new Error(`--track must be reasoning-pure or heuristic-assisted, got: ${track}`)
  }

  return {
    deckCode,
    oppDeckCode: (values["opp-deck"] as string) || "",
    version: (values["version"] as string) || "",
    model: values["model"] as string,
    apiBase,
    apiKey,
    promptTemplate: values["prompt"] as string,
    outputDir: values["output"] as string,
    track,
    goldPath: (values["gold"] as string) || "",
    generateVariants: values["variants"] === "1" || values["variants"] === "true",
    temperature: parseFloat(values["temperature"] as string),
    maxTokens: parseInt(values["max-tokens"] as string, 10),
    bootstrapIterations: parseInt(values["bootstrap-iterations"] as string, 10),
  }
}

// ─── Deck data builder ────────────────────────────────────────────────────

async function buildDeckDataJson(
  deckCode: string,
  version?: string,
): Promise<string> {
  const manager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
  const context = await createDeckContext(deckCode, manager)

  const data = {
    deckCode,
    version: version ?? null,
    characters: context.characterFullInfo.map((ch) => ({
      id: ch.id,
      name: ch.name,
      elements: ch.elements,
      weapon: ch.weapon,
      nations: ch.nations,
      hp: ch.hp,
      maxEnergy: ch.maxEnergy,
      skills: ch.skills.map((s) => ({
        name: s.name,
        type: s.type,
        description: s.description,
        playCost: s.playCost,
      })),
    })),
    cards: context.cards.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      tags: c.tags,
      relatedCharacterTag: c.relatedCharacterTag,
      description: c.description,
      playingDescription: c.playingDescription || undefined,
      playCost: c.playCost,
      meaningfulTags: c.meaningfulTags,
    })),
    cardCounts: context.summary.cardFrequencies
      .filter((f) => f.count > 1)
      .map((f) => ({ name: f.name, count: f.count })),
    entityDescriptions: Object.fromEntries(context.entityDescriptions),
    generatedHandCards: Object.fromEntries(context.generatedHandCardDescriptions),
    summary: {
      elementCounts: context.summary.elementCounts,
      nations: context.summary.nations,
      equipmentCount: context.summary.equipmentCount,
      eventCount: context.summary.eventCount,
      supportCount: context.summary.supportCount,
      talentCount: context.summary.talentCount,
      weaponCount: context.summary.weaponCount,
      artifactCount: context.summary.artifactCount,
      resonanceCount: context.summary.resonanceCount,
    },
  }

  return JSON.stringify(data, null, 2)
}

// ─── LLM caller ───────────────────────────────────────────────────────────

async function callLlm(
  model: string,
  apiBase: string,
  apiKey: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<string> {
  const normalizedBase = apiBase.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "")
  const url = `${normalizedBase}/chat/completions`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }],
      temperature,
      max_tokens: maxTokens,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string | null } }>
  }
  return data.choices?.[0]?.message?.content ?? ""
}

// ─── JSON extraction ────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  const trimmed = text.trim()

  // Try direct parse
  try {
    return JSON.parse(trimmed)
  } catch { /* continue */ }

  // Try to find first { ... last }
  const firstBrace = trimmed.indexOf("{")
  const lastBrace = trimmed.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1)
    try {
      return JSON.parse(jsonStr)
    } catch { /* continue */ }
  }

  throw new Error("Could not extract JSON from LLM response")
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function runSingleSample(
  cli: CliArgs,
  deckCode: string,
  deckName: string,
  oppDeckCode: string | null,
  variant?: DeckVariant,
): Promise<BenchmarkResult> {
  const version = cli.version || undefined
  const hasOpponent = oppDeckCode !== null
  const sampleId = variant
    ? `${deckName}_${variant.kind}`
    : deckName

  console.log(`\n=== Benchmark: ${sampleId} ===`)
  console.log(`  Deck: ${deckCode.slice(0, 20)}...`)
  if (oppDeckCode) console.log(`  Opp:  ${oppDeckCode.slice(0, 20)}...`)

  // 1. Build deck data
  console.log("  Building deck contexts...")
  const myDeckData = await buildDeckDataJson(deckCode, version)
  const oppDeckData = hasOpponent
    ? await buildDeckDataJson(oppDeckCode, version)
    : "{}"

  // 2. Build prompt
  const promptTemplate = readFileSync(resolve(process.cwd(), cli.promptTemplate), "utf8")
  const promptHash = createHash("sha256").update(promptTemplate).digest("hex").slice(0, 16)
  const systemPrompt = promptTemplate
    .replace("{myDeckData}", myDeckData)
    .replace("{oppDeckData}", oppDeckData)

  // 3. Call LLM
  console.log(`  Calling LLM (${cli.model})...`)
  const llmResponse = await callLlm(
    cli.model,
    cli.apiBase,
    cli.apiKey,
    systemPrompt,
    cli.temperature,
    cli.maxTokens,
  )

  // 4. Parse JSON
  let rawOutput: unknown
  try {
    rawOutput = extractJson(llmResponse)
  } catch (e) {
    console.error(`  Failed to extract JSON: ${(e as Error).message}`)
    return {
      sampleId,
      track: cli.track,
      model: cli.model,
      deckCode,
      oppDeckCode,
      version: cli.version,
      promptHash,
      temperature: cli.temperature,
      timestamp: new Date().toISOString(),
      schemaValid: false,
      schemaErrors: [`JSON extraction failed: ${(e as Error).message}`],
      evidenceValid: false,
      evidenceIssues: 1,
      hallucinatedIds: 0,
      crossSideViolations: 0,
      goldAvailable: false,
      rawOutput: llmResponse,
      variantInfo: variant,
    }
  }

  // 5. Validate schema
  const { result: schemaResult, parsed } = validateSchema(rawOutput)

  if (!schemaResult.valid) {
    console.error(`  Schema validation failed: ${schemaResult.errors.length} errors`)
    return {
      sampleId,
      track: cli.track,
      model: cli.model,
      deckCode,
      oppDeckCode,
      version: cli.version,
      promptHash,
      temperature: cli.temperature,
      timestamp: new Date().toISOString(),
      schemaValid: false,
      schemaErrors: [...schemaResult.errors, ...schemaResult.archetypeIssues],
      evidenceValid: false,
      evidenceIssues: 0,
      hallucinatedIds: 0,
      crossSideViolations: 0,
      goldAvailable: cli.goldPath !== "",
      rawOutput,
      parsedOutput: parsed,
      variantInfo: variant,
    }
  }

  console.log("  Schema valid. Validating evidence...")

  // 6. Validate evidence
  const idSet = buildValidIdSet(
    JSON.parse(myDeckData),
    hasOpponent ? JSON.parse(oppDeckData) : undefined,
  )
  const evidenceResult = validateEvidence(parsed!, idSet)

  console.log(
    `  Evidence: ${evidenceResult.valid ? "OK" : "ISSUES"} ` +
    `(hallucinated=${evidenceResult.stats.hallucinated}, crossSide=${evidenceResult.stats.crossSide})`,
  )

  // 7. Score against gold (if available)
  let score: ScoreResult | undefined
  let goldAvailable = false
  if (cli.goldPath && existsSync(cli.goldPath)) {
    const goldRaw = readFileSync(cli.goldPath, "utf8")
    const goldData = JSON.parse(goldRaw) as { samples?: Record<string, unknown> }
    // Look up gold by sampleId or deckCode
    // (simplified: use the first gold for now)
    const gold = goldData.samples?.[sampleId] as { gold?: GoldAnalysis } | undefined
    if (gold?.gold) {
      goldAvailable = true
      score = scoreAnalysis({
        output: parsed!,
        gold: gold.gold,
        evidenceValidation: evidenceResult,
        hasOpponent,
        variant,
      })
      console.log(`  Score: ${score.total.toFixed(1)}/${score.maxTotal}`)
    }
  }

  if (!score) {
    // Score without gold (smoke test)
    score = scoreAnalysis({
      output: parsed!,
      gold: undefined,
      evidenceValidation: evidenceResult,
      hasOpponent,
      variant,
    })
    console.log(`  Score (no gold): ${score.total.toFixed(1)}/${score.maxTotal}`)
  }

  return {
    sampleId,
    track: cli.track,
    model: cli.model,
    deckCode,
    oppDeckCode,
    version: cli.version,
    promptHash,
    temperature: cli.temperature,
    timestamp: new Date().toISOString(),
    schemaValid: true,
    schemaErrors: [],
    evidenceValid: evidenceResult.valid,
    evidenceIssues: evidenceResult.issues.length,
    hallucinatedIds: evidenceResult.stats.hallucinated,
    crossSideViolations: evidenceResult.stats.crossSide,
    score,
    goldAvailable,
    rawOutput,
    parsedOutput: parsed,
    variantInfo: variant,
  }
}

async function main() {
  const cli = parseCli()
  const projectDir = process.cwd()
  const outputDirAbs = resolve(projectDir, cli.outputDir)
  mkdirSync(outputDirAbs, { recursive: true })

  console.log("=== Pre-Game Deck Analysis Benchmark ===")
  console.log(`  Model:  ${cli.model}`)
  console.log(`  Track:  ${cli.track}`)
  console.log(`  Output: ${outputDirAbs}`)

  const allResults: BenchmarkResult[] = []

  // Run base deck
  const baseResult = await runSingleSample(
    cli,
    cli.deckCode,
    "base",
    cli.oppDeckCode || null,
  )
  allResults.push(baseResult)

  // Generate and run variants if requested
  if (cli.generateVariants) {
    console.log("\n=== Generating variants ===")
    const version = cli.version || undefined
    const manager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
    const lineage = makeLineageId(cli.deckCode, "bench")
    const variantResult = await generateVariants(cli.deckCode, lineage, manager)

    console.log(`  Generated ${variantResult.variants.length} variants`)
    for (const v of variantResult.variants) {
      console.log(`    ${v.kind}: ${v.description}`)
    }

    for (const variant of variantResult.variants) {
      const result = await runSingleSample(
        cli,
        variant.deckCode,
        variant.parentDeckCode.slice(0, 10),
        cli.oppDeckCode || null,
        variant,
      )
      allResults.push(result)
    }
  }

  // Save results
  const resultsPath = join(outputDirAbs, "benchmark_results.json")
  writeFileSync(
    resultsPath,
    JSON.stringify({
      model: cli.model,
      track: cli.track,
      timestamp: new Date().toISOString(),
      results: allResults,
    }, null, 2) + "\n",
    "utf8",
  )
  console.log(`\nResults saved: ${resultsPath}`)

  // Run bootstrap if we have scores
  const scoredResults = allResults.filter((r) => r.score !== undefined)
  if (scoredResults.length >= 2) {
    const scoreResults = scoredResults.map((r) => r.score!)
    const report = runBootstrap(scoreResults, {
      iterations: Math.min(cli.bootstrapIterations, scoredResults.length * 100),
    })
    console.log(`\n=== Bootstrap CI (${report.numLineageGroups} groups, ${report.numSamples} samples) ===`)
    console.log(`  Total: ${formatCI(report.total)}`)
    for (const [cat, ci] of Object.entries(report.byCategory)) {
      console.log(`  ${cat}: ${formatCI(ci)}`)
    }

    const reportPath = join(outputDirAbs, "bootstrap_report.json")
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8")
    console.log(`\nBootstrap report saved: ${reportPath}`)
  }

  // Summary
  console.log("\n=== Summary ===")
  for (const r of allResults) {
    const status = r.schemaValid
      ? r.evidenceValid
        ? "OK"
        : "EVIDENCE_ISSUES"
      : "SCHEMA_FAIL"
    const score = r.score ? `${r.score.total.toFixed(1)}/${r.score.maxTotal}` : "N/A"
    console.log(`  ${r.sampleId.padEnd(30)} ${status.padEnd(16)} score=${score}`)
  }

  process.exit(0)
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
