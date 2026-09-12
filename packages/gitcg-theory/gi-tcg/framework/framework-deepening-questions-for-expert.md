## 框架深化提问 · 资深玩家答题册

> 目的：在已有的 `framework.md` / `framework-critical-gaps.md` / `framework-missing-modules.md` /
> `missing-modules-guiding-questions.md` / `framework-organization-v2.md` / `framework-open-questions.md` /
> `framework-preliminary-organization.md` / `rl-implementation-spec.md` / `static-effect-meta-priors-for-rl.md`
> 与 `analysis/` 全部文档的基础上，对照 `packages/core` 引擎实现（`game.ts` / `skill_executor.ts` /
> `mutator.ts` / `base/state.ts` / `base/skill.ts` / `base/reaction.ts` / `utils.ts` /
> `builder/context/skill.ts`），列出**仍未在任何文档中被收束、但又会显著影响后续 AI / RL 设计**的问题，
> 整理为一份给资深玩家直接作答的提问册。

> 写法约定：
> - 每个问题都标注：**引擎/文档证据**（含来源行号或文件名）、**当前文档状态**、**为什么必须由人答**。
> - 凡是引擎源码已经写死的事实（如 reaction map、击倒结算顺序），不再问"是不是这样"，只问其**策略含义**。
> - 凡是文档中已经回答过的问题，不重复列出，但若回答之间有冲突，则在"冲突点"小节单独提出。
> - 资深玩家可以只挑感兴趣的部分回答，未答的问题在重写理论时会标记为"暂缓"。
>
> **参考答案约定**（v2 增补）：
> - 凡是能由 `framework-design-principles.md` 中 P1-P5 推导出的问题，已在问题下方追加 **"参考答案（基于 P1-P5 推导，待你检查调整）"**。
> - 参考答案给出的是**基于原则的推导结果**，不是经验答案；用户审阅时只需检查"原则是否被正确套用 / 推导链是否合理"。
> - 如果某条参考答案与你直觉冲突，可能意味着：(a) 我推导失误，需修正；(b) 原则套用边界不清，需在 `framework-design-principles.md` 加注；(c) 原则本身需要修订（罕见但允许）。
> - 参考答案中引用的原则代号 P1-P5 见 `framework-design-principles.md`：
>   - **P1 决策单位主导拆分**：玩家级独立决策才单列；
>   - **P2 AI 结构 ≠ 引擎结构**：玩家决策语义优先，引擎执行因果可省略；
>   - **P3 评估与执行同粒度**：value 与 policy 用同一组特征，差异只在信息可见性；
>   - **P4 知识源优先级（决策时 S3 > S1 > S2，引导期反向）**：在线决策时数据驱动学到的精细模式压 deck 模板压通用元规则；训练初期 S3 没数据时由 S2/S1 提供先验；S3 在某 matchup 上稳定后接管该 matchup 上的判断；
>   - **P5 连续价值 + 多路径并行评估**：单一 V(s) + 多路径取 max，禁止过早分类/路由。

---

## 〇、与引擎实际行为对齐时发现的硬空白（最优先）

这一节的所有问题都来自"翻引擎源码 → 发现文档没明说 / 与文档暗示不一致"。在重写框架之前必须先把这些事实厘清，否则 `def 0` / `def 1` / `def 2` 都会带错。

### 0.1 击倒后的强制结算窗口在框架中怎么定位

**引擎事实**（`builder/context/skill.ts:295-360`，`skill_executor.ts:233-294`）：

- 击倒不是"操作"，而是**当次伤害结算的同步副作用**：在同一个伤害管线内同时完成 `alive=0` / `energy(或 specialEnergy)=0` / `aura=None`，并设置 `hasDefeated` flag、清 `roundSkillLog`。
- 立即进入**强制 `chooseActive`**：对**双方** active 同时检查（双方 active 在同一段伤害链同时倒下也会一起处理），解析顺序按 `currentTurn` 先、再 `flip(currentTurn)`（`skill_executor.ts:273-286`）。
- "免死"是 `modifyZeroHealth` 上的 `_immuneInfo`，在 `causeDefeated=true` 之后才决定不真正去掉 alive；`causeDefeated` 仍然为 true。
- `defeatedSwitching` 是与 `phase` **正交**的 flag（`base/state.ts:165-166` 注释明说"官方实现可能是作为 `phase` 的特殊值，这里我们令其正交"）。

**文档现状**：

- `framework.md` 第十五节"死亡换人/强制切换是否归入操作"仍标为开放（L1070）。
- `declareEnd-hard-constraints.md` §4 默认认为"强制切人不消耗骰子，等于加速一动"。
- `framework-missing-modules.md` §G 把 `T(s,a)` 内部结构整体列为缺口。

**问题**：

1. **`def 1`（操作）是否仍坚持"死亡换人不算 a"？** 但它会改变 `A(s')` 的形状（`activeCharacterId` 变了，`canCharged` / `canPlunging` 随之变）。如果不算操作，下一个决策点的 candidate 集合实际上是"上一手伤害结算 + 对方私有选择"二者共同决定的——AI 的 `Q(s,a)` 是否需要把"对手的强制 chooseActive 选谁"作为一个**未知信息维度**显式建模？
**回答**：部分带有强制切人效果的击倒会跳过该环节。在可以选择出战角色时算作单独的行动。
2. **同一段伤害链同时击倒双方 active**（结晶/扩散反弹后台 + 链式触发，是真实可达的）：你认为应该建模为两个独立的 chooseActive，还是一个联合 chooseActive？前者更接近引擎，后者更接近博弈论的同时决策——这一区别对评估重要吗？
**回答**：后者。评估时拿到尽可能多的信息大概算好事？
3. **免死的策略含义**：引擎把"伤害打到 0 但有免死"和"伤害没打到 0"在 `causeDefeated` / `hasDefeated` 上做了不同处理（前者仍计入 `causeDefeated`，但 alive 不掉）。这是否意味着"打掉一次免死"应该被框架当作一个**独立的 `K_now` 子类**（结构跳变但角色还在）而不是普通的 `D_now`？
**回答**：是。通常这种效果在限定回合/轮次中有次数限制，在下一次“免于被击倒”效果生成前即可直接击倒。

### 0.2 反应增伤、反应附伤、反应附带效果的拆解口径

**引擎事实**（`base/skill.ts:963-998`，`base/reaction.ts:96-117`）：

- 反应增伤是**固定加值**：融化 / 蒸发 / 超载 +2；超导 / 感电 / 冻结 / 结晶（4 种）/ 燃烧 / 绽放 / 激化 / 月相绽放 +1；其他反应（扩散 4 类、月相感电、月相结晶水）**没有直接加伤**，只走附带效果。
- "反应"对象是 `(targetAura, damageType)`，与施法者无关；月相反应通过 `enabledLunarReactions` 白名单替换。
- 扩散是"对该角色阵营的**其他**所有角色各 1 点对应元素伤害"（不是元素传播）——`framework-missing-modules.md` §A 已标注。

**文档现状**：

- `framework.md` §11 写的是"反应项 + 后续触发项"，没有显式说"+2/+1"的加值结构。
- `character-synergy-metrics.md` §① 给的反应权重 `v(reaction)` 是**估值权重**（融化/蒸发 2.0、超导 1.5 等），与引擎实际数值对不上——这个权重表是"卡组评分启发式"，不是 `D_now` 计算。
- `replay-hidden-constraints-analysis.md` H4 说 reaction 链是有意识设计的高收益序列，但没区分"反应自身的加伤"和"反应附带的状态/召唤物收益"。

**问题**：

1. 在 `D_now` 拆项里，下面三类应该单列还是合并？
   - **反应直接增伤**（`+2/+1` 那一档，纯数值）
   - **反应附带的额外伤害**（如冻结造成的"再被物理/火攻击时附加 +1"、感电对全员的电伤、结晶产生的护盾等）
   - **反应附带的非伤害收益**（扩散的 AOE 附着、结晶护盾的 `R_window` 改善、激化的"草原核"类状态）
**回答**：合并。
2. **冻结 / 眩晕 / 石化**这种"控制型反应/附带状态"，更适合归入：(a) `K_now`（即时压制对手），(b) `T_plan`（未来节奏空间），(c) 单独建一个 `Control_now` 项？
**回答**：同时具备ab两项的特征，不需要额外增加项
3. 引擎里 `enabledLunarReactions` 是按白名单启用月相反应的，意味着"是否启用月相"是**卡组带的环境标记**而非局面状态。月相反应在框架里值得单列还是并入普通反应表？
**回答**：模拟器引擎进行额外单列是出于游戏机制而言的，在可以准确选择启用普通反应和月相反应的前提下，从玩家的角度而言不需要单列，简化框架。

### 0.3 成本类型与 ALIGNED / VOID / ENERGY / LEGEND 的策略差异

**引擎事实**（`typings/src/gen/enums.ts`、`utils.ts:847-886`、`base/skill.ts:602`）：

- 真正的费用类型只有 11 个：7 元素 + `VOID`（任意）+ `ALIGNED`（出战同色）+ `ENERGY`（角色独立累积，不是骰子）+ `LEGEND`（秘传，整局一次的标记）。
- `ChangeCardCostTypeModification` / `deductCost` 在打牌前由附件按优先级减费（`utils.ts:847-886`）；同一张牌的 base cost 与运行时 cost 可以差很多。
- 调和的产物默认是出战角色元素，但可被 `ChangeCardTuningTarget` 改变，也可被 `DisableCardTuning` 整张禁用。
- `diceCostApplyAttachments` 在 v6.4.0 起为 true（`base/state.ts:104-115`）：意味着**当前元素骰费用**而非"原本元素骰费用"被用于结算——版本切换会改变同一张牌的策略价值。

**文档现状**：

- `missing-modules-guiding-questions.md` B4 已经回答了"减费等价于多骰子"，并给了林龙马 / 磐岩盟契例子。
- `static-effect-meta-priors-for-rl.md` 把 `cost_reduce_skill` / `cost_reduce_switch` / `dice_fix` 列为效果族。
- 但 `framework.md` §10.1 把"骰子（数量与颜色质量合并为一个变量）"——这种合并对策略的损失从未量化讨论。

