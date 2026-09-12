# Deck Analysis Benchmark — 设计文档

> 目标：测量 LLM 在不联网、不查询数据库的情况下，仅凭卡组构成信息进行战前分析的能力。
> 核心考察的是 **推理质量**，不是知识记忆。

---

## 一、核心设计原则

| # | 原则 | 来源 |
|---|------|------|
| 1 | 不使用**单一离散** archetype 分类（aggro/midrange/control 的单一标签在 GI TCG 中先天不可行）。v3.0 的 `deckProfile` 采用**主副类型制**：MTG 分类（aggro/midrange/combo/control/tempo）的主类型 + 可选副类型，不用权重表示重要度——以多维标签代替单一归类 | `packages/gitcg-theory/paper-scout/analysis/archetype-classification-impossibility.md` |
| 2 | 分离"内秉属性"和"条件响应"。内秉属性由 deck code 静态确定（卡组级标注）；条件响应取决于对手（对局级标注）。两者分文件存储 | `packages/gitcg-theory/gi-tcg/analysis/strong-coupling-and-deckbuilding.md` |
| 3 | 题目问的是推理链，不是最终结论。评分考察推理步骤的完整性、自洽性、可验证性 | P5（连续价值，禁止过早分类） |
| 4 | 可用 deck code + data 引擎直接计算的事实，不进 LLM 主观判断，只用于自动验证 LLM 的事实断言 | 工程约束 |
| 5 | 提供对手信息时，明确要求模型展示"响应逻辑"——同一卡组对阵不同对手时打法如何变化 | 方案 C |

---

## 二、题目分层

```
L1 — 静态事实（deck code → 唯一确定答案）
     → 元素构成、费用分布、共鸣资格、技能类型
     → 自动评分：精确匹配
     → 示例："这副牌的三个角色分别是什么元素？"

L2 — 内秉结构（deck code → 需要推理，但答案不依赖对手）
     → 标准开局序列、核心展开条件、关键组件识别、出伤模式、韧性
     → 自动评分：检查清单 + DSL 合法性验证
     → 示例："给出这套卡组 R1 的标准开局序列，并说明费用和调谐需求。"
     → 对应 data/ground-truth/{version}/decks/*.json

L3 — 响应链（deck + opponent deck → 打法调整）
     → 节奏偏移、反应控制权、威胁-应对映射、窗口变形、职能重分配、先后手调整
     → 自动评分：检查清单 + DSL 合法性验证 + LLM-as-judge 语义一致性
     → 示例："对阵卡组 Y，你的打法与对阵卡组 Z 有什么不同？请逐一说明变化。"
     → 对应 data/ground-truth/{version}/matchups/*.json
```

L1 本质上是对 gi-knowledge benchmark 的补充，不是本 benchmark 的核心价值。**核心价值在 L2 和 L3。**

---

## 三、Ground Truth Schema（v3.0 冻结版）

专家标注的结构化标准答案。**卡组级与对局级分离存储**：

```
data/ground-truth/{version}/
  decks/{safeCode}.json                    ← L2 内秉属性，每卡组一份
  matchups/{safeA}__vs__{safeB}.json       ← L3 响应链，每有序对一份
```

`safeCode` = deck code 前 20 字符（非字母数字转 `_`）。Schema 与
`src/annotate/schema.ts` 中的类型定义一一对应，以代码为准。

### 3.1 卡组级：`DeckGroundTruth`

