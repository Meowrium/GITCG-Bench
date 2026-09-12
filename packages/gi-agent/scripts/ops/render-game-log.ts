// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D8b — render human-readable game logs from a self-play DataLake.
 *
 * Reads a sqlite captured by `run-ismcts-self-play.ts` (rows ORDER BY id) and
 * groups samples by `game_id`. For each game it reconstructs the decision
 * trace: per ply, who acted, which case (useSkill / playCard / switchActive /
 * elementalTuning / declareEnd), the primary definition id resolved to its
 * human name via `@gi-tcg/data`, the chosen target, the resulting HP delta
 * inferred from the next sample's character snapshot, and the search policy's
 * top-3 visit-share with that pick highlighted.
 *
 * Output: one Markdown file per game under `<out-dir>/{game_id}.md`, plus an
 * `index.md` with aggregate stats. Use `--limit N` to render only the first N
 * games (any order matches what was inserted into sqlite).
 *
 * Usage:
 *   gnx packages/gi-agent/scripts/ops/render-game-log.ts <db.sqlite> <out-dir> [--limit N] [--game <id>]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { CURRENT_VERSION, type GameData } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import Database from "better-sqlite3"

const ELEMENT_NAMES: Record<number, string> = {
  0: "—",
  1: "Cryo",
  2: "Hydro",
  3: "Pyro",
  4: "Electro",
  5: "Anemo",  // PbDiceType.Anemo = 5
  6: "Geo",
  7: "Dendro",
  8: "Omni",
}

interface NameLookup {
  /** characterDef → human name (best-effort) */
  charName: (defId: number) => string
  /** skillDef → "{character} · {skill}" */
  skillName: (defId: number) => string
  /** card / status / summon def → name */
  entityName: (defId: number) => string
}

function buildNameLookup(data: GameData): NameLookup {
  // Character names. The `@gi-tcg/data` registry doesn't expose user-facing
  // strings (those are in assets-manager), but the definition's `.id` and
  // `.tags` give us enough: format as `def(elem)`.
  const elemFromTags = (tags: readonly string[] = []): string => {
    for (const e of ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"]) {
      if (tags.includes(e)) return e[0].toUpperCase() + e.slice(1)
    }
    return "—"
  }

  const charName = (defId: number): string => {
    if (defId <= 0) return "?"
    const c = data.characters.get(defId)
    if (!c) return `char#${defId}`
    return `${defId}(${elemFromTags(c.tags as readonly string[])})`
  }

  // Skills live on the character. Skill defId is character defId * 10 + slot,
  // so 11042 = character 1104 · skill index 2 (per @gi-tcg encoding).
  const skillName = (defId: number): string => {
    if (defId <= 0) return "?"
    const cid = Math.floor(defId / 10)
    const slot = defId % 10
    const c = data.characters.get(cid)
    if (!c) return `skill#${defId}`
    const label = ["normal", "skill", "burst", "passive"][slot] ?? `slot${slot}`
    return `${charName(cid)}.${label}`
  }

  // Cards / entities / attachments — try each registry.
  const entityName = (defId: number): string => {
    if (defId <= 0) return "—"
    if (data.entities.has(defId)) return `entity#${defId}`
    if (data.attachments.has(defId)) return `equip#${defId}`
    return `def#${defId}`
  }

  return { charName, skillName, entityName }
}

function diceTypeName(n: number | null | undefined): string {
  if (n == null) return ""
  return ELEMENT_NAMES[n] ?? `dice${n}`
}

interface CharacterSnapshot {
  definition_id: number
  health: number
  energy: number
  max_energy: number
  aura: number
  is_active: boolean
  defeated: boolean
}

