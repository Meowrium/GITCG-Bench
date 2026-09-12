# 七圣召唤 AI 战队系统开发计划书 v3.0

## 项目代号：GeniusInvocation-RT (Runtime & Research Team)
## 日期：2026-03-13

---

## 一、方案背景与架构演进（v2.0 → v3.0）

基于对实战对弈数据的诊断，发现现有评分系统存在根本性缺陷（线性加法无耦合、`actionBias` 常量主导结果、风险评估无量纲，导致无法逼近真实胜率）。因此，本项目在经过架构重估后，做出了以下核心路线调整：

1. **全栈 TypeScript**：消除原计划中的 Python 桥接层，AI Agent 和核心流程全部回归 TypeScript（monorepo内部直连），做到零通信开销与完美的类型系统复用。
2. **Phase 0 (评分系统重构) 最高优先级**：所有 Agent 的战术都受制于底层的动作评分。不修好评分基础，Agent 投入再多也是徒劳。
3. **监督学习约束**：七圣召唤决策空间巨大，纯自我对弈必然引发搜索空间坍缩。用高质量真实对局/自玩数据训练的监督学习（Logistic Regression）约束 Agent，避免陷入局部模式。
4. **延迟次要优化**：组合发现（`tactic-search`）和角色搜索（`eval-char-comb`）的补强将在 Agent 主框架企稳并积累足够对局数据后再进行。

---

## 二、总体架构设计（全栈 TypeScript）

### 2.1 整体架构

```text
packages/gi-agent/  (新建 @gi-tcg/agent TypeScript 包)
│
├── ScoringAgent (Phase 0 - 最高优先级)
│   ├── 数据获取：监督数据后续补上（初期可Mock/小规模试跑）
│   ├── 校准方法：使用 Logistic Regression 拟合特征与胜率的关系
│   └── 迭代目标：输出 Δwin_prob 作为核心评分指标
│
├── BattleAgent (Phase 1)
│   ├── 框架：@langchain/langgraph (版本强制锁定于稳定版，如 0.2.x)
│   ├── 节点：plan → reason → decide → execute → critic → loop
│   └── 交互：直接内部 import @gi-tcg/mcp 模块进行动作调用
│
├── DataPipeline (Phase 2)
│   ├── 数据源：前期 Mock/对弈数据 → 后期接 Server PostgreSQL (Game 表)
│   └── 持久化：基于 better-sqlite3 存储 (state, action, win_or_loss) 三元组
│
├── RDAgent (Phase 3)  
│   ├── 循环：败局分析 → 提取 L1 规则 → Logistic 回归重校准 → Sandbox 验证
│   └── 部署：KnowledgeBase 规则管理
│
└── SearchOptimizer (Phase 4 - 低优先级)
    └── 对已有的 eval-char-comb 和 tactic-search 算法进行改进
```

---

## 三、阶段与实施规划

建议分四个阶段推进，**Phase 0 为一切逻辑之基石**。

### Phase 0: 评分系统基础重构 【最高优先级】

**核心痛点**：当前 `FragmentResolver.ts` 的评分完全基于线性加法+硬编码偏置，造成高风险动作和低收益动作混淆。

**执行步骤**:

1. **构建校准 Pipeline**
   - 依赖监督学习数据：**受限于真实数据提取进度，监督数据后续补上**。
   - 前期先用本地 Sandbox 小规模运行产生的数据，或手动挑选典型局部做打分；后期接入 Server Database 做批量导入。
   - 将现有局面特征（HP差、能量Gap、行动类型等）导出为 JSON Lines。
2. **Logistic Regression 校准器**
   - **统一定义评分校准算法**：采用 **Logistic Regression**，将上述特征映射到 `0~1` 胜率贡献值。通过回归系数直接取代现有源码中的魔数。
3. **基于 Agent 的公式改写**
   - R&D 智能体（或在此阶段由开发者主导）将原有的 `total = strategyMatch + localGain - riskPenalty` 加减法逻辑，修改为“阶段门控（过滤极危动作） + 收益乘法（风险系数作为折扣）”。
   - 更新 `packages/mcp/src/scoring/` 目录下的评分模块代码。