**问题**：

1. **`ALIGNED` 与 `VOID` 的策略差异**：引擎层 `ALIGNED` 是"出战角色同色"，所以**切人会改变同一手牌的实际可付方式**——这意味着"出战角色"并不是一个纯节奏/位置量，它**直接进入合法操作集 `A(s)` 的形状**。你是否同意把"出战角色"显式列为**第 0 阶资源**（它先于其他骰子决定哪些手牌可用）？

   **参考答案（基于 P1 推导，待你检查调整）**：同意。"出战角色"满足 P1 的"独立决策"判别——切人本身就是单独 candidate，且会改变后续多步合法集形状。命名建议改为更中性的"决策前置量 / 状态轴"，避免与资源项（血量/骰子/手牌）混淆。形式化：把"当前出战角色 ID + 元素"列为 `s` 的最高优先级字段，决定 ALIGNED 费用卡的可付性。

2. **`ENERGY` 不是骰子**但仍走 `requiredCost`：引擎用 `Map<DiceType, number>` 把它和骰子放一起表示。在框架里它该归资源项还是该单列为"可在多个角色身上累积的私有资源池"？充能的"位置归属"（白垩之术 332009 / 312014 这类抽充能 / 转化充能的卡）正是文档反复提到但没拍板的点。

   **参考答案（基于 P1 + P2 推导，待你检查调整）**：单列为"按角色私有累积的资源池"。理由：(P1) 充能的"何时充 / 为谁充 / 何时释放"是独立决策，白垩之术允许重新分配位置就是独立决策的存在性证明；(P2) 引擎把 ENERGY 塞进 `Map<DiceType, number>` 是执行因果，玩家视角下能量与骰子是完全不同的资源（不可互换、按角色分布、有独立上限）。形式化：`s.energy = [(char_id, current, max)]`，与骰子分轴。332009 / 312014 / 123031 这类非元素爆发兑现路径，归 `E_plan` 的 `energy_alt_payoff` 子项，与"开大招"路径并列（P5 多路径并行评估）。

3. **`LEGEND` / 秘传作为"整局一次"的全局 flag**（`game.ts:819-826` 写到 `legendUsed`）：它的"使用机会成本"是不是应该作为一个**独立的不可再生资源轴**进入 `R_now` 的耗损建模？`analyzer-static-limitations-and-fixes.md` 已经指出"秘传起手保证"是 T1 确定性资源，但没算这一项。

   **参考答案（基于 P1 推导，待你检查调整）**：同意，单列为独立资源轴。秘传"打不打 / 何时打"是跨多回合的独立决策（P1 命中），整局一次的硬限决定其机会成本不可被普通资源量纲表达。落地：`s` 加 `legend_used: bool`；`C_now` 拆项加 `legend_consumption_cost`，仅当本步打秘传时不为 0；权重应较高，且随回合数递减（越靠后剩余回合越少 → 机会成本越低）。

4. `diceCostApplyAttachments` 改版（v6.4.0）让"原本费用"和"当前费用"出现差异。理论是否需要在 `s` 中显式区分"卡的 base cost"与"运行时 cost"，还是只保留运行时值即可？

   **参考答案（基于 P2 + P3 推导，待你检查调整）**：只保留运行时值。(P2) base cost 是引擎用于追踪 modifier 的执行结构，玩家做决策只关心"现在花多少"；(P3) value 与 policy 看运行时 cost 即可。但若未来要做"对手会拍走我的减费支援"这类预测，可在 derived feature 中标记"当前减费来自哪些可被破坏的来源"——这是另一个独立特征，不需要 base cost 本身。

### 0.4 阶段、`pending_method` 与决策点的真实拓扑

**引擎事实**（`game.ts`、`io.ts`）：

- `phase` 有 6 个：`initHands` / `initActives` / `roll` / `action` / `end` / `gameEnd`。
- `action` 阶段中存在 5 种 `pending_method`：`action` / `chooseActive` / `rerollDice` / `switchHands` / `selectCard`。
- `chooseActive` 触发不止"开局选首发"和"被击倒强制"，还有主动战斗切换 / 被动切换导致的中间结算；`selectCard` 由特定卡牌触发；`switchHands` 只在 `initHands` 末尾出现。
- 一回合内**双方都已 declare** 才会进入 `end`（`game.ts:900-916`）；单方 declareEnd 后下一个 `actionPhase` 会通过 `switchTurn` 跳过该方（`game.ts:682-685`）。
- `currentTurn` 初始为 0，永不重置——`turn-order-and-opening-analysis.md` §1.2 已确认。

**文档现状**：

- `framework.md` 把"行动权归属"写成节奏项，但没分 `pending_method`。
- `rl-implementation-spec.md` §3.3 给了 ObservationV1 的 `phase` 与 `pending_method` 字段。
- `declareEnd-hard-constraints.md` 把 declareEnd 单列出来，没系统化讨论其它 `pending_method`。

**问题**：

1. `chooseActive`（被击倒后）和 `chooseActive`（开局/主动产生的中间）在策略上是否应**视为同一类决策点**？它们的合法集大小不同，信息状态也不同（前者紧跟伤害链）。

   **参考答案（基于 P2 推导，与用户 Q2 回答一致）**：视为同一类。引擎用不同 RPC 是执行因果，玩家视角下两者是同一战术语义——"在受限合法集中选最优出战角色"。差异（合法集大小、伤害链信息）通过 obs 的相邻字段（如"上一段是否含 critical damage"、"剩余存活角色 ID 集"）自然表达，不需要单独建类。
   **补充**：但两种行动后的行动权不同，需要额外加以区分。
2. `selectCard` 类决策（如查抽/选牌）目前文档完全没单独讨论，但它在数据上是**可观测的对手手牌缩窄**——你认为 `selectCard` 的策略价值更靠近：(a) `M_now`（已兑现的资源摆动），(b) `S_plan`（中间状态 / 未来手牌质量提升），还是 (c) `N_plan` 的反向——主动暴露给对手的"信息释放"代价？

   **参考答案（基于 P1 推导，待你检查调整）**：归入 `S_plan`（中间状态收益）为主，`N_plan` 反向作为辅助。`selectCard` 的核心价值是"未来手牌质量提升"——选定的卡进入手牌、影响下几步的 candidate 集，与 `M_now`（当下兑现）不同。但 P1 提示"选哪一张"是独立决策（跨多步影响），所以 `selectCard` 应**单列为 candidate family**（与 `action` / `chooseActive` 并列），不只作为 obs 字段。"信息释放代价"次要，第一版可不单列。

3. `switchHands`（mulligan）目前只在 `initHands` 末尾发生一次。RL contract 里它的最优策略**强烈依赖未公开的对方阵容信息**（看到对方角色后才能决定调什么）。你认为 mulligan 评分应走"独立子策略 + 对方阵容先验"，还是和后续行动统一进 ranker？

   **参考答案（基于 P1 + P4 推导，待你检查调整）**：独立子策略。(P1) mulligan 是完全独立的决策窗口（只 1 次、不与后续 action 共享候选编码）；(P4) 第一版 S3 几乎无 mulligan 数据（每局 1 个数据点），因此引导期由 S2 跨卡组规则（"留组合关键件、调高费、调没用上的"）+ S1 deck-aware LLM gameplan 提示主导；待 S3 在足够 matchup 上稳定后再让学到的 mulligan policy 接管。落地：mulligan 走规则策略 + LLM gameplan 提示，**不进主 ranker**（与速答 Q3 一致）。
   **补充**：事件牌“草与智慧"也有类似效果，但战术语义不同（在对局已进行一段后，根据当前局面优化当前手牌）

### 0.5 二段伤害管线与"安全 / 致命"事件序

**引擎事实**（`builder/context/skill.ts:295-413`）：

- 同一次伤害结算实际上跑了**两段**：
  - safe damage events（不会击倒的伤害）先跑常规 `onDamageOrHeal`；
  - critical damage events（会击倒）走 `modifyZeroHealth → immune?` 流程，只有 `alive=0` 才进 critical。
- 之后才广播 `onDefeated` / `defeated`。
- `causeDefeated` 由 `modifyDamage3` 的最终 value 与 `targetHealth` 比较得出（`base/skill.ts:931-944`）：减伤 / 增伤的最终结算才能判定，启发式预估有偏差。

**文档现状**：完全没有任何文档讨论这个二段结构。`framework-missing-modules.md` §G 只是泛泛说"结算流程是黑盒"。

**问题**：

1. 二段结构意味着"打到 1 滴血"和"打到 0 死亡"在事件触发顺序上是不一样的。理论模型需不需要把这一层显式纳入 `T(s,a)` 描述？还是把它视作"工程上由模拟器处理"，策略层只用关心 `damage / kill / immune` 三态？

   **参考答案（基于 P2 推导，待你检查调整）**：不显式纳入 `T(s,a)`，策略层只关心 `damage / kill / immune` 三态。二段管线是引擎执行因果（P2 典型反例：引擎区分但玩家视角不需要还原）。玩家做决策时只看"会不会死 / 是否触发免死 / 打剩多少血"，不关心"中间穿越了几个事件钩子"。

2. 多段伤害的"安全段先打到 1 滴血、致命段补刀"链式情形下，AI 用"基础伤害 ≥ HP 即斩杀"的启发式（`declareEnd-hard-constraints.md` 约束 1）会有偏差吗？是否应改成"min over modifyDamage3 path 后的最终值 ≥ HP"？

   **参考答案（基于 P3 推导，待你检查调整）**：应改成"经过 `modifyDamage3` 的最终值 ≥ HP"，由模拟器 preview API 给出，不重新实现。(P3) value 与 policy 需要"准确斩杀判定"——一方用真值一方用启发式会违反 P3。引擎的 `ActionPreviewer.modifyAndPreview`（`game.ts:1132`）已经能算最终伤害，应直接调用。

### 0.6 `replaceAction` 与"被替换的动作"在框架中没位置

**引擎事实**（`game.ts:709-720`）：在每个 `action` 决策点之前，有 `findReplaceAction(state, eventArg)`：若被命中，玩家本次的合法动作直接被替换为该 skill（典型如部分被动每回合首次行动改普攻、强制切人结算等）。被替换执行完后直接 `switchTurn`。

