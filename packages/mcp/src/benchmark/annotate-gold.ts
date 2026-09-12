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
 * Batch Gold Annotation Tool
 *
 * Subcommands:
 *   init <deck-list.json>   Create annotation workspace from a deck list
 *   validate                Validate all filled gold.json against schema + evidence
 *   status                  Show annotation progress
 *   export                  Collect all gold.json into a single dataset file
 *
 * Deck list format (JSON):
 * {
 *   "version": "v5.5.0",            // optional, defaults to current
 *   "decks": [                       // single-deck samples
 *     { "code": "A0BQ9...", "name": "水八" },
 *     ...
 *   ],
 *   "matchups": [                    // matchup samples (optional)
 *     { "deck0": "A0BQ9...", "deck1": "APBw4...", "deck0Name": "水八", "deck1Name": "雷鹤" },
 *     ...
 *   ]
 * }
 *
 * Usage:
 *   gnx packages/mcp/src/benchmark/annotate-gold.ts init deck-list.json
 *   gnx packages/mcp/src/benchmark/annotate-gold.ts init deck-list.json --variants 1
 *   gnx packages/mcp/src/benchmark/annotate-gold.ts validate
 *   gnx packages/mcp/src/benchmark/annotate-gold.ts status
 *   gnx packages/mcp/src/benchmark/annotate-gold.ts export gold-dataset.json
 */

/// <reference types="node" />

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { parseArgs } from "node:util"
import { createHash } from "node:crypto"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer"
import { generateVariants, makeLineageId, type DeckVariant } from "./variant-generator.js"
import { validateSchema, validateEvidence, buildValidIdSet } from "./evidence-validator.js"
import { ARCHETYPE_LABELS } from "./analysis-v2-schema.js"
import type { AnalysisV2 } from "./analysis-v2-schema.js"
import type { GoldAnalysis } from "./scorer.js"

// ─── Types ────────────────────────────────────────────────────────────────

interface DeckListEntry {
  code: string
  name?: string
}

interface MatchupEntry {
  deck0: string
  deck1: string
  deck0Name?: string
  deck1Name?: string
}

interface DeckList {
  version?: string
  decks?: DeckListEntry[]
  matchups?: MatchupEntry[]
}

interface SampleMeta {
  id: string
  type: "single" | "matchup"
  lineage: string
  deckCode: string
  oppDeckCode: string | null
  deckName: string
  oppDeckName: string | null
  version: string
  contextHash: string
  isVariant: boolean
  variantKind: string | null
  removedCardId: number | null
  removedCardName: string | null
  addedCardId: number | null
  addedCardName: string | null
  parentDeckCode: string | null
  createdAt: string
}

