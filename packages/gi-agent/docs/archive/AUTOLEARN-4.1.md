# 4.1 卡组自动学习路线

## 卡组配置

8套卡组（来自 `to-gather/4_1decklist.txt`），已生成36个matchup配置：
- 8场内战
- 28场不同卡组对战

## 配置文件

| 文件 | 用途 |
|------|------|
| `benchmark-4.1.json` | Benchmark配置（36个matchup） |
| `self-play-4.1.json` | Self-play采样配置 |
| `iteration-4.1.json` | 迭代训练配置 |

## 自动学习路线操作步骤

### 第一步：跑 benchmark（建立基线）

```bash
cd packages/gi-agent
bun run benchmark benchmark-4.1.json --output benchmark-4.1-result.json --markdown benchmark-4.1-report.md
```

这会：
- 用 baseline policy 跑全部36个 matchup
- 每个 matchup 10局（可调整 `benchmark-4.1.json` 中的 `games` 字段）
- 输出每个 matchup 的胜率报表

### 第二步：补 self-play 样本

```bash
bun run self-play self-play-4.1.json
```

这会：
- 读取 `benchmark-4.1.json` 中的卡组配置
- 用当前策略自己对打（`gamesMultiplier` = 2，即每 matchup 20局）
- 把动作样本写入 `DataLake`（`output/data-4.1.db`）
- 输出每个 matchup 的插入样本数

### 第三步：自动迭代 evaluator

```bash
bun run iterate iteration-4.1.json --output output/iteration-4.1-report.json --markdown output/iteration-4.1-report.md
```

这会自动做三件事：
1. 如果配置里带 `selfPlay`，先补样本
2. 用 `DataLake` 训练 evaluator 权重（输出到 `output/weights-4.1-iteration.json`）
3. 跑 baseline vs evaluator 对比并给出 `promote` / `reject` 建议

### 第四步：评估结果

根据 `iteration-4.1-report.md` 中的报告：
- 检查总胜率是否提升
- 检查有没有关键 matchup 明显退化
- 检查样本量是否足够（`minSampleCount`: 500）

### 第五步：通过 benchmark 后接回 EvaluatorPolicy

如果通过 benchmark，可以将训练好的权重接回 `EvaluatorPolicy`：
```json
{
  "name": "evaluator-4.1",
  "kind": "evaluator",
  "weightsPath": "./output/weights-4.1-iteration.json"
}
```

## 常用命令汇总

```bash
cd packages/gi-agent

# 1. 跑基线 benchmark
bun run benchmark benchmark-4.1.json --output benchmark-4.1-result.json --markdown benchmark-4.1-report.md

# 2. 补 self-play 样本
bun run self-play self-play-4.1.json

# 3. 迭代训练 evaluator
bun run iterate iteration-4.1.json --output output/iteration-4.1-report.json --markdown output/iteration-4.1-report.md

# 4. 查看结果
cat output/iteration-4.1-report.md
```

## 调优参数

在配置文件中可以调整：

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| `games` | 每个 matchup 对局数 | 10-30 |
| `gamesMultiplier` | self-play 倍数 | 1-3 |
| `epochs` | 训练轮数 | 100-300 |
| `lr` | 学习率 | 0.001-0.1 |
| `lambda` | 正则化 | 0.0001-0.01 |
