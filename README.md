# GITCG-Bench

> **状态：代码快照 v0（2026-09）。** 公开仓库，用于占位与代码归档；尚未打 tag，也未做发布级整理（本机绝对路径、内部计划文档等仍在其中）。

七圣召唤（Genius Invokation TCG）双人对局的 **LLM agent 评测基准**：让 LLM agent 在固定卡组池上打完整对局，并对决策质量做可复现测量与归因的实验管线。

## 包含什么

| 路径 | 内容 |
|---|---|
| `packages/core` `data` `typings` `utils` … | 上游模拟器与卡牌数据（含本仓库的评测侧改动） |
| `packages/gi-agent` | LLM 对战 agent 与 one-shot 决策树管线：`author → batch → reflect → ablate`，含 harness、卡面事实表与机检 |
| `packages/benchmark` | 基准套件：`gi-knowledge`（知识问答）、`tree-bench`（决策树对战）、`battle-benchmark`（自进化） |
| `packages/gi-ml` | 学习/训练子系统：概念库、ranker、value artifact（同时是 `gi-agent` 的契约类型来源） |
| `packages/gitcg-theory` | 理论框架与文献笔记（`paper-scout/` 只含 markdown 笔记与题录，PDF 未入库） |
| `docs/` `AGENTS.md` `CLAUDE.md` | 工程文档与包级约定 |

上游项目自身的说明（模拟器用法、包结构、多语言 README）见 [`README.upstream.md`](./README.upstream.md)。

## 不含什么（本次快照刻意剔除）

- **闭源 NN 基线**：`aibridge` 桥接工程、`gi-agent/src/runtime/nn-bridge/`、NN 相关的脚本/示例计划/证据文档（其代码调用点已一并清理，快照内无悬挂引用）。
- **第三方版权材料**：电子书（`gitcg-theory/cgt/books`）、论文 PDF、官方卡图（`packages/card_images`）。论文草稿（`packages/benchmark/paper/`）亦未收入。
- **本地 agent 配置** `.opencode/`（含个人凭据脚本）与本地凭据文件（`tree-bench/API.txt` 等）。

## 评测口径（scope）

- **oracle-free / engine-only**：判定与归因只使用引擎侧证据，不把 NN 基线回算或搜索 oracle 当作评测臂。
- 归因工具 `plan:eval` 在本快照中只保留 ISMCTS 口径；`--oracle nn` 已随 NN 桥接一并移除。

## 构建与运行

```bash
pnpm install          # 包管理器：pnpm（不要用 bun）
pnpm build            # typings → utils → core → data → 其余
cd packages/gi-agent && pnpm test
```

- 需要 Node `^26.1.0` 与 pnpm；仓库使用 pnpm workspace（`catalog:` 集中版本）。
- 涉及 LLM 的脚本一律从环境变量取凭据（如 `OPENAI_API_KEY`，评估用 `LLM_API_KEY`），仓库内不存任何 key。示例见 `packages/gi-agent/.env.example`。

## 血缘与许可

- 本项目基于 [piovium/genius-invokation](https://github.com/piovium/genius-invokation)（七圣召唤模拟器）的下游工作，遵循 **AGPL-3.0**（见 [`LICENSE`](./LICENSE)）。上游版权归原作者所有；本仓库新增部分同样以 AGPLv3 发布。
- 使用前请自行确认对游戏素材（卡牌图像、文本等）的合理使用范围。

---

## English

**GITCG-Bench** — an LLM-agent benchmark for *Genius Invokation TCG* (七圣召唤). This repository is a **code snapshot (v0, 2026-09)** of a reproducible pipeline that runs LLM agents over a fixed deck pool and scores their play under an **oracle-free / engine-only** evaluation protocol. Deliberately **not included**: the closed-source neural-network baseline bridge, the `@gi-tcg/ml` training subsystem, third-party copyrighted material (books, paper PDFs, official card art), and local agent/credential configuration. Licensed under **AGPL-3.0**; a downstream work of [piovium/genius-invokation](https://github.com/piovium/genius-invokation) (its own README is kept as `README.upstream.md`).
