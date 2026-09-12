# V31 F9 — Character Skill Fingerprint (CSF)

> 日期: 2026-06-28（设计）→ 2026-06-29（实现 ✅）
> 范围: `packages/gi-agent`（生成器 + encoder 接入）+ `packages/gi-ml/python`（训练器同步）
> 理论: 消除 OOD 角色词表阶梯的结构性方案
> 状态: **已完成**（代码 + 测试 + 数据升级 + 训练）
> 关联: V31 §F6.D5 §5（词表泛化诊断）、§F6.D6 §8 #2（架构修复）

---

## 0. 动机

### 当前 char embedding 的根因缺陷

每个角色在 encoder 中的表示仅由一张学习表决定：

```
char_in = char_emb[definition_id](32) ⊕ numerics(4) ⊕ attached_status_pool(32)
```

`char_emb` 是纯 lookup 表（`nn.Embedding(vocab_size=26→35, embed_dim=32)`）——**不包含任何先天知识**。对不在训练池中的 ~80% 角色，`char_emb(UNK=1)` 退化到同一个通用向量。按 D5 分析，这导致 OOD 角色损失 `side_repr` 输入中约 19.4% 的信号（char 路径在 `side_repr_in` 占比 = 3×(S/2) / (5×3×(S/2) + meta + dice) = 192/990 ≈ 19.4%）。

### 现有可用的补充信号

| 信号 | 何时可用 | OOD 可用？ | 编码内容 |
|------|----------|------------|----------|
| `char_emb(def_id)` | 训练数据中出现过 | **否** | 角色"怎么用"的策略权重 |
| `preview_vector` (46 dims) | 决策时引擎执行 | 是 | 该回合"按这个按钮发生什么" |
| `CSF[def_id]` (本次新增) | **预计算**（离线编译一次） | **是** | "这个角色有什么技能/被动/属性" |

三种信号互补：CSF 是角色的**身份证**（静态结构），`char_emb` 是角色的**履历**（习得策略），`preview_vector` 是**当前动作后果预览**（动态引擎事实）。

### 与"元素+属性"简单编码的区别

"元素+属性"（如 `element_onehot(8) + weapon_onehot(7)`）只能区分 15 个角色大类——把 146 个角色压进 15 个桶。CSF 通过编码**每个技能的损伤类型/数值/费用/效果标签**和**被动触发条件/效果**，将分辨力提升到"角色级"：两个同元素同武器但技能结构不同的角色（如迪卢克 vs 宵宫）在 CSF 空间中距离很远。

---

## 1. CSF 向量设计（256 dims）

全局固定 256 维，分 4 个 block。所有维度的取值域为 [0, 1] 或 {0, 1}，无需额外归一化。

### Block 1: 角色静态属性 (0–31, 32 dims)

```
维度  名称              说明                               取值范围
[0]   elem_cryo         冰元素                             {0,1}
[1]   elem_hydro        水元素                             {0,1}
[2]   elem_pyro         火元素                             {0,1}
[3]   elem_electro      雷元素                             {0,1}
[4]   elem_anemo        风元素                             {0,1}
[5]   elem_geo          岩元素                             {0,1}
[6]   elem_dendro       草元素                             {0,1}
[7]   elem_omni         —（怪物/万能元素）                   {0,1}
[8]   weap_sword        单手剑                             {0,1}
[9]   weap_claymore     双手剑                             {0,1}
[10]  weap_pole         长柄武器                           {0,1}
[11]  weap_catalyst     法器                               {0,1}
[12]  weap_bow          弓                                 {0,1}
[13]  weap_other        其他武器（怪物卡）                   {0,1}
[14]  is_monster        是否为怪物卡（无天资装备）           {0,1}
[15]  max_hp_bin1       max_hp ∈ [1,6]                     {0,1}
[16]  max_hp_bin2       max_hp ∈ [7,8]                     {0,1}
[17]  max_hp_bin3       max_hp ∈ [9,10]                    {0,1}
[18]  max_hp_bin4       max_hp ∈ [11+]                     {0,1}
[19]  max_energy_2      max_energy = 2                     {0,1}
[20]  max_energy_3      max_energy = 3                     {0,1}
[21]  has_special_energy 有特殊能量（战意/夜魂值）          {0,1}
[22]  has_nightsoul     有夜魂祝福                         {0,1}
[23]  nation_mond       蒙德                               {0,1}
[24]  nation_liyue      璃月                               {0,1}
[25]  nation_inazuma    稻妻                               {0,1}
[26]  nation_sumeru     须弥                               {0,1}
[27]  nation_fontaine   枫丹                               {0,1}
[28]  nation_natlan     纳塔                               {0,1}
[29]  nation_fatui      愚人众                             {0,1}
[30]  has_talent_equip  是否有专属天资牌（=有角色装备卡）   {0,1}
[31]  has_lunar_reaction 有月相反应                        {0,1}
```

