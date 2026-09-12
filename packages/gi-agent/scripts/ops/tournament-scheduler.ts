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
 * tournament-scheduler — battle 调度器核心（pipeline「生成即赛」，impl-spec-1 §4.7）。
 *
 * 职责：LLM producer（author/evolve）持续产出依赖（manifest / 格树）的同时，对某个
 * round 的赛程做「扫描 → 派发就绪批 → 等待 → 重扫」循环，producer 结束后 drain：
 * 把仍就绪的批跑完，仍 not-ready 的批如实记「依赖未就绪」失败（recordFailure 不写
 * done 位图，后续 invocation 重试不受阻）。
 *
 * 设计要点：
 * - 纯逻辑（分区/终止条件）抽成可测函数；异步核心 runBattleScheduler 的全部副作用
 *   （批执行、done 查询、就绪判定、唤醒）经 deps 注入——单测零引擎零子进程；
 * - 唤醒信号（createStateSignal）事件驱动 + 轮询兜底：producer markDone 后 notify，
 *   信号丢失（notify 时无等待方）最坏退化为 pollMs 轮询，不影响正确性；
 * - 同一 invocation 内已尝试（含失败）的批不重试（attempted 集合，与 battle 子命令
 *   单遍语义一致）；done 位图命中直接跳过（幂等续跑）。
 */

import { cellDirOf, pairDirOf, playerIdOf } from "./tournament-config.js"

// ── 赛程批 ───────────────────────────────────────────────────────────────

/** 单个 battle 批的赛程坐标（与 model-tournament 的 BatchSpec 结构一致——
 *  此处独立声明以避免脚本模块的 import 副作用，测试可直接导入本模块） */
export interface SchedulerBatchSpec {
  round: number
  envLabel: string
  planModel: string
  planRound: number
  di: number
  oppModel: string
  oppRound: number
  dj: number
  /** 同模型跨代链批（state log 恒全量） */
  isChain: boolean
}

/** battle 批 state key（与 model-tournament battleKey / tournament-archive battleKeyOf 同格式） */
export function battleKey(spec: SchedulerBatchSpec): string {
  const pairName = pairDirOf(playerIdOf(spec.planModel, spec.planRound), playerIdOf(spec.oppModel, spec.oppRound))
  return `battle|r${spec.round}|${spec.envLabel}|${pairName}|${cellDirOf(spec.di, spec.dj)}`
}

// ── 分区（纯函数，可测）──────────────────────────────────────────────────

/** 一次扫描的批分区：skipped = done 或本 invocation 已尝试（不再处理）；
 *  ready = 依赖就绪可派发；notReady = 依赖未就绪（drain 后记「依赖未就绪」失败的候选） */
export interface BatchPartition<T> {
  ready: T[]
  notReady: T[]
  skipped: T[]
}

export function partitionBatches<T>(
  specs: readonly T[],
  keyOf: (spec: T) => string,
  isDone: (key: string) => boolean,
  isReady: (spec: T) => boolean,
  attempted: ReadonlySet<string>,
): BatchPartition<T> {
  const ready: T[] = []
  const notReady: T[] = []
  const skipped: T[] = []
  for (const spec of specs) {
    if (isDone(keyOf(spec)) || attempted.has(keyOf(spec))) {
      skipped.push(spec)
    } else if (isReady(spec)) {
      ready.push(spec)
    } else {
      notReady.push(spec)
    }
  }
  return { ready, notReady, skipped }
}

// ── 唤醒信号 ─────────────────────────────────────────────────────────────

/** 单次唤醒信号：notify 唤醒全部当前等待方；无等待方时通知即丢失（轮询兜底） */
export interface WakeSignal {
  wait(): Promise<void>
  notify(): void
}

export function createStateSignal(): WakeSignal {
  let waiters: Array<() => void> = []
  return {
    wait: () => new Promise<void>((resolve) => { waiters.push(resolve) }),
    notify: () => {
      const current = waiters
      waiters = []
      for (const w of current) w()
    },
  }
}

/** 把唤醒钩子装到宿主对象上（model-tournament 的 Ctx：producer 经 ctx.wakeScheduler?.() 通知） */
export function installWake(target: { wakeScheduler?: () => void }): WakeSignal {
  const signal = createStateSignal()
  target.wakeScheduler = () => signal.notify()
  return signal
}

// ── 调度核心（副作用全部注入）────────────────────────────────────────────

