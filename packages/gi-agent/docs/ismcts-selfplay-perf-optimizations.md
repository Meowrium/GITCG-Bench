# ISMCTS Self-Play 采样加速方案（修订版）

> 状态：草案 v2（依据 2026-06 代码核查重写）
> 适用：V31 F6+ ISMCTS 自对弈管线 (`src/mcts/cli/run-ismcts-self-play.ts`)
> 排除了降低搜索质量（减步数 / 降 K / 降 N）的方案
>
> v1 → v2 修正要点：
> - 方案三：当前 `createNeuralLeafEvaluator` 调用 `predict()` 时 `actions = []`，已是 V-only 路径；无 `predictVOnly` 收益。
> - 方案四：`better-sqlite3` / `bun:sqlite` 均为同步 API，`setImmediate` 异步包装不能将写入移出主线程。
> - 方案五：以 `state.players` 对象引用作为 cache key 命中率为 0（`randomizeUnknowns` 每次产生新数组），不可行。
> - 方案二：`GameState` 含 `@gi-tcg/data` 函数引用，无法 structured-clone；闭包（leaf / opponent）不能 `postMessage`。需 worker pool 内重新构造，工程量被严重低估。
> - 方案一：`workerData` 路径需指向 `.ts`（仓库使用 `gnx` 运行）；每 worker 冷启 `getData()` 约 1–2s；`cfg.seed` 应**强制必填**以保证可复现性。

---

## 成本模型（无变化）

单局对弈约 50 个决策点，每决策点 ISMCTS 搜索耗时约 500ms（`timeBudgetMs` 上限）。
瓶颈顺序：

1. **引擎步进** (`rolloutOneRound` → `runEngineActions`) 占约 **75–80%**
2. **神经网络推理** (`predictor.predict`) 占约 **12–15%**
3. **状态观测导出** (`StateExporter.export`) 占约 **3–5%**
4. **DataLake 写入** 占约 **2–3%**（已批量写入事务内）

---

## 方案概览（修订）

| # | 方案 | 修订后预期 | 实施复杂度 | 风险 | 影响样本数值 |
|---|------|------------|------------|------|:---:|
| 1 | 对局级进程并行 | **4–6×**（线性） | 低 | 低 | 否（前提：强制 seed） |
| 2 | 确定性级线程并行 | 1.5–2×（含通信） | **高** | 高 | 可能 |
| 3 | NN 推理批量化（prior + opponent） | ~3–5% | 中 | 低 | 否 |
| 4 | 写入解耦（搬入 worker） | 2–3% | 低（依赖方案一） | 低 | 否 |
| 5 | 状态观测缓存 | 接近 0（命中率为 0） | — | — | — |

---

## 方案一：对局级进程并行（**P0 推荐**）

### 原理

IS-MCTS 自对弈中，不同对局之间**完全无依赖**：
- 每个对局有自己的 `Game` 实例、独立的 `shuffleSeed` 与 `decisionSeed`
- 所有对局共享同一份只读 `@gi-tcg/data` 与 `V30NeuralPredictor` 权重快照

当前 `run-ismcts-self-play.ts:368-389` 是串行双层循环（matchup × game），可参考已验证可行的 benchmark 并行化基础设施：

```
packages/gi-agent/src/evaluation/benchmark/cli/run-benchmark.ts:199-235
packages/gi-agent/src/evaluation/benchmark/cli/run-benchmark-worker.ts
```

### 实施方案（修订）

**主进程改造**：新增 `--concurrency N` CLI 参数；当 N>1 时将 (matchup, game) 笛卡尔积拆 shard，每个 shard 投递给一个 Worker。

**Worker 入口**：`src/mcts/cli/run-ismcts-self-play-worker.ts`
- worker 内部独立加载 `getData()` 与 `V30NeuralPredictor.fromFile()`（每个 worker ~80MB 权重 + ~150–250MB 卡牌 / Game 状态机内存）
- worker 各自打开 SQLite DataLake（WAL 已启用，多 writer 串行短事务）
- 通过 `parentPort.postMessage` 返回汇总统计

