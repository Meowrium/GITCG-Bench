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

/** Card definition extracted from source JSDoc */
export interface CardDef {
  definitionId: number
  name: string
  description: string
  type: string       // "character:pyro" | "equipment" | "event" | "support"
  tags: string[]
  cost: number       // total dice cost
  kind: CardKind     // "card" | "character" | "skill" | "summon" | "status" | "combatStatus"
  since: string | null
  sourcePath: string
  /** Character base health (from `.health(N)`) */
  health?: number
  /** Character base energy (from `.energy(N)`) */
  energy?: number
  /** Character special energy slot size (from `.specialEnergy("...", N)`) */
  specialEnergy?: number
}

export type CardKind =
  | "card"
  | "character"
  | "skill"
  | "summon"
  | "status"
  | "combatStatus"
  | "extension"
  | "entity"
  | "unknown"

export type QuestionCategory =
  | "card-name-to-effect"          // 卡牌名 → 效果
  | "effect-to-card-name"          // 效果描述 → 卡牌名
  | "card-cost"                    // 卡牌费用
  | "card-type"                    // 卡牌类型
  | "card-tags"                    // 卡牌标签
  | "character-element"            // 角色元素
  | "character-stats"              // 角色属性(HP/充能)
  | "character-skills"             // 角色技能
  | "version-introduced"           // 版本信息
  | "weapon-type"                  // 武器类型
  | "nation"                       // 国家阵营
  | "multiple-answer"              // 多答案题
  | "skill-cost"                   // 技能费用
  | "cost-deduction"               // 费用减免
  | "from-description-find-name"   // 根据描述找名字
  | "card-effect-match"            // 卡牌匹配

export interface BenchmarkQuestion {
  id: string
  category: QuestionCategory
  /** The question text presented to the LLM */
  question: string
  /** Ground-truth answer(s) */
  groundTruth: string | string[]
  /** For scoring: acceptable answer patterns (keyword matching) */
  keywords: string[]
  /** Source card id(s) for traceability */
  sourceIds: number[]
  /** Difficulty hint */
  difficulty: "easy" | "medium" | "hard"
  /**
   * True if the answer overlaps with Genshin Impact本体知识
   * (element, weapon, nation — same in both games).
   * These can be filtered out for a pure TCG-knowledge score.
   */
  overlap?: boolean
}

export interface BenchmarkSet {
  meta: {
    generatedAt: string
    sourceRoot: string
    totalQuestions: number
    categories: Record<string, number>
  }
  questions: BenchmarkQuestion[]
}

export interface EvaluationResult {
  questionId: string
  category: QuestionCategory
  question: string
  groundTruth: string | string[]
  llmAnswer: string
  passed: boolean
  score: number  // 0-1
  details: string
}