**文档现状**：所有理论文档都默认"决策点 = 玩家在 `A(s)` 中选 a"，从未提到 replaceAction 这条"在玩家选择前就被引擎接管"的路径。

**问题**：

1. `replaceAction` 实际上是引擎层的"`A(s)` 被截断为单元素集"。这种**强制行动**应该作为：(a) 视为 `A(s)` 的退化情况（合法集是单元素），(b) 视为 `T(s,·)` 的另一种形式（不需要 a），(c) 单独建一类"强制操作"事件？

   **参考答案（基于 P1 + P2 推导，待你检查调整）**：(a) `A(s)` 的退化情况。(P1) replaceAction 没给玩家选择，不是独立决策，不需要单列；(P2) 玩家视角下就是"这一步我没得选"，等同 `|A(s)| = 1`。落地：candidate ranker 看到单元素合法集自动退化（无候选可比），不需要特殊代码路径。可在 obs 加 `forced_action: bool` 标记用于分析，但不影响决策。

2. 这与 §0.1 的"被击倒强制 chooseActive"在抽象上是同类问题（玩家可选项被引擎压缩到 1）。是否值得在 `def 1` 层引入一个"被强制度"的维度？

   **参考答案（基于 P1 推导，待你检查调整）**：不需要。"被强制度"对应的玩家决策都在合法集 size 中体现（size=1 即强制），另设维度违反 P1（不存在玩家级决策需要"判断当前自己有多被强制"）。

---

## 一、定义层（`def 0` / `def 1` / `def 2` / 价值符号）的剩余硬空白

### 1.1 `s` 是真实状态还是信息状态——文档内部冲突

**冲突点**：

- `framework.md` §二明确区分了"真实状态" vs "有限信息状态"，并把对手手牌写成概率上界。
- 但 `framework.md` §四又写"对手未知信息不影响 `A(s)` 的合法性"。
- `framework-organization-v2.md` §四把 `V(s)` 写成"某策略下从 s 出发的期望价值"——这里的 s 是哪一个？
- `rl-implementation-spec.md` §3.9 提供了 `debug_full / policy_public` 双视角，但没要求二者价值口径相同。

**问题**：

1. 你最终倾向哪一种正式定义：
   - (a) `s = (公开, 我方私有, 对手私有)` 完整真值，`V*` / `Q*` 都对真值定义，价值学习对每个 `obs_policy_public` 求条件期望；
   - (b) `s = belief_state`（含对手手牌分布），`V` / `Q` 直接对信念状态定义；
   - (c) 双层：理论层用 (a)，工程层用 (b) 的 `policy_public` 投影。

   **参考答案（基于 P3 推导，待你检查调整）**：(c) 双层。(P3) 评估和执行用同一组特征。理论层用真值便于推导，工程层 V/Q 都用 `policy_public` 视角的 belief_state 投影实现，二者保持一一对应。`debug_full` 仅作训练时上界对照、对手建模数据增广用，不进生产策略。这是 (a) 与 (b) 的折中：保留 (a) 的理论清晰度，但工程实现拒绝二者割裂。

2. `obs_debug_full` 在评测时是否要求"对相同信念状态下两个视角的 V 一致"？还是允许它们因信息差不一致？

   **参考答案（基于 P3 推导，待你检查调整）**：**不要求**两视角 V 一致——这正是 `debug_full` 存在的价值（量化"完美信息下能多赢多少"，反推 `policy_public` 的优化空间）。但要求两视角共用同一组 derived 特征定义（同等粒度，差异只在哪些字段被遮蔽）。

### 1.2 `Q_total` 与 `Q^π` 的桥接没有写下来

**文档现状**：

- `framework.md` §13.4 说 `Q_total ≈ Q(s,a)` 的工程展开。
- `framework-critical-gaps.md` §1.1 已经回答 `r(s,a) = (G_now - C_now)`、`γ E[V(s')] ≈ (G_plan - C_plan)`，风险 `R(s,a)` 拆到两端。
- 但**风险怎么拆**仍没写：`R_role` 主导兑现期、`R_window` 主导即时段、`R_state` 主导未来分布——这种主导划分够直觉，但缺一句"形式化的归并规则"。

**问题**：

1. 你是否认可下面这条精化版归并规则：
   ```
   R_role  → 全部进 γ·E[V(s')]（功能坍缩 = 未来期望价值下降）
   R_window → 主要进 r(s,a)（当前窗口被破坏 = 即时损失），少量进 γ·E[V(s')]
   R_state → 全部进 γ·E[V(s')]（局面分布滑向更差区域）
   ```
   如果不认可，你愿意写下哪条？

   **参考答案（基于 P5 推导，待你检查调整）**：认可这条精化规则。(P5) V(s) 是连续标量，把所有"未来负面分布"都吸到 `γ·E[V(s')]` 里是单标量的自然要求。`R_window` 拆到两端是边界情况——如果窗口被破坏的代价主要在"本步本来要兑现却没兑现"，那就是 `r(s,a)` 部分；如果是"以后再也兑现不了"，就是 `γ·E[V(s')]` 部分。具体比例不重要（都进同一个 V），不需要硬分。

2. 引擎里 `causeDefeated` 是当次结算的硬事件——`R_role` 在击倒发生那一步实际**已转成 `K_now` / `-K_now`**。你接受"`R_role` 只在'潜在坍缩'阶段为正，一旦坍缩发生就转成已兑现项"这一语义切换吗？

   **参考答案（基于 P1 推导，待你检查调整）**：接受。这是 P1 的自然推论——"潜在坍缩"和"已兑现击倒"是不同的玩家决策对象（前者影响"要不要保 / 要不要换"，后者影响"接下来局面怎么打"），分属不同子项。语义切换在 `causeDefeated=true` 那一帧完成，不需要专门触发——只要每帧重新算 `K_now` / `R_role`，转换是自动的。

### 1.3 折扣系数 γ 与回合上限的相互作用

**引擎事实**：`maxRoundsCount = 15`（`base/state.ts:73`）。
**文档现状**：`framework.md` §13.5 把 γ 锁定为"时间偏好"。

**冲突点**：有限回合 + 终局二值 reward 的设定下，标准 RL 通常用 `γ = 1` 直接最大化期望胜率；任何 `γ < 1` 都会扭曲"控制内战拖到第 14 回合再发力"的相对偏好。

**问题**：

1. 第一版 RL 训练，你倾向 `γ = 1` 还是 `γ < 1`？

   **参考答案（基于 P5 推导，待你检查调整）**：`γ = 1`。(P5) V(s) 直接编码胜率，控制内战拖到 R14 再发力是合法路径，不应被 γ 衰减。终局二值 reward + 有限 15 回合 + γ=1 → `V(s) = P(win|s) - P(loss|s)`，语义最干净。

2. 若 `γ < 1`，你怎么解释"控制内战拖到 R14 再发力"在该 γ 下的合理性？

   **参考答案**：跳过（γ=1 后此问消解）。

3. 你是否同意把"剩余回合数"显式作为 observation 字段（不靠 γ 衰减来表达）？`framework-critical-gaps.md` §3.4 已部分回答（同意），但请确认正式纳入。

   **参考答案（基于 P3 推导，待你检查调整）**：同意。`rounds_remaining = maxRoundsCount - roundNumber` 进 `policy_public`。P3 要求时间压力信息对 value 与 policy 都可见。

### 1.4 `def 1` 的"操作实例"与 RL action contract 的最小公倍数

**引擎事实**（`game.ts:723-898`）：单次 `action` decision point 必须同时给出 `(chosenActionIndex, usedDice[])`——选哪个动作 **+** 用哪些骰子。骰子选择与动作选择是**绑定**的，不是分开两个决策。
**文档现状**：`framework.md` §3 写"同一动作采用不同支付方式，也是不同操作"。`rl-implementation-spec.md` §4.6.1 提到 `auto_selected_dice`/`used_dice_spec`。

**问题**：

1. `(action, usedDice)` 同时是动作的一部分意味着候选枚举量 = `Σ_action C(可用骰子, requiredCost)`，远超"动作类型数"。你是否同意把"骰子选择"作为一个**自动可解的子问题**（启发式 `applyAutoSelectedDiceToAction`）而不是 RL 学习的对象？或者：mulligan / reroll / 骰子选择都交由"非学习子模块"处理，RL 只学 action_case + target？

   **参考答案（基于 P1 + P4 推导，待你检查调整）**：同意。骰子选择不构成独立战术决策（P1：除少数特例如"必须留给后续技能的特定颜色"外，玩家不会单独考虑"用哪几颗骰子付这个费"），且第一版 S3 没有足够数据精细化骰子选择（每个 action 下骰子组合极多 → 数据稀疏），用 S2 元规则启发式（"最不通用骰先用"）已足够（P4 引导期）。少数特例（保留色用于天守阁 / 吞星之鲸 / 后续大招）通过 GamePlan 模板里的 `dice_reservation` 软约束（S1）传给启发式，不进 RL action 空间。后续若 S3 在该子问题上学到稳定模式，可允许其覆盖。
   **补充**：不同意，“必须留给后续行动特定颜色的骰子”的决策非常常见，需要评估该维度的学习难度后再次做出选择。
2. 反过来，"先调和 → 再行动"在引擎里是两个独立的 decision point，每个都是单 action。这与你在 `missing-modules-guiding-questions.md` B2 给的"先调和后行动"建议一致——但**调和的目标元素**（默认出战，但可被 `ChangeCardTuningTarget` 改）决定了下一步 cost 计算。是否需要在调和决策的 candidate 编码里强制带 `tuningTarget` 维度？

   **参考答案（基于 P1 推导，待你检查调整）**：需要。当 `ChangeCardTuningTarget` 生效时，调和的目标元素本身是独立决策（不同 target → 不同后续合法集），符合 P1 单列条件。当无 modifier 时（默认出战同色），可省略此维度。即：candidate 编码字段为 `tuningTarget?`，仅在多个可选 target 时填充。

---

## 二、价值层（`Q_total` 各子项）的拍板需求

### 2.1 `D_now` 的拆项粒度（接 0.2）