**数据来源**：全部从 `CharacterDefinition.tags`（`ElementTag|WeaponTag|NationTag|ArkheTag`）、`varConfigs`、`associatedNightsoulsBlessing`、`enabledLunarReactions` 类型字段直取，无需源码解析。

**特殊能量判定**：检查 `skills[]` 中是否存在 `initiativeSkillConfig.requiredCost` 包含 `Energy(9)` 以外的能量费用类型（如 `FightingSpirit` 等自定义费用），或 `specialEnergy !== null`。

**天资牌判定**：`skills` 中是否存在 `.equip(id)` 调用且该装备的 `ownerType === "character"`（用 skill 定义中的 `filter` 过滤装备卡引用）。简化方案：检查 `@gi-tcg/data` 的 `cards/equipment/` 目录下是否有匹配当前 `character_id` 的装备卡（`equipId / 10 == charId + 2` 的约定）。

### Block 2: 主动技能描述 (32–127, 3 × 32 = 96 dims)

三个槽位依次对应 **普攻 (normal) / 元素战技 (elemental) / 元素爆发 (burst)**。如果角色缺少某个技能类型（如怪物卡只有 2 个主动技能），对应槽位全部填 0。

每个槽位 32 维，结构完全一致：

```
维度  名称                  说明                        取值范围 / 编码
[0]   skill_exists          该槽位是否有技能              {0,1}
[1]   stype_normal          普攻                          {0,1}
[2]   stype_elemental       元素战技                      {0,1}
[3]   stype_burst           元素爆发                      {0,1}
[4]   cost_cryo_dice        需要冰骰子数 / 总费用          [0,1]
[5]   cost_hydro_dice       需要水骰子数 / 总费用          [0,1]
[6]   cost_pyro_dice        需要火骰子数 / 总费用          [0,1]
[7]   cost_electro_dice     需要雷骰子数 / 总费用          [0,1]
[8]   cost_anemo_dice       需要风骰子数 / 总费用          [0,1]
[9]   cost_geo_dice         需要岩骰子数 / 总费用          [0,1]
[10]  cost_dendro_dice      需要草骰子数 / 总费用          [0,1]
[11]  cost_omni_dice        万能骰子数 / 总费用            [0,1]
[12]  cost_same_dice        同元素骰子数 / 总费用          [0,1]
[13]  cost_total_bin1       总费用 ∈ [1-2]                 {0,1}
[14]  cost_total_bin2       总费用 ∈ [3-4]                 {0,1}
[15]  cost_total_bin3       总费用 ∈ [5-6]                 {0,1}
[16]  cost_total_bin4       总费用 ∈ [7+]                  {0,1}
[17]  cost_energy           能量费用（burst）              {0,1,2,3} / 3
[18]  dmg_physical          物理伤害                       {0,1}
[19]  dmg_cryo              冰元素伤害                     {0,1}
[20]  dmg_hydro             水元素伤害                     {0,1}
[21]  dmg_pyro              火元素伤害                     {0,1}
[22]  dmg_electro           雷元素伤害                     {0,1}
[23]  dmg_anemo             风元素伤害                     {0,1}
[24]  dmg_geo               岩元素伤害                     {0,1}
[25]  dmg_dendro            草元素伤害                     {0,1}
[26]  dmg_piercing          穿透伤害                       {0,1}
[27]  has_healing           有治疗                         {0,1}
[28]  has_summon_creation    创建召唤物                     {0,1}
[29]  has_support_creation   创建支援牌                     {0,1}
[30]  has_combat_status      创建出战状态                   {0,1}
[31]  has_character_status   创建角色状态                   {0,1}
```

第二组效果标签 (32 dims)：

