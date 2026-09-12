# 游戏版本钉扎（game version pinning）：正式设计

> 日期：2026-09-02。状态：**设计定稿 + 已实现**（V0 执行链 → V1 起草/校验/反思消费 → V2 编排贯通）。
> 关联：`docs/plans/2026-09-02-two-layer-portfolio.md`（两层 portfolio；本文档在其设施之上增量）。
> 共享工具：`src/runtime/plan-oneshot/version.ts`（parseGameVersion / resolveDeclaredPlanVersion /
> checkRunDirVersions / assetsManagerForVersion / applyAuthorGameVersion，纯函数可单测）。

## 1. 目标

plan-oneshot 全链路（起草 → 批跑 → 反思 → 消融 → 回算 → 编排）支持**选定游戏版本**：
对局数据、开局机制行为、prompt 卡面文本、计划词表校验全部同源钉住；版本错配默认
fail-fast（`--force` / config `force: true` 放行并降级 warning）。动机：one-shot 计划的
数值断言（HP/伤害/费用）按特定版本卡面起草，跨版本执行会系统性失真；NN 强基线
（闭源 checkpoint）只有 v6.3.0 词表。

## 2. 机制背景：两条独立通道

| 通道 | 位置 | 说明 |
|---|---|---|
| **数据** | `@gi-tcg/data` 默认导出 `getData(version?)`（缺省 CURRENT_VERSION） | 版本差异 = **定义级覆盖**：`data/src/old_versions/vX.Y.Z.ts` 用 builder `.until("vX.Y.Z")` 重定义整张卡（HP/技能/费用/集合）；后加卡用 `.since("vX")` 标记（无标记 = 全版本可用） |
| **机制** | `core/src/base/state.ts` 的 `VersionBehavior` | 4 个机制开关随版本变（`defaultRecreateBehavior` v3.5.0、`foodOmitInjuredOnly`/`disposeMaxCostHandsAbortPreview` v6.1.0、`diceCostApplyAttachments` v6.4.0）——机制**不是**引擎版本无关的 |

开局生效：`CreateInitialStateConfig.versionBehavior?: VersionBehavior | Version`（字符串自动转），
数据直接进 `state.data`；两通道必须**同源钉住**（数据版本 = 机制行为版本），否则旧数据
跑新机制（V0 之前的状态）。版本白名单：core 硬编码 `VERSIONS`（v3.3.0…v6.6.0），
`CURRENT_VERSION = "v6.6.0"`（IS_BETA=false）。

## 3. assets 静态素材 API 的版本支持（实测结论，2026-09-02）

- URL 形态 `{endpoint}/datum/{version}/{lang}/{id}`；endpoint 默认
  `https://static-data.piovium.org/api/v4`；`new AssetsManager({ version: "v6.3.0" })`
  直接可用（构造参数 `version` 接受任意版本串，缺省 `IS_BETA ? "beta" : "latest"`）。
- 实测（爱可菲 id=1115，v6.3.0 后 HP 11→10 被削）：
  - `GET /datum/v6.3.0/CHS/1115` → HTTP 200，`hp: 11`（与 `data/src/old_versions/v6.3.0.ts`
    的 `.until("v6.3.0") health(11)` 一致）；
  - `GET /datum/latest/CHS/1115` → HTTP 200，`hp: 10`；
  - `GET /datum/v9.9.9/CHS/1115` → HTTP 500（服务端按版本目录存数据，未知版本 ENOENT）。
- `@gi-tcg/data` 源码的卡面文本只在 JSDoc 注释（`@name`/描述），无运行时文本 API——
  **author 的 prompt 卡面文本必须走 assets API**，这正是 author 版本化用 versioned
  AssetsManager 的原因。
- deck 分享码 decode 与版本无关（静态映射），`DEFAULT_ASSETS_MANAGER.decode` 无需版本化。

## 4. 版本解析真值表（plan:batch；`resolveBatchGameVersion`）

解析序：**config.gameVersion ?? plan.context.gameVersion ?? CURRENT_VERSION**；
portfolio 模式的 plan 来源 = 各层共同版本（`portfolio.commonGameVersion`，V0 校验注入）。

| config | plan/portfolio 声明 | nn | force | 结果 |
|---|---|---|---|---|
| — | — | — | — | CURRENT_VERSION |
| X | — | — | — | X（plan 未声明不算错配） |
| — | X | — | — | X |
| X | X（相同） | — | — | X |
| X | Y≠X | — | 否 | **抛错中断**（错配 fail-fast） |
| X | Y≠X | — | 是 | X + warning（以 config 为准） |
| X≠v6.3.0 | 任意 | 是 | 否 | **抛错**（NN 词表锁定 v6.3.0） |
| X≠v6.3.0 | 任意 | 是 | 是 | **v6.3.0** + warning（NN 无法用其他词表，实际仍强制） |
| 任意 | 任意 | 是 | — | v6.3.0（忽略 plan 声明） |

author 侧（`--game-version <v>`）：core `VERSIONS` 封闭校验（非法 → 启动报错并列出可用
版本）；显式传了才写 `context.gameVersion`（缺省不写 = 未钉版本，保持旧产物形态；
LLM 幻觉值一律剥离——必须 `delete` 而非赋 `undefined`，否则 planId 的 stableStringify
会把 undefined 键序列化进去，与落盘 JSON 不一致破坏 planId 自洽）。

## 5. 错配防线清单（V0-V2 各点）

