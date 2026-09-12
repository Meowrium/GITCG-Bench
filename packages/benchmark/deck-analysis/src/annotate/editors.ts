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
 * 标注分区编辑器与仪表盘主循环。
 *
 * 两种模式共用同一套 SectionDef 框架：
 *   - 卡组模式（L2）：卡组画像/关键卡牌/出伤与节奏/韧性/开局决策树/弃权
 *   - 对局模式（L3）：对手特征/威胁与应对/反应控制权/节奏偏移/窗口变形/
 *     职能重分配/先后手/综合评估/弃权
 *
 * 交互模型（原位编辑）：
 *   - 表单分区：Enter 展开后字段显示在大类下方；枚举用 ←→/Enter 循环切换，
 *     布尔用 Space/Enter 勾选，多选展开选项子行用 Space 勾选；
 *     自由文本按 Enter 后在界面下方临时输入。
 *   - 列表分区：Enter 展开条目，"＋添加"/条目编辑为界面下方的 inquirer 向导。
 */

import { ELEMENT_ZH, type DeckInfo } from "../deck-info"
import {
  buildPriorKeyCardIndex,
  KEY_CARD_GROUPS,
  saveJson,
  type Abstention,
  type DeckGroundTruth,
  type KeyCard,
  type KeyCardGroup,
  type MatchupPerspective,
  type MatchupThreat,
  type OpeningSequence,
  type PriorKeyCardEntry,
  type PriorThreat,
  type RoleShift,
} from "./schema"
import {
  fallbackMenu,
  MenuSession,
  renderColumns,
  truncate,
  type ColumnSpec,
  type InqType,
  type MenuItem,
} from "./tui"

// ── 框架 ────────────────────────────────────────────────

export interface DashboardContext {
  iq: InqType
  myDi: DeckInfo
  oppDi?: DeckInfo
  /** 对手卡组的 L2 ground truth（对手特征继承 + 威胁来源候选） */
  oppState?: DeckGroundTruth | null
  /** 同对手已标威胁（跨对局继承） */
  priorThreats?: PriorThreat[]
}

export interface FieldOption {
  label: () => string
  onToggle: () => void
}

/** 表单分区的一个字段（原位编辑） */
export interface FieldDef {
  id: string
  label: () => string
  /** 枚举/布尔：←→ 循环 */
  onCycle?: (dir: 1 | -1) => void
  /** 布尔/多选子项：Space 勾选 */
  onToggle?: () => void
  /** 文本：Enter 后在界面下方输入 */
  onEnter?: () => void | Promise<void>
  /** 多选：Enter 展开/收起选项子行 */
  expandable?: () => FieldOption[]
}

export interface SectionDef<S> {
  key: string
  label: string
  /** 状态标记："✓" | "△" | "○" | "" */
  status: (s: S) => string
  /** 收起时标题行后的单行摘要 */
  summary?: (s: S) => string
  /** 列表分区：条目摘要行（用于标题计数与 resume 展开判断） */
  items?: (s: S, ctx: DashboardContext) => string[]
  /** 表单分区：字段定义 */
  fields?: (s: S, ctx: DashboardContext) => FieldDef[]
  /**
   * 自定义展开行（覆盖默认的 fields/items 展开逻辑）。
   * 用于分组树形结构（如关键卡牌按组展开、组内独立添加）。
   */
  rows?: (s: S, ctx: DashboardContext, ui: { expandedField: string | null }, save: () => void) => MenuItem[]
  /** 列表分区：添加 */
  onAdd?: (ctx: DashboardContext, s: S) => Promise<void>
  /** 列表分区：编辑第 idx 条 */
  onItem?: (ctx: DashboardContext, s: S, idx: number) => Promise<void>
}

// ── 字段工厂 ─────────────────────────────────────────────

function toggleIn(arr: string[], v: string): void {
  const i = arr.indexOf(v)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(v)
}

function enumField(
  id: string, label: string,
  get: () => string | undefined, set: (v: string) => void,
  options: readonly string[],
  scope?: Record<string, string>,
): FieldDef {
  return {
    id,
    label: () => `${label}: ${get() ? zh(get(), scope) : "？"}`,
    onCycle: dir => {
      const cur = options.indexOf(get() ?? "")
      const next = cur === -1
        ? (dir === 1 ? 0 : options.length - 1)
        : (cur + dir + options.length) % options.length
      set(options[next]!)
    },
  }
}

function boolField(
  id: string, label: string,
  get: () => boolean, set: (v: boolean) => void,
): FieldDef {
  return {
    id,
    label: () => `${label}: ${get() ? "✓ 是" : "✗ 否"}`,
    onCycle: () => set(!get()),
    onToggle: () => set(!get()),
  }
}

function textField(
  id: string, label: string,
  get: () => string, set: (v: string) => void,
  iq: InqType, message?: string,
): FieldDef {
  return {
    id,
    label: () => `${label}: ${truncate(get() || "（空）", 14)}`,
    onEnter: async () => {
      set(await iq.input({ message: message ?? label, default: get() }))
    },
  }
}

/** 逗号分隔的字符串列表文本字段 */
function listTextField(
  id: string, label: string,
  get: () => string[], set: (v: string[]) => void,
  iq: InqType,
): FieldDef {
  return textField(
    id, label,
    () => get().join(", "),
    v => set(v.split(",").map(s => s.trim()).filter(Boolean)),
    iq, `${label}（逗号分隔）`,
  )
}

function multiField(
  id: string, label: string,
  get: () => string[],
  options: readonly string[],
): FieldDef {
  return {
    id,
    label: () => `${label}: ${get().length ? get().map(v => zh(v)).join(",") : "（无）"}`,
    expandable: () => options.map(o => ({
      label: () => `${get().includes(o) ? "☑" : "☐"} ${zh(o)}`,
      onToggle: () => toggleIn(get(), o),
    })),
  }
}

// ── 枚举常量 ─────────────────────────────────────────────

const MTG_TYPES = ["aggro", "midrange", "combo", "control", "tempo"]
const TEMPOS = ["fast", "medium", "slow"]
const STARTUPS = ["turn1", "turn2~3", "turn4", ">=turn5"]
const DAMAGE_MODES = ["reaction_chain", "summon_swarm", "single_burst", "chip", "raw"]
const POWER_CURVES = ["frontloaded", "steady", "backloaded", "spiky"]
const SETUP_DEPS = ["low", "medium", "high"]
const VULNERABLE_TO = ["frontloaded_burst", "summon_swarm", "reaction_chain", "chip"]
const RC_ADVS = ["me", "opponent", "even"]
const TEMPO_SHIFTS = ["accelerate", "maintain_early_pressure", "slow_down", "disrupt_their_rhythm", "no_shift"]
const WINDOW_ADJS = ["prioritize_first_kill", "delay_for_better_setup", "skip_opening_setup", "same_as_isolated"]
const ADVANTAGES = ["faster_combo", "better_sustain", "more_disruption", "resource_lead", "tempo_advantage"]
const STRATEGIES = ["race", "disrupt", "outlast", "build_value"]
const DIRECTIONS = ["heavilyFavored", "slightlyFavored", "even", "slightlyUnfavored", "heavilyUnfavored"]

// ── 枚举值中文名 ─────────────────────────────────────────
// 仅标注 TUI 显示用；写入 ground truth JSON 的仍是英文原值。

const VALUE_ZH: Record<string, string> = {
  // tempo / setupDependency
  fast: "快", medium: "中", slow: "慢", low: "低", high: "高",
  // startupSpeed
  turn1: "1回合启动", "turn2~3": "2-3回合启动", turn4: "4回合启动", ">=turn5": "5+回合启动",
  // damageMode / vulnerableTo
  reaction_chain: "反应链", summon_swarm: "召唤物群", single_burst: "单体爆发",
  chip: "高频小额", raw: "纯面板",
  // powerCurve
  frontloaded: "前期集中", steady: "平稳", backloaded: "后期跃升", spiky: "峰谷明显",
  frontloaded_burst: "前期爆发",
  // 威胁
  lethal: "斩杀", disrupting: "控制链", grinding: "消耗战", ramping: "滚雪球",
  early: "前期", mid: "中期", late: "后期",
  // 反应控制权 / 整体优劣
  me: "我方", opponent: "对手", even: "均势",
  // 节奏偏移
  accelerate: "加速", maintain_early_pressure: "保持前期压力", slow_down: "放慢",
  disrupt_their_rhythm: "干扰对手节奏", no_shift: "不变",
  // 窗口调整
  prioritize_first_kill: "优先首杀", delay_for_better_setup: "等待更好时机",
  skip_opening_setup: "跳过铺场", same_as_isolated: "与孤立时相同",
  // 优势
  faster_combo: "连招更快", better_sustain: "生存更强", more_disruption: "干扰更多",
  resource_lead: "资源领先", tempo_advantage: "节奏优势",
  // 推荐策略
  race: "竞速", disrupt: "干扰启动", outlast: "拼消耗", build_value: "蓄爆",
  // 整体优劣
  heavilyFavored: "大优", slightlyFavored: "小优",
  slightlyUnfavored: "小劣", heavilyUnfavored: "大劣",
  // 关键卡牌组/角色/重要性
  combo: "连招", damage: "增伤", draw: "过牌", sustain: "生存", disruption: "干扰", ramp: "蓄爆", flex: "灵活位",
  combo_starter: "连招起点", combo_field: "铺场", combo_bridge: "衔接", combo_finisher: "连招终点",
  damage_amplifier: "增伤", flex_slot: "灵活位",
  core: "核心", important: "重要", flexible: "可替换",
  // 伤害类型
  vaporize: "蒸发", melt: "融化", overload: "超载", electrocharge: "感电",
  freeze: "冻结", superconduct: "超导", swirl: "扩散", burning: "燃烧",
  bloom: "绽放", aggravate: "超激化", spread: "蔓激化", other: "其他",
}

