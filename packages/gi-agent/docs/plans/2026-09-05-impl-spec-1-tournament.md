# WP1 实现规格：锦标赛管线（tournament.json + model-tournament.ts + 证据适配器）

> 来源：[impl-spec-0-overview.md](./2026-09-05-impl-spec-0-overview.md)（共享约定与代码锚点索引）。
> 状态：**已实现**（2026-09-05/06：Mock-LLM 全管线冒烟十项验收全过，见
> [../../smoke/ACCEPTANCE.md](../../smoke/ACCEPTANCE.md)；真实模型跑批待 API 凭据环境）。
> 目标文档：[2026-09-05-tournament-execution-plan.md](./2026-09-05-tournament-execution-plan.md) §3/§5/§6。
> 实现位置：`packages/gi-agent/scripts/ops/`（编排脚本 + config 解析）；**不改** plan-oneshot
> 现有 CLI（全部子进程调用复用）。

## 1. 交付物

| # | 件 | 位置 |
|---|---|---|
| 1 | tournament.json schema + 校验 + 示例 | `packages/gi-agent/scripts/ops/tournament-config.ts` + `examples/tournament.example.json` |
| 2 | 编排脚本（八子命令；archive 冷归档 2026-09-06 追加；pipeline 生成即赛 2026-09-05 追加） | `packages/gi-agent/scripts/ops/model-tournament.ts` + `scripts/ops/tournament-scheduler.ts`（调度核心，colocated 单测） |
| 3 | own-generations 证据适配器 | `packages/gi-agent/scripts/ops/tournament-evidence.ts`（被 evolve 调用） |
| 4 | 冒烟验收（§6）通过记录 | 冒烟输出目录 `smoke/ACCEPTANCE.md` |

## 2. tournament.json 契约（含校验规则）

```jsonc
{
  "models": [                        // ≥2；name 唯一；apiKeyEnv 唯一
    { "name": "glm-5.3", "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "model": "glm-5.3", "apiKeyEnv": "GLM_API_KEY" }
  ],
  "environments": [                  // ≥1；label 唯一（形如 v6.3）；gameVersion 必须在 core VERSIONS 内
    { "label": "v6.3", "gameVersion": "v6.3.0",
      "decks": ["<deckCode>", "…×8"] }   // ≥1，唯一
  ],
  "gamesPerCell": 15,                // 正整数；实际批 games = 2×（正反手由 alternateFirstPlayer 均分）
  "rounds": 12,                      // 上限；饱和判定提前停
  "llmConcurrency": 3,               // 可选；author/evolve 的 LLM 单元并发（默认 3，钳 1-8；单元=独立凭据/out/state key，state 落盘互斥串行化）
  "traceSignatures": "lean",         // 可选；battle 批 trace 签名模式（"full"|"lean"，缺省 lean；仅编排层读取——plan:batch CLI 缺省仍 full）。
                                     //   lean = 批配置注入 traceSignatures:"lean"：trace 条目不内嵌整份 stateSignature（改 16 hex
                                     //   短哈希指针 sigHash，trace.ts sigHashOf），单局产物 ~1.87MB → ≤0.45MB；消费侧（reflect/
                                     //   organize-export/eval）经 sig-backfill.ts 从同局 game_state_log.json 反查回填。lean 下
                                     //   game_state_log.json 成为局面摘要的承重墙——跨模型批 gameArchive.stateLogSample<1 会令被
                                     //   抽样删除的局在 reflect/organizer 中降级"(无 state)"（evidence 组装时告警）
  "evidenceScope": "own-generations",// 仅此值合法（唯一实现口径）
  "seedBase": 20260905,
  "outRoot": "output/plan-oneshot/tournament/run-001",
  "gameArchive": { "stateLogSample": 0.1 }  // game-* 目录恒留（R9 证据）；state log 抽样率
}
```

**校验（fail-fast，列全错误再退出）**：上表注释中的唯一性/范围；`gameVersion` 用
`parseGameVersion`（`plan-oneshot/version.ts`）；decks 用 `DEFAULT_ASSETS_MANAGER.decode`
试解码；`apiKeyEnv` 对应进程 env 必须存在（缺失列名，不打印值）。
**禁止**：schema 中出现任何 key 明文；不支持的 `evidenceScope` 值。