4. **A/B 单元验证**
   - 新旧打分机制使用模拟局对比验证，保证胜率正相关（不再偏好高风险低端动作）。

---

### Phase 1: BattleAgent 原型落地 【高优先级】

基于新的评分基准，搭建 AI 大脑进行实际对战。

**执行步骤**:

1. **环境与核心库设置**
   - `cd packages/gi-agent` 并初始化包。
   - 安装依赖：**锁定 `@langchain/langgraph` 以及 `@langchain/core` 版本，防止 API 漂移**导致图结构执行失败（推荐锁定至 `0.2.20` 或当前最新稳定兼容版）。
2. **组装 BattleGraph**
   - 实现状态机（StateGraph）：包含从计划提出、语义推断、动作决策到批判反馈的核心循环。
3. **实现执行引擎连接**
   - 编写 `battle-agent.ts` 入口，直接加载 `@gi-tcg/core` 驱动对局。绕过 HTTP MCP Server，直连 `StandaloneMcpToolHandler`。
4. **运行测试**
   - AI 挑战随机 Agent，进行压测和可用性测试。

---

### Phase 2: 数据闭环与知识库沉淀 【中优先级】

积累对局数据，反哺 Logistic Regression 训练。

**执行步骤**:

1. **DataLake 储能**
   - 使用 `better-sqlite3` 实现游戏动作的三元组长期记录（`state`, `action`, `win_loss_label`）。
2. **监控服务（Monitor）**
   - 编写脚本持续解析对战过程中产生的 `runtime-plans/` JSON，落库用于下一步机器分析。
3. **沉淀常识**
   - 初步集成 L1 (专家规则) 与 L2 (特定卡组节奏)，存储于当前 Agent 独立可读的知识库内。

---

### Phase 3: R&D 自动迭代 【中优先级】

由 R&D Agent 定期接管训练与调优环节。

**执行步骤**:

1. **分析败局并更新 Logistic 权重**
   - 读取 Phase 2 中落局和落败的场景特征对，重新拟合模型得到新的 Logistic Regression 权重组。
2. **沙盒 A/B Test**
   - 在独立的 Sandbox Runner（纯 TS 进程级多线程并发）中对跑：新权重版 BattleAgent vs 旧版。
   - 胜率显著提升则部署代码覆盖。
3. **L1 规则萃取**
   - 使用 LLM 分析败局文字日志，抽象出"禁止切人"等硬防范规则。

---

### Phase 4: 搜索算法体系修复 【低优先级】

等 Agent 能自我对战并产生可靠分析维度后，再处理配套工具的积弊。

**执行步骤**:

1. **组合发现扩容 (`tactic-search`)**
   - 重构 Beam Search 剪枝逻辑。用 Phase 3 获取的实际常见搭配为准绳，排查丢包原因。
2. **角色评估矫正 (`eval-char-comb`)**
   - 基于庞大的对战数据真实胜率，而非静态理论值，去重新拟合角色的“反应覆盖率”、“冲突兼容性”。

---

## 四、项目资源架构清单

在新建的 `packages/gi-agent/` 中将主要包含：

```text
packages/gi-agent/
├── package.json                   # 强制锁定 langgraph 等底层库版本
├── tsconfig.json          
├── src/
│   ├── index.ts
│   ├── agents/
│   │   ├── battle-agent.ts        # 实战 AI 入口 (BattleGraph)
│   │   ├── rd-agent.ts            # 策略研发 AI 入口
│   │   └── scoring-auditor.ts     # 评分迭代触发器
│   ├── graphs/
│   │   ├── battle-graph.ts        # 控制对战的 LangGraph 工作流
│   │   └── rd-graph.ts            # 控制迭代分析的工作流
│   ├── ml/
│   │   └── logistic-reg.ts        # 评分修正逻辑 (Phase 0) 监督数据后续补上
│   ├── db/
│   │   ├── extractor.ts           # 从 Server PostgreSQL 获取记录
│   │   └── data-lake.ts           # 本地 SQLite 持久化
│   └── sandbox/
│       └── runner.ts              # A/B验证高频运行环境
└── plan-v3.md                     # 本文：Agent 记忆文件存档
```