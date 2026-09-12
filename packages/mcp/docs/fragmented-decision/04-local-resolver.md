# Local Resolver Design

## 目标

本地 resolver 负责把 `DecisionFragmentV1` 映射为具体动作，并独占最终执行权。

## 输入

1. 当前 pending RPC
2. `TurnDigestV1`
3. `DecisionFragmentV1`
4. 当前候选动作列表
5. 当前战略 profile

## 输出

1. 最终选中的 candidate
2. 实际执行工具与参数
3. `ExecutionFeedbackV1`

## 责任边界

resolver 负责：

1. 候选动作合法性检查
2. 本地特征提取
3. 按 fragment 约束对候选动作打分
4. 执行失败时的本地回退

resolver 不负责：

1. 长期战略生成
2. 技能文档检索
3. 开局计划生成
4. 用户可读解释的大段推理

## 最小评分模型

建议使用线性打分起步：

`total_score = strategy_match + local_gain - risk_penalty - resource_penalty`

### strategy_match

由以下信息贡献：

- `intent`
- `must_do`
- `avoid`
- `preference_order`

### local_gain

由以下候选动作特征贡献：

- 伤害收益
- 元素附着或反应价值
- 充能收益
- 换位收益
- 节奏收益

### risk_penalty

由以下因素贡献：

- 暴露核心角色
- 破坏后续连段
- 将 HP 压到风险阈值以下
- 高投入低收益

### resource_penalty

由以下因素贡献：

- 万能骰浪费
- 超过 `resource_policy`
- 不必要的卡牌损耗

## 失败恢复

resolver 应优先本地恢复，不立刻重新问 AI。

推荐顺序：

1. 过滤非法候选动作后重排
2. 应用 `fallback_rule`
3. 选择低风险保守动作
4. 若确实无正收益动作，再执行结束回合类动作

## 调试输出

建议固定记录：

- 输入 digest 摘要
- 输入 fragment 摘要
- 每个候选动作的分项得分
- 最终选择原因
- 是否触发 fallback

## 验收标准

1. AI 不提供动作索引时，本地仍可稳定执行
2. 同一 `DecisionFragmentV1` 对相同 digest 应产生可复现结果
3. 非法动作不会传递到 standalone bridge
4. 日志足够支持复盘与 critic 使用