/** 显示用翻译：有中文名返回 "英文（中文）"，否则原样；空值返回空串。scope 可覆盖同名值 */
function zh(v: string | undefined, scope?: Record<string, string>): string {
  if (!v) return ""
  const z = scope?.[v] ?? VALUE_ZH[v]
  return z ? `${v}（${z}）` : v
}

/** 仅中文名（空间紧张的列表行用）；无翻译则原样 */
function zhOnly(v: string | undefined, scope?: Record<string, string>): string {
  if (!v) return ""
  return scope?.[v] ?? VALUE_ZH[v] ?? v
}

/** 主副类型（MTG 分类）语境下的翻译；combo 与关键组件组的 combo（连招）区分 */
const ZH_ARCHETYPE: Record<string, string> = {
  aggro: "快攻", midrange: "中速", combo: "组合技", control: "控制", tempo: "节奏",
}

// ── 菜单构建 ─────────────────────────────────────────────

interface UiState {
  expanded: Set<string>
  expandOrder: string[]
  expandedField: string | null
}

function toggleSection(ui: UiState, key: string): void {
  if (ui.expanded.has(key)) {
    ui.expanded.delete(key)
    ui.expandOrder = ui.expandOrder.filter(k => k !== key)
  } else {
    ui.expanded.add(key)
    ui.expandOrder.push(key)
  }
}

function buildMenuItems<S>(
  sections: SectionDef<S>[], state: S, ui: UiState,
  ctx: DashboardContext, save: () => void,
  nav?: { prev: boolean; next: boolean },
  extraItems?: MenuItem[],
): MenuItem[] {
  const items: MenuItem[] = []
  for (const sec of sections) {
    const isOpen = ui.expanded.has(sec.key)
    const st = sec.status(state)
    const sum = sec.summary?.(state)

    if (sec.fields) {
      // 表单分区：展开后字段显示在大类下方，原位编辑
      items.push({
        label: () => `${isOpen ? "▾" : "▸"} ${sec.label} ${st}${!isOpen && sum ? `  ${sum}` : ""}`,
        indent: 0,
        onEnter: () => toggleSection(ui, sec.key),
      })
      if (isOpen) {
        for (const f of sec.fields(state, ctx)) {
          const fieldOpen = ui.expandedField === f.id
          items.push({
            label: () => `${f.expandable ? (fieldOpen ? "▾ " : "▸ ") : "  "}${f.label()}`,
            indent: 1,
            onCycle: f.onCycle ? dir => { f.onCycle!(dir); save() } : undefined,
            onToggle: f.onToggle ? () => { f.onToggle!(); save() } : undefined,
            onEnter: f.expandable
              ? () => { ui.expandedField = fieldOpen ? null : f.id }
              : f.onEnter
                ? async () => { await f.onEnter!(); save() }
                : f.onCycle
                  ? () => { f.onCycle!(1); save() }
                  : f.onToggle
                    ? () => { f.onToggle!(); save() }
                    : undefined,
          })
          if (f.expandable && fieldOpen) {
            for (const o of f.expandable!()) {
              items.push({
                label: o.label,
                indent: 2,
                onToggle: () => { o.onToggle(); save() },
              })
            }
          }
        }
      }
    } else {
      // 列表分区：条目 + 添加（向导在界面下方进行）；有 rows 钩子则用自定义展开行
      const rows = sec.items?.(state, ctx) ?? []
      items.push({
        label: () => `${isOpen ? "▾" : "▸"} ${sec.label} (${rows.length}) ${st}`,
        indent: 0,
        onEnter: () => toggleSection(ui, sec.key),
      })
      if (isOpen) {
        if (sec.rows) {
          items.push(...sec.rows(state, ctx, ui, save))
        } else {
          rows.forEach((r, i) => items.push({
            label: () => r,
            indent: 1,
            onEnter: sec.onItem ? async () => { await sec.onItem!(ctx, state, i); save() } : undefined,
          }))
          items.push({
            label: () => "＋ 添加",
            indent: 1,
            onEnter: sec.onAdd ? async () => { await sec.onAdd!(ctx, state); save() } : undefined,
          })
        }
      }
    }
  }
  if (nav?.prev) items.push({ label: () => "── ← 上一卡组 ──", indent: 0, value: "nav:prev" })
  if (nav?.next) items.push({ label: () => "── 下一卡组 → ──", indent: 0, value: "nav:next" })
  if (extraItems?.length) items.push(...extraItems)
  items.push({ label: () => "── 保存并退出 ──", indent: 0, value: "save" })
  items.push({ label: () => "── 退出 ──", indent: 0, value: "quit" })
  return items
}

export interface RunDashboardOpts<S> {
  ctx: DashboardContext
  state: S
  sections: SectionDef<S>[]
  filePath: string
  leftTitle: string
  /** 右栏信息面板（build 接收可用宽度）：卡组模式 1 个、对局模式 2 个 */
  panels: { title: string; build: (w: number) => string[] }[]
  validate?: (s: S) => string[]
  /** 批次内可前后切换时提供：非改值行 ←→ 切换上/下一项，并显示导航菜单行 */
  nav?: { prev: boolean; next: boolean }
  /** 自定义保存逻辑（默认直接序列化 state 到 filePath；对局双视角需整体落盘） */
  save?: () => void
  /** 附加菜单行（插到保存/退出之前；value 透传为 runDashboard 返回值） */
  extraItems?: MenuItem[]
}

const HINT = " ↑↓ 导航 · Enter 展开/确认 · ←→ 改值 · Space 勾选 · Esc/q 收起/退出"

/**
 * 仪表盘主循环。每次编辑操作后自动保存（防 Ctrl+C 丢数据）；
 * "保存并退出"额外打印路径与校验告警。
 */
export async function runDashboard<S>(opts: RunDashboardOpts<S>): Promise<string> {
  const { ctx, state, sections } = opts
  const ui: UiState = { expanded: new Set(), expandOrder: [], expandedField: null }
  // resume：已有内容的分区默认展开
  for (const sec of sections) {
    if (sec.items && sec.items(state, ctx).length > 0) ui.expanded.add(sec.key)
    if (sec.fields && sec.status(state) !== "○") ui.expanded.add(sec.key)
  }
  ui.expandOrder = [...ui.expanded]

  const save = opts.save ?? (() => saveJson(opts.filePath, state))
  const getItems = () => buildMenuItems(sections, state, ui, ctx, save, opts.nav, opts.extraItems)

  const computeColumns = (items: MenuItem[]): ColumnSpec[] => {
    const termW = process.stdout.columns || 100
    const nPanels = opts.panels.length
    const overhead = (nPanels + 1) * 3 + 1 // 边框与间隔
    const menuW = nPanels === 1
      ? Math.min(44, Math.floor((termW - overhead) * 0.42))
      : Math.min(36, Math.floor((termW - overhead) * 0.32))
    const panelW = Math.max(24, Math.floor((termW - overhead - menuW) / nPanels))
    const menuLines = items.map(it => `${it.indent > 0 ? "  " : ""}${it.label()}`)
    return [
      { title: opts.leftTitle, lines: menuLines, width: menuW },
      ...opts.panels.map(p => ({ title: p.title, lines: p.build(panelW), width: panelW })),
    ]
  }

  const finish = (value: string): string | null => {
    if (value === "save") {
      save()
      console.log(`已保存: ${opts.filePath}`)
      for (const w of opts.validate?.(state) ?? []) {
        console.log(`  ⚠ ${w}`)
      }
      return "saved"
    }
    if (value === "quit") {
      // 退出同样落盘：与"每次编辑后自动保存"的语义保持一致
      save()
      return "quit"
    }
    if (value === "nav:prev" && opts.nav?.prev) { save(); return "prev" }
    if (value === "nav:next" && opts.nav?.next) { save(); return "next" }
    if (value) { save(); return value } // 自定义值（extraItems）透传
    return null
  }

  const hint = opts.nav ? HINT.replace("←→ 改值", "←→ 改值/换卡组") : HINT

  // 非 TTY 回退：数字输入（枚举项回车 = 切换下一值）
  if (!process.stdin.isTTY) {
    while (true) {
      const items = getItems()
      const cols = computeColumns(items)
      const picked = await fallbackMenu(items, () => {
        renderColumns(cols, -1, items.length)
        process.stdout.write(`${hint}\n（非 TTY：输入序号）\n`)
      })
      if (!picked) continue
      if (picked.onEnter) await picked.onEnter()
      else if (picked.onCycle) { picked.onCycle(1); save() }
      else if (picked.onToggle) { picked.onToggle(); save() }
      else if (picked.value) {
        const r = finish(picked.value)
        if (r) return r
      }
    }
  }

  const session = new MenuSession()
  // Esc/q 逐层收起：多选子行 → 最近展开的分区 → 退出
  session.onEscapeRequest = () => {
    if (ui.expandedField) { ui.expandedField = null; return true }
    const last = ui.expandOrder.pop()
    if (last) { ui.expanded.delete(last); return true }
    return false
  }
  session.attach()
  try {
    while (true) {
      session.resumeStream() // inquirer 编辑器结束后恢复输入状态
      session.navEnabled = { prev: !!opts.nav?.prev, next: !!opts.nav?.next }
      const value = await session.showMenu(getItems, sel => {
        const items = getItems()
        renderColumns(computeColumns(items), sel, items.length)
        process.stdout.write(hint + "\n")
      })
      const r = finish(value)
      if (r) return r
    }
  } finally {
    session.detach()
  }
}