继续 §0.2 的反应口径之后，需要定下：

1. **直伤 / 穿透 / 分段** 在 `D_now` 内是否再细分为子项 `D_direct` / `D_pierce` / `D_split`？分段伤害的策略价值（多次小伤更易触发反应、通过减伤分裂更稳）你在 framework §11 提过，但未列入子项。

   **参考答案（基于 P1 推导，待你检查调整）**：不细分。穿透/分段不是玩家的独立决策——它们是技能/卡牌固有属性，玩家选了技能就一并决定。`D_now` 保持一个聚合数值，让 V/policy 通过其他 obs 字段（如目标 HP、是否触发后续反应）自动学到分段/穿透的价值差异。

2. **召唤物伤害** 在 `D_now` vs `S_plan` 之间应怎么归：
   - (a) 召唤物当回合触发 → `D_now`；
   - (b) 召唤物**未来回合**预计触发 → `S_plan`（你已在 framework §3.2 列过"召唤物剩余次数"）；
   - (c) 是否单独建立 `D_summon_future` 表示"召唤物剩余触发的折现伤害期望"？

   **参考答案（基于 P1 推导，待你检查调整）**：(a)+(b) 组合，不另设 `D_summon_future`。当回合的召唤物伤害与玩家选择"打这个技能召唤"是同一决策点 → `D_now`；未来回合的不是独立决策（玩家不会"单独决定让召唤物触发"）→ `S_plan` 的 `summon_remaining_value`。单独 `D_summon_future` 与 `summon_remaining_value` 重复（P1 反例：合并）。
   **补充**：有回合内直接触发召唤物的机制。

3. **反应链**在分类上属于：(a) `D_now` 的复合事件，(b) `L_plan` 解锁线（已搭好的链 = 一次大兑现），还是 (c) 跨项？

   **参考答案（基于 P1 + P5 推导，待你检查调整）**：依"链是否被有意识设计"分两情形：**临时反应**（这步打火 + 上回合挂水的偶然蒸发）→ `D_now` 复合事件（不是独立长程决策）；**有意识设计的反应链**（雷鹤 E→Q→Q 超导链、神宵宵宫 Q+神里融化）→ `L_plan` 展开线（玩家在多回合内有意识铺路 → P1 单列）。两者用 P5 的多路径并行评估：value 同时算"走反应链路径"和"走纯输出路径"的潜力，policy 取 max。实现上不需要"分类器"判定属哪种，只要 `L_plan` 的 prerequisites 字段足够细，未触发时该路径的潜力自动小。

### 2.2 `K_now` 的"功能坍缩 vs 单纯击倒"该不该再拆

文档已经把"角色被击倒"和"角色失去关键功能"区别开（`framework.md` §9.1.2 / §14.3 / `analysis/three-character-collapse.md`），但 `K_now` 目前是**一个项**。

**问题**：

1. 哪种 `K_now` 拆分对策略更有用？
   - (a) `K_now = K_kill + K_function_collapse + K_immune_break`（击倒 / 功能坍缩 / 打掉免死）；
   - (b) `K_now = α·K_kill + β·K_collapse_after_kill`（击倒 + 击倒带来的体系结构坍缩，β 反映 3→2 / 2→1 不可逆）；
   - (c) 不再拆，但要求引擎事件里能显式给 `K_now` 加 deck-aware 系数。

   **参考答案（基于 P1 推导，待你检查调整）**：(a)。理由：(a1) "打掉免死"已在 §0.1.3 由用户确认为独立子类（P1 命中）；(a2) "功能坍缩"是分层的、与具体击倒事件解耦（一个角色可能没击倒就已坍缩，已击倒但还有残余功能），P1 命中应单列；(a3) "单纯击倒"是结构跳变事件，P1 命中。三者并列：`K_now = K_kill + K_function_collapse + K_immune_break`，可同时为正（一次结算同时打掉免死 + 击倒 + 触发功能坍缩）。

2. 你之前给过：迪希雅"开 1 次战技 + 召唤物到位后即可送掉"（`replay-hidden-constraints-analysis.md` 案例 4）。这说明同一个角色的 `K_kill` 系数是**回合相关**（前 2 回合很高，第 3 回合后骤降到接近 0）。`K_kill` 系数的衰减曲线，理论上你觉得更适合：
   - (a) 由角色 + 卡组手写定义"何时变废"；
   - (b) 用"角色已使用过的关键技能数 / 该角色对队伍胜利路径的贡献已兑现比例"作为 deck-agnostic 代理；
   - (c) 直接交给 RL 学，不给先验。

   **参考答案（基于 P4 推导，待你检查调整）**：(b) 优先（引导期），(a) 兜底，目标是 (c) 接管。理由：(P4 引导期顺序 S2 → S1) 先用 deck-agnostic 代理（S2 跨卡组通用代理，"已使用关键技能数 / 贡献兑现比例"），不够再叠 deck-aware 模板（S1）。但**最终决策时**应让 S3 学习并覆盖该衰减曲线——人类经验给的代理函数不可能精确捕捉每个角色每个 matchup 下的真实衰减（P4 决策时 S3 > S1 > S2），(c) 完全不给先验在引导期会让 S3 学不动，但 S3 一旦稳定就该接管。

3. `analysis/three-character-collapse.md` 论证 3→2 不可逆。`framework-critical-gaps.md` §3.1 你已确认"2→1 也有质变（无法切人让先手）"。这两个跳变点的策略价值是否对称？或者 2→1 比 3→2 更剧烈？

   **参考答案（基于用户原文推导，待你检查调整）**：2→1 比 3→2 更剧烈。用户原话：2→1 时**完全无法**通过切人让先手、无法规避伤害和元素反应——是**新增**的不可恢复约束，3→2 只是"自由度下降"。落地：`K_collapse_after_kill` 的系数在 2→1 时显著高于 3→2，建议比例 ≥ 1.5×。

### 2.3 `T_now` / `T_plan` 的子指标重写（取代"节奏"原子概念）

`framework-critical-gaps.md` §1.3 你已经决定"不再把节奏当成独立原子概念，而是拆成可度量子指标"。但**具体子指标清单**仍未写下。

**候选子指标**（请逐项判定：保留/修改/删除）：

- `dice_efficiency`：骰子换有效行动密度（行动数 / 骰子消耗）。
- `forced_response_count`：当前回合内迫使对手做出响应的次数。
- `action_advantage`：本回合内我方比对手多打的"战斗行动数"（不计快速行动）。
- `tempo_pressure`：对手剩余资源 / 我方剩余资源。
- `window_alignment`：当前我方关键窗口（爆发就绪、反应链就绪、组合技就绪）的可执行度。
- `priority_keep`：保留的行动权数（快速行动 + declareEnd 抢先）。

**问题**：

1. 上述哪些子指标你认为可以稳定计算？哪些其实需要先做对手建模（如 `forced_response_count` 取决于对手是否真的响应了）？

   **参考答案（基于 P3 推导，待你检查调整）**：
   - **可稳定计算**（仅依赖己方/公开状态）：`dice_efficiency`、`action_advantage`、`tempo_pressure`、`window_alignment`、`priority_keep`。
   - **需对手建模**：`forced_response_count` 依赖"对手是否被迫响应"——但 P3 要求评估和执行同粒度，对手建模成本高且不稳定。建议第一版改写成"我方动作中**理论上**应迫使对手响应的次数"（用 effect family 标注：`reaction_enable / burst_enable` 类动作 +1），不依赖对手实际行为。

2. 是否补充"切人价值差" `switch_value_delta`（A→B 的切换让 B 在下回合更值，定量为下个 action 期望价值的差）？

   **参考答案（基于 P5 推导，待你检查调整）**：不补充。`switch_value_delta` 实质是"如果切了 vs 不切的 V(s') 差"，本身就是 V(s) 已经吸收的信息（P5 单一 V 原则），再额外计算等于双计。需要它的场景（人类解释切人价值）改为"模型决策后输出 candidate Q 值差"作为可解释性指标，不进 obs。

3. `T_now` / `T_plan` 在 deck 间是否可共享同一组子指标？还是必须 deck-specific？

   **参考答案（基于 P4 推导，待你检查调整）**：共享同一组子指标，权重最终由 S3 学。(P4) 子指标本身（"骰效率"、"行动密度"等）是跨卡组通用概念（S2 引导可定义），快攻 vs 控制对它们的权重不同——引导期由 GamePlan 模板（S1）给初始权重；但**决策时**让 V/ranker 自己学到该 deck-matchup 下的精确权重（S3 接管，因为 S3 > S1 > S2）。不要在 deck 间复制特征，不要硬编码 archetype 权重表。

### 2.4 `S_plan` 的"中间状态价值"该如何离散

`framework.md` §9.3.2 列出 `S_plan` = 后续反应铺路的元素附着 / 召唤物建立 / 轮转位置改善 / 接近兑现窗口的状态变化。

**引擎相关性**：附着只有"有/无"两态（`base/reaction.ts` 注释），没有"附着量"概念；召唤物用 `usage`（`PbEntityState.variableValue`）记次数；支援用持续轮次 / 计数。

**问题**：

1. `S_plan` 是否应固定拆为四个可数字段？例如：
   - `aura_setup_score`（己方/对方各角色的可触发反应配对数）
   - `summon_remaining_value`（剩余次数 × 每次预期收益）
   - `support_remaining_value`（剩余轮次 × 每轮预期收益）
   - `position_alignment`（关键角色当前是否在前/后台正确位置）

   **参考答案（基于 P1 推导，待你检查调整）**：同意四字段拆分。四类中间状态对应四类独立的玩家长期决策——附着关心反应链路径、召唤物关心持续输出、支援关心资源/控制持久度、位置关心切人时机。P1 命中。

2. 其中"每次/每轮预期收益"是否需要 deck-aware？还是允许第一版用引擎事件的全局平均值？

   **参考答案（基于 P4 推导，待你检查调整）**：第一版用全局平均（S2 引导启动），稳定后让 S3 学到 deck-aware 权重并接管（P4：决策时 S3 > S1 > S2）。S1 模板调权作为 S3 数据未覆盖区的过渡。

