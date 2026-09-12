# 临时文档：四模型锚点实验 —— 进度 / 参数问题 / 行动方案

> 日期：2026-09-07。性质：临时交接文档（问题解决后可归档或删除）。
> **【已归档 2026-09-07】实验已完成，最终结果见文末「归档结论」。**

## 归档结论（2026-09-07 16:32 实验进程正常结束）

- **glm 系弃用**：glm-5.3 harness 探针（--turns 4，LLM_TIMEOUT_MS=1h）仍失败——
  sidecar `reasoningOnly {total:3, salvaged:0, failed:3}`，四轮全部只写
  reasoning_content（~10 万字符非 JSON 分析）而 content 为空，抢救机制无效。
  按既定备选换 qwen：glm-5.3 → qwen3.8-max-0902、glm-5.3-flash → qwen3.8-flash
  （Aliyun maas 兼容端点，凭据 env：QWEN_API_KEY_MAX / QWEN_API_KEY_FLASH）。
- **参数补齐（本次修复，全部落码）**：
  - `llm.ts`：输出上限参数按供应商分叉——qwen 系发 `max_completion_tokens`，
    其余发 `max_tokens`；GLM/qwen 均设 128000（config `models_api[].maxTokens`，
    编排脚本透传 `--max-tokens`）；
  - `injectedEnvOf` 注入 `LLM_TIMEOUT_MS=3600000`（单请求 20min→1h）；
  - author 子进程超时：anchor-experiment 60min→4h、model-tournament 40min→4h；
  - thinking 一律默认开启；`--author` 不填。
  - qwen3.8-max-0902 探针一次通过（terminatedBy=final，50 rules，42min/4 轮，
    reasoningOnly 全 0）。
- **最终读数**（`output/anchor-exp-v40/run/summary.md`）：704 单元全 done、失败 0；
  臂对臂合计 6400 局与各批 games 之和交叉校验一致。
  - 按臂：anchor 在全部 4 模型上 coverage 一致更低（-0.4~-4.4pp）、fallback
    一致更高、avgRounds 更长（qwen3.8-flash 落差最大 95.0%→90.6%）；
  - 臂对臂（anchor 视角）：合计 **2786 胜 : 3449 负 : 165 平**，ctrl 占优
    （仅 deepseek-v4-pro-0813 798:771 轻微偏 anchor，噪声范围内）；
  - 与 round19（27:43:10 ctrl 占优）同向复现。
- **判定（impl-spec-5 §5）**：复现负面 → **主赛 author 一律 ctrl 直起草，不开
  `--anchor`**。model-tournament 的 author 本就不传 `--anchor`，无需代码回写。
- **口径注记**：deepseek 系 30 单元为 one-shot 产物（修复前完成）、qwen 系 32 单元为
  harness（--turns 4）产物；臂对臂战绩与 coverage 对比均在**同模型内部**进行
  （ctrl vs anchor），跨模型起草协议差异不影响实验判定的有效性。

---

（以下为归档前的过程文档原文）

> 实验定义：impl-spec-5（round19 式 `--anchor` 起草复验）；编排脚本
> `packages/gi-agent/scripts/ops/anchor-experiment.ts`。
> 配套交接：pipeline「生成即赛」的交接在 [2026-09-06-pipeline-handoff.md](./2026-09-06-pipeline-handoff.md)，本文不重复。

## 1. 实验进度（截至 2026-09-06 23:35 实验进程停止）

配置：4 模型 × 8 卡组（4.0.json 带 deckName 者）× 双臂（ctrl 直起草 / `--anchor`）×
5 seeds（42071001-05）× gamesPerMatch 20；gameVersion **v4.0.0**；产物
`packages/gi-agent/output/anchor-exp-v40/run/`（state.json 幂等续跑真值）。

