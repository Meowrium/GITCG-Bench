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
 * async-pool — 编排脚本的 LLM 子进程并发基建。
 *
 * author/evolve 的墙钟瓶颈在 spawnSync 串行（模型 × 卡组 × 臂逐个跑）；各 LLM 单元
 * 相互独立（独立凭据注入 / 独立 --out / 独立 state key），适合有界工作池并行。
 * 池上限可按模型分桶（runBucketedPool：每模型一个独立池，慢供应商不队头阻塞其余模型）。
 * 引擎 battle 批保持同步路径（CPU 密集，与 LLM 限速无关）。
 */

import { spawn } from "node:child_process"

export interface SpawnResult {
  ok: boolean
  output: string
  timedOut: boolean
}

/** spawnPnpm 的异步版（Windows 下 pnpm 是 .cmd——shell: true）；超时 kill 并标记 timedOut。 */
export function spawnPnpmAsync(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: opts.cwd,
      // 逐模型凭据注入（impl-spec-0 §4）：opts.env 必须真正传给子进程
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on("data", (d: Buffer) => {
      stdout += String(d)
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += String(d)
    })
    child.on("error", (e) => {
      if (timer) clearTimeout(timer)
      resolve({ ok: false, output: `${stdout}\n${stderr}\n${e.message}`.trim(), timedOut })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ ok: code === 0, output: `${stdout}\n${stderr}`.trim(), timedOut })
    })
  })
}

/** 有界并发工作池：最多 concurrency 个 worker 从 items 中取任务执行。 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const n = Math.max(1, Math.min(concurrency, items.length))
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        await worker(items[i]!, i)
      }
    }),
  )
}

/**
 * 逐桶并发上限解析（纯函数）：桶自身上限（正整数）优先，缺省/非法回退全局上限；
 * 结果恒钳 1-8（API 限速友好——与 config.llmConcurrency 同口径）。
 * globalLimit 由调用方保证已解析（默认值 + 钳制），此处只做兜底钳制。
 */
export function resolveBucketConcurrency(bucketLimit: number | undefined, globalLimit: number): number {
  const n = Number.isInteger(bucketLimit) && (bucketLimit as number) >= 1 ? (bucketLimit as number) : globalLimit
  return Math.max(1, Math.min(n, 8))
}

/** 分桶结果：同桶任务 + 该桶解析后的并发上限（桶按首次出现顺序排列） */
export interface TaskBucket<T> {
  key: string
  concurrency: number
  items: T[]
}

/** 纯函数：按 keyOf 分组（保持首现顺序），各桶上限由 concurrencyOf(key) 解析。 */
export function bucketTasks<T>(
  tasks: readonly T[],
  keyOf: (task: T) => string,
  concurrencyOf: (key: string) => number,
): Array<TaskBucket<T>> {
  const byKey = new Map<string, TaskBucket<T>>()
  for (const task of tasks) {
    const key = keyOf(task)
    let bucket = byKey.get(key)
    if (bucket === undefined) {
      bucket = { key, concurrency: concurrencyOf(key), items: [] }
      byKey.set(key, bucket)
    }
    bucket.items.push(task)
  }
  return [...byKey.values()]
}

/**
 * 分桶有界工作池：每桶一个独立 runPool（上限 = 该桶解析值），各桶并行 drain——
 * 桶间不共享槽位（慢供应商的队头阻塞不外溢到其余模型/供应商）；桶内失败只停该桶，
 * 其余桶照跑（全部桶 settle 后才抛出首个拒绝——不用 Promise.all 提前 reject，
 * 避免其余桶变成游离的未处理拒绝）。
 */
export async function runBucketedPool<T>(
  tasks: readonly T[],
  keyOf: (task: T) => string,
  concurrencyOf: (key: string) => number,
  worker: (task: T, index: number) => Promise<void>,
): Promise<void> {
  const buckets = bucketTasks(tasks, keyOf, concurrencyOf)
  const settled = await Promise.allSettled(buckets.map((b) => runPool(b.items, b.concurrency, worker)))
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")
  if (rejected !== undefined) throw rejected.reason
}

/**
 * 状态落盘互斥：并行 worker 对同一 state.json 的写必须串行化（内存对象是真值，
 * 每次变更后排队整体落盘；上次写失败不阻塞后续写，错误向上抛给调用方）。
 */
export function createSerializedSaver<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (...args: A) => {
    const run = chain.then(() => fn(...args))
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
