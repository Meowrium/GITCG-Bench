# V7 MacroPlan Benchmark — 深度诊断与修正方案

> 日期：2026-05-06 | 模型：V7 ranker + GBDT value | 配置：temperature=1.5, macroPlanWeight=0.6, tempoValueWeight=0.3
> 基准线：V5 baseline (temperature=1.2, adaptiveProfile=true)

## 总结果

| 指标 | 值 |
|------|:--:|
| 总对局 | 320 (64 matchups × 5) |
| 平均胜率 | **51.88%** |
| 历史对比 | V3 56.4% > V7 **51.9%** > V4+Plan 47.5% > V4-only 34.4% |
| 平均回合 | 7.64 |
| 平均耗时 | 74s/局 |

## 各卡组表现

| 卡组 | 胜率 | 评价 |
|------|:----:|------|
| HongNiu (红牛) | **65.0%** | R1三连击即可赢；但链式切人会导致惨败 |
| ShuiZhai (水债) | **60.0%** | 受益于 macroPlan 的中速部署 |
| LeiLang (雷狼) | 55.0% | 中上 |
| ShenXiao (神宵) | 55.0% | 中上 |
| ShuiNing (水凝) | 55.0% (6平) | 镜像三平局，14轮拉锯 |
| ShuiBa (水八) | 50.0% | 持平 baseline |
| MoYou (莫优) | 42.5% | 偏弱 |
| **LeiHe (雷鹤)** | **32.5%** | **系统性崩盘** |

---

## 一、LeiHe 崩盘：卡牌过打 + 链式切人

### 数据

| 对手 | LeiHe V7 | Baseline 对手 | 核心差距 |
|------|:---:|:---:|---|
| vs ShuiZhai | skills=12 **plays=8** sw=4 | skills=12 plays=4 sw=7 | plays 多 1 倍 |
| vs LeiLang | skills=14 **plays=10** sw=6 | skills=14 plays=5 sw=11 | plays 多 1 倍 |
| vs HongNiu | skills=17 **plays=7** sw=3 | skills=17 plays=3 sw=7 | plays 多 1 倍+ |
| vs ShuiBa | skills=12 **plays=7** sw=5 | skills=11 plays=4 sw=11 | plays 多 75% |

**规律：LeiHe V7 的 skill 数量与对手持平，但 play 数量始终是对手的 1.7-2.3 倍。**

### Replay 证据

1. **vs ShuiBa R2**：雷电→申鹤 (-1) → 申鹤→雷电 (-1) ⚠️ **CHAIN_SWITCH 浪费 2 骰，棋盘状态不变**

2. **vs LeiLang R3**：FAST_SWITCH 申鹤→雷电 → 雷电→重云 (-1) ⚠️ 切出去再切回来

3. **R1 普遍模式**：先出 1-2 张卡再攻击。LeiHe 作为速攻卡组，丧失了先手压制力。

4. **全局 loop switch 统计**：LeiHe V7 共计 24 次 loop switch（vs ShuiZhai 5 次，vs MoYou 4 次）

### 根因

macroPlanWeight=0.6 使得 macroPlan 生成的"你应该出这些卡/切这个人"指令凌驾于当前战场局势之上。LeiHe 的 macroPlan 可能列出了若干需要部署的支援/事件卡，V7 ranker 将其解读为"本回合必须打完这些卡"，即使对手已经压到脸上。

---

## 二、HongNiu 的极端波动

### 赢的模式（3 局全胜）

R1：`SKILL(-3) SKILL(-3) SKILL(-3) PLAY(-1)` — **9 骰攻击，1 骰起立本**。直接压制 ShenXiao baseline 的血量。

### 输的模式（1 局惨败）

R1：`PLAY(-1) → SKILL(-3) → SKILL(-3) → SWITCH(-1) → CHAIN_SWITCH(-1) → LOOP_SWITCH(-1) → LOOP_SWITCH(-1)`