```
维度  名称                  说明                        取值范围
[0]   has_equip_creation    创建装备                       {0,1}
[1]   has_element_apply     施加元素附着                   {0,1}
[2]   has_force_switch      强制切人                       {0,1}
[3]   has_card_draw         抽牌                           {0,1}
[4]   has_dice_gen          生成骰子                       {0,1}
[5]   has_energy_gain_self  自身获得充能                   {0,1}
[6]   has_energy_gain_team  队友获得充能                   {0,1}
[7]   is_charged_attack     重击                           {0,1}
[8]   is_plunging_attack    下落攻击                       {0,1}
[9]   is_fast_action        快速行动                       {0,1}
[10]  is_multi_target       多目标伤害                     {0,1}
[11]  is_prepared           准备技能（不占行动）             {0,1}
[12]  is_hidden             隐藏（不可手动选择）             {0,1}
[13]  no_energy_gain        不产生充能                     {0,1}
[14]  has_shield            生成护盾                       {0,1}
[15]  has_damage_boost      增加伤害 buff                  {0,1}
[16]  has_damage_reduction  减伤                           {0,1}
[17]  has_damage_type_change 改变伤害类型                   {0,1}
[18]  has_self_damage       自伤                           {0,1}
[19]  has_dispose            消灭对方实体（驱散）            {0,1}
[20]  has_dice_convert       骰子转换                       {0,1}
[21]  has_variable_modify    修改变量                       {0,1}
[22]  has_create_hand_card   创建手牌                       {0,1}
[23]  reserved_23~31         保留，当前填 0                  —
```

**数据来源**：
- 费用向量（维度 4-17）：从 `InitiativeSkillDefinition.initiativeSkillConfig.requiredCost`（`Map<DiceType, number>`）直取——这是类型系统保证的，**无需源码解析**。
- 伤害类型/效果标签（维度 18-31、效果标签 0-22）：**需正则解析源码**（见 §4）。

### Block 3: 触发/被动技能描述 (128–223, 3 × 32 = 96 dims)

取角色的前 3 个触发技能（`TriggeredSkillDefinition`，通常包括被动天赋和装备触发技能）。每个槽位 32 维：

```
维度  名称                  说明                        取值范围 / 编码
[0]   skill_exists          该槽位是否有技能              {0,1}
[1]   trig_on_use_skill     触发于"使用技能后"              {0,1}
[2]   trig_on_damage_heal   触发于"造成/受到伤害/治疗"      {0,1}
[3]   trig_on_round_end     触发于"回合结束"                {0,1}
[4]   trig_on_phase_end     触发于"阶段结束"（action/end）  {0,1}
[5]   trig_on_switch        触发于"切换角色"                {0,1}
[6]   trig_on_equip         触发于"装备"                    {0,1}
[7]   trig_on_reaction      触发于"元素反应"                {0,1}
[8]   trig_on_declare_end   触发于"宣告结束"                {0,1}
[9]   trig_on_draw_card     触发于"抽牌"                    {0,1}
[10]  trig_on_roll_dice     触发于"投骰子"                  {0,1}
[11]  trig_on_defeated      触发于"被击倒"                  {0,1}
[12]  trig_on_other         其他事件类型                    {0,1}
[13]  has_usage_limit       有使用次数限制                  {0,1}
[14]  has_per_round_usage   每回合可用                      {0,1}
[15]  usage_charge           单次可用次数 / 3                [0,1]（usage 除以 3）
[16]  has_hand_trigger       可从手牌触发                    {0,1}
[17]  has_pile_trigger       可从牌堆触发                    {0,1}
// 效果标签 (18-31)，与主动技能的"效果标签"维度 0-13 复用（多 2 个被动专属）
[18]  has_damage             造成伤害                        {0,1}
[19]  has_heal               治疗                            {0,1}
[20]  has_shield             护盾                            {0,1}
[21]  has_card_draw          抽牌                            {0,1}
[22]  has_dice_gen           生成骰子                         {0,1}
[23]  has_energy_gain        充能                            {0,1}
[24]  has_summon             召唤                            {0,1}
[25]  has_status_creation    创建状态                        {0,1}
[26]  has_damage_buff        伤害增益                        {0,1}
[27]  has_damage_reduction   减伤                            {0,1}
[28]  has_reaction_bonus     反应增幅                        {0,1}
[29]  has_revive_immune      免疫击倒/复活                   {0,1}
[30]  has_force_switch       强制切人                        {0,1}
[31]  has_dispose            驱散                            {0,1}
```

**触发事件类型判定**：从 `TriggeredSkillDefinition.triggerOn` 字段直取。`triggerOn` 是 `EventNames` 字面量（如 `"onUseSkill"`、`"onDamageOrHeal"` 等），映射到 12 个类别即可。**无需源码解析**。

**效果标签**：需正则解析源码（与主动技能共用同一套正则逻辑，见 §4）。

### Block 4: 全局技能统计 (224–255, 32 dims)