## 3. 目录布局（outRoot 下，全部产物幂等可续跑）

```
outRoot/
  tournament.resolved.json        # 展开后的运行时 config（含解析 deck 摘要；无 key）
  plans/<model>/<env>/            # r0 author 产物
    general.di.r0.json            #   di = deck 索引（环境 decks 数组下标）
    single.di-vs-dj.r0.json       #   格树（known_deck=dj）
  portfolios/<model>/<env>/di/    # portfolio manifest（r0 由 author 阶段组装；r≥1 由 reflect 产出）
    portfolio.json  plans/…
  battles/<pair>/<env>/di-vs-dj/  # plan:batch 输出（原样结构）
    summary.json summary.side1.json game-0001/…
  evidence/<model>/<env>/di/r<r>/ # evolve 组装的证据组（见 §5）
  archive/round-<r>/<pair>.tar.gz # 冷代次压缩归档（archive 子命令，§4.6；2026-09-06 追加）
  results/ results.by-model.json results.by-model-deck.json
  ratings/ …（analyze 产物） plots/ …
  state.json                      # 编排状态：各 (pair,env,cell,round) 批完成位图、代完成标记、饱和停点
```

`pair` 目录名 = 两选手 id 字典序拼接（如 `glm-5.3@r1__vs__glm-5.3@r0`；**禁止** p1===p2
选手重名——同模型同代对局不排入赛程）。`state.json` 是续跑真值来源：子命令启动时读，
完成一批置位一批（写盘原子化：临时文件 + rename）。

**battles 生命周期（冷归档，§4.6）**：batches 的 game-\* 明细（plan_trace /
plan_trace.side1 / game_state_log，lean 单局 ≈0.4MB、每代 ~40GB）只被 own-generations
证据组装（§5，闸控）消费；export/analyze 只读 summary。第 r 代在其消费方（r+1 的
evolve）全部完成后即**冷**，`archive` 子命令将冷 pair 的 game-\* 打包进
`archive/round-<r>/<pair>.tar.gz` 并删除原 game-\* 目录（批级 JSON 恒保留、
state 位图不变）。恢复口径：`tar -xzf <tarball> -C battles/<pair>`。

## 4. 子命令规格

### 4.1 `author`（r0；唯一大 LLM 阶段）

对每 model × env × 本方 deck di（portfolio 维度，共 M×ΣD_e 个）：

1. **single 逐格**：对每个对手 deck dj（含 dj=di 镜像格）调
   `pnpm run plan:author -- --deck <di> --opponent-deck <dj> --game-version <env版本>
   --out plans/<model>/<env>/single.di-vs-dj.r0.json --seed <S> --model <model.id>`；
2. **general**：调 `--deck <di> --opponent-set <env decks 文件> --game-version <env版本>
   --out plans/<model>/<env>/general.di.r0.json`（先例：
   `scripts/ops/author-portfolio-singles.ts`——直接复用该 wrapper 的调用形态）；
3. **manifest 组装**：按 09-02 D5/G8 写 `portfolios/<model>/<env>/di/portfolio.json`
   （generalPlan 指向 general、singles[] label=dj 绑定 deckCode；用
   `loadPortfolioWithValidation` 自校验一次）。

**env 注入**：子进程 env = `{...process.env, OPENAI_API_KEY: process.env[apiKeyEnv],
OPENAI_BASE_URL: model.baseUrl, OPENAI_MODEL: model.model}`。**失败隔离**：单次失败
重试 2 次（间隔 5s）后记录 `state.json.failures` 并继续；`author` 结束时若任一失败，
exit code 1 并打印失败清单（可重跑只补缺）。
**seed 派生**：`S = seedBase + hash(model,env,di,dj) % 100000`（确定性，可复现）。

### 4.2 `evolve`（r ≥ 1；每 portfolio 一次 reflect）

对每 model × env × di，取该 model **上一轮全部对局**（own-generations：r-1 轮的
跨模型批 + 链批中，X 持 di 的所有 cell——X 为 plan 侧与 opponent 侧双向），
经 §5 适配器组装为证据组目录 `evidence/<model>/<env>/di/r<r>/`，然后调：