interface SampleRow {
  id: number
  gameId: string
  round: number
  turn: number
  player: 0 | 1
  actionCase: string
  observation: {
    meta: { game_id: string; perspective: 0 | 1; sample_index: number; round: number; turn: number }
    self: { side: 0 | 1; characters: CharacterSnapshot[]; is_first_player?: boolean }
    opponent: { side: 0 | 1; characters: CharacterSnapshot[]; is_first_player?: boolean }
    candidate_actions: Array<{
      candidate_id: string
      action_case: string
      primary_definition_id: number
      cost_total_dice: number
      cost_energy: number
      target_ids: number[]
      tuning_target?: number | null
      consumes_legend?: boolean
      changes_active?: boolean
    }>
    selected_action_index: number | null
    policy_target?: number[] | null
  }
  label: number
}

function loadAllSamples(dbPath: string): SampleRow[] {
  const db = new Database(dbPath, { readonly: true })
  const rows = db
    .prepare(
      "SELECT id, game_id, round, turn, player, action_case, state_observation, label FROM samples WHERE state_observation IS NOT NULL ORDER BY id",
    )
    .all() as Array<{
      id: number
      game_id: string
      round: number
      turn: number
      player: number
      action_case: string
      state_observation: string
      label: number
    }>
  db.close()
  return rows.map((r) => ({
    id: r.id,
    gameId: r.game_id,
    round: r.round,
    turn: r.turn,
    player: (r.player === 1 ? 1 : 0) as 0 | 1,
    actionCase: r.action_case,
    observation: JSON.parse(r.state_observation) as SampleRow["observation"],
    label: r.label,
  }))
}

function groupByGame(rows: SampleRow[]): Map<string, SampleRow[]> {
  const m = new Map<string, SampleRow[]>()
  for (const r of rows) {
    const arr = m.get(r.gameId)
    if (arr) arr.push(r)
    else m.set(r.gameId, [r])
  }
  return m
}

/** Decision-card target token. Resolves character entity_id → "p?ch#defId@HP". */
function describeTargetIds(
  ids: number[],
  selfChars: CharacterSnapshot[],
  oppChars: CharacterSnapshot[],
  selfSide: 0 | 1,
): string {
  if (!ids || ids.length === 0) return ""
  const oppSide = (1 - selfSide) as 0 | 1
  const all: Array<{ id: number; def: number; hp: number; side: 0 | 1 }> = []
  // entity_id is engine-side and not exposed in the snapshot's `entity_id`.
  // What we have: characters[].definition_id. The action target_ids field is
  // an engine character id, not def_id; we render the raw value if unmapped.
  return `→[${ids.map((x) => (x < 0 ? `idx${-x - 500000}` : `eid${x}`)).join(",")}]`
}

function pickName(c: SampleRow["observation"]["candidate_actions"][number], names: NameLookup): string {
  const primary = c.primary_definition_id
  switch (c.action_case) {
    case "useSkill":
      return names.skillName(primary)
    case "playCard":
      return `play ${names.entityName(primary)}`
    case "switchActive":
      return `switch→${names.charName(primary)}`
    case "elementalTuning":
      return `tune→${diceTypeName(c.tuning_target ?? 0)}`
    case "declareEnd":
      return "declareEnd"
    default:
      return c.action_case
  }
}

interface GamePlySummary {
  ply: number
  round: number
  turn: number
  player: 0 | 1
  action: string
  costDice: number
  costEnergy: number
  consumesLegend: boolean
  changesActive: boolean
  /** "delta HP/aura/energy on each side, after this ply" — inferred from next sample. */
  effectSummary: string
  /** "top-3 visits: a=p1, b=p2, c=p3 (chose b)" */
  policyTop: string
}

interface GameSummary {
  gameId: string
  shortId: string
  rounds: number
  totalPlies: number
  winner: 0 | 1 | "draw"
  firstPlayer: 0 | 1 | null
  selfDecks: { p0: number[]; p1: number[] }
  plies: GamePlySummary[]
}

function shortId(g: string): string {
  const parts = g.split("-")
  const out: string[] = []
  for (const p of parts) {
    if (p.length === 8 && /^[0-9a-f]+$/.test(p)) break
    out.push(p)
  }
  return out.join("-")
}

function snapshotHpVec(chars: CharacterSnapshot[]): number[] {
  return chars.map((c) => (c.defeated ? 0 : c.health))
}

