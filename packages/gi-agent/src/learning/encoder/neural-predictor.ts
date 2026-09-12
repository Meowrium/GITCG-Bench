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

/**
 * V30 Stage 3.F — Neural encoder runtime predictor.
 *
 * Loads the JSON weights bundle written by `gitcg_ml.train_v30_encoder` and
 * reproduces the forward pass in pure TypeScript so the runtime never needs
 * a Python dependency.
 *
 * The implementation is intentionally straightforward and CPU-only: encode
 * one observation at a time, score all candidates jointly, return Q values
 * (logits) and a baseline V(s).
 *
 * Layout matches `train_v30_encoder.py:V30Encoder`:
 *   - per-kind embedding tables (character / summon / support / combat_status
 *     / character_status / hand_card / action_target)
 *   - DeepSets pool (mean ⊕ max ⊕ sum) over each entity set
 *   - 5 sets × pool + side_meta(7, V31 F3/F5 + D7 first-mover) + dice(9) → side_proj
 *   - 2 sides + global_meta(3) → state_proj → V(s)
 *   - per-candidate action_proj concatenated with state → advantage_head
 *   - dueling Q(s, a) = V(s) + A(s, a) − mean_a A
 */

import { readFileSync } from "node:fs"
import type { StateObservation } from "./state-observation.js"

// V31 F9 — Character Skill Fingerprint dimension (must match generator output).
const CSF_DIM = 256

// ─────────────────────────────────────────────────────────────────────────────
// Constants — must mirror Python side exactly
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_CASES = [
  "useSkill",
  "playCard",
  "switchActive",
  "elementalTuning",
  "declareEnd",
  "unknown",
] as const

const ACTION_CASE_TO_INDEX: Record<string, number> = Object.fromEntries(
  ACTION_CASES.map((c, i) => [c, i] as const),
)

const AURA_VOCAB = [0, 1, 2, 3, 4, 7, 113] as const
const AURA_TO_INDEX: Record<number, number> = Object.fromEntries(
  AURA_VOCAB.map((v, i) => [v, i] as const),
)

const NUM_ACTION_CASES = ACTION_CASES.length

// ─────────────────────────────────────────────────────────────────────────────
// Loader types
// ─────────────────────────────────────────────────────────────────────────────

interface SerialisedTensor {
  shape: number[]
  dtype: string
  values: number[]
}

interface VocabJson {
  pad_token: number
  unk_token: number
  size: number
  id_to_index: Record<string, number>
}

interface VocabularyJson {
  character: VocabJson
  summon: VocabJson
  support: VocabJson
  combat_status: VocabJson
  character_status: VocabJson
  hand_card: VocabJson
  action_target: VocabJson
}

interface EncoderConstants {
  MAX_CHARS: number
  MAX_SUMMONS: number
  MAX_SUPPORTS: number
  MAX_COMBAT_STATUSES: number
  MAX_HAND: number
  MAX_CANDIDATES: number
  DICE_BUCKETS: number
  COST_BUCKETS: number
  PREVIEW_VECTOR_DIM: number
  ACTION_CASES: string[]
  AURA_VOCAB: number[]
}

interface HParamsJson {
  embed_dim: number
  hidden_dim: number
  state_repr_dim: number
  action_repr_dim: number
  dropout: number
}

export interface EncoderWeightsBundle {
  schema_version: number
  h_params: HParamsJson
  vocabularies: VocabularyJson
  constants: EncoderConstants
  state_dict: Record<string, SerialisedTensor>
}

// ─────────────────────────────────────────────────────────────────────────────
// Tensor helpers (very small subset, optimised for clarity over speed)
// ─────────────────────────────────────────────────────────────────────────────

class Vocab {
  private readonly map = new Map<number, number>()
  readonly size: number
  readonly padToken: number
  readonly unkToken: number
  constructor(json: VocabJson) {
    this.size = json.size
    this.padToken = json.pad_token
    this.unkToken = json.unk_token
    for (const [k, v] of Object.entries(json.id_to_index)) {
      this.map.set(Number(k), v)
    }
  }
  encode(raw: number | undefined | null): number {
    if (raw == null || !Number.isFinite(raw) || raw <= 0) return this.padToken
    const i = this.map.get(raw)
    return i ?? this.unkToken
  }
}

