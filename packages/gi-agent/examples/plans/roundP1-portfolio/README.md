# roundP1-portfolio — 两层 portfolio 代际循环示例

> 本目录是 **G9（编排/CLI/存储）** 的约定样板：`portfolio-generation.example.json` 是
> orchestrator（`scripts/ops/portfolio-generation.ts`）的 config 实例；本 README 说明
> 存储约定与手工复现步骤。示例**不真跑**（对手 planFile 指向仓库内签入的真实
> GamePlanV1 计划，见下"对手计划说明"）。

## 存储约定（§5，G9-3）

```
output/portfolio-p1/                    # portfolioDir：manifest 与 plans/ 所在
├── portfolio.json                      # PlanPortfolioV1 manifest（D5）
├── portfolio.base.r<N>.json            # 消融用 base 快照（反思前 r<N-1> 代，消融开启时）
├── opponent-set.txt                    # General 起草的 --opponent-set（evidence[].deckCode 换行）
├── reflect.reflection.json             # 反思 sidecar（portfolio 模式落 portfolioDir 根部）
├── reflect.prompt.txt                  # 反思 prompt（engine-only 机检用）
└── plans/
    ├── general.r0.json                 # General 层第 N 代树（unknown_deck）
    └── single.<label>.r0.json          # Single 层第 N 代树（known_deck，绑定 evidence[].deckCode）

output/plan-bench/                      # runRoot：run 目录根
├── configs/                            # orchestrator 生成的批跑 config（可复核/重跑）
├── r<N>-evidence-vs-<label>/           # 证据组（进反思 --run-dir；opponent 必须 plan 型）
│   ├── portfolio.side0.json            #   组合快照（manifest + portfolioId + routing）
│   ├── plan.side0.json                 #   general 计划（旧工具链可读）
│   ├── plan.side1.json                 #   对手计划（plan 型对手归档，消融依赖）
│   ├── summary.json / game-*/          #   批跑产物
├── metric-r<N>/                        # 度量对局（不进反思；固定 seed 梯跨代可比）
└── heldout-r<N>-<label>/               # held-out 泛化批次（不进反思；无 single → general-only）
```

轮次命名沿用 roundS 系列（`examples/plans/roundS1-selfevo` 起）：证据组 `r<N-1>-evidence-vs-<label>`（用 r<N-1> 代组合树打证据 → 反思产出 r<N>），度量/held-out 用 `metric-r<N>` / `heldout-r<N>-<label>`（度量第 N 代树）。

## 对手计划说明

`evidence[].opponentPlanFile` / `metric.opponentPlanFile` / `heldout[].opponentPlanFile`
是 **plan 型对手**（批跑 config `opponent: {"type":"plan"}`），要求是真实存在的
GamePlanV1 计划文件——其 `context.deckCode` 即对手牌表（缺省对手码的推导来源；
`opponentDeckCode` 显式给出时以显式值为准）。本示例选用的签入文件：

| 对手 label | opponentPlanFile | 说明 |
|---|---|---|
| hongniu | `examples/plans/example-plan.json` | 仓库签入的示例计划（6 规则，known_deck） |
| leihe | `src/runtime/plan-oneshot/prompts/examples/fewshot-plan.json` | fewshot 示例计划（known_deck） |
| moyou（held-out） | `examples/plans/example-plan.json` | 复用示例计划；`deckCode` 显式指定为非 singles 覆盖的牌表（APBw4CAO…）→ 路由退化到 general-only |

> 真实运行请替换为各对手自己的 ctrl 计划（如 roundS 系列用的
> `output/plan-oneshot/round22-g53f/plans/*.ctrl.r0.json`，位于 gitignored `output/`，
> 本 clean 仓库不包含）。held-out 对手的 `deckCode` **必须不在 singles 覆盖集合内**，
> 否则会被路由到某棵 Single 树，就测不到"无 Single 覆盖时 General-only 的表现"。

## 方式 A：orchestrator（G9-2）

```bash
cd packages/gi-agent
# 先看将执行的命令序列（不执行、不写盘）
pnpm exec gnx scripts/ops/portfolio-generation.ts examples/plans/roundP1-portfolio/portfolio-generation.example.json --dry-run
# 正式运行（需 .env 的 OPENAI_*，起草与反思各代调 LLM）
pnpm exec gnx scripts/ops/portfolio-generation.ts examples/plans/roundP1-portfolio/portfolio-generation.example.json
```

orchestrator 每代循环（round r = 1..rounds）编排：

