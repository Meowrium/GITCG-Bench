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
 * annotate.ts - 卡组 Ground Truth 标注 TUI（v3.0：卡组/对局分离）
 *
 * 功能：
 *   - 并排分栏：最左栏操作菜单（↑↓/jk 导航），右侧卡组信息面板
 *   - 卡组模式两栏（菜单+卡组信息），对局模式三栏（菜单+我方+对手）
 *   - 表单分区原位编辑：字段显示在大类下方，←→ 改值 / Space 勾选 / Enter 展开
 *   - 批量会话：标注界面内 ←→ 直接切换上/下一套（或点菜单「上/下一卡组」）
 *   - 选牌/选操作时显示卡牌效果描述
 *   - 每次编辑后自动保存（Ctrl+C 不丢数据）
 *   - 批量模式进度持久化、断点续标
 *
 * 用法（在 packages/benchmark 下）:
 *   单卡组: pnpm annotate --deck <code> --version v6.3.0 [--name "卡组名"] [--resume]
 *   单对局: pnpm annotate --matchup <myCode> --opp <oppCode> --version v6.3.0 [--resume]
 *   批  量: pnpm annotate --batch deck-analysis/data/deck-list.json [--mirror] [--resume]
 *           （8 卡组 + 8×7=56 对局；--mirror 追加 8 个内战对局）
 */

import { existsSync, readFileSync } from "node:fs"
import { getNameSync, staticDecode } from "@gi-tcg/assets-manager"
import { buildDeckInfo, type DeckInfo } from "../deck-info"
import {
  deckPath,
  findPriorThreats,
  initDeckState,
  initMatchupState,
  loadJson,
  loadProgress,
  matchupPath,
  normalizeDeckState,
  normalizeMatchupState,
  saveJson,
  saveProgress,
  validateDeckState,
  validateMatchupState,
  type DeckGroundTruth,
  type MatchupGroundTruth,
  type MatchupPerspective,
} from "../annotate/schema"
import { buildDeckPanel, getInquirer, initStdinKeepAlive, type InqType } from "../annotate/tui"
import { deckSections, matchupSections, resolveCardName, runDashboard, type DashboardContext } from "../annotate/editors"

// ── 解码 ────────────────────────────────────────────────

function decodeDeck(version: string, code: string, nameOverride?: string): DeckInfo {
  const decoded = staticDecode(code)
  const name = (nameOverride && nameOverride.trim()) ||
    decoded.characters.map((id: number) => getNameSync("CHS", id)).filter(Boolean).join("")
  return buildDeckInfo(version, code, name, decoded.characters, decoded.cards)
}

// ── 标注单元 ─────────────────────────────────────────────

interface DeckTask { code: string; name: string }
interface MatchupTask { code: string; name: string; oppCode: string; oppName?: string }

type DashResult = "saved" | "quit" | "prev" | "next"

async function annotateDeckOnce(
  iq: InqType, version: string, task: DeckTask,
  opts: { confirmOverwrite?: boolean; nav?: { prev: boolean; next: boolean }; posText?: string } = {},
): Promise<DashResult | "skip"> {
  const di = decodeDeck(version, task.code, task.name)
  const fp = deckPath(version, task.code)

  const existing = loadJson<DeckGroundTruth>(fp)
  if (existing && opts.confirmOverwrite) {
    console.log(`已有标注: ${fp}`)
    if (!await iq.confirm({ message: "覆盖重新标注？", default: false })) return "skip"
  }
  const state = existing && !opts.confirmOverwrite
    ? normalizeDeckState(existing)
    : initDeckState(version, task.code, di.deckName)

  const ctx: DashboardContext = { iq, myDi: di }
  return (await runDashboard({
    ctx,
    state,
    sections: deckSections(),
    filePath: fp,
    leftTitle: `标注: ${di.deckName}${opts.posText ?? ""}`,
    panels: [{ title: "卡组信息", build: w => buildDeckPanel(di, w) }],
    validate: validateDeckState,
    nav: opts.nav,
  })) as DashResult
}