function gelu(x: number): number {
  // Approximate GELU (matches PyTorch nn.GELU 'tanh' enough for our purposes;
  // PyTorch default is exact but the approximation is ~1e-4 close).
  return 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x ** 3)))
}

/** Multiply matrix W (out, in) by vector x (in) and add bias b (out). */
function linear(W: SerialisedTensor, b: SerialisedTensor, x: number[]): number[] {
  const [outDim, inDim] = W.shape
  const out = new Array<number>(outDim)
  for (let i = 0; i < outDim; i++) {
    let acc = b.values[i]
    const base = i * inDim
    for (let j = 0; j < inDim; j++) {
      acc += W.values[base + j] * x[j]
    }
    out[i] = acc
  }
  return out
}

function applyGelu(v: number[]): number[] {
  for (let i = 0; i < v.length; i++) v[i] = gelu(v[i])
  return v
}

/** A 2-layer GELU MLP matching torch nn.Sequential(Linear, GELU, Dropout, Linear). */
function mlp(weights: Record<string, SerialisedTensor>, prefix: string, x: number[]): number[] {
  const w0 = weights[`${prefix}.0.weight`]
  const b0 = weights[`${prefix}.0.bias`]
  const w3 = weights[`${prefix}.3.weight`]
  const b3 = weights[`${prefix}.3.bias`]
  if (!w0 || !b0 || !w3 || !b3) {
    throw new Error(`MLP weights missing for prefix='${prefix}'`)
  }
  return linear(w3, b3, applyGelu(linear(w0, b0, x)))
}

/** Embedding lookup → vector of length D. PadIdx 0 → zeros. */
function embed(weights: Record<string, SerialisedTensor>, key: string, idx: number): number[] {
  const t = weights[`${key}.weight`]
  if (!t) throw new Error(`Embedding tensor missing: ${key}`)
  const [vocab, dim] = t.shape
  if (idx < 0 || idx >= vocab) idx = 0
  const out = new Array<number>(dim)
  const base = idx * dim
  for (let j = 0; j < dim; j++) out[j] = t.values[base + j]
  return out
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0)
}

function add(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i]
  return out
}

function scale(a: number[], s: number): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s
  return out
}

function maxOfTwo(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i]
  return out
}

function concat(parts: number[][]): number[] {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Array<number>(total)
  let off = 0
  for (const p of parts) {
    for (let j = 0; j < p.length; j++) out[off + j] = p[j]
    off += p.length
  }
  return out
}

/** DeepSets-style pool over a list of present vectors. Returns mean ⊕ max ⊕ sum. */
function deepSetsPool(vectors: number[][], dim: number): number[] {
  if (vectors.length === 0) return zeros(3 * dim)
  const sum = zeros(dim)
  const max = vectors[0].slice()
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i]
    for (let j = 0; j < dim; j++) {
      sum[j] += v[j]
      if (v[j] > max[j]) max[j] = v[j]
    }
  }
  const mean = scale(sum, 1 / vectors.length)
  return concat([mean, max, sum])
}

// ─────────────────────────────────────────────────────────────────────────────
// Predictor
// ─────────────────────────────────────────────────────────────────────────────

export interface NeuralPredictorInput {
  observation: StateObservation
}

export interface NeuralPredictorOutput {
  /** V(s) baseline value (logit-space). */
  v: number
  /** Q(s, a) per candidate (logit-space). Indexed by candidate_actions[i].candidate_id. */
  q: number[]
  /** Sigmoid(Q(s, a)) — convenience win-prob estimate. */
  winProb: number[]
  /** Order: same as observation.candidate_actions. */
  candidateIds: string[]
}

export class V30NeuralPredictor {
  private readonly weights: Record<string, SerialisedTensor>
  private readonly vocabs: {
    character: Vocab
    summon: Vocab
    support: Vocab
    combat_status: Vocab
    character_status: Vocab
    hand_card: Vocab
    action_target: Vocab
  }
  private readonly hp: HParamsJson
  private readonly constants: EncoderConstants

  constructor(bundle: EncoderWeightsBundle) {
    this.weights = bundle.state_dict
    this.hp = bundle.h_params
    this.constants = bundle.constants
    this.vocabs = {
      character: new Vocab(bundle.vocabularies.character),
      summon: new Vocab(bundle.vocabularies.summon),
      support: new Vocab(bundle.vocabularies.support),
      combat_status: new Vocab(bundle.vocabularies.combat_status),
      character_status: new Vocab(bundle.vocabularies.character_status),
      hand_card: new Vocab(bundle.vocabularies.hand_card),
      action_target: new Vocab(bundle.vocabularies.action_target),
    }
  }

  static fromFile(path: string): V30NeuralPredictor {
    const text = readFileSync(path, "utf8")
    return new V30NeuralPredictor(JSON.parse(text) as EncoderWeightsBundle)
  }

  predict(input: NeuralPredictorInput): NeuralPredictorOutput {
    const o = input.observation
    const stateRepr = this.stateRepr(o)
    // Value head
    const vHidden = applyGelu(linear(
      this.weights["value_head.0.weight"],
      this.weights["value_head.0.bias"],
      stateRepr,
    ))
    const v = linear(
      this.weights["value_head.3.weight"],
      this.weights["value_head.3.bias"],
      vHidden,
    )[0]

    // Action features
    const advantages: number[] = []
    const candidateIds: string[] = []
    for (const a of o.candidate_actions) {
      const targetIdx = this.vocabs.action_target.encode(a.primary_definition_id)
      const targetEmb = embed(this.weights, "target_emb", targetIdx)
      const caseIdx = ACTION_CASE_TO_INDEX[a.action_case] ?? ACTION_CASE_TO_INDEX["unknown"]
      const caseEmb = embed(this.weights, "case_emb", caseIdx)
      const cost = padTo(a.cost_by_type ?? [], this.constants.COST_BUCKETS)
      const preview = padTo(a.preview_vector ?? [], this.constants.PREVIEW_VECTOR_DIM)
      const flags = [
        (a.cost_total_dice ?? 0) / 6,
        (a.cost_energy ?? 0) / 4,
        a.is_fast ? 1 : 0,
        // V31 F3: P1 decision dims (tuning target / legend / active change).
        typeof a.tuning_target === "number" && a.tuning_target > 0 ? a.tuning_target / 7 : 0,
        a.consumes_legend ? 1 : 0,
        a.changes_active ? 1 : 0,
      ]
      const aIn = concat([targetEmb, caseEmb, cost, preview, flags])
      const aRepr = mlp(this.weights, "action_proj", aIn)
      const advHidden = applyGelu(linear(
        this.weights["advantage_head.0.weight"],
        this.weights["advantage_head.0.bias"],
        concat([stateRepr, aRepr]),
      ))
      const adv = linear(
        this.weights["advantage_head.3.weight"],
        this.weights["advantage_head.3.bias"],
        advHidden,
      )[0]
      advantages.push(adv)
      candidateIds.push(a.candidate_id)
    }

    let baseline = 0
    if (advantages.length > 0) {
      let s = 0
      for (const x of advantages) s += x
      baseline = s / advantages.length
    }
    const q = advantages.map((adv) => v + adv - baseline)
    const winProb = q.map((z) => 1 / (1 + Math.exp(-z)))
    return { v, q, winProb, candidateIds }
  }

  private encodeSide(
    side: "self" | "opponent",
    observation: StateObservation,
  ): number[] {
    const data = side === "self" ? observation.self : observation.opponent
    const dim = this.hp.state_repr_dim / 2 // pool input dim per kind == S/2

    // Characters
    const charProjs: number[][] = []
    const chars = data.characters.slice(0, this.constants.MAX_CHARS)
    for (const c of chars) {
      const idx = this.vocabs.character.encode(c.definition_id)
      const charEmb = embed(this.weights, "char_emb", idx)
      const maxH = Math.max(c.max_health || 1, 1)
      const maxE = Math.max(c.max_energy || 1, 1)
      const num = [
        (c.health ?? 0) / maxH,
        (c.energy ?? 0) / maxE,
        c.defeated ? 0 : 1,
        c.is_active ? 1 : 0,
      ]
      // Attached pool
      const attEmbs: number[][] = []
      for (const a of c.attached_definition_ids.slice(0, 4)) {
        const i = this.vocabs.character_status.encode(a)
        if (i !== this.vocabs.character_status.padToken) {
          attEmbs.push(embed(this.weights, "cstat_emb", i))
        }
      }
      const cstatDim = this.weights["cstat_emb.weight"].shape[1]
      const attPool = attEmbs.length === 0
        ? zeros(cstatDim)
        : meanVec(attEmbs)
      // V31 F9: Character Skill Fingerprint (256 dims), zeros for missing.
      const csf = padTo(c.skill_fingerprint ?? [], CSF_DIM)
      const xIn = concat([charEmb, num, attPool, csf])
      charProjs.push(mlp(this.weights, "char_proj", xIn))
    }
    const charPool = deepSetsPool(charProjs, dim)

    // Summons
    const summonProjs: number[][] = []
    for (const e of data.summons.slice(0, this.constants.MAX_SUMMONS)) {
      const idx = this.vocabs.summon.encode(e.definition_id)
      const usage = e.usage ?? 0
      summonProjs.push(mlp(this.weights, "summon_proj", concat([embed(this.weights, "summon_emb", idx), [usage]])))
    }
    const summonPool = deepSetsPool(summonProjs, dim)

    // Supports
    const supportProjs: number[][] = []
    for (const e of data.supports.slice(0, this.constants.MAX_SUPPORTS)) {
      const idx = this.vocabs.support.encode(e.definition_id)
      const usage = e.usage ?? 0
      supportProjs.push(mlp(this.weights, "support_proj", concat([embed(this.weights, "support_emb", idx), [usage]])))
    }
    const supportPool = deepSetsPool(supportProjs, dim)

    // Combat statuses
    const csProjs: number[][] = []
    for (const e of data.combat_statuses.slice(0, this.constants.MAX_COMBAT_STATUSES)) {
      const idx = this.vocabs.combat_status.encode(e.definition_id)
      csProjs.push(mlp(this.weights, "cs_proj", embed(this.weights, "cs_emb", idx)))
    }
    const csPool = deepSetsPool(csProjs, dim)

    // Hand
    const handProjs: number[][] = []
    for (const c of data.hand.slice(0, this.constants.MAX_HAND)) {
      const idx = this.vocabs.hand_card.encode(c.definition_id)
      handProjs.push(mlp(this.weights, "hand_proj", embed(this.weights, "hand_emb", idx)))
    }
    const handPool = deepSetsPool(handProjs, dim)

    const meta = [
      data.declared_end ? 1 : 0,
      data.legend_used ? 1 : 0,
      data.hand_size / 12,
      data.pile_size / 30,
      // V31 F3: active character element (DiceType 0..7) normalised.
      (data.active_element ?? 0) / 7,
      // V31 F5: presence of any immune-to-defeat charge on this side.
      data.characters.some((c) => (c.immune_remaining ?? 0) > 0) ? 1 : 0,
      // V31 F6 / D7 (schema v3): coin-flip first-mover flag — only asymmetric
      // signal in pure mirror matchups.
      data.is_first_player ? 1 : 0,
    ]
    const dice = padTo(data.dice_counts ?? [], this.constants.DICE_BUCKETS)
    return mlp(this.weights, "side_proj", concat([charPool, summonPool, supportPool, csPool, handPool, meta, dice]))
  }

  private stateRepr(o: StateObservation): number[] {
    const self = this.encodeSide("self", o)
    const opp = this.encodeSide("opponent", o)
    const glob = [
      (o.meta.round ?? 0) / 12,
      o.meta.opponent_declared_end ? 1 : 0,
      o.meta.perspective ?? 0,
    ]
    return mlp(this.weights, "state_proj", concat([self, opp, glob]))
  }
}

function meanVec(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0].length
  const out = zeros(dim)
  for (const v of vectors) {
    for (let j = 0; j < dim; j++) out[j] += v[j]
  }
  for (let j = 0; j < dim; j++) out[j] /= vectors.length
  return out
}

function padTo(arr: number[], n: number): number[] {
  const out = new Array<number>(n).fill(0)
  for (let i = 0; i < Math.min(arr.length, n); i++) out[i] = arr[i] ?? 0
  return out
}
