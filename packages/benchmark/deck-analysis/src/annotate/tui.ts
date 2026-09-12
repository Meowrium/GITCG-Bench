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
 * TUI 基础设施：终端宽度计算（东亚宽字符感知）、卡组信息面板渲染、
 * 仪表盘菜单。
 *
 * 菜单键盘交互由 MenuSession 自带的 data 解析器承担（方向键/jk/Enter/Space/Esc）。
 * stdin 由进程级 keep-alive 维持 raw+流动，inquirer 向导结束后的
 * setRawMode(false)+pause 由 resumeStream/看门狗复位。
 */

import * as readline from "node:readline"
import { ELEMENT_ZH, type DeckInfo } from "../deck-info"

// ── 进程级 stdin 保活 ────────────────────────────────────

let _keepAlive: (() => void) | null = null

/**
 * 让 stdin 在整个进程生命周期内保持 raw+流动：
 * - 常驻一个 no-op data 监听，使 Node 永不停止底层 TTY 读取
 *   （Windows 上"监听归零 → 停止读取 → 模式切换 → 重启读取"的竞态
 *   会导致流假死：isPaused=false 但按键永不派发）
 * - raw 模式只在此处设置一次、退出时恢复；中途不再切换
 */
export function initStdinKeepAlive(): void {
  if (!process.stdin.isTTY || _keepAlive) return
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  const noop = () => { /* 占位，保持读取活跃 */ }
  process.stdin.on("data", noop)
  process.stdin.resume()
  _keepAlive = () => {
    process.stdin.removeListener("data", noop)
    if (process.stdin.setRawMode) process.stdin.setRawMode(false)
    _keepAlive = null
  }
  process.once("exit", () => _keepAlive?.())
}

export type InqType = typeof import("@inquirer/prompts")

let _inquirer: InqType | null = null
export async function getInquirer(): Promise<InqType> {
  if (!_inquirer) {
    try { _inquirer = await import("@inquirer/prompts") }
    catch { console.error("需要 @inquirer/prompts。运行: pnpm install"); process.exit(1) }
  }
  return _inquirer
}

// ── 显示宽度 ─────────────────────────────────────────────

/**
 * 判断字符是否为东亚全宽/宽字符（占 2 列）。
 * 注意：▶▸○✓◆✕▾ 与制表符等符号是 1 宽，不能按"非 ASCII 即 2 宽"处理
 * （旧实现的 bug，导致边框错位）。
 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK 部首、符号
    (cp >= 0x3041 && cp <= 0x33ff) ||   // 平假名/片假名/CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) ||   // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK 扩展 B+
  )
}

/** 字符串显示宽度（东亚宽字符算 2 列，其余算 1 列） */
export function displayWidth(str: string): number {
  let w = 0
  for (let i = 0; i < str.length; i++) {
    w += isWideChar(str.codePointAt(i)!) ? 2 : 1
  }
  return w
}

/** 截断字符串到指定显示宽度（截断符用 "~"：U+2026"…"在中文字体终端按 2 列渲染，会导致边框错位） */
export function truncate(str: string, maxW: number): string {
  let w = 0
  let i = 0
  for (i = 0; i < str.length; i++) {
    const cw = isWideChar(str.codePointAt(i)!) ? 2 : 1
    if (w + cw > maxW) break
    w += cw
  }
  return i < str.length ? str.slice(0, i) + "~" : str
}

/** 填充空格到指定显示宽度 */
export function padDisplay(str: string, targetW: number): string {
  const dw = displayWidth(str)
  if (dw >= targetW) return str
  return str + " ".repeat(targetW - dw)
}

// ── 卡组信息面板 ──────────────────────────────────────────

const SKILL_TYPE_LBL: Record<string, string> = {
  normal: "A", elementalSkill: "E", elementalBurst: "Q", passive: "P",
}