**关键修正（vs v1）**：

1. **`workerData` 模块路径**：worker 入口是 `.ts`，必须用与 `run-benchmark.ts:212` 一致的 `new URL("./run-ismcts-self-play-worker.ts", import.meta.url)` 模式，依赖 `gnx` 在 Bun/Node 下加载 TS。
2. **`cfg.seed` 必填**：现有代码当 `cfg.seed` 缺省时 `ismcts.ts:200` 用 `Date.now()` 兜底；多 worker 同时启动可能撞 seed。CLI 仍可不传，但**未传时主进程必须用 `args.seed` 派生**，并在 shard 内进一步偏移：

   ```
   decisionSeed(workerId, gameId) = baseSeed
                                  ^ (workerId * 0x9E3779B9)   // golden-ratio mix
                                  ^ (gameOrdinal * 0x01000193) // FNV prime
   shuffleSeed(workerId, gameId)  = baseSeed
                                  + workerId * 1_000_003
                                  + gameOrdinal * 101
                                  + len(matchupId)
   ```

   该派生方案保证：相同 `(workerId, gameOrdinal, matchupId)` 完全可复现；且 `workerCount=1` 时与原串行实现 seed 一致（向后兼容）。

3. **冷启动开销**：每 worker `getData()` ~1–2s + predictor `fromFile()` ~0.5–1s。短任务（<20 局）并行收益会被冷启抵消，主进程检测 `gamesPerWorker < 5` 时降级为串行（带一行 warning）。

4. **SQLite 多 writer**：每个 worker 独立 `new DataLake(dbPath)`；WAL 模式下读写不互斥但 writer 互斥，事务极短（一局 ~50 条记录 ~5ms）。建议 `PRAGMA wal_autocheckpoint=10000` 避免短时间 checkpoint 雪崩（`data-lake.ts:196-198` 现有 pragma 已足够，不必改动）。

5. **退出时 close 串行**：主进程不持有 DataLake（lake 由 worker 持有），worker 内 `finally { lake?.close() }`，最后一个 worker 退出后由它执行 WAL checkpoint。

### 预期收益

- 4–8 核机器：N 个 worker → **4–6×** 端到端吞吐（线性，扣除冷启 ~10%）
- 5.5 小时（8 核）→ **55–70 分钟**

### 风险

| 风险 | 对策 |
|------|------|
| Worker 间 seed 碰撞 | 见上面 `decisionSeed` 派生公式 |
| 内存上限 | 单 worker 实际 ~300–500MB；8 worker ~3–4GB，需检查机器 |
| 冷启动占比 | `gamesPerWorker < 5` 时降级串行 |
| WAL writer 抢锁 | 事务极短可接受；如观察到 `SQLITE_BUSY` 增加 `PRAGMA busy_timeout=5000` |
| Worker 异常崩溃 | `worker.once("error")` + `worker.once("exit", code≠0)` 视作 fail-fast，已写入 SQLite 的样本保留 |

### 实施工作量

- worker 文件：~80 行
- 主进程 shard / 并发分支：~60 行
- 公共类型 / `playAndRecord` 导出：~20 行
- 测试 + 文档：~30 行
- 约 **4–6 小时**

---

## 方案二：确定性级线程并行（**P2，建议先 profile**）

### v1 设计的硬伤（修订）

1. **`GameState` 不可 structured-clone**：`state.config` / `state.entities[*].definition` / `state.players[*].pile[*].definition` 都引用 `@gi-tcg/data` builder DSL 生成的**函数**（`skillDescription`, `onTrigger` 等）。structured clone 见到 function 直接抛 `DataCloneError`。
2. **闭包不可序列化**：`leafValue` / `opponentDecide` / `selfTailDecide` 都是闭包，必须在 worker 内部重建（即每 worker 加载 ~80MB predictor + 卡牌数据），冷启代价远超 500ms time budget。
3. **同进程 `Promise.all` 无效**：引擎步进是 CPU-bound 纯计算，JS 事件循环单线程，`Promise.all([engineStep1, engineStep2])` 不会得到任何加速。
4. **样本质量声明矛盾**：worker 调度顺序非确定 → `decisionSeed++` 推进顺序变化 → 与 v1 自身"样本数值一致"声明冲突。