async function annotateMatchupOnce(
  iq: InqType, version: string, task: MatchupTask,
  opts: { confirmOverwrite?: boolean; nav?: { prev: boolean; next: boolean }; posText?: string } = {},
): Promise<DashResult | "skip"> {
  const diA = decodeDeck(version, task.code, task.name)
  const bCode = task.oppCode || await iq.input({ message: "对手 deck code" })
  const diB = decodeDeck(version, bCode, task.oppName)
  const fp = matchupPath(version, task.code, bCode)

  const existing = loadJson<MatchupGroundTruth>(fp)
  if (existing && opts.confirmOverwrite) {
    console.log(`已有标注: ${fp}`)
    if (!await iq.confirm({ message: "覆盖重新标注？", default: false })) return "skip"
  }
  const state = existing && !opts.confirmOverwrite
    ? normalizeMatchupState(existing)
    : initMatchupState(
        version,
        diA.deckCode, diA.deckName, diB.deckCode, diB.deckName,
        diA.characters.map(c => c.element), diB.characters.map(c => c.element),
      )

  // 双方 L2 标注（对手侧继承用）
  const gtA = loadJson<DeckGroundTruth>(deckPath(version, diA.deckCode))
  const gtB = loadJson<DeckGroundTruth>(deckPath(version, diB.deckCode))
  const stateA = gtA ? normalizeDeckState(gtA) : null
  const stateB = gtB ? normalizeDeckState(gtB) : null

  let cur: "a" | "b" = "a"
  let finalResult: DashResult = "quit"
  while (true) {
    const me = cur === "a" ? diA : diB
    const opp = cur === "a" ? diB : diA
    const myState = cur === "a" ? stateA : stateB
    const oppState = cur === "a" ? stateB : stateA
    void myState
    const pState = state.perspectives[cur]
    applyOpponentInheritance(pState, oppState, opp)
    const other: "a" | "b" = cur === "a" ? "b" : "a"
    const otherMe = cur === "a" ? diB : diA
    const result = await runDashboard({
      ctx: {
        iq, myDi: me, oppDi: opp, oppState,
        priorThreats: findPriorThreats(version, me.deckCode, opp.deckCode),
      },
      state: pState,
      sections: matchupSections(),
      filePath: fp,
      save: () => saveJson(fp, state),
      leftTitle: `对局: ${diA.deckName} vs ${diB.deckName} · ${cur.toUpperCase()} 视角（我方=${me.deckName}）${opts.posText ?? ""}`,
      panels: [
        { title: `A: ${diA.deckName}`, build: w => buildDeckPanel(diA, w) },
        { title: `B: ${diB.deckName}`, build: w => buildDeckPanel(diB, w) },
      ],
      validate: () => validateMatchupState(state),
      nav: opts.nav,
      extraItems: [{ label: () => `── ⇄ 切换到 ${other.toUpperCase()} 视角（我方=${otherMe.deckName}） ──`, indent: 0, value: "switch" }],
    })
    if (result === "switch") { cur = other; continue }
    finalResult = result as DashResult
    // 保存并退出后：若另一视角为空，询问是否继续
    if (result === "saved") {
      const otherEmpty = !state.perspectives[other].overallDirection && state.perspectives[other].threats.length === 0
      if (otherEmpty) {
        const go = await iq.confirm({ message: `继续标注 ${other.toUpperCase()} 视角（我方=${otherMe.deckName}）？`, default: true })
        if (go) { cur = other; continue }
      }
    }
    break
  }
  return finalResult
}

/** 对手特征继承：powerCurve/damageMode 取自对手 L2 标注；threatSummary 用其关键斩杀/增伤件草拟 */
function applyOpponentInheritance(state: MatchupPerspective, oppState: DeckGroundTruth | null, oppDi: DeckInfo): void {
  if (!oppState) return
  const on = state.opponentNotables
  if (!on.powerCurve) on.powerCurve = oppState.powerCurve ?? ""
  if (!on.damageMode) on.damageMode = oppState.damageMode ?? ""
  if (!on.threatSummary) {
    const finishers = [
      ...oppState.keyCards.combo.filter(c => c.role === "combo_finisher"),
      ...oppState.keyCards.damage,
    ]
    const cores = finishers.filter(c => c.importance === "core")
    const names = (cores.length > 0 ? cores : finishers).slice(0, 3).map(c => resolveCardName(oppDi, c.id))
    if (names.length > 0) {
      const type = oppState.deckProfile.primaryType
      on.threatSummary = `${type ? `${type} 体系，` : ""}以${names.join("、")}为核心制胜`
    }
  }
}

// ── 批量会话（标注界面内 ←→ 切换上/下一项） ─────────────────

