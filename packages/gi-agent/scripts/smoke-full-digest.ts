// 一次性冒烟：验证 extractFullDigest 在真实 run 目录上的输出形态与计数。
// 用法：pnpm exec gnx scripts/smoke-full-digest.ts [runDir] [side]
import { extractFullDigest } from "../src/runtime/plan-oneshot/cli/evidence-extract.js"

const runDir = process.argv[2] ?? "../../output/plan-oneshot/round10-mm/games"
const side = Number(process.argv[3] ?? "1") as 0 | 1
const evalSuffix = process.argv[4] || undefined

const r = await extractFullDigest(runDir, side, { evalSuffix })
console.log(`side${side}: total=${r.totalPoints} blunders=${r.blunders} divergences=${r.divergences} fallbacks=${r.fallbacks} omittedAligned=${r.omittedAligned} lines=${r.lines.length}`)
console.log("--- 前 3 行 ---")
console.log(r.lines.slice(0, 3).join("\n"))
console.log("--- 含 ✗ 的前 5 行 ---")
console.log(r.lines.filter((l) => l.includes("✗")).slice(0, 5).join("\n"))
console.log("--- global:11 相关行数 ---", r.lines.filter((l) => l.includes("global:11")).length)