3. 阿佩普的绿洲守望者（2702）这类**计数门槛触发**的支援（你在 `missing-modules-guiding-questions.md` 3.3 提过）应该把"距离阈值的距离"作为一个独立 `setup_progress` 子项吗？

   **参考答案（基于 P1 推导，待你检查调整）**：不单设 `setup_progress`，并入 `support_remaining_value`。"距离阈值"对玩家不是独立决策（玩家选打不打衍生牌时就一并考虑了进度）；应在 `support_remaining_value` 的 deck-aware 权重里捕获——阿佩普的"每次预期收益"是**门槛函数**（达到 4 次后跳变到大值，未达到时为 0）。这与 P5 一致：用连续 V + 离散阈值特征，不另设路由。
   **补充**：阿佩普的绿洲守望者（或简称草龙）的召唤物可以通过手牌中/牌库中弃置进行召唤，不过也能在召唤物维度进行。

### 2.5 `L_plan` 的展开线可观察性

`L_plan` 是已被识别为 deck-specific 的项（`framework.md` §9.8.3）。

**问题**：

1. 你愿意把"展开线"形式化为 `(prerequisites: 集合, completion: 0..1, payoff: 一次性大兑现)` 三元组吗？

   **参考答案（基于 P5 推导，待你检查调整）**：同意三元组形式化。三元组保留所有必要信息（前置/进度/收益），不引入分类（符合 P5）。

2. 林龙马的"圣遗物 → 千年珍珠骏麟 → 若陀龙王 → 捷德弃置"按这种形式可写为：
   ```
   prereq = {圣遗物到位, 捷德到位, 弃置目标存在}
   completion = 已就位组件数 / 总组件数
   payoff = 当回合产生大量额外费用 → 多次行动
   ```
   但"完成度"在多步反应链上不是单调递增（中途被对手打断会回退）。是否需要引入 `setback_distance` 作为反向项？

   **参考答案（基于 P1 推导，待你检查调整）**：不需要 `setback_distance`，但 `completion` 必须是**双向**的（可正可负、可减少）。"回退"不是独立玩家决策（被对手打断是被动事件），P1 不命中；但 V 需要看到当前 completion 比上一帧低，自动学到"哪些动作会导致 completion 下降，应避免"。工程上：`completion` 每帧重算，不维护历史。

3. 多条 L 线并存时（如吞星之鲸的"调和 3 张同费"+ 后期单挑），`L_plan` 应该是 `max` 取最有希望的一条，还是 `Σ`？

   **参考答案（基于 P5 推导，待你检查调整）**：`max`（多路径并行评估的直接应用）。`Σ` 会让"两条都半成"误判为"一条全成"，违反 P5 的"不允许过早分类砍路径"。

---

## 三、风险层（`R_role` / `R_window` / `R_state` / 功能层级）的形式化

### 3.1 "功能"的可计算定义（接 `framework-critical-gaps.md` §1.2）

你在 critical-gaps §1.2 已经认可"功能 = 该角色可贡献正价值的操作子集，功能丧失 = 该子集坍缩为空或接近空"。但还有问题没拍板。

**问题**：

1. 久岐忍（1411）的例子：技能生成的出战状态在已存在时只能刷新次数，**这种"功能退降"不是离散的 0/1**。你愿意把功能层级写成：
   - 0 (核心) → 1 (战术) → 2 (残余) → 3 (功能彻底坍缩)
   - 三个连续 score：`E[Q_role | role执行核心任务]`、`E[Q_role | role执行战术任务]`、`E[Q_role | role执行残余任务]`，按 max 取当前层

   **参考答案（基于 P5 推导，待你检查调整）**：用三个连续 score + max。这是 P5 多路径并行评估的角色级版本——同一角色的不同功能层级是不同"路径"，不应过早分类到某一层。久岐忍刷新出战状态既不算"完全有效"也不算"无效"，连续 score 自然表达。

2. "功能层级"是否需要随**回合数 / 局面阶段**变化？同一个角色在 R2 与 R10 的"核心功能"是否应不同？

   **参考答案（基于用户原文推导，待你检查调整）**：需要随回合 / 已兑现进度变化（迪希雅 R2 vs R10 例已确认）。落地：每个 score 的计算函数接受 `current_round` 与 `cumulative_role_progress` 作为参数；不需要离散切换"R2 用核心、R10 用残余"——交给 V 学。

3. 是否需要把"功能可兑现窗口"显式写成时间轴标记，例如：
   ```
   role.core_window = (R2-R3)  # 核心功能必须在这两回合内兑现
   role.tactical_window = (R1-R6)
   role.residual_window = (R6+)
   ```

   **参考答案（基于 P4 + P5 推导，待你检查调整）**：需要，但**只在 GamePlan 模板里出现**，不进 V 的 obs。(P4) 时间窗口是 deck-aware 信息（S1 引导填充），不是跨卡组规则；S3 决策时可直接从"角色 + 已用技能 + 当前回合"组合学到隐含窗口（决策时 S3 > S1）。(P5) 模板生成时输出离散窗口标记，但 V 看到的只是"距离 core_window 末端还有多少回合"这一连续特征——不要让 V 显式区分"我现在在 core_window 还是 tactical_window"（违反 P5 过早分类）。

### 3.2 风险时间尺度的拍板

`framework.md` §14.4 给出"短期（下一次行动）"和"中期（完成本轮职责前）"两层。`ai-improvement-plan-v3.md` §1.1 进一步引入"对手伤害容量 / 角色 HP"作为 survivalRisk 代理。

**问题**：

1. 你是否同意把短期 / 中期风险数学化为：
   - `R_short(s, role) = P(role.alive=0 在下一次双方行动序列内)`
   - `R_mid(s, role) = P(role 无法在本回合完成预定职责)`

   **参考答案（基于 P1 推导，待你检查调整）**：同意。两个风险对应两类独立玩家决策（"立刻保 / 立刻换" vs "本回合内调整 plan"），P1 命中。

2. `R_mid` 中"预定职责"如何指定？由 GamePlan 注入？由 Game-level 模板查表？还是从角色当前层级自动推断？

   **参考答案（基于 P4 推导，待你检查调整）**：GamePlan 注入（S1 引导）+ 角色层级兜底（S2 兜底）+ 最终由 S3 学到精细的 deck-matchup 职责映射（接管）。GamePlan 显式给出"本回合该角色应完成 X 事件"时优先用，没给时用"该角色当前最高 active 层级的代表任务"；S3 数据稳定后允许覆盖前两者。

3. **跨回合**风险（如"接下来 2 回合内能否承受对手两次大招"）是否应单独建一个 `R_long`？还是用 `γ E[V]` 自动覆盖？

   **参考答案（基于 P5 推导，待你检查调整）**：用 `γ E[V]` 自动覆盖。跨回合风险没有独立玩家决策窗口（玩家不会"专门为应对 2 回合后的风险而做一个动作"，决策永远是"现在做什么"），不命中 P1；同时单建 `R_long` 又违反 P5（多个并列项让 V 重复学）。
   **补充**：玩家会应对2回合后的极高风险的行动做出应对，包括但不限于组件破坏（以极限之名、旧日鏖战等等）、压低核心角色血线甚至直接斩杀、为限制行动做准备（莱伊拉的飞星，钟离的天星等），但大部分可以归到其他项中，有待后续详细检查与讨论。

### 3.3 风险与反应增伤倍率的耦合（接 `ai-improvement-plan-v3.md` §4.2）

`ai-improvement-plan-v3.md` 提出 `opponentReactionAmplifier` 启发式估计（双方阵容元素决定 1.0 / 1.5 / 2.0）。**注：该乘法 amplifier 是错误建模，引擎实为固定加值（见 §0.2 / 下方问题 2），已在 `ai-improvement-plan-v3.md` §4.2 修正为 `opponentReactionBonus`（+2/+1/+0）。**

**问题**：

1. 这个启发式是否够用？或者需要按"对方已附着的元素 + 对方角色元素技能比例"做更细的 ampl 估计？

   **参考答案（基于 P4 推导，待你检查调整）**：第一版只用阵营元素估计 + **固定加值表**（S2 通用引导：可触发蒸发/融化/超载 → +2，超导/感电/冻结/结晶/燃烧/绽放/激化 → +1，扩散等 → +0），后续随 S3 数据积累，让对手增伤估计直接由"该 matchup 历史 reaction 触发频率 + 类型"统计学到（S3 接管），S1 deck-aware 模板作为过渡。P4 引导期 S2/S1 → 决策时 S3。

2. 反应增伤的"倍率"在引擎层其实是**加值** `+1/+2`（§0.2），不是乘法。把它表示为乘法 amplifier 在 deck-vs-deck 评估上是否系统性偏差？

   **参考答案（基于 P3 推导，待你检查调整）**：是系统性偏差，**必须改成加法**。乘法模型会随基础伤害放大增伤：6 点技能蒸发被估成 `6×2=12`，而引擎实际是 `6+2=8`——高基础伤害技能被系统性高估威胁，低伤技能被低估。已确认改法：威胁 = `damage_capacity + reaction_bonus`（加法），`reaction_bonus ∈ {+2, +1, 0}` 按可触发反应类型查表。不再保留乘法 amplifier。同时在 obs 中保留"对方平均/最大技能伤害"特征，让 V 学到剩余结构。`ai-improvement-plan-v3.md` §4.2 已据此重写 `computeCollapseDistance` 与 `estimateReactionBonus`。

3. `R_state` 中"对手蒸发/融化体系威胁高于纯岩"这种结构差异，是否需要在 risk 模型里区分"威胁类型"（爆发型威胁 vs 拖延型威胁），而不是只看一个 `damage_capacity`？

   **参考答案（基于 P5 推导，待你检查调整）**：不区分类型（违反 P5）。统一用 `damage_capacity_short / damage_capacity_long` 两个连续值（短期内最大单次 / 长期累积）即可表达威胁结构差异，不引入"类型路由"。

**补充**：严格按照引擎层的计算原则！！！这一部分对应的错误应该全部改掉！

---

## 四、对手建模（minimax + 先验）的具体落地

### 4.1 minimax 的搜索深度与剪枝口径

`framework-critical-gaps.md` §2.2 你已经选定 minimax + 强先验，并怀疑"通过先验降低计算量"。