### 修订后的真正可行做法

- **持久化 worker pool**（不是短期 spawn）+ `SharedArrayBuffer` 编码引擎可重建的状态摘要（去除函数引用，仅保留状态机 ID + 变量）
- worker 内基于摘要 + 共享只读的 `@gi-tcg/data` 重建 `GameState`
- 工程量 **≥20 小时**，需先证明方案一 + 方案三仍不够再考虑

### 预期收益（修订）

- 含 IPC + structured clone 等价物开销，3–4 worker 上限 **1.5–2×**
- 不与方案一线性叠加：方案一已用满核心，方案二应在 N_cores ≥ 16 且 matchup 数 ≤ N_cores 时考虑

---

## 方案三：神经网络批量推理（**P1，收益修正**）

### v1 的关键错误

v1 估算 "1 + K×|kept_actions|×(leaf + opponent) ≈ 129 次 predict"。实际代码：

```ts
// neural-leaf.ts:89-101 (createNeuralLeafEvaluator)
return (state, who) => {
  const exported = observationFromState(state, who, [])   // ← 空 actions slate
  const out = predictor.predict({ observation: exported.observation })
  return sigmoid(out.v)
}
```

传入 `actions = []` → `predict()` 内 `for (const a of o.candidate_actions)` 循环 **0 次**，advantage head 完全不跑。所以 v1 提出的 `predictVOnly` 快速路径**已经存在**（隐式实现），无可榨取的收益。

### 真正能批量化的点

| 调用点 | 频率 / 决策 | 是否可批量 |
|--------|------------|------------|
| `createNeuralPrior` (neural-leaf.ts:128) | 1 次 / 决策 | 否（单点） |
| `createNeuralLeafEvaluator`（已 V-only） | K × \|kept\| ≈ 16–64 次 | 状态独立 → 难以批合并 |
| `createSameEvaluatorOpponent` (neural-leaf.ts:153) | K × \|kept\| × \|opp_actions\| | **可批量**（同一 rollout 内的多个 opponent 决策） |

但 `runEngineActions` 是 `await`-驱动的串行调用，无法在引擎请求 RPC 前预判会出现多少个 opponent decision。即使用攒批策略（攒满 N 个再 flush），引擎被卡在等待状态，整体不变快。

### 实际可榨取的优化

- **手写 `batchLinear`** 把 K 个独立 state 的 value head 编码合并为矩阵 × 矩阵乘法。在纯 JS 上 cache locality 收益约 **1.3×**（不如 BLAS 的 5–10×）。
- 这部分只占决策时间 ~12% → 端到端 **~3–5%**。

### 实施工作量

- `predictBatch(stateReprs[])` 与 `batchLinear` 内核：~80 行
- 改造 ISMCTS 内层循环先收集状态、再统一调用：~40 行
- 不能与方案一线性叠加（worker 内每 worker 独立调用）
- 约 **6–8 小时**，仅 ~5% 收益，**P1 优先级偏低**

---

## 方案四：异步写入（**降级为方案一内置项**）

### v1 的机制错误

`better-sqlite3` 与 `bun:sqlite` 都是**同步** API（`data-lake.ts:35-58`）。v1 的 `setImmediate(flush)` 只是延后到下一个 macrotask，但 `lake.insertBatch` 内的 `INSERT` 调用仍然阻塞主线程。在 ISMCTS 主循环里，CPU 永远是忙的，event-loop 永远没有 idle，asynchronous 包装零效果。

### 真正可行做法（方案一内置）

写入并行化的**正确实现**就是方案一本身：每个 worker 独立写入同一 SQLite，WAL 模式天然支持 N writer 串行。无需另外的 async queue。