export interface SchedulerDeps<T> {
  /** 该 round 的全部赛程批 */
  specs: readonly T[]
  keyOf: (spec: T) => string
  isDone: (key: string) => boolean
  /** 依赖就绪判定（manifest + 对手格树文件存在） */
  isReady: (spec: T) => boolean
  /** 单批执行（内部自行 markDone/recordFailure；异常视为该批失败，不中断调度） */
  runBatch: (spec: T) => Promise<void>
  /** drain 终态仍 not-ready 的批逐个回调（记「依赖未就绪」失败） */
  onNotReady: (spec: T, key: string) => void
  /** producer（author/evolve）完成信号：resolve 与 reject 都算结束（随后 drain） */
  producerDone: Promise<void>
  /** producer 推进唤醒信号（缺省 = 仅 pollMs 轮询） */
  wakeup?: WakeSignal
  /** 批进程并发 */
  concurrency: number
  /** 无唤醒信号时的重扫间隔（默认 10s） */
  pollMs?: number
  log?: (message: string) => void
}

export interface SchedulerResult {
  /** 本 invocation 实际派发的批数 */
  dispatched: number
  /** drain 终态仍依赖未就绪的批数（已逐个回调 onNotReady） */
  notReady: number
}

/**
 * 调度主循环（pipeline 模式）：
 * 1. 扫描分区 → 就绪批派发进在飞集合（上限 concurrency）；
 * 2. 有在飞批：等「任一在飞结束 ∨ 唤醒信号 ∨ pollMs 超时」后重扫；
 * 3. 无在飞批且 producer 未结束：等「唤醒信号 ∨ pollMs 超时」后重扫；
 * 4. 无在飞批且 producer 已结束且本扫描无新派发 → 终态 drain：对仍 not-ready 的批
 *    逐个回调 onNotReady（如实记录「依赖未就绪」），返回统计。
 * 终止性：每次迭代要么派发（受 specs 总量约束）、要么等待（有界）、要么退出。
 */
export async function runBattleScheduler<T>(deps: SchedulerDeps<T>): Promise<SchedulerResult> {
  const pollMs = deps.pollMs ?? 10_000
  const log = deps.log ?? ((message: string) => console.log(message))
  const attempted = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  const settleSignal = createStateSignal()
  let producerSettled = false
  let dispatched = 0
  // producer 失败（reject）也算结束：立即唤醒循环做终态 drain，把依赖其产物的批
  // 如实记「依赖未就绪」（不写 done 位图——后续 invocation 重试不受阻）
  void deps.producerDone.then(
    () => { producerSettled = true; settleSignal.notify() },
    () => { producerSettled = true; settleSignal.notify() },
  )

  const scanAndDispatch = (): number => {
    const { ready } = partitionBatches(deps.specs, deps.keyOf, deps.isDone, deps.isReady, attempted)
    let n = 0
    for (const spec of ready) {
      if (inFlight.size >= deps.concurrency) break
      const key = deps.keyOf(spec)
      attempted.add(key) // 派发即登记：本 invocation 内失败不重试
      dispatched++
      n++
      const run: Promise<void> = deps.runBatch(spec)
        .catch((e) => { log(`[battle] 批运行器异常（已隔离，继续调度）：${e instanceof Error ? e.message : String(e)}`) })
        .finally(() => { inFlight.delete(run) })
      inFlight.add(run)
    }
    return n
  }

  const settleOf = (p: Promise<void>): Promise<void> => p.then(() => undefined, () => undefined)

  while (true) {
    scanAndDispatch()
    if (inFlight.size > 0) {
      await Promise.race([
        settleOf(Promise.race([...inFlight])),
        ...(deps.wakeup ? [deps.wakeup.wait()] : []),
        settleSignal.wait(),
        sleep(pollMs),
      ])
      continue
    }
    if (producerSettled) break
    log(`[battle] 暂无就绪批，等待 producer 推进（${pollMs / 1000}s 重扫兜底）`)
    await Promise.race([
      ...(deps.wakeup ? [deps.wakeup.wait()] : []),
      settleSignal.wait(),
      sleep(pollMs),
    ])
  }

  // 终态 drain：producer 已结束、无在飞批、最后一次扫描无新派发——
  // 此时分区内仍 not-ready 的批即「上游失败/未生成」的批，如实记录失败
  const { notReady } = partitionBatches(deps.specs, deps.keyOf, deps.isDone, deps.isReady, attempted)
  for (const spec of notReady) {
    deps.onNotReady(spec, deps.keyOf(spec))
  }
  return { dispatched, notReady: notReady.length }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