interface Manifest {
  version: string
  createdAt: string
  deckListPath: string
  samples: SampleMeta[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex").slice(0, 16)
}

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

/**
 * Generate a gold.json template with field documentation.
 * Annotators fill this in; empty values are null or empty arrays.
 */
function generateGoldTemplate(meta: SampleMeta): string {
  const isMatchup = meta.type === "matchup"
  const lines: string[] = [
    "{",
    `  "// 标注说明": "填写下方的 analysisV2。evidence 中的 ID 必须来自 my_deck_data.json（或 matchup 时的 opp_deck_data.json）。不确定的字段用 abstentions 声明。",`,
    `  "// 样本ID": "${meta.id}",`,
    `  "// 卡组名": "${meta.deckName}${meta.oppDeckName ? " vs " + meta.oppDeckName : ""}",`,
    `  "// 版本": "${meta.version}",`,
    `  "// 是变体": "${meta.isVariant ? meta.variantKind : "否"}",`,
  ]
  if (meta.isVariant && meta.removedCardName) {
    lines.push(`  "// 变体说明": "已移除 ${meta.removedCardName}，替换为 ${meta.addedCardName}",`)
  }
  lines.push(
    `  "// archetype 可选值": "${ARCHETYPE_LABELS.join(", ")}",`,
    `  "// primaryArchetypes 阈值": "权重 >= 0.35 的标签",`,
    `  "// winCondition.kind 可选值": "burst, board_lock, attrition, engine, other",`,
    `  "// keyPiece.role 可选值": "enabler, payoff, engine, tutor, protection, finisher",`,
    `  "// keyPiece.necessity 可选值": "required, replaceable, optional",`,
    `  "// line.kind 可选值": "combo, pressure, stabilize, value",`,
    `  "// threat.severity 可选值": "low, medium, high",`,
    `  "// targetPace 可选值": "race, stabilize, deny_setup, outvalue",`,
    "",
    `  "analysisV2": {`,
    `    "deckProfile": {`,
    `      "archetypeWeights": {},`,
    `      "primaryArchetypes": [],`,
    `      "pace": {`,
    `        "setupRounds": { "min": 0, "max": 0 },`,
    `        "pressurePeakRounds": [],`,
    `        "lateGameReliance": 0.0`,
    `      },`,
    `      "winConditions": [],`,
    `      "keyPieces": [],`,
    `      "lines": [],`,
    `      "resourcePlan": {`,
    `        "priority": [],`,
    `        "bottlenecks": []`,
    `      }`,
    `    },`,
    `    "matchup": {`,
  )
  if (isMatchup) {
    lines.push(
      `      "opponentThreats": [],`,
      `      "relativePlan": {`,
      `        "advantageAxes": [],`,
      `        "targetPace": "race",`,
      `        "confidence": 0.0`,
      `      }`,
    )
  } else {
    lines.push(
      `      "// 说明": "无对手卡组，应将此字段加入 abstentions",`,
      `      "opponentThreats": [],`,
      `      "relativePlan": {`,
      `        "advantageAxes": [],`,
      `        "targetPace": "race",`,
      `        "confidence": 0.0`,
      `      }`,
    )
  }
  lines.push(
    `    },`,
    `    "abstentions": []`,
    `  }`,
    `}`,
  )
  return lines.join("\n")
}

/**
 * Strip JSON comments (lines starting with //) and parse.
 */
function parseJsonWithComments(text: string): unknown {
  const cleaned = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      // Keep lines that are just "// ..." comments inside JSON
      // But we need to be careful: don't remove // inside strings
      // Simple heuristic: only remove lines where the first non-space chars are "//"
      return !trimmed.startsWith('"//')
    })
    .join("\n")
  return JSON.parse(cleaned)
}