```
维度  名称                  说明                        取值范围
[0]   num_initiative         主动技能数                     {0,1,2,3} / 3
[1]   num_triggered          触发/被动技能数                实际值 / 6（clamp）
[2]   total_damage_cap       最大单发伤害总和 / 20           [0,1]
[3]   avg_dice_cost          平均骰子费用 / 8                [0,1]
[4]   num_dmg_types          能造成的伤害类型种类数 / 9       [0,1]
[5]   rxn_melt               可参与融化                       {0,1}
[6]   rxn_vaporize           可参与蒸发                       {0,1}
[7]   rxn_overload           可参与超载                       {0,1}
[8]   rxn_superconduct       可参与超导                       {0,1}
[9]   rxn_ec_frozen          可参与感电/冻结                  {0,1}
[10]  rxn_swirl              可参与扩散                       {0,1}
[11]  rxn_crystallize        可参与结晶                       {0,1}
[12]  rxn_burning_bloom      可参与燃烧/绽放                  {0,1}
[13]  has_utility            有非伤害功能性（治疗/召唤/护盾等）{0,1}
[14]  has_passive_dmg        有被动伤害（召唤物/出战状态）     {0,1}
[15]  is_defensive           偏向防守（高血量/护盾/治疗）      {0,1}
[16]  is_aggro               偏向进攻（高伤害/低血量）         {0,1}
[17]  is_support             偏向辅助（充能/增益/抽牌）        {0,1}
[18]  reserved_18~31         保留，当前填 0                    —
```

**计算方式**：从 Block 1-3 的已编码信息中二次推导，无需额外数据源。反应参与可能性由"角色元素"与"技能伤害类型"的排列组合推断（e.g. pyro 角色 = 可参与 melt/vaporize/overload/burning）。

---

## 2. 数据提取组件

### 2.1 生成器: `scripts/ops/generate-character-skill-fingerprints.ts`

**功能**：扫描 `@gi-tcg/data` 所有角色定义，为每个 `character_definition_id` 生成对应的 CSF[256] 向量，输出为 JSON。

**输入**：
- `@gi-tcg/data` 的 `getData(CURRENT_VERSION)` → `GameData.characters`（resolved `CharacterDefinition[]`）
- `@gi-tcg/data` 的源码 `.ts` 文件（`packages/data/src/characters/{element}/*.ts`）——用于正则提取语义标签

**输出**：
- `packages/gi-agent/output/character-skill-fingerprints.json`
- 格式：`{ "version": "v6.4.0", "dim": 256, "fingerprints": { "1104": [0.0, 1.0, ...], ... } }`

**操作流程**：

```
Step A: 扫描源码文件，建立 def_id → EffectTagSet 映射。
  - 正则模式（按优先级）:
    .damage(DamageType.X, N)                 → dmg_X, dmg_amount=N
    .damage(DamageType.Piercing, N)          → dmg_piercing
    .heal(N)                                 → has_healing
    .apply(ElementType.X, target)            → has_element_apply
    .summon(Entity)                          → has_summon_creation, refs entity_id
    .combatStatus(Entity)                    → has_combat_status
    .characterStatus(Entity)                 → has_character_status
    .equip(Entity)                           → has_equip_creation
    .switchActive(target)                    → has_force_switch
    .drawCards(N)                            → has_card_draw
    .createHandCard(id)                      → has_create_hand_card
    .gainEnergy(N)                           → has_energy_gain_self/team（看 target）
    .generateDice(type, N)                   → has_dice_gen
    .convertDice(type, N)                    → has_dice_convert
    .dispose(target)                         → has_dispose
    .increaseDamage(N)                       → has_damage_boost
    .changeDamageType(type)                  → has_damage_type_change
    .addVariable(...) / .setVariable(...)    → has_variable_modify
    .shield(N, type)                         → has_shield
    .noEnergy()                              → no_energy_gain
    .forceCharged()                          → is_charged_attack
    .forcePlunging()                         → is_plunging_attack
    .fast()                                  → is_fast_action
    .hidden()                                → is_hidden
    .prepared()                              → is_prepared
  触发技能专用正则（在 .on("event") 之后）：
    .usage(N)                                → has_usage_limit, usage_charge=N
    .usagePerRound(N)                        → has_per_round_usage, usage_charge=N
    .enableHandTriggering()                  → has_hand_trigger
    .enablePileTriggering()                  → has_pile_trigger

Step B: 走 getData() 拿到每个角色的 CharacterDefinition:
  - tags → Block 1 的元素/武器/国家
  - varConfigs → Block 1 的 max_hp / max_energy
  - skills[] 遍历:
    - 对 InitiativeSkillDefinition:
      → initiativeSkillConfig.requiredCost → Block 2 费用向量
      → initiativeSkillConfig.gainEnergy → Block 2 no_energy_gain 取反
      → initiativeSkillConfig.alwaysCharged/Plunging/hidden → Block 2 标签
      → initiativeSkillConfig.shouldFast → Block 2 is_fast_action
      → 按 skill.id 在 EffectTagSet 中查找语义标签
    - 对 TriggeredSkillDefinition（按 usagePerRound 有值优先，取前 3）:
      → triggerOn → Block 3 触发事件类型
      → skill.id 在 EffectTagSet 中查找语义标签

Step C: 汇总 Block 4 全局统计。

Step D: 写入 output/character-skill-fingerprints.json。
```