```
pnpm run plan:reflect -- --run-dir <组1>,<组2>,…,--side 0 \
  --portfolio portfolios/<model>/<env>/di/portfolio.json --round <r> \
  --evidence engine-only --patch --out portfolios/<model>/<env>/di/
```

（`--seed/--temperature` 亦按确定性派生；reflect 失败重试 1 次后隔离记录。）
完成后当代格树 = `portfolios/…/plans/single.<label>.r<r>.json`——供 battle 取用。

### 4.3 `battle`（引擎批跑，零 LLM）

枚举赛程（只排缺批，幂等）：

- **r0**：对每 env、每模型对 (X,Y)（含 X≠Y 全组合 C(M,2)×E）、每格对 (di,dj)
  （含 di=dj 镜像与双向交叉）：X 持 di 用 `single.di-vs-dj@r0`、Y 持 dj 用
  `single.dj-vs-di@r0`；plan = X 的树、opponent = Y 的树；批 games = 2×gamesPerCell、
  `alternateFirstPlayer: true`；`config.gameVersion` = 环境版本；seed =
  `seedBase + hash(pair,env,di,dj,round)`。**归档策略**：game-\* 目录恒留；
  `game_state_log.json` 按抽样率写（批跑后置删除或调用侧关闭 captureReplay 再补抽样局
  ——实现选其一，冒烟时记录单局体积后定）。
- **r ≥ 1**：同代跨模型批（同上，双树取 r 代）+ 同模型链批（X@r 持 di vs X@(r-1) 持 dj，
  共 M×ΣD_e² 批/代）。
- 断言（fail-fast）：两侧树 `context.gameVersion` = 环境版本；`known_deck` 与
  `opponentDeckCode` 一致（`runPlanBatch` 内建 assertOpponentAlignment 自动生效）。
- **并行**：批间进程池（`config.concurrency`，默认 4，对齐设备核数）；批内引擎并发恒 1
  （引擎在单 node 进程内单线程，批内 >1 只重叠 I/O 不加速 CPU——冒烟实测批内 4 并发
  wall≈引擎串行时间）。
- **trace 签名 lean 化（2026-09-05 件 1）**：batchConfig 注入
  `traceSignatures: config.traceSignatures ?? "lean"`——lean 下 plan_trace.json /
  plan_trace.side1.json 条目不内嵌整份 stateSignature（改 sigHash 短哈希指针），与
  **本局 game_state_log.json 互为底座**：state log 是 lean trace 签名的唯一反查来源，
  证据适配器（§5）拷 trace 时必须同拷 state log（源批被抽样删除则告警降级，见 §5）；
  `traceSignatures: "full"` 恢复内嵌整份签名（与旧产物逐字节同形态，plan:batch CLI
  缺省即 full）。

### 4.4 `export`

读全部 battles 的 `summary.json`/`summary.side1.json` perGame，产两份 results：

- `results.by-model.json`：`{p1: <modelA>@r<a>, p2: <modelB>@r<b>, winner: "p1"|"p2"|"draw", period: r}`；
- `results.by-model-deck.json`：`p1 = <model>@<env>/<di>@r<a>`（卡组级）；
- **winner 映射**（关键）：引擎 `0→"p1"`、`1→"p2"`、`null→"draw"`（tree-bench
  `parseGameResult` 对其他值 fail-fast）；`planSide` 与 p1/p2 的换算按 perGame 语义
  （plan 侧 = p1；`plan_side` 字段标注 plan 侧坐哪位，winner 是玩家位 0|1）。
- 派生 `mirror-only` 变体文件（同一批对局过滤 di=dj）。

### 4.5 `analyze` / `status`

- `analyze`：逐 results 文件调 tree-bench `pnpm analyze --input … --out ratings/<视角>/`
  （子进程或 import 均可）；再调 `plots/plot_*.py`（WP3 交付）产 `plots/*.png`。
- `status`：读 `state.json` 打印完成位图、失败清单、建议的下一步子命令；并显示
  `archive/round-*/` 下已归档 pair tarball 计数（2026-09-06 追加）。

### 4.6 `archive`（冷代次压缩归档；2026-09-06 追加，核心在 tournament-archive.ts）

