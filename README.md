# GITCG-Bench

> **状态：占位仓库（placeholder）。** 目前只放 LICENSE 与这份说明，代码与评测材料整理完成后以第二个 commit 推送。

七圣召唤（Genius Invokation TCG）双人对局的 **LLM agent 评测基准**：一套让 LLM agent 在固定卡组池上打完整对局、并对决策质量做可复现测量与归因的实验管线。

## 这个仓库现在有什么

- `LICENSE` — AGPL-3.0
- `README.md` — 本文件（含计划中的仓库结构与评测口径）

## 计划中的内容（后续 commit）

```
packages/
  core/ data/ typings/ utils/   # 引擎与卡牌数据（上游包及评测侧改动）
  gi-agent/                     # LLM 对战 agent：决策树管线 author → batch → reflect → ablate
  benchmark/                    # 卡组池、批跑配置、评分与产物汇总
docs/                           # 评测口径、产物 schema、复现步骤
```

- **对战 agent**：one-shot 决策树起草（含机检/校核）、批量对局、赛后反思、消融验证。
- **评测**：固定卡组池与赛程、对局产物（trace / summary / 评分）与聚合报告。
- **复现**：配置样本与最小复现步骤。

## 评测口径（scope）

- 采用 **oracle-free / engine-only** 口径：判定与归因只使用引擎侧证据，不把 NN 基线回算或搜索 oracle 当作评测臂。
- **不包含**闭源 NN 基线桥接及其权重（不入库）。
- **不包含**第三方版权材料：电子书、论文 PDF、官方卡图等。

## 血缘与许可

- 本项目基于 [piovium/genius-invokation](https://github.com/piovium/genius-invokation)（七圣召唤模拟器）的下游工作，遵循 **AGPL-3.0**。上游版权归原作者所有；本仓库新增部分同样以 AGPLv3 发布。
- 使用前请自行确认对游戏素材（卡牌图像、文本等）的合理使用范围。

---

## English

Placeholder repository for **GITCG-Bench**, an LLM-agent benchmark for *Genius Invokation TCG* (七圣召唤). It will host a reproducible pipeline that runs LLM agents over a fixed deck pool and scores their play, using an **oracle-free / engine-only** evaluation protocol. Closed-source NN baselines and third-party copyrighted material (books, paper PDFs, official card art) are intentionally not included. Licensed under **AGPL-3.0**; a downstream work of [piovium/genius-invokation](https://github.com/piovium/genius-invokation).
