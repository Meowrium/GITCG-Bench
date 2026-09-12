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
 * tournament-scheduler 离线单测（impl-spec-1 §4.7）：批分区（done/ready/not-ready）、
 * 调度循环（producer 未结束即派发 / drain 终止 / 唤醒加速 / 并发上限 / 失败不重试）、
 * not-ready 失败记录、battleKey 格式契约。全部零引擎零子进程零真实计时依赖（pollMs 毫秒级）。
 */

import { describe, expect, it } from "vitest"
import {
  battleKey,
  createStateSignal,
  partitionBatches,
  runBattleScheduler,
  type SchedulerBatchSpec,
} from "./tournament-scheduler.js"
import { cellDirOf, pairDirOf, playerIdOf } from "./tournament-config.js"

// ── fixture ──────────────────────────────────────────────────────────────

const ENV = "v6.3"

function specOf(over: Partial<SchedulerBatchSpec> = {}): SchedulerBatchSpec {
  return {
    round: 0,
    envLabel: ENV,
    planModel: "alpha",
    planRound: 0,
    di: 0,
    oppModel: "beta",
    oppRound: 0,
    dj: 1,
    isChain: false,
    ...over,
  }
}

interface Harness {
  done: Set<string>
  ready: Set<string>
  ran: string[]
  failures: Array<{ key: string; error: string }>
  maxInFlight: number
}

function harness(specs: readonly SchedulerBatchSpec[], opts: { runBatchMs?: number; failKeys?: Set<string> } = {}): {
  h: Harness
  deps: Parameters<typeof runBattleScheduler<SchedulerBatchSpec>>[0]
} {
  const h: Harness = { done: new Set(), ready: new Set(), ran: [], failures: [], maxInFlight: 0 }
  let inFlight = 0
  const deps = {
    specs,
    keyOf: battleKey,
    isDone: (key: string) => h.done.has(key),
    isReady: (spec: SchedulerBatchSpec) => h.ready.has(battleKey(spec)),
    runBatch: async (spec: SchedulerBatchSpec) => {
      inFlight++
      h.maxInFlight = Math.max(h.maxInFlight, inFlight)
      h.ran.push(battleKey(spec))
      if (opts.runBatchMs !== undefined) await new Promise((r) => setTimeout(r, opts.runBatchMs))
      inFlight--
      if (opts.failKeys?.has(battleKey(spec))) throw new Error(`批失败（模拟）：${battleKey(spec)}`)
      h.done.add(battleKey(spec))
    },
    onNotReady: (spec: SchedulerBatchSpec, key: string) => {
      h.failures.push({ key, error: `依赖未就绪（上游 author/evolve 失败或未生成）:${battleKey(spec)}` })
    },
    producerDone: Promise.resolve(),
    concurrency: 4,
    pollMs: 5,
    log: () => {},
  }
  return { h, deps }
}

// ── battleKey 契约 ───────────────────────────────────────────────────────

describe("tournament-scheduler battleKey 契约", () => {
  it("与 tournament-archive battleKeyOf / state.json 格式逐字符一致", () => {
    expect(battleKey(specOf())).toBe("battle|r0|v6.3|alpha@r0__vs__beta@r0|0-vs-1")
    expect(
      battleKey(specOf({ round: 1, planRound: 1, oppModel: "alpha", oppRound: 0, isChain: true })),
    ).toBe("battle|r1|v6.3|alpha@r1__vs__alpha@r0|0-vs-1")
    // 独立复算（命名约定纯函数）
    const s = specOf({ planModel: "x", oppModel: "y", di: 2, dj: 3, round: 2, planRound: 2, oppRound: 2 })
    expect(battleKey(s)).toBe(`battle|r2|${ENV}|${pairDirOf(playerIdOf("x", 2), playerIdOf("y", 2))}|${cellDirOf(2, 3)}`)
  })
})

// ── partitionBatches（纯函数）────────────────────────────────────────────