// ── 公共选择器 ───────────────────────────────────────────

const SKILL_TYPE_LBL: Record<string, string> = {
  normal: "A", elementalSkill: "E", elementalBurst: "Q", passive: "P",
}

interface CardChoice { id: number; label: string; description: string }

function buildCardChoices(di: DeckInfo): CardChoice[] {
  const choices: CardChoice[] = []
  for (const ch of di.characters) {
    choices.push({ id: ch.definitionId, label: `[角色] ${ch.name}`, description: `HP:${ch.hp} 充能:${ch.energy}` })
  }
  for (const c of di.cards) {
    const cost = c.cost && c.cost !== "?" ? `[${c.cost}]` : ""
    choices.push({
      id: c.definitionId,
      label: `[${c.type}] ${cost} ${c.name.replace(/ ×\d+$/, "")}`,
      description: truncate(c.description, 120),
    })
  }
  return choices
}

interface ActionOption { label: string; action: string; cost: string; description: string }

/** 行动菜单：全部角色技能 + 切人 + 全部行动牌（不再截断）+ 调和/结束 */
function buildActionMenu(di: DeckInfo): ActionOption[] {
  const items: ActionOption[] = []
  for (const ch of di.characters) {
    const el = ELEMENT_ZH[ch.element] ?? ch.element
    for (const sk of ch.skills) {
      const t = SKILL_TYPE_LBL[sk.type] ?? sk.type
      const cost = sk.cost || `3${el}`
      items.push({
        label: `${ch.name} ${t} ${sk.name}  [${cost}]`,
        action: `${ch.name} ${sk.name}`,
        cost,
        description: truncate(sk.description, 120),
      })
    }
    if (ch.skills.length === 0) {
      items.push({ label: `${ch.name} A(普攻)`, action: `${ch.name} A`, cost: `3${el}`, description: "普通攻击" })
      items.push({ label: `${ch.name} E(战技)`, action: `${ch.name} E`, cost: `3${el}`, description: "元素战技" })
      items.push({ label: `${ch.name} Q(爆发)`, action: `${ch.name} Q`, cost: `3${el}+${ch.energy}能`, description: "元素爆发" })
    }
  }
  for (const ch of di.characters) {
    items.push({ label: `切换到 ${ch.name}`, action: `切${ch.name}`, cost: "1任意", description: "出战角色切换" })
  }
  for (const c of di.cards) {
    const cost = c.cost && c.cost !== "?" ? c.cost : "?"
    items.push({
      label: `[${cost}] ${c.name}`,
      action: c.name.replace(/ ×\d+$/, ""),
      cost,
      description: truncate(c.description, 120),
    })
  }
  items.push({ label: "元素调和（弃牌转骰子）", action: "调和", cost: "0", description: "弃1手牌 → 转1任意骰" })
  items.push({ label: "宣告结束", action: "结束", cost: "0", description: "结束当前回合" })
  return items
}

async function pickAction(iq: InqType, di: DeckInfo, menu: ActionOption[]): Promise<EditStep | null> {
  const sel = await iq.select({
    message: "选择操作",
    choices: [
      { name: "蓄爆（泛指，任意蓄爆类牌填充此步）", value: "__chargeup__", description: "不再细分选牌；如立本/蒂玛乌斯/派蒙等" },
      ...menu.map((m, i) => ({ name: m.label, value: String(i), description: m.description })),
      { name: "取消", value: "cancel", description: undefined as unknown as string },
    ],
    pageSize: 15,
  })
  if (sel === "cancel") return null
  if (sel === "__chargeup__") return { ...CHARGE_UP_STEP }
  const opt = menu[parseInt(sel as string, 10)]
  return opt ? { action: opt.action, cost: opt.cost } : null
}

/** 蓄爆伪步骤（泛指，无细分选择）：该步以任意蓄爆类牌填充 */
const CHARGE_UP_STEP: EditStep = {
  action: "蓄爆",
  cost: "0",
  effectDescription: "投资牌蓄爆：骰子消耗/存储为非技能资源，铺垫后续回合",
}

async function pickPosition(iq: InqType, maxPos: number): Promise<number> {
  const input = await iq.input({ message: `插入位置 (1-${maxPos})`, default: String(maxPos) })
  const pos = parseInt(input, 10)
  return isNaN(pos) ? maxPos - 1 : Math.max(0, Math.min(maxPos - 1, pos - 1))
}

/** 解析费用字符串中的骰子数（不含能量） */
function parseDiceCost(cost: string): number {
  if (!cost || cost === "0") return 0
  return cost.split("+")
    .filter(p => !p.includes("能"))
    .reduce((s, p) => {
      const m = p.match(/\d+/)
      return s + (m ? parseInt(m[0], 10) : 0)
    }, 0)
}

// ── 统一步骤编辑器 ────────────────────────────────────────

export interface EditStep {
  action: string
  cost: string
  effectDescription?: string
}

// ── 速记解析（低代码录入） ─────────────────────────────────

/**
 * 速记语法（分隔符支持 > ; ； ， , →）：
 *   角色技能：角色名片段 + A/E/Q（纯水E、八重Q），或技能全名（纯水幻造）
 *   切人：    切八重 / 切八重神子
 *   卡牌：    卡名或片段（立本、卯师傅）
 *   特殊：    调和 / 结束
 *   战术意义（开局序列）：动作=说明（纯水E=铺场挂水）
 * 歧义（一片段命中多个动作）或未命中 → 就地弹出候选选择
 */
function matchActions(token: string, menu: ActionOption[], di: DeckInfo): ActionOption[] {
  const t = token.replace(/\s+/g, "")
  if (!t) return []
  // 全名精确匹配（调和/结束/卡名/技能全名）
  const exact = menu.filter(m => m.action === t)
  if (exact.length) return exact
  // 切人
  if (t.startsWith("切")) {
    const frag = t.slice(1)
    return menu.filter(m => m.action.startsWith("切") && m.action.includes(frag))
  }
  // 角色名片段 + A/E/Q
  const m = t.match(/^(.+?)([AEQ])$/i)
  if (m) {
    const frag = m[1]!
    const letter = m[2]!.toUpperCase()
    const typeMap: Record<string, string> = { A: "normal", E: "elementalSkill", Q: "elementalBurst" }
    const out: ActionOption[] = []
    for (const ch of di.characters) {
      if (!ch.name.includes(frag)) continue
      for (const sk of ch.skills) {
        if (sk.type !== typeMap[letter]) continue
        const opt = menu.find(o => o.action === `${ch.name} ${sk.name}`)
        if (opt) out.push(opt)
      }
    }
    if (out.length) return out
  }
  // 名称包含（卡名/技能名/角色名片段）
  return menu.filter(m => m.action.includes(t) || m.label.includes(t))
}