`model-tournament.ts <config> archive --through <N> [--include-chain] [--dry-run]`。
把 r ≤ N 的冷 pair 的 game-\* 明细打包 `archive/round-<r>/<pairName>.tar.gz` 并删除原
game-\* 目录（批级 JSON 恒保留），为正赛多代跑批控制磁盘占用（每代 ~40GB → 9 代热数据
冷归档后 ~60-80GB）。判定与安全纪律：

- **粒度**：pair 级一个 tarball（`tar -czf <tarball>.pack -C battles/<pair> .`，打包其下
  全部 env/cell/game-\* 与批级 JSON；pack 临时名校验通过后 rename 为正式名——正式
  tarball 即 marker，存在 ⇒ 必然通过过校验）。pair 的代数取 BatchSpec（不从目录名反解）；
  pair 内所有 cell 同代，天然 pair 级冷度。
- **冷判定（全过才归档）**：round ≤ N；跨模型 pair（!isChain）全部批 battle done；
  pair 内每个 on-disk cell 都在赛程内（赛程外 cell → 整 pair 跳过）；链批 pair 默认保留
  （ownChain=keep：链批 state log organizer 试点要用），`--include-chain` 才归档。
- **安全闸（上游 evolve 未 done → 跳过，计入"未归档（上游未完成）"）**：第 r 代 games
  被 own-generations 证据双向消费——X@r 持 di 的批（plan 侧 X@r__vs__\* 与 opponent 侧
  \*__vs__X@r）喂 evolve r+1；链批 X@r__vs__X@(r-1) 的同批 games 双向都收（X@r 持 di 喂
  evolve r+1，X@(r-1) 持 dj 的 side1 视角喂 evolve r）。故逐批检查：
  `evolve|<planModel>|<env>|<di>|r<r+1>`（r+1 ≤ rounds 时）、跨模型另查
  `evolve|<oppModel>|<env>|<dj>|r<r+1>`、链批另查 `evolve|<oppModel>|<env>|<dj>|r<r>`。
  末代（r == rounds）无 +1 闸。
- **删除安全**：打包后 `tar -tzf` 条目与打包前逐文件清点做集合相等校验，不一致即删 .pack
  并 fail-fast（退出码非 0，不删任何原目录）；删除只删 cell 下 game-NNNN 目录。tarball
  已存在（崩溃恢复）→ 校验现存 game 明细 ⊆ tarball 条目后补删剩余；任何校验不过即中止。
- **不改 state.json**：battle done 位图不变 → battle 重跑对已归档批 isDone 跳过不会重跑
  （无 game 缺失冲突）；export 重跑只读 summary 无冲突；重跑 archive 幂等（已归档 pair
  报 no-games / 仅补删）。status 追加显示已归档 pair 计数。
- **evidence 交互（硬链接）**：§5 的三级 fallback 下，hardlink / copyFile 的 evidence 组
  不受归档影响（删 battles 原文件后数据仍被组内链接持有，tarball 内容亦完整）；**symlink**
  （绝对路径指向 battles 原文件）会被删除打断 → 归档前扫描 evidence 全树符号链接，凡指向
  候选 pair 的整 pair 跳过并如实报告（不静默物化）。evidence.fingerprint.json 只记批级
  relDir（summary 恒保留）→ 指纹复核仍一致；若组目录被删需重建，须先按恢复口径 tar 恢复。
- **恢复口径**：`tar -xzf <outRoot>/archive/round-<r>/<pairName>.tar.gz
  -C <outRoot>/battles/<pairName>`（打包含 pair 下全部文件原样）。plan:organize-export /
  plan:eval 等用户指路工具若要读已归档批目录，需先恢复。

### 4.7 `pipeline`（「生成即赛」；2026-09-05 追加）

`model-tournament.ts <config> pipeline [--round <N>]`：LLM 生成决策树（producer）的同时，
引擎对局调度循环持续把「依赖已就绪」的对局批跑掉，消除 author/evolve 阶段的引擎空转。
核心在 `scripts/ops/tournament-scheduler.ts`（纯逻辑分区 + 副作用全注入的调度核心，
colocated 单测 `tournament-scheduler.test.ts`）。