describe("partitionBatches 分区", () => {
  const s1 = specOf({ di: 0, dj: 0 })
  const s2 = specOf({ di: 0, dj: 1 })
  const s3 = specOf({ di: 1, dj: 0 })
  const specs = [s1, s2, s3]
  const keyOf = battleKey
  const isReady = (s: SchedulerBatchSpec) => s.di !== 1 // s3 依赖未就绪

  it("done / attempted → skipped；就绪 → ready；其余 → notReady", () => {
    const attempted = new Set<string>()
    const p = partitionBatches(specs, keyOf, (k) => k === battleKey(s1), isReady, attempted)
    expect(p.skipped.map(keyOf)).toEqual([battleKey(s1)])
    expect(p.ready.map(keyOf)).toEqual([battleKey(s2)])
    expect(p.notReady.map(keyOf)).toEqual([battleKey(s3)])
  })

  it("attempted（本 invocation 已尝试含失败）与 done 一样跳过", () => {
    const attempted = new Set([battleKey(s2)])
    const p = partitionBatches(specs, keyOf, () => false, isReady, attempted)
    expect(p.skipped.map(keyOf)).toEqual([battleKey(s2)])
    expect(p.ready.map(keyOf)).toEqual([battleKey(s1)])
  })

  it("空赛程 → 三区全空", () => {
    const p = partitionBatches([], keyOf, () => false, isReady, new Set())
    expect(p).toEqual({ ready: [], notReady: [], skipped: [] })
  })
})

// ── runBattleScheduler 调度循环 ──────────────────────────────────────────