```typescript
interface DeckGroundTruth {
  schemaVersion: "3.0"
  deckCode: string
  deckName: string
  version: string
  // 卡组所基于的游戏版本（如 "v6.3.0"）。不同版本的卡牌数值可能有变化，
  // 同样的三角色在不同版本的最优打法可能完全不同。评分时与题目版本比对。

  // ------ 卡组画像（制胜机制；主副类型制，见原则 1）------
  deckProfile: {
    primaryType?: "aggro" | "midrange" | "combo" | "control" | "tempo"
    secondaryType?: "aggro" | "midrange" | "combo" | "control" | "tempo"
    // MTG 分类的主/副类型，不用权重表示重要度：
    // aggro:    快攻（前期持续施压抢血）
    // midrange: 中速（靠单卡质量与资源交换滚雪球）
    // combo:    组合技（凑齐组件一波制胜；OTK 属于该类）
    // control:  控制（化解对手行动、拖入消耗取胜）
    // tempo:    节奏（以节奏差/行动权差换取资源领先）
    // 单一类型时 secondaryType 留空；副类型不应与主类型相同。
    tempo?: "fast" | "medium" | "slow"
    // 平均费用：fast ≤2 / medium 2-3 / slow >3
    startupSpeed?: "turn1" | "turn2~3" | "turn4" | ">=turn5"
    // 启动速度：核心打法开始运转的回合（1 / 2-3 / 4 / ≥5）
  }

  // ------ 关键组件（分 7 组，只列对战略有决定性影响的牌）------
  keyCards: {
    combo: KeyCard[]       // 连招件（一条连招链可涉及多张行动牌/技能/角色/站场效果）：
                           //   combo_starter:  起点——提供前置条件（挂元素、充能启动）
                           //   combo_field:    铺场——产生站场效果供连招联动（召唤物、出战状态）
                           //   combo_bridge:   衔接——让链条走通的中间件（调度/润滑/找关键件/延长链条）
                           //   combo_finisher: 终点——前置满足后打出终结伤害（伤害来源本身）
    damage: KeyCard[]      // 增伤/斩杀件，role = damage_amplifier
                           // 显著提升伤害上限的牌——自身不是伤害来源，
                           // 但决定"能打"还是"能杀"。例：武器（狼的末路）、
                           // 圣遗物（追忆之注连）、仙跳墙等增伤事件
    draw: KeyCard[]        // 过牌/检索，role = draw
    sustain: KeyCard[]     // 生存件（回复/护盾/减伤），role = sustain
    disruption: KeyCard[]  // 干扰件（切人/控制/弃牌/拆支援），role = disruption
    ramp: KeyCard[]        // 蓄爆/资源件，role = ramp
                           // 将骰子以非技能形式消耗/存储的牌（支援/装备类投资），
                           // 在节省轮次/抢先的同时为后续回合铺垫更多资源。
                           // 例：立本（存骰）、蒂玛乌斯/瓦格纳（存装备费）、派蒙（持续产骰）
    flex: KeyCard[]        // 灵活位——非核心、可根据 meta 替换。
                           // 标注 flex 的目的是告诉 LLM"哪些牌不是必须的"。
  }

  // ------ 开局决策树（一级条件分支）------
  // 每个分支 = 条件 + 该条件下的打法序列；isPrimary 的分支为默认分支
  // （条件不满足任何其他分支时的打法）。按优先级从高到低录入。
  openingSequences?: {
    id: string             // 如 "open-1"，供 matchup 调整引用
    name: string           // 分支名，如 "召唤铺场→感电输出"
    condition: string      // 分支条件（如「手牌有卯师傅」「后手」「骰子 ≥3 同色」）；空串 = 默认分支
    style?: "tempo" | "charge_up"
    // 分支打法风格：
    // "tempo"     节奏——骰子直接转化为行动权/伤害（技能/切换/进攻牌）
    // "charge_up" 蓄爆——将骰子以非技能形式消耗/存储（打出支援/装备类投资牌），
    //             在节省轮次/抢先的同时为后续回合铺垫更多资源
    steps: {
      action: string       // "角色名 技能名"、"卡牌名"、"切角色名"、"调和"、"结束"；切人也算一步（耗骰耗行动权）
      cost: string         // 如 "3水"、"1任意"、"3水+2能"、"0"
      effectDescription: string
      // 这一步的战略效果（非规则文本复述），≤40字。
      // 例: "虚影召唤→回合末自动挂水+1水伤"
    }[]
    diceConstraint: string
    // 骰子颜色约束，含调谐预期。例: "至少3水+3雷，最多需要2次调谐"
    totalDiceUsed: number  // 不含调谐消耗的序列总骰数（标注工具自动求和）
    isPrimary: boolean     // 默认分支（无条件命中时打这条），通常每 deck 1 个
  }[]

  // ------ 展开依赖度 ------
  setupDependency?: "low" | "medium" | "high"
  // low: 不需要特定组件，每回合都有可执行的有效行动
  // medium: 核心组件显著提升效率，缺失时可降级运作
  // high: 关键组件缺位时战斗力断崖式下跌

  // ------ 出伤模式 ------
  damageMode?: "reaction_chain" | "summon_swarm" | "single_burst" | "chip" | "raw"
  powerCurve?: "frontloaded" | "steady" | "backloaded" | "spiky"
  hasOneShotPotential?: boolean
  // 是否具备单回合内击杀满血角色（~10HP+）的能力

  // ------ 韧性 ------
  resilience?: {
    hasHealing: boolean        // 有任何回复手段即 true
    hasShield: boolean         // 有任何护盾来源即 true
    hasImmuneControl: boolean  // 有角色自带免疫控制标签
    // ------ 反制手段（卡组自带的针对工具，有即为 true）------
    hasBoardDisruption?: boolean  // 干扰站场：拆除/压制对手支援区（送你一程等）
    hasEventCounter?: boolean     // 事件牌反制：反制对手事件牌（裁定之时等）
    hasSummonRemoval?: boolean    // 召唤物去除：清除对手召唤物（护法之誓等）
    hasHandDisruption?: boolean   // 手牌破坏：削减对手手牌
    hasDeckDisruption?: boolean   // 牌库破坏：削减对手牌库
    vulnerableTo: ("frontloaded_burst" | "summon_swarm" | "reaction_chain" | "chip")[]
  }

  // ------ 弃权 ------
  abstentions: { field: string; reason: string }[]
  // 标注者对某字段无法判断时显式弃权，评分时该维度不计入
}

interface KeyCard {
  id: string  // 卡牌或角色的 definitionId（字符串形式），来自 data 源文件 @id
  role: "combo_starter" | "combo_field" | "combo_bridge" | "combo_finisher" | "damage_amplifier" | "draw" | "sustain" | "disruption" | "ramp" | "flex_slot"
  importance: "core" | "important" | "flexible"
  // core: 不可替代，缺失时强度大幅下降 / important: 显著增强但可替代 / flexible: 可替换
  rationale: string  // ≤50字，judge 评分时参考
  mulligan?: "always_keep" | "high" | "situational" | "never"
  // ↑ 仅行动牌。角色不抽牌，无所谓留牌，不设此项。
  skills?: { id: string; name: string }[]
  // ↑ 仅角色：关键技能/被动，精确到 skill definitionId（charDefId*10+序号，
  //   与模拟器寻址一致）。空/缺省 = 不限定具体技能（整张角色卡都是关键组件）。
  //   例：纯水精灵·洛蒂娅 → [{ id: "21021", name: "纯水幻造" }]
}
```

#### 多属性卡牌的标注约定

一张牌可能兼具多种属性（如卯师傅既是过牌又能产骰）：

- **主属性制**：录入最能决定其在该卡组战略定位的一组，次要属性写进 `rationale`。
- 当两种属性确实同等重要时，**允许录入多组**——录入工具自动处理：
  在其他组录入已存在的卡牌时，自动继承先前的重要性/留牌/理由/连招角色
  作为默认值（可回车沿用，也可按本组视角修改）；同组重复则直接跳过。
- 保存时若同一卡牌 id 出现在多个组，给出提醒但不阻断（用于抓误操作）。
- **跨卡组继承**：大部分卡牌在不同卡组中的作用一致。录入时会自动检索同版本
  所有已标卡组的 ground truth，按「本卡组他组 > 他卡组同组 > 他卡组他组」的
  优先级继承默认值（role 随当前组，重要性/留牌/理由/连招角色作为默认值可改）；
  checkbox 中以 `[已录:draw/ramp]` 标出他卡组已录入的卡牌。
