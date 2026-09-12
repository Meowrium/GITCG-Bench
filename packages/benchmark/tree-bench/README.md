# tree-bench

七圣召唤(Genius Invokation TCG)模型对战的赛后分析工具包:一次锦标赛结束后,产出

1. **Glicko-2 排行榜** —— 主评分(µ ± φ),与 PTCG-Bench 同一算法、同一初始化
2. **配对胜率 heatmap** —— 暴露克制关系(冷色 = 行选手更强)
3. **Spinning-top 结构诊断** —— 传递/循环分解 + Nash averaging + 响应图聚类,
   回答"这个榜哪里可信、哪里是循环噪声"

纯 TypeScript、零运行时依赖(heatmap 为手写 SVG)。

## 用法

在 `packages/benchmark` 下:

```bash
# 跑内置合成数据(3 个循环选手 + 2 个尖塔选手)演示
pnpm analyze:demo

# 分析真实对局
pnpm analyze --input path/to/results.json [--out <dir>] [--bootstrap 200] [--eps 0] [--raw-edges]
```

- `--bootstrap <n>`:bootstrap 重采样次数(默认 200,`0` 关闭)
- `--eps <x>`:响应图判边的额外绝对余量(默认 0)
- `--raw-edges`:关闭显著性检验,退化为裸 `A[i][j] > 0.5 + eps` 判边(不推荐,易把噪声当循环)
- `--seed <n>`:bootstrap 随机种子(默认 42)
- `--dense-subset <minGamesPerPair>`:稀疏池下,spinning-top 分解只在稠密子锦标赛上做
  ——保留"与其余入选选手每对都 ≥ n 局"的最大子集(贪心剔除),`spin-top.json` 记
  `usedSubset: {threshold, players}`;默认 0 = 不过滤(Glicko/heatmap 始终用全体选手)

输出到 `tree-bench/out/`(已 gitignore):

| 文件 | 内容 |
|---|---|
| `ratings.json` | Glicko-2 最终评分 + W/L/D |
| `ratings-history.json` | 每 period 更新后全体已进池选手的 `{id, mu, phi, sigma}`(末态与 `ratings.json` 一致) |
| `heatmap.svg` | 配对胜率热图(浏览器直接打开) |
| `heatmap.json` | 胜率矩阵 + 逐格对局数 `gamesMatrix` + `coverage {pairsTotal, pairsPlayed, ratio}` + 逐对统计;无对局格计算层仍填 0.5,以 `gamesMatrix===0` 区分 |
| `spin-top.json` | 分解、Nash averaging、聚类、bootstrap 区间(`--dense-subset` 时附 `usedSubset`) |

## matplotlib 绘图(plots/)

`plots/plot_*.py` 把上述 JSON 画成五张图(300dpi PNG,图内英文;依赖仅 matplotlib,
用 [uv](https://docs.astral.sh/uv/) 运行,缺输入文件时报错列出全部缺名):

```bash
uv run plots/plot_trajectory.py    --data out/ratings-history.json --out out/plots
uv run plots/plot_improvement.py   --data <results.json> --ratings-history out/ratings-history.json --out out/plots
uv run plots/plot_heatmap.py       --data out/heatmap.json --out out/plots          # 全史 by-model
uv run plots/plot_heatmap_deck.py  --data out/heatmap.json --out out/plots          # by-model-deck 仅最新代
uv run plots/plot_spintop.py       --data out/spin-top.json --out out/plots
```

| 图 | 文件 | 要点 |
|---|---|---|
| 排位轨迹 | `trajectory.png` | 每模型一条 µ 曲线 + ±2φ 置信带;新代进池竖虚线 |
| 迭代增益 | `improvement.png` | X@r vs X@(r-1) 聚合胜率 ±bootstrap CI;50% 基准线 |
| 全史热图 | `heatmap-full.png` | 模型×代际块排序;n=0 格灰底 hatch;格注 n;>40 选手去标签 |
| 卡组热图 | `heatmap-deck-latest.png` | by-model-deck 仅最新代;同上灰底规则 |
| 结构诊断 | `spintop-summary.png` | 传递/循环占比条形 + Nash averaging 条形 + 团块成员表 |

## 输入格式

`results.json` 为对局数组:

```json
[
  { "p1": "agent-a", "p2": "agent-b", "winner": "p1", "period": 0 },
  { "p1": "agent-a", "p2": "agent-c", "winner": "draw", "period": 0 },
  ...
]
```

- `winner`: `"p1" | "p2" | "draw"`(也接受 `"result": "win"|"loss"|"draw"`,相对 p1)
- `period`(可选):同一期内的对局合并为一个 Glicko-2 rating period;
  缺省时全部视为一期。建议一批(如 5 局)为一个 period,与 PTCG-Bench 一致。
- 不允许自对局(p1 === p2)。

## 解读指南

- **传递占比高(≥80%)**:榜单整体可信,可直接按 Glicko-2 排序。
- **传递占比低 / bootstrap 区间宽**:循环或噪声主导,只信 `spire`(尖塔)排序,
  循环团块 `{...}` 内部不可排序。
- **每对少于 ~20 局时**:分解与评分受二项噪声影响大,务必看 bootstrap 区间
  (Bertrand et al. 2023:有限样本会把噪声误判成循环)。

## 参考

- Glickman (2012) *Example of the Glicko-2 system* — glicko.net/glicko/glicko2.pdf
- Balduzzi et al. (2019) *Open-ended Learning in Symmetric Zero-sum Games* — arXiv:1901.08106
- Czarnecki et al. (2020) *Real World Games Look Like Spinning Tops* — arXiv:2004.09468
- Bertrand et al. (2023) *On the Limitations of the Elo...* — arXiv:2305.15234
- PTCG-Bench (2026) *Can LLM Agents Master Pokémon Trading Card Game?* — arXiv:2605.29653
