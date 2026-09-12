# Combat Window Pipeline

> **⚠️ 状态：部分过时** — 管道架构仍在用，但 V25 主要依赖 self-play 训练数据而非 combat windows。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

这份文档对应 `packages/gi-agent` 里的一阶段局部树流水线。目标不是直接训练最终 AI，而是把对局日志整理成可验证的 `combat_window_plan` 种子库。

## 目标

流水线分三步：

1. 从 `runtime-plans/` 里提取 2 到 4 动作的候选窗口
2. 用 LLM 对每个窗口做赛后结构化分析，生成 `combat_window_plan`
3. 对生成的树做本地验证，并写入 `tree-lake`

当前实现优先支持 `battle-agent` / MCP 产出的 `runtime-plans` 目录。  
这意味着第一版 `state_fingerprint` 是 **session 级** 的，不是完全 replay-backed 的跨局稳定指纹。  
但当前 MCP digest 已经带了 `character_definitions`，所以 extractor / selector 现在可以直接从 runtime artifact 推出：

- `deck_fingerprint_self`
- `deck_fingerprint_opp`
- `self/opp active character definition_id`

只有在旧 artifact 缺少这些字段时，才会退回到更弱的 session 级特征。

## 命令

在 [package.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/package.json) 里新增了三条命令：

- `pnpm run combat-window:extract`
- `pnpm run combat-window:analyze`
- `pnpm run combat-window:validate`
- `pnpm run combat-window:align-replay`
- `pnpm run combat-window:import-branch-eval`
- `pnpm run combat-window:export-library`
- `pnpm run combat-window:query-library`
- `pnpm run combat-window:evaluate-library`
- `pnpm run combat-window:evaluate-workload`

## 1. 提取候选窗口

最常用命令：

```powershell
cd packages/gi-agent
pnpm run combat-window:extract `
  --runtime-plans-dir ./runtime-plans `
  --output ./output/combat-windows/windows.json `
  --min-actions 2 `
  --max-actions 4 `
  --top-k-per-session 24
```

输出文件是一个 JSON，对应类型是 `CombatWindowExtractionResult`。核心字段：

- `sessions_scanned`
- `windows`
- `windows[].state_fingerprint`
- `windows[].steps`

切窗规则：

- 只保留 `pending_method=action`
- 只保留 `execution_ok=true` 且存在 `selected_candidate_id` 的动作
- 同一 round + 同一 turn 的连续动作会被视作一个 sequence
- 如果反馈里有 `active_window_id`，会优先用它切分
- 每个 sequence 再展开成长度为 2 到 4 的滑动窗口

## 2. 赛后结构化分析

这一步需要 OpenAI API 环境变量。仓库里已有说明见 [README.md](/D:/AI/GTCG/genius-invokation/packages/gi-agent/README.md#L316)。

```powershell
cd packages/gi-agent
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_MODEL="gpt-4o-mini"

pnpm run combat-window:analyze `
  --input ./output/combat-windows/windows.json `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --model gpt-4o-mini `
  --temperature 0 `
  --limit 20
```

说明：

- `--skip-existing` 默认开启，会跳过已经入库的 `source_window_id`
- 每个窗口分析后会以 `draft` 状态写入 `tree-lake`
- LLM 必须返回 JSON；命令会自动剥离 ```json fenced block

输出对象核心字段：

- `analysis_meta`
- `source_context`
- `state_fingerprint`
- `combat_window_plan`
- `candidate_review`
- `outcome_assessment`
- `quality`

## 3. 验证 draft trees

```powershell
cd packages/gi-agent
pnpm run combat-window:validate `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --status draft `
  --limit 100
```

当前验证器包含四类检查：

- schema 检查
- `entry_conditions` 与源窗口是否匹配
- 源动作线是否能沿 `entry_node_id -> next` 走通
- 节点约束是否和实际选中的 candidate 冲突

验证结果会：

- 写入 `tree_validation_runs`
- 回写 `trees.validation_summary_json`
- 将 `status` 更新为 `validated` 或 `rejected`

## 4. 用 replay 给 tree 补锚点

如果你手上已经有 benchmark 配置和同 matchup 的 replay 目录，可以继续跑 replay 对齐：

```powershell
cd packages/gi-agent
pnpm run combat-window:align-replay `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --benchmark-path ./prior-v2/benchmark.self-play.shuining-mirror.json `
  --matchup-id ShuiNing-mirror `
  --replay-dir ./prior-v2/output/replay-samples/ShuiNing-mirror `
  --status validated `
  --threshold 0.6