- **下游整合**（题目生成/judge，阶段 1-3 实现时遵循）：按 `definitionId` 去重，
  同一张卡的多个 role 合并为多标签；T2 检查清单中的组件数量按去重后计数。
  **评分按角色覆盖度从严**：多属性组件需答出全部已标角色才得满分
  （全覆盖 → 1；只答出部分角色 → 0.5；答错角色或漏答组件 → 0），
  题面会显式告知"只答一种视为不完整"，保证公平。

### 3.2 对局级：`MatchupGroundTruth`

每个**无序对**（A vs B）一份文件：**正反手（双方视角）合并存储**——
`perspectives.a` = A 视角（我方=A，对手=B），`perspectives.b` = B 视角（我方=B，对手=A）。
专家在同一任务内标注双方（TUI 内一键切换视角）。标注任务 = 8×7/2 = **28 个对局**
（内战经 `--mirror` 追加 8 个；双方视角的威胁、应对、优劣势互为镜像但不相同）。

```typescript
interface MatchupGroundTruth {
  schemaVersion: "3.0"
  version: string
  deckA: { code: string; name: string }
  deckB: { code: string; name: string }
  isMirror: boolean  // 内战（双方 deck code 相同）
  perspectives: { a: MatchupPerspective; b: MatchupPerspective }
}

// 单方视角的响应链标注
interface MatchupPerspective {

  // 对手关键特征（elementComposition 由工具自动填，其余手填）
  opponentNotables: {
    elementComposition: string[]  // 如 ["cryo", "pyro", "cryo"]
    powerCurve: string            // 与 L2 powerCurve 枚举相同
    damageMode: string            // 与 L2 damageMode 枚举相同
    threatSummary: string         // 一句话：对手靠什么赢
  }

  // ------ 威胁-应对映射 ------
  threats: {
    source: string
    // 威胁来源（对手技能/卡牌名或自由描述），如 "林尼蓄力爆发"
    kind: "lethal" | "disrupting" | "grinding" | "ramping"
    // lethal: 高爆发斩杀（1-2回合击杀关键角色）
    // disrupting: 控制链（冻结/眩晕/强制切人）
    // grinding: 消耗战（资源被拖垮）
    // ramping: 滚雪球累积（越拖越强，须尽早打断）
    window: "early" | "mid" | "late"  // early=R1-R2, mid=R3-R4, late=R5+
    countermeasure: string            // 应对策略，≤60字
    existingCounterCards: string[] | null
    // 我方牌表中的针对牌名列表；null = 无针对牌，只能靠打法调整
  }[]

  // ------ 反应控制权 ------
  reactionControl?: {
    myMonopoly: string[]    // 我方可单方面保证触发的反应
    oppMonopoly: string[]   // 对手可单方面保证触发的反应
    contested: string[]     // 竞争性反应（取决于先后手与操作）
    advantage: "me" | "opponent" | "even"
  }

  // ------ 节奏偏移 ------
  tempoShift?: {
    shift: "accelerate" | "maintain_early_pressure" | "slow_down"
         | "disrupt_their_rhythm" | "no_shift"
    rationale: string  // 判断依据（引用对手速度特征或具体机制）
  }

  // ------ 窗口变形 ------
  windowShift?: {
    myEffectiveWindow: string  // 本 matchup 中的实际有效窗口，如 "R1-R2"
    adjustment: "prioritize_first_kill" | "delay_for_better_setup"
              | "skip_opening_setup" | "same_as_isolated"
  }

  // ------ 职能重分配 ------
  // 同一角色/卡牌在本 matchup 中的实际职能与孤立时不同
  roleShifts?: {
    cardOrCharacter: string
    isolatedRole: string  // 孤立时职能（keyCards.role 枚举或自由文本）
    matchupRole: string   // 本 matchup 中的实际职能
    reason: string
  }[]

  // ------ 先后手 ------
  playOrder?: {
    asFirst?: string   // 我方先手时的调整（≤60字）
    asSecond?: string  // 我方后手时的调整（≤60字）
  }

  // ------ 综合评估 ------
  assessment: {
    myAdvantages: string[]   // faster_combo/better_sustain/more_disruption/resource_lead/tempo_advantage
    oppAdvantages: string[]  // 同上枚举
    recommendedStrategy?: "race" | "disrupt" | "outlast" | "build_value"
  }
  overallDirection: "heavilyFavored" | "slightlyFavored" | "even"
                  | "slightlyUnfavored" | "heavilyUnfavored" | ""
  // 基于卡组结构的判断，非对战胜率统计
  decisiveFactor: string
  // 一句话：本 matchup 的最关键决定因素

  abstentions: { field: string; reason: string }[]
}
```

**对手侧自动继承**（标注工具在对局模式下的行为）：

- 对手特征：对手的 `powerCurve`/`damageMode` 直接取自其 L2 标注（仅填空、不覆盖）；
  `threatSummary` 用对手的关键斩杀/增伤件（combo_finisher/damage_amplifier 的
  core 件）与主类型自动草拟，可编辑。
- 威胁与应对：录入威胁时，同版本中面对**同一对手**已标过的威胁
  （source/kind/window）可勾选继承（应对策略以其原文为默认值可改；
  针对牌按我方牌表重新选择）；威胁来源候选按类别分组
  （对手关键斩杀/增伤件 ★、角色技能、事件牌、支援牌、装备牌、自定义输入），
  类内批量勾选多选，同批威胁的类型/窗口统一设置默认值（可逐条修改），
  应对策略与针对牌逐条填写；已录入的来源在候选中自动隐藏。

### 3.3 与早期 v1.0 草案的对应关系

v1.0 草案（曾写在本文件 §3）与 v3.0 冻结版的差异，供历史参考：