async function inputStepsShorthand(iq: InqType, di: DeckInfo, withEffect: boolean): Promise<EditStep[] | null> {
  const hint = withEffect
    ? "速记（如：纯水E=铺场>立本>八重E；留空则逐步添加）"
    : "速记（如：纯水E>立本>八重Q；留空则逐步添加）"
  const line = await iq.input({ message: hint })
  if (!line.trim()) return null
  const menu = buildActionMenu(di)
  const steps: EditStep[] = []
  const tokens = line.split(/[>;；，,→]/).map(t => t.trim()).filter(Boolean)
  for (const tok of tokens) {
    const [actionTok, effect] = tok.split("=").map(x => x.trim())
    if (!actionTok) continue
    // 蓄爆伪行动：泛指一步，无细分选择
    if (actionTok === "蓄爆") {
      const st: EditStep = { ...CHARGE_UP_STEP }
      if (withEffect && effect) st.effectDescription = effect
      steps.push(st)
      continue
    }
    const matched = matchActions(actionTok, menu, di)
    let step: { action: string; cost: string } | null = null
    if (matched.length === 1) {
      step = { action: matched[0]!.action, cost: matched[0]!.cost }
    } else {
      // 未命中或歧义：就地选择
      const pool = matched.length > 1 ? matched : menu
      const sel = await iq.select({
        message: `「${actionTok}」${matched.length > 1 ? "有多个匹配" : "无匹配"}，请选择`,
        choices: [
          ...pool.map((m, i) => ({ name: m.label, value: String(i), description: m.description })),
          { name: "跳过此步", value: "skip", description: undefined as unknown as string },
        ],
        pageSize: 12,
      })
      if (sel === "skip") continue
      const opt = pool[parseInt(sel as string, 10)]
      if (opt) step = { action: opt.action, cost: opt.cost }
    }
    if (step) {
      const st: EditStep = { ...step }
      if (withEffect && effect) st.effectDescription = effect
      steps.push(st)
    }
  }
  return steps
}

/**
 * 智能步骤录入：速记 → 预览确认（可进逐步编辑器微调）；
 * 留空速记则直接进入逐步编辑器。
 */
async function inputStepsSmart(iq: InqType, di: DeckInfo, withEffect: boolean): Promise<EditStep[]> {
  const quick = await inputStepsShorthand(iq, di, withEffect)
  if (quick && quick.length > 0) {
    console.log("解析结果:")
    for (let i = 0; i < quick.length; i++) {
      const st = quick[i]!
      console.log(`  ${i + 1}. ${st.action} [${st.cost}]${st.effectDescription ? ` — ${st.effectDescription}` : ""}`)
    }
    const ok = await iq.confirm({ message: "确认使用该序列（否则进入逐步编辑器微调）？", default: true })
    if (ok) return quick
    return editSteps(iq, di, quick, withEffect)
  }
  return editSteps(iq, di, [], withEffect)
}

/** 步骤编辑器：开局决策树分支的步骤编辑（增/删/改/排序/插位） */
async function editSteps(iq: InqType, di: DeckInfo, existing: EditStep[], withEffect: boolean): Promise<EditStep[]> {
  const steps = existing.map(s => ({ ...s }))
  const menu = buildActionMenu(di)
  while (true) {
    const action = await iq.select({
      message: `步骤 (${steps.length}步)`,
      choices: [
        ...steps.map((s, i) => ({
          name: `[${i + 1}] ${s.action} [${s.cost}]${s.effectDescription ? ` — ${s.effectDescription}` : ""}`,
          value: `edit:${i}`,
        })),
        { name: "[+添加步骤]", value: "add" },
        { name: "[完成]", value: "done" },
      ],
      pageSize: 12,
    })
    if (action === "done") return steps
    if (action === "add") {
      const picked = await pickAction(iq, di, menu)
      if (picked) {
        const insertAt = steps.length === 0 ? 0 : await pickPosition(iq, steps.length + 1)
        const step: EditStep = { ...picked }
        if (withEffect) {
          step.effectDescription = await iq.input({ message: "该步战术意义（≤40字，可空）", default: picked.effectDescription ?? "" })
        }
        steps.splice(insertAt, 0, step)
      }
      continue
    }
    if (action.startsWith("edit:")) {
      const idx = parseInt(action.split(":")[1]!, 10)
      const step = steps[idx]
      if (!step) continue
      const sub = await iq.select({
        message: `步骤 ${idx + 1}: ${step.action} [${step.cost}]`,
        choices: [
          { name: "替换", value: "replace" },
          { name: "在此前插入", value: "insertBefore" },
          ...(withEffect ? [{ name: "修改战术意义", value: "effect" }] : []),
          { name: "上移", value: "up" },
          { name: "下移", value: "down" },
          { name: "删除", value: "delete" },
          { name: "返回", value: "back" },
        ],
      })
      if (sub === "replace") {
        const picked = await pickAction(iq, di, menu)
        if (picked) steps[idx] = { ...picked, effectDescription: step.effectDescription ?? picked.effectDescription }
      } else if (sub === "insertBefore") {
        const picked = await pickAction(iq, di, menu)
        if (picked) {
          const ns: EditStep = { ...picked }
          if (withEffect) ns.effectDescription = await iq.input({ message: "该步战术意义（≤40字，可空）", default: picked.effectDescription ?? "" })
          steps.splice(idx, 0, ns)
        }
      } else if (sub === "effect") {
        step.effectDescription = await iq.input({ message: "战术意义（≤40字）", default: step.effectDescription ?? "" })
      } else if (sub === "up" && idx > 0) {
        [steps[idx - 1], steps[idx]] = [steps[idx]!, steps[idx - 1]!]
      } else if (sub === "down" && idx < steps.length - 1) {
        [steps[idx + 1], steps[idx]] = [steps[idx]!, steps[idx + 1]!]
      } else if (sub === "delete") {
        steps.splice(idx, 1)
      }
    }
  }
}

// ── 卡组级编辑器（列表分区向导） ───────────────────────────

// --- 关键卡牌 ---

export function resolveCardName(di: DeckInfo, id: string): string {
  const name = di.cards.find(x => String(x.definitionId) === id)?.name
    ?? di.characters.find(x => String(x.definitionId) === id)?.name
    ?? id
  return name.replace(/ ×\d+$/, "")
}

function findKeyCard(s: DeckGroundTruth, flatIdx: number): { group: KeyCardGroup; card: KeyCard; realIdx: number } | null {
  let count = 0
  for (const { group } of KEY_CARD_GROUPS) {
    const cards = s.keyCards[group]
    for (let i = 0; i < cards.length; i++) {
      if (count === flatIdx) return { group, card: cards[i]!, realIdx: i }
      count++
    }
  }
  return null
}

/** 关键卡牌分组树：每组一行（Enter 展开该组卡牌 + 组内「＋添加」） */
function keyCardGroupRows(
  s: DeckGroundTruth, ctx: DashboardContext,
  ui: { expandedField: string | null }, save: () => void,
): MenuItem[] {
  const items: MenuItem[] = []
  let flat = 0
  for (const g of KEY_CARD_GROUPS) {
    const cards = s.keyCards[g.group]
    const gKey = `keyCards:${g.group}`
    const open = ui.expandedField === gKey
    items.push({
      label: () => `${open ? "▾" : "▸"} ${g.group}（${g.label}） (${cards.length})`,
      indent: 1,
      onEnter: () => { ui.expandedField = open ? null : gKey },
    })
    if (open) {
      for (const c of cards) {
        const idx = flat
        items.push({
          label: () => `${resolveCardName(ctx.myDi, c.id)}${c.skills?.length ? `（${c.skills.map(x => x.name).join("、")}）` : ""} [${zhOnly(c.role)}·${zhOnly(c.importance)}]`,
          indent: 2,
          onEnter: async () => { await editKeyCardItem(ctx, s, idx); save() },
        })
        flat++
      }
      items.push({
        label: () => "＋ 添加",
        indent: 2,
        onEnter: async () => { await addKeyCard(ctx, s, g.group); save() },
      })
    } else {
      flat += cards.length
    }
  }
  return items
}

async function pickImportance(iq: InqType, def?: string): Promise<KeyCard["importance"]> {
  return await iq.select({
    message: "重要性",
    default: def,
    choices: [
      { name: "core - 不可替代", value: "core" },
      { name: "important - 显著增强可替代", value: "important" },
      { name: "flexible - 可替换", value: "flexible" },
    ],
  }) as KeyCard["importance"]
}

async function pickMulligan(iq: InqType, def?: string): Promise<KeyCard["mulligan"]> {
  return await iq.select({
    message: "留牌优先级",
    default: def,
    choices: [
      { name: "always_keep - 必留", value: "always_keep" },
      { name: "high - 优先保留", value: "high" },
      { name: "situational - 看情况", value: "situational" },
      { name: "never - 不留", value: "never" },
    ],
  }) as KeyCard["mulligan"]
}

/** 在全部组中查找某张卡（跨组继承用） */
function findKeyCardAnywhere(s: DeckGroundTruth, id: string): { group: KeyCardGroup; card: KeyCard } | null {
  for (const { group } of KEY_CARD_GROUPS) {
    const card = s.keyCards[group].find(c => c.id === id)
    if (card) return { group, card }
  }
  return null
}

const MULLIGAN_ZH: Record<string, string> = {
  always_keep: "必留", high: "优先", situational: "看情况", never: "不留",
}

/** 连招组角色选择：覆盖「起点 → 铺场/站场效果 → 衔接 → 终点」的完整链条 */
async function pickComboRole(iq: InqType, def?: string): Promise<KeyCard["role"]> {
  const isComboRole = def?.startsWith("combo_") ? def : undefined
  return await iq.select({
    message: "角色（连招链中的位置）",
    default: isComboRole,
    choices: [
      { name: "combo_starter - 起点：提供前置条件（挂元素/充能启动）", value: "combo_starter" },
      { name: "combo_field - 铺场：产生站场效果供连招联动（召唤物/出战状态）", value: "combo_field" },
      { name: "combo_bridge - 衔接：让链条走通（调度/润滑/找关键件/延长链条）", value: "combo_bridge" },
      { name: "combo_finisher - 终点：前置满足后打出终结伤害", value: "combo_finisher" },
    ],
  }) as KeyCard["role"]
}

