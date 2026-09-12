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

import type { BenchmarkQuestion, BenchmarkSet, CardDef, QuestionCategory } from "./types"

// ── helpers ──────────────────────────────────────────────

let _qid = 0
function qid(): string {
  return `q-${String(++_qid).padStart(4, "0")}`
}

interface Rng {
  randInt(n: number): number
  pick<T>(arr: T[]): T
  shuffle<T>(arr: T[]): T[]
}

function makeRng(seed?: number): Rng {
  let s = seed ?? 0
  const randInt = (n: number) => {
    if (seed !== undefined) {
      s = (s * 1664525 + 1013904223) | 0
      return ((s >>> 0) % n)
    }
    return Math.floor(Math.random() * n)
  }
  const pick = <T>(arr: T[]): T => arr[randInt(arr.length)]
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  return { randInt, pick, shuffle }
}

const defaultRng: Rng = makeRng()
/** Mutable reference so `generateBenchmark` can swap in a seeded Rng */
let rng: Rng = defaultRng

const ELEMENT_NAMES: Record<string, string> = {
  pyro: "火",
  hydro: "水",
  electro: "雷",
  cryo: "冰",
  anemo: "风",
  geo: "岩",
  dendro: "草",
}

const NATION_NAMES: Record<string, string> = {
  mondstadt: "蒙德",
  liyue: "璃月",
  inazuma: "稻妻",
  sumeru: "须弥",
  fontaine: "枫丹",
  natlan: "纳塔",
  nodkrai: "挪德卡莱",
  fatui: "愚人众",
  monster: "怪物",
  hilichurl: "丘丘人",
  eremite: "镀金旅团",
}

// ── question generators ──────────────────────────────────

type Generator = (
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
) => BenchmarkQuestion[]

// ── 1. Card name → Effect ───────────────────────────────
function genCardNameToEffect(
  _cards: CardDef[],
  _chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const pool = all.filter(
    (d) =>
      (d.kind === "card" || d.kind === "character") &&
      d.description.length > 5,
  )
  return rng.shuffle(pool).slice(0, 80).map((d) => ({
    id: qid(),
    category: "card-name-to-effect" as QuestionCategory,
    question: `问：在七圣召唤中，“${d.name}”的效果是什么？`,
    groundTruth: d.description,
    keywords: d.description
      .split(/[，。；：、\s\n]+/)
      .filter((k) => k.length >= 6)
      .slice(0, 5),
    sourceIds: [d.definitionId],
    difficulty: d.description.length > 80 ? "hard" : "medium",
  }))
}

// ── 2. Effect → Card name ───────────────────────────────
function genEffectToCardName(
  _cards: CardDef[],
  _chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const pool = all.filter(
    (d) =>
      (d.kind === "card" || d.kind === "character") &&
      d.description.length > 10 && d.description.length < 150,
  )
  return rng.shuffle(pool).slice(0, 60).map((d) => {
    const desc = d.description
    return {
      id: qid(),
      category: "effect-to-card-name" as QuestionCategory,
      question: `问：在七圣召唤中，哪张牌的效果如下：${desc}`,
      groundTruth: d.name,
      keywords: [d.name],
      sourceIds: [d.definitionId],
      difficulty: "medium",
    }
  })
}

// ── 3. Card cost ─────────────────────────────────────────
function genCardCost(
  cards: CardDef[],
  _chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  const pool = cards.filter((d) => d.cost > 0)
  return rng.shuffle(pool).slice(0, 40).map((d) => ({
    id: qid(),
    category: "card-cost" as QuestionCategory,
    question: `问：在七圣召唤中，卡牌“${d.name}”需要多少元素骰费用？`,
    groundTruth: `${d.cost}费`,
    keywords: [`${d.cost}`, `${d.cost}费`],
    sourceIds: [d.definitionId],
    difficulty: "easy",
  }))
}

