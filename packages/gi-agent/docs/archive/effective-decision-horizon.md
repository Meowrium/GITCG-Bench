# 策略进化度量：有效决策视界

> 日期: 2026-05-22
> 状态: 理论框架
> 关联: V25 实验、branch-eval 分析

---

## 1. 核心概念

策略从"普攻对撸"进化到"复杂博弈"的本质：**每一步决策的有效时间视界在变长**。

量化指标：**有效决策视界 h_eff**

---

## 2. 操作化定义

### 2.1 规划深度必要性 D(S)

对同一决策点，用两种评估方式：

```
V_immediate(a) = 一步后的即时收益（伤害 + 治疗 + 反应）
V_terminal(a)  = 五步 continuation 后的终局胜率
```

定义：

$$D(S) = \frac{|\text{topK}(V_{immediate}) \cap \text{topK}(V_{terminal})|}{K}$$

- D ≈ 1.0：短视策略足够，即时收益已经能选出正确动作
- D ≈ 0.2：必须长视界才能选出好动作

### 2.2 全局指标：Rank Correlation

从 self-play replay 中直接计算：

```
corr(V_immediate, V_terminal)
```

- 高（>0.7）：谁打得多谁赢，短视阶段
- 中（0.4-0.7）：学到了部分 setup→cashout 链
- 低（<0.4）：大量长视界决策

### 2.3 进步判据

关键不是 corr(V_immediate, V_terminal) 是否变低（越低=越长视界），
而是 **corr(V_model, V_terminal) 是否变高**：

| 指标 | V15 | V20 | V25 | 人类 |
|------|-----|-----|-----|------|
| corr(V_model, V_terminal) | 0.45 | 0.55 | 0.65 | 0.80? |
| corr(V_immediate, V_terminal) | 0.80 | 0.65 | 0.50 | 0.35? |

两列应该反向走——说明模型学到了即时收益之外的东西。

### 2.4 游戏天然下限

七圣总 HP 有限，伤害总会导致胜利，所以 corr(V_immediate, V_terminal) 不会趋近 0。天然下限约 0.3-0.4——比围棋高（HP 硬约束），但比纯数值游戏低。

---

## 3. 决策空间收缩：H(S) 和 n_eff

跨回合的决策空间收缩不是"合法动作数"的变化，而是"有效动作的价值分布"的集中。

### 3.1 决策熵

$$H(S) = -\sum_{a \in A(S)} p(a|S) \cdot \log_{|A|}\, p(a|S)$$

$$p(a|S) = \frac{\exp(V(a,S)/\tau)}{\sum_{b}\exp(V(b,S)/\tau)}$$

归一化：[0, 1]。1.0 = 所有动作等价，0 = 只有一个动作值得选。

### 3.2 有效动作数

$$n_{\text{eff}}(S) = |\{a \in A(S) : V(a,S) > \max V - \delta\}|$$

**n_eff = 1 的时刻是从博弈变成执行的临界点。**

### 3.3 优势

不需要硬编码回合数，H(S) 和 n_eff(S) 自动适应：
- 快攻卡组 → 早收缩
- 控制卡组 → 晚收缩
- 从 branch-eval 数据直接标定，自涌现特征

---

## 4. 实施路径

### Phase 1: 数据分析（v22 完成后）

1. 对 v22 的 branch-eval 数据，每个决策点计算 H 和 n_eff
2. 画 `H × round` 散点图 → 验证跨回合收缩
3. 画 `H × matchup_type`（快攻 vs 控制）→ 验证卡组区分度
4. 从 self-play replay 计算 `corr(V_immediate, V_terminal)` 按训练轮次

### Phase 2: 特征化

如果 H(S) 对卡组有区分度：
- 单特征替代 4-5 处散落的 round-based heuristic
- 可直接喂入 GBDT

### Phase 3: 策略进化追踪

- 每轮 self-play 后自动计算 corr(V_model, V_terminal)
- 追踪这个值的增长趋势 → 判断策略是否在真正进步

---

## 5. 相关概念

- **V_immediate**: 一步动作的即时收益（damage, healing, reaction, energy）
- **V_terminal**: 该动作所在对局的终局结果（win/loss/draw）
- **V_model**: GBDT/ranker 给出的 value 估计
- **D(S)**: 规划深度必要性——需要长视界的程度
- **H(S)**: 决策熵——动作价值分布的均匀程度
- **n_eff(S)**: 有效动作数——比最优动作不差超过 δ 的动作数