**问题**：

1. 你倾向的具体搜索范围：
   - (a) 单步 minimax（我方一动 → 对方一动）；
   - (b) 单回合 minimax（我方完整行动序列 → 对方完整行动序列）；
   - (c) 双方各完整 1 回合（一整轮）；
   - (d) 全游戏 minimax（不可行）。

   **参考答案（基于 P4 推导，待你检查调整）**：(c) 双方各完整 1 回合，由 V 接管之后。理由：单步太浅（看不到组合技收益）；单回合不对称（我方多看一动）；全局不可行；一整轮恰好覆盖"我方一回合 + 对方一回合"的反击窗口，与"看 ≥ 2 次行动"的玩家级元规则一致。之后用 V(s_after_1_round) 接管——S3 学到的 V 在已展开 1 轮后承担剩余评估（决策时 S3 > S1 > S2）。

2. 在哪一层用 minimax，在哪一层用 self-play 对称采样？

   **参考答案**：minimax 用于 candidate ranking（决策时刻），self-play 用于训练数据生成。两者不冲突。

3. 用什么作为剪枝先验？(a) `Q_total` 启发式打分排序后只保留 top-k；(b) effect-family 先验过滤；(c) GamePlan 限定的合法子集？

   **参考答案（基于 P4 推导，待你检查调整）**：组合 (a)+(c)。(a) `Q_total` 启发式排序就是 ranker 输出（S3 学到的精细模式）——决策时优先（P4：S3 > S1）；(c) GamePlan 限定子集是 S1 deck-aware 模板，作为 S3 在该 deck 数据稀疏时的兜底裁剪。(b) effect-family 先验粒度太粗（同族卡时机价值差异大），单独用易误剪。剪枝顺序：先用 ranker 取 top-k，再用 GamePlan 裁掉与当前主路径明显冲突的候选。

### 4.2 隐藏信息建模与 minimax 的协同

**冲突点**：

- minimax 默认完美信息；七圣是非完美信息。
- `framework-critical-gaps.md` §2.2 你说"信息效应排除在在线决策外，仅作离线分析"。
- 但 `missing-modules-guiding-questions.md` F1 你又说"读牌是关键决策依据"。

**问题**：

1. 这两者怎么调和？提议：
   - 在线决策中的隐藏信息 → 用对手手牌**统计期望分布**做 minimax，对每个可能手牌世界各跑一次单回合 minimax，按概率加权。
   - 离线分析中的信息效应（"威胁某张牌的存在让对手不敢推进"）→ 不进在线评分。

   **参考答案**：同意此调和方案。"读牌作决策依据"是用对手已知信息更新 belief（信息**接收**端），属在线；"信息效应"是利用对手对我方信息的不确定性（信息**发送**端），属离线。两者都要做，但分层。

2. 对手手牌分布的更新：(a) 仅基于已打出/调和过的牌做减法；(b) 加上"对手在 N 行动后没打 X，意味着 P(对手有 X) 下调"的贝叶斯更新；(c) 不更新，使用 prior。

   **参考答案（基于 P4 推导，待你检查调整）**：第一版 (a)（确定性硬证据更新），第二版叠加 (b)（贝叶斯软更新由 S3 学概率参数）。理由：硬证据（已打出 = 必然不在牌库/手牌）是规则推论，对所有 matchup 普适；软证据的概率参数（"对手在 N 行动后没打 X 应该把 P(对手有 X) 下调多少"）需要 S3 从对局数据学，不能拍脑袋。引导期不开 (b) 是为防止 S3 学不到时启发式参数误导；待 S3 数据足够再开。

### 4.3 minimax 中"对手最优"的定义

**问题**：

1. minimax 里的"对手"是：
   - (a) 假设对手用与我方相同的 evaluator；
   - (b) 假设对手用启发式策略；
   - (c) 假设对手用一个 lookup 出来的 archetype-aware 策略。

   **参考答案（基于 P4 推导，待你检查调整）**：(a) 同 evaluator 为主 + (c) archetype-aware bias 作初值。对称 self-play 训练默认对手用同 evaluator（让 S3 学到对称博弈下的最优响应）；推理时若识别到对手是已知 archetype，可叠加 archetype 偏置（S1 引导）作为 S3 数据稀疏时的初值修正。S3 数据足够后，archetype bias 退化为可解释性提示，不再影响决策。单纯启发式 (b) 偏弱，会让 minimax 高估自己。

2. self-play 训练中的对手池（镜像 40% + 历史 ckpt 40% + baseline 20%）已固定。但 minimax 内部的对手模型是否应与 self-play 对手池一致？还是 minimax 应假设比 self-play 中位水平更强（避免过拟合到弱对手）？

   **参考答案**：不一致。self-play 对手池是为训练分布多样性；minimax 内部应假设"理想最优对手"（同 evaluator），保守估计。一致会导致策略对弱对手过拟合。

---

## 五、阶段感知 / GamePlan 的可计算化

### 5.1 阶段不能由通用特征推断——但能否用"组件就位向量"？

`framework-organization-v2.md` 18.2 / `missing-modules-guiding-questions.md` C1 你已确认"阶段无泛用代理变量，必须 deck-specific"。

**问题**：

1. 你是否愿意接受这条折中：阶段判断 = `f(组件就位向量, 关键技能可用性, 关键卡牌已抽到)`，其中各项由 GamePlan 模板定义？

   **参考答案（基于 P4 推导，待你检查调整）**：接受作为引导期方案。(P4 引导期) 各项原子（组件就位、技能可用、抽牌）跨卡组通用（S2 引导可定义），具体哪些组件/卡牌算关键由模板填（S1 引导填充）。但**长期**目标是让 S3 直接从原始 obs（手牌 / 装备 / 召唤物 / 能量）学到隐含阶段，模板退化为可解释性来源 + 训练辅助标签。

2. GamePlan 模板由谁产出：
   - (a) LLM（gi-tcg-gameplan skill）；
   - (b) 玩家手写；
   - (c) 离线学习；
   - (d) 三者结合。

   **参考答案（基于 P4 推导，待你检查调整）**：(d) 三者结合，引导期优先级 LLM/手写（S1）> 离线学习（S3 候选挖掘）。S1 模板属人类知识范畴，第一版主要靠 LLM gameplan + 玩家手写填充；离线学习作 S3 兜底（生成候选模板供人审）。S3 数据稳定后，离线学习可生成 deck-matchup 级别的精细模板，覆盖 LLM/手写版本。

3. `declareEnd-hard-constraints.md` 约束 4 中"phase_weight 暂设为 1.0"——你是否同意：第一版 GamePlan 只输出离散阶段标签 (`setup` / `execution` / `closing`)，不输出连续 phase_weight？

   **参考答案（基于 P5 推导，待你检查调整）**：**不同意**离散标签。(P5) 禁止过早分类。改为输出**多个连续进度量**（`setup_completion ∈ [0,1]`、`execution_readiness ∈ [0,1]`、`closing_pressure ∈ [0,1]`），让 V 自己处理三阶段并存的混合局面（最常见！）。

### 5.2 GamePlan 的条件分支（接 `missing-modules-guiding-questions.md` E2）

火刻打可莉 vs 打班尼特走不同路径，已经确认。

**问题**：

1. GamePlan 条件分支的触发器有哪些？(a) 对手阵容（看到角色 ID）；(b) 对手 R1 行动（看是否铺装备 vs 直接出伤）；(c) 我方手牌是否含特定卡。这三者优先级如何？

   **参考答案（基于 P4 推导，待你检查调整）**：a > b > c（信息可达性顺序）。(a) 对手阵容在 mulligan 后即知，最早可用且信息密度最高；(b) R1 行动作二次校正；(c) 我方手牌主要影响"具体打法"而非"路径选择"，归 mulligan 子策略处理。引导期由 GamePlan 模板定义条件分支（S1）；S3 数据稳定后，**条件触发本身**也可由模型隐式学到（不再需要显式 if-else 模板）。
   **补充**：c可能在起手换牌后进行决定，这个优先级会在先手时高于b。

2. 单局对局中**最多支持几次路径切换**？建议第一版是不是只允许 R1 末尾切一次（看完对方 R1 行动），后续不再切？

   **参考答案（基于 P5 推导，待你检查调整）**：**任意次**，但**所有候选路径并行评估**。(P5) 禁止用"最多切 N 次"做硬约束——这等同于过早分类。让 V 同时评估所有路径，每帧都允许 max 切换的胜出路径变化。"切换"在工程上不是显式动作，只是 V 的内部权重移动。

---

## 六、数据采集 / 训练 / 评估制度的待拍板细节

### 6.1 自对弈数据的对称化（接 `replay-hidden-constraints-v2.md`）

v2 文档已修正"P0 恒为训练模型"的偏差。

**问题**：

1. 是否同意正式落实：每个 matchup 训练模型在 P0 / P1 各打**等量**对局，benchmark 报告默认按 P0/P1 分层显示？

   **参考答案**：同意（与 v2 修正一致）。P3 推论：先后手是 obs 字段，必须保证训练分布对称。

2. `currentTurn` 总从 0 开始（引擎硬编码）。是否需要在 RL config 里显式增加"先后手交换 wrapper"，自动让训练模型一半时间作为 sideB 上场？

   **参考答案**：需要。引擎硬编码不可改，wrapper 是唯一办法。

3. 镜像对局（同卡组对决）是否单独保留训练子集？还是与跨卡组训练数据混在一起？

   **参考答案（基于 P5 推导，待你检查调整）**：混在一起，但 obs 包含"对手卡组指纹"。镜像不是独立 mode（违反 P5 过早分类），但 V 看到自身/对手卡组同/异自然学到差异。

### 6.2 reward shaping 的优先级与冲突

`ai-improvement-plan-v3.md` §5.1 / §5.2 给了 12 条 shaping 项。`framework.md` 17.9.7 你已回答"双计冲突时优先归 `G_plan`"。

**问题**：

