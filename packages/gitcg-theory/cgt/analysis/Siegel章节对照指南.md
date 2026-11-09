# Siegel《组合博弈论》× 七圣召唤 章节对照指南

## 为什么选 Siegel

Siegel (2013) 是现代 CGT 的标准教材——每章有严格的定义→定理→证明，且有 Domineering/Go/Dots-and-Boxes 的完整应用案例。和 Conway ONaG (1976) 比：Siegel 更算法化、更可工程化。

---

## 第一章：CGT 基础

### §1.1–1.3: 游戏定义、和、等价
- **核心**: G = {G^L | G^R}，disjunctive sum G+H
- **七圣映射**: 每个决策点是一个 game position。子局面（角色 A vs 角色 B，骰子 d 颗）= G = {L1, L2, ... | R1, R2, ...}
- **实验**: 提取 branch-eval 中每个 decision point 的 options 值分布。Left/Right 值域重叠大 → 温度低（冷）

### §1.4: 结果分类（L, R, N, P）
- L-position = 我方必胜
- R-position = 对方必胜
- N-position = 先手必胜（**高温局面**——CGT 重点关注）
- P-position = 后手必胜（低温局面）

**实验**: benchmark 数据上对每个 matchup 统计 outcome distribution。如果 matchup 总是 sideA 赢 → L-position（牌组相克）。双向均匀 → N-position（取决于操作）

---

## 第二章：群结构

### §2.1: 游戏群
游戏在 disjunctive sum 下构成 Abel 群。

**工程应用**: 等价性 → transposition table。如果 G=H（G+(-H) 是 P-position），搜索中到达一个就够。

### §2.2: 简化（Canonical Form）
两条简化规则：

**1. Dominance 淘汰**
如果 G^L1 ≥ G^L2，删除 G^L2（被压制的选项不需要考虑）

**2. Reversibility 绕过**
如果 G^LR ≤ G，用 G^LRR 替换 G^L（对手能廉价抵消的行动 → 跳过，直接用反制后的选项）

**伪代码**（可直接工程化）：
```
canonicalOptions(G):
  // 1. 删被压制的
  options = options 中不被其他 option 严格优于的
  
  // 2. 绕过可逆的
  for 每个 option:
    检查对手最优回应后局面是否 ≤ 原局面
    如果是 → 用反制后的 Left options 替换这个 option
  
  return 精简后的 options
```

**实验**: 在 branch-eval 数据上统计：被删除 options 占比 + top-1 变化率

---

## 第三章：数与游戏（最关键）

### §3.1: Numbers
**定义**: 一个游戏是 number ⇔ 它是"冷的"（所有 L options < 所有 R options，且每个 option 也是 number）。Numbers 没有先手优势。

**七圣判据:**
- **Number-like（冷）**: 所有可选行动中，对手最优回应的净收益 ≤ 当前局面的 heuristic 值。等价于：对手能造成的**最大潜在伤害**不改变局面分类（不会击杀角色、不会迫使必须切人、不会打断关键反应链）。**不是固定 HP 阈值，需要计算对手的可能输出**。
- **Not-number（热）**: 存在对手行动能显著改变局面（击杀、破反应链、抢占先手权）。**元素爆发未必指向你的残血角色**——需判断 burst 的真实目标（可能是叠层、清场、控场）。

### §3.2: Number Avoidance Theorem
**定理**: 在一个不交和中，你不需要在 number 组件上行动。Numbers 不影响最优策略。

**直接推论**: AI 不需要在冷子游戏上搜索。Focus 只在 hot components 上。

**实验**: 按 temperature 二分七圣局面 → 冷子游戏用 heuristic，热子游戏用 MCTS。预测搜索时间减 40-50%，决策质量不变。

### §3.3: Simplicity Rule
一个游戏的值 = 它两侧最简单的 number。

**工程化**: value model 不用输出连续值 → 分类输出（大优/小优/均势/小劣/大劣），更稳定、更容易训练。

---

## 第四章：温度理论

### §4.1: Thermograph
- L_G(t) = max_{G^L} (G^L 的 thermograph，冷却 t)
- 随 t 增大 → 收敛到一点 = mean

**七圣应用**: 对每个 character pairing（如迪卢克 vs 行秋），离线预计算 thermograph。像 Domineering 的终局数据库——小到可穷举，组合起来覆盖大部分实战。

### §4.2: Temperature as Urgency
**定理** (Siegel 4.12): t(G+H) ≤ max(t(G), t(H))

**推论**: 多个角色可选时，只需在温度最高的角色上深搜，其他浅搜或 heuristic。

### §4.3: Mean Value
每个游戏有唯一的 mean m(G)。mean 代表"去掉所有 urgency 的基本面"。

V(s) = mean(s) + 先手方额外优势

---

## 第五章-第六章：应用案例

### Domineering → 角色对战数据库
Domineering 分解为独立 columns → 七圣分解为独立角色对战。
- 枚举 2v1 子局面（场上角色 vs 场上角色，有限骰子）
- 计算 canonical form
- 建 lookup table
- 实时查表，只在无法匹配时搜索

### Dots-and-Boxes chains → 元素反应链
长链给先手优势，短链给后手优势。七圣中"上火→蒸发→再上火→再蒸发"的 chain 长度决定谁占优。

---

## 四个立即可做的实验

### Exp 1: Number/Non-number 分类器（~80 行）
- 对每个 decision point 计算对手的**最大潜在伤害**（考虑骰子、元素、反应加成、装备 buff）
- 如果最大潜在伤害不改变局面分类（不击杀、不迫使切人、不断反应链）→ Number-like，跳过搜索
- 验证：branch-eval 数据上统计 Number-like 占比 + heuristic 与 MCTS 选择一致性
- **假说**: >50% 的 decision points 是 Number-like 的；在这些 points 上 heuristic 和 MCTS top-1 一致性 >90%
- **修正说明（2026-05-24）**: 不再用固定 HP=3 阈值；改为计算对手**实际可打出的最大伤害**，且 Burst 需判断真实目标（非必然击倒残血角色）

### Exp 2: Domination + Reversibility 剪枝
- benchmark replay 上跑 domination + reversibility check
- 统计被剪 actions 占比 + 是否包含 top-1 选择
- **假说**: 可剪 30-40% options，top-1 命中率 >95%

### Exp 3: 温度加权搜索
- MCTS 不同节点不同 sim 数（基于 temperature）
- 和 uniform sims 比较同总 sim 数下的 win rate
- **假说**: temperature-weighted 在高温节点找更好动作

### Exp 4: 预计算 Thermograph DB
- 选 3 个最常见 matchup，穷举子局面 + canonical form
- 构建 10K-50K 条 lookup table
- 在 benchmark 中替换 MCTS leaf eval
- **假说**: 查表速度 100x，决策质量持平或略优

---

## Siegel vs Conway 差异

| | Siegel (2013) | Conway ONaG (1976) |
|---|---|---|
| 风格 | 教科书，定义→定理→证明 | 开创性论文，直觉驱动 |
| 应用案例 | Domineering/Go/D&B 完整计算 | 较少 |
| 可工程化 | ⭐⭐⭐⭐⭐ 每章有练习和算法 | ⭐⭐⭐ 需自己翻译成算法 |
| Temperature | 完整一章 + 计算示例 | 分散在多处 |
| Canonical form | 详细算法 | 概念性描述 |

**阅读建议**: Siegel 给数学框架和算法，Winning Ways 给直觉和案例。两本互补。
