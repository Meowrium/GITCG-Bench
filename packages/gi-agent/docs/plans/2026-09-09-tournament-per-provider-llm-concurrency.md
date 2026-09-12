# 锦标赛 LLM 并发按供应商分桶(已实施,2026-09-09 记录)

> 状态:**已实施(2026-09-09)**。实现口径:`TournamentModel.concurrency` 可选字段 + fail-fast 校验
> （`scripts/ops/tournament-config.ts`）,author/evolve 的池化改为逐模型分桶（`scripts/ops/model-tournament.ts`
> 的 `modelLimitsOf` + `scripts/ops/async-pool.ts` 的 `resolveBucketConcurrency` / `runBucketedPool`）,
> colocated 单测 `scripts/ops/async-pool.test.ts`;缺省回退全局 `llmConcurrency`,旧 config 行为逐一致。
> 相关:[2026-09-05-impl-spec-1-tournament.md](./2026-09-05-impl-spec-1-tournament.md)(WP1 锦标赛管线)。

## 1. 问题

改造前 `model-tournament.ts` 的 LLM 并发是**单一全局池**:`llmConcurrencyOf()`(约 151 行)把
config 的 `llmConcurrency`(缺省 3,钳 1-8)读成一个标量,`authorProducer()`(约 352 行)把
**所有模型的全部起草调用**(single 逐格 + general)收集进同一个 `callTasks` 数组,过同一个
有界工作池。evolve producer 同口径。没有任何按模型/供应商的分桶。

由此两个缺陷:

1. **队头阻塞**:慢供应商(如 deepseek 长推理,单单元 5~30 分钟)先占满全部槽位时,其余模型
   的起草/反思全部排队。smoke-3m 轮实测:pipeline 启动后 3 个槽被 deepseek 12 个单元占满,
   qwen/hy3 的 manifest 要等 deepseek 全部完成才陆续组装——battle 调度器的「生成即赛」
   收益被供应商间速度差部分抵消。
2. **供应商级限速不可表达**:池子只认总数,不认「deepseek 限 3 / qwen 可 10」这类差异,
   限速宽松的供应商吞吐被浪费;反过来对限速严格的供应商也无法单独压低。

## 2. 方案(实施口径)

- `TournamentModel`(`tournament-config.ts`)加**可选** `concurrency` 字段(正整数,钳 1-8);
  缺省回退到全局 `llmConcurrency`,行为与现状完全一致(增量兼容,旧 config 不改)。
- `authorProducer` / evolve producer 的池化处改为**按模型分桶**:每模型一个独立有界池
  (上限 = model.concurrency ?? 全局值),各桶并行 drain;battle 调度器的依赖就绪逻辑不动。
  全局限速第二层总闸**未做**:各桶上限即供应商级限速,慢供应商不再占满全局槽位。
- 校验随 schema 走既有 fail-fast 惯例(列全错误再退出);`status`/失败清单口径不变。
- 单测:分桶纯逻辑(池上限/缺省回退/失败隔离不串桶)colocated 在 `scripts/ops/async-pool.test.ts`;
  旧 config(无 `concurrency` 字段)dry 验证 `status` 正常读入(增量兼容);

## 3. 验收

- 三模型 config 分别设 1/2/3 并发时,日志中各模型在飞单元数不超过各自上限且互不阻塞;
- 不设 `concurrency` 的旧 config 无需改动:每模型上限回退全局 `llmConcurrency`(与旧全局池同参数;
  桶间并行是本设计的预期——不设全局总闸);
- `pnpm exec vitest run` 相关 suite 全绿;smoke 十项不回归。

## 4. 动机证据(2026-09-09 smoke-3m 轮)

- 3 模型(deepseek-v4.1-flash / qwen3.8-flash / hy3)× v4.0 × 3 卡组,`llmConcurrency: 3`;
- pipeline r0 启动后 3 槽全被 deepseek 占满(`single|0-vs-0/0-vs-1/0-vs-2` 同刻开跑),
  battle 调度器持续「暂无就绪批」空转,直至 deepseek+qwen manifest 齐才开跑首批。