| v1.0 | v3.0 | 说明 |
|------|------|------|
| `keyComponents`（7 种 role 平铺） | `keyCards`（7 组，role 随组定） | `draw_and_dice`→`draw`、`survival`→`sustain`、`damage_amplifier`→独立 `damage` 组、新增 `flex` 组（role=`flex_slot`） |
| `threatCounterMap.threat.type` = one_shot/snowball/lockdown/outgrind | `threats.kind` = lethal/ramping/disrupting/grinding | 一一对应：lethal≈one_shot、ramping≈snowball、disrupting≈lockdown、grinding≈outgrind；`existingCounterCards` 语义不变 |
| `matchups[]` 内嵌于卡组文件 | 独立 `matchups/` 目录，每无序对一份（双视角合并） | 支持 28 对局规模与断点续标 |
| （无） | `playOrder`（先后手）、`deckProfile`（画像）、`assessment` | v3.0 新增维度 |

---

## 四、题目模板

### L2 题型

#### T1：开局序列分析
```
Prompt:
你面前是卡组「{deckName}」，deck code: {deckCode}。
角色为 {charList}。行动牌共 30 张。

请完成以下分析：

(1) 列出 R1 的 2-3 个候选开局序列。每个序列包括：
    - 具体操作步骤（含费用颜色）
    - 总花费骰子数
    - 骰子颜色约束和调谐预期

(2) 指出哪个是最优先序列，并说明取决于什么条件（先后手、手牌）。
    若候选序列中存在"蓄爆"打法（将骰子投资于非技能资源以铺垫后续回合），
    请指出它与你认为的最快出伤序列之间的取舍。

(3) 指出这些序列之间的资源竞争关系（谁和谁冲突，冲突在哪颗骰子上）。
```

```
评分检查清单：
☐ 序列步骤可在引擎上合法执行（通过 DSL 验证）
☐ 费用计算正确（可通过 deck code 解析验证）
☐ 骰子颜色约束被显式讨论（调谐需求）
☐ 明确了最优序列的条件依赖
☐ 正确区分了蓄爆打法与节奏打法（如卡组含蓄爆件）
☐ 识别了序列间的资源冲突
```

#### T2：关键组件识别
```
Prompt:
卡组「{deckName}」的完整牌表见附件。

(1) 识别本卡组的"不可替代"关键组件（最多 5 张），并为每张说明：
    - 它在卡组中的角色（过牌/增伤/组合技起点/保命/干扰等）
    - 缺失时卡组会怎样退化
    - 开局留牌优先级
    注意：若某张关键组件兼具多种重要属性（如既过牌又产骰），
    请全部指出并分别说明，只答一种视为不完整。

(2) 指出哪些牌是"灵活位"——可以根据 meta 替换而不影响核心战术。

(3) 画一张"组件解锁关系图"：哪些组件的持有会解锁哪些操作路线的选择权。
```

```
评分检查清单：
☐ core 级组件数量合理（通常 ≤5），且理由充分
☐ 每张组件的角色判断正确；多属性组件需覆盖其全部已标角色
   （全覆盖 → 1；只答出部分角色 → 0.5；答错角色或漏答组件 → 0）
☐ 至少识别了 1-2 个 flex_slot
☐ 组件解锁关系逻辑自洽（有 A 才能做 B）
☐ 留牌优先级与开局序列分析一致（不自相矛盾）
```

#### T3：出伤与节奏特征
```
Prompt:
仅从构筑角度分析卡组「{deckName}」：

(1) 主要的出伤模式是什么？（反应链/召唤物群/单体爆发/高频小额/纯数值）
    请引用具体的角色技能或卡牌作为论据。

(2) 出伤曲线属于哪种？（前期集中/平稳/后期跃升/峰谷明显）
    判断依据。

(3) 这套牌是否具备 OTK（一回合内击杀满血角色）的潜力？如果具备，需要满足什么条件？
```

```
评分检查清单：
☐ 出伤模式判断有具体卡牌/技能引用支撑
☐ 曲线判断引用了费用分布或技能成本
☐ OTK 判断正确且条件描述准确
☐ 无事实错误（卡牌效果、费用、角色元素等）
```

#### T6：卡组类型判断（不定项选择，1-2 项）
```
Prompt:
你面前是卡组「{deckName}」，deck code: {deckCode}。完整牌表见附件。

从以下五种类型中，选出最符合本卡组制胜机制的 1-2 项：
- aggro（快攻）：前期持续施压抢血
- midrange（中速）：靠单卡质量与资源交换滚雪球
- combo（组合技）：凑齐组件一波制胜（OTK 属于该类）
- control（控制）：化解对手行动、拖入消耗取胜
- tempo（节奏）：以节奏差/行动权差换取资源领先

(1) 本卡组的主类型是哪一项？说明理由。
(2) 本卡组是否存在副类型？如有，指出并说明；如无，说明为什么它是单一类型。
```

```
评分检查清单：
☐ 主类型与专家一致
   （专家有副类型时，把副类型答成主类型 → 0.5；完全命中 → 1；其余 → 0）
☐ 副类型判断与专家一致
   - 专家有副类型：命中 → 1；主副颠倒 → 0.5；缺失或错误 → 0
   - 专家无副类型：正确识别"单一类型" → 1；多答但可辩护 → 0.5；多答明显错误 → 0
☐ 选择引用了具体的角色/卡牌/机制，且与所选类型逻辑自洽
```

Ground truth 来源：`deckProfile.primaryType` / `secondaryType`（标注已覆盖，无需额外工作）。

---

### L3 题型

#### T4：Matchup 响应分析
```
Prompt:
卡组 A：「{deckNameA}」（我方）
卡组 B：「{deckNameB}」（对手）

双方的角色构成和关键特征如下：
- A: {elementCompositionA}, 出伤模式 {damageModeA}, 曲线 {powerCurveA}
- B: {elementCompositionB}, 出伤模式 {damageModeB}, 曲线 {powerCurveB}

请分析这个 matchup：

(1) 【反应优先级】我方可以打出哪些反应？对方可以打出哪些反应，收益高不高，需不需要/怎样应对？除切人外，双方是否能干扰对手的反应？

(2) 【节奏偏移】对比双方的速度曲线，我应该加速、减速、保持、还是干扰对手节奏？
    给出具体理由。

(3) 【威胁-应对】对手的终端（制胜手段）是什么？我有哪些手段应对？
    我方牌表中的哪些牌在这个 matchup 中角色发生了变化（从泛用变为针对，或反之）？

(4) 【窗口变形】我方孤立时的强势期是什么，在本 matchup 中这个窗口是被压缩还是拉长？
    需要提前斩杀，还是可以等到更好时机？

(5) 【综合】整体优劣势判断，以及决定性因素是什么？
```