```

这一步会为每棵 tree 生成一个 `replay_alignment`，并在命中时额外生成 `canonical_fingerprint`：

- `matched`
- `matchup_id`
- `replay_file`
- `replay_entry_index`
- `similarity`
- `matched_fields`

`canonical_fingerprint` 会补上跨局更稳定的字段，例如：

- `deck_fingerprint_self`
- `deck_fingerprint_opp`
- `self_active_character_definition_id`
- `opp_active_character_definition_id`
- `first_action_case`
- `first_action_definition_id`
- `support_bucket`
- `summon_bucket`
- `cards_in_hand_bucket`
- `canonical_key`

当前对齐器是启发式的，不是精确状态同构。  
它主要靠这些信号打分：

- self deck fingerprint
- round / turn
- HP bucket / dice bucket
- 首步 action case
- 首步 tag overlap

所以它适合作为“给树补 branch-eval 锚点”的中间层，而不是当成最终真值。

## 5. 导入 branch-eval 结果

先跑原有 branch-eval：

```powershell
cd packages/gi-agent
pnpm run branch-eval ./prior-v2/branch-eval.shuining-mirror.json
```

现在 `branch-eval` 输出里会额外带：

- `replayActionType`
- `replayActionDefinitionId`
- `replayActionTags`
- `policySelectedActionType`
- `branches[].candidateTags`

有了这些字段之后，就可以把 report 回灌到 `tree-lake`：

```powershell
cd packages/gi-agent
pnpm run combat-window:import-branch-eval `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --report ./prior-v2/output/branch-eval-shuining-mirror.json `
  --status validated
```

导入后，每棵命中的 tree 会补一个 `branch_eval_summary`，核心字段：

- `best_action_win_rate`
- `replay_action_win_rate`
- `policy_action_win_rate`
- `lift_vs_replay`
- `lift_vs_policy`
- `tree_first_action_case_matches_replay`
- `promote_signal`

保守规则：

- 只有 `validated` tree 才可能被推到 `promoted`
- 只有当 tree 首步 action case 和 replay action case 对齐，并且 replay branch 已经接近最佳 branch，才会自动 `promote`
- 如果只是 point-level 证据不足，保持 `hold`

## 6. 导出离线检索库

当 tree 已经补齐 `canonical_fingerprint` 后，可以直接导出一个更适合检索的 library JSON：

```powershell
cd packages/gi-agent
pnpm run combat-window:export-library `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --status promoted `
  --output ./output/combat-windows/library.json
```

导出的每条 entry 至少包含：

- `canonical_key`
- `tree_id`
- `status`
- `matchup_id`
- `fingerprint`
- `combat_window_plan`
- `promote_signal`

这份 `library.json` 就是下一阶段在线 selector 或离线检索器最直接的输入。

## 7. 查询离线树库

导出 `library.json` 之后，可以直接拿候选窗口或已有 tree 做离线检索，验证“当前局面会召回哪些局部树”：

```powershell
cd packages/gi-agent
pnpm run combat-window:query-library `
  --library ./output/combat-windows/library.json `
  --windows ./output/combat-windows/windows.json `
  --window-id window_xxx `
  --matchup-id ShuiNing-mirror `
  --deck-fingerprint-opp 1411-1510-2102 `
  --limit 5 `
  --min-score 0.5
```

如果已经有 replay-backed tree，也可以直接用 tree 作为查询源：

```powershell
cd packages/gi-agent
pnpm run combat-window:query-library `
  --library ./output/combat-windows/library.json `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --tree-id tree_xxx `
  --query-mode canonical
```

返回结果里最重要的是：

- `selection.query`
- `selection.matches[].state_similarity`
- `selection.matches[].quality_prior`
- `selection.matches[].final_score`
- `selection.matches[].matched_fields`

当前 selector 有两个刻意保守的设计：

- 默认要求 `deck_fingerprint_self` 一致，否则直接过滤
- 如果 runtime artifact 缺少 `character_definitions`，检索仍会退化为“部分指纹命中”
- 如果 digest 自带 `character_definitions`，selector 会自动恢复双方 deck fingerprint 和 active character definition id，不需要额外传参

## 8. 评估检索质量

光能查还不够，还要知道“树库里有的 key 是否真能被召回”。可以直接对 `tree-lake` 里的已验证树做离线评估：

```powershell
cd packages/gi-agent
pnpm run combat-window:evaluate-library `
  --library ./output/combat-windows/library.json `
  --tree-lake ./output/combat-windows/tree-lake.sqlite `
  --query-status validated `
  --query-mode all `
  --selection-limit 5 `
  --output ./output/combat-windows/library-eval.json