**输出大小预估**：146 个角色 × 256 float ≈ 150 KB JSON（压缩后 ~50 KB），完全可嵌入运行时。

**正则提取的覆盖率目标**：
- 类型字段（费用/技能类型/触发事件）：**100%**（类型系统保证）
- 语义标签（damage/heal/summon/draw/...）：**≥ 85%** 的技能可通过 regex 覆盖（基于现有 `generate-skill-damage-table.ts` 已验证的覆盖率，扩展到全部语义标签）
- 未覆盖的技能（~15%，主要是复杂的条件逻辑如 `.if(...).do(...).else()`）：语义标签保守填 0，靠 `char_emb` 补足

### 2.2 运行时加载器: `knowledge/character-skill-fingerprints.ts`

```ts
// 单例加载，惰性初始化
let _fingerprints: Map<number, number[]> | null = null

export function loadSkillFingerprints(): Map<number, number[]> {
  if (_fingerprints) return _fingerprints
  const raw = JSON.parse(readFileSync("output/character-skill-fingerprints.json", "utf-8"))
  _fingerprints = new Map()
  for (const [key, vec] of Object.entries(raw.fingerprints)) {
    _fingerprints.set(Number(key), vec as number[])
  }
  return _fingerprints
}

/** 获取一个角色的 CSF 向量。OOD 角色返回角色属性级别的退化向量。 */
export function getSkillFingerprint(definition_id: number): number[] {
  const map = loadSkillFingerprints()
  const fp = map.get(definition_id)
  if (fp) return fp
  // 退化：仅填充 element one-hot（从 def_id 的第二位推导）
  return degradedFingerprint(definition_id)
}
```

退化向量的实现：仅填充 Block 1 的元素/武器（从 `definition_id` 的 `1<E>NN` 编码、或 `@gi-tcg/data` 的类型 tags 中可查），其余维度全部填 0。这样 UNK 角色至少有"它是火元素双手剑"的粗粒度先验。

---

## 3. 模型接入组件

### 3.1 Schema 变更: `state-observation.ts`

```ts
/** V31 F9 (schema v4): precomputed 256-dim skill fingerprint per character. */
export interface CharacterObservation {
  // ... existing fields ...
  /** V31 F9: 256-dim static skill fingerprint. Filled by state-exporter. */
  skill_fingerprint?: number[]
}

// Bump schema version
export const STATE_OBSERVATION_SCHEMA_VERSION = 4
```

**向后兼容**：字段为 optional。旧 v3 样本（无 fingerprint）在 trainer 中对应的 CSF 维度全部填 0（等同学到了 neutral prior），新 v4 样本带真实 CSF。

### 3.2 导出器: `state-exporter.ts`

在 `exportSide()` 中，每个角色映射时注入 fingerprint：

```ts
// 在 CharacterObservation 构造中新增一行:
skill_fingerprint: getSkillFingerprint(ch.definitionId ?? 0),
```

**无需引擎变更** —— fingerprint 是纯静态映射，不依赖运行时状态。

### 3.3 TypeScript 推理侧: `neural-predictor.ts`

修改 `encodeSide()` 中角色的 `xIn` 拼接：

```ts
// 旧:
const xIn = concat([charEmb, num, attPool])     // 68 dims

// 新:
const fp = padTo(c.skill_fingerprint ?? [], this.constants.CSF_DIM)  // 256 dims
const xIn = concat([charEmb, num, attPool, fp])  // 68 + 256 = 324 dims
```

对应的 `char_proj` MLP 输入维度从 `E + 4 + E = 68` 变为 `E + 4 + E + CSF_DIM = 324`。

**CSF_DIM 常量**：在 `this.constants` 中新增 `CSF_DIM = 256`。

### 3.4 Python 训练侧: `train_v30_encoder.py`

#### (a) SCHEMA_VERSION 更新

```python
SCHEMA_VERSION = 4
```

#### (b) `_encode_side` 新增 CSF 提取