// ── 4. Card type ─────────────────────────────────────────
function genCardType(
  cards: CardDef[],
  chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  const pool = [...cards, ...chars]
  const TYPE_LABEL: Record<string, string> = {
    equipment: "装备牌",
    event: "事件牌",
    support: "支援牌",
  }

  return rng.shuffle(pool).slice(0, 40).map((d) => {
    let answer: string
    if (d.type.startsWith("character:")) {
      const el = d.type.split(":")[1]
      answer = `${ELEMENT_NAMES[el] ?? el}元素角色牌`
    } else {
      answer = TYPE_LABEL[d.type] ?? d.type
    }
    return {
      id: qid(),
      category: "card-type" as QuestionCategory,
      question: `问：在七圣召唤中，卡牌“${d.name}”属于什么类型？`,
      groundTruth: answer,
      keywords: [answer],
      sourceIds: [d.definitionId],
      difficulty: "easy",
    }
  })
}

// ── 5. Character element ─────────────────────────────────
function genCharacterElement(
  _cards: CardDef[],
  chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  return rng.shuffle(chars).slice(0, 40).map((d) => {
    const elTag = d.tags.find((t) => ELEMENT_NAMES[t])
    const elName = elTag ? ELEMENT_NAMES[elTag] ?? elTag : "未知"
    return {
      id: qid(),
      category: "character-element" as QuestionCategory,
      question: `问：在七圣召唤中，角色牌“${d.name}”是什么元素的？`,
      groundTruth: elName,
      keywords: [elName],
      sourceIds: [d.definitionId],
      difficulty: "easy",
      overlap: true,
    }
  })
}

// ── 6. Character stats ───────────────────────────────────
function genCharacterStats(
  _cards: CardDef[],
  chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  // Prefer characters where health was parsed successfully
  const pool = chars.filter((d) => d.health !== undefined)
  return rng.shuffle(pool).slice(0, 40).map((d) => {
    const hp = d.health ?? "?"
    const en = d.energy ?? d.specialEnergy ?? "?"
    const enText = en !== "?"
      ? `${en}点`
      : "标准充能"
    const extra = d.specialEnergy ? `（${en === d.specialEnergy ? `特殊能量槽${en}格` : ""}）` : ""
    return {
      id: qid(),
      category: "character-stats" as QuestionCategory,
      question: `问：在七圣召唤中，角色牌“${d.name}”的基础生命值和充能是多少？`,
      groundTruth: `生命值${hp}，充能${enText}${extra}`,
      keywords: [`${hp}`, `生命值${hp}`],
      sourceIds: [d.definitionId],
      difficulty: "medium",
    }
  })
}

// ── 7. Version introduced ────────────────────────────────
function genVersionIntroduced(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const pool = all.filter((d) => d.since && (d.kind === "card" || d.kind === "character"))
  return rng.shuffle(pool).slice(0, 30).map((d) => ({
    id: qid(),
    category: "version-introduced" as QuestionCategory,
    question: `问：在七圣召唤中，卡牌“${d.name}”是在哪个版本加入游戏的？`,
    groundTruth: d.since!,
    keywords: [d.since!],
    sourceIds: [d.definitionId],
    difficulty: "hard",
  }))
}

// ── 8. Weapon type ───────────────────────────────────────
function genWeaponType(
  _cards: CardDef[],
  chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  const WEAPON: Record<string, string> = {
    sword: "单手剑",
    claymore: "双手剑",
    pole: "长柄武器",
    bow: "弓",
    catalyst: "法器",
    otherWeapon: "其他武器",
  }
  const pool = chars.filter((d) =>
    d.tags.some((t) => t in WEAPON),
  )
  return rng.shuffle(pool).slice(0, 30).map((d) => {
    const wt = d.tags.find((t) => t in WEAPON)
    return {
      id: qid(),
      category: "weapon-type" as QuestionCategory,
      question: `问：在七圣召唤中，角色牌“${d.name}”使用什么武器？`,
      groundTruth: WEAPON[wt ?? ""] ?? wt ?? "未知",
      keywords: [WEAPON[wt ?? ""] ?? wt ?? "未知"],
      sourceIds: [d.definitionId],
      difficulty: "easy",
      overlap: true,
    }
  })
}