1. `ai-improvement-plan-v3.md` 提出的 `burst_waste_penalty`、`collapse_penalty`、`phase_alignment_bonus`、`key_char_protect_bonus` 这 4 项新 shaping 是否纳入第一版？还是只先开 `burst_waste_penalty`？

   **参考答案（基于 P4 推导，待你检查调整）**：第一版只开 `burst_waste_penalty`。理由：(P4 引导期) `burst_waste_penalty` 是跨卡组通用规则（S2 充能浪费 = 损失），不依赖具体 deck 上下文，第一版即可稳定；`collapse_penalty` / `phase_alignment_bonus` / `key_char_protect_bonus` 都依赖 deck-aware 信息（S1 模板未稳定 + S3 数据未足）。引导期遵循"先 S2 后 S1，最后由 S3 自学微调权重"的顺序——shaping 项越具体，需要越多数据才能确定其方向不带偏。

2. `framework.md` 17.9.6 你提到"刷分行为容易透支资源导致崩溃，能否事后修正"——你愿意接受**事后回看修正**（terminal 时倒推每步实际收益）还是**当步即时削峰**？

   **参考答案（基于 P5 推导，待你检查调整）**：事后回看修正。当步削峰需要预判"这一步是否会导致后续崩溃"，本质是局部分类（违反 P5）；事后修正用 terminal 信号反推，不依赖中间分类，更干净。

3. 反应增伤事件（§0.2）是否要进入 shaping 白名单？目前只有 `r_damage` 总量项，没区分反应贡献。

   **参考答案（基于 P1 推导，待你检查调整）**：不单列。`r_damage` 已聚合反应增伤（伤害总值已含 +2/+1）；反应不是独立玩家决策（P1：跟随母技能决策），重复 shaping 违反 P1。

### 6.3 评估指标分层

`rl-implementation-spec.md` §6.11 已分主 / 副 / 解释三层。

**问题**：

1. 你是否同意补充"先后手分层胜率"为副指标，且作为 ckpt 晋级硬约束（任一先后手胜率 < 45% 即不晋级）？

   **参考答案**：同意。P3 推论：obs 包含先后手则训练分布需对称，评估也应对称呈现。
   **补充**：受卡组强度限制，单个特定对局的胜率可能就是上不去，阈值应该稍放宽些且不根据特定对局的极端胜率进行粗暴取舍。

2. "可解释性"作为副指标（`framework.md` 17.10.7）——具体指标怎么测？提议：
   - 每个错例的 ranker top-1 vs ground truth gap；
   - 每个 decision point 的 `Q_total` 子项与最终选择是否一致；
   - 关键失误（如击杀线放过）的占比。
   你倾向哪种？

   **参考答案（基于 P5 推导，待你检查调整）**：用第一与第三项；不用第二项。第二项要求 `Q_total` 子项可加权解释最终选择，但 P5 的非线性 V 不一定能这样分解（GBDT/MLP 不保证子项加性）。第一与第三项是端到端测量，与模型内部结构无关。

---

## 七、构筑论 / 跨卡组 / 元层（`strong-coupling` / `dynamic-thresholds`）回到主线

### 7.1 概率分布视角的入口位置

`framework-critical-gaps.md` §4.3 你已确认：概率分布视角的入口是**特征设计**（分布的统计量作为输入），而非修改 Q 定义。

**问题**：

1. 第一版要不要就在 observation 里加入 `expected_card_value_distribution`（我方手牌中每张牌的 `(low, median, high)`）作为特征？还是先只用 `expected_response_buckets`（已在 `OpponentHiddenEstimateV1` 中）？

   **参考答案（基于 P4 推导，待你检查调整）**：先只用 `expected_response_buckets`（S2 引导启动的跨卡组桶）。每张牌的 `(low, median, high)` 是 S3 派生（需大量数据校准），第一版未足；S3 数据稳定后允许进入 obs 接管粗桶。

2. 矢量化评估 `(vsAggro, vsControl, vsMidrange)` 在**对局中**有用吗？还是只在卡组离线分析阶段用？

   **参考答案（基于 P5 推导，待你检查调整）**：仅离线。vsAggro / vsControl 等是 archetype 路由的另一种形式（违反 P5）。对局中只看"对手当前阵营元素 + 已显示行动倾向"，不显式分类对手 archetype。

### 7.2 角色配合相性度量与 `Q_total` 的接口

`character-synergy-metrics.md` 给出 4 维度（反应兼容 / 技能链 / 职能互补 / 牌增强）。

**问题**：

1. 这 4 维度是否应作为 GamePlan 模板生成时的输入特征？还是仅作为构筑评估输出，不进对局策略？

   **参考答案（基于 P2 推导，待你检查调整）**：**不进对局策略，仅作 GamePlan 模板生成的输入**（隔层）。(P2) 构筑评估和对局策略是不同任务，不应共享中间量。GamePlan 模板是"翻译层"。

2. "反应兼容性 R" 用的反应权重表（v(reaction)）与引擎实际加值（§0.2）不一致。是否要统一两者，或者承认"构筑评估用估值权重，对局评分用引擎实值"？

   **参考答案（基于 P2 推导，待你检查调整）**：承认分离，不统一。构筑评估关心"长期价值期望"，对局评分关心"当下数值结算"——不同任务，不同权重表合理。但权重表需各自版本化，避免误用。
   **补充**：改用引擎实值。

---

## 八、例子驱动的最后两步

### 8.1 第一例子的完整展开（林龙马）

`framework-organization-v2.md` §7.2 已选定林龙马为第一例。

**问题**：

1. 你愿意提供：
   - 1 个具体决策点（具体回合 + 状态快照）；
   - 该点最优解（人类视角，不需要计算）；
   - 一个"看似合理但错"的替代选择，及为什么错。
   `missing-modules-guiding-questions.md` H2 你之前未答此项——能否在这一稿补上？

   **参考答案**：跳过——此问需用户具体局面知识，无法由 P1-P5 推导。

2. 如果你时间有限，能否给一个 1-2 句的关键决策点描述（例如"R2 圣遗物已就位，差捷德的弃置触发，此时是先打圣遗物链的下一环还是先调和换费"），其余由后续整理？

   **参考答案**：跳过——同上。

### 8.2 第二例子的对照价值

四个候选例子（林龙马 / 久闲女 / 为死而战 / 水凝白垩）。

**问题**：

1. 第二例子最适合验证哪个具体框架特性？(a) `R_role` 风险拆分（为死而战残局）；(b) `Q(s,a)` 的 deck-aware 系数（白垩之术）；(c) `D_now ≠ Q` 的反例（久闲女 R1 久岐忍普攻）。

   **参考答案（基于 P5 推导，待你检查调整）**：(c) 久闲女。(c) 直接验证 P5 多路径并行——R1 久岐忍普攻看 `D_now` 是 0 但 V 仍应高（铺路潜力），是 P5 最经典应用。(a)(b) 验证的是局部子项细节，没 (c) 关键。

2. 是否在文档主线写两个例子就够了？还是需要 4 个全做？

   **参考答案（基于 P4 推导，待你检查调整）**：写 2 个就够。覆盖 P5（多路径）+ P1（独立决策拆分）即可，4 个例子重复验证同类原则浪费篇幅。例子的目的是验证原则的解释力，不是穷尽所有反例（P4 引导期：例子越多 ≠ 原则越对，最终原则的对错由 S3 训练结果验证）。

---

## 九、当前文档间的剩余冲突点（请最终拍板）

下列冲突在多份文档间存在，必须由你拍一个版本，否则后续重写会出错。

1. **风险 `R(s,a)` 是单列还是分散到子项**：
   - `framework.md` §14.5 倾向"理论并入未来价值，工程单列"；
   - `framework-organization-v2.md` §六也倾向单列；
   - 但 `framework.md` §14.5.3 说"局部上允许有归属"——这个混合方案是否最终采纳？

   **参考答案（基于 P5 推导，待你检查调整）**：**完全分散到 V(s)**，不工程单列。(P5) 单一连续 V 原则不允许 V 之外另设独立标量项；混合方案是过渡性妥协，长期不一致。所有"风险"都通过 V(s) 已经吸收（角色更易死 → V 下降）。要解释性时通过 ranker 输出 candidate Q 差给出，不进 obs 也不进 reward。

2. **"节奏"是否还作为名词出现**：
   - `framework-critical-gaps.md` §1.3 决定"拆成子指标，去掉节奏这个名字"；
   - 但 `framework.md` 仍大量使用 `T_now`/`T_plan` 命名（虽然字段名不带"节奏"）。
   - 是否同意：保留 `T_now` / `T_plan` 字段名，但内部完全用子指标定义，文档中的"节奏"一律改写？

   **参考答案**：同意。`T_now`/`T_plan` 字段名保留（已是中性符号），文档行文中"节奏"一律替换为具体子指标名（如"骰效率""行动密度""强制响应"）。

3. **`Q_total` vs `Q^π` 的层级**：
   - `framework.md` §13.4 与 §17 内部一致——`Q_total` 是工程展开。
   - `framework-organization-v2.md` §四也认同。
   - 但 `static-effect-meta-priors-for-rl.md` §4 提出 effect family 加权也是另一种 `Q_total` 子项。
   - 是否最终把 effect family / meta slots 列为 `Q_total` 中的"特征注入层"，与 `G_now` 等并列但不重复计分？

   **参考答案（基于 P3 推导，待你检查调整）**：effect family / meta slots 作为 **obs 特征**注入 V/policy，而非 `Q_total` 子项。(P3) V 与 policy 用同一组特征，effect family 适合作为输入特征（让模型自己学其权重），列为 `Q_total` 子项会导致重复计分。

4. **`maxRoundsCount = 15` 的版本依赖**：所有文档都默认 15。`base/state.ts` 在 `getDefaultGameConfig` 写死 15，但 `Game.createInitialState` 接受 `partialConfig` 可覆盖。是否同意：理论文档中显式注明"以默认配置为准；自定义 maxRoundsCount 时请在 GamePlan 中重新校准"？

   **参考答案**：同意。这只是注释。