/** 生成卡组信息面板的内容行（已按宽度截断） */
export function buildDeckPanel(di: DeckInfo, w: number): string[] {
  const lines: string[] = []

  lines.push(truncate(`卡组: ${di.deckName}`, w))
  lines.push(truncate(`版本: ${di.version}  Deck: ${di.deckCode.slice(0, 20)}…`, w))
  lines.push("")

  for (const ch of di.characters) {
    const el = ELEMENT_ZH[ch.element] ?? ch.element
    lines.push(truncate(`◆ ${ch.name} [${el}] HP:${ch.hp} 充能:${ch.energy}`, w))
    for (const sk of ch.skills) {
      const lbl = SKILL_TYPE_LBL[sk.type] ?? sk.type
      const cost = sk.cost ? `[${sk.cost}]` : ""
      lines.push(truncate(`  ${lbl} ${sk.name} ${cost}`, w))
    }
  }

  lines.push("")
  lines.push(truncate(`─ 行动牌 (${di.cards.length}种) ─`, w))
  const typeLbl: Record<string, string> = { equipment: "装备", event: "事件", support: "支援" }
  const groups: Record<string, typeof di.cards> = { equipment: [], event: [], support: [] }
  for (const c of di.cards) (groups[c.type] ??= []).push(c)
  for (const [type, cards] of Object.entries(groups)) {
    if (!cards.length) continue
    lines.push(truncate(`  [${typeLbl[type] ?? type}] (${cards.length}种)`, w))
    for (const c of cards) {
      const cost = c.cost && c.cost !== "?" ? `[${c.cost}]` : "[?]"
      lines.push(truncate(`    ${cost} ${c.name}`, w))
    }
  }
  return lines
}

// ── 非 TTY 回退：持久行读取器 ──────────────────────────────

let _lineQueue: string[] | null = null
let _lineWaiter: ((line: string) => void) | null = null

function initLineReader(): void {
  if (_lineQueue) return
  _lineQueue = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })
  rl.on("line", line => {
    if (_lineWaiter) {
      const w = _lineWaiter
      _lineWaiter = null
      w(line.trim())
    } else {
      _lineQueue!.push(line.trim())
    }
  })
  rl.on("close", () => {
    if (_lineWaiter) {
      const w = _lineWaiter
      _lineWaiter = null
      w("") // EOF：不挂起
    }
  })
}

function askLine(question: string): Promise<string> {
  initLineReader()
  process.stdout.write(question)
  if (_lineQueue!.length > 0) {
    return Promise.resolve(_lineQueue!.shift()!)
  }
  return new Promise(resolve => { _lineWaiter = resolve })
}

// ── 仪表盘菜单 ────────────────────────────────────────────

export interface MenuItem {
  /** 懒求值标签：每次渲染重新计算，反映最新状态 */
  label: () => string
  indent: number
  /** Enter 自定义处理（展开/编辑/向导）；设置后不再作为普通选项解析 */
  onEnter?: () => void | Promise<void>
  /** ←/→ 循环改值（枚举/布尔/数值） */
  onCycle?: (dir: 1 | -1) => void
  /** Space 勾选（布尔/多选） */
  onToggle?: () => void
  /** 普通选项值（仅 "save" / "quit" 等终态项使用） */
  value?: string
}

export interface ColumnSpec {
  title: string
  /** 内容行（会被截断/填充到列宽） */
  lines: string[]
  width: number
}

/** 选中行高亮样式（青色；ANSI 转义码零显示宽度） */
const SELECTED_STYLE = "\x1b[36m"
const ANSI_RESET = "\x1b[0m"

/**
 * 渲染多栏框架（1-3 栏）。第一栏通常是操作菜单（带 ▶ 光标，selected=-1 时无光标），
 * 其余栏为信息面板。
 */