```
评分检查清单：
☐ 反应控制权分析正确（元素匹配 → 反应推导无错误）
☐ 节奏偏移判断与双方曲线分析一致
☐ 威胁识别引用了对手的具体特征（不是泛泛而谈）
☐ 至少识别了一个 roleShift（某牌在本 matchup 的角色变化）
☐ 窗口分析考虑了对手的强势期与我方强势期的相对位置
☐ 综合判断与前述分析一致（不矛盾）
```

#### T5：多 matchup 对比
```
Prompt:
卡组 A：「{deckNameA}」（我方）

分别对阵以下两个对手：
- 卡组 B：「{deckNameB}」
- 卡组 C：「{deckNameC}」

请对比 A vs B 和 A vs C 的打法差异：

(1) 在哪个 matchup 中 A 更接近"进攻方"？在哪个中更接近"防守方"？为什么？

(2) A 的标准开局序列在这两个 matchup 中会有变化吗？如果有，各自怎么调整？

(3) A 的同一张关键牌（由专家指定或 LLM 自行选择）在这两个 matchup 中的角色有何不同？
```

```
评分检查清单：
☐ 准确区分了两种对局中 A 的定位差异
☐ 开局调整有具体依据（引用了对手的速度/威胁特征）
☐ 卡牌角色变化分析具体（不是"都一样"，也不是空泛）
☐ 无事实错误
```

---

## 五、自动评分策略

### 双路径评分架构

```
LLM 答案
    │
    ├── 路径一：事实验证（自动，严格）
    │    提取 LLM 答案中的可验证断言（元素、费用、技能效果等）
    │    → 与 deck code 解析结果 / data 源文件比对
    │    → 每个错误扣分
    │
    └── 路径二：推理质量（自动，检查清单 + LLM-as-judge）
         按题目类型的检查清单逐项评分
         每项: 0 (缺失/错误) / 0.5 (部分正确) / 1 (完整正确)

         辅助：DSL 序列验证
           对 LLM 提出的操作序列 → 转为 DSL →
           ① 合法性检查（是否可执行）
           ② 结果检查（执行后状态是否符合 LLM 描述）
```

### 逐题评分权重

| 题目 | 事实正确权重 | 推理质量权重 |
|------|:---------:|:---------:|
| T1 开局序列 | 40%（费用、元素正确性） | 60%（序列合理性、条件分析） |
| T2 关键组件 | 30%（组件存在性） | 70%（角色判断、解锁关系） |
| T3 出伤特征 | 20%（技能引用正确） | 80%（模式判断、论证链） |
| T6 卡组类型 | 40%（主/副类型与专家一致） | 60%（论证质量） |
| T4 Matchup | 30%（元素反应正确性） | 70%（响应链完整性） |
| T5 多 matchup | 20% | 80%（对比深度） |

### LLM-as-judge 设计

使用一个独立的 judge prompt（与题目 LLM 不同的模型调用）：

```
你是一个七圣召唤 benchmark 的自动评分员。
你的任务是根据检查清单，评估一份 LLM 的答案。

## 题目
{question}

## 专家参考
{groundTruth}

## LLM 答案
{llmAnswer}

## 检查清单
{checklist}

对检查清单的每一项，给出 0/0.5/1 的评分和简要理由。

## 输出格式
[
  {"item": "检查项1", "score": 1, "reason": "..."},
  {"item": "检查项2", "score": 0.5, "reason": "..."},
  ...
]
```

Judge 的准确性需要通过人工校准：抽 20 道题的人工评分与 judge 评分做相关性检验。相关性 > 0.8 即可接受。

---

## 六、DSL 的辅助验证角色

GTS DSL 用于**验证 LLM 事实断言**，不做为主评分依据：

### 验证类型 1：序列合法性

LLM 提出的操作序列是否可以实际执行（资源足够、目标合法）？

```
LLM 答: "先开 A 的 Q 大招（3能）收头"
DSL 验证: 构造状态 → 尝试执行 → 发现 A 初始 0 能量 → 不可执行 → 标记事实错误
```

### 验证类型 2：伤害计算

LLM 声称的结果是否与引擎计算一致？

```
LLM 答: "该序列造成 5 点伤害"
DSL 验证: 构造状态 → 执行序列 → 断言 target.health 变化 → 实际 4 点 → 标记事实错误
```

### 验证类型 3：状态一致性

LLM 在分析中引用的状态（如"此时场上已有水附着"）是否与序列前序步骤矛盾？

```
DSL 验证: 执行前序步骤 → 检查 aura 字段 → 不匹配 → 标记逻辑矛盾
```

### 限制

- DSL 不支持精确骰子颜色分布（全设为 Omni）。因此费用颜色约束的验证只能通过 deck code 解析做近似判断，不能 100% 精确。
- DSL 只能验证"可执行"，不能验证"最优"。"这个序列合法但不好"是推理层的判断，不归 DSL。

---

## 七、deck pool 与标注工具

### 卡池

使用 `deck-analysis/data/deck-list.json` 中的 **8 套卡组（v6.3.0 版本数值）**。
标注任务 = 8 份卡组级（L2）+ 8×7/2=**28 个对局**（L3，无序对，正反手合并标注，不含内战）。
内战对局（8 份）可通过 `--mirror` 追加；先后手差异经对局 schema 的
`playOrder { asFirst, asSecond }` 字段标注。

### 标注工具

命令行 TUI（`packages/benchmark` 下运行）：

```bash
# 单卡组标注（L2）
pnpm annotate --deck A0BQ... --version v6.3.0 --name "水八"

# 单对局标注（L3）
pnpm annotate --matchup A0BQ... --opp AABQ... --version v6.3.0

# 批量标注（8 卡组 + 28 对局；断点续标）
pnpm annotate --batch deck-analysis/data/deck-list.json --resume

# 追加内战对局的批量
pnpm annotate --batch deck-analysis/data/deck-list.json --mirror --resume
```

