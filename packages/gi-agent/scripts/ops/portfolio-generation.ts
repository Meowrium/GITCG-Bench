// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * portfolio-generation — 两层 portfolio（General + Single）代际循环 orchestrator
 * （G9，Phase 5）。只编排 CLI 调用（author → batch → reflect → [ablate]），不重新
 * 实现任何批跑/反思/消融逻辑；全部产物走既有 CLI 与存储约定（见
 * TEMP-two-layer-general-single-gap-analysis.md §5 与 §2-G9）。
 *
 * 用法（在 gi-agent 包目录内）：
 *   pnpm exec gnx scripts/ops/portfolio-generation.ts <config.json> [--dry-run]
 *
 * config（形状定型，完整实例见 examples/plans/roundP1-portfolio/portfolio-generation.example.json）：
 * {
 *   "deck": "<己方分享码>",
 *   "portfolioDir": "output/portfolio-p1",       // portfolio.json 与 plans/ 所在
 *   "runRoot": "output/plan-bench",              // run 目录根
 *   "rounds": 3,                                  // r0 → r3（round 0 = 起草；1..rounds = 代际循环）
 *   "games": 20, "seedBase": 100,
 *   "evidence": [                                 // 证据对局（2-3 个卡组对手；进反思 --run-dir）
 *     { "label": "hongniu", "deckCode": "<对手分享码>", "opponentPlanFile": "examples/plans/…ctrl….json" }
 *   ],
 *   "metric":   { "label": "hongniu", "opponentPlanFile": "…", "games": 40 },  // 度量对局（不进反思）
 *   "heldout":  [{ "label": "moyou", "opponentPlanFile": "…", "games": 10 }],  // held-out 泛化批次（不进反思）
 *   "skipAuthor": false,                          // true = 假定 portfolioDir 已有 r0 计划与 portfolio.json
 *   "skipAblate": true,                           // MVP 默认跳过消融（可开）
 *   "authorExtraArgs": [],                        // 可选；透传给 plan:author
 *   // 可选扩展（缺省用默认值）：
 *   "concurrency": 4,                             // 批跑并发
 *   "gameVersion": "v6.3.0",                      // 钉对局数据版本（缺省 = plan:batch 默认 CURRENT_VERSION）
 *   "continueOnError": false,                     // true = 批跑/反思/消融失败打印上下文后继续
 *   "ablateExtraArgs": []                         // 可选；透传给 plan:ablate
 * }
 *
 * 每代循环（round r = 1..rounds；执行顺序按依赖编排，见下注①）：
 *   0. （r0 准备，仅 skipAuthor=false 时）evidence 各对手经 wrapper
 *      scripts/ops/author-portfolio-singles.ts 起草 single（plan:author --opponent-deck
 *      <code>）；opponent-set 文件（evidence[].deckCode 换行）→ --opponent-set 起草
 *      general（plan:author 强制 unknown_deck，D3）；随后生成 portfolio.json
 *      （plans/general.r0.json + plans/single.<label>.r0.json，D5）并做轻量结构校验
 *      （完整 G8 校验由首次证据批跑的 loadPortfolioWithValidation 承担）。
 *   1. 证据批跑：逐 evidence 对手写 plan:batch config（portfolio 键 + opponent plan 型
 *      + opponentDeckCode + games/seedBase + concurrency），顺序执行；outDir
 *      <runRoot>/r<r-1>-evidence-vs-<label>。opponent 必须 plan 型（消融依赖
 *      plan.side1.json 归档）；run 目录自动落 portfolio.side0.json（reflect 组断言用）。
 *   2. 反思：plan:reflect --portfolio <portfolioDir>/portfolio.json --round <r> --side 0
 *      --evidence engine-only --run-dir <证据组逗号列表> --out <portfolioDir>
 *      → plans/general.r<r>.json + plans/single.<label>.r<r>.json + 更新 portfolio.json
 *      + sidecar（reflect.reflection.json / reflect.prompt.txt 落 portfolioDir 根部）。
 *   3. 度量/held-out 批跑：portfolio config 照常（路由自然处理：heldout 对手无 single
 *      → general-only，即路由退化的直接度量）；outDir <runRoot>/metric-r<r> /
 *      <runRoot>/heldout-r<r>-<label>。度量/heldout 不进 reflect 的 --run-dir。
 *   4. （可选）消融：skipAblate=false 时 plan:ablate portfolio 模式（base = 反思前
 *      r<r-1> manifest 快照 <portfolioDir>/portfolio.base.r<r-1>.json，revised =
 *      portfolioDir 目录，reflection = reflect.reflection.json，evidence-runs = 本轮
 *      证据组，--evidence engine-only），臂输出 <runRoot>/ablate-r<r>/ 下各 arm 目录。
 *
 * 注① 度量/heldout 放在反思之后执行：它们度量本轮新产出的 r<r> 代（roundS 的
 *      metric-r<N> 口径 = 度量第 N 代树）；任务步骤清单 2/3/4 按组件列示，实际
 *      依赖顺序为 证据 → 反思 → 度量/heldout。
 *
 * seed 约定（确定性、可复现；metric/heldout 跨代固定 → 同 seed 梯跨代可比）：
 *   evidence[i] @ round r : seedBase + (r-1)*1000 + i*10
 *   metric        @ round r: seedBase + 5000        （每代相同）
 *   heldout[i]    @ round r: seedBase + 6000 + i*10 （每代相同）
 *
 * --dry-run：只打印将执行的命令序列（含将写入的 config 内容），不执行、不写盘。
 * fail-fast：任一步失败打印轮次/步骤上下文与输出尾部并停止（exit 1）；
 *   continueOnError=true 时批跑/反思/消融失败仅记录继续（author 与 portfolio.json
 *   生成失败恒 fail-fast）。
 *
 * 路径约定：config 内全部路径相对 gi-agent 包目录（调用方 cwd），不硬编码绝对路径；
 * 与 scripts/ops/author-portfolio-singles.ts 同约定（spawnSync + shell:true——Windows
 * 下 pnpm 是 .cmd）。
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { VERSIONS } from "@gi-tcg/core"

