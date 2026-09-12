# WP3 实现规格：tree-bench 扩展 + matplotlib 五图

> 来源：[impl-spec-0-overview.md](./2026-09-05-impl-spec-0-overview.md)；目标：执行方案阶段 0-C/0-D。
> 状态：**已实现**（2026-09-05/06：mini 数据端到端五图验证、coverage 手算核对、threshold=0 与现状逐字节一致）。
> 设计依据：[2026-09-03-cross-model-rating-tournament.md](./2026-09-03-cross-model-rating-tournament.md) §6/§7（R7 定稿）。
> 实现位置：`packages/benchmark/tree-bench/`（src 小改 + plots/ 新增）。

## 1. 交付物

| # | 件 | 位置 |
|---|---|---|
| 1 | ratings-history.json 导出 | `tree-bench/src/cli/analyze.ts` |
| 2 | coverage 统计 + 无对局格元数据 | `tree-bench/src/cli/analyze.ts` / `heatmap.json` 输出 |
| 3 | spin-top 稠密子块过滤参数 | `tree-bench/src/cli/analyze.ts` / `spin-top.ts` |
| 4 | matplotlib 绘图脚本 ×5 | `tree-bench/plots/plot_*.py` + `plots/requirements.txt` |

## 2. 需求细节

### 2.1 ratings-history（件 1）

- `analyze` 的逐 period 循环内，每期结束后把全体选手的 `{id, mu, phi, sigma}` 落
  `ratings-history.json`：`{periods: [{period: r, players: [{id, mu, phi, sigma}]}]}`。
- 语义对齐：期内期初快照（`glicko2.ts:195-229` 已核实的先快照后更新）——history 记录
  的是"本期更新后"状态（与最终 ratings.json 末态一致可校验）。
- 验收：构造两 period 的 mini results.json 跑 analyze，末 period 的 players 状态 ==
  ratings.json 同 id 值。

### 2.2 coverage 与无对局格（件 2）

- `heatmap.json` 增 `coverage: { pairsTotal, pairsPlayed, ratio }` 与逐格 `n`（对局数）；
  **计算层仍填 0.5（`results.ts:158` 现状，算法消费），呈现层以 n===0 区分**。
- 验收：含未交手对的输入 → coverage 数字正确；heatmap.json 每格带 n。

### 2.3 spin-top 稠密子块（件 3）

- analyze 增 `--dense-subset <minGamesPerPair>`（默认 0 = 不过滤）；过滤后子锦标赛上
  做分解，并在 spin-top.json 记 `{usedSubset: {threshold, players}}`。
- 验收：稀疏输入 + threshold → 只含达到阈值的选手对；threshold=0 与现状输出一致。

### 2.4 matplotlib 五图（件 4）

`plots/` 下五脚本（`pnpm` 不可用 Python——统一用 `uv run plot_x.py --data <out> --out <dir>`）：

| 脚本 | 输入 | 内容要点 |
|---|---|---|
| `plot_trajectory.py` | ratings-history.json | 每模型一条 µ 曲线 + ±2φ 置信带；新代进池竖虚线；图例 |
| `plot_improvement.py` | results.json（by-model）+ ratings-history | 每模型 X@r vs X@(r-1) 聚合胜率 ±bootstrap CI 柱/线；50% 基准线 |
| `plot_heatmap.py` | heatmap.json | 全史 by-model：模型×代际块排序；n=0 格灰底 hatch；格注 n；>40 选手缩字号/去标签 |
| `plot_heatmap_deck.py` | heatmap.json | by-model-deck 仅最新 period；同上灰底规则 |
| `plot_spintop.py` | spin-top.json | 传递/循环占比条形 + Nash averaging 条形 + 团块成员表（matplotlib table） |

**约定**（09-03 §7.1）：图内文字英文；PNG 300dpi 出 `out/plots/`；同名单 SVG 可选；
缺输入文件时脚本报错列缺名不静默。`requirements.txt` 仅 `matplotlib>=3.8`。
**bootstrap CI**：若 analyze 输出已含区间则直接用；不含则脚本内自算（纯 numpy，
200 次重采样，秒级）。

## 3. 验收标准

1. mini 数据端到端：构造 4 选手×2 period×含平局与未交手对的 results.json →
   `pnpm analyze` 出全产物 → 五脚本各出 PNG（人工看图：曲线/置信带/灰底格/图例齐全）；
2. ratings-history 末态一致性（§2.1 验收）；
3. coverage 数字与手算一致（构造数据 6 对中 4 对交手 → 4/6）；
4. dense-subset 过滤正确且 threshold=0 无回归（tree-bench 现有测试如存在须全绿；
   无测试则 mini 数据对比）；
5. `uv run` 一遍跑通五脚本（uv 环境仅装 requirements.txt）；
6. 空数据边界：全平局/单人/单 period 输入不崩（允许报错退出但消息可读）。

## 4. 明确不做

不改动 Glicko-2/热图/spin-top 算法语义；不做交互式图；不做中文渲染方案（预留注册
CJK 字体的注释即可）；heatmap.svg legacy 路径不动。
