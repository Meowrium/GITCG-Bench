# RESOURCES.md — 外部资源清单

## 项目内部文档（可优先阅读）

### AGENTS.md
- `packages/gi-agent/AGENTS.md` — 包结构契约，CLI 入口表，依赖方向，公共 API

### gi-agent docs/
- `docs/INDEX.md` — 文档索引
- `docs/READEME.md` — 包总览
- `docs/v26-ai-architecture-recommendations.md` — 架构建议（第 26 版复盘）
- `docs/v28-gi-agent-ml-review-and-improvement-plan.md` — ML review
- `docs/combat-window-pipeline.md` — 局部窗口树流水线
- `docs/plans/2026-04-08-hidden-constraints-analysis.md` — 隐式约束分析
- `docs/plans/2026-04-24-skill-to-execution-gap.md` — 技能到执行的 gap

### Archive docs（项目演进历史，可过后再看）
- `docs/archive/` 下的各种 v5-v25 复盘文档
- 按需翻阅

### 相关包
- `packages/gi-ml/` — ML 概念库、ranker、value artifact 训练（被 gi-agent 依赖）
- `packages/core/` — 游戏引擎核心
- `packages/mcp/` — MCP 服务（已学过）

## 外部参考

### MCTS
- [Monte Carlo Tree Search - Wikipedia](https://en.wikipedia.org/wiki/Monte_Carlo_tree_search)
- [A Survey of Monte Carlo Tree Search Methods](https://ieeexplore.ieee.org/document/6145622) (Browne et al.)
- [Information Set Monte Carlo Tree Search](https://www.austintek.com/mcts/) (ISMCTS, for imperfect information games)

### 强化学习
- [Sutton & Barto - Reinforcement Learning: An Introduction](http://incompleteideas.net/book/the-book-2nd.html)
- [Self-Play RL in Games - AlphaGo, AlphaZero](https://deepmind.google/discover/blog/alphazero-shedding-new-light-on-chess-go-and-shogi/)

### TypeScript 程序架构
- TypeScript 设计模式（你的 MCP 课里已经学过的：抽象类、模板方法、IPC、协议分层）
- Node.js Event Loop (process.stdin, async/await)

## 社区
- [七圣召唤非官方 Discord / QQ 群] — 暂时不需要
