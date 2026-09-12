// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * P0-1: Cross-card state dependency graph.
 *
 * Detects counter/accumulator-based dependencies between cards:
 *   Card A increment counter X → Card B reads counter X at threshold
 *
 * Complements the existing trigger chain (event→listener) detection
 * with state-variable (writer→reader) detection.
 */

import type { DeckCardInfo, DeckCharacterFullInfo } from "../heuristics"

export interface StateDependencyEdge {
  /** Card that writes the state variable */
  from: string
  /** Card that reads the state variable */
  to: string
  /** The state variable name (e.g. "disposedSupportCount", "experience") */
  variable: string
  /** How the writer modifies the variable: "increment" | "set" */
  writeType: string
  /** How the reader uses the variable: "threshold_check" | "read" */
  readType: string
  /** Description of the dependency */
  description: string
}

interface CardStateEffect {
  cardName: string
  writes: Array<{ variable: string; type: string; description: string }>
  reads: Array<{ variable: string; type: string; threshold?: number; description: string }>
}

/**
 * Parse card and character descriptions to extract state variable
 * read/write patterns. Uses regex on description text since we
 * operate within the heuristic (non-AST) pipeline.
 */
function extractStateVariables(
  cards: DeckCardInfo[],
  characters: DeckCharacterFullInfo[],
): CardStateEffect[] {
  const results: CardStateEffect[] = []

  // State variable patterns from card descriptions
  const accumulatePatterns: Array<{
    regex: RegExp
    variable: string
    description: string
  }> = [
    {
      regex: /(?:记录|累积|称为).{0,6}「([^」]+)」/g,
      variable: "$1",
      description: "累积计数器",
    },
    {
      regex: /(?:累积)一个.{0,4}「([^」]+)」/g,
      variable: "$1",
      description: "累积标记",
    },
    {
      regex: /(?:已累积|累积到|已收集).{0,4}(\d+).{0,2}个/g,
      variable: "累积层数",
      description: "层数追踪",
    },
    {
      regex: /此牌累积(\d+)个「([^」]+)」/g,
      variable: "$2",
      description: "具体标记累积",
    },
    {
      regex: /(?:记录|称为)「([^」]+)」。?（最多(\d+)点）/g,
      variable: "$1",
      description: "带上限的计数器",
    },
  ]

  const thresholdReadPatterns: Array<{
    regex: RegExp
    description: string
  }> = [
    {
      regex: /如果.{0,10}至少为?(\d+)/g,
      description: "阈值检查(≥N)",
    },
    {
      regex: /如果.{0,10}至少(\d+)点/g,
      description: "点数阈值检查",
    },
    {
      regex: /如果.{0,10}(\d+)点.{0,6}则/g,
      description: "条件阈值触发",
    },
  ]

  // Generic discard/dispose tracking
  const disposeTrackPattern =
    /(?:支援区弃置卡牌|弃置.{0,4}支援.{0,4}牌|被弃置|被舍弃)/g

  for (const card of cards) {
    const fullText = [card.description, card.playingDescription ?? ""]
      .filter(Boolean)
      .join("\n")
    if (!fullText) continue

    const writes: CardStateEffect["writes"] = []
    const reads: CardStateEffect["reads"] = []

    // Detect accumulation patterns
    for (const { regex, variable: varTemplate, description } of accumulatePatterns) {
      // Reset regex lastIndex
      regex.lastIndex = 0
      for (const match of fullText.matchAll(regex)) {
        const varName = varTemplate === "$1" ? match[1] ?? match[2] ?? "累计值"
          : varTemplate === "$2" ? match[2] ?? "标记"
          : varTemplate
        writes.push({
          variable: varName.replace(/[「」]/g, ""),
          type: "increment",
          description,
        })
      }
    }

    // Detect dispose tracking (implicit counter)
    if (disposeTrackPattern.test(fullText)) {
      writes.push({
        variable: "支援弃置计数",
        type: "increment",
        description: "记录支援区弃置次数",
      })
    }

    // Detect threshold reads
    for (const { regex, description } of thresholdReadPatterns) {
      regex.lastIndex = 0
      for (const match of fullText.matchAll(regex)) {
        reads.push({
          variable: "累积值",
          type: "threshold_check",
          threshold: parseInt(match[1], 10),
          description: `${description}(${match[1]})`,
        })
      }
    }

    // Detect variable reads from accumulate descriptions
    for (const { regex } of accumulatePatterns) {
      regex.lastIndex = 0
      // Check if this card READS rather than writes
      const hasWrite = writes.some((w) =>
        fullText.includes(w.variable),
      )
      // If the card mentions accumulation AND has a trigger condition,
      // it likely reads the accumulated value
      if (hasWrite) {
        // Cards that both write AND read their own counter
        for (const w of writes) {
          if (
            fullText.includes(`至少为`) ||
            fullText.includes(`至少`) ||
            fullText.includes(`达到`) ||
            fullText.includes(`后：如果`)
          ) {
            reads.push({
              variable: w.variable,
              type: "threshold_check",
              description: "检查自身累积值",
            })
          }
        }
      }
    }

    if (writes.length > 0 || reads.length > 0) {
      results.push({
        cardName: card.name,
        writes,
        reads,
      })
    }
  }

  return results
}