// ─── init subcommand ──────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    options: {
      "workspace": { type: "string", default: ".opencode/tmp/gold-workspace" },
      "variants": { type: "string", default: "0" },
    },
    args: args,
    strict: false,
  })

  const deckListPath = args[0]
  if (!deckListPath) {
    console.error("Usage: init <deck-list.json> [--workspace <dir>] [--variants 1]")
    process.exit(1)
  }

  const workspaceDir = resolve(process.cwd(), values["workspace"] as string)
  const variantsEnabled = values["variants"] === "1" || values["variants"] === "true"
  const deckListAbs = resolve(process.cwd(), deckListPath)

  if (!existsSync(deckListAbs)) {
    console.error(`Deck list not found: ${deckListAbs}`)
    process.exit(1)
  }

  const deckList = JSON.parse(readFileSync(deckListAbs, "utf8")) as DeckList
  const version = deckList.version ?? ""
  const versionLabel = version || "current"

  console.log("=== Gold Annotation Workspace Init ===")
  console.log(`  Deck list:   ${deckListAbs}`)
  console.log(`  Version:     ${versionLabel}`)
  console.log(`  Variants:    ${variantsEnabled ? "enabled" : "disabled"}`)
  console.log(`  Workspace:   ${workspaceDir}`)
  console.log("")

  const samplesDir = join(workspaceDir, "samples")
  mkdirSync(samplesDir, { recursive: true })

  const allSamples: SampleMeta[] = []
  let sampleIdx = 0

  // Process single-deck samples
  for (const deck of deckList.decks ?? []) {
    const deckName = deck.name ?? `deck_${sampleIdx}`
    const lineage = makeLineageId(deck.code, deckName)
    const sampleId = `${deckName}-base`
    console.log(`[${++sampleIdx}] Processing: ${sampleId}`)

    // Build deck data
    const deckData = await buildDeckDataJson(deck.code, version || undefined)
    const contextHash = hashContent(deckData)

    // Create sample directory
    const sampleDir = join(samplesDir, sampleId)
    mkdirSync(sampleDir, { recursive: true })

    writeFileSync(join(sampleDir, "my_deck_data.json"), deckData, "utf8")
    writeFileSync(join(sampleDir, "gold.json"), generateGoldTemplate({
      id: sampleId,
      type: "single",
      lineage,
      deckCode: deck.code,
      oppDeckCode: null,
      deckName,
      oppDeckName: null,
      version,
      contextHash,
      isVariant: false,
      variantKind: null,
      removedCardId: null,
      removedCardName: null,
      addedCardId: null,
      addedCardName: null,
      parentDeckCode: null,
      createdAt: new Date().toISOString(),
    }), "utf8")

    allSamples.push({
      id: sampleId,
      type: "single",
      lineage,
      deckCode: deck.code,
      oppDeckCode: null,
      deckName,
      oppDeckName: null,
      version,
      contextHash,
      isVariant: false,
      variantKind: null,
      removedCardId: null,
      removedCardName: null,
      addedCardId: null,
      addedCardName: null,
      parentDeckCode: null,
      createdAt: new Date().toISOString(),
    })

    // Generate variants
    if (variantsEnabled) {
      console.log(`  Generating variants for ${deckName}...`)
      const manager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
      const variantResult = await generateVariants(deck.code, lineage, manager)

      for (const v of variantResult.variants) {
        const vSampleId = `${deckName}-${v.kind}`
        const vDeckData = await buildDeckDataJson(v.deckCode, version || undefined)
        const vContextHash = hashContent(vDeckData)
        const vSampleDir = join(samplesDir, vSampleId)
        mkdirSync(vSampleDir, { recursive: true })

        const vMeta: SampleMeta = {
          id: vSampleId,
          type: "single",
          lineage,
          deckCode: v.deckCode,
          oppDeckCode: null,
          deckName: `${deckName} (${v.kind})`,
          oppDeckName: null,
          version,
          contextHash: vContextHash,
          isVariant: true,
          variantKind: v.kind,
          removedCardId: v.removedCardId,
          removedCardName: v.removedCardName,
          addedCardId: v.addedCardId,
          addedCardName: v.addedCardName,
          parentDeckCode: v.parentDeckCode,
          createdAt: new Date().toISOString(),
        }

        writeFileSync(join(vSampleDir, "my_deck_data.json"), vDeckData, "utf8")
        writeFileSync(join(vSampleDir, "gold.json"), generateGoldTemplate(vMeta), "utf8")

        allSamples.push(vMeta)
        console.log(`    -> ${vSampleId}: ${v.description}`)
      }
    }
  }

  // Process matchup samples
  for (const mu of deckList.matchups ?? []) {
    const d0Name = mu.deck0Name ?? "deck0"
    const d1Name = mu.deck1Name ?? "deck1"
    const sampleId = `${d0Name}-vs-${d1Name}`
    console.log(`[${++sampleIdx}] Processing: ${sampleId} (matchup)`)

    const lineage = makeLineageId(mu.deck0 + mu.deck1, `${d0Name}_${d1Name}`)
    const deck0Data = await buildDeckDataJson(mu.deck0, version || undefined)
    const deck1Data = await buildDeckDataJson(mu.deck1, version || undefined)
    const contextHash = hashContent(deck0Data + deck1Data)

    const sampleDir = join(samplesDir, sampleId)
    mkdirSync(sampleDir, { recursive: true })

    const meta: SampleMeta = {
      id: sampleId,
      type: "matchup",
      lineage,
      deckCode: mu.deck0,
      oppDeckCode: mu.deck1,
      deckName: d0Name,
      oppDeckName: d1Name,
      version,
      contextHash,
      isVariant: false,
      variantKind: null,
      removedCardId: null,
      removedCardName: null,
      addedCardId: null,
      addedCardName: null,
      parentDeckCode: null,
      createdAt: new Date().toISOString(),
    }

    writeFileSync(join(sampleDir, "my_deck_data.json"), deck0Data, "utf8")
    writeFileSync(join(sampleDir, "opp_deck_data.json"), deck1Data, "utf8")
    writeFileSync(join(sampleDir, "gold.json"), generateGoldTemplate(meta), "utf8")

    allSamples.push(meta)
  }

  // Write manifest
  const manifest: Manifest = {
    version,
    createdAt: new Date().toISOString(),
    deckListPath: deckListAbs,
    samples: allSamples,
  }
  writeFileSync(
    join(workspaceDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  )

  console.log("")
  console.log(`Done! ${allSamples.length} samples created.`)
  console.log(`  Workspace: ${workspaceDir}`)
  console.log("")
  console.log("Next steps:")
  console.log(`  1. For each sample in samples/, read my_deck_data.json (+ opp_deck_data.json for matchup)`)
  console.log(`  2. Fill in gold.json following the field documentation`)
  console.log(`  3. Run: gnx packages/mcp/src/benchmark/annotate-gold.ts validate --workspace ${values["workspace"]}`)
  console.log(`  4. Export: gnx packages/mcp/src/benchmark/annotate-gold.ts export gold-dataset.json --workspace ${values["workspace"]}`)
}