async function addKeyCard(ctx: DashboardContext, s: DeckGroundTruth, presetGroup?: KeyCardGroup): Promise<void> {
  const { iq, myDi } = ctx
  const group = presetGroup ?? await iq.select({
    message: "选择分组",
    choices: KEY_CARD_GROUPS.map(g => ({ name: `${g.group} - ${g.label}`, value: g.group })),
  }) as KeyCardGroup
  const groupDef = KEY_CARD_GROUPS.find(g => g.group === group)!
  // 跨卡组已录索引（同版本所有卡组，同组优先、他组兜底）
  const priorIdx = buildPriorKeyCardIndex(myDi.version, myDi.deckCode)
  const pickPrior = (id: string): PriorKeyCardEntry | null => {
    const entries = priorIdx.get(id)
    if (!entries?.length) return null
    return entries.find(e => e.group === group) ?? entries[0]!
  }
  // 第一步：批量勾选要录入的卡牌（标注他卡组已录分组）
  const picks = await iq.checkbox({
    message: `${group}（${groupDef.label}）：勾选要录入的卡牌（空格多选，回车确认）`,
    choices: buildCardChoices(myDi).map(c => {
      const prior = priorIdx.get(String(c.id))
      const tag = prior ? ` [已录:${[...new Set(prior.map(p => p.group))].join("/")}]` : ""
      return { name: `${c.label}${tag}`, value: c.id, description: c.description }
    }),
    pageSize: 12,
  }) as number[]
  if (picks.length === 0) return
  // 第二步：逐一标注角色/重要性/留牌/理由
  for (let i = 0; i < picks.length; i++) {
    const id = String(picks[i])
    const name = resolveCardName(myDi, id)
    // 同组重复：跳过（如需修改请在条目上回车编辑）
    if (s.keyCards[group].some(c => c.id === id)) {
      console.log(`── [${i + 1}/${picks.length}] ${name} 已在 ${group} 组，跳过`)
      continue
    }
    // 继承默认值：本卡组他组 > 他卡组同组 > 他卡组他组
    const prev = findKeyCardAnywhere(s, id)
    const prior = prev ? null : pickPrior(id)
    const src = prev?.card ?? prior?.card
    const note = prev
      ? `（继承自 ${prev.group} 组：${zhOnly(prev.card.importance)}${prev.card.mulligan ? `/${MULLIGAN_ZH[prev.card.mulligan] ?? prev.card.mulligan}` : ""}${prev.card.rationale ? `，${prev.card.rationale}` : ""}）`
      : prior
        ? `（继承自「${prior.deckName}」${prior.group} 组：${zhOnly(prior.card.importance)}${prior.card.mulligan ? `/${MULLIGAN_ZH[prior.card.mulligan] ?? prior.card.mulligan}` : ""}${prior.card.rationale ? `，${prior.card.rationale}` : ""}）`
        : ""
    console.log(`── [${i + 1}/${picks.length}] ${name}${note}`)
    const ch = myDi.characters.find(c => String(c.definitionId) === id)
    const role = groupDef.role ?? await pickComboRole(iq, src?.role)
    const importance = await pickImportance(iq, src?.importance ?? (group === "flex" ? "flexible" : undefined))
    // 角色：精确到关键技能/被动（引擎按 skill definitionId 寻址）；不评估留牌（角色不抽牌）
    let skills: KeyCard["skills"]
    let mulligan: KeyCard["mulligan"]
    if (ch) {
      const TYPE_LBL: Record<string, string> = { normal: "A", elementalSkill: "E", elementalBurst: "Q", passive: "P" }
      const picked = await iq.checkbox({
        message: `${ch.name} 的关键技能/被动（空格多选；空选=不限定）`,
        choices: ch.skills.map(sk => ({
          name: `${TYPE_LBL[sk.type] ?? sk.type} ${sk.name}${sk.cost ? ` [${sk.cost}]` : ""}`,
          value: sk.name,
          description: truncate(sk.description, 120),
          checked: src?.skills?.some(x => x.name === sk.name) ?? false,
        })),
        pageSize: 10,
      }) as string[]
      if (picked.length > 0) {
        skills = picked.map(nm => ({ id: String(ch.skills.find(x => x.name === nm)!.id), name: nm }))
      }
    } else {
      mulligan = await pickMulligan(iq, src?.mulligan)
    }
    const rationale = await iq.input({ message: "理由（≤50字）", default: src?.rationale })
    s.keyCards[group].push({ id, role, importance, rationale, ...(skills ? { skills } : {}), ...(mulligan ? { mulligan } : {}) })
  }
}

async function editKeyCardItem(ctx: DashboardContext, s: DeckGroundTruth, flatIdx: number): Promise<void> {
  const { iq, myDi } = ctx
  const found = findKeyCard(s, flatIdx)
  if (!found) return
  const { card } = found
  const name = myDi.cards.find(c => String(c.definitionId) === card.id)?.name
    ?? myDi.characters.find(c => String(c.definitionId) === card.id)?.name
    ?? card.id
  const isChar = myDi.characters.some(c => String(c.definitionId) === card.id)
  const action = await iq.select({
    message: `编辑: ${name} (${card.role}, ${card.importance})`,
    choices: [
      ...(found.group === "combo" ? [{ name: "修改角色", value: "role" }] : []),
      { name: "修改重要性", value: "importance" },
      ...(isChar
        ? [{ name: "修改关键技能/被动", value: "skills" }]
        : [{ name: "修改留牌优先级", value: "mulligan" }]),
      { name: "修改理由", value: "rationale" },
      { name: "删除此卡牌", value: "delete" },
      { name: "返回", value: "back" },
    ],
  })
  if (action === "delete") {
    s.keyCards[found.group].splice(found.realIdx, 1)
  } else if (action === "role") {
    card.role = await pickComboRole(iq, card.role)
  } else if (action === "importance") {
    card.importance = await pickImportance(iq, card.importance)
  } else if (action === "skills") {
    const ch = myDi.characters.find(c => String(c.definitionId) === card.id)!
    const TYPE_LBL: Record<string, string> = { normal: "A", elementalSkill: "E", elementalBurst: "Q", passive: "P" }
    const picked = await iq.checkbox({
      message: `${ch.name} 的关键技能/被动（空格多选；空选=不限定）`,
      choices: ch.skills.map(sk => ({
        name: `${TYPE_LBL[sk.type] ?? sk.type} ${sk.name}${sk.cost ? ` [${sk.cost}]` : ""}`,
        value: sk.name,
        description: truncate(sk.description, 120),
        checked: card.skills?.some(x => x.name === sk.name) ?? false,
      })),
      pageSize: 10,
    }) as string[]
    card.skills = picked.length > 0
      ? picked.map(nm => ({ id: String(ch.skills.find(x => x.name === nm)!.id), name: nm }))
      : undefined
  } else if (action === "mulligan") {
    card.mulligan = await pickMulligan(iq, card.mulligan)
  } else if (action === "rationale") {
    card.rationale = await iq.input({ message: "理由（≤50字）", default: card.rationale })
  }
}

// --- 开局决策树（一级条件分支） ---

async function addOpeningSequence(ctx: DashboardContext, s: DeckGroundTruth): Promise<void> {
  const { iq, myDi } = ctx
  s.openingSequences ??= []
  // 一级条件分支：先问条件（留空=默认分支），再速记打法；按优先级从高到低录入
  const condition = await iq.input({ message: "分支条件（如「手牌有卯师傅」「后手」「骰子≥3同色」；留空=默认分支）" })
  let isPrimary = condition.trim() === ""
  if (isPrimary) {
    const existing = s.openingSequences.find(seq => seq.isPrimary)
    if (existing) {
      const replace = await iq.confirm({ message: `已有默认分支「${existing.name}」，替换为默认？`, default: true })
      if (replace) existing.isPrimary = false
      else isPrimary = false
    }
  }
  const name = await iq.input({
    message: "分支名称",
    default: condition.trim() || "默认开局",
  })
  const steps = await inputStepsSmart(iq, myDi, true)
  if (steps.length === 0) { console.log("未添加步骤，跳过"); return }
  const diceConstraint = await iq.input({ message: "骰子颜色约束（含调谐预期）" })
  const style = await iq.select({
    message: "分支打法风格",
    default: "tempo",
    choices: [
      { name: "tempo - 节奏（骰子直接转化为行动权/伤害）", value: "tempo" },
      { name: "charge_up - 蓄爆（骰子投资非技能资源，铺垫后续回合）", value: "charge_up" },
    ],
  }) as "tempo" | "charge_up"
  const totalDiceUsed = steps.reduce((sum, st) => sum + parseDiceCost(st.cost), 0)
  s.openingSequences.push({
    id: `open-${s.openingSequences.length + 1}`,
    name, condition: condition.trim(), style,
    steps: steps.map(st => ({ action: st.action, cost: st.cost, effectDescription: st.effectDescription ?? "" })),
    diceConstraint, totalDiceUsed, isPrimary,
  })
}

