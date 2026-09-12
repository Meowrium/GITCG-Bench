# 锦标赛剩余测试项交接(2026-09-09)

> 面向新对话的自包含交接。范围:**只测 deepseek-v4.1-flash 与 qwen3.8-flash 的数据;hy3(混元)弃测;赛程变体(vs-previous / chainGap>1)不专门测**。
> 前置状态:三模型 smoke 轮已跑完,产物在 `packages/gi-agent/output/tournament-smoke-3m/`;全部相关代码已提交(分支 `v5-temporal-reasoning`,commit `d76dd5e4`~`4b2cb06f`)。

## 0. 已验证(不要重复测)

- model-tournament 八子命令中 **author / evolve / battle / pipeline / export / analyze / status** 全部实跑通过(analyze 含连通性预检告警路径 + uv/matplotlib 五图);
- `tournament-selfcheck.ts` 离线验收 24/24;
- LLM 并发按供应商分桶(`TournamentModel.concurrency`)单测 11 例 + 旧 config 兼容;
- lean trace 签名(锦标赛默认)与 full 签名(candidates-ab 的 plan:batch 路径)各自真实跑过。

## 1. archive 真跑 + 恢复演练(唯一未验的子命令回路)

- **目的**:`archive --through N` 的「tar 打包 → tar -tzf 条目校验一致 → 删除 game-* 明细 → tar -xzf 恢复」完整回路只跑过 `--dry-run`。
- **数据**:`output/tournament-smoke-3m/`(r0 的 54 个 pair 批明细;hy3 的 r0 数据也在其中,一并归档即可——不测 hy3 指不再用 hy3 跑 LLM,文件操作无妨)。
- **命令**(全部在 `packages/gi-agent/` 下):
  ```bash
  node .tmp/tournament-3m.mjs archive --through 0 --dry-run   # 先看清单(幂等)
  node .tmp/tournament-3m.mjs archive --through 0             # 真跑
  node .tmp/tournament-3m.mjs status                          # 位图必须不变
  # 恢复演练(任选一个 pair):
  tar -xzf output/tournament-smoke-3m/battles/archive/round-0/<pair>.tar.gz \
      -C output/tournament-smoke-3m/battles/<pair>
  ```
- **验收**:① 批级 JSON 恒保留、state.json 完成位图不变;② 链批默认不归档(除非 `--include-chain`);③ evidence 为 symlink 的 pair 被跳过;④ 恢复后目录与归档前逐文件一致(可 `diff -r` 抽查一个 pair);⑤ tarball 校验不过时应 fail-fast 且不删原目录。
- **风险**:低(删除前内建校验;数据可经 tarball 恢复)。

## 2. organizer 试点(WP4 件 4,唯一从未跑过真实数据的管线)

- **目的**:`plan:organize-export`(证据导出五件)+ `scripts/ops/organize-run.ts`(提及/实践/错位三任务编排)在真实对局数据上的首跑与人工校准。规格:`docs/plans/2026-09-05-impl-spec-4-organizer.md`;CLI 口径:gi-agent `AGENTS.md` 的 `plan:organize-export` 条目。
- **数据**:smoke-3m 的 battles run 目录(360 局真实对局,含 trace/summary/state log)。
- **模型**:organizer 模型用 deepseek 或 qwen(`ORGANIZER_*` env 注入,见 organize-run.ts);deepseek API 仍可用(模型名 `deepseek-v4.1-flash-expires-on-0910`,maxTokens 384000;qwen `qwen3.8-flash`,128000)。
- **验收**:evidencePack 五件落盘(fullDigest/stateSignatures/draw-sequence/outliers/side1);三任务报告过 `organizer-report.schema.json` 校验;人工校准一轮(抽样核对 organizer 输出 vs 原始证据)。
- **成本**:数次 organizer 模型 LLM 调用。

## 3. 锦标赛内 `traceSignatures: "full"` 注入路径

- **目的**:编排层把 `traceSignatures` 注入 battle 批配置的路径只验过 lean;full 需显式设一次确认注入生效。
- **做法**(最小成本,不需新锦标赛):复制 `.tmp/tournament-smoke-3m.json` 改 `outRoot` + 加 `"traceSignatures": "full"`、`rounds: 1`、`gamesPerCell: 1`,只跑 `author` 的一小格或直接用 `plan:batch` 对既有计划跑一批,核对批 config 落盘含 `traceSignatures:"full"` 且单局产物为内嵌整签名(~1.87MB/局,与 lean 的 ≤0.45MB 对照)。
- **验收**:批配置含注入字段;reflect/organizer 消费 full 产物不报错(lean 反查逻辑对 full 是 no-op,已有单测)。

## 4. 环境与新对话须知

- **`.env` 加载**:`packages/gi-agent/.env` 含裸行(模型名注释行),`source` 会炸、`--env-file` 不允许进 NODE_OPTIONS——统一走包装器:`node .tmp/tournament-3m.mjs <子命令> [args]`(自动解析 .env、补 node_modules/.bin PATH)。配置:`.tmp/tournament-smoke-3m.json`(3 模型;若起新锦标赛可裁掉 hy3 项)。
- **凭据键**:DEEPSEEK_API_KEY/DEEPSEEK_URL、QWEN_API_KEY/QWEN_URL;TENCENT_* 组(hy3)已搁置。
- **hy3 弃测根因**(供备查):reflect 输入 201k~287k tokens 超供应商 192K 输入硬限;根因是 digest 截断只删对齐行、对 thenMiss 富集的差计划失效(自锁)。若日后复测 hy3,先做附录 A 的方案 A。
- **幂等续跑**:tournament state.json 位图不写失败,任何子命令可安全重跑补缺。
- **测试纪律**:`pnpm exec vitest run scripts/ops` 与 `pnpm exec vitest run src/runtime/plan-oneshot` 应保持全绿(基线 60 + 376);`pnpm check` 仅 2 个 gi-ml 预存错误(rl.ts:295、unified-value-predictor.ts:55)。

## 附录 A:机制级待修发现(非测试项,仅记录)

1. **digest 截断对非对齐行失效(hy3 自锁根因)**:`evidence-extract.ts:473-486` 只删对齐行;方案 A = 按规则键分层抽样闸 `--digest-max-lines-per-rule`(约 40 行,实测可压到 113~138K tokens)。hy3 弃测后优先级降低,但对任何小输入窗模型仍是护栏。
2. **回放断言空转**:smoke-3m 六次 reflect 共 59 条 op 断言全部 `no-target`,falsifiableClaim 从未被机检;deepseek 三组 merge 后 fallbackRate 反升。合并期机检需要修。
3. **revise 错靶**:patch 协议按 `layer:scope:priority` 定位且允许只交 `when`,跨层同 priority 时 LLM 误判会产出 when/then 语义错乱规则(本轮改坏 4 棵树的实例在案)。修复方向:revise 强制回显 `then`,或校验 when 的 `self.active.defId` 与 then 技能归属一致。
4. **reason 字段语义漂移**:r1 的 reason 变成修订备忘录,会作为下一轮 reflect 输入,注意污染。

## 附录 B:相关文档指针

- 候选制单对话 A/B 复测与「候选-挑选是否额外获取判断力」预留问题:`2026-09-09-candidates-single-session-ab.md`
- 分桶并发设计与实施:`2026-09-09-tournament-per-provider-llm-concurrency.md`
- 锦标赛实现规格:`2026-09-05-impl-spec-1-tournament.md`(§4.7 pipeline)
