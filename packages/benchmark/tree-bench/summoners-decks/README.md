# summoners-decks

从 [召唤之巅](https://www.summoners.top/)（七圣召唤赛事数据站）API 爬取的各版本卡组统计数据。

## 文件

| 文件 | 游戏版本 | 站内名称 |
|---|---|---|
| `4.0.json` | 4.0 | — |
| `4.8.json` | 4.8 | — |
| `5.3.json` | 5.3 | — |
| `5.8.json` | 5.8 | — |
| `6.3.json` | 6.3 | 月之四 |

## 数据来源

API v4（文档见 <https://www.summoners.top/_docs/scalar>，OpenAPI 规范 `/​_docs/openapi.json`）：

- `GET /api/v4/teams-stats?gameVersion={v}` — 该版本所有阵容（三角色组合）的对局数/胜场
- `GET /api/v4/teams/{teamId}/decks-stats?gameVersion={v}` — 每个阵容下的具体卡组分享码及对局数/胜场
- `GET /api/v4/cards-data` — 角色牌 ID → 中文名/英文名
- `GET /api/v4/overview-stats` — 各版本"含牌组对局数"（出场率分母）
- `GET /api/v4/game-versions` — 版本 ID 与名称映射

爬取时间：2026-09-02。

## 字段说明

每个文件为 `{ source, gameVersion, versionName, numGamesWithDeck, deckCount, decks: [...] }`：

| 字段 | 含义 |
|---|---|
| `deckCode` | 牌组分享码（可直接导入游戏） |
| `teamId` | 阵容 ID（角色牌 ID 以 `-` 拼接） |
| `characters` | 三个角色的中文名（按角色牌 ID 升序） |
| `charactersEn` | 三个角色的英文名 |
| `numGames` | 该卡组上场对局数 |
| `numGamesWin` | 获胜对局数 |
| `usageRate` | 出场率 = `numGames / numGamesWithDeck`（0–1 比例，版本内含牌组对局数为分母） |
| `winRate` | 胜率 = `numGamesWin / numGames`（0–1 比例） |

`decks` 按对局数降序排列。

## 去重规则

同一角色配队的卡组（三角色组合相同、顺序无关，即同 `teamId`）只保留一个：优先出场率（`numGames` 最大），场次并列时取胜率（`winRate`）更高者。各版本去重后数量：4.0 → 21、4.8 → 39、5.3 → 23、5.8 → 25、6.3 → 23。

未去重的原始全量数据备份在 `raw/` 子目录（文件名同名，数量：105 / 186 / 78 / 68 / 72），可随时重新爬取（脚本 `fetch-raw.mjs`）。

## 注意事项

- **对局口径**：`numGames` 为该卡组在收录对局中的上场次数，镜像对局对双方阵容各计一次，因此各卡组 `numGames` 之和会大于 `numGamesWithDeck`。
- **4.8 版本差异**：爬取时本目录聚合出 186 个卡组（去重前），而站内 `deck-codes`（热门牌组列表，预计算缓存）只有 169 个。差异的 17 个均为对局数 ≤3 的低频卡组，且网站列表是当时数据的子集，故以实时聚合的 teams/decks-stats 为准。
- 角色名来自 `cards-data` 的**当前**卡牌数据；早期版本角色未改动 ID，映射不受版本影响。