describe("runBattleScheduler 调度循环", () => {
  it("producer 未结束时即派发就绪批（生成即赛的核心断言）", async () => {
    const a = specOf({ di: 0, dj: 1 })
    let releaseProducer!: () => void
    const producerDone = new Promise<void>((resolve) => { releaseProducer = resolve })
    const { h, deps } = harness([a])
    h.ready.add(battleKey(a))
    const order: string[] = []
    void producerDone.then(() => { order.push("producer-settled") })
    const running = runBattleScheduler({ ...deps, producerDone })
    // 首扫同步派发（runBattleScheduler 函数体首个 await 之前完成）——producer 仍挂起
    expect(h.ran).toEqual([battleKey(a)])
    expect(order).toEqual([]) // producer-settled 尚未发生
    releaseProducer()
    const result = await running
    expect(result.dispatched).toBe(1)
    expect(result.notReady).toBe(0)
    expect(order).toEqual(["producer-settled"])
  })

  it("drain：producer 运行中途陆续就绪的批被持续补派；producer 结束后立即收尾", async () => {
    const a = specOf({ di: 0, dj: 1 })
    const b = specOf({ planModel: "beta", oppModel: "alpha", di: 1, dj: 0 })
    const { h, deps } = harness([a, b])
    let releaseProducer!: () => void
    const producerDone = new Promise<void>((resolve) => { releaseProducer = resolve })
    // a 初始就绪；b 在 a 跑完后、producer 结束前才就绪（模拟 producer 逐 di 产出）
    h.ready.add(battleKey(a))
    const running = runBattleScheduler({ ...deps, producerDone })
    await new Promise((r) => setTimeout(r, 10))
    expect(h.ran).toEqual([battleKey(a)])
    h.ready.add(battleKey(b))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.ran).toEqual([battleKey(a), battleKey(b)]) // 轮询/补派发现新就绪批
    releaseProducer()
    const result = await running // producer 结束 → 立即收尾（不被 pollMs 拖住）
    expect(result.dispatched).toBe(2)
    expect(result.notReady).toBe(0)
  })

  it("终态 drain：依赖未就绪的批逐个回调 onNotReady（依赖未就绪失败语义）", async () => {
    const readySpec = specOf({ di: 0, dj: 1 })
    const staleA = specOf({ planModel: "alpha", di: 1, dj: 0 })
    const staleB = specOf({ planModel: "beta", oppModel: "alpha", di: 1, dj: 1 })
    const { h, deps } = harness([readySpec, staleA, staleB])
    h.ready.add(battleKey(readySpec))
    const result = await runBattleScheduler(deps)
    expect(h.ran).toEqual([battleKey(readySpec)])
    expect(result.dispatched).toBe(1)
    expect(result.notReady).toBe(2)
    expect(h.failures.map((f) => f.key).sort()).toEqual([battleKey(staleA), battleKey(staleB)].sort())
    for (const f of h.failures) {
      expect(f.error).toContain("依赖未就绪（上游 author/evolve 失败或未生成）")
    }
  })

  it("同一 invocation 内失败（或异常）的批不重试；成功批 done 位图命中也跳过", async () => {
    const failing = specOf({ di: 0, dj: 0 })
    const ok = specOf({ di: 0, dj: 1 })
    const { h, deps } = harness([failing, ok], { failKeys: new Set([battleKey(failing)]) })
    h.ready.add(battleKey(failing))
    h.ready.add(battleKey(ok))
    const result = await runBattleScheduler(deps)
    expect(h.ran.filter((k) => k === battleKey(failing))).toHaveLength(1) // 失败后不重试
    expect(h.ran.filter((k) => k === battleKey(ok))).toHaveLength(1)
    expect(result.dispatched).toBe(2)
  })

  it("在飞批不超过 concurrency 上限", async () => {
    const specs = Array.from({ length: 9 }, (_, i) => specOf({ di: i % 2, dj: (i + 1) % 2, planModel: `m${i}` }))
    const { h, deps } = harness(specs, { runBatchMs: 15 })
    for (const s of specs) h.ready.add(battleKey(s))
    const result = await runBattleScheduler({ ...deps, concurrency: 3 })
    expect(h.ran).toHaveLength(9)
    expect(h.maxInFlight).toBeLessThanOrEqual(3)
    expect(result.dispatched).toBe(9)
    expect(result.notReady).toBe(0)
  })

  it("唤醒信号即时触发重扫（pollMs 很大也能 promptly 派发）", async () => {
    const a = specOf({ di: 1, dj: 0 })
    const { h, deps } = harness([a])
    const signal = createStateSignal()
    let releaseProducer!: () => void
    const producerDone = new Promise<void>((resolve) => { releaseProducer = resolve })
    const running = runBattleScheduler({ ...deps, producerDone, wakeup: signal, pollMs: 60_000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(h.ran).toEqual([]) // 未就绪且未唤醒 → 等待
    h.ready.add(battleKey(a))
    signal.notify() // producer markDone 后的唤醒
    await new Promise((r) => setTimeout(r, 20))
    expect(h.ran).toEqual([battleKey(a)]) // 信号驱动派发（60s 轮询远未到）
    releaseProducer()
    await running
  })

  it("producerDone reject 也算结束：依赖其产物的批 drain 时记失败而非挂起", async () => {
    const stale = specOf({ di: 1, dj: 1 })
    const { h, deps } = harness([stale])
    const result = await runBattleScheduler({ ...deps, producerDone: Promise.reject(new Error("author 崩了")) })
    expect(result.dispatched).toBe(0)
    expect(result.notReady).toBe(1)
    expect(h.failures.map((f) => f.key)).toEqual([battleKey(stale)])
  })

  it("无唤醒信号时靠 pollMs 轮询推进（兜底路径不挂死）", async () => {
    const a = specOf({ di: 0, dj: 0 })
    const { h, deps } = harness([a])
    let releaseProducer!: () => void
    const producerDone = new Promise<void>((resolve) => { releaseProducer = resolve })
    const running = runBattleScheduler({ ...deps, producerDone, pollMs: 5 })
    await new Promise((r) => setTimeout(r, 10))
    h.ready.add(battleKey(a)) // 无信号——下一次 5ms 轮询应发现
    await Promise.race([running, new Promise((r) => setTimeout(r, 500))])
    expect(h.ran).toEqual([battleKey(a)])
    releaseProducer()
    await running
  })
})