交互说明：

- **并排分栏**：最左栏为操作菜单（↑↓/jk 导航），右侧为卡组信息面板。
  卡组模式两栏（菜单 + 卡组信息）；对局模式三栏（菜单 + 我方卡组 + 对手卡组）。
- **原位编辑**：表单分区 Enter 展开后，字段直接显示在大类下方——枚举值用
  ←→ 或 Enter 循环切换，布尔用 Space 勾选，多选展开选项子行用 Space 勾选；
  仅自由文本按 Enter 后在界面下方临时输入；Esc 逐层收起（多选子行 → 分区 → 退出）。
- **批量会话内切换**：批量模式下，标注界面内按 ←→（非枚举行的任意行）或点菜单
  「← 上一卡组 / 下一卡组 →」直接切换上/下一套，无需退出到批量菜单；
  标题显示当前位置（如 `标注: 水八 [3/8]`）。
- 列表分区（开局决策树/威胁等）的添加与编辑为界面下方的引导式向导。
- **威胁来源分类批量录入**：选类别（★斩杀/增伤件、角色技能、事件/支援/装备牌、
  自定义）→ 类内**批量勾选**来源（空格多选，已录入的自动隐藏）→ 同批统一设置
  威胁类型/窗口默认值 → 逐条填写应对策略与针对牌；条目上回车可单条修改
  类型/窗口/应对/针对牌。一次「添加」可连续录入多个类别（完成选「完成（返回）」）。
- **关键卡牌按组树形展开**：每组一行（连招件/增伤/过牌/生存/干扰/资源/灵活位，带计数），
  Enter 展开某组后可看到该组已有卡牌；组内「＋添加」先**批量勾选**该组要录入的卡牌
  （空格多选），再逐张标注角色/重要性/留牌/理由（无需先选分组、无需逐张重启向导）；
  已在他组录入的卡牌自动**继承**先前信息作为默认值，同组重复自动跳过。
- **开局决策树（一级条件分支）**：先问条件（如「手牌有卯师傅」「后手」，
  留空=默认分支）再录打法；已有默认分支时会询问是否替换。
- **序列速记（低代码）**：决策树分支的步骤支持一行速记，按优先级从高到低录入：
  `纯水E=铺场>立本>切八重>八重E>调和>结束`（角色名片段+A/E/Q、切+角色、卡名片段、
  调和/结束；`动作=说明` 附带战术意义）。特殊步骤 **`蓄爆`**：词元或行动菜单中选用后
  直接插入泛指步骤（该步以任意蓄爆类牌填充，不再细分选牌）。歧义就地弹出候选；
  解析后显示带费用的预览，确认或进逐步编辑器微调。留空速记则直接进入逐步编辑器。
- 选牌/选操作时**显示卡牌效果描述**（inquirer description 行）。
- **每次编辑后自动保存**（Ctrl+C 不丢数据）；"保存并退出"额外打印校验告警
  （如：同一牌进多个关键卡组、开局序列总骰数 >8、对局缺 decisiveFactor）。
- 批量模式进度持久化到 `data/.batch-progress.json`；`--resume` 跳过已完成项。
- 非 TTY 环境回退为数字序号输入（仅适合冒烟，不建议实际标注使用）。

输出：`data/ground-truth/{version}/decks/*.json` 与 `.../matchups/*.json`。

---

## 八、专家标注与 LLM 自生成数据的边界

### 核心区分

```
专家数据 = 评分基准（ground truth），用于判断 LLM 分析的正确性
自生成数据 = LLM 自己的战前分析 + 战后修正，是被评测的对象
```

二者不可混淆：不能拿 LLM 自己生成的数据当评分标准。但自生成数据有另一个用途——**作为 LLM 下一轮对战的迭代输入**。

### 静态层：专家一次性标注

| 标注项 | 谁做 | 工作量 | 说明 |
|--------|------|--------|------|
| **题目模板** | 专家审阅 | ~1h | 从自动生成候选池中筛选 30-50 道，去废话/歧义 |
| **检查清单**（每类题型 5-8 条） | 专家定义 | ~1h | T1-T6 共 6 类，定义后同类题复用 |
| **Judge 校准** | 专家评分 20 题，与 judge 自动评分比对 | ~1.5h | 相关性 >0.8 则 judge 可用；不达标则迭代 prompt |
| **L2 可计算字段审核** | 专家确认自动计算结果 | ~1h | deck code 自动填的元素/费用等字段做最终确认 |
| **L2 推理维度 ground truth** | 专家填写 | ~1.5h/套 × 8套 ≈ 12h | 开局序列、关键组件、出伤模式等（卡组级 8 份） |
| **L3 响应链 ground truth** | 专家填写 | ~0.75h/对局 × 28对局 ≈ 21h | 威胁-应对、反应控制权、节奏/窗口、职能重分配、先后手（双方视角） |

**总计：约 37.5 小时专家时间。**（L3 占大头；可先标 8 卡组 + 少量代表性对局做试点。）

L2/L3 推理维度的 ground truth 必须专家做。它提供的是一份**被认可的参考分析**，用于：
1. 作为 judge 评分的上下文（judge 需要知道"好的分析应该覆盖哪些要点"）
2. 作为 LLM 迭代学习的锚点（LLM 自己的分析可以偏离专家，但偏离需要在对战中得到验证）

### 动态层：LLM 自生成数据

LLM 自生成数据**不参与评分**——它们是**被评测对象**和**下一轮迭代的输入**。生命周期如下：

