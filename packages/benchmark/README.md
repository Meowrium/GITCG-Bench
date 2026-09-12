# @gi-tcg/benchmark — 七圣召唤评测集

> 本包包含三个子 benchmark：
>
> | 子项目 | 测什么 | 入口 |
> |--------|--------|------|
> | `gi-knowledge/` | 卡牌世界知识记忆（456 题） | `pnpm generate / evaluate / score` |
> | `deck-analysis/` | 卡组战前分析推理（L2/L3，专家标注基准） | `pnpm annotate`（标注阶段） |
> | `gold-match/` | 金标准对局卡组池（历代版本竞技卡组 deck-list） | 数据目录 |
>
> 共享组件：`shared/jsdoc-scan.ts` — 从 `@gi-tcg/data` 源码 JSDoc 提取
> 卡牌/角色/技能定义的扫描器（gi-knowledge 与 deck-analysis 共用）。

## gi-knowledge：世界知识评测

> 测量 LLM 对《七圣召唤》(Genius Invokation TCG) 卡牌数据的世界知识掌握程度。
> AI 在不联网、不查询数据库的情况下，直接凭训练知识回答卡牌相关问题。

### 评测方式

1. **生成题库** — 从 `@gi-tcg/data` 源码的 JSDoc 注释中解析卡牌数据，自动生成问答对
2. **提问 LLM** — 将问题逐题发给 AI，AI 仅凭内在知识回答
3. **评分** — 关键词 + 子串匹配，按分类统计通过率

## 题类

| 分类 | 说明 | 难度 | 数量 |
|------|------|------|------|
| `card-name-to-effect` | 给出卡牌名，问效果 | 中 | 80 |
| `effect-to-card-name` | 给出效果描述，问卡牌名 | 中 | 60 |
| `card-cost` | 卡牌的元素骰费用 | 易 | 40 |
| `card-type` | 卡牌类型(事件/装备/支援/角色) | 易 | 40 |
| `character-element` | 角色元素属性 | 易 | 40 |
| `character-stats` | 角色生命值/充能 | 中 | 40 |
| `weapon-type` | 角色武器类型 | 易 | 30 |
| `nation` | 角色所属国家/阵营 | 中 | 30 |
| `version-introduced` | 卡牌加入版本 | 难 | 30 |
| `card-effect-match` | 从效果片段定位卡牌 | 难 | 26 |
| `cost-deduction` | 费用减免类卡牌 | 中 | 20 |
| `skill-cost` | 技能效果(含费用) | 难 | 15 |
| `multiple-answer` | 列举式开放题 | 难 | 4 |
| `from-description-find-name` | 条件组合查询 | 难 | 1 |

**总计: 456 题** (覆盖全部 14 个版本 v3.3.0 ~ v6.5.0，696 张可获取卡/角色)

## 快速开始

### 生成题库

```bash
# 自动生成到 data/benchmark-<时间戳>.json
pnpm generate

# 指定标签（方便后续引用）
pnpm exec gnx src/cli/generate.ts --tag my-run --max 500 --seed 42

# 指定完整路径
pnpm exec gnx src/cli/generate.ts --out custom.json
```

### 评测 LLM

```bash
# 默认读取 data/benchmark-questions.json，结果写入 data/benchmark-questions-<时间戳>-results.json
# 需要本地 Ollama 或兼容 API
LLM_API_URL=http://localhost:11434/api/generate \
LLM_MODEL=qwen2.5:7b \
pnpm evaluate

# 只用前 20 题快速测试
pnpm exec gnx src/cli/evaluate.ts --max 20

# 指定标签对齐生成阶段
pnpm exec gnx src/cli/evaluate.ts --tag my-run --max 100

# 使用 OpenAI 兼容 API
LLM_API_URL=https://api.openai.com/v1 \
LLM_MODEL=gpt-4o-mini \
LLM_API_KEY=sk-xxx \
pnpm exec gnx src/cli/evaluate.ts --max 100
```

### 重新打分

```bash
pnpm exec gnx src/cli/score.ts --results benchmark-results.json
```

## 输出

- `data/benchmark-questions.json` — 包含所有问题 + 标准答案 + 匹配关键词
- `data/benchmark-questions-results.json` — 评测结果（逐题 + 汇总报告）

## 评分报告示例

```
============================================================
 七圣召唤世界知识评测报告
============================================================
总题数: 456
通过: 312
通过率: 68.4%

── 各分类表现 ──

  card-name-to-effect              200/280   71.4% ████████████░░░░░░
  effect-to-card-name              150/220   68.2% ███████████░░░░░░░
  ...
```

## 数据来源

所有问题基于 `packages/data/src/` 下的源码，通过正则提取 JSDoc 注释（`@id`、`@name`、`@description`）及 builder 调用链（`.health()`、`.energy()`、`.cost*()`、`.tags()` 等）自动生成标准答案。

版本范围: v3.3.0 ~ v6.5.0 (共 14 个大版本)

---

## deck-analysis：卡组分析推理评测（标注阶段）

> 测量 LLM 仅凭卡组构成信息进行**战前分析**的推理能力（不是知识记忆）。
> 分为 L1 静态事实 / L2 内秉结构 / L3 对局响应链三层，核心价值在 L2/L3。
> 设计文档：`deck-analysis/DESIGN.md`。

**当前进度**：专家标注阶段。评测管线（题目生成/评分/judge/迭代对战）尚未实现。

### 标注（专家）

```bash
# 单卡组（L2）
pnpm annotate --deck <deckCode> --version v6.3.0 [--name 名称] [--resume]

# 单对局（L3）
pnpm annotate --matchup <myCode> --opp <oppCode> --version v6.3.0 [--resume]

# 批量：8 卡组 + 8×7=56 对局（有序对，不含内战）；--mirror 追加 8 内战
pnpm annotate --batch deck-analysis/data/deck-list.json [--mirror] [--resume]
```

- 标注对象：`deck-analysis/data/deck-list.json` 中的 8 套卡组（v6.3.0）
- 产出：`deck-analysis/data/ground-truth/{version}/decks/*.json`（卡组级）与
  `.../matchups/*.json`（对局级），schema 见 `deck-analysis/src/annotate/schema.ts`
- TUI：并排分栏，最左栏操作菜单；卡组模式两栏、对局模式三栏（菜单 + 我方 + 对手）；
  表单分区原位编辑（←→ 改值 / Space 勾选 / Enter 展开），列表分区下方向导；
  批量会话内 ←→ 直接切换上/下一套；每次编辑后自动保存；
  "保存并退出"打印校验告警；批量模式断点续标