// ── 9. Nation ────────────────────────────────────────────
function genNation(
  _cards: CardDef[],
  chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  const pool = chars.filter((d) =>
    d.tags.some((t) => t in NATION_NAMES),
  )
  return rng.shuffle(pool).slice(0, 30).map((d) => {
    const nt = d.tags.find((t) => t in NATION_NAMES)
    return {
      id: qid(),
      category: "nation" as QuestionCategory,
      question: `问：在七圣召唤中，角色牌“${d.name}”属于哪个国家/阵营？`,
      groundTruth: NATION_NAMES[nt ?? ""] ?? nt ?? "未知",
      keywords: [NATION_NAMES[nt ?? ""] ?? nt ?? "未知"],
      sourceIds: [d.definitionId],
      difficulty: "medium",
      overlap: true,
    }
  })
}

// ── 10. Multi-answer: find by tag ────────────────────────
function genMultipleAnswer(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const questions: BenchmarkQuestion[] = []

  // Cards tagged "food"
  const foodCards = cards.filter((d) => d.tags.includes("food"))
  if (foodCards.length > 0) {
    questions.push({
      id: qid(),
      category: "multiple-answer",
      question: `问：在七圣召唤中，请列出至少3张带有"料理"标签的卡牌名称。`,
      groundTruth: foodCards.map((d) => d.name),
      keywords: foodCards.slice(0, 3).map((d) => d.name),
      sourceIds: foodCards.map((d) => d.definitionId),
      difficulty: "hard",
    })
  }

  // Cards tagged "resonance"
  const resCards = cards.filter((d) => d.tags.includes("resonance"))
  if (resCards.length > 0) {
    questions.push({
      id: qid(),
      category: "multiple-answer",
      question: `问：在七圣召唤中，请列举至少3种元素共鸣牌的名称。`,
      groundTruth: resCards.map((d) => d.name),
      keywords: resCards.slice(0, 3).map((d) => d.name),
      sourceIds: resCards.map((d) => d.definitionId),
      difficulty: "hard",
    })
  }

  // Pyro characters
  const pyroChars = chars.filter((d) => d.tags.includes("pyro"))
  if (pyroChars.length > 0) {
    questions.push({
      id: qid(),
      category: "multiple-answer",
      question: `问：在七圣召唤中，请列举至少3个火元素角色牌。`,
      groundTruth: pyroChars.map((d) => d.name),
      keywords: pyroChars.slice(0, 3).map((d) => d.name),
      sourceIds: pyroChars.map((d) => d.definitionId),
      difficulty: "easy",
    })
  }

  // Weapons - bow users
  const bowChars = chars.filter((d) => d.tags.includes("bow"))
  if (bowChars.length > 0) {
    questions.push({
      id: qid(),
      category: "multiple-answer",
      question: `问：在七圣召唤中，请列举至少3个使用弓的角色牌。`,
      groundTruth: bowChars.map((d) => d.name),
      keywords: bowChars.slice(0, 3).map((d) => d.name),
      sourceIds: bowChars.map((d) => d.definitionId),
      difficulty: "medium",
    })
  }

  return questions
}

// ── 11. Card effect matching (yearn→name) ────────────────
function genCardEffectMatch(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const pool = all.filter(
    (d) =>
      (d.kind === "card" || d.kind === "character") &&
      d.description.length > 15,
  )
  const questions: BenchmarkQuestion[] = []

  for (const d of rng.shuffle(pool).slice(0, 30)) {
    // Pick a distinctive phrase from the description
    const sentences = d.description.split(/[。；\n]/).filter(Boolean)
    if (sentences.length < 2) continue
    // Pick the first sentence as a clue
    const clue = sentences[0].trim()
    if (clue.length < 6) continue
    questions.push({
      id: qid(),
      category: "card-effect-match",
      question: `问：在七圣召唤中，以下效果对应哪张牌？"${clue}"`,
      groundTruth: d.name,
      keywords: [d.name],
      sourceIds: [d.definitionId],
      difficulty: "hard",
    })
  }
  return questions
}