```
Round 0:
  LLM 仅凭卡组构成做初始分析（L2）
  → 存入 LLMDeckKnowledge.preGameAnalysis

Round 1-N（每轮一个 matchup）:
  输入 = 卡组 + LLMDeckKnowledge（含所有历史迭代记录）
  → LLM 做本局 matchup 预测
  → 对战
  → LLM 做战后反思（预测-vs-实际对比）
  → 追加 iterationLog
  → 聚合 refinedKnowledge（修正后的 matchup 知识）

Benchmark 评测点：
  ┌─ 评测 A: Round 0 的 L2 初始分析 vs 专家 ground truth
  ├─ 评测 B: Round N 的 matchup 预测 vs 专家 ground truth
  │           （是否比 Round 0 更准？是否收敛到专家标准？）
  ├─ 评测 C: 反思质量
  │           （LLM 能否从胜负中提取正确的教训？归因是否合理？）
  └─ 评测 D: 知识收敛性
              （refinedKnowledge 是否随迭代趋于稳定？
                还是在不同方向上来回摇摆？）
```

### 关键设计决策：对战结果不作为评分标准

单局胜负受随机性（抽牌、骰子、先后手）影响太大。LLM 可以做了一个完全正确的分析但仍然输掉比赛。

"对战结果"在 benchmark 中的唯一用途是：**考察 LLM 的反思能力**——能否正确地将"输了"归因为"我的分析有问题"还是"这一局的随机性对我不利"。错误归因（赢了就觉得自己分析全对，输了就全盘否定）本身就是 LLM 推理能力的不足。

### LLMDeckKnowledge 数据结构

这是 **LLM 自生成**的数据——LLM 自己的战前分析 + 每轮对战后的反思和修正。存储在 `data/llm-knowledge/` 下，每轮迭代后更新。**不参与评分**，只作为被评测对象和下一轮迭代的输入。

```typescript
interface LLMDeckKnowledge {
  deckCode: string
  createdAt: string
  // 首次创建时间（Round 0 结束时）

  version: number
  // 每次对战迭代后递增。从 0 开始。
  // version=0 代表只有 preGameAnalysis（还没打过任何对战）

  // ------ Round 0 生成的初始分析 ------
  // LLM 仅凭卡组构成做的 L2 分析。
  // 评测 A 就是拿这个跟 L2 ground truth 比对。
  preGameAnalysis: {
    openingSequences: OpeningSequence[]
    // 格式与 ground truth OpeningSequence 完全相同（见 3.1）

    keyCards: KeyCard[]
    // 格式与 ground truth KeyCard 完全相同（见 3.1）

    damageMode: string
    // LLM 判断的出伤模式。取值为 ground truth damageMode 枚举值之一。

    powerCurve: string
    // LLM 判断的出伤曲线。取值为 ground truth powerCurve 枚举值之一。
  }

  // ------ Round 1~N 的迭代记录 ------
  // 每轮对战追加一条。
  iterationLog: {
    iteration: number
    // 从 1 开始

    timestamp: string
    opponentDeckCode: string
    opponentDeckName: string

    // -- 战前预测 --
    // LLM 在看到对手卡组但还没开始对战时做的判断。
    // prompt 中会附上 refinedKnowledge 作为历史上下文。
    predictedMatchup: {
      tempoShift: string
      // 取值与 ground truth tempoShift.shift 枚举相同
      reactionAdvantage: string
      // 取值与 ground truth reactionControl.advantage 枚举相同
      threatResponse: string
      // 自由文本。LLM 对"怎么应对"的本轮策略描述。
      overallDirection: string
      // 取值与 ground truth overallDirection 枚举相同
      decisiveFactor: string
      // 自由文本。本轮认为的决定性因素。
    }

    // -- 战前选择 --
    // LLM 在实际进入对局前完成的"开打准备"。
    // 评测中会检查这些是否与 LLM 自己的预测一致（自洽性）。
    preGameChoices: {
      mulliganKept: number[]
      // 开局调度后保留的手牌 cardId 列表。
      // 若分析说某牌必留，这里应有它；没留且反思中未承认错误 → 不自洽扣分。

      openingCharacter: number
      // 选择的出战角色 definitionId。

      plannedSequence: string
      // 本轮计划的开局序列 ID，如 "open-1"。
      // 必须引用 preGameAnalysis.openingSequences 中已定义的 id。
    }

    // -- 对战结果 --
    // 由引擎生成，LLM 不参与。客观事实。
    gameResult: {
      winner: "me" | "opponent"
      // 赢了 ≠ 分析正确，输了 ≠ 分析错误。
      totalRounds: number
      // 用于对比 LLM 预测的 powerCurve。
      keyTurningPoint: string
      // LLM 自己识别的对局转折点。自由文本。
      // 评测 C 会检查是否能正确识别——而非把"输了的回合"等于"转折点"。
    }

    // -- 战后反思 --
    // 评测 C 的核心评分对象。
    postGameReflection: {
      predictionAccuracy: "correct" | "partial" | "wrong"
      // LLM 对自己预测准确性的自我评估。
      // "correct":  预测基本正确。输了可能是执行/随机性。
      // "partial":  部分正确。需指出哪里对哪里错。
      // "wrong":    主要方向错了。
      // 评测 C 检查自我判断是否合理：
      //   其实输了是骰子差，却标 "wrong" 全盘推翻 → 过度修正。

      whatWasWrong: string      // 自由文本。分析中哪些部分是错的。
      revisedAnalysis: string   // 自由文本。修正后的 matchup 分析（自然语言）。
      // 下一轮同 matchup 时作为上下文输入。
      // 评测 D（收敛性）追踪其是否持续细化 vs 来回摇摆。
    }
  }[]

  // ------ 聚合后的修正知识 ------
  // 从 iterationLog 中自动提取（不是 LLM 直接输出）。
  refinedKnowledge?: {
    matchupAdjustments: Record<string, {
      // key = 对手的 deckCode。同一对手多轮取最新修正。
      tempoShift: string
      openingAdjustment: string     // 自由文本
      keyThreats: string            // 自由文本
      confidence: number            // 0-1
      // 基于: (1) 迭代次数: 1局→0.3, 5局→0.7
      //       (2) 修正方向一致性: 连续一致→加分, 来回摇摆→扣分
      // 不参与评分，仅供 LLM 决定"这个修正该不该听"。
    }>
  }
}
```

---

## 九、评测 C：反思质量评分

考察 LLM 能否从对战中正确学习。不依赖专家 ground truth。