// ── config 形状 ─────────────────────────────────────────────────────────

interface EvidenceEntry {
  label: string
  deckCode: string
  opponentPlanFile: string
}

interface MetricEntry {
  label: string
  opponentPlanFile: string
  games?: number
  /** 可选；显式指定对手牌表分享码——缺省由 opponentPlanFile 的 context.deckCode 推导 */
  deckCode?: string
}

interface HeldoutEntry {
  label: string
  opponentPlanFile: string
  games?: number
  /** 可选；显式指定对手牌表分享码——缺省由 opponentPlanFile 的 context.deckCode 推导 */
  deckCode?: string
}

interface GenerationConfig {
  deck: string
  portfolioDir: string
  runRoot: string
  rounds: number
  games: number
  seedBase: number
  evidence: EvidenceEntry[]
  metric?: MetricEntry
  heldout?: HeldoutEntry[]
  skipAuthor?: boolean
  skipAblate?: boolean
  authorExtraArgs?: string[]
  concurrency?: number
  gameVersion?: string
  continueOnError?: boolean
  ablateExtraArgs?: string[]
}

// ── 校验 ─────────────────────────────────────────────────────────────────

function checkLabel(label: string, where: string): void {
  if (label.length === 0 || label.includes(":")) {
    console.error(`${where} label 非法：${JSON.stringify(label)}（必须非空且不含 ':'——ruleRef 层前缀分隔符）`)
    process.exit(1)
  }
}

