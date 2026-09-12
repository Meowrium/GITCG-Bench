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
 * async-pool 分桶纯逻辑离线单测（2026-09-09 锦标赛 LLM 并发按供应商分桶）：
 * 逐桶上限解析（显式优先 / 缺省回退全局 / 钳 1-8 / 非法值回退）、分桶分组（首现顺序）、
 * 分桶池行为（各桶上限生效、桶间并行、缺省回退、失败隔离不串桶）。零子进程零真实计时依赖。
 */

import { describe, expect, it } from "vitest"
import {
  bucketTasks,
  resolveBucketConcurrency,
  runBucketedPool,
} from "./async-pool.js"

// ── resolveBucketConcurrency（纯函数）────────────────────────────────────

describe("resolveBucketConcurrency 逐桶上限解析", () => {
  it("显式正整数优先于全局值", () => {
    expect(resolveBucketConcurrency(5, 3)).toBe(5)
    expect(resolveBucketConcurrency(1, 8)).toBe(1)
  })

  it("显式值超上限钳到 8", () => {
    expect(resolveBucketConcurrency(20, 3)).toBe(8)
    expect(resolveBucketConcurrency(8, 3)).toBe(8)
  })

  it("缺省回退全局值（旧 config 行为逐一致）", () => {
    expect(resolveBucketConcurrency(undefined, 3)).toBe(3)
    expect(resolveBucketConcurrency(undefined, 8)).toBe(8)
  })

  it("非法显式值（非正整数）回退全局值", () => {
    expect(resolveBucketConcurrency(0, 3)).toBe(3)
    expect(resolveBucketConcurrency(-2, 3)).toBe(3)
    expect(resolveBucketConcurrency(1.5, 3)).toBe(3)
    expect(resolveBucketConcurrency(Number.NaN, 3)).toBe(3)
  })

  it("结果恒钳 1-8（全局值异常时兜底）", () => {
    expect(resolveBucketConcurrency(undefined, 12)).toBe(8)
    expect(resolveBucketConcurrency(undefined, 0)).toBe(1)
  })
})

// ── bucketTasks（纯函数）─────────────────────────────────────────────────

describe("bucketTasks 分桶分组", () => {
  const tasks = [
    { model: "alpha", id: 0 },
    { model: "beta", id: 0 },
    { model: "alpha", id: 1 },
    { model: "gamma", id: 0 },
    { model: "beta", id: 1 },
  ]
  const limits: Record<string, number> = { alpha: 1, beta: 2, gamma: 4 }

  it("按 key 分组、保持首现顺序、各桶上限逐桶解析", () => {
    const buckets = bucketTasks(tasks, (t) => t.model, (k) => limits[k]!)
    expect(buckets.map((b) => b.key)).toEqual(["alpha", "beta", "gamma"])
    expect(buckets.map((b) => b.concurrency)).toEqual([1, 2, 4])
    expect(buckets.map((b) => b.items.map((t) => t.id))).toEqual([[0, 1], [0, 1], [0]])
  })

  it("空输入 → 空桶列表（concurrencyOf 不被调用）", () => {
    let called = 0
    const buckets = bucketTasks([], (t: { model: string }) => t.model, () => {
      called++
      return 1
    })
    expect(buckets).toEqual([])
    expect(called).toBe(0)
  })
})

// ── runBucketedPool 行为 ─────────────────────────────────────────────────

interface Task {
  model: string
  id: number
}

/** 在飞计数探针：记录逐桶与全局峰值（worker 首段同步执行，峰值可确定性断言） */
function probe(): {
  wrap: (t: Task, delayMs: number) => Promise<void>
  peakOf: (model: string) => number
  totalPeak: () => number
  ran: string[]
} {
  const inFlight = new Map<string, number>()
  const peak = new Map<string, number>()
  let total = 0
  let totalMax = 0
  const ran: string[] = []
  return {
    wrap: async (t, delayMs) => {
      const cur = (inFlight.get(t.model) ?? 0) + 1
      inFlight.set(t.model, cur)
      peak.set(t.model, Math.max(peak.get(t.model) ?? 0, cur))
      total++
      totalMax = Math.max(totalMax, total)
      await new Promise((r) => setTimeout(r, delayMs))
      inFlight.set(t.model, cur - 1)
      total--
      ran.push(`${t.model}${t.id}`)
    },
    peakOf: (model) => peak.get(model) ?? 0,
    totalPeak: () => totalMax,
    ran,
  }
}

describe("runBucketedPool 分桶池", () => {
  it("各桶上限生效且桶间并行（桶间不共享槽位）", async () => {
    const tasks: Task[] = [
      { model: "alpha", id: 0 }, { model: "alpha", id: 1 }, { model: "alpha", id: 2 },
      { model: "beta", id: 0 }, { model: "beta", id: 1 },
    ]
    const p = probe()
    await runBucketedPool(tasks, (t) => t.model, (m) => (m === "alpha" ? 1 : 2), (t) => p.wrap(t, 10))
    expect(p.peakOf("alpha")).toBe(1) // 上限 1
    expect(p.peakOf("beta")).toBe(2) // 上限 2
    expect(p.totalPeak()).toBeGreaterThan(2) // 两桶同时在飞 → 并行 drain
    expect(p.ran.sort()).toEqual(["alpha0", "alpha1", "alpha2", "beta0", "beta1"])
  })

  it("缺省回退：无 concurrency 的桶用全局上限（与 model-tournament 同一解析口径）", async () => {
    const limits: Record<string, number | undefined> = { alpha: 1, beta: undefined }
    const tasks: Task[] = [
      { model: "alpha", id: 0 }, { model: "alpha", id: 1 }, { model: "alpha", id: 2 },
      { model: "beta", id: 0 }, { model: "beta", id: 1 }, { model: "beta", id: 2 },
    ]
    const p = probe()
    await runBucketedPool(tasks, (t) => t.model, (m) => resolveBucketConcurrency(limits[m], 2), (t) => p.wrap(t, 10))
    expect(p.peakOf("alpha")).toBe(1) // 显式上限
    expect(p.peakOf("beta")).toBe(2) // 缺省回退全局 2
    expect(p.ran).toHaveLength(6)
  })

  it("失败隔离不串桶：某桶任务抛错只停该桶，其余桶全部跑完，最后抛出该错误", async () => {
    const tasks: Task[] = [
      { model: "bad", id: 0 }, { model: "good", id: 0 },
      { model: "bad", id: 1 }, { model: "good", id: 1 },
    ]
    const p = probe()
    const run = runBucketedPool(tasks, (t) => t.model, () => 1, async (t) => {
      if (t.model === "bad" && t.id === 0) throw new Error("模拟桶内失败")
      await p.wrap(t, 5)
    })
    await expect(run).rejects.toThrow("模拟桶内失败")
    expect(p.ran).toContain("good0")
    expect(p.ran).toContain("good1") // 其余桶不受影响
    expect(p.ran).not.toContain("bad1") // 桶内上限 1：抛错后该桶不再取任务
  })

  it("空任务 → 直接 resolve（concurrencyOf/worker 均不被调用）", async () => {
    let called = 0
    await runBucketedPool([], (t: Task) => t.model, () => {
      called++
      return 1
    }, async () => {
      called++
    })
    expect(called).toBe(0)
  })
})