### 检查清单

```
对 LLM 战后反思文本评分：

☐ 是否区分了"分析错误"和"执行/随机性不利"
   正确示例："预测对手 R3 爆发，实际对方 R2 就启动了——我的速度判断偏慢。"
   错误示例："输了因为这局骰子太差。"（把所有失败归因外部）

☐ 是否引用了对局中的具体事件作为论据
   正确示例："R2 对手用 X 卡牌加速了充能，这一点我战前没考虑到。"
   错误示例："对手太强了。"

☐ 修正后的分析与原分析之间是否有明确的差异点
   正确示例："原分析认为应该先铺资源再进攻，修正后认为应该 R1 直接施压。"
   错误示例："继续保持原计划。"（无论输赢都不修正）

☐ 修正是否过度
   - 赢了就不改 → 扣分（可能只是运气好）
   - 输了就全推翻 → 扣分（可能只是运气差）
   - 收敛方向一致（多轮迭代后修正方向不来回摇摆）→ 加分
```

### 交叉验证（模拟器，可选增强）

```
如果 LLM 在反思中说"我应该做 X 而不是 Y"：
  → 用 DSL 构造相同场景，分别跑 X 和 Y 的实际结果
  → 如果 X 确实比 Y 好 → 反思正确，加分
  → 如果 Y 反而更好 → 反思归因错误，标记
```

---

## 十、工程管线

```
┌─────────────────────────────────────────────────────┐
│  阶段 0：静态准备（专家一次性）【进行中】              │
│    → 筛选题目、定义检查清单、校准 judge              │
│    → 填写 L2 ground truth（8 套卡组）                │
│    → 填写 L3 ground truth（28 对局，双视角）          │
│    → 自动计算字段 + 专家审核                         │
│    → 产出：questions.json + ground-truth/{decks,matchups}/*.json │
│    → 现状：标注 TUI 已就绪（见下"目录结构"）          │
├─────────────────────────────────────────────────────┤
│  阶段 1：Round 0 初始评测【未实现】                   │
│    → LLM 只看卡组构成，做 L2 分析                    │
│    → 与静态 ground truth 比对，评分                  │
│    → 产出：L2 初始分析质量报告                       │
├─────────────────────────────────────────────────────┤
│  阶段 2：迭代对战 + 反思（Round 1-N）【未实现】        │
│    → 对每个 matchup：                                │
│      ① LLM 读取 LLMDeckKnowledge 做战前预测         │
│      ② 对战（引擎执行）                              │
│      ③ LLM 做战后反思                                │
│      ④ 追加 iterationLog，更新 refinedKnowledge     │
│    → 预测与专家 L3 ground truth 比对                 │
│    → 反思质量评分                                    │
├─────────────────────────────────────────────────────┤
│  阶段 3：终评测【未实现】                             │
│    → 对比 Round 0 vs Round N 的分析质量              │
│    → 检查知识收敛性、反思有效性                      │
│    → 产出：综合报告（含学习曲线、归因分析）           │
└─────────────────────────────────────────────────────┘
```

### 目录结构（现状）

```
packages/benchmark/deck-analysis/
  DESIGN.md              ← 本文件
  src/
    deck-info.ts         ← 卡组信息解析（基于 shared/jsdoc-scan）
    annotate/
      schema.ts          ← v3.0 schema 类型、IO、校验（标注数据契约以此为准）
      tui.ts             ← TUI 基础设施（宽度/渲染/键盘菜单）
      editors.ts         ← 分区编辑器与仪表盘主循环
    cli/
      annotate.ts        ← 标注 TUI 入口（pnpm annotate）
  data/
    deck-list.json       ← 8 套卡池（v6.3.0）
    ground-truth/        ← 专家标注产出
      {version}/
        decks/           ← L2 卡组级标注
        matchups/        ← L3 对局级标注
    llm-knowledge/       ← LLM 自生成知识库（动态，每轮迭代更新；暂空）

packages/benchmark/shared/
  jsdoc-scan.ts          ← 共享 JSDoc 扫描器（本目录与 gi-knowledge 共用）

# 以下模块属于阶段 1-3，尚未实现：
#   src/questions.ts、score.ts、judge.ts、dsl-verify.ts、iteration.ts
#   src/cli/generate.ts、evaluate.ts、score.ts
#   data/questions/、data/results/
```

---

## 十一、专家 vs LLM 的职责边界速查

| 维度 | 专家标注（静态） | LLM 自生成（动态） |
|------|:---:|:---:|
| **用途** | 评分基准 + judge 上下文 | 被评测对象 + 下一轮输入 |
| **内容** | 题目筛选、检查清单、L2/L3 ground truth、judge 校准 | 战前分析、matchup 预测、战后反思、修正知识 |
| **更新频率** | 一次标注，除非卡池大版本变更 | 每轮对战自动更新 |
| **谁生成** | 人类专家 | LLM（被测模型自己） |
| **验证方式** | 定义上就是正确的（不需要验证） | 与专家基准比对 + 模拟器交叉验证 |
| **不可替代的原因** | 推理的"好"的标准只能由人类定义 | 不需要替代——它的价值就在于"看看 LLM 自己能学到什么" |

---

## 十二、与 gi-knowledge benchmark 的关系

| 维度 | gi-knowledge | deck-analysis（本项目） |
|------|-------------|----------------------|
| 测什么 | 卡牌知识记忆（"这张牌什么效果"） | 卡组分析推理（"这副牌怎么赢"） |
| 正确答案来源 | data 源文件 | 专家推理（静态层）+ 引擎验证 |
| 评分方式 | 关键词子串匹配 | 检查清单 + DSL 合法性 + LLM-judge |
| 人工标注量 | 0 | 首次 ~37.5h（8 卡组 + 28 对局×双视角），后续 ~0（仅版本更新时追加） |
| 核心价值 | 测量 LLM 训练数据覆盖度 | 测量 LLM 对复杂游戏的推理能力和迭代学习能力 |
| 是否涉及对战 | 否 | 是（迭代阶段，作为反思质量的输入） |