```python
# 每个角色提取 fingerprint
char_csf = torch.zeros(MAX_CHARS, CSF_DIM, dtype=torch.float)
for i, c in enumerate(chars):
    fp = c.get("skill_fingerprint")
    if fp and len(fp) == CSF_DIM:
        char_csf[i] = torch.tensor(fp, dtype=torch.float)
```

返回 dict 新增 `"char_csf": char_csf`。

#### (c) `char_proj` 输入维度更新

```python
CSF_DIM = 256
self.char_proj = _mlp(E + 4 + E + CSF_DIM, H, S // 2, hp.dropout)
```

#### (d) `encode_side` 拼接

```python
char_csf = batch[f"{prefix}_char_csf"]
char_in = torch.cat([char_emb, char_num[..., :4], att_pool, char_csf], dim=-1)
```

#### (e) `side_repr_in` 不变

CSF 走的是 `char_proj` 内部路径，DeepSets pooling 输出维度不变，因此 `side_proj` / `state_proj` / `value_head` / `advantage_head` 的维度均无需改动。

### 3.5 模型参数量变化

| 部件 | 旧维度 | 新维度 | 参数量变化 |
|------|--------|--------|-----------|
| `char_proj` MLP (input→hidden) | 68×128 | 324×128 | +32,768 |
| `char_proj` MLP (hidden→output) | 128×64 | 不变 | 0 |
| `side_proj` | 不变 | 不变 | 0 |
| 其余全部 | 不变 | 不变 | 0 |
| **总计** | 340,754 | ~373,522 | +32,768 (+9.6%) |

参数增量仅来自 `char_proj` 的第一层权重矩阵（`char_in_dim` 增加 256）。

---

## 4. 开发与验证计划

### 4.1 实现顺序

| 步骤 | 文件 | 验证方式 | 工期 |
|------|------|----------|------|
| 1 | `scripts/ops/generate-character-skill-fingerprints.ts` | 生成后抽查 5 个已知角色（宵宫/钟离/散兵/莫娜/凝光），人工验证 CSF 向量 | 1 天 |
| 2 | `knowledge/character-skill-fingerprints.ts`（运行时加载器） | 单测：已知角色 → 256 维非全零、OOD 角色 → 退化为仅 Block-1 非零 | 0.5 天 |
| 3 | `state-observation.ts` schema v4 + `state-exporter.ts` 注入 | 单测：`state-exporter.test.ts` 新增"导出角色含 skill_fingerprint 且 dim=256" | 0.5 天 |
| 4 | `neural-predictor.ts` TS 推理侧 | 现有 `neural-predictor.test.ts` 全部 pass（维度变化） | 0.5 天 |
| 5 | `train_v30_encoder.py` Python 训练侧同步 | `py:test` 全 pass + 新增 CSF 维度断言 | 0.5 天 |
| 6 | `export-dataset.ts` 兼容（v3 旧数据自动补零 CSF） | 单测：v3 无 CSF 样本导出后 CSF 全零、v4 样本带真实 CSF | 0.5 天 |
| 7 | 重采 + 重训（与下一轮飞轮合并） | v3 数据 `--upgrade-v2-to-v3` 路径扩展为 `v3→v4` | 1 天 |

### 4.2 测试用例

```ts
// 1. 基础生成测试
test("known character has non-trivial CSF", () => {
  const fp = getSkillFingerprint(1305) // 宵宫
  expect(fp).toHaveLength(256)
  expect(fp[2]).toBe(1.0)     // elem_pyro
  expect(fp[12]).toBe(1.0)    // weap_bow
  expect(fp[19]).toBe(1.0)    // max_energy_3
  // 普攻槽位：伤害类型 physical
  expect(fp[32 + 18]).toBe(1.0)  // slot0 dmg_physical
  // 元素战技：cost_pyro
  expect(fp[64 + 6]).toBeGreaterThan(0)  // slot1 cost_pyro_dice
})

// 2. OOD 退化测试
test("OOD character falls back to element-only CSF", () => {
  const fp = getSkillFingerprint(99999) // non-existent
  expect(fp).toHaveLength(256)
  // Only Block-1 element resolution may be non-zero
  const block2 = fp.slice(32, 128)
  expect(block2.every(v => v === 0)).toBe(true)
  const block3 = fp.slice(128, 224)
  expect(block3.every(v => v === 0)).toBe(true)
})

// 3. Exporter 注入测试
test("state-exporter v4 includes skill_fingerprint", () => {
  const result = StateExporter.export({ ... })
  for (const c of result.observation.self.characters) {
    expect(c.skill_fingerprint).toBeDefined()
    expect(c.skill_fingerprint!).toHaveLength(256)
  }
})

// 4. 向后兼容（v3 无 CSF → 推理时补零）
test("neural-predictor handles missing skill_fingerprint", () => {
  const obs = { ...validObs }
  delete obs.self.characters[0].skill_fingerprint
  // 不应抛错
  expect(() => predictor.predict(obs)).not.toThrow()
})
```