**7 个动作，4 次切人（一斗↔迪希雅来回），4 骰纯粹浪费。** temperature=1.5 放大了随机性——一旦 macroPlan 推高了多个选项的分数，高 temperature 导致任何选项都可能被选中，链式切换无法停止。

### 反直觉发现：HongNiu V7 全局有 41 次 loop switch

在所有 37 局游戏中，HongNiu V7 比任何其他卡组都更多地进行 loop switch。但它仍能赢 65%，因为 HongNiu 的中速属性能承受一定的骰子浪费，且其攻击质量够高。

---

## 三、ShuiNing 镜像三平局

- 14 轮拉锯，每方 110+ 骰，skill 占比 70-80%
- **Baseline 水凝 R1 固定模式**：心海→凝光 (-1) → 凝光→心海 (-1) ⚠️ 开局浪费 2 骰
- V7 水凝同样：plays=14 vs baseline plays=8，多出近一倍的卡

双方都无法斩杀对方——这是水凝内战的固有特性，与 macroPlan 无关。但 V7 水凝的出卡倾向仍然过高。

---

## 四、根本原因层级

### P0 — 权重失衡（直接影响）

```
macroPlanWeight=0.6 过高
    ↓
"出这张卡"被当成必须完成的任务
    ↓
行动阶段无视战场时机（如对手残血不补刀、先出卡再攻击）
```

### P1 — Temperature 放大效应

```
temperature=1.5（baseline=1.2）
    ↓
macroPlan 抬高多个选项后，高温度让方差变大
    ↓
一旦进入链式切换（A→B→A），后续切换也被推高分，形成雪崩
```

### P2 — MacroPlan 缺少条件约束

当前 macroPlan 是静态文本（"第 N 回合做 X"），没有：
- **前置条件**："如果对手血量安全则出卡，否则攻击"
- **禁止规则**："不要 A→B→A 浪费骰子"
- **时机判断**："先攻击再出卡"的优先级排序

### P3 — Deck 级别的策略偏差

LeiHe 是速攻卡组，不能按中速卡组的节奏出卡。macroPlan 对所有卡组用同样的生成逻辑，导致卡组特性被抹平。

---

## 五、修正方案（按优先级）

### P0：降低 macroPlanWeight（立即见效）

```json
"macroPlanWeight": 0.3    // 从 0.6 → 0.3
"temperature": 1.2         // 从 1.5 → 1.2（对齐 baseline）
```

或采用动态权重：开局/换回合时 macroPlanWeight=0.5，连续行动时衰减到 0.15。

### P1：在 MacroPlan 生成时加入约束

向 LLM prompt 注入：
```
- 不要在同一回合内执行 A→B→A 的链式切换（浪费骰子无棋盘变化）
- 如果对手有角色 HP ≤ 3，优先击杀而非出卡
- 速攻卡组的 R1 目标：至少执行 2 次攻击，最多出 1 张卡
```

### P2：按 Deck 类型差异化 macroPlan 风格

在生成 macroPlan 之前，由 `eval-char-comb` + `llm-deck-analyzer` 判定卡组类型（aggro/midrange/control），LLM 根据类型调整计划风格。

### P3：Ranker 侧加入反模式惩罚

在 `static-priors.ts` 或 ranker 特征中直接编码：
- 检测到 LOOP_SWITCH 候选动作 → 给大幅负分
- 连续 3 次出卡无攻击 → tempo 惩罚递增

### P4：Benchmark 复查

修改后应首先验证：
1. LeiHe vs ShuiZhai/LeiLang 不再 0-5
2. HongNiu 的 loop switch 频率下降
3. 总体胜率 > 55%（对标 V3 的 56.4%）

---

## 六、对局诊断 Checklist（快速判断）

- [ ] LeiHe R1：plays ≤ 1，skills ≥ 2？
- [ ] 任何卡组：loop switch count = 0？
- [ ] ShuiNing 镜像：有没有一方能在 10 轮内结束？
- [ ] HongNiu R1：plays ≤ 1，没有 chain switch？