- **代次判定**：无 `--round` 时自动判定最小未完成代——存在未 done 的 r0 battle 批 → r0；
  否则最小 r 使该代有 evolve 或 battle 未 done；全部完成 → 提示无事可做并 exit 0。
  显式 `--round <N>` 则直接以 N 为目标代（超出 `config.rounds` fail-fast）。
- **并发结构**：`Promise.all([producer, battleScheduler(round, producerDone)])`——r0 的
  producer = `authorProducer`（author 子命令的工件部分），r≥1 = `evolveProducer`（限定
  roundFilter=r）。两代之间仍严格串行（own-generations：evolve r+1 消费 r 的全部对局），
  单次 pipeline 只推进一代，多代由多次调用衔接。
- **author 重构（对 `author` 子命令同样生效，语义兼容）**：manifest 组装从「阶段 B 集中
  做」改为「该 (model, env, di) 的 D+1 个调用（D single + 1 general）全部结束即组装」
  （per-di 计数器 + 延迟 Promise，producer 末尾 await 全部）。调用失败的 di 在 producer
  收尾时仍尝试组装并如实记录「计划缺失（或损坏）」失败（凭据失败模型无任何调用，由
  收尾兜底触发）——`author` 单独跑的最终状态不变：所有 manifest 要么 done 要么
  recorded failure。
- **调度语义**（`runBattleScheduler`）：扫描该 round 全部 BatchSpec → 分区
  done（位图命中）/ attempted（本 invocation 已派发，含失败——不重试，与 `battle`
  单遍语义一致）/ ready（manifest + 对手格树文件均存在）/ not-ready；ready 批进
  `battleConcurrency`（默认 4）进程池跑单批（`runBattleBatch`：版本钉扎断言、
  batchConfig 写盘、plan:batch 子进程、失败隔离、state log 抽样归档——与 `battle`
  子命令共用同一函数）；无 ready 且 producer 未结束 → 等待唤醒或 10s 重扫兜底。
  producer `markDone` 后经 `ctx.wakeScheduler` 事件驱动唤醒（信号丢失最坏退化为
  10s 轮询，不影响正确性）；producer 结束（含 reject）立即唤醒做最终 drain。
- **终止条件与失败语义**：producer 结束 + 无在飞批 + 本扫描无新派发 → 终态 drain：
  把仍就绪的批跑完后，对仍 not-ready 的批逐个 `recordFailure(key, "battle",
  "依赖未就绪（上游 author/evolve 失败或未生成）：缺 <具体缺口>")`。recordFailure 只写
  `state.json.failures`、**不写 done 位图**——后续 invocation（重跑 `pipeline` / `battle`）
  对这些批照常重试，不阻塞补缺。末尾对本次涉及的全部失败（author/evolve/battle）按
  `finishWithFailureCheck` 语义汇总并 exit 1（重跑补缺成功后失败清单不残留）。
- **前置校验（r≥1）**：第 r-1 代必须全部 battle done（evolve r 的 own-generations 证据
  依赖上一代全量对局），否则报错退出并提示先跑 `pipeline` / `battle --round <r-1>` 补齐。
- **资源预算**：LLM 单元（`llmConcurrency`，默认 3）是网络等待型、battle 批进程
  （`concurrency`，默认 4）是 CPU 型，二者天然互补，无需联动节流。
- **不自动跑 export/analyze**：饱和判定是人肉环节，保持既有纪律。
- **与 archive 兼容**：pipeline 只经由 state.json 位图判定批完成，归档过 game 明细的批
  `isDone` 跳过不受影响（批级 summary/config 恒保留；同 §4.6「不改 state.json」）。
- **单批执行函数化**：`runBattleBatch` 从 `battle` 子命令抽出共用；`battleKey` 移入
  `tournament-scheduler.ts`（与 `tournament-archive.battleKeyOf` 逐字符同格式，单测锚定）。

## 5. own-generations 证据适配器（tournament-evidence.ts）

**输入**：battles 下 X 持 di 的全部 cell 目录（r-1 轮）+ X 的 portfolio manifest。
**输出**：reflect 可读的证据组目录（每组 = 一个对手 deck dj 的一个目录）：

