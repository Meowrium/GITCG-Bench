# 基于 LLM 的七圣召唤卡组构筑工具设计讨论

> 从 llm-deck-analyzer 出发，逆向设计。"Decker" 项目的前期 architecture exploration。
> 状态：方案讨论阶段，未实现代码。待项目推进后重新评估。

## 1. 正向 vs 逆向流水线

```
正向（已有）:  deck code → decode → 卡牌数据 → LLM 分析 → 策略图
逆向（Decker）: 策略意图 → LLM 设计 → 选牌 → deck code
```

## 2. 核心挑战

### 2.1 搜索空间爆炸

| 维度 | 规模 |
|------|:--:|
| 角色池 | ~70+ 个角色 |
| 3 角色组合 | C(70,3) ≈ 54740 |
| 行动卡池 | ~300 张 |
| 30 张牌选择 | 组合数天文级 |
| 合法性约束 | 同名 ≤2、元素匹配、天赋只能带对应角色 |

### 2.2 LLM 的结构化局限在构筑场景下更致命

| 问题 | 分析场景（已解决） | 构筑场景（更难） |
|------|:--:|:--:|
| 卡池认知 | 只需理解已有的 30 张牌 | 需从 300+ 张中挑选 |
| 幻觉风险 | 可能编造卡牌效果 | **必定**编造不存在或效果错误的牌 |
| 验证难度 | 策略分析是主观的 | 构筑合法性是客观可验的 |

**演示暴露的问题**：让 LLM 直接为芭芭拉-凯亚-行秋配牌，它写出了"岩与契约"——一张不存在或效果完全不符的牌。这是 LLM 从训练数据中混淆了类似卡牌名。

### 2.3 同一角色组合存在多条合理构筑

芭芭拉-凯亚-行秋至少三套完全不同的 30 张牌：

```
构筑 A: 冻结控制  → 6 天赋 + 6 共鸣 + 骰子过牌拉满，长盘资源胜
构筑 B: 冻结节奏  → 少共鸣多装备 + 赌徒耳环，中期斩杀窗口
构筑 C: 混伤直伤  → 行秋主C + 凯亚后台 + 芭芭拉纯奶，走元素反应
```

这让"一套固定的构筑算法"本身就不成立——构筑是一个多目标优化问题，不同路线对应不同的卡牌选择。

## 3. 方案演进

### 3.1 方案 A: Package 权重打分（已否决）

```
LLM 给 10 个 package 打权重 → 规则引擎按权重填牌
```

**否决原因**：

- 同 package 内区分度为零。Package "骰子" 里最好的伙伴、一掷乾坤、换班时间、白垩之术对同一套构筑价值完全不同。
- 权重 0-10 的粒度无法表达"需要骰子牌但只需要转万能类型的，不需要充能类型的"。
- 覆盖面依赖 package 定义的穷举，新增 package 需要人工维护。

### 3.2 方案 B: 小型神经网络匹配（暂搁置）

```
card embedding → ranker (XGBoost/MLP) → 排序选牌
```

**搁置原因**：

- 训练数据严重不足。每套 tournament deck 仅有个位数对局记录。
- 无法学到"这张牌对这套构筑贡献多大"的可靠信号。
- 从零训练一个小型 NN 的 ROI 远低于规则+LLM 组合。

不排除未来在数据充足后重新评估。如果 tournament 数据随时间积累到每构筑百局级别，可以考虑 lightweight ranker。

### 3.3 方案 C: 策略假说 + 验证（当前方向，未实现）

```
LLM 生成多条策略假说 → 规则引擎每条生成一套牌 → self-play 互打验证 → LLM 看回放迭代
```

**原理**：不试图让 LLM"知道要什么牌"，而是让它生成可验证的假说，让模拟器排序。

**复用现有基础设施**：

| 模块 | 在 Decker 中的角色 |
|------|-------------------|
| `inferDeckRoles` | 角色定位（carry/enabler/protector/hybrid） |
| `buildStrategyNodesPrompt` | 策略假说生成（每种假说 = 一条 opening_line） |
| `effect-extractor` + trigger chain | combo 检测 → 规则引擎选中协同牌 |
| `ACTION_CARD_FUNCTION_TAGS` | 按功能过滤候选牌（骰子修正/治疗/装备/…） |
| `gi-ml-runtime` self-play | 假说互打验证 |
| `llm-deck-analyzer` | 分析回放 → 建议微调牌表 |

**未解决的核心问题**：

- self-play 验证的成本（每套假说需要若干局对打才能得出可靠结论）
- 假说生成的质量依赖 LLM 对角色理解的深度
- 迭代回环（打 → 分析 → 调牌 → 再打）是否收敛
- 是否需要"替代 self-play 的更快验证方式"

### 3.4 方案 D: 可检索的策略语言（补充思路）

```
LLM 输出策略约束（自然语言）→ 规则引擎检索匹配卡牌（确定性的，零幻觉）
```

**关键**：LLM 不碰卡牌名，只描述需求。所有卡牌名由规则引擎从 `cards-data`（官方数据源）确定性地产生。

```
LLM: "我需要 4-6 张帮助凑冰骰的牌，优先能转万能或重投的"
规则: → 查 FUNCTION_TAGS["dice_fixer"] 
     → 过滤：非冰水元素、充能相关
     → 排序返回
```

这本质上是 StrategyGraph 思路的延伸：LLM 做 what（语义意图），规则做 how（确定性映射）。

## 4. 为什么不现在实现

1. **self-play 验证成本高**——当前 pipeline 跑一次完整的 self-play + ranker + benchmark 需要 8-12 小时。
2. **策略假说质量不稳定**——StrategyGraph 刚通过两轮 LLM 实现，还需观察长尾质量。
3. **可检索策略语言需要 card metadata 补充**——`FUNCTION_TAGS` 的粒度可能不够，需要更细的卡牌特征标注。
4. **项目优先级**——当前重点是 RL 训练收敛和 benchmark 效果评估，Decker 属于辅助工具线。

## 5. 待推进后的补充方向

- [ ] 用 tournament 数据做 ground truth：召唤之巅 API 可提供真实高分构筑，作为验证基准
- [ ] 强化卡牌特征标注：从 `cards-data` 和 effect 文本提取更细粒度的功能标签
- [ ] 探索"不依赖 self-play 的快速评估"：轻量版 heuristic 评估（骰子预算、元素匹配度、combo 覆盖率）作为 self-play 的前置筛选
- [ ] 假说生成质量评估：同一角色组合不同 LLM 模型的假说多样性对比

## 6. 相关文件

- StrategyGraph 类型：`packages/llm-deck-analyzer/src/types.ts`
- 卡牌特征词汇表：`packages/llm-deck-analyzer/src/features/vocabulary.ts`
- 角色推断：`packages/llm-deck-analyzer/src/role-inference.ts`
- 效果提取器：`packages/llm-deck-analyzer/src/effect-extractor/`
- LLM 结构化局限文档：`packages/gi-agent/docs/llm-structural-limitations.md`
- 召唤之巅 API 技能：`gi-tcg/summoners-top-api`
