**文件级迁移清单**

`@gi-tcg/agent`
- 保留为核心：
  - `src/learning/scoring/feature-extractor.ts` -> `src/learning/features/action-feature-extractor.ts`
  - `src/learning/scoring/logistic-reg.ts` -> `src/learning/training/logistic-calibrator.ts`
  - `src/db/data-lake.ts` -> `src/learning/data/data-lake.ts`
  - `src/sandbox/runner.ts` -> `src/evaluation/benchmark/sandbox-runner.ts`
- 保留但降级：
  - `src/agents/scoring-auditor.ts` -> `src/analysis/scoring-auditor.ts`
  - `src/graphs/battle-graph.ts` -> `src/analysis/llm-runtime-experiments/battle-graph.ts`
  - `src/agents/battle-agent.ts` -> `src/analysis/llm-runtime-experiments/battle-agent.ts`
- 接口保留、实现后补：
  - `src/db/extractor.ts` -> `src/learning/data/replay-extractor.ts`

`@gi-tcg/tactic-search`
- 直接迁移：
  - `src/sim-adapter.ts` -> `src/runtime/adapters/sim-adapter.ts`
  - `src/internal-types.ts` -> `src/runtime/adapters/internal-types.ts`
  - `src/types.ts` -> `src/runtime/search/types.ts`
  - `src/bounded-searcher.ts` -> `src/runtime/search/bounded-searcher.ts`
- 拆分重写：
  - `src/state-evaluator.ts` ->
    - `src/runtime/search/delta-extractor.ts`
    - `src/runtime/eval-baselines/heuristic-scorer.ts`
    - `src/runtime/eval-baselines/feasibility-estimator.ts`
- 可选迁移，默认只做分析工具：
  - `src/combo-registry.ts` -> `src/analysis/combo-registry.ts`
  - `src/mcp-output.ts` -> `src/analysis/mcp-output.ts`
- 退役：
  - `src/index.ts`

`@gi-tcg/eval-char-comb`
- 直接迁移：
  - `src/profiler/types.ts` -> `src/knowledge/character-profiles/types.ts`
  - `src/profiler/CharacterProfileExtractor.ts` -> `src/knowledge/character-profiles/character-profile-extractor.ts`
  - `src/profiler/SourceParser.ts` -> `src/knowledge/character-profiles/source-parser.ts`
  - `src/profiler/SkillPhaseValueEstimator.ts` -> `src/knowledge/character-profiles/skill-phase-value-estimator.ts`
  - `src/card-affinity/CardAffinityAnalyzer.ts` -> `src/knowledge/deck-priors/card-affinity-analyzer.ts`
- 降级为先验/候选生成：
  - `src/compatibility/ElementalCompatibilityCalc.ts` -> `src/knowledge/deck-priors/elemental-compatibility.ts`
  - `src/compatibility/CostCompatibilityCalc.ts` -> `src/knowledge/deck-priors/cost-compatibility.ts`
  - `src/compatibility/TempoCompatibilityCalc.ts` -> `src/knowledge/deck-priors/tempo-compatibility.ts`
  - `src/compatibility/DeckCompatibilityScorer.ts` -> `src/knowledge/deck-priors/deck-prior-scorer.ts`
  - `src/DeckCandidateFilter.ts` -> `src/knowledge/deck-priors/deck-candidate-filter.ts`
  - `src/CharacterProfileService.ts` -> `src/knowledge/character-profiles/character-profile-service.ts`
- 退役：
  - `src/cli/extract-all.ts`
  - `src/index.ts`

**建议的新目录**
```text
src/
├── runtime/
│   ├── adapters/
│   ├── search/
│   ├── policy/
│   └── io/
├── evaluation/
│   ├── benchmark/
│   └── scenarios/
├── learning/
│   ├── data/
│   ├── features/
│   └── training/
├── knowledge/
│   ├── character-profiles/
│   └── deck-priors/
├── analysis/
│   ├── scoring-auditor.ts
│   ├── combo-registry.ts
│   ├── mcp-output.ts
│   └── llm-runtime-experiments/
└── index.ts
```

**迁移顺序**
1. 先搬 `tactic-search` 的 `sim-adapter / internal-types / types / bounded-searcher`
2. 再搬 `eval-char-comb` 的 `types / extractor / source-parser / phase estimator / card affinity`
3. 然后重组 `gi-agent` 的 `sandbox / data-lake / feature-extractor / logistic-reg`
4. 再拆 `state-evaluator.ts`
5. 最后把 `battle-graph` 和 `battle-agent` 降级成实验工具