export function renderColumns(cols: ColumnSpec[], selected: number, menuItemCount: number): void {
  const border = (l: string, m: string, r: string) =>
    l + cols.map(c => "─".repeat(c.width + 2)).join(m) + r

  const lines: string[] = []
  lines.push(border("┌", "┬", "┐"))
  lines.push("│" + cols.map(c => ` ${padDisplay(truncate(c.title, c.width), c.width)} `).join("│") + "│")
  lines.push(border("├", "┼", "┤"))
  const maxLen = Math.max(...cols.map(c => c.lines.length))
  for (let i = 0; i < maxLen; i++) {
    const cells = cols.map((c, ci) => {
      let content = c.lines[i] ?? ""
      // 第一栏为菜单：注入选择光标
      if (ci === 0 && i < menuItemCount) {
        content = `${i === selected ? "▶" : " "} ${content}`
      } else if (ci === 0) {
        content = `  ${content}`
      }
      const padded = ` ${padDisplay(truncate(content, c.width), c.width)} `
      // 选中行整行高亮（颜色码在宽度计算之后注入，不影响对齐）
      if (ci === 0 && i === selected) return `${SELECTED_STYLE}${padded}${ANSI_RESET}`
      return padded
    })
    lines.push("│" + cells.join("│") + "│")
  }
  lines.push(border("└", "┴", "┘"))

  console.clear()
  process.stdout.write(lines.join("\n") + "\n")
}

/**
 * 持久菜单会话：整个标注会话只挂载一次键盘监听。
 * 条目通过 getItems 动态获取（懒标签），编辑/展开均原位发生；
 * 仅异步向导（inquirer 提示序列）期间挂起键盘响应。
 *
 * 注意：键盘事件由自带的 'data' 解析器解码（而非 readline.emitKeypressEvents）。
 * inquirer 向导结束时会拆除共享的 keypress 解码器并暂停 stdin，
 * 曾导致向导返回后菜单完全收不到按键；自有解析器不受其影响。
 */
export class MenuSession {
  private active = false
  private busy = false
  private getItems: () => MenuItem[] = () => []
  private renderFrame: (selected: number) => void = () => {}
  private selected = 0
  private resolver: ((value: string) => void) | null = null
  private attached = false
  /** 转义序列跨 chunk 时的残留字节 */
  private pending = ""

  /** Esc/q 拦截：返回 true 表示已消费（如收起展开项），否则解析为 "quit" */
  onEscapeRequest: (() => boolean) | null = null

  /** ←→ 切换上/下一项标注对象（由 runDashboard 按批次上下文设置；仅非改值行生效） */
  navEnabled = { prev: false, next: false }

