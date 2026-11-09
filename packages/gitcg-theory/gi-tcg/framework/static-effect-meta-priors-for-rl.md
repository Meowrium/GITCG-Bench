# Static-Effect Meta Priors For RL

这份文档提出一个候选方向：

- 不让 RL 重新从黑盒试错中“发现”每张牌的静态效果
- 而是把 `packages/data/src` 中已经存在的静态卡牌效果，整理成更高层、可迁移的元认知先验
- 再把这些先验注入 observation、candidate、concept、warm start 和 self-play 流程中

它不是要求改变规则执行权，也不是要求让模型直接解释 DSL。
相反，它承认以下边界：

- 规则正确性仍然由模拟器和 `@gi-tcg/core` 保证
- 牌面效果的具体执行仍然由 `packages/data/src` 决定
- 学习系统只负责利用这些静态知识形成更好的抽象、泛化和样本效率

## 一、当前问题的更精确定义

当前 RL 流程已经不是纯黑盒：

- observation 中已有不少 derived 特征
- candidate 中已有 `rule_tags`、cost、family、definition id 等摘要
- ranker / value 也已经在消费这些摘要后的局面结果

但它仍然没有充分利用“静态效果语义本身”。

现在的流程更接近：

- 学习“这个局面看起来像赢”
- 学习“这个动作在历史上经常更好”

而不是系统化地学习：

- “这是一个一次性爆发增伤效果”
- “这是一个短期减费换 tempo 的效果”
- “这是一个延迟治疗 / 延迟续航效果”
- “这是一个制造切人窗口或爆发窗口的效果”
- “这是一个展开资源、压缩骰子、提高后续动作密度的效果”

也就是说，当前抽象层更偏“统计相关”，还没有稳定进入“效果类型与策略意图”的元认知层。

## 二、推荐方向

推荐把静态卡牌效果整理成三层先验，并按由浅到深的顺序接入。

### 2.1 第一层：Static Effect Family

这是最便宜、最稳定、最容易泛化的一层。

把卡牌和技能的静态效果归入少量跨牌共享的效果族，而不是只保留 `definition_id`。

推荐先从以下族开始：

- `direct_damage`
- `damage_buff_once`
- `damage_buff_window`
- `damage_reduction_once`
- `damage_reduction_window`
- `heal_now`
- `heal_over_time`
- `energy_gain`
- `cost_reduce_skill`
- `cost_reduce_switch`
- `dice_fix`
- `draw_cards`
- `summon_create`
- `support_create`
- `reaction_enable`
- `burst_enable`
- `revive`
- `force_switch`
- `future_random_value`
- `card_generation`

目标不是追求完整语义，而是先形成跨卡共享的“功能桶”。

### 2.2 第二层：Tempo / Window / Resource Meta Slots

在效果族之上，再进一步把静态效果折算为更贴近策略层的中间变量。

推荐优先抽取：

- `tempo_gain_now`
- `tempo_gain_next_window`
- `burst_window_enable`
- `reaction_window_enable`
- `survival_swing`
- `resource_conversion_score`
- `action_density_gain`
- `stability_gain`
- `finisher_alignment`
- `setup_dependency`

这层不要求从牌面直接精算到真实胜率，而是提供“策略上大致在做什么”的中间语义。

### 2.3 第三层：Concept Seeds

把前两层先验作为 concept discovery 的 seed，而不是完全依赖 replay / branch-eval 事后聚类。

例如：

- `concept:buff-window:normal-attack-once`
- `concept:burst-window:enabled`
- `concept:healing-bridge:two-turn`
- `concept:dice-tempo:skill-cost-reduced`
- `concept:delayed-value:random-choice-card`

这样 concept bank 就不只是“从行为里倒推模式”，而是“用规则语义提出候选，再用行为数据验证价值”。

## 三、为什么这会加速 RL

### 3.1 缩短从单卡到泛化策略的路径

如果模型只看到 `definition_id=333001`，它需要自己从大量对局中慢慢学会：

- 这是增伤
- 这是一次性
- 主要影响普通攻击
- 它在某些窗口比直接伤害更值

如果改为同时看到：

- `damage_buff_once`
- `normal_attack_alignment`
- `tempo_gain_next_window`

那么不同卡之间可以共享样本。

这会把学习难度从“记住每张牌的经验”转成“学习一类效果何时有价值”。

### 3.2 提高版本迁移和新卡泛化

牌池变化时，最脆弱的是基于 card id 的经验。
最稳定的是基于效果族和策略角色的经验。

新卡只要落入已有族谱：

- 即使 definition id 从未见过
- 模型也能继承已有的 effect-family prior

这比纯 replay 记忆更接近真正的元认知。

### 3.3 帮助 self-play 早期摆脱稀疏终局信号

RL 早期最常见的问题是：