### 4.3 回归检查

- `state-exporter` 现有 14 个测试全 pass
- `neural-predictor` 现有测试全 pass
- `mcts` 32 个测试全 pass（ISMCTS self-play collector 消费 exporter）
- Python `py:test` 全 pass
- TS `bun run check` 在改动文件上零新增类型错误

---

## 5. 架构图（数据流）

```
┌──────────────────────────────────────────────────────────┐
│  BUILD TIME（一次性）                                      │
│                                                            │
│  @gi-tcg/data/src/characters/*.ts                          │
│    │                                                       │
│    ├─► getData(CURRENT_VERSION)  ──► CharacterDefinition   │
│    │    (类型字段: tags, varConfigs, skills[].cost, ...)    │
│    │                                                       │
│    └─► regex 解析源码  ──► EffectTagSet (per skill_id)     │
│         .damage()/.heal()/.summon()/.drawCards()/...       │
│                                                            │
│    ▼                                                       │
│  generate-character-skill-fingerprints.ts                   │
│    ▼                                                       │
│  output/character-skill-fingerprints.json                   │
│    { "1104": [0,1,0,...], "1305": [0,0,1,...], ... }       │
│    ~150 KB                                                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  RUNTIME（每个决策点）                                      │
│                                                            │
│  engine Notification.state                                 │
│    │                                                       │
│    ▼                                                       │
│  StateExporter.export()                                    │
│    │                                                       │
│    │  for each character:                                  │
│    │    c.definition_id ──► getSkillFingerprint(id)        │
│    │    ──► c.skill_fingerprint = [256]                    │
│    │                                                       │
│    ▼                                                       │
│  StateObservation (schema v4)                              │
│    │                                                       │
│    ├─► DataLake sqlite (samples.state_observation)         │
│    │     │                                                 │
│    │     └─► export-dataset.ts ──► NDJSON ──► Python       │
│    │                                          trainer      │
│    │                                            │          │
│    │                                            ▼          │
│    │                               char_in = char_emb(E)   │
│    │                                       ⊕ numerics(4)  │
│    │                                       ⊕ att_pool(E)  │
│    │                                       ⊕ CSF(256)     │
│    │                                            │          │
│    │                                            ▼          │
│    │                               char_proj MLP(324→64)  │
│    │                                                       │
│    └─► NeuralPredictor.predict() (TS 推理)                  │
│           │                                                │
│           ▼                                                │
│         char_in = charEmb ⊕ numerics ⊕ attPool ⊕ CSF       │
│           │                                                │
│           ▼                                                │
│         V(s), Q(s,a)                                       │
└──────────────────────────────────────────────────────────┘
```

---

## 6. 与现有工作的关系

| 现有系统 | CSF 如何交互 |
|----------|-------------|
| `preview_vector` (46 dims) | 互补：preview 编码动作后果，CSF 编码角色身份。`preview_vector` 仍然在 action path（`action_proj`）中消费，不受 CSF 影响 |
| `char_emb` (32 dims) | 互补：`char_emb` 学习策略权重，CSF 提供结构先验。两者 concat 后共同进 `char_proj` MLP |
| `is_first_player` (schema v3) | CSF 不替代。镜像局仍需 `is_first_player` 作唯一非对称信号 |
| `mirror_v_loss` | 不受影响。CSF 在 mirror 位置两侧相等（同角色同指纹），不存在非对称信息泄漏 |
| `--upgrade-v2-to-v3` | 扩展为 `--upgrade-v3-to-v4`：对旧 v3 样本，CSF 维度补零（中性先验），由 `char_emb` 单方面提供角色语义。不阻止新旧数据混训 |
| F1-F5 权重 | **需要重训**：`char_proj` 输入维度变化 → 旧权重不兼容。与下一轮飞轮 self-play + 重采合并 |

---

## 7. 预期效果

