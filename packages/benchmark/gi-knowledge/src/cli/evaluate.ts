// Copyright (C) 2026 Piovium Labs
// 
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// 
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
// 
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * CLI: evaluate — read a benchmark questions file and send questions to an LLM,
 * then score the answers.
 *
 * Single-run mode:     gnx src/cli/evaluate.ts [--questions <path>] [--max <num>]
 * Batch config mode:   gnx src/cli/evaluate.ts --config eval-config.json
 *
 * Environment variables (single-run):
 *   LLM_API_URL    - LLM inference endpoint
 *   LLM_MODEL      - Model name
 *   LLM_API_KEY    - API key if needed
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { BenchmarkQuestion, BenchmarkSet, EvaluationResult } from "../types"
import { scoreAnswer, formatReport } from "../score"

const DEFAULT_API_URL = "http://localhost:11434/api/generate"
const DEFAULT_MODEL = "qwen2.5:7b"

interface LLMOptions {
  apiUrl: string
  model: string
  apiKey?: string
}

interface QAResponse {
  model: string
  response: string
  done: boolean
}

async function queryLLMByChat(
  prompt: string,
  opts: LLMOptions,
): Promise<string> {
  const body = JSON.stringify({
    model: opts.model,
    messages: [
      {
        role: "system",
        content:
          "你是一位七圣召唤（Genius Invokation TCG）专家。请回答以下关于七圣召唤卡牌的问题。只给出答案本身，不要多余解释。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 200000,
  })

  const url = opts.apiUrl.endsWith("/generate")
    ? opts.apiUrl.replace("/generate", "/chat/completions")
    : opts.apiUrl

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body,
  })

  if (!response.ok) {
    let short = `API ${response.status}`
    try {
      const errBody = (await response.json()) as Record<string, unknown>
      const msg = (errBody.error as Record<string, unknown> | undefined)?.message
      if (msg) short += `: ${String(msg).slice(0, 100)}`
    } catch {}
    throw new Error(short)
  }

  const data = (await response.json()) as Record<string, unknown>

  // Try standard OpenAI format
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  if (choices?.[0]) {
    const msg = choices[0].message as Record<string, unknown> | undefined
    if (msg?.content !== undefined) {
      const text = String(msg.content).trim()
      if (!text) {
        const reason = choices[0].finish_reason ?? "unknown"
        throw new Error(`empty response (finish_reason: ${reason})`)
      }
      return text
    }
    if (choices[0].text) return (choices[0].text as string).trim()
  }

  // Try Ollama-style { response: "..." }
  if (typeof data.response === "string" && data.response.trim()) {
    return data.response.trim()
  }

  const keys = Object.keys(data).join(", ")
  throw new Error(`Unknown API response format (keys: ${keys}): ${JSON.stringify(data).slice(0, 200)}`)
}

// ── batch config types ───────────────────────────────────

interface EvalRun {
  name: string
  api: string
  key?: string
  model: string
  tag?: string
  max?: number
}

interface EvalConfig {
  questions?: string
  max?: number
  runs: EvalRun[]
}

// ── batch mode ───────────────────────────────────────────