- 终局信号太晚
- 局面价值头过于粗糙
- ranker 只能学到浅层强相关特征

如果 static effect meta slots 能在动作发出时提供一些稳定的中间表征，模型会更早知道：

- 哪些动作是在开窗口
- 哪些动作是在买生存
- 哪些动作是在把当前资源换成后续动作密度

这会让 warm start 和 self-play 都更稳。

## 四、三个最值得优先做的入口

### 4.1 入口 A：Effect Family Table

这是第一优先级。

做法：

- 为 card / skill / summon / support / status 定义静态效果族标签
- 将这些标签通过稳定表或离线导出器暴露给训练数据

优点：

- 成本最低
- 与现有 observation / candidate contract 最兼容
- 泛化收益最大

缺点：

- 语义还比较粗
- 不能自动表达上下文依赖

### 4.2 入口 B：Meta Slot Compiler

第二优先级。

做法：

- 从 effect family 和已知规则字段编译出少量数值化 meta slots
- 例如“立刻 tempo”“下个窗口收益”“续航摆动”“减费强度”“随机性/延迟性”

优点：

- 直接服务 value / ranker
- 可与现有 derived features 并列

缺点：

- 需要小心避免和 reward shaping 重复计分
- 需要版本化和单测

### 4.3 入口 C：Concept Seed Pipeline

第三优先级。

做法：

- 用 effect family 和 meta slot 自动生成 concept hypothesis seed
- 再由 branch-eval / self-play 数据做 predictability 和 ranking gain 验证

优点：

- 能把静态知识和概念学习真正打通
- 更容易形成可解释在线输出

缺点：

- 工程面更长
- 需要 concept validation 机制更成熟

## 五、推荐的数据接入位置

### 5.1 Observation

在 state-level observation 里加入：

- 当前我方手牌的 effect family 计数
- 当前我方可用动作对应的 effect family 分布
- active character 与 hand/summon/support 的策略协同计数
- effect-family 聚合后的 tempo / sustain / burst / reaction meta slots

注意：

- 不要求把每张手牌完整展开成大 one-hot
- 更推荐做聚合计数或 top-k public/private summaries

### 5.2 Candidate

对每个 candidate 加入：

- `static_effect_tags`
- `meta_effect_slots`
- `synergy_slots`

例如：

- 是否直接带来治疗
- 是否减少技能费用
- 是否给当前 active 创造爆发窗
- 是否偏 setup 而非即时兑现

### 5.3 Concept Bank

把 static effect family 当作 concept seed source：

- 一部分 concept 由语义模板直接提出
- 一部分 concept 仍由 replay / combat-window 发现

这样 concept bank 会同时具备：

- top-down 的规则语义候选
- bottom-up 的行为统计候选

## 六、验证标准

这个方向值不值得继续，建议看以下四类指标。

### 6.1 样本效率

- warm start 收敛速度是否更快
- self-play 前几个 checkpoint 是否更稳定

### 6.2 泛化

- 新卡或变体卡加入后，是否更容易迁移
- 跨 matchup 的性能方差是否下降

### 6.3 可解释性

- 模型高分动作是否能用 effect family / meta slot 解释
- 错误样本是否更容易定位为“效果误读”还是“窗口误判”

### 6.4 去重

- 是否减少了对单卡 id 的过拟合
- 是否提升了“同类效果不同牌”之间的共享学习

## 七、实现约束

这个方向应遵守以下约束：

- 不把规则执行权移出模拟器
- 不要求在线模型直接解析 DSL
- 不把卡牌 description 文本直接当作第一版核心输入
- 不与 reward shaping 重复记账
- 所有 static meta features 都需要版本号和可回放生成逻辑

## 八、推荐的最小可行方案

第一版最小可行方案建议只做以下内容：

1. 建立 `effect family` 标签表
2. 为 candidate 导出 `static_effect_tags`
3. 为 observation 导出少量聚合 `meta slots`
4. 在 warm start ranker / value 中做 ablation

先不要做：

- 复杂文本 embedding
- 大规模 card-id one-hot 主导训练
- 过度精细的手写效果打分系统

正确方向应该是：

- 先建立便宜、可迁移、跨牌共享的先验
- 再观察它是否真的改善样本效率和泛化

## 九、与现有系统的关系

这个方案不替代现有 observation derived features，也不替代 concept discovery。

它更像是补上一条长期缺口：

- 当前系统已经会看“局面结果”
- 但还不够会看“这些局面结果背后的静态功能语义”

如果这条线做成，RL 学到的将不只是某些 card id 的历史偏好，而是更像：

- 什么时候该买 tempo
- 什么时候该买续航
- 什么时候该开 burst / reaction window
- 什么时候 setup 值得压过即时兑现

这才更接近“利用静态效果形成元认知加速学习”。