// ─── validate subcommand ──────────────────────────────────────────────────

async function cmdValidate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    options: {
      "workspace": { type: "string", default: ".opencode/tmp/gold-workspace" },
    },
    args: args,
    strict: false,
  })

  const workspaceDir = resolve(process.cwd(), values["workspace"] as string)
  const manifestPath = join(workspaceDir, "manifest.json")

  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`)
    console.error("Run 'init' first.")
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  const samplesDir = join(workspaceDir, "samples")

  console.log("=== Gold Annotation Validation ===")
  console.log(`  Workspace: ${workspaceDir}`)
  console.log(`  Samples:   ${manifest.samples.length}`)
  console.log("")

  let validCount = 0
  let errorCount = 0
  let pendingCount = 0
  const errors: Array<{ sampleId: string; errors: string[] }> = []

  for (const meta of manifest.samples) {
    const sampleDir = join(samplesDir, meta.id)
    const goldPath = join(sampleDir, "gold.json")

    if (!existsSync(goldPath)) {
      pendingCount++
      console.log(`  [PENDING] ${meta.id} - gold.json not found`)
      continue
    }

    const goldRaw = readFileSync(goldPath, "utf8")

    // Check if gold is still the template (all empty)
    let goldParsed: unknown
    try {
      goldParsed = parseJsonWithComments(goldRaw)
    } catch (e) {
      errorCount++
      const errs = [`JSON parse error: ${(e as Error).message}`]
      errors.push({ sampleId: meta.id, errors: errs })
      console.log(`  [ERROR]   ${meta.id} - JSON parse failed`)
      continue
    }

    // Check if still empty (template)
    const goldObj = goldParsed as { analysisV2?: AnalysisV2 }
    const dp = goldObj?.analysisV2?.deckProfile
    if (
      dp &&
      Object.keys(dp.archetypeWeights ?? {}).length === 0 &&
      (dp.winConditions ?? []).length === 0 &&
      (dp.keyPieces ?? []).length === 0 &&
      (dp.lines ?? []).length === 0
    ) {
      pendingCount++
      console.log(`  [PENDING] ${meta.id} - template not yet filled`)
      continue
    }

    // Build the full wrapper for schema validation
    const wrapper = {
      analysisSchemaVersion: "2.0",
      inputIdentity: {
        myDeck: { code: meta.deckCode, version: meta.version || "current", contextHash: meta.contextHash },
        ...(meta.oppDeckCode ? {
          opponentDeck: { code: meta.oppDeckCode, version: meta.version || "current", contextHash: "" },
        } : {}),
      },
      analysisV2: goldObj.analysisV2,
    }

    // Validate schema
    const { result: schemaResult, parsed } = validateSchema(wrapper)
    if (!schemaResult.valid) {
      errorCount++
      const errs = [...schemaResult.errors, ...schemaResult.archetypeIssues]
      errors.push({ sampleId: meta.id, errors: errs })
      console.log(`  [ERROR]   ${meta.id} - schema: ${errs.length} errors`)
      for (const e of errs.slice(0, 3)) {
        console.log(`             ${e}`)
      }
      continue
    }

    // Validate evidence
    const myDeckData = JSON.parse(readFileSync(join(sampleDir, "my_deck_data.json"), "utf8"))
    const oppDeckData = meta.type === "matchup" && existsSync(join(sampleDir, "opp_deck_data.json"))
      ? JSON.parse(readFileSync(join(sampleDir, "opp_deck_data.json"), "utf8"))
      : undefined

    const idSet = buildValidIdSet(myDeckData, oppDeckData)
    const evResult = validateEvidence(parsed!, idSet)

    if (evResult.issues.length > 0) {
      errorCount++
      const errs = evResult.issues.map((i) => `${i.field}: ${i.message}`)
      errors.push({ sampleId: meta.id, errors: errs })
      console.log(`  [ERROR]   ${meta.id} - evidence: ${evResult.issues.length} issues`)
      for (const i of evResult.issues.slice(0, 3)) {
        console.log(`             ${i.field}: ${i.message}`)
      }
      continue
    }

    validCount++
    console.log(`  [OK]      ${meta.id}`)
  }

  console.log("")
  console.log("=== Summary ===")
  console.log(`  Valid:    ${validCount}`)
  console.log(`  Errors:   ${errorCount}`)
  console.log(`  Pending:  ${pendingCount}`)
  console.log(`  Total:    ${manifest.samples.length}`)

  if (errorCount > 0) {
    console.log("")
    console.log("Errors detail:")
    for (const { sampleId, errors: errs } of errors) {
      console.log(`  ${sampleId}:`)
      for (const e of errs) {
        console.log(`    - ${e}`)
      }
    }
    process.exit(1)
  }
}

// ─── status subcommand ────────────────────────────────────────────────────

async function cmdStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    options: {
      "workspace": { type: "string", default: ".opencode/tmp/gold-workspace" },
    },
    args: args,
    strict: false,
  })

  const workspaceDir = resolve(process.cwd(), values["workspace"] as string)
  const manifestPath = join(workspaceDir, "manifest.json")

  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`)
    console.error("Run 'init' first.")
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  const samplesDir = join(workspaceDir, "samples")

  console.log("=== Gold Annotation Status ===")
  console.log(`  Workspace: ${workspaceDir}`)
  console.log(`  Version:    ${manifest.version || "current"}`)
  console.log(`  Created:    ${manifest.createdAt}`)
  console.log(`  Deck list:  ${manifest.deckListPath}`)
  console.log("")

  // Group by lineage
  const byLineage = new Map<string, SampleMeta[]>()
  for (const s of manifest.samples) {
    const list = byLineage.get(s.lineage) ?? []
    list.push(s)
    byLineage.set(s.lineage, list)
  }

  console.log("By lineage:")
  let done = 0
  let pending = 0
  let total = 0

  for (const [lineage, samples] of byLineage) {
    console.log(`  ${lineage}:`)
    for (const s of samples) {
      const goldPath = join(samplesDir, s.id, "gold.json")
      let status = "PENDING"
      if (existsSync(goldPath)) {
        try {
          const goldRaw = readFileSync(goldPath, "utf8")
          const gold = parseJsonWithComments(goldRaw) as { analysisV2?: AnalysisV2 }
          const dp = gold?.analysisV2?.deckProfile
          if (
            dp &&
            (Object.keys(dp.archetypeWeights ?? {}).length > 0 ||
              (dp.winConditions ?? []).length > 0)
          ) {
            status = "DONE"
            done++
          } else {
            status = "TEMPLATE"
            pending++
          }
        } catch {
          status = "PARSE_ERR"
          pending++
        }
      } else {
        pending++
      }
      total++

      const variantTag = s.isVariant ? ` [variant: ${s.variantKind}]` : ""
      const typeTag = s.type === "matchup" ? " [matchup]" : ""
      console.log(`    ${status.padEnd(10)} ${s.id}${variantTag}${typeTag}`)
    }
  }

  console.log("")
  console.log(`Progress: ${done}/${total} done, ${pending} pending`)
  const pct = total > 0 ? ((done / total) * 100).toFixed(1) : "0"
  console.log(`  ${pct}% complete`)
}