/**
 * Build state dependency edges from extracted variable read/write data.
 * Creates edges between cards that share state variables.
 */
export function detectStateDependencies(
  cards: DeckCardInfo[],
  characters: DeckCharacterFullInfo[],
): StateDependencyEdge[] {
  const effects = extractStateVariables(cards, characters)
  const edges: StateDependencyEdge[] = []

  // Group by variable name (fuzzy match)
  const variableGroups = new Map<string, CardStateEffect[]>()

  // Common variable name synonyms
  const synonymGroups: Record<string, string[]> = {
    "阅历": ["阅历", "支援弃置计数", "弃置次数"],
    "灵感": ["灵感"],
    "寻宝线索": ["寻宝线索"],
    "累计值": ["累计值", "累积层数", "累计层数"],
  }

  const normalizeVar = (name: string): string => {
    for (const [canonical, synonyms] of Object.entries(synonymGroups)) {
      if (synonyms.some((s) => name.includes(s)) || canonical.includes(name)) {
        return canonical
      }
    }
    return name
  }

  for (const effect of effects) {
    const allVars = new Set<string>()
    for (const w of effect.writes) allVars.add(normalizeVar(w.variable))
    for (const r of effect.reads) {
      const key = r.variable.includes("累积值") && r.threshold
        ? `threshold_${r.threshold}`
        : normalizeVar(r.variable)
      allVars.add(key)
    }
    for (const v of allVars) {
      if (!variableGroups.has(v)) variableGroups.set(v, [])
      variableGroups.get(v)!.push(effect)
    }
  }

  // Build edges: writer → reader
  for (const [, group] of variableGroups) {
    const writers = group.filter((e) => e.writes.length > 0)
    const readers = group.filter((e) => e.reads.length > 0)

    for (const writer of writers) {
      for (const reader of readers) {
        // Skip self-references
        if (writer.cardName === reader.cardName) continue

        // Find matching write/read variables
        for (const w of writer.writes) {
          const wNorm = normalizeVar(w.variable)
          for (const r of reader.reads) {
            const rNorm = normalizeVar(r.variable)
            if (wNorm === rNorm || (wNorm.includes(rNorm) || rNorm.includes(wNorm))) {
              edges.push({
                from: writer.cardName,
                to: reader.cardName,
                variable: wNorm,
                writeType: w.type,
                readType: r.type,
                description: `${writer.cardName}${w.description} → ${reader.cardName}${r.description}`,
              })
            }
          }
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  return edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.variable}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