async function annotateSession<T extends { code: string; name: string }>(
  tasks: T[],
  startIdx: number,
  once: (task: T, nav: { prev: boolean; next: boolean }, posText: string) => Promise<DashResult | "skip">,
): Promise<{ endIdx: number; result: DashResult | "skip" }> {
  let i = startIdx
  let result: DashResult | "skip" = "quit"
  while (i >= 0 && i < tasks.length) {
    const r = await once(tasks[i]!, { prev: i > 0, next: i < tasks.length - 1 }, ` [${i + 1}/${tasks.length}]`)
    result = r
    if (r === "prev") { i--; continue }
    if (r === "next") { i++; continue }
    break
  }
  return { endIdx: Math.max(0, Math.min(i, tasks.length - 1)), result }
}

// ── 单卡组/单对局入口 ─────────────────────────────────────

async function annotateDeck(
  iq: InqType, version: string, deckCode: string,
  deckNameOverride?: string, resume = false,
): Promise<void> {
  const r = await annotateDeckOnce(iq, version, { code: deckCode, name: deckNameOverride ?? "" }, {
    confirmOverwrite: !resume,
  })
  if (r === "quit") {
    console.log(`已自动保存: ${deckPath(version, deckCode)}（每次编辑后自动保存）`)
  }
}

async function annotateMatchup(
  iq: InqType, version: string,
  myCode: string, myNameOverride?: string,
  oppCode?: string, oppNameOverride?: string,
  resume = false,
): Promise<void> {
  const r = await annotateMatchupOnce(iq, version, {
    code: myCode, name: myNameOverride ?? "", oppCode: oppCode ?? "", oppName: oppNameOverride,
  }, { confirmOverwrite: !resume })
  if (r === "quit") {
    console.log(`已自动保存: ${matchupPath(version, myCode, oppCode ?? "")}（每次编辑后自动保存）`)
  }
}

// ── CLI ──────────────────────────────────────────────────

interface CliArgs {
  mode: "deck" | "matchup" | "batch"
  version: string
  resume: boolean
  mirror: boolean
  deckCode?: string
  deckName?: string
  myCode?: string
  oppCode?: string
  batchFile?: string
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const r: CliArgs = { mode: "deck", version: "?", resume: false, mirror: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--deck" || a === "-d") r.deckCode = args[++i]
    else if (a === "--version" || a === "-v") r.version = args[++i]!
    else if (a === "--name" || a === "-n") r.deckName = args[++i]
    else if (a === "--matchup" || a === "-m") { r.mode = "matchup"; r.myCode = args[++i] }
    else if (a === "--opp" || a === "-o") r.oppCode = args[++i]
    else if (a === "--resume" || a === "-r") r.resume = true
    else if (a === "--mirror") r.mirror = true
    else if (a === "--batch" || a === "-b") { r.mode = "batch"; r.batchFile = args[++i] }
    else if (a === "--batch-version") r.version = args[++i]!
  }
  if (r.mode === "batch") {
    if (!r.batchFile) { console.error("批量模式需要 --batch <deck-list.json>"); process.exit(1) }
    if (!existsSync(r.batchFile)) { console.error(`文件不存在: ${r.batchFile}`); process.exit(1) }
    return r
  }
  if (r.mode === "matchup") {
    if (!r.myCode) {
      console.error("对局模式需要 --matchup <myCode> --opp <oppCode>")
      process.exit(1)
    }
    return r
  }
  if (!r.deckCode) {
    console.error("单卡组: pnpm annotate --deck <code> --version v6.3.0 [--name 名称] [--resume]")
    console.error("单对局: pnpm annotate --matchup <myCode> --opp <oppCode> --version v6.3.0 [--resume]")
    console.error("批  量: pnpm annotate --batch deck-analysis/data/deck-list.json [--mirror] [--resume]")
    process.exit(1)
  }
  return r
}

// ── 批量模式 ─────────────────────────────────────────────

interface DeckEntry { code: string; name?: string }
interface Task { type: "deck" | "matchup"; code: string; name: string; oppCode?: string; oppName?: string }