```

这个命令会分别跑三种 query mode：

- `runtime`
  只用 source window / runtime digest 当前可观测到的信息检索，最接近真实在线条件
- `window`
  用 `source_window` + replay-backed 已知 metadata 检索，是“补全一些离线 metadata 后”的增强版
- `canonical`
  直接用 replay-backed `canonical_fingerprint` 检索，代表理想上限

输出里最关键的是这些指标：

- `coverable_count`
  查询树的 `canonical_key` 在库里是否存在
- `hit_at_1_all / hit_at_3_all / hit_at_5_all`
  对所有查询树的总召回率
- `hit_at_1_coverable / hit_at_3_coverable / hit_at_5_coverable`
  只在“库里本来就有这棵树”前提下统计的召回率
- `avg_top1_final_score`
  top-1 召回结果的平均排序分
- `matchups`
  按 matchup 的覆盖和召回拆分

这组指标的用途很直接：

- `coverable_count` 低：优先补树
- `coverable` 高但 `hit_at_k` 低：优先调 selector
- `window` 明显高于 `runtime`：说明在线 digest 暴露的信息还不够稳定
- `canonical` 明显高于 `window`：说明 replay-backed 指纹仍然比当前离线 metadata 更强

## 9. 批量评估 benchmark / self-play workload

如果你已经积累了一批 `runtime-plans`，更实用的问题通常不是“标注树自己能不能召回自己”，而是“这批真实 workload 里，有多少窗口能被树库接住”。

最直接的命令：

```powershell
cd packages/gi-agent
pnpm run combat-window:evaluate-workload `
  --library ./output/combat-windows/library.json `
  --runtime-plans-dir ./runtime-plans `
  --selection-limit 5 `
  --strong-match-threshold 0.7 `
  --output ./output/combat-windows/workload-eval.json
```

如果你已经提前跑过 `combat-window:extract`，也可以直接复用 `windows.json`：

```powershell
cd packages/gi-agent
pnpm run combat-window:evaluate-workload `
  --library ./output/combat-windows/library.json `
  --windows ./output/combat-windows/windows.json `
  --output ./output/combat-windows/workload-eval.json
```

这个报告不依赖 ground truth tree，而是回答：

- `matched_window_count`
  有多少 runtime 窗口至少能召回一棵树
- `strong_match_count`
  有多少窗口的 top-1 分数超过阈值
- `deck_pairs`
  覆盖缺口集中在哪些 self deck / opp deck 组合
- `top_match_matchups`
  当前 workload 最常被哪类 matchup 树吸附

推荐把它当成 benchmark/self-play 的批处理后置报告：

- `matched_window_count` 低：说明树库覆盖还不够
- `matched_window_count` 高但 `strong_match_count` 低：说明 selector 区分度不够
- 某些 `deck_pairs` 特别差：说明应优先补这些对阵的窗口树

## 产物

`tree-lake` 目前默认是 SQLite，如果环境不支持 `better-sqlite3`，会自动退回 JSON 文件。

表结构：

- `trees`
- `tree_validation_runs`
- `tree_usage_stats`

`trees` 表中保存：

- 原始 `source_window`
- LLM 产出的 `analysis`
- `replay_alignment`
- `canonical_fingerprint`
- `branch_eval_summary`
- 当前 `status`
- 最新 `validation_summary`

## 当前限制

当前仍然没有把 branch-eval 硬塞进 `validate` 主命令，原因是：

- replay 对齐仍然是启发式，不是严格同构匹配
- branch-eval 更适合作为“promotion evidence”，而不是基础 schema/replay legality 校验

所以目前推荐做法是：

1. 先跑 `extract`
2. 再跑 `analyze`
3. 再跑 `validate`
4. 如果有 replay/benchmark，再跑 `align-replay`
5. 再跑 `branch-eval`
6. 最后 `import-branch-eval`
7. 导出 `export-library`
8. 用 `query-library` spot check 单个检索结果
9. 用 `evaluate-library` 看整体检索质量
10. 用 `evaluate-workload` 看 benchmark/self-play 的真实 workload 覆盖

## 代码位置

- 提取器：[window-extractor.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/window-extractor.ts)
- LLM 分析器：[post-analysis.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/post-analysis.ts)
- 树库存储：[tree-lake.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/tree-lake.ts)
- 验证器：[tree-validator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/tree-validator.ts)
- replay 对齐器：[replay-alignment.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/replay-alignment.ts)
- branch-eval 导入器：[branch-eval-import.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/branch-eval-import.ts)
- library 导出器：[export-library.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/export-library.ts)
- library 检索器：[library-selector.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/library-selector.ts)
- library 评估器：[library-evaluator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/library-evaluator.ts)
- workload 评估器：[library-workload-evaluator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/library-workload-evaluator.ts)
- runtime digest 特征工具：[runtime-digest-utils.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/runtime-digest-utils.ts)

## 推荐起步规模

第一批建议：

- 先用 1 到 3 个稳定卡组
- 每个 session 提取 10 到 24 个高分窗口
- 先分析 20 到 50 个窗口
- 验证通过后再决定是否引入 replay-backed enrich 和 branch-eval 自动桥接