| 模型 | author 单元（×2 臂 ×8 deck = 16/模型） | 说明 |
|---|---|---|
| deepseek-v4-pro-0813 | **16/16 ✓** | one-shot 完成 |
| deepseek-v4-flash-vision-exp | 14/16 | 2 单元 3 次重试后放弃 |
| glm-5.3 | **0/16** | 全部失败（见 §2） |
| glm-5.3-flash | ~0-3/16 | 推进到 d3 附近，几乎全失败 |

battle 0/640（未进入）。**进程已死**：日志
`<home>\.zcode\cli\exec\sess_49665f51-3f2c-48f6-a6bb-6d84b2a7ded4\call_1796e888846a439a9f1c2b8a-stdout.log`
最后写入 2026-09-06 23:35:37（过夜停止，疑机器休眠/后台任务被终止）。重启即幂等续跑：
state.json 只记 done（**失败不入 state**，死亡时 in-memory 的失败清单已丢），未 done 的
单元会自动重试。已产出的 deepseek 计划文件会被 adopt/skip 逻辑复用，不重花钱。

## 2. 参数问题（根因，已定位）

**author 起草当前是 one-shot，而规格本要求 harness 有界多轮。**

- `plan:author` CLI 支持 `--turns N`（harness 有界多轮 → `mainAgentic`，即 WP2 扩展过
  的 `agent-loop.ts`：多轮 payload 校验反馈、format 错误直方图、`<out>.harness.json`
  sidecar）；`--turns` 缺省 1 = one-shot（起草 → 校验失败 → repair 反馈重起草，最多
  3 发，仍是单次 LLM 调用语义）。
- **两个编排脚本（anchor-experiment.ts 与 model-tournament.ts）的 author 调用都没传
  `--turns`**；只有 reflect 被传了 `--turns 4`（冒烟期 B-2 修复）。执行方案 §7 本就写明
  author 是「harness 模式内部有界多轮」→ **实现遗漏**。
- Mock 冒烟测不出：mock LLM 永远返回合法 JSON，one-shot 也能过。
- 失败签名（glm 系，实验日志统计）：**112 次「输出无法解析为 JSON（content 0 字符 /
  reasoning ~100k 字符）」** + 79 次「校验未通过且修复次数用尽」+ 4 次 429 限速。即
  glm-5.3 / glm-5.3-flash 把全部内容写进 `reasoning_content`（10 万字符条目式分析，
  本身非合法 JSON）而 `content` 为空；repair 轮同 prompt 复现同行为，救不回来。
  reasoning 原文已落盘：`output/anchor-exp-v40/run/plans/glm-5.3-flash/*.attempt*.reasoning.txt`。
- deepseek 系不受影响（one-shot 成功）。

### 修复状态

| 项 | 状态 |
|---|---|
| `anchor-experiment.ts` author args 加 `--turns 4`（对所有模型、双臂一致，保臂间公平） | **✅ 已改**（authorTasks worker 内 args 数组，含注释） |
| `model-tournament.ts` author args 加 `--turns 4`（**两处**：single 分支 ~L432、general 分支 ~L450 的 args 数组） | **⬜ 待做**（注意：该文件已被 pipeline 实现重构，worker 有 try/finally + onCallTaskDone，编辑以当前文本为准） |
| 真调用探针验证（glm-5.3 harness 模式） | ⬜ 见 §3-b |
| 重启实验 | ⬜ 见 §3-c |

## 3. 行动方案（按序执行）

**a. 补 model-tournament 的 --turns**：两处 author args 数组各加 `"--turns", "4"`
（与 reflect 同界；加一行注释引用 anchor-experiment.ts 同注）。完成后
`tsc -p packages/gi-agent --noEmit` 无新增错误。

**b. glm-5.3 单单元探针（1 个 authoring 会话的 API 成本）**：