async function editOpeningSequence(ctx: DashboardContext, s: DeckGroundTruth, idx: number): Promise<void> {
  const { iq, myDi } = ctx
  const seq = s.openingSequences?.[idx]
  if (!seq) return
  const action = await iq.select({
    message: `编辑分支: ${seq.name}${seq.condition ? `（${seq.condition}）` : ""}`,
    choices: [
      { name: "编辑步骤", value: "steps" },
      { name: "修改名称/条件/属性", value: "meta" },
      { name: "删除此分支", value: "delete" },
      { name: "返回", value: "back" },
    ],
  })
  if (action === "delete") {
    s.openingSequences!.splice(idx, 1)
  } else if (action === "steps") {
    const steps = await editSteps(iq, myDi, seq.steps, true)
    seq.steps = steps.map(st => ({ action: st.action, cost: st.cost, effectDescription: st.effectDescription ?? "" }))
    seq.totalDiceUsed = seq.steps.reduce((sum, st) => sum + parseDiceCost(st.cost), 0)
  } else if (action === "meta") {
    seq.name = await iq.input({ message: "分支名称", default: seq.name })
    seq.condition = await iq.input({ message: "分支条件（留空=默认分支）", default: seq.condition })
    seq.isPrimary = seq.condition.trim() === ""
      ? true
      : await iq.confirm({ message: "作为默认分支？", default: seq.isPrimary })
    seq.style = await iq.select({
      message: "分支打法风格",
      default: seq.style ?? "tempo",
      choices: [
        { name: "tempo - 节奏", value: "tempo" },
        { name: "charge_up - 蓄爆", value: "charge_up" },
      ],
    }) as "tempo" | "charge_up"
    seq.diceConstraint = await iq.input({ message: "骰子约束", default: seq.diceConstraint })
  }
}

// --- 弃权（两种模式共用） ---

async function addAbstention<S extends { abstentions: Abstention[] }>(ctx: DashboardContext, s: S): Promise<void> {
  const { iq } = ctx
  const field = await iq.input({ message: "弃权字段路径（如 threats、openingSequences）" })
  const reason = await iq.input({ message: "理由（≤50字）" })
  s.abstentions.push({ field, reason })
}

async function editAbstentionItem<S extends { abstentions: Abstention[] }>(ctx: DashboardContext, s: S, idx: number): Promise<void> {
  const { iq } = ctx
  const a = s.abstentions[idx]
  if (!a) return
  const action = await iq.select({
    message: `${a.field}: ${a.reason}`,
    choices: [
      { name: "修改理由", value: "reason" },
      { name: "删除", value: "delete" },
      { name: "返回", value: "back" },
    ],
  })
  if (action === "delete") {
    s.abstentions.splice(idx, 1)
  } else if (action === "reason") {
    a.reason = await iq.input({ message: "理由", default: a.reason })
  }
}

// ── 卡组模式分区 ──────────────────────────────────────────

export function deckSections(): SectionDef<DeckGroundTruth>[] {
  return [
    {
      key: "deckProfile", label: "卡组画像",
      status: s => {
        const n = [s.deckProfile.primaryType, s.deckProfile.tempo, s.deckProfile.startupSpeed].filter(Boolean).length
        return n === 3 ? "✓" : n > 0 ? "△" : "○"
      },
      summary: s => {
        const p = s.deckProfile.primaryType ? zh(s.deckProfile.primaryType, ZH_ARCHETYPE) : ""
        const sec = s.deckProfile.secondaryType ? `+${zh(s.deckProfile.secondaryType, ZH_ARCHETYPE)}` : ""
        return [p && p + sec, zh(s.deckProfile.tempo), zh(s.deckProfile.startupSpeed)].filter(Boolean).join("·")
      },
      fields: s => [
        enumField("primaryType", "主类型", () => s.deckProfile.primaryType, v => { s.deckProfile.primaryType = v }, MTG_TYPES, ZH_ARCHETYPE),
        {
          id: "secondaryType",
          label: () => `副类型: ${s.deckProfile.secondaryType ? zh(s.deckProfile.secondaryType, ZH_ARCHETYPE) : "（无）"}`,
          onCycle: dir => {
            const opts = ["", ...MTG_TYPES]
            const cur = opts.indexOf(s.deckProfile.secondaryType ?? "")
            const next = (cur + dir + opts.length) % opts.length
            s.deckProfile.secondaryType = opts[next]! || undefined
          },
        },
        enumField("tempo", "tempo", () => s.deckProfile.tempo, v => { s.deckProfile.tempo = v }, TEMPOS),
        enumField("startupSpeed", "startup", () => s.deckProfile.startupSpeed, v => { s.deckProfile.startupSpeed = v }, STARTUPS),
      ],
    },
    {
      key: "keyCards", label: "关键卡牌",
      status: s => KEY_CARD_GROUPS.some(({ group }) => s.keyCards[group].length > 0) ? "" : "○",
      items: s => KEY_CARD_GROUPS.flatMap(({ group }) => s.keyCards[group].map(c => c.id)),
      rows: keyCardGroupRows,
    },
    {
      key: "damageMode", label: "出伤与节奏",
      status: s => {
        const n = [s.damageMode, s.powerCurve, s.setupDependency, s.hasOneShotPotential !== undefined ? "x" : undefined].filter(Boolean).length
        return n === 4 ? "✓" : n > 0 ? "△" : "○"
      },
      summary: s => [
        zh(s.damageMode), zh(s.powerCurve),
        s.hasOneShotPotential !== undefined ? (s.hasOneShotPotential ? "有OTK" : "无OTK") : undefined,
        s.setupDependency && `依赖:${zh(s.setupDependency)}`,
      ].filter(Boolean).join("·") as string,
      fields: s => [
        enumField("damageMode", "出伤模式", () => s.damageMode, v => { s.damageMode = v }, DAMAGE_MODES),
        enumField("powerCurve", "出伤曲线", () => s.powerCurve, v => { s.powerCurve = v }, POWER_CURVES),
        boolField("otk", "OTK 潜力", () => s.hasOneShotPotential ?? false, v => { s.hasOneShotPotential = v }),
        enumField("setupDependency", "展开依赖", () => s.setupDependency, v => { s.setupDependency = v }, SETUP_DEPS),
      ],
    },
    {
      key: "resilience", label: "韧性",
      status: s => s.resilience ? "✓" : "○",
      summary: s => {
        if (!s.resilience) return ""
        const r = s.resilience
        const counters = [
          r.hasBoardDisruption ? "站场" : "",
          r.hasEventCounter ? "事件" : "",
          r.hasSummonRemoval ? "召唤" : "",
          r.hasHandDisruption ? "手牌" : "",
          r.hasDeckDisruption ? "牌库" : "",
        ].filter(Boolean).join("/")
        return `回血:${r.hasHealing ? "✓" : "✗"} 护盾:${r.hasShield ? "✓" : "✗"} 免控:${r.hasImmuneControl ? "✓" : "✗"} 反制:${counters || "无"} 弱点:${r.vulnerableTo.map(v => zh(v)).join("/")}`
      },
      fields: s => {
        const r = () => s.resilience ??= { hasHealing: false, hasShield: false, hasImmuneControl: false, vulnerableTo: [] }
        return [
          boolField("hasHealing", "回复手段", () => r().hasHealing, v => { r().hasHealing = v }),
          boolField("hasShield", "护盾来源", () => r().hasShield, v => { r().hasShield = v }),
          boolField("hasImmuneControl", "免疫控制", () => r().hasImmuneControl, v => { r().hasImmuneControl = v }),
          boolField("hasBoardDisruption", "干扰站场", () => r().hasBoardDisruption ?? false, v => { r().hasBoardDisruption = v }),
          boolField("hasEventCounter", "事件牌反制", () => r().hasEventCounter ?? false, v => { r().hasEventCounter = v }),
          boolField("hasSummonRemoval", "召唤物去除", () => r().hasSummonRemoval ?? false, v => { r().hasSummonRemoval = v }),
          boolField("hasHandDisruption", "手牌破坏", () => r().hasHandDisruption ?? false, v => { r().hasHandDisruption = v }),
          boolField("hasDeckDisruption", "牌库破坏", () => r().hasDeckDisruption ?? false, v => { r().hasDeckDisruption = v }),
          multiField("vulnerableTo", "弱点", () => r().vulnerableTo, VULNERABLE_TO),
        ]
      },
    },
    {
      key: "openingSequences", label: "开局决策树",
      status: s => (s.openingSequences?.length ?? 0) > 0 ? "" : "○",
      items: s => (s.openingSequences ?? []).map(seq =>
        `${seq.isPrimary ? "●" : "○"} ${seq.name}${seq.condition ? `（${seq.condition}）` : ""}${seq.style === "charge_up" ? " [蓄爆]" : ""} (${seq.steps.length}步, ${seq.totalDiceUsed}骰)`),
      onAdd: addOpeningSequence,
      onItem: editOpeningSequence,
    },
    {
      key: "abstentions", label: "弃权",
      status: s => s.abstentions.length > 0 ? "" : "○",
      items: s => s.abstentions.map((a, i) => `[${i + 1}] ${a.field}: ${a.reason.slice(0, 20)}`),
      onAdd: addAbstention,
      onItem: editAbstentionItem,
    },
  ]
}