如果未来真要分离：必须 spawn 一个 dedicated writer worker，主 worker 通过 `MessageChannel` 把 `SampleRecord[]` 投过去（结构化克隆成本 ~1ms / 局，可接受）。但当前阶段无须做。

### 收益

- 内置在方案一时：~2–3%（写入与 ISMCTS 计算被天然分摊到多核）
- 单独实现：接近 0

---

## 方案五：状态观测缓存（**已撤销**）

### v1 的致命错误

1. `WeakMap<state.players, ...>` cache key：`randomizeUnknowns` (ismcts.ts:211) 每个 `k` 都返回**全新对象**，`state.players` 也是新数组——cache 命中率 **0%**。
2. v1 §"实际成本" 把 "K × |kept| = 64 次 × 3ms = 192ms" 当作可缓存，但每次 `child.state` 都是不同 rollout 的产物，**无重复状态**。

### 可能的替代设计（仅作记录，未推荐）

- 按 `notificationState` 的**内容哈希**（非引用）做 cache key。但哈希成本与 `StateExporter.export` 同量级，得不偿失。
- 跨决策点的 `SideObservation` 局部缓存：跨决策状态变化大，命中率低。

**结论**：撤销此方案。

---

## 实施路线图（修订）

```
P0（高价值低风险，1 天内）:
  ├─ 方案一：对局级进程并行（含 cfg.seed 强制）  [~5h]
  └─ 方案四：写入随方案一自然并行                 [内置]
  预期：4–6× 端到端加速

P1（中等收益中等复杂度，2 天）:
  └─ 方案三：prior + opponent decide 批量化      [~7h]
  预期：~3–5% 单 worker 加速

P2（高风险，先 profile）:
  └─ 方案二：worker pool + SharedArrayBuffer     [~20h]
  预期：1.5–2×，仅在核心数 ≥ 16 时考虑

合理总加速（P0+P1，8 核机器）：5–7×（而非 v1 宣称的 15–30×）
```

---

## 注意事项

1. **样本等价性**：方案一保证 `pi_MCTS` 与 `z` 在给定 `(workerId, gameOrdinal, matchupId)` 下与 `workerCount=1` 完全一致；前提是 `cfg.seed` 必填。
2. **可逆性**：`--concurrency 1` 走原有串行路径，与历史 self-play 数据完全 schema 兼容。
3. **相容性**：方案一仅依赖 `node:worker_threads`（已在 benchmark 路径验证）；不修改 `@gi-tcg/core` / `@gi-tcg/data` / `@gi-tcg/typings`。
4. **监控建议**：
   - games per second / samples per second（每 worker + 总）
   - 决策点 p50 / p95 / p99
   - SQLite 写延迟（`PRAGMA wal_checkpoint(PASSIVE)` 间隔）
   - Worker 利用率（CPU%）

---

## 附录 A：v1 已知错误对照

| v1 章节 | 错误内容 | 修正 |
|---------|----------|------|
| §方案三 318–319 行 | "1 + 64 + 64 ≈ 129 次 predict" 估算包含 leaf+opponent 的 advantage head | leaf path `actions=[]` 不跑 advantage head；实际 ~1 + 64 = 65 次中只有 1 次跑完整 head |
| §方案三 实施方案 B | 提出 `predictVOnly` 快速路径 | 现状已等价 V-only，无收益 |
| §方案四 实施方案 | `setImmediate(flush)` 异步包装 | SQLite 同步 API，wrapping 无效 |
| §方案五 cache key | `WeakMap<state.players, ...>` | 引用每次都变，命中率 0% |
| §方案二 风险表 | "structured clone 天然隔离" | `GameState` 含函数引用，结构化克隆直接抛错 |
| §方案一 worker 示例 | `import availableParallelism` 漏写 / 模块路径用 `.js` | 需 `node:os` 导入；模块路径必须用 `new URL("./*.ts", import.meta.url)` |
| §注意事项 §1 | "并行不影响 seed 推进顺序" | 仅在 `cfg.seed` 必填 + workerId 偏移时成立 |
