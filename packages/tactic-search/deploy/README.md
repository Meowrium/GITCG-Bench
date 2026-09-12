# tactic-search 云端部署指南（v2）

## 概览

`tactic-search` v2 支持：
- 全角色三人组搜索（组合去重，不计角色排列）。
- 全卡池合法构筑（自动过滤不合法卡，遵守单卡数量限制）。
- 多线程 worker 并行。
- checkpoint 断点恢复。
- Docker 自定义镜像部署。

## 文件说明

| 文件 | 用途 |
|------|------|
| `pack.ts` | 将 monorepo 精简打包为可独立运行的子集 |
| `mine.ts` | 离线 combo 挖掘主入口（多线程 + checkpoint） |
| `mine-worker.ts` | 单 worker 任务执行逻辑 |
| `merge.ts` | 将云端结果合并回本地 registry |
| `Dockerfile` | 自定义镜像构建 |

---

## 1. 本地直接运行

```bash
cd genius-invokation/packages/tactic-search

# 全角色 + 全卡池合法构筑（默认 self 对局，推荐先限制 max-decks）
bun run mine -- --deck-source full-pool --pair-mode self --max-decks 500 --workers 8

# 从 checkpoint 恢复
bun run mine:resume -- --deck-source full-pool --pair-mode self --max-decks 500 --workers 8

# 使用外部牌组列表
bun run mine -- --decks ./decks.json --pair-mode all --max-pairs 1000 --workers 8
```

---

## 2. 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--decks <file>` | - | 指定牌组 JSON；指定后会覆盖 `deck-source` |
| `--deck-source <mode>` | `full-pool` | `full-pool` 或 `sample` |
| `--deck-variants <n>` | `1` | 每个角色三人组生成几个合法卡组变体 |
| `--pair-mode <mode>` | `self` | `self` 仅自身对局，`all` 为全对阵 |
| `--workers <n>` | CPU/2 | 多线程 worker 数 |
| `--max-decks <n>` | 全部 | 最多处理多少个 deck |
| `--max-pairs <n>` | 全部 | 最多处理多少个 pair task |
| `--samples <n>` | `10` | 每个 task 采样局面数 |
| `--beam-width <n>` | `10` | beam 宽度 |
| `--max-depth <n>` | `5` | beam 深度 |
| `--score-threshold <n>` | `5.0` | 最低入库分数 |
| `--top-k <n>` | `5` | 每次搜索取 top-k |
| `--checkpoint <n>` | `20` | 每 N 个任务保存一次 checkpoint |
| `--seed <n>` | `20260311` | 全卡池构筑随机种子 |
| `--resume` | - | 从 `output/progress.json` 恢复 |

---

## 3. Docker 自定义镜像

在 `genius-invokation` 根目录执行：

```bash
docker build -f packages/tactic-search/deploy/Dockerfile -t gi-tactic-search:custom .
```

运行镜像（输出挂载到本地）：

```bash
docker run --rm \
  -v $(pwd)/packages/tactic-search/output:/workspace/packages/tactic-search/output \
  gi-tactic-search:custom \
  bun run deploy/mine.ts --deck-source full-pool --pair-mode self --max-decks 1000 --workers 8 --checkpoint 20
```

恢复运行：

```bash
docker run --rm \
  -v $(pwd)/packages/tactic-search/output:/workspace/packages/tactic-search/output \
  gi-tactic-search:custom \
  bun run deploy/mine.ts --resume --deck-source full-pool --pair-mode self --max-decks 1000 --workers 8
```

---

## 4. 查看进度与结果

```bash
cat packages/tactic-search/output/progress.json | jq .
cat packages/tactic-search/output/stats.json | jq .
ls -lh packages/tactic-search/output/combos-*.json
```

`progress.json`（v2）关键字段：

```json
{
  "version": 2,
  "completedTaskIds": [0, 1, 2],
  "completedPairs": ["1101-1102-1103_vs_1101-1102-1103"],
  "totalTasks": 12345,
  "totalCombosFound": 678,
  "lastTimestamp": "2026-03-11T12:00:00.000Z"
}
```

---

## 5. 合并云端结果

```bash
cd genius-invokation/packages/tactic-search
bun run deploy/merge.ts ./cloud-results/
```

合并按 combo ID 去重，自动保留唯一结果。