function validateConfig(c: GenerationConfig): void {
  if (!c.deck && !c.skipAuthor) {
    console.error("config 需包含 deck（skipAuthor=false 时起草必需）")
    process.exit(1)
  }
  if (!c.portfolioDir || !c.runRoot) {
    console.error("config 需包含 portfolioDir 与 runRoot（相对 gi-agent 包目录）")
    process.exit(1)
  }
  if (!Number.isInteger(c.rounds) || c.rounds < 1) {
    console.error("config.rounds 必须是 ≥1 的整数（r0 → r<rounds>）")
    process.exit(1)
  }
  if (!Number.isInteger(c.games) || c.games < 1 || !Number.isInteger(c.seedBase)) {
    console.error("config.games（≥1 整数）与 config.seedBase（整数）必填")
    process.exit(1)
  }
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
    console.error("config.evidence 必须是非空数组（2-3 个卡组对手；必填，进反思证据包）")
    process.exit(1)
  }
  const labels = c.evidence.map((e) => e.label)
  if (new Set(labels).size !== labels.length) {
    console.error("evidence[].label 必须唯一（产物文件名与 ruleRef 层前缀依赖 label）")
    process.exit(1)
  }
  for (const e of c.evidence) {
    checkLabel(e.label, `evidence[${e.label}]`)
    if (!e.deckCode || !e.opponentPlanFile) {
      console.error(`evidence[${e.label}] 需包含 deckCode 与 opponentPlanFile`)
      process.exit(1)
    }
  }
  if (c.metric) {
    checkLabel(c.metric.label, "metric")
    if (!c.metric.opponentPlanFile) {
      console.error(`metric[${c.metric.label}] 需包含 opponentPlanFile`)
      process.exit(1)
    }
  }
  for (const h of c.heldout ?? []) {
    checkLabel(h.label, `heldout[${h.label}]`)
    if (!h.opponentPlanFile) {
      console.error(`heldout[${h.label}] 需包含 opponentPlanFile`)
      process.exit(1)
    }
  }
  for (const [i, e] of c.evidence.entries()) {
    if (!existsSync(e.opponentPlanFile)) {
      console.error(`evidence[${i}]（${e.label}）的 opponentPlanFile 不存在：${e.opponentPlanFile}`)
      process.exit(1)
    }
  }
  // 版本钉扎（V2）：config.gameVersion 封闭校验（缺省 = CURRENT_VERSION，由下游
  // plan:batch / plan:author 各自回落）；非法版本串启动报错并列出可用版本
  if (c.gameVersion !== undefined && !(VERSIONS as readonly string[]).includes(c.gameVersion)) {
    console.error(`config.gameVersion 非法：${JSON.stringify(c.gameVersion)}（可用：${VERSIONS.join(", ")}）`)
    process.exit(1)
  }
}

// ── 执行助手 ─────────────────────────────────────────────────────────────