function snapshotEnergyVec(chars: CharacterSnapshot[]): number[] {
  return chars.map((c) => c.energy)
}

function diffHp(a: number[], b: number[]): string {
  if (a.length !== b.length) return ""
  const parts: string[] = []
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i]
    if (d !== 0) parts.push(`ch${i}:${d > 0 ? "+" : ""}${d}`)
  }
  return parts.length === 0 ? "—" : parts.join(",")
}

function inferEffectSummary(curr: SampleRow, next: SampleRow | null): string {
  if (!next) return "(end of trajectory)"
  // The next decision happens in some perspective — we want HP deltas on BOTH
  // sides relative to `curr`. The `next` observation always carries both sides.
  // Match self/opp by perspective in `next`: if next.perspective === curr.perspective,
  // they're literally same self/opp; else swap.
  const sameSide = next.observation.meta.perspective === curr.observation.meta.perspective
  const nextSelf = sameSide ? next.observation.self : next.observation.opponent
  const nextOpp = sameSide ? next.observation.opponent : next.observation.self
  const selfBefore = snapshotHpVec(curr.observation.self.characters)
  const selfAfter = snapshotHpVec(nextSelf.characters)
  const oppBefore = snapshotHpVec(curr.observation.opponent.characters)
  const oppAfter = snapshotHpVec(nextOpp.characters)
  const selfD = diffHp(selfBefore, selfAfter)
  const oppD = diffHp(oppBefore, oppAfter)
  if (selfD === "—" && oppD === "—") return "no-hp-change"
  return `self:${selfD} | opp:${oppD}`
}