```bash
cd /d/AI/GTCG/genius-invokation-clean/packages/gi-agent
export PATH="$PWD/.tmp/smoke-tools/bin:$PATH"        # 系统 pnpm shim 损坏，用现成 shim
set -a; source .tmp/anchor-exp/env.sh; set +a        # 实验凭据（GLM/DEEPSEEK env 名）
node ../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
  src/runtime/plan-oneshot/cli/run-plan-author.ts \
  --deck "BJFRyhsQBCFx9XQQCkFR9pYQDFEx97QQDIGB/rkQDNKhC7wRDKLBDL0RDbJxD8gRDeEB" \
  --mirror --game-version v4.0.0 \
  --out .tmp/glm-probe/ctrl-probe.json \
  --seed 42071001 --temperature 0.2 --model glm-5.3 --turns 4 --stream
```

成功判据：exit 0 + `.tmp/glm-probe/ctrl-probe.json` 存在且含 planId + 产出
`.tmp/glm-probe/ctrl-probe.json.harness.json`（harness sidecar，可看
issueHistogram/counters 观察 glm 行为）。若 harness 模式仍失败 → 读 harness.json 的
rejected/counters 定位（可能需要调 turns 上限或放弃 glm，见 §3-e 备选）。

**c. 探针成功后重启实验**（后台，幂等续跑）：

```bash
cd /d/AI/GTCG/genius-invokation-clean/packages/gi-agent
export PATH="$PWD/.tmp/smoke-tools/bin:$PATH"; set -a; source .tmp/anchor-exp/env.sh; set +a
node ../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
  scripts/ops/anchor-experiment.ts \
  --config output/anchor-exp-v40/anchor-exp.json --out output/anchor-exp-v40/run \
  --author-concurrency 3 --battle-concurrency 4
```

- 30 个 done 单元跳过；deepseek-flash 的 2 个失败单元与 glm 系全部单元自动重试
  （每单元 3 发，每发为 harness 4 轮）；author 后自动进 battle（4 批进程并行，批内
  lean trace）。
- glm 系曾触 429：若再遇，把 `--author-concurrency` 降 2 或接受（失败隔离会重试）。
- 预计剩余墙钟：glm 系 32 单元 × harness 数分钟 + battle ~1.5-2.5h。

**d. 口径注记（写进最终 summary.md）**：deepseek 已完成的 30 单元是 one-shot 产物、
glm 系是 harness 产物——臂对臂战绩与 coverage 对比都在**同模型内部**进行（ctrl vs
anchor），跨模型起草协议差异不影响实验判定的有效性；如追求全模型口径完全一致可删
deepseek plans 重跑（成本大，不建议）。

**e. 备选（探针仍失败时）**：读 harness.json 定位后仍无解 → 选项：换掉 glm 系模型
（需替补凭据，tournament.json/anchor-exp.json 改 models 即可）/ 接受 2 模型降级重启
（battle 阶段对缺树模型的批自动跳过：`!existsSync(planFile) → continue`）。

**f. 读数与回写**（实验完成后）：`output/anchor-exp-v40/run/summary.json` +
`summary.md`（按臂 coverage/fallback/avgRounds ± SE、臂对臂战绩 anchor 视角、round19
对照行、自动判定提示）；判定规则 impl-spec-5 §5（复现负面 → 主赛 author 一律 ctrl；
稳定收益 → 回写主赛 author 默认 `--anchor`；混合 → 报告不改）；交叉校验：臂对臂合计
局数 == 各批 games 之和。

## 4. 环境与禁区

- 系统 pnpm corepack shim 损坏、禁 bun；tsdx 路径与 shim 见 §3-b/c 命令。
- **禁区**：`output/anchor-exp-v40/`（实验产物）、`.tmp/smoke-tools/`（实验依赖的
  pnpm shim）、`.tmp/anchor-exp/`（凭据 env，**任何文件不得落盘 key 值**）。
- 凭据来源：`packages/benchmark/tree-bench/API.txt`（deepseek 两模型共用一把 key、
  glm 两模型共用一把 key；env.sh 由本会话生成）。
- vitest 基线 524 通过 / 2 失败（cli-config 环境性 ENOENT）；selfcheck 24/24。
- 不 git commit。