1. 证据批跑：逐 evidence 对手 `plan:batch`（portfolio 键 + plan 型对手），outDir `r<r-1>-evidence-vs-<label>`；
2. 反思：`plan:reflect --portfolio <portfolioDir>/portfolio.json --round <r> --side 0 --evidence engine-only --run-dir <证据组> --out <portfolioDir>` → `plans/general.r<r>.json` + `plans/single.<label>.r<r>.json` + 更新 `portfolio.json`；
3. 度量/held-out 批跑（**不进**反思 --run-dir）：`metric-r<r>` / `heldout-r<r>-<label>`；
4. （可选）消融：`skipAblate=false` 时 `plan:ablate` portfolio 模式。

seed 约定：evidence `seedBase + (r-1)*1000 + i*10`；metric `seedBase + 5000`（每代相同 → 同 seed 梯跨代可比）；heldout `seedBase + 6000 + i*10`（每代相同）。全部确定性可复现。

## 游戏版本钉扎（gameVersion，V2）

config 可选键 `"gameVersion": "v6.6.0"`（缺省 = CURRENT_VERSION，须为 core `VERSIONS` 白名单内的版本串，非法值启动报错）。显式指定后全链路同版本钉扎：

1. **r0 起草**：全部 `plan:author` 调用（singles + general）追加 `--game-version <v>` —— prompt 卡面文本按该版本（versioned AssetsManager），产物写 `context.gameVersion`（进 planId/portfolioId 内容哈希，跨版本产物自动区分）；
2. **每代 plan:batch**：生成的 config 带 `gameVersion` 键 —— 对局数据与开局机制行为（versionBehavior）按该版本，state log `gv` / plan_trace / summary 三处一致落盘；
3. **plan:reflect / plan:ablate**：无需版本参数 —— 从 manifest 各层共同版本（V0/V1 校验保证一致）推导，证据组 run 目录版本自动断言（错配中断，`--force` 放行）。

版本解析优先级（plan:batch 侧）：config `gameVersion` ?? plan `context.gameVersion` ?? CURRENT_VERSION；两个显式来源冲突默认 fail-fast，`--force` / config `force: true` 放行（降级 warning）。详见 `docs/plans/2026-09-02-game-version-pinning.md`。

## 方式 B：手工逐步 CLI（不依赖 orchestrator）

```bash
cd packages/gi-agent
# 1) r0 起草：Single 层逐对手 + General 层（--opponent-set 强制 unknown_deck）
pnpm exec gnx scripts/ops/author-portfolio-singles.ts <wrapper-config.json>   # 或逐个：
pnpm run plan:author -- --deck <己方码> --opponent-deck <hongniu码> --out output/portfolio-p1/plans/single.hongniu.r0.json
pnpm run plan:author -- --deck <己方码> --opponent-deck <leihe码>   --out output/portfolio-p1/plans/single.leihe.r0.json
pnpm run plan:author -- --deck <己方码> --opponent-set output/portfolio-p1/opponent-set.txt --out output/portfolio-p1/plans/general.r0.json
# 2) 写 portfolio.json（PlanPortfolioV1：generalPlan + singles[{opponentDeckCode,label,planRef}]）
# 3) 证据批跑（每个对手一份 config，portfolio 键 + opponent plan 型）
pnpm run plan:batch -- output/plan-bench/configs/r0-evidence-vs-hongniu.json
# 4) 反思 → r1
pnpm run plan:reflect -- --portfolio output/portfolio-p1/portfolio.json --round 1 --side 0 --evidence engine-only \
  --run-dir output/plan-bench/r0-evidence-vs-hongniu,output/plan-bench/r0-evidence-vs-leihe --out output/portfolio-p1
# 5) 度量/held-out（不进反思）
pnpm run plan:batch -- output/plan-bench/configs/metric-r1.json
pnpm run plan:batch -- output/plan-bench/configs/heldout-r1-moyou.json
# 6) 重复 3-5 直至目标代
```

## 与 roundS 系列的差别

- roundS1-S8 = 每代**一棵树**在多对手上收证据；本示例 = **两层 portfolio**（general + 每对手一棵 single），反思按 D6 层路由修订。
- roundS 的批跑 config 用 `planFile`（单树）；本示例全部用 `portfolio` 键（两层组合，与 `planFile` 互斥）。
- 证据/度量/held-out 三种对局角色与 roundS 同义（见 `docs/plans/2026-09-02-two-layer-portfolio.md` §3 衔接）。