function policyTopShare(
  pt: number[] | null | undefined,
  cands: SampleRow["observation"]["candidate_actions"],
  chosen: number | null,
  names: NameLookup,
): string {
  if (!pt || pt.length === 0) return "—"
  const total = pt.reduce((a, b) => a + b, 0) || 1
  const ranked = pt
    .map((p, i) => ({ p: p / total, i }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
  return ranked
    .map(({ p, i }) => {
      const tag = i === chosen ? "★" : ""
      const c = cands[i]
      const desc = c ? pickName(c, names) : `idx${i}`
      return `${tag}${desc}=${(p * 100).toFixed(0)}%`
    })
    .join(", ")
}

function renderGame(rows: SampleRow[], names: NameLookup): GameSummary {
  // Sample insertion order in the DataLake: D8/D8b collectors write **all p0
  // samples first, then all p1 samples** (see run-ismcts-self-play.ts:351).
  // That means raw ROWID order is NOT the true play order — each side's slice
  // is monotonic but they're concatenated, not interleaved. To recover a
  // playable trace we re-sort by `(round, sample_index_within_side)` and
  // interleave: within the same round, list p0's plies in order followed by
  // p1's plies in order. This is still an approximation of the engine's true
  // turn-by-turn interleaving (Genius Invokation alternates per declareEnd /
  // fast / initiative inside a round) but it preserves causality at the round
  // boundary, which is what matters for reviewing the trajectory.
  const bySide: Record<0 | 1, SampleRow[]> = { 0: [], 1: [] }
  for (const r of rows) bySide[r.observation.meta.perspective].push(r)
  for (const s of [0, 1] as const) {
    bySide[s].sort((a, b) => {
      if (a.round !== b.round) return a.round - b.round
      return (a.observation.meta.sample_index ?? 0) - (b.observation.meta.sample_index ?? 0)
    })
  }
  // Interleave per round (p0 first per round; this matches v3 schema's
  // is_first_player when p0 won the coin flip, otherwise reversed — we leave
  // the swap as a visualization detail and surface first-mover at the header).
  const maxRound = Math.max(
    bySide[0].at(-1)?.round ?? 0,
    bySide[1].at(-1)?.round ?? 0,
  )
  // Determine first-mover before we build the interleave order, to put the
  // coin-flip winner's plies first in each round.
  let firstPlayerProbe: 0 | 1 | null = null
  for (const r of rows) {
    if (r.observation.self.is_first_player) {
      firstPlayerProbe = r.observation.meta.perspective
      break
    }
  }
  const firstSide: 0 | 1 = firstPlayerProbe ?? 0
  const secondSide: 0 | 1 = (1 - firstSide) as 0 | 1
  const sorted: SampleRow[] = []
  const heads: Record<0 | 1, number> = { 0: 0, 1: 0 }
  for (let r = 1; r <= maxRound; r++) {
    while (heads[firstSide] < bySide[firstSide].length && bySide[firstSide][heads[firstSide]].round === r) {
      sorted.push(bySide[firstSide][heads[firstSide]++])
    }
    while (heads[secondSide] < bySide[secondSide].length && bySide[secondSide][heads[secondSide]].round === r) {
      sorted.push(bySide[secondSide][heads[secondSide]++])
    }
  }
  // Any leftover (round-0 mulligan etc.) appended at the end.
  for (const s of [0, 1] as const) {
    while (heads[s] < bySide[s].length) sorted.push(bySide[s][heads[s]++])
  }

  if (sorted.length === 0) {
    return {
      gameId: "?",
      shortId: "?",
      rounds: 0,
      totalPlies: 0,
      winner: "draw",
      firstPlayer: null,
      selfDecks: { p0: [], p1: [] },
      plies: [],
    }
  }
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const winner: 0 | 1 | "draw" = last.label === 1
    ? last.player as 0 | 1
    : last.label === 0
      ? ((1 - last.player) as 0 | 1)
      : "draw"

  const firstPlayer: 0 | 1 | null = firstPlayerProbe ?? first.player

  // Decks: from the earliest observation each side appeared.
  const seen: Record<0 | 1, number[] | null> = { 0: null, 1: null }
  for (const r of sorted) {
    const side = r.observation.meta.perspective
    if (seen[side] === null) {
      seen[side] = r.observation.self.characters.map((c) => c.definition_id).filter((x) => x > 0)
    }
    const otherSide = (1 - side) as 0 | 1
    if (seen[otherSide] === null) {
      seen[otherSide] = r.observation.opponent.characters.map((c) => c.definition_id).filter((x) => x > 0)
    }
    if (seen[0] !== null && seen[1] !== null) break
  }

  const plies: GamePlySummary[] = []
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    const next = sorted[i + 1] ?? null
    const sel = r.observation.selected_action_index
    const ca = sel != null && sel >= 0 && sel < r.observation.candidate_actions.length
      ? r.observation.candidate_actions[sel]
      : null
    const action = ca ? pickName(ca, names) : r.actionCase
    const targets = ca ? describeTargetIds(ca.target_ids, r.observation.self.characters, r.observation.opponent.characters, r.observation.meta.perspective) : ""
    plies.push({
      ply: i,
      round: r.round,
      turn: r.turn,
      player: r.player,
      action: action + targets,
      costDice: ca?.cost_total_dice ?? 0,
      costEnergy: ca?.cost_energy ?? 0,
      consumesLegend: !!ca?.consumes_legend,
      changesActive: !!ca?.changes_active,
      effectSummary: inferEffectSummary(r, next),
      policyTop: policyTopShare(r.observation.policy_target, r.observation.candidate_actions, sel, names),
    })
  }

  return {
    gameId: first.gameId,
    shortId: shortId(first.gameId),
    rounds: last.round,
    totalPlies: sorted.length,
    winner,
    firstPlayer,
    selfDecks: { p0: seen[0] ?? [], p1: seen[1] ?? [] },
    plies,
  }
}

function gameToMarkdown(g: GameSummary, names: NameLookup): string {
  const out: string[] = []
  out.push(`# Game \`${g.gameId}\``)
  out.push("")
  out.push(`- matchup tag: \`${g.shortId}\``)
  out.push(`- rounds played: ${g.rounds}`)
  out.push(`- decisions captured: ${g.totalPlies}`)
  out.push(`- winner: **${g.winner === "draw" ? "draw" : `p${g.winner}`}**`)
  out.push(`- first-mover: ${g.firstPlayer == null ? "unknown" : `p${g.firstPlayer}`}`)
  out.push(`- p0 chars: ${g.selfDecks.p0.map((d) => names.charName(d)).join(", ")}`)
  out.push(`- p1 chars: ${g.selfDecks.p1.map((d) => names.charName(d)).join(", ")}`)
  out.push("")
  out.push("| ply | R/T | side | action | dice / nrg | effect (Δhp) | top-3 π_MCTS |")
  out.push("|----:|:---:|:----:|:-------|:----------:|:-------------|:-------------|")
  for (const p of g.plies) {
    const cost = `${p.costDice}` + (p.costEnergy > 0 ? `/⚡${p.costEnergy}` : "") + (p.consumesLegend ? "/★" : "") + (p.changesActive ? "/↔" : "")
    out.push(`| ${p.ply} | R${p.round}T${p.turn} | p${p.player} | ${p.action} | ${cost} | ${p.effectSummary} | ${p.policyTop} |`)
  }
  out.push("")
  out.push("Legend: `↔` action changes active char, `★` consumes LEGEND, `⚡N` energy cost, `★X=Y%` chosen action with π_MCTS top-3 share.")
  return out.join("\n")
}

function parseArgs(argv: string[]) {
  let limit = 0
  let gameFilter = ""
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--limit") limit = Number(argv[++i] ?? "0")
    else if (a === "--game") gameFilter = argv[++i] ?? ""
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`)
    else positional.push(a)
  }
  if (positional.length < 2) {
    throw new Error(
      "Usage: render-game-log.ts <db.sqlite> <out-dir> [--limit N] [--game <game_id>]",
    )
  }
  return { dbPath: positional[0], outDir: positional[1], limit, gameFilter }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.outDir)
  mkdirSync(outDir, { recursive: true })

  console.error(`[render-game-log] loading data registry @ ${CURRENT_VERSION}…`)
  const data = getData(CURRENT_VERSION)
  const names = buildNameLookup(data)

  console.error(`[render-game-log] reading ${args.dbPath}…`)
  const rows = loadAllSamples(args.dbPath)
  console.error(`[render-game-log] ${rows.length} samples, grouping by game…`)
  const byGame = groupByGame(rows)
  console.error(`[render-game-log] ${byGame.size} unique games`)

  let games = Array.from(byGame.entries()).map(([_, rs]) => renderGame(rs, names))
  if (args.gameFilter) {
    games = games.filter((g) => g.gameId === args.gameFilter || g.shortId === args.gameFilter)
  }
  games.sort((a, b) => a.gameId.localeCompare(b.gameId))
  if (args.limit > 0) games = games.slice(0, args.limit)

  // Per-game files.
  for (const g of games) {
    const path = resolve(outDir, `${g.gameId}.md`)
    writeFileSync(path, gameToMarkdown(g, names), "utf8")
  }

  // Index.
  const idx: string[] = []
  idx.push(`# Game log index — ${args.dbPath.split(/[\\/]/).pop()}`)
  idx.push("")
  idx.push(`Total games rendered: ${games.length}`)
  idx.push("")
  idx.push("| game_id | tag | rounds | plies | winner | p0 chars | p1 chars |")
  idx.push("|---|---|---:|---:|:-:|---|---|")
  for (const g of games) {
    const p0c = g.selfDecks.p0.map((d) => names.charName(d)).join(",")
    const p1c = g.selfDecks.p1.map((d) => names.charName(d)).join(",")
    const win = g.winner === "draw" ? "—" : `p${g.winner}`
    idx.push(`| [\`${g.gameId}\`](./${g.gameId}.md) | ${g.shortId} | ${g.rounds} | ${g.totalPlies} | ${win} | ${p0c} | ${p1c} |`)
  }
  writeFileSync(resolve(outDir, "index.md"), idx.join("\n"), "utf8")
  console.error(`[render-game-log] wrote ${games.length} game(s) + index.md → ${outDir}`)
}

main()