function runPnpm(step: string, script: string, args: string[], dryRun: boolean): boolean {
  const cmd = ["pnpm", "run", script, "--", ...args].join(" ")
  if (dryRun) {
    console.log(`[dry-run] ${step}：${cmd}`)
    return true
  }
  console.log(`\n### ${step}`)
  const res = spawnSync("pnpm", ["run", script, "--", ...args], {
    cwd: process.cwd(),
    shell: true,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (res.status !== 0) {
    console.error(`[fail] ${step} 失败（exit=${res.status ?? "signal"}）：`)
    console.error((res.stdout ?? "").trim().split("\n").slice(-12).join("\n"))
    console.error((res.stderr ?? "").trim().split("\n").slice(-12).join("\n"))
    return false
  }
  console.log(`[ok] ${step}`)
  return true
}

/** 写生成的 config 文件；dry-run 只打印内容不写盘 */
async function writeConfig(path: string, value: unknown, dryRun: boolean): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (dryRun) {
    console.log(`[dry-run] 将写入 ${path}：\n${text}`)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf-8")
}

/** batch config 公共骨架（portfolio 键 + opponent plan 型；evidence 需显式 opponentDeckCode） */
function batchConfigOf(c: GenerationConfig, outDir: string, games: number, seedBase: number, opponentDeckCode?: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    portfolio: `${c.portfolioDir}/portfolio.json`,
    opponent: { type: "plan", planFile: "" }, // planFile 由调用方覆写
    games,
    seedBase,
    alternateFirstPlayer: true,
    concurrency: c.concurrency ?? 4,
    outDir,
  }
  if (opponentDeckCode !== undefined) cfg.opponentDeckCode = opponentDeckCode
  if (c.gameVersion) cfg.gameVersion = c.gameVersion
  return cfg
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const configPath = args.find((a) => !a.startsWith("-"))
  const dryRun = args.includes("--dry-run")
  if (!configPath) {
    console.error("usage: pnpm exec gnx scripts/ops/portfolio-generation.ts <config.json> [--dry-run]")
    process.exit(1)
  }
  const config = JSON.parse(await readFile(configPath, "utf-8")) as GenerationConfig
  validateConfig(config)

  const portfolioDir = config.portfolioDir
  const runRoot = config.runRoot
  const continueOnError = config.continueOnError ?? false
  console.log(
    `portfolio-generation：rounds=0..${config.rounds}，evidence=${config.evidence.map((e) => e.label).join(",")}`
    + `${config.metric ? `，metric=${config.metric.label}` : ""}`
    + `${config.heldout?.length ? `，heldout=${config.heldout.map((h) => h.label).join(",")}` : ""}`
    + `${dryRun ? "（dry-run，仅打印）" : ""}`,
  )

  // ── r0 起草（skipAuthor=false 时）──────────────────────────────────────
  if (!config.skipAuthor) {
    const opponentSet = `${portfolioDir}/opponent-set.txt`
    const wrapperConfig = `${runRoot}/configs/author.r0.json`
    // opponent-set 文件（换行文本，parseOpponentSetFile 兼容：空行与 # 注释忽略）
    const setText = config.evidence.map((e) => e.deckCode).join("\n") + "\n"
    if (dryRun) {
      console.log(`[dry-run] 将写入 ${opponentSet}：\n${setText}`)
    } else {
      await mkdir(portfolioDir, { recursive: true })
      await writeFile(opponentSet, setText, "utf-8")
    }
    const wrapperCfg = {
      deck: config.deck,
      opponents: config.evidence.map((e) => ({ code: e.deckCode, label: e.label })),
      outDir: portfolioDir,
      round: 0,
      // 版本钉扎（V2）：显式 gameVersion → r0 起草全部 author 调用带 --game-version
      //（产物写 context.gameVersion、prompt 卡面按该版本），全链路与批跑数据同版本
      extraAuthorArgs: [
        ...(config.gameVersion !== undefined ? ["--game-version", config.gameVersion] : []),
        ...(config.authorExtraArgs ?? []),
      ],
      generalOpponentsFile: opponentSet,
    }
    await writeConfig(wrapperConfig, wrapperCfg, dryRun)
    // wrapper 经 gnx 调用（不在 package.json 中）
    const wrapperCmd = ["pnpm", "exec", "gnx", "scripts/ops/author-portfolio-singles.ts", wrapperConfig].join(" ")
    if (dryRun) {
      console.log(`[dry-run] [r0] 起草：${wrapperCmd}`)
    } else {
      console.log("\n### [r0] 起草（wrapper：singles + general）")
      const res = spawnSync("pnpm", ["exec", "gnx", "scripts/ops/author-portfolio-singles.ts", wrapperConfig], {
        cwd: process.cwd(),
        shell: true,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      if (res.status !== 0) {
        console.error(`[fail] [r0] 起草失败（exit=${res.status ?? "signal"}）：`)
        console.error((res.stdout ?? "").trim().split("\n").slice(-12).join("\n"))
        console.error((res.stderr ?? "").trim().split("\n").slice(-12).join("\n"))
        process.exit(1)
      }
      console.log("[ok] [r0] 起草完成")
    }

    // 生成 portfolio.json（D5；lineage 从产物读取，装载时仍会重算校验）
    const manifestPath = `${portfolioDir}/portfolio.json`
    const manifest = await buildR0Manifest(config, dryRun)
    await writeConfig(manifestPath, manifest, dryRun)
    if (!dryRun) {
      const loaded = JSON.parse(await readFile(manifestPath, "utf-8")) as { version?: string; generalPlan?: string; singles?: unknown[] }
      if (loaded.version !== "PlanPortfolioV1" || !loaded.generalPlan || !Array.isArray(loaded.singles)) {
        console.error("[fail] [r0] portfolio.json 结构校验未过（version/generalPlan/singles）——请检查起草产物")
        process.exit(1)
      }
      console.log(`[ok] [r0] portfolio.json 已生成（general=${loaded.generalPlan}，singles=${loaded.singles.length}）`)
    }
  } else {
    const manifestPath = `${portfolioDir}/portfolio.json`
    if (!existsSync(manifestPath)) {
      console.error(`[fail] skipAuthor=true 但 ${manifestPath} 不存在——请先准备 r0 计划与 portfolio.json`)
      process.exit(1)
    }
    console.log(`[r0] skipAuthor=true：假定 ${manifestPath} 已就绪`)
  }

  // ── 代际循环 r = 1..rounds ────────────────────────────────────────────
  for (let r = 1; r <= config.rounds; r++) {
    console.log(`\n========== round ${r}/${config.rounds}（r${r - 1} → r${r}）==========`)

    // 1) 证据批跑（r<r-1> 代组合树；opponent 必须 plan 型）
    const evidenceDirs: string[] = []
    for (const [i, e] of config.evidence.entries()) {
      const dir = `${runRoot}/r${r - 1}-evidence-vs-${e.label}`
      evidenceDirs.push(dir)
      const cfg = batchConfigOf(config, dir, config.games, config.seedBase + (r - 1) * 1000 + i * 10, e.deckCode)
      ;(cfg.opponent as { planFile: string }).planFile = e.opponentPlanFile
      const cfgPath = `${runRoot}/configs/r${r - 1}-evidence-vs-${e.label}.json`
      await writeConfig(cfgPath, cfg, dryRun)
      const ok = runPnpm(`[r${r}] 证据批跑 ${e.label}（r${r - 1} 组合树 vs plan 对手）`, "plan:batch", [cfgPath], dryRun)
      if (!ok) {
        if (continueOnError) {
          console.error(`[warn] [r${r}] 证据批跑 ${e.label} 失败，continueOnError=true 继续`)
        } else {
          console.error(`[fail] [r${r}] 证据批跑 ${e.label} 失败——中止（continueOnError=true 可跳过）`)
          process.exit(1)
        }
      }
    }

    // 2) 反思（r<r-1> 证据包 → r<r>；--evidence engine-only）
    const reflectArgs = [
      "--portfolio", `${portfolioDir}/portfolio.json`,
      "--round", String(r),
      "--side", "0",
      "--evidence", "engine-only",
      "--run-dir", evidenceDirs.join(","),
      "--out", portfolioDir,
    ]
    const okReflect = runPnpm(`[r${r}] 反思（证据组 ${evidenceDirs.length} 个 → r${r}）`, "plan:reflect", reflectArgs, dryRun)
    if (!okReflect) {
      console.error(`[fail] [r${r}] 反思失败——中止（反思失败无法进入下一代的 r${r} 计划）`)
      process.exit(1)
    }

    // 3) 度量/held-out 批跑（r<r> 代；不进反思 --run-dir）
    if (config.metric) {
      const dir = `${runRoot}/metric-r${r}`
      const cfg = batchConfigOf(config, dir, config.metric.games ?? config.games, config.seedBase + 5000, config.metric.deckCode)
      ;(cfg.opponent as { planFile: string }).planFile = config.metric.opponentPlanFile
      const cfgPath = `${runRoot}/configs/metric-r${r}.json`
      await writeConfig(cfgPath, cfg, dryRun)
      const ok = runPnpm(`[r${r}] 度量 ${config.metric.label}（r${r} 组合树，seed ${config.seedBase + 5000}）`, "plan:batch", [cfgPath], dryRun)
      if (!ok && !continueOnError) {
        console.error(`[fail] [r${r}] 度量 ${config.metric.label} 失败——中止`)
        process.exit(1)
      }
    }
    for (const [i, h] of (config.heldout ?? []).entries()) {
      const dir = `${runRoot}/heldout-r${r}-${h.label}`
      const cfg = batchConfigOf(config, dir, h.games ?? config.games, config.seedBase + 6000 + i * 10, h.deckCode)
      ;(cfg.opponent as { planFile: string }).planFile = h.opponentPlanFile
      const cfgPath = `${runRoot}/configs/heldout-r${r}-${h.label}.json`
      await writeConfig(cfgPath, cfg, dryRun)
      const ok = runPnpm(`[r${r}] held-out ${h.label}（r${r} 树，无 single → general-only 度量）`, "plan:batch", [cfgPath], dryRun)
      if (!ok && !continueOnError) {
        console.error(`[fail] [r${r}] held-out ${h.label} 失败——中止`)
        process.exit(1)
      }
    }

    // 4) 消融（可选；base = 反思前 r<r-1> manifest 快照）
    if (!config.skipAblate) {
      const baseSnapshot = `${portfolioDir}/portfolio.base.r${r - 1}.json`
      if (!dryRun) {
        await writeFile(baseSnapshot, await readFile(`${portfolioDir}/portfolio.json`, "utf-8"), "utf-8")
      }
      const ablateArgs = [
        "--portfolio-base", baseSnapshot,
        "--portfolio-revised", portfolioDir,
        "--reflection", `${portfolioDir}/reflect.reflection.json`,
        "--evidence-runs", evidenceDirs.join(","),
        "--evidence", "engine-only",
        "--out", `${runRoot}/ablate-r${r}`,
        ...(config.ablateExtraArgs ?? []),
      ]
      const ok = runPnpm(`[r${r}] 消融（base r${r - 1} vs revised r${r}）`, "plan:ablate", ablateArgs, dryRun)
      if (!ok && !continueOnError) {
        console.error(`[fail] [r${r}] 消融失败——中止`)
        process.exit(1)
      }
    }
  }

  console.log(`\n全部完成：r0 → r${config.rounds}。产物：`)
  console.log(`  portfolio manifest：${portfolioDir}/portfolio.json`)
  console.log(`  plans：${portfolioDir}/plans/general.r{N}.json + plans/single.<label>.r{N}.json`)
  console.log(`  证据组：${runRoot}/r{N}-evidence-vs-<label>`)
  console.log(`  度量/held-out：${runRoot}/metric-r{N} / ${runRoot}/heldout-r{N}-<label>`)
  if (!config.skipAblate) console.log(`  消融臂：${runRoot}/ablate-r{N}/arm-XX-*/<组名>/`)
}

/** r0 manifest：generalPlan + singles（label 缺省 = opponentDeckCode）+ lineage（从产物读取） */
async function buildR0Manifest(c: GenerationConfig, dryRun: boolean): Promise<Record<string, unknown>> {
  const generalRef = "plans/general.r0.json"
  let generalPlanId: string | null = null
  const singles: Array<{ opponentDeckCode: string; label?: string; planRef: string }> = []
  const singleIds: Record<string, string> = {}
  if (!dryRun) {
    const general = JSON.parse(await readFile(`${c.portfolioDir}/${generalRef}`, "utf-8")) as { planId?: string }
    generalPlanId = general.planId ?? null
    for (const e of c.evidence) {
      const plan = JSON.parse(await readFile(`${c.portfolioDir}/plans/single.${e.label}.r0.json`, "utf-8")) as { planId?: string }
      singles.push({
        opponentDeckCode: e.deckCode,
        ...(e.label !== e.deckCode ? { label: e.label } : {}),
        planRef: `plans/single.${e.label}.r0.json`,
      })
      singleIds[e.label] = plan.planId ?? ""
    }
  } else {
    for (const e of c.evidence) {
      singles.push({
        opponentDeckCode: e.deckCode,
        ...(e.label !== e.deckCode ? { label: e.label } : {}),
        planRef: `plans/single.${e.label}.r0.json`,
      })
    }
  }
  return {
    version: "PlanPortfolioV1",
    generalPlan: generalRef,
    singles,
    ...(generalPlanId !== null ? { lineage: { generalId: generalPlanId, singles: singleIds } } : {}),
  }
}

await main()