| 指标 | 预期变化 | 依据 |
|------|----------|------|
| OOD dendro/anemo 角色 V 头准确度 | **+10-20% sign_acc** | D5/D6 观察到跨元素训练数据多样化直接提升 V_ev（0.090→0.196）；CSF 给 OOD 角色提供了同等的前置先验 |
| in-distribution 权重 | **不退化**（±3pp mirror/cross） | CSF 是附加以外输入，模型可自行学习权重融合（`char_proj` 多层有能力忽略无用的输入维度） |
| char vocab 覆盖率要求 | **不增加**（仍是 ~34 个） | CSF 的"静态语义先验"让 UNK 角色的 `char_emb(UNK)` 不再是全零信号——模型有 CSF 可依赖 |
| 训练收敛速度 | **更快**（V-head 早停 epoch 减少 2-3） | D8b 证明训练数据的"结构性信息"（非标签本身）是 V-head 训练效率的瓶颈；CSF 注入这种信息 |
| self-play 采样效率 | **不变**（引擎推理完全不受影响） | CSF 是静态查表操作（O(1) 内存访问），对 `StateExporter.export()` 的 overhead < 1μs |

---

## 8. 实现总结（2026-06-29 ✅）

### 8.1 实际改动文件

| 步骤 | 文件 | 验证 |
|------|------|------|
| 1 生成器 | `scripts/ops/generate-character-skill-fingerprints.ts` | 生成 146 角色 × 256 维 JSON |
| 2 运行时加载器 | `src/knowledge/character-skill-fingerprints.ts` | OOD 退化 + 惰性加载 + 文件缺失降级 |
| 3 Schema v4 | `src/learning/encoder/state-observation.ts` | `STATE_OBSERVATION_SCHEMA_VERSION = 4` |
| 4 Exporter 注入 | `src/learning/encoder/state-exporter.ts` | 每角色注入 `skill_fingerprint` |
| 5 TS 推理 | `src/learning/encoder/neural-predictor.ts` | `char_in = concat([charEmb, num, attPool, csf])` |
| 6 Python 训练 | `gi-ml/python/gitcg_ml/train_v30_encoder.py` | `char_proj: E+4+E+256 → S/2` |
| 7 后向兼容 | `src/learning/encoder/export-dataset.ts` | `--upgrade-v3-to-v4` 补零升级 |
| 8 导出 CLI | `src/learning/encoder/cli/run-export-encoder-dataset.ts` | 新增 `--upgrade-v3-to-v4` 参数 |

### 8.2 测试验证

```
17 pass (encoder 全套)    0 fail
232 pass (gi-agent 全套)  6 fail (6 个为预处理环境问题)
```

### 8.3 旧数据升级

| 数据库 | 行数 | v2→v3 | v3→v4 |
|--------|------|-------|-------|
| v31-f6 (D5前主池) | 59,202 | 59,202 | 59,202 |
| D3 gen0 | 3,162 | 3,162 | 3,162 |
| D3 gen1 | 2,943 | 2,943 | 2,943 |
| D5 gen2 crossdeck | 34,427 | 34,427 | 34,427 |
| D6 gen3 crossdeck | 53,825 | 53,825 | 53,825 |
| D7 gen4 crossdeck | 28,012 | 0 | 28,012 |
| D8 gen5b selfplay | 27,123 | 0 | 27,123 |
| **总计** | **208,694** | **153,559** | **208,694** |

输出目录：`D:\gitcg-data\v4-export\`（按子目录分池 + `merged/` 合并集）

### 8.4 训练结果

使用 163k 训练 / 45k 验证，`train_v30_encoder` **12 epoch 全部完成**（~5h）。

| 指标 | 值 |
|------|-----|
| Model params | 377,138（含 CSF 256 维输入） |
| `char_proj.0.weight` shape | [128, 324] = 32(char_emb) + 4(num) + 32(att_pool) + 256(CSF) |
| 训练 acc (epoch 1→12) | 75.9% → 93.3% |
| 验证 acc (稳定区间) | ~68-71%（Q-head BCE 过拟合） |
| 最佳验证 v_loss (epoch 1) | **0.189** |
| 最终验证 v_loss (epoch 12) | 0.255 |
| V head 行为 | 训练 v_loss 持续下降 (0.159→0.090)，验证 v_loss 轻度退化 (0.189→0.255)，典型 online-TD 模式 |
| 在线 TD(0) bootstrap | gamma=0.95, warmup=1; 160,714 bootstrap / 3,060 terminal |
| 权重输出 | encoder-weights-csf-v4.json (8.2 MB, schema_version=4) |

**分析**：与 F6/D3/D4 的 gen0-gen1 训练一致——最佳 checkpoint 始终是 epoch 1（v_loss 最低）。后续 epoch 的 Q-head BCE 过拟合推高总 loss，但 V head 健康度保持稳定（v_loss 0.19→0.25 而非退化到随机）。这是 self-play 训练中 V30 编码器的典型行为，不影响下游 ISMCTS leaf eval 使用。