// ── 对局级编辑器（列表分区向导） ───────────────────────────

// --- 威胁与应对 ---

/** 针对牌选择器（我方牌表多选；空选确认为 null） */
async function pickCounterCards(iq: InqType, myDi: DeckInfo, current: string[] | null): Promise<string[] | null> {
  const picks = await iq.checkbox({
    message: "我方牌表中的针对牌（无则直接回车）",
    choices: myDi.cards.map(c => ({
      name: c.name,
      value: c.name.replace(/ ×\d+$/, ""),
      description: truncate(c.description, 100),
      checked: current?.includes(c.name.replace(/ ×\d+$/, "")) ?? false,
    })),
    pageSize: 12,
  }) as string[]
  if (picks.length > 0) return picks
  const none = await iq.confirm({ message: "确认无针对牌（仅靠打法调整）？", default: true })
  return none ? null : []
}

const THREAT_KIND_CHOICES = [
  { name: "lethal - 高爆发斩杀（1-2回合击杀关键角色）", value: "lethal" },
  { name: "disrupting - 控制链（冻结/眩晕/强制切人）", value: "disrupting" },
  { name: "grinding - 消耗战（资源被拖垮）", value: "grinding" },
  { name: "ramping - 滚雪球累积（越拖越强）", value: "ramping" },
]

const THREAT_WINDOW_CHOICES = [
  { name: "early - R1-R2", value: "early" },
  { name: "mid - R3-R4", value: "mid" },
  { name: "late - R5+", value: "late" },
]

/** 威胁来源候选（同类归为一类，类内批量多选） */
interface ThreatSourceCand { name: string; value: string; description?: string }

async function addThreat(ctx: DashboardContext, s: MatchupPerspective): Promise<void> {
  const { iq, myDi, oppDi } = ctx

  // ── 跨对局继承：同对手已标威胁 → 勾选继承（应对以其原文为默认值，可改）
  const priors = (ctx.priorThreats ?? []).filter(p => !s.threats.some(t => t.source === p.source))
  if (priors.length > 0) {
    const picked = await iq.checkbox({
      message: "同对手已标威胁（勾选继承 source/kind/window）",
      choices: priors.map(p => ({
        name: `${p.source} (${zh(p.kind)}/${zh(p.window)}) —— 来自「${p.deckName}」`,
        value: p.source,
        checked: false,
        description: p.countermeasure ? `先前应对：${p.countermeasure}` : undefined,
      })),
      pageSize: 12,
    }) as string[]
    for (const src of picked) {
      const p = priors.find(x => x.source === src)!
      const countermeasure = await iq.input({ message: `应对「${src}」（≤60字）`, default: p.countermeasure })
      const counterCards = await pickCounterCards(iq, myDi, null)
      s.threats.push({ source: p.source, kind: p.kind, window: p.window, countermeasure, existingCounterCards: counterCards })
    }
  }

  // ── 全新录入：来源候选按类别分组（★斩杀件/角色技能/事件/支援/装备/自定义）
  const buildCats = (): { key: string; label: string; items: ThreatSourceCand[] }[] => {
    const cats: { key: string; label: string; items: ThreatSourceCand[] }[] = []
    const recorded = (v: string) => s.threats.some(t => t.source === v)
    if (ctx.oppState && oppDi) {
      const coreIds = new Set<string>()
      for (const k of [...ctx.oppState.keyCards.combo.filter(c => c.role === "combo_finisher"), ...ctx.oppState.keyCards.damage]) {
        if (k.importance === "core") coreIds.add(k.id)
      }
      const items = [...coreIds].map(id => resolveCardName(oppDi, id)).filter(nm => !recorded(nm))
        .map(nm => ({ name: `★ ${nm}`, value: nm, description: "对手关键斩杀/增伤件" }))
      if (items.length > 0) cats.push({ key: "star", label: "对手关键斩杀/增伤件", items })
    }
    if (oppDi) {
      const skills = oppDi.characters.flatMap(ch => ch.skills.map(sk => ({
        name: `${ch.name} ${sk.name}`,
        value: `${ch.name} ${sk.name}`,
        description: truncate(sk.description, 120),
      }))).filter(it => !recorded(it.value))
      if (skills.length > 0) cats.push({ key: "skill", label: "角色技能", items: skills })
      for (const [type, label] of [["event", "事件牌"], ["support", "支援牌"], ["equipment", "装备牌"]] as const) {
        const items = oppDi.cards.filter(c => c.type === type).map(c => ({
          name: c.name,
          value: c.name.replace(/ ×\d+$/, ""),
          description: truncate(c.description, 120),
        })).filter(it => !recorded(it.value))
        if (items.length > 0) cats.push({ key: type, label, items })
      }
    }
    cats.push({ key: "custom", label: "自定义输入", items: [] })
    return cats
  }

  // 逐类别录入：选类别 → 类内批量勾选 → 批量类型/窗口默认值 → 逐条应对
  while (true) {
    const cats = buildCats()
    const cat = await iq.select({
      message: "威胁来源类别",
      choices: [
        ...cats.map(c => ({ name: c.key === "custom" ? c.label : `${c.label} (${c.items.length})`, value: c.key })),
        { name: "完成（返回）", value: "__done__" },
      ],
      pageSize: 12,
    }) as string
    if (cat === "__done__") return
    const catDef = cats.find(c => c.key === cat)!

    let picks: string[]
    if (cat === "custom") {
      const src = await iq.input({ message: "威胁来源（如「林尼蓄力爆发」）" })
      if (!src.trim()) continue
      if (s.threats.some(t => t.source === src.trim())) { console.log(`「${src.trim()}」已录入，跳过`); continue }
      picks = [src.trim()]
    } else {
      picks = await iq.checkbox({
        message: `${catDef.label}：勾选威胁来源（空格多选，回车确认）`,
        choices: catDef.items,
        pageSize: 12,
      }) as string[]
      if (picks.length === 0) continue
    }

    // 同类一批：类型/窗口统一设置（可在条目上回车逐条修改）
    const kind = await iq.select({
      message: `威胁类型（本批 ${picks.length} 项统一设置）`,
      choices: THREAT_KIND_CHOICES,
    }) as MatchupThreat["kind"]
    const window = await iq.select({
      message: "威胁窗口（本批统一设置）",
      choices: THREAT_WINDOW_CHOICES,
    }) as MatchupThreat["window"]
    for (let i = 0; i < picks.length; i++) {
      const source = picks[i]!
      console.log(`── [${i + 1}/${picks.length}] ${source} (${zhOnly(kind)}/${zhOnly(window)})`)
      const countermeasure = await iq.input({ message: "应对策略（≤60字）" })
      const counterCards = await pickCounterCards(iq, myDi, null)
      s.threats.push({ source, kind, window, countermeasure, existingCounterCards: counterCards })
    }
  }
}

async function editThreatItem(ctx: DashboardContext, s: MatchupPerspective, idx: number): Promise<void> {
  const { iq, myDi } = ctx
  const t = s.threats[idx]
  if (!t) return
  const action = await iq.select({
    message: `威胁: ${t.source} (${t.kind}, ${t.window})`,
    choices: [
      { name: "修改威胁类型", value: "kind" },
      { name: "修改威胁窗口", value: "window" },
      { name: "修改应对策略", value: "countermeasure" },
      { name: "修改针对牌", value: "counterCards" },
      { name: "删除", value: "delete" },
      { name: "返回", value: "back" },
    ],
  })
  if (action === "delete") {
    s.threats.splice(idx, 1)
  } else if (action === "kind") {
    t.kind = await iq.select({ message: "威胁类型", default: t.kind, choices: THREAT_KIND_CHOICES }) as MatchupThreat["kind"]
  } else if (action === "window") {
    t.window = await iq.select({ message: "威胁窗口", default: t.window, choices: THREAT_WINDOW_CHOICES }) as MatchupThreat["window"]
  } else if (action === "countermeasure") {
  } else if (action === "counterCards") {
    t.existingCounterCards = await pickCounterCards(iq, myDi, t.existingCounterCards)
  }
}

// --- 职能重分配 ---

const ROLE_CHOICES = [
  { name: "combo_starter - 连招起点", value: "combo_starter" },
  { name: "combo_finisher - 连招终点", value: "combo_finisher" },
  { name: "draw - 过牌/检索", value: "draw" },
  { name: "sustain - 生存", value: "sustain" },
  { name: "disruption - 干扰", value: "disruption" },
  { name: "ramp - 资源", value: "ramp" },
  { name: "flex_slot - 灵活位", value: "flex_slot" },
  { name: "自定义输入", value: "__custom__" },
]