async function batchMode(configPath: string) {
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as EvalConfig
  const questionsPath = config.questions ?? path.resolve(import.meta.dirname, "../../data/benchmark-questions.json")
  const defaultMax = config.max ?? 100

  const bench = JSON.parse(readFileSync(questionsPath, "utf-8")) as BenchmarkSet
  const questions = bench.questions.slice(0, defaultMax)

  for (const run of config.runs) {
    console.log(`\n===== ${run.name} (${run.model}) =====`)

    const apiUrl = run.api
    const model = run.model
    const apiKey = run.key ?? process.env["LLM_API_KEY"]
    const maxQ = run.max ?? defaultMax
    const tag = run.tag ?? run.name.replace(/[^a-zA-Z0-9_-]/g, "-")

    if (apiKey && /[^\x20-\x7E]/.test(apiKey)) {
      console.error(`❌  ${run.name}: API key contains non-ASCII characters`)
      continue
    }

    const slice = questions.slice(0, maxQ)
    const results: EvaluationResult[] = []

    for (let i = 0; i < slice.length; i++) {
      const q = slice[i]!
      const prefix = `[${i + 1}/${slice.length}] [${q.category}]`
      process.stdout.write(`${prefix} ${q.question.slice(0, 50)}... `)

      try {
        const answer = await queryLLMByChat(q.question, { apiUrl, model, apiKey })
        const result = scoreAnswer(q, answer)
        const icon = result.passed ? "✅" : "❌"
        const text = answer || "(empty)"
        process.stdout.write(`${icon} ${text.replace(/\n/g, "↵").slice(0, 80)}\n`)
        results.push(result)
      } catch (err) {
        const msg = String(err).slice(0, 120)
        process.stdout.write(`💥 "${msg}"\n`)
        results.push({
          questionId: q.id, category: q.category, question: q.question,
          groundTruth: q.groundTruth, llmAnswer: `[ERROR: ${err}]`,
          passed: false, score: 0, details: `API error: ${err}`,
        })
      }
    }

    const report = formatReport(results, slice as unknown as BenchmarkQuestion[])
    console.log(report)

    const outPath = path.resolve(path.dirname(configPath), `data/benchmark-${tag}-results.json`)
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ ...bench, results, runName: run.name }, null, 2), "utf-8")
    console.log(`📝  Results saved to ${outPath}`)
  }

  console.log("\n===== 全部完成 =====")
}

// ── single-run mode ──────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      opts[key] = args[i + 1] ?? "true"
      if (opts[key] !== "true") i++
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs()

  // Batch mode
  if (opts.config) {
    await batchMode(opts.config)
    return
  }

  // Single-run mode
  const questionsPath =
    opts.questions ?? path.resolve(import.meta.dirname, "../../data/benchmark-questions.json")
  const tag = opts.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const outPath = opts.out ?? questionsPath.replace(".json", `-${tag}-results.json`)
  const maxQuestions = opts.max ? Number(opts.max) : 20

  const apiUrl = process.env["LLM_API_URL"] ?? DEFAULT_API_URL
  const model = process.env["LLM_MODEL"] ?? DEFAULT_MODEL
  const apiKey = process.env["LLM_API_KEY"]

  if (apiKey && /[^\x20-\x7E]/.test(apiKey)) {
    console.error("❌ LLM_API_KEY contains non-ASCII characters. Check your placeholder.")
    process.exit(1)
  }

  console.log(`📋  Loading questions from ${questionsPath}...`)
  const bench = JSON.parse(readFileSync(questionsPath, "utf-8")) as BenchmarkSet

  const questions = bench.questions.slice(0, maxQuestions)
  console.log(`   Selected ${questions.length} questions (out of ${bench.meta.totalQuestions})`)
  console.log(`🤖  LLM: ${model} @ ${apiUrl}\n`)

  const results: EvaluationResult[] = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const prefix = `[${i + 1}/${questions.length}] [${q.category}]`
    process.stdout.write(`${prefix} Q: ${q.question.slice(0, 60)}... `)

    try {
      const answer = await queryLLMByChat(q.question, { apiUrl, model, apiKey })
      const result = scoreAnswer(q, answer)
      const icon = result.passed ? "✅" : "❌"
      const text = answer || "(empty)"
      const display = text.replace(/\n/g, "↵")
      process.stdout.write(`${icon} ${display}\n`)
      results.push(result)
    } catch (err) {
      const msg = String(err).slice(0, 120)
      process.stdout.write(`💥 "${msg}"\n`)
      results.push({
        questionId: q.id,
        category: q.category,
        question: q.question,
        groundTruth: q.groundTruth,
        llmAnswer: `[ERROR: ${err}]`,
        passed: false,
        score: 0,
        details: `API error: ${err}`,
      })
    }
  }

  // Report & save
  const report = formatReport(results, questions as unknown as BenchmarkQuestion[])
  console.log("\n" + report)

  writeFileSync(outPath, JSON.stringify({ ...bench, results }, null, 2), "utf-8")
  console.log(`\n📝  Results saved to ${outPath}`)
}

main().catch((err) => {
  console.error("❌", err)
  process.exit(1)
})