```
evidence/<X>/<env>/di/r<r>/
  vs-dj/                          # 一组（= reflect --run-dir 的一个目录）
    plan.side0.json               # = X 的当代 portfolio 的 general 计划
    portfolio.side0.json          # manifest + 解析后 planId 清单 + 本组 routing（X 为 side0）
    summary.json                  # X 视角汇总（见下）
    game-NNNN/plan_trace.json     # X 视角 trace
    game-NNNN/plan_trace.side1.json  # 对手视角 trace（可选，有则拷）
    game-NNNN/game_state_log.json    # 抽样命中才拷
```

**视角翻转规则**：cell 批中 X 为 plan 侧 → `plan_trace.json`/`summary.json` 即 X 视角，
直接拷贝；X 为 opponent 侧 → 拷 `plan_trace.side1.json` → 输出为 `plan_trace.json`，
`summary.side1.json` → 输出为 `summary.json`（两者本就是对手侧口径，无需重算）。
**契约参考**：实现前先检视 `examples/plans/roundP1-portfolio/` 的 run 目录结构与
`run-plan-reflect.ts:335-407` 组装载逻辑，输出必须与其逐字段兼容；不兼容处（如
batch 不写 portfolio.side0.json）由适配器补写。**断言**：组装后对每组跑
`loadPortfolioWithValidation` + portfolioId 一致性检查，失败 fail-fast。
**幂等**：原样复制走三级 fallback（symlink → hardlink `fs.link` 同卷免特权 → copyFile；
**仅字节原样复制允许 link**——视角翻转拷贝内容被改写，恒走真拷贝；组内文件组装后
只读、重Build 走 rm+重建、battle 侧事后删除 state log 只摘源目录项，硬链接副本内容
不受影响），已存在且校验通过则跳过。
**lean trace（2026-09-05 件 1/件 2 交叉点）**：lean trace 的签名反查依赖同局
game_state_log.json——源批缺失（跨模型批 state log 抽样删除）时如实 console.warn，
该局 reflect/organizer 局面摘要降级"(无 state)"；要全量保真请在 tournament.json 设
`gameArchive.stateLogSample: 1`（链批恒全量归档不受影响）。

## 6. 冒烟验收（阶段 1，全部通过才算 WP1 完成）

配置：M=4 provisional × E=1（v6.3）× D=2（该环境 usageRate top-2）× r0+r1 × 每格 15 局。

| # | 验收项 | 通过判据 |
|---|---|---|
| 1 | author 逐模型 env 注入 | 4 模型产出 4 套互不相同的树；`plan.author` 字段 = 模型名 |
| 2 | 失败隔离 | 人为设 1 个无效 apiKeyEnv 的模型：author 完成其余 3 家、state.json 记失败、exit 1 |
| 3 | 版本钉扎 | 树 `context.gameVersion` = v6.3.0；手工把一批配成 v5.8.0 → fail-fast 报错含两版本名 |
| 4 | battle 幂等 | 中断（Ctrl-C）后重跑 `battle` 只补缺批；正反手 perGame `plan_side` 恰各半 |
| 5 | evolve 组装 | 证据组过 loadPortfolioWithValidation；X 为 opponent 侧的 cell 视角翻转正确（抽 1 局比对 trace 首条 chosen 动作与胜方归属） |
| 6 | reflect 生效 | r1 产出 `single.<label>.r1.json` 且至少一个 label 的规则集 ≠ r0（singles 层被修订）；general 或有或无修订均可 |
| 7 | export 映射 | results 中 winner 仅取三值；构造/找到平局样本验证计 0.5；period 正确；p1≠p2 恒成立 |
| 8 | analyze+plot | ratings*.json + 五 PNG 产出（WP3 就绪前可先验 ratings JSON）；无对局格在热图中非 0.5 渲染 |
| 9 | 定标 | 记录 局/秒 与单局目录体积（含/不含 state log）写 `smoke/ACCEPTANCE.md`，回填执行方案 §7 |
| 10 | 干净续跑 | `status` 报告全绿；重复执行任一子命令为 no-op |

**附**：`pnpm test`（gi-agent 包）全绿（现有测试不得回归）。

## 7. 明确不做

不做 own-chain 口径代码分支（唯一口径 own-generations）；不做赛程锚点矩阵；不做
候选池/选择器（A 案挂起）；不改 plan-oneshot CLI 内部逻辑；不做 k 次起草选优；
不做 NN 相关任何接线。