// ─── export subcommand ────────────────────────────────────────────────────

async function cmdExport(args: string[]): Promise<void> {
  const { values } = parseArgs({
    options: {
      "workspace": { type: "string", default: ".opencode/tmp/gold-workspace" },
    },
    args: args,
    strict: false,
  })

  const outputPath = args[0]
  if (!outputPath) {
    console.error("Usage: export <output.json> [--workspace <dir>]")
    process.exit(1)
  }

  const workspaceDir = resolve(process.cwd(), values["workspace"] as string)
  const manifestPath = join(workspaceDir, "manifest.json")

  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`)
    console.error("Run 'init' first.")
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  const samplesDir = join(workspaceDir, "samples")
  const outputAbs = resolve(process.cwd(), outputPath)

  console.log("=== Gold Dataset Export ===")
  console.log(`  Workspace: ${workspaceDir}`)
  console.log(`  Output:    ${outputAbs}`)
  console.log("")

  const dataset: {
    schemaVersion: string
    exportedAt: string
    version: string
    samples: Array<{
      id: string
      type: string
      lineage: string
      deckCode: string
      oppDeckCode: string | null
      deckName: string
      oppDeckName: string | null
      version: string
      contextHash: string
      isVariant: boolean
      variantKind: string | null
      removedCardId: number | null
      removedCardName: string | null
      gold: GoldAnalysis | null
    }>
  } = {
    schemaVersion: "2.0",
    exportedAt: new Date().toISOString(),
    version: manifest.version,
    samples: [],
  }

  let exported = 0
  let skipped = 0

  for (const meta of manifest.samples) {
    const goldPath = join(samplesDir, meta.id, "gold.json")
    let gold: GoldAnalysis | null = null

    if (existsSync(goldPath)) {
      try {
        const goldRaw = readFileSync(goldPath, "utf8")
        const parsed = parseJsonWithComments(goldRaw) as { analysisV2?: { deckProfile: { archetypeWeights?: Record<string, number> } } }
        if (parsed.analysisV2) {
          // Check if it's actually filled
          const dp = parsed.analysisV2.deckProfile
          if (dp && Object.keys(dp.archetypeWeights ?? {}).length > 0) {
            gold = { analysisV2: parsed.analysisV2 as unknown as GoldAnalysis["analysisV2"] }
            exported++
          } else {
            skipped++
          }
        } else {
          skipped++
        }
      } catch {
        skipped++
      }
    } else {
      skipped++
    }

    dataset.samples.push({
      id: meta.id,
      type: meta.type,
      lineage: meta.lineage,
      deckCode: meta.deckCode,
      oppDeckCode: meta.oppDeckCode,
      deckName: meta.deckName,
      oppDeckName: meta.oppDeckName,
      version: meta.version,
      contextHash: meta.contextHash,
      isVariant: meta.isVariant,
      variantKind: meta.variantKind,
      removedCardId: meta.removedCardId,
      removedCardName: meta.removedCardName,
      gold,
    })
  }

  writeFileSync(outputAbs, JSON.stringify(dataset, null, 2) + "\n", "utf8")

  console.log(`Exported: ${exported} samples with gold`)
  console.log(`Skipped:  ${skipped} samples (pending/template/parse error)`)
  console.log(`Output:   ${outputAbs}`)
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error("Usage: annotate-gold.ts <subcommand> [args]")
    console.error("Subcommands:")
    console.error("  init <deck-list.json> [--workspace <dir>] [--variants 1]")
    console.error("  validate [--workspace <dir>]")
    console.error("  status [--workspace <dir>]")
    console.error("  export <output.json> [--workspace <dir>]")
    process.exit(1)
  }

  const subcommand = args[0]!
  const rest = args.slice(1)

  switch (subcommand) {
    case "init":
      await cmdInit(rest)
      break
    case "validate":
      await cmdValidate(rest)
      break
    case "status":
      await cmdStatus(rest)
      break
    case "export":
      await cmdExport(rest)
      break
    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      console.error("Available: init, validate, status, export")
      process.exit(1)
  }
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
