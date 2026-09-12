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
 * author-opponent-set — plan:author 的 --opponent-set（General 起草模式，G2，Phase 4）
 * 纯函数模块（CLI 入口 main() 不可测，本模块收敛可测逻辑）：
 *
 * - parseOpponentSetFile：解析对手集合文件——JSON 数组 / { "opponents": [...] } /
 *   换行文本（每行一个 deckCode，空行与 # 注释忽略）。垃圾输入返回 { ok: false }。
 * - buildOpponentSetPromptSections：对手集合注入文本的组装（纯函数；describeDeckDetail
 *   是 IO（读卡库），由调用方传入逐对手的详情文本，本函数只做章节排版）。
 * - GENERAL_ROBUSTNESS_DISCIPLINE：稳健性写作纪律段落（注入 user prompt；要求规则
 *   不得引用仅单个对手特有的 defId/牌表细节——除非是明牌先验字段，规则应对任意
 *   未知对手稳健）。与 prompts/author-system.md 的两层起草纪律章节呼应。
 */

/** 解析结果：{ ok: true, codes: string[] } 或 { ok: false, error: string } */
export type OpponentSetParseResult = { ok: true; codes: string[] } | { ok: false; error: string }

/** 去重（保持首现顺序） */
function dedupe(codes: string[]): string[] {
  return [...new Set(codes)]
}

/**
 * 解析对手集合文件内容。支持：
 * 1. JSON 数组 ["<deckCode>", ...]
 * 2. JSON 对象 { "opponents": ["<deckCode>", ...] }
 * 3. 换行文本（每行一个 deckCode；空行与 # 开头注释行忽略）
 * 解析成功但无有效 deckCode → 视为错误（空集合无法起草 General）。
 */
export function parseOpponentSetFile(text: string): OpponentSetParseResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "对手集合文件为空" }
  }
  const trimmed = text.trim()
  let codes: string[] | null = null
  if (trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: "对手集合 JSON 解析失败（以 [ 开头，应为 JSON 数组）" }
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "对手集合 JSON 数组非法（非数组）" }
    }
    if (!parsed.every((c) => typeof c === "string" && c.length > 0)) {
      return { ok: false, error: "对手集合 JSON 数组含非字符串项" }
    }
    codes = parsed as string[]
  } else if (trimmed.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: "对手集合 JSON 解析失败（以 { 开头，应为 { \"opponents\": [...] }）" }
    }
    const opponents = (parsed as { opponents?: unknown })?.opponents
    if (!Array.isArray(opponents)) {
      return { ok: false, error: "对手集合 JSON 对象缺少 opponents 数组" }
    }
    if (!opponents.every((c) => typeof c === "string" && c.length > 0)) {
      return { ok: false, error: "对手集合 opponents 数组含非字符串项" }
    }
    codes = opponents as string[]
  } else {
    // 换行文本：逐行 trim，忽略空行与 # 注释
    codes = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
  }
  const deduped = dedupe(codes)
  if (deduped.length === 0) {
    return { ok: false, error: "对手集合为空（无有效 deckCode；换行文本中 # 开头为注释）" }
  }
  return { ok: true, codes: deduped }
}

/**
 * 稳健性写作纪律段落（G2-1）：注入 user prompt，约束 General 计划不得引用
 * 仅单个对手特有的细节约束 when——规则应对任意未知对手稳健（D3）。
 */
export const GENERAL_ROBUSTNESS_DISCIPLINE = `# 稳健性写作纪律（本计划为 General 层公共树）

以上是本 General 计划需要稳健应对的对手集合。纪律：
- 规则 when 只能引用对任意对手稳健的字段——明牌先验（dice.*、我方角色/卡牌字段、
  opp.threat.* 等局面级字段）可用；**不得引用仅单个对手特有的 defId / 牌表细节**
  （如某对手专属卡牌的 hasCardP、专属角色 id）来约束 when——那是该对手 Single 层的
  职责，不应写进 General 层。
- 每条规则应说明"对所有对手都成立"的共性理由；若某规则只对集合中某一个对手成立，
  请把它下放到该对手的 Single 层（本次不产），不要写进 General。
- context.opponent 必须声明 unknown_deck（系统会强制覆盖）——General 是面向任意
  未来对手的公共树，即使你已看到本集合的牌表，也不得据此特化规则。`

/**
 * 对手集合注入文本（G2-1）：逐对手一节牌表详情 + 稳健性纪律段落。
 * detailOf 由调用方提供（describeDeckDetail 读卡库）；本函数只做章节排版（纯函数）。
 */
export function buildOpponentSetPromptSections(
  codes: string[],
  detailOf: (code: string) => string,
): string[] {
  const sections: string[] = []
  sections.push(`# 对手集合（General 计划需稳健应对 ${codes.length} 个对手）`)
  codes.forEach((code, i) => {
    sections.push(`## 对手 ${i + 1}/${codes.length}（分享码 ${code}）\n\n${detailOf(code)}`)
  })
  sections.push(GENERAL_ROBUSTNESS_DISCIPLINE)
  return sections
}
