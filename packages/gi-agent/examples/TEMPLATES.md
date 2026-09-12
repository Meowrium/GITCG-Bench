# 模板文件说明

为了方便后续整理常见卡组和固定 benchmark 场景，这里先放了两个模板：

- [examples/configs/decks.template.json](<repo-root>/packages/gi-agent/examples/configs/decks.template.json)
- [benchmark-core.template.json](<repo-root>/packages/gi-agent/benchmark-core.template.json)

## 1. `decks.template.json`

用途：

- 存你确认过的常见 deck code
- 给每套牌一个稳定 `id`
- 方便你在仓库外或脚本里维护自己的 deck 池

字段建议：

- `id`
  - 稳定标识，后面不要轻易改
- `name`
  - 便于人工阅读
- `deckCode`
  - 真正要喂给 benchmark 的编码串
- `archetype`
  - 可选，方便后续按快攻/中速/展开等分组
- `tags`
  - 可选，方便筛选
- `notes`
  - 可选，记录来源、版本、已知弱点

## 2. `benchmark-core.template.json`

用途：

- 固定你的核心回归场景集
- 每次改 policy/evaluator 后都用这份跑一遍

当前模板里直接给了三类最常见起步项：

- `mirror-deck-001`
- `deck-001-vs-deck-002`
- `deck-002-vs-deck-001`

之所以正反都放，是因为当前输出以 `sideA / deck0` 为主视角，交换双方可以避免只看单边视角造成误判。

## 推荐用法

建议你后面按这个顺序落地：

1. 复制模板
   - `decks.template.json` -> `decks.json`
   - `benchmark-core.template.json` -> `benchmark-core.json`
2. 先填 `decks.json`
3. 再把对应 deck code 填进 `benchmark-core.json`
4. 用下面的命令跑固定回归集

```bash
pnpm run benchmark benchmark-core.json --output benchmark-core.result.json --markdown benchmark-core.report.md
```

## 当前限制

当前 benchmark CLI 还不支持在配置文件里直接通过 `deck id` 引用 `decks.json`。

也就是说：

- `decks.template.json` 现在主要是“你的 deck 池登记表”
- `benchmark-core.template.json` 仍然需要直接写 deck code

如果后面你确认想这么用，下一步最自然的改造就是：

- 让 benchmark CLI 支持 `deckRef`
- 再把 `decks.json` 自动展开到真实 deck code