async function runBatch(iq: InqType, cli: CliArgs): Promise<void> {
  const raw = JSON.parse(readFileSync(cli.batchFile!, "utf-8"))
  const decks: DeckEntry[] = raw.decks ?? raw
  const version = cli.version !== "?" ? cli.version : (raw.version ?? "?")

  if (!Array.isArray(decks) || decks.length === 0) {
    console.error("deck-list 中没有找到 decks")
    process.exit(1)
  }

  // 任务列表：全部卡组 + 有序对局对（不含内战；--mirror 追加内战）
  const deckTasks: DeckTask[] = []
  for (const d of decks) {
    if (d?.code) deckTasks.push({ code: d.code, name: d.name ?? d.code.slice(0, 12) })
  }
  const matchupTasks: MatchupTask[] = []
  // 无序对（正反手合并为一份，双方视角在同一任务内标注）
  for (let i = 0; i < decks.length; i++) {
    for (let j = i; j < decks.length; j++) {
      const a = decks[i], b = decks[j]
      if (!a?.code || !b?.code) continue
      if (a.code === b.code && !cli.mirror) continue
      matchupTasks.push({
        code: a.code, name: a.name ?? a.code.slice(0, 12),
        oppCode: b.code, oppName: b.name ?? b.code.slice(0, 12),
      })
    }
  }
  const tasks: Task[] = [
    ...deckTasks.map(t => ({ type: "deck" as const, ...t })),
    ...matchupTasks.map(t => ({ type: "matchup" as const, ...t })),
  ]

  const total = tasks.length
  const progress = loadProgress()
  const progressKey = `${cli.batchFile}${cli.mirror ? "|mirror" : ""}`
  let startIdx = progress[progressKey] ?? 0
  if (cli.resume && startIdx > 0) {
    const input = await iq.input({ message: `从第几项继续？（1-${total}）`, default: String(startIdx + 1) })
    startIdx = Math.max(0, Math.min(total - 1, parseInt(input, 10) - 1 || 0))
  }

  console.log(`批量标注: ${deckTasks.length} 卡组 + ${matchupTasks.length} 对局, 版本 ${version}. Ctrl+C 随时退出（已自动保存）.`)
  console.log("提示：标注界面内 ←→ 可直接切换上/下一套（枚举字段行上 ←→ 为改值）。\n")

  let i = startIdx
  while (i < total) {
    const t = tasks[i]!
    const fp = t.type === "deck" ? deckPath(version, t.code) : matchupPath(version, t.code, t.oppCode!)
    const done = existsSync(fp)

    console.log(`\n${"=".repeat(60)}`)
    const label = t.type === "deck" ? `[卡组] ${t.name}` : `[对局] ${t.name} vs ${t.oppName}`
    console.log(`  [${i + 1}/${total}] ${label}${done ? "（已有标注）" : ""}`)

    if (done && cli.resume) {
      console.log("  已完成，跳过")
      progress[progressKey] = i + 1
      saveProgress(progress)
      i++
      continue
    }

    const action = await iq.select({
      message: "操作",
      choices: [
        { name: `标注${done ? "（覆盖重来）" : ""}`, value: "annotate" },
        ...(done ? [{ name: "跳过（保留已有）", value: "skip" }] : []),
        { name: "退出批量", value: "quit" },
      ],
    })
    if (action === "quit") { console.log("已退出。"); break }
    if (action === "skip") { progress[progressKey] = i + 1; saveProgress(progress); i++; continue }

    if (t.type === "deck") {
      const subIdx = deckTasks.findIndex(x => x.code === t.code)
      const { endIdx } = await annotateSession(deckTasks, Math.max(0, subIdx), (task, nav, posText) =>
        annotateDeckOnce(iq, version, task, { nav, posText }))
      i = endIdx + 1 // 卡组子列表即主列表前段
    } else {
      const subIdx = matchupTasks.findIndex(x => x.code === t.code && x.oppCode === t.oppCode)
      const { endIdx } = await annotateSession(matchupTasks, Math.max(0, subIdx), (task, nav, posText) =>
        annotateMatchupOnce(iq, version, task, { nav, posText }))
      i = deckTasks.length + endIdx + 1
    }

    progress[progressKey] = i
    saveProgress(progress)
  }
  console.log("\n批量标注结束。")
}

// ── 主入口 ───────────────────────────────────────────────

async function main() {
  initStdinKeepAlive()
  const cli = parseArgs()
  const iq = await getInquirer()

  if (cli.mode === "batch") {
    await runBatch(iq, cli)
  } else if (cli.mode === "matchup") {
    await annotateMatchup(iq, cli.version, cli.myCode!, cli.deckName, cli.oppCode, undefined, cli.resume)
  } else {
    await annotateDeck(iq, cli.version, cli.deckCode!, cli.deckName, cli.resume)
  }
}

main().catch(err => {
  // Ctrl+C 中断 inquirer 提示：编辑均已自动保存，安静退出
  if ((err as { name?: string } | null)?.name === "ExitPromptError") {
    console.log("\n已中断（编辑内容已自动保存）。")
    process.exit(0)
  }
  console.error(err)
  process.exit(1)
})
