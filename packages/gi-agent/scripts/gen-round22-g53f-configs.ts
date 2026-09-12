// 生成 round22-g53f 批跑配置：GLM-5.3-Flash(side0) vs GLM-5.2(side1)
// 镜像 16 组 + 跨卡组交叉 112 组（8×8 去对角 × 双臂）
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const decks = ["hongniu", "leihe", "leilang", "moyou", "shenxiao", "shuiba", "shuining", "shuizhai"]
const arms = ["ctrl", "anchor"] as const

/** 红牛/雷鹤沿用 round19 known_deck 口径计划；其余 6 卡组为 round20-xmodel mirror 口径 */
const glmPlan = (deck: string, arm: string) =>
  deck === "hongniu" || deck === "leihe"
    ? `../../output/plan-oneshot/round19-glm/plans/${deck}.${arm}.r0.json`
    : `../../output/plan-oneshot/round20-xmodel/glm/plans/${deck}.${arm}.r0.json`
const g53fPlan = (deck: string, arm: string) =>
  `../../output/plan-oneshot/round22-g53f/plans/${deck}.${arm}.r0.json`

const write = (rel: string, cfg: unknown) => {
  const p = `examples/plans/round22-g53f/${rel}`
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
  console.log(p)
}

for (const arm of arms) {
  const mirrorSeed = arm === "ctrl" ? 20273701 : 20273801
  const crossSeed = arm === "ctrl" ? 20273901 : 20274001
  for (const deck of decks) {
    write(`${deck}.${arm}.g53f-vs-glm.json`, {
      planFile: g53fPlan(deck, arm),
      opponent: { type: "plan", planFile: glmPlan(deck, arm) },
      games: 10,
      seedBase: mirrorSeed,
      concurrency: 4,
      alternateFirstPlayer: true,
      outDir: `../../output/plan-oneshot/round22-g53f/games/${deck}.${arm}.g53f-vs-glm`,
    })
  }
  for (const g of decks) {
    for (const d of decks) {
      if (g === d) continue
      write(`xdeck/${arm}.${g}-vs-${d}.json`, {
        planFile: g53fPlan(g, arm),
        opponent: { type: "plan", planFile: glmPlan(d, arm) },
        games: 10,
        seedBase: crossSeed,
        concurrency: 4,
        alternateFirstPlayer: true,
        outDir: `../../output/plan-oneshot/round22-g53f/xdeck/${arm}/${g}-vs-${d}`,
      })
    }
  }
}