| # | 环节 | 防线 | 位置 |
|---|---|---|---|
| 1 | plan:batch 装载 | 计划声明版本 → 用该版本数据做**存在性校验**（旧版本没有的角色/卡 → 校验失败；如 `.since("v6.5.0")` 的 313010 在 v6.3.0 不存在）；版本串不在 VERSIONS → 抛错 | `loadPlanWithValidation`（batch-runner.ts）、portfolio `loadPlanChecked`、plan:validate CLI |
| 2 | plan:batch 解析 | §4 真值表（错配中断 / nn 锁定 / force 降级） | `resolveBatchGameVersion` + cli/run-plan-batch.ts（config `gameVersion`/`force` 键 + `--force`） |
| 3 | portfolio 装载 | 各层 `context.gameVersion` 一致性：全未声明 → 放行 + warning；混合/互异 → 硬错误（force 降级）；共同版本注入 `commonGameVersion` | `loadPortfolioWithValidation` |
| 4 | 对局执行 | 数据版本与机制行为同源：开局 `versionBehavior` = state log `gv` 标签 = trace.gameVersion = summary.gameVersion = 实际 getData 版本 | sandbox/runner.ts（可选参数向后兼容）+ batch-runner runOne 调用点 |
| 5 | plan:eval 回算 | trace.gameVersion 存在且与 state log gv 不一致 → warning（以 gv 为准回算，不中断） | evaluation/plan-eval/eval-game.ts |
| 6 | plan:reflect | 版本 = portfolio 共同版本 ?? 计划声明 ?? CURRENT；证据 run 目录 summary 的 gameVersion **断言**：未标注（旧产物）→ warning；错配 → 中断；`--force` 降级。静态求值/回放（plan_simulate、verifyPatchAssertions 等注入点）全经 `ensureGameData` 按该版本取数 | cli/run-plan-reflect.ts |
| 7 | plan:ablate | legacy：版本 = 被修订计划声明 ?? CURRENT，base/opponent 声明不一致 → 中断（force 降级）；portfolio：base 与 revised 两 manifest 共同版本必须一致（含"一方声明一方未声明"）；基线/证据组 run 目录版本断言同 6 | cli/run-plan-ablate.ts |
| 8 | author 校验 | 显式 `--game-version` 时校验上下文附带该版本 GameData——LLM 引用该版本不存在的卡/角色在修复循环里被拦下 | cli/run-plan-author.ts |
| 9 | orchestrator | config `gameVersion` 封闭校验；r0 起草全部 author 调用带 `--game-version`；每代 plan:batch config 带 `gameVersion` 键；reflect/ablate 无需版本参数（从 manifest 推导） | scripts/ops/portfolio-generation.ts |

## 6. CLI 参数一览（版本相关增量）

| CLI | 参数 | 语义 |
|---|---|---|
| `plan:author` | `--game-version <v>` | prompt 卡面按该版本（versioned AssetsManager）；产物写 `context.gameVersion`；缺省 latest 且不写（旧产物形态） |
| `plan:batch` | config `gameVersion` / `force` 键 + `--force` | §4 解析序；错配 fail-fast |
| `plan:reflect` | `--force` | run 目录版本断言失败降级 warning |
| `plan:ablate` | `--force` | 同上 + base/revised manifest 版本一致性降级 |
| `plan:validate` | （自动） | 声明版本 → 按该版本数据做存在性校验 |
| orchestrator | config `gameVersion` | 全链路贯通（§5-9） |

## 7. 已知限制

1. **assets "latest" 与 CURRENT 可能差一个小版本**：assets 服务端的 `latest` 目录与
   data 包 `CURRENT_VERSION` 的同步由上游维护，author 缺省（不传 `--game-version`）
   仍用 latest——两者可能有一个小版本的偏移；要严格一致请显式传 `--game-version`。
2. **author 缺省仍 latest**：不传参数 = 未钉版本（产物无 `context.gameVersion`），
   保持旧产物形态与旧流程兼容。
3. **NN 锁 v6.3.0**：外部 NN 强基线（闭源 checkpoint）只有 v6.3.0 词表；config 显式给
   其他版本需 `--force` 放行，且实际仍强制 v6.3.0（NN 无法用其他词表）。
4. **数据定义的版本标记不全**：无 `.since()` 标记的定义默认全版本可用——个别后加卡
   若漏标 `.since`，在旧版本 getData 里仍会存在（存在性校验依赖标记的正确性）。
5. **旧产物无版本标注**：V0 之前的 run 目录 summary/trace 无 `gameVersion` 字段，
   reflect/ablate 对其只给 warning 不中断（--force 与否不影响该路径）。
6. **force 只降级不校准**：`--force` 放行错配后按 config 版本执行，不尝试转换计划词表
   ——计划按旧版本起草的数值断言可能失真，warning 已提示。

## 8. 测试与验收

- `batch-runner-version.test.ts`：真实引擎单局三处版本一致（v6.3.0 / 缺省回归）、
  `resolveBatchGameVersion` 真值表、portfolio 层间版本校验、`validateGamePlan` 版本
  存在性（313010 用例）、`loadPlanWithValidation` 版本感知。
- `version.test.ts`：版本串封闭校验、计划声明版本解析、run 目录版本断言（match /
  mismatch / 未标注 / force）、版本化 AssetsManager、author context 写入契约
  （含 planId 序列化自洽）。
- 环境基线（非本特性引入）：gi-ml 2 个历史 tsc 错误（rl.ts:295 / unified-value-predictor.ts:55）、
  `evaluation/benchmark/cli-config.test.ts` 2 个缺 gitignored RL 产物的失败。
