# Fragmented Decision Route Overview

## 背景

当前系统虽然已经具备：

- `auto_select_skills`
- `create_opening_plan_v1`
- `create_opening_plan_v2`
- `create_decision_shard_v1`
- `critic_evaluate_v1`

但动作执行阶段仍然由 AI 直接读取状态并调用：

- `choose_action`
- `choose_active`
- `reroll_dice`
- `switch_hands`
- `select_card`

因此现状不是“片段化决策 -> 本地执行”，而是“计划 artifact -> AI 直接执行动作”。

## 目标

将链路改造成三层：

1. 战略层
   - 负责开局计划、技能偏好、风险边界、资源原则
2. 决策片段层
   - AI 只输出语义化决策片段，不输出具体动作索引
3. 本地执行层
   - 本地程序结合候选动作、局面特征、策略约束，选出最终动作并执行

## 核心原则

1. AI 不直接掌握动作执行权
2. 本地程序独占合法性判断与最终动作映射
3. 对 AI 压缩的是观察面和输出格式，不是长期战略信息本身
4. `critic` 优先评估“决策片段质量”，不是评估“模型点了第几个动作”

## 为什么这条路线更适合七圣召唤

- 七圣召唤的单步决策存在长程耦合，无法粗暴降维成极短规则列表。
- 但每个时点的候选动作集合是有限的，适合交给本地程序做最后一跳的约束求解。
- 这样可以同时保留长期战略信息与本地执行稳定性。

## 当前偏差

当前 `decision shard` 仍然只是 artifact，而不是执行权威对象：

- shard 的 policy 最终仍指向 `choose_action`
- `tactic-e2e.ts` 在 reasoner 后直接调用动作工具
- standalone bridge 接收的是具体动作索引，而不是抽象决策意图

## 目标状态

目标状态下，AI 的输出应类似：

- 当前意图：保节奏
- 资源策略：平衡消耗
- 优先级：元素附着 > 高效率技能 > 低价值过牌
- 避免：暴露核心角色、无收益烧万能骰
- 兜底：若没有正收益动作则结束回合

而不是：

- 选择第 3 个动作
- 使用 `[0, 0, 1]` 这些骰子