async function addRoleShift(ctx: DashboardContext, s: MatchupPerspective): Promise<void> {
  const { iq, myDi } = ctx
  const choices = buildCardChoices(myDi)
  const sel = await iq.select({
    message: "选择角色/卡牌",
    choices: choices.map(c => ({ name: c.label, value: c.label, description: c.description })),
    pageSize: 12,
  }) as string
  const cardOrCharacter = sel.replace(/^\[(角色|equipment|event|support)\]\s*(\[[^\]]*\]\s*)?/, "")
  let isolatedRole = await iq.select({ message: "孤立时的职能", choices: ROLE_CHOICES }) as string
  if (isolatedRole === "__custom__") {
    isolatedRole = await iq.input({ message: "孤立职能（如 enabler、anchor）" })
  }
  const matchupRole = await iq.input({ message: "本对局中的实际职能（如 前台承伤 anchor）" })
  const reason = await iq.input({ message: "变化原因（一句话）" })
  s.roleShifts ??= []
  s.roleShifts.push({ cardOrCharacter, isolatedRole, matchupRole, reason })
}

async function editRoleShiftItem(ctx: DashboardContext, s: MatchupPerspective, idx: number): Promise<void> {
  const { iq } = ctx
  const rs = s.roleShifts?.[idx]
  if (!rs) return
  const action = await iq.select({
    message: `${rs.cardOrCharacter}: ${rs.isolatedRole} → ${rs.matchupRole}`,
    choices: [
      { name: "修改对局职能", value: "matchupRole" },
      { name: "修改原因", value: "reason" },
      { name: "删除", value: "delete" },
      { name: "返回", value: "back" },
    ],
  })
  if (action === "delete") {
    s.roleShifts!.splice(idx, 1)
  } else if (action === "matchupRole") {
    rs.matchupRole = await iq.input({ message: "对局职能", default: rs.matchupRole })
  } else if (action === "reason") {
    rs.reason = await iq.input({ message: "原因", default: rs.reason })
  }
}

// ── 对局模式分区 ──────────────────────────────────────────

export function matchupSections(): SectionDef<MatchupPerspective>[] {
  return [
    {
      key: "opponentNotables", label: "对手特征",
      status: s => {
        const on = s.opponentNotables
        const n = [on.powerCurve, on.damageMode, on.threatSummary].filter(Boolean).length
        return n === 3 ? "✓" : n > 0 ? "△" : "○"
      },
      summary: s => {
        const on = s.opponentNotables
        return [zh(on.powerCurve), zh(on.damageMode), on.threatSummary && truncate(on.threatSummary, 16)].filter(Boolean).join("·")
      },
      fields: (s, ctx) => [
        enumField("powerCurve", "对手曲线", () => s.opponentNotables.powerCurve || undefined, v => { s.opponentNotables.powerCurve = v }, POWER_CURVES),
        enumField("damageMode", "对手模式", () => s.opponentNotables.damageMode || undefined, v => { s.opponentNotables.damageMode = v }, DAMAGE_MODES),
        textField("threatSummary", "制胜摘要", () => s.opponentNotables.threatSummary, v => { s.opponentNotables.threatSummary = v }, ctx.iq, "对手制胜手段摘要（一句话）"),
      ],
    },
    {
      key: "threats", label: "威胁与应对",
      status: s => s.threats.length > 0 ? "" : "○",
      items: s => s.threats.map((t, i) =>
        `[${i + 1}] ${t.source} (${zh(t.kind)}/${zh(t.window)}) → ${t.existingCounterCards === null ? "无针对牌" : (t.existingCounterCards.join("、") || "？")}`),
      onAdd: addThreat,
      onItem: editThreatItem,
    },
    {
      key: "reactionControl", label: "反应控制权",
      status: s => s.reactionControl ? "✓" : "○",
      summary: s => {
        const rc = s.reactionControl
        if (!rc) return ""
        return `优势:${zh(rc.advantage)} 我:${rc.myMonopoly.join("/") || "无"} 敌:${rc.oppMonopoly.join("/") || "无"} 争:${rc.contested.join("/") || "无"}`
      },
      fields: (s, ctx) => {
        const rc = () => s.reactionControl ??= { myMonopoly: [], oppMonopoly: [], contested: [], advantage: "even" }
        return [
          listTextField("myMonopoly", "我方垄断", () => rc().myMonopoly, v => { rc().myMonopoly = v }, ctx.iq),
          listTextField("oppMonopoly", "对手垄断", () => rc().oppMonopoly, v => { rc().oppMonopoly = v }, ctx.iq),
          listTextField("contested", "竞争反应", () => rc().contested, v => { rc().contested = v }, ctx.iq),
          enumField("advantage", "控制权", () => rc().advantage, v => { rc().advantage = v }, RC_ADVS),
        ]
      },
    },
    {
      key: "tempoShift", label: "节奏偏移",
      status: s => s.tempoShift ? "✓" : "○",
      summary: s => s.tempoShift ? zh(s.tempoShift.shift) : "",
      fields: (s, ctx) => {
        const ts = () => s.tempoShift ??= { shift: "no_shift", rationale: "" }
        return [
          enumField("shift", "偏移", () => ts().shift, v => { ts().shift = v }, TEMPO_SHIFTS),
          textField("rationale", "理由", () => ts().rationale, v => { ts().rationale = v }, ctx.iq),
        ]
      },
    },
    {
      key: "windowShift", label: "窗口变形",
      status: s => s.windowShift ? "✓" : "○",
      summary: s => s.windowShift ? `${s.windowShift.myEffectiveWindow || "?"} ${zh(s.windowShift.adjustment)}` : "",
      fields: (s, ctx) => {
        const ws = () => s.windowShift ??= { myEffectiveWindow: "", adjustment: "same_as_isolated" }
        return [
          textField("myEffectiveWindow", "有效窗口", () => ws().myEffectiveWindow, v => { ws().myEffectiveWindow = v }, ctx.iq, "实际有效窗口（如 R1-R2）"),
          enumField("adjustment", "调整", () => ws().adjustment, v => { ws().adjustment = v }, WINDOW_ADJS),
        ]
      },
    },
    {
      key: "roleShifts", label: "职能重分配",
      status: s => (s.roleShifts?.length ?? 0) > 0 ? "" : "○",
      items: s => (s.roleShifts ?? []).map((r, i) => `[${i + 1}] ${r.cardOrCharacter}: ${zh(r.isolatedRole)} → ${zh(r.matchupRole)}`),
      onAdd: addRoleShift,
      onItem: editRoleShiftItem,
    },
    {
      key: "playOrder", label: "先后手",
      status: s => (s.playOrder?.asFirst || s.playOrder?.asSecond) ? "✓" : "○",
      summary: s => [
        s.playOrder?.asFirst ? "先手✓" : "",
        s.playOrder?.asSecond ? "后手✓" : "",
      ].filter(Boolean).join(" "),
      fields: (s, ctx) => {
        const po = () => s.playOrder ??= {}
        return [
          textField("asFirst", "先手调整", () => po().asFirst ?? "", v => { po().asFirst = v }, ctx.iq, "我方先手时的调整（≤60字，可空）"),
          textField("asSecond", "后手调整", () => po().asSecond ?? "", v => { po().asSecond = v }, ctx.iq, "我方后手时的调整（≤60字，可空）"),
        ]
      },
    },
    {
      key: "assessment", label: "综合评估",
      status: s => (s.overallDirection && s.decisiveFactor) ? "✓" : (s.overallDirection || s.assessment.recommendedStrategy) ? "△" : "○",
      summary: s => [zh(s.overallDirection), zh(s.assessment.recommendedStrategy), s.decisiveFactor && truncate(s.decisiveFactor, 14)].filter(Boolean).join("·"),
      fields: (s, ctx) => [
        multiField("myAdvantages", "我方优势", () => s.assessment.myAdvantages, ADVANTAGES),
        multiField("oppAdvantages", "对手优势", () => s.assessment.oppAdvantages, ADVANTAGES),
        enumField("strategy", "推荐策略", () => s.assessment.recommendedStrategy, v => { s.assessment.recommendedStrategy = v }, STRATEGIES),
        enumField("direction", "整体优劣", () => s.overallDirection || undefined, v => { s.overallDirection = v }, DIRECTIONS),
        textField("decisive", "决定因素", () => s.decisiveFactor, v => { s.decisiveFactor = v }, ctx.iq, "决定性因素（一句话）"),
      ],
    },
    {
      key: "abstentions", label: "弃权",
      status: s => s.abstentions.length > 0 ? "" : "○",
      items: s => s.abstentions.map((a, i) => `[${i + 1}] ${a.field}: ${a.reason.slice(0, 20)}`),
      onAdd: addAbstention,
      onItem: editAbstentionItem,
    },
  ]
}

// 类型导出（供 CLI 使用）
export type { OpeningSequence, RoleShift }