// ── 12. Cost deduction (问某个卡牌减少了什么费用) ────────
function genCostDeduction(
  cards: CardDef[],
  _chars: CardDef[],
  _all: CardDef[],
): BenchmarkQuestion[] {
  const pool = cards.filter(
    (d) =>
      d.description.includes("少花费") ||
      d.description.includes("少消耗") ||
      d.description.includes("减"),
  )
  return rng.shuffle(pool).slice(0, 20).map((d) => ({
    id: qid(),
    category: "cost-deduction",
    question: `问：在七圣召唤中，卡牌“${d.name}”能减少什么费用？`,
    groundTruth: d.description,
    keywords: ["少花费", "减", d.name],
    sourceIds: [d.definitionId],
    difficulty: "medium",
  }))
}

// ── 13. from-description-find-name (partial effect → card name) ──
function genFromDescriptionFindName(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  const pool = all.filter(
    (d) =>
      (d.kind === "card" || d.kind === "character") &&
      d.description.length > 20,
  )
  const questions: BenchmarkQuestion[] = []
  for (const d of rng.shuffle(pool).slice(0, 30)) {
    const desc = d.description
    // Ask about a specific aspect
    if (desc.includes("结束阶段")) {
      questions.push({
        id: qid(),
        category: "from-description-find-name",
        question: `问：在七圣召唤中，哪张卡牌的描述中提到"结束阶段"且效果是关于生成元素骰的？`,
        groundTruth: d.name,
        keywords: ["结束阶段", d.name],
        sourceIds: [d.definitionId],
        difficulty: "hard",
      })
    }
  }
  return questions
}

// ── 14. Skill cost ─────────────────────────────────────
function genSkillCost(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
): BenchmarkQuestion[] {
  // We can extract skill cost from the source by analyzing skill() definitions
  // For now, ask about character skills that have visible costs in descriptions
  const questions: BenchmarkQuestion[] = []
  const skillDefs = all.filter((d) => d.kind === "skill" && d.description.length > 5)
  for (const d of rng.shuffle(skillDefs).slice(0, 20)) {
    if (d.description.includes("造成")) {
      questions.push({
        id: qid(),
        category: "skill-cost",
        question: `问：在七圣召唤中，技能"${d.name}"的效果是什么？(卡牌ID: ${d.definitionId})`,
        groundTruth: d.description,
        keywords: d.description.slice(0, 20).split(/[，。]/).filter(Boolean),
        sourceIds: [d.definitionId],
        difficulty: "hard",
      })
    }
  }
  return questions
}

// ── aggregator ───────────────────────────────────────────

const GENERATORS: Generator[] = [
  genCardNameToEffect,
  genEffectToCardName,
  genCardCost,
  genCardType,
  genCharacterElement,
  genCharacterStats,
  genVersionIntroduced,
  genWeaponType,
  genNation,
  genMultipleAnswer,
  genCardEffectMatch,
  genCostDeduction,
  genFromDescriptionFindName,
  genSkillCost,
]

export interface GenerateOptions {
  maxQuestions?: number
  categories?: QuestionCategory[]
  seed?: number
}

/**
 * Generate a complete benchmark set by running all question generators.
 */
export function generateBenchmark(
  cards: CardDef[],
  chars: CardDef[],
  all: CardDef[],
  options: GenerateOptions = {},
): BenchmarkSet {
  _qid = 0 // reset counter
  if (options.seed !== undefined) {
    rng = makeRng(options.seed)
  }

  const allQuestions: BenchmarkQuestion[] = []
  const enabledCategories = options.categories

  for (const gen of GENERATORS) {
    const qs = gen(cards, chars, all)
    for (const q of qs) {
      if (!enabledCategories || enabledCategories.includes(q.category)) {
        allQuestions.push(q)
      }
    }
  }

  const cap = options.maxQuestions ?? 500
  const questions = rng.shuffle(allQuestions).slice(0, cap)

  const catCount: Record<string, number> = {}
  for (const q of questions) {
    catCount[q.category] = (catCount[q.category] ?? 0) + 1
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceRoot: "packages/data/src",
      totalQuestions: questions.length,
      categories: catCount,
    },
    questions,
  }
}
