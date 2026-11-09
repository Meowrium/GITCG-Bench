# 先后手不对称性与开局出战选择

> 2026-05-04。源：V3/V4 tempo benchmark 系列 + chooseActive 修复 + 干净 ranker 重训。

---

## 1. 问题发现

### 1.1 出战角色选择是硬编码的

`sim-adapter.ts:pickBestCharacter` 和 `policy-player-io.ts:chooseBestActiveCharacter` 在游戏开局（全角色满血 0 能量）时退化到"选候选列表第一个"——即 deck code 中排第一的角色。这导致：

- 神宵总是神里开局（而非宵宫）
- 雷鹤总是雷神开局（恰好正确）
- 莫优取决于码序

**已修复**（`src/knowledge/character-skill-profiles.ts`）：解析角色 DSL 源文件，识别 E 技能类型（召唤/自我buff/场地效果），用作 tiebreaker。优先级：self-buff(3) > summon(2) > combatStatus(1) > direct(0)。

**已知不足**：
- 红牛：一斗 prio=3 > 迪希雅 prio=2 → 选一斗，但人类打法通常是迪希雅先手
    - 1.召唤需要回合兑现+提供后台防御
    - 2.面对快攻时，迪希雅在T1在前台承伤，骰子用于过牌、上装备、拍支援牌
    - 3.**在需要快1~2轮次启动（一斗Q）出伤且没有生存压力的对局中，会选择一斗开**
- 优先级过于简化：self-buff 高于 summon，但 summon 的时序价值可能更高（取决于具体效果）
    - 1.神宵选择宵宫开局是因为需要宵宫的Q提供后续的出伤，不能简单地只看E的消耗的效果。充能往往不需要开E。
    - 2.在有宵宫天赋的前提下，天赋A有较高的伤害，3次普攻共12点伤害足以击倒一个角色。

### 1.2 先后手无感知

引擎层（`core/src/game.ts:300`）：`currentTurn` 初始化为 0，永不改变。**player 0 永远是先手。**

benchmark 层（`benchmark-suite.ts:58-61`）：sideA → player 0（先手），sideB → player 1（后手），固定不交替。

GiMlPolicy 的训练数据全部来自 player 0 视角，从未学习过后手策略。

---

## 2. 先后手敏感性的精细分析框架（待探索）

不是所有 matchup 和操作对先后手都敏感。需要建立区分指标。

### 2.1 对先后手高度敏感的场景

**高收益、可以通过交互影响的行动**


### 2.2 对先后手不敏感的场景

| 场景 | 原因 |
|------|------|
| 纯数值碾压（红牛打脆皮） | 先后手不影响伤害计算 |
| 双方都龟缩的控制镜像 | 谁先动谁吃亏，双方都不想动 |
| 装备、蓄爆 | 纯资源铺垫，无互动 |

### 2.3 待探索的区分指标

1. **手牌-骰子比**：手牌多的一方先手优势大（有更多选择先铺场）
2. **召唤物数量差**：有召唤物的 deck 先手优势大
3. **E 技能成本方差**：成本差异大的 deck（如神宵：1火 vs 3冰）先手选择影响极大
4. **斩杀线阈值**：当前 HP 分布决定谁先到斩杀线
5. **信息价值**：后手看到对方操作后能做的适应性调整的价值

---

## 3. Benchmark 演进追踪（本次 session）

| 版本 | Ranker | tempo | Plan | chooseActive | WR | 备注 |
|------|--------|-------|------|-------------|-----|------|
| V4+Plan | iter3（污染） | V4(switch-only) | 0.6 | 退化→首角色 | 47.5% | Plan 掩盖了 ranker 问题 |
| V4-only | iter3 | V4(switch-only) | 0 | 退化→首角色 | 34.4% | 去掉 plan 后裸奔 |
| V3-revert | iter3 | V3(全动作) | 0 | 退化→首角色 | 31.6% | V3 恢复也对坏 ranker 无用 |
| **V3-Clean** | **新 streaming** | **V3(全动作)** | **0** | **DSL 优先级** | **?** | 360 局 diverse self-play 重训 |

### 3.1 核心教训

1. **Ranker 污染是根本问题**：iter3 用双方 GiMlPolicy 对称 self-play 训练，学到的是噪声。macroPlan=0.6 只是一个巨大偏置掩盖了 ranker 的无能。
2. **macroPlan 是拐杖不是解药**：它把 34.4% 撑到 47.5%，但副作用是压垮了爆发卡组（莫优 -57.5pp, 雷鹤 -47.5pp）。
3. **V3 tempo 逻辑本身没问题**：V3 的 gate-controlled tempo_fast 全动作覆盖拿到过 56.4%。当前失败是 ranker 的锅，不是 tempo 的锅。

---

## 4. 下一轮训练待办

### 4.1 必须

- [ ] **添加后手对局**：在 diverse self-play config 中，将 50% 的 matchup 的 sideA/sideB 位置互换（sideA→player1, sideB→player0），使 GiMlPolicy 学习后手策略
- [ ] **修正 chooseActive 优先级**：考虑骰子成本 + 召唤物价值，而非简单的 self-buff > summon 排序

### 4.2 探索

- [ ] 先后手敏感性指标：从对局 replay 统计各操作类型的先后手胜率差异
- [ ] self.who 作为显式特征注入 ranker：让模型自己学习先后手差异
- [ ] deck 级别的最佳先后手策略：某些 deck 先手优势大（召唤系），某些后手优势大（控制系）

### 4.3 架构改进

- [ ] benchmark suite 应支持交替先后手（`alternateFirstPlayer: true`），而非固定 sideA=player0
- [ ] self-play config 应支持 same-deck 两次对局（各当一次先手），确保对称训练
