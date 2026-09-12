# Migration Plan

## 阶段 1：锁定工具边界

### 目标

禁止 AI 直接使用动作工具。

### 实施项

1. 改写 `prompt.txt`
2. 增加 tool exposure mode
3. 在 fragmented 模式下隐藏：
   - `choose_action`
   - `choose_active`
   - `reroll_dice`
   - `switch_hands`
   - `select_card`

### 验收

1. AI 侧无法直接看到动作工具
2. 老的 direct-action 模式仍可保留为兼容模式

## 阶段 2：补齐新契约

### 目标

引入 digest / fragment / feedback 三类 artifact。

### 实施项

1. 新增 `get_turn_digest_v1`
2. 新增 `submit_decision_fragment_v1`
3. 新增 `get_execution_feedback_v1`
4. 为 artifact 增加统一落盘路径

### 验收

1. 单个决策点可产生完整的三段式 artifact 链路
2. 无需暴露动作工具即可完成一次完整决策闭环

## 阶段 3：落地本地 resolver

### 目标

将 fragment 映射为最终动作。

### 实施项

1. 建立 candidate featurizer
2. 建立线性评分模型
3. 接入 standalone bridge 执行层
4. 接入失败回退链

### 验收

1. resolver 能处理 `action`
2. resolver 能处理 `chooseActive`
3. resolver 的日志可复盘

## 阶段 4：重构 e2e

### 目标

让 `tactic-e2e.ts` 演示完整 fragmented 流程。

### 实施项

1. 用 `get_turn_digest_v1` 替代直接读完整状态
2. 用 `submit_decision_fragment_v1` 替代 `chooseReasonedAction`
3. 用本地 resolver 完成最终执行
4. 用 `ExecutionFeedbackV1` 喂给 `critic_evaluate_v1`

### 验收

1. e2e 日志中不再出现 AI 直接调用动作工具
2. e2e 日志中出现 digest / fragment / feedback 三类 artifact

## 阶段 5：灰度与回滚

### 目标

降低改造风险，保留 direct-action 回退路线。

### 实施项

1. 增加运行模式开关：
   - `direct-action`
   - `fragmented-decision`
2. 新模式先用于本地测试与少量对局
3. 记录胜率、非法动作率、超时率、token 消耗

### 验收

1. 新旧模式可切换
2. fragmented 模式不会明显增加非法动作率
3. token 消耗相较 direct-action 有可测下降

## 实施顺序建议

建议严格按以下顺序推进：

1. 工具边界
2. 数据契约
3. 本地 resolver
4. e2e 重构
5. critic 收敛

不要先做复杂 resolver，再回头补工具边界。否则系统仍会继续走老路径。