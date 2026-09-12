// Copyright (C) 2024-2025 Guyutongxue
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
 * ReplayBuffer — Fixed-size buffer retaining historical training samples
 * to prevent catastrophic forgetting during incremental fine-tuning.
 *
 * Uses FIFO eviction with uniform random sampling for replay.
 * Supports JSON persistence alongside DataLake.
 */

import type { LabeledSample } from "../../learning/scoring/feature-extractor.js"

export class ReplayBuffer {
  private samples: LabeledSample[] = []
  private readonly maxSize: number

  constructor(maxSize: number = 100_000) {
    this.maxSize = maxSize
  }

  /** Add new samples. Evicts oldest (FIFO) when over capacity. */
  add(samples: readonly LabeledSample[]): void {
    this.samples.push(...samples)
    if (this.samples.length > this.maxSize) {
      this.samples = this.samples.slice(this.samples.length - this.maxSize)
    }
  }

  /** Uniform random sample of up to `count` entries. */
  sample(count: number): LabeledSample[] {
    if (count >= this.samples.length) return [...this.samples]
    const indices = new Set<number>()
    while (indices.size < count) {
      indices.add(Math.floor(Math.random() * this.samples.length))
    }
    return [...indices].map((i) => this.samples[i])
  }

  /** Total number of stored samples. */
  get size(): number {
    return this.samples.length
  }

  /** Diagnostic statistics. */
  getStats(): { total: number; labelMean: number; weightMean: number } {
    if (this.samples.length === 0) return { total: 0, labelMean: 0, weightMean: 0 }
    let labelSum = 0
    let weightSum = 0
    for (const s of this.samples) {
      labelSum += s.label
      weightSum += s.weight ?? 1.0
    }
    return {
      total: this.samples.length,
      labelMean: labelSum / this.samples.length,
      weightMean: weightSum / this.samples.length,
    }
  }

  /** Serialize to JSON-serializable array. */
  toJSON(): LabeledSample[] {
    return this.samples
  }

  /** Deserialize from JSON array. */
  static fromJSON(
    data: LabeledSample[],
    maxSize: number = 100_000,
  ): ReplayBuffer {
    const buffer = new ReplayBuffer(maxSize)
    buffer.samples = [...data]
    return buffer
  }
}