5. **`canCharged` / `canPlunging` / `hasDefeated` 的暴露层级**：
   - `rl-implementation-spec.md` §3.11.2 标注它们为 `RAW_ONLY`，第一版可不进主 obs；
   - 但它们直接影响合法动作（charged attack / plunging attack 的伤害有别）。
   - 是否同意：这三项必须进 `policy_public` 主 obs，否则合法动作集会失真？

   **参考答案（基于 P3 推导，待你检查调整）**：必须进。(P3) 合法动作前置量在 V 与 policy 都可见，否则 V 会预测到一个 policy 选不到的"幽灵动作"价值。

6. **角色数量降级的策略模式切换**（`three-character-collapse.md` / `ai-improvement-plan-v3.md` §4.1）：
   - 文档同意 3→2、2→1 是质变；
   - 但具体做法是 (a) 训练 3 个独立模型按存活数路由，(b) 单模型 + 存活数特征，(c) 单模型 + 阶段感知 GamePlan 处理？

   **参考答案（基于 P5 推导，待你检查调整）**：**(b) 单模型 + 存活数特征**。(P5) 明确禁止按存活数路由独立模型——会让"3 角色逆风一波斩杀"和"2 角色拖延翻盘"两条路径无法在同一 evaluator 内对比。`framework-design-principles.md` 中已把此作为 P5 反例之一。

---

## 十、一句话回答即可的快速筛选问题

为了便于你只在感兴趣的问题上花时间，下面 12 条都只需 yes/no / 选项字母 + 一句话理由：

| # | 问题 | 选项 | 参考答案（基于 P1-P5） |
|---|------|------|----------------------|
| Q1 | 死亡换人是否纳入 `def 1` 操作 | yes / no | **yes**（用户 §0.1 已确认；P1 命中） |
| Q2 | `selectCard` 是否独立建一类 candidate family | yes / no | **yes**（P1：选哪张是独立决策） |
| Q3 | mulligan 是否独立子策略，不进主 ranker | yes / no | **yes**（P1+P4：决策孤立 + 第一版 S3 数据稀疏，由 S2/S1 引导启动） |
| Q4 | γ = 1 还是 γ < 1（第一版） | =1 / <1 | **=1**（P5：胜率为唯一标量目标） |
| Q5 | reroll 是否完全交规则策略，不进主 ranker | yes / no | **yes**（P4 引导期：S3 在 reroll 子问题数据稀疏，由 S2 启发式覆盖；与 mulligan 同理） |
| Q6 | 调和的 tuningTarget 是否进 candidate 编码 | yes / no | **yes**（P1：可改 target 时是独立决策） |
| Q7 | LEGEND/秘传作为独立资源轴 | yes / no | **yes**（P1：整局一次的硬限） |
| Q8 | 出战角色作为"第 0 阶资源" | yes / no | **yes**（P1+P2：决定 ALIGNED 解锁集） |
| Q9 | minimax 的搜索深度 | 单步/单回合/单轮/全局 | **单轮**（参考答案 4.1.1） |
| Q10 | 第一版只开 `burst_waste_penalty` 一项新 shaping | yes / no | **yes**（P4 引导期：S2 通用规则先行，deck-aware 项 S3 未稳定时不开） |
| Q11 | "节奏"在文档中保留还是移除（仅保留子指标） | 保留 / 移除 | **移除**（已确认） |
| Q12 | 风险 `R(s,a)` 工程层最终单列 / 完全分散 / 混合 | 单列 / 分散 / 混合 | **分散**（P5：单一 V 已含风险） |

---

## 附录 A：本提问册映射回各原文件的章节索引

| 本文章节 | 主要回应的原文档章节 |
|---|---|
| 〇.1 击倒结算 | `framework.md` §15、`declareEnd-hard-constraints.md` §4、`framework-missing-modules.md` §G |
| 〇.2 反应口径 | `framework.md` §11、`character-synergy-metrics.md` §①、`framework-missing-modules.md` §A |
| 〇.3 成本类型 | `missing-modules-guiding-questions.md` §B、`static-effect-meta-priors-for-rl.md` §2.1、`framework.md` §10.1 |
| 〇.4 pending_method | `rl-implementation-spec.md` §3.3、`declareEnd-hard-constraints.md` |
| 〇.5 二段管线 | `framework-missing-modules.md` §G、`declareEnd-hard-constraints.md` 约束 1 |
| 〇.6 replaceAction | 全部文档均未提及 |
| 一.1 状态语义 | `framework.md` §二、§四；`framework-organization-v2.md` §四 |
| 一.2 风险归并 | `framework-critical-gaps.md` §1.1、`framework.md` §14.5 |
| 一.3 γ | `framework.md` §13.5、`framework-critical-gaps.md` §3.4 |
| 一.4 RL action | `framework.md` §3、`rl-implementation-spec.md` §4.6 |
| 二.1 D_now | `framework.md` §11、§9.1.1 |
| 二.2 K_now | `framework.md` §9.1.2、`three-character-collapse.md` |
| 二.3 节奏 | `framework-critical-gaps.md` §1.3 |
| 二.4 S_plan | `framework.md` §9.3.2 |
| 二.5 L_plan | `framework.md` §9.3.3、`framework.md` §9.8.3 |
| 三.1 功能 | `framework-critical-gaps.md` §1.2、`framework.md` §14.3 |
| 三.2 风险时间 | `framework.md` §14.4、`ai-improvement-plan-v3.md` §1.1 |
| 三.3 反应威胁 | `ai-improvement-plan-v3.md` §4.2 |
| 四.1-4.3 对手建模 | `framework-critical-gaps.md` §2.2、`missing-modules-guiding-questions.md` §F |
| 五.1-5.2 阶段 / GamePlan | `framework-organization-v2.md` §18.2、`missing-modules-guiding-questions.md` §C、`declareEnd-hard-constraints.md` §4 |
| 六.1-6.3 训练制度 | `replay-hidden-constraints-v2.md`、`framework.md` §17.9-17.10、`rl-implementation-spec.md` §6 |
| 七.1-7.2 元层 | `framework-critical-gaps.md` §4.3、`character-synergy-metrics.md`、`strong-coupling-and-deckbuilding.md`、`dynamic-thresholds-and-conditional-features.md` |
| 八.1-8.2 例子 | `framework-organization-v2.md` §7、`missing-modules-guiding-questions.md` §H |
| 九 冲突点 | 跨多文档汇总 |

---

## 附录 B：引擎源码引用清单（便于复核）

| 行号 / 文件 | 内容 |
|---|---|
| `core/src/base/state.ts:67-77` | `getDefaultGameConfig`：8 骰、5 起手、10 手上限、200 牌库、15 回合、4 支援、4 召唤、16 骰上限 |
| `core/src/base/state.ts:108-115` | `VersionBehavior`：`diceCostApplyAttachments` v6.4.0+；`foodOmitInjuredOnly` / `disposeMaxCostHandsAbortPreview` v6.1.0+；`defaultRecreateBehavior` v3.5.0+ |
| `core/src/base/state.ts:138-141` | `currentTurn: 0 | 1`、`winner` |
| `core/src/base/state.ts:156-180` | `PlayerState` 字段（含 `declaredEnd`、`hasDefeated`、`canCharged`、`canPlunging`、`legendUsed`、`skipNextTurn`、`defeatedSwitching`、`roundSkillLog`、`phaseDamageLog`、`phaseReactionLog`） |
| `core/src/base/reaction.ts:30-94` | `REACTION_MAP`（每个 aura × damageType 对应的 newAura + reaction） |
| `core/src/base/reaction.ts:96-117` | `REACTION_RELATIVES`：每个反应对应的两元素 |
| `core/src/base/reaction.ts:119-123` | `LUNA_REMAPPING`：感电/绽放/水结晶 → 月相变体 |
| `core/src/base/skill.ts:931-944` | `ModifyDamageEventArgBase.damageInfo`：`+increased` → `× multiplied/divider` → `-decreased`；`causeDefeated = value >= targetHealth` |
| `core/src/base/skill.ts:963-998` | `increaseDamageByReaction`：融化/蒸发/超载 +2，超导/感电/冻结/结晶/燃烧/绽放/激化/月相绽放 +1 |
| `core/src/base/skill.ts:1000-1039` | `ModifyDamage1/2/3`、`GenericModifyDamageEventArg` 混入 |
| `core/src/builder/context/skill.ts:295-360` | 击倒结算：`alive=0` / `energy=0` / `aura=None` / `hasDefeated=true` / `removeRoundSkillLog` |
| `core/src/builder/context/skill.ts:411-413` | `causeDefeated = criticalDamageEvents.length > 0` |
| `core/src/skill_executor.ts:233-294` | 倒下后强制 `chooseActive` 顺序：`currentTurn` → `flip(currentTurn)`；保存 `defeatedSwitching` |
| `core/src/game.ts:285-326` | `createInitialState`：phase = `initHands`、currentTurn = 0、roundNumber = 0 |
| `core/src/game.ts:401-474` | `start()` / 主循环：phase function 表、gameEnd 终止 |
| `core/src/game.ts:590-622` | `initHands` / `initActives` 流程 |
| `core/src/game.ts:624-665` | `rollPhase`：`onRoll` → `randomDice` → `reroll` |
| `core/src/game.ts:667-919` | `actionPhase`：`replaceAction` / `availableActions` / 骰子结算 / 能量结算 / 五种 action_case 分发 / `switchTurn` |
| `core/src/game.ts:900-919` | 双方都 `declaredEnd` → 进入 `end`；非 fast 行动 `switchTurn` |
| `core/src/game.ts:921-953` | `endPhase`：`onEndPhase` → 各方抽 2 → `onRoundEnd` → 重置 hasDefeated/canPlunging → `stepRound` → 满 15 回合 `gameEnd` |
| `core/src/game.ts:955-1142` | `availableActions`：技能 / 卡牌（含支援满覆写目标）/ 调和 / 切人 / declareEnd 全部生成 + preview |
| `core/src/game.ts:1162-1175` | `rpcReroll`：通知双方 reroll 完成（对方 count=0） |
| `core/src/utils.ts:847-886` | `applyAttachmentModifications`：`disableTuning` / `willBeEffectless` / `shouldFast` / `requiredCost` / `tunedToType` 由附件按优先级合成 |

---

> **回答方式建议**：直接在本文件下方追加"## 答题区"分节，按问题编号作答；不要求一次答完，未答的问题在重写理论时会标记为"暂缓"。