  /** 看门狗：第三方（inquirer 的 readline 收尾）会把 stdin 暂停/切回 cooked，定期自愈 */
  private watchdog: NodeJS.Timeout | null = null

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (!this.active) return
      try {
        if (process.stdin.setRawMode && !process.stdin.isRaw) process.stdin.setRawMode(true)
        if (process.stdin.isPaused()) process.stdin.resume()
      } catch { /* 流状态竞争，下轮再试 */ }
    }, 250)
    this.watchdog.unref() // 不作为维持进程存活的依据
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  private onData = (chunk: Buffer): void => {
    if (!this.active) { this.pending = ""; return } // 向导运行期间：丢弃（inquirer 自己解码）
    const s = this.pending + chunk.toString("utf8")
    let i = 0
    while (i < s.length) {
      const ch = s[i]!
      if (ch === "\x1b") {
        const rest = s.slice(i, i + 3)
        if (rest.length < 3 && (rest === "\x1b" || rest === "\x1b[")) break // 序列未收全，等下一块
        if (rest === "\x1b[A") { this.key("up"); i += 3 }
        else if (rest === "\x1b[B") { this.key("down"); i += 3 }
        else if (rest === "\x1b[C") { this.key("right"); i += 3 }
        else if (rest === "\x1b[D") { this.key("left"); i += 3 }
        else if (rest[1] === "[") { i += 3 } // 其他 CSI 序列（功能键等）：忽略
        else { this.key("escape"); i += 1 } // 单独 Esc
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\n" && s[i - 1] === "\r") { i++; continue } // \r\n 只算一次 Enter
        this.key("return"); i++
      } else if (ch === " ") {
        this.key("space"); i++
      } else if (ch === "\x03") {
        this.detach()
        process.exit(0)
      } else if (ch === "j") {
        this.key("down"); i++
      } else if (ch === "k") {
        this.key("up"); i++
      } else if (ch === "q") {
        this.key("q"); i++
      } else {
        i++ // 其他字符（含 CJK）：忽略
      }
    }
    this.pending = s.slice(i)
  }

  private key(name: string): void {
    void this.onKey(name)
  }

  private async onKey(name: string): Promise<void> {
    if (!this.active || this.busy) return
    const items = this.getItems()
    if (items.length === 0) return
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1))
    const item = items[this.selected]!

    switch (name) {
      case "up":
        this.selected = (this.selected - 1 + items.length) % items.length
        this.renderFrame(this.selected)
        break
      case "down":
        this.selected = (this.selected + 1) % items.length
        this.renderFrame(this.selected)
        break
      case "left":
        if (item.onCycle) { item.onCycle(-1); this.renderFrame(this.selected) }
        else if (this.navEnabled.prev) { this.active = false; this.resolver?.("nav:prev") }
        break
      case "right":
        if (item.onCycle) { item.onCycle(1); this.renderFrame(this.selected) }
        else if (this.navEnabled.next) { this.active = false; this.resolver?.("nav:next") }
        break
      case "space":
        if (item.onToggle) { item.onToggle(); this.renderFrame(this.selected) }
        break
      case "return":
        if (item.onEnter) {
          this.busy = true
          this.active = false
          try {
            await item.onEnter()
          } catch (err) {
            if ((err as { name?: string } | null)?.name === "ExitPromptError") {
              this.detach()
              process.exit(0)
            }
            console.error(err)
          }
          this.resumeStream()
          this.active = true
          this.busy = false
          this.renderFrame(this.selected)
        } else if (item.value) {
          this.active = false
          this.resolver?.(item.value)
        }
        break
      case "escape":
      case "q":
        if (this.onEscapeRequest?.()) {
          this.renderFrame(this.selected)
          break
        }
        this.active = false
        this.resolver?.("quit")
        break
    }
  }

  attach(): void {
    if (this.attached || !process.stdin.isTTY) return
    this.attached = true
    this.resumeStream()
    process.stdin.on("data", this.onData)
    this.startWatchdog()
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.active = false
    this.pending = ""
    this.stopWatchdog()
    process.stdin.removeListener("data", this.onData)
    // 注意：不恢复 raw、不 pause —— 由进程级 keep-alive 维持流状态，
    // 避免 Windows 上"停止读取 + 模式切换"的重启竞态
  }

  /**
   * 每次回到菜单前恢复输入状态：
   * - inquirer 的 readline 关闭时会强制 setRawMode(false)（cooked 模式会行缓冲按键）
   * - inquirer 提示结束后会把 stdin 置为暂停
   */
  resumeStream(): void {
    if (!process.stdin.isTTY) return
    if (process.stdin.setRawMode) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.ref()
  }

  /**
   * 显示菜单并等待终态选择（"save"/"quit"）。
   * 菜单全程存活：导航、展开、原位编辑都在内部处理，不会反复进出。
   */
  showMenu(getItems: () => MenuItem[], render: (selected: number) => void): Promise<string> {
    this.getItems = getItems
    this.renderFrame = render
    this.selected = 0
    render(0)
    this.active = true
    return new Promise(resolve => { this.resolver = resolve })
  }
}

// ── 非 TTY 回退 ──────────────────────────────────────────

/** 非 TTY 数字输入菜单：渲染框架后读取序号，返回选中的条目 */
export async function fallbackMenu(items: MenuItem[], render: () => void): Promise<MenuItem | null> {
  render()
  for (let i = 0; i < items.length; i++) {
    const indent = items[i]!.indent > 0 ? "  " : ""
    process.stdout.write(` ${i + 1}. ${indent}${items[i]!.label()}\n`)
  }
  const input = await askLine("输入序号: ")
  const idx = parseInt(input, 10) - 1
  if (idx >= 0 && idx < items.length) return items[idx]!
  return null
}
