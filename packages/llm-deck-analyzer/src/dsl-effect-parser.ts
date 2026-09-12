// Copyright (C) 2024-2025 Guyutongxue
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
 * DSL 效果解析器：从 builder DSL 源码中提取结构化的 CardEffectData。
 *
 * 与描述文本正则相比，DSL 源码精确无歧义：
 * - .on("eventName") 直接映射到触发条件
 * - .damage()/.generateDice()/.drawCards() 等方法直接映射到效果信号
 *
 * 用于在 buildTriggerChainInfo 中替代/补充描述文本正则路径。
 */

import type {
  CardEffectData,
  ParsedSkill,
  ParsedTrigger,
  ParsedEffect,
  InternalEventName,
  TriggerKind,
  TriggerScope,
  EffectKind,
  TargetSpecifier,
  DamageTypeSpecifier,
} from "./effect-extractor/types"

// ── DSL event name → (InternalEventName, TriggerKind) 映射 ──
// 参考 core/src/builder/skill.ts 的 detailedEventDictionary

const DSL_EVENT_MAP: Record<string, { eventName: InternalEventName; kind: TriggerKind }> = {
  roll: { eventName: "modifyRoll", kind: "on_generate_dice" },
  addDice: { eventName: "modifyAction0", kind: "on_generate_dice" },
  deductElementDice: { eventName: "modifyAction1", kind: "on_play_card" },
  deductOmniDice: { eventName: "modifyAction2", kind: "on_play_card" },
  deductOmniDiceSwitch: { eventName: "modifyAction2", kind: "on_swap" },
  deductOmniDiceCard: { eventName: "modifyAction2", kind: "on_play_card" },
  deductAllDiceCard: { eventName: "modifyAction3", kind: "on_play_card" },
  deductVoidDiceSkill: { eventName: "modifyAction0", kind: "on_skill_use" },
  deductElementDiceSkill: { eventName: "modifyAction1", kind: "on_skill_use" },
  deductOmniDiceSkill: { eventName: "modifyAction2", kind: "on_skill_use" },
  deductOmniDiceTechnique: { eventName: "modifyAction2", kind: "on_skill_use" },
  beforeFastSwitch: { eventName: "onAction", kind: "on_swap" },
  modifySkillDamageType: { eventName: "modifyDamage0", kind: "on_damage_increase" },
  increaseDamage: { eventName: "modifyDamage1", kind: "on_damage_increase" },
  increaseSkillDamage: { eventName: "modifyDamage1", kind: "on_damage_increase" },
  increaseTechniqueDamage: { eventName: "modifyDamage1", kind: "on_damage_increase" },
  multiplySkillDamage: { eventName: "modifyDamage2", kind: "on_damage_increase" },
  increaseDamaged: { eventName: "modifyDamage1", kind: "on_damaged" },
  multiplyDamaged: { eventName: "modifyDamage2", kind: "on_damaged" },
  decreaseDamaged: { eventName: "modifyDamage3", kind: "on_damaged" },
  cancelHealed: { eventName: "modifyHeal0", kind: "on_heal" },
  decreaseHealed: { eventName: "modifyHeal1", kind: "on_heal" },
  beforeDefeated: { eventName: "modifyZeroHealth", kind: "on_defeated_check" },
  battleBegin: { eventName: "onBattleBegin", kind: "on_battle_begin" },
  roundBegin: { eventName: "onRoundBegin", kind: "on_round_begin" },
  roundEnd: { eventName: "onRoundEnd", kind: "on_round_end" },
  actionPhase: { eventName: "onActionPhase", kind: "on_action_phase" },
  endPhase: { eventName: "onEndPhase", kind: "on_end_phase" },
  beforeAction: { eventName: "onBeforeAction", kind: "on_play_card" },
  replaceActionBySkill: { eventName: "replaceAction", kind: "on_skill_use" },
  action: { eventName: "onAction", kind: "on_play_card" },
  playCard: { eventName: "onPlayCard", kind: "on_play_card" },
  beforeSkill: { eventName: "onBeforeUseSkill", kind: "on_skill_use" },
  beforeTechnique: { eventName: "onBeforeUseSkill", kind: "on_skill_use" },
  useSkill: { eventName: "onUseSkill", kind: "on_skill_use" },
  useTechnique: { eventName: "onUseSkill", kind: "on_skill_use" },
  useSkillOrTechnique: { eventName: "onUseSkill", kind: "on_skill_use" },
  declareEnd: { eventName: "onAction", kind: "on_play_card" },
  switchActive: { eventName: "onSwitchActive", kind: "on_swap" },
  drawCard: { eventName: "onHandCardInserted", kind: "on_draw" },
  handCardInserted: { eventName: "onHandCardInserted", kind: "on_draw" },
  disposeCard: { eventName: "onDispose", kind: "on_discard" },
  disposeOrTuneCard: { eventName: "onDispose", kind: "on_discard" },
  dealDamage: { eventName: "onDamageOrHeal", kind: "on_damage_dealt" },
  skillDamage: { eventName: "onDamageOrHeal", kind: "on_damage_dealt" },
  damaged: { eventName: "onDamageOrHeal", kind: "on_damaged" },
  healed: { eventName: "onDamageOrHeal", kind: "on_heal" },
  damagedOrHealed: { eventName: "onDamageOrHeal", kind: "on_damaged" },
  modifyReaction: { eventName: "modifyReaction", kind: "on_reaction" },
  reaction: { eventName: "onReaction", kind: "on_reaction" },
  dealReaction: { eventName: "onReaction", kind: "on_reaction" },
  skillReaction: { eventName: "onReaction", kind: "on_reaction" },
  enter: { eventName: "onEnter", kind: "on_enter" },
  enterRelative: { eventName: "onEnter", kind: "on_enter" },
  dispose: { eventName: "onDispose", kind: "on_dispose" },
  selfDispose: { eventName: "onDispose", kind: "on_dispose" },
  defeated: { eventName: "onDamageOrHeal", kind: "on_defeated" },
  revive: { eventName: "onRevive", kind: "on_heal" },
  transformDefinition: { eventName: "onTransformDefinition", kind: "on_enter" },
  generateDice: { eventName: "onGenerateDice", kind: "on_generate_dice" },
  cancelConsumeNightsoul: { eventName: "modifyChangeVariable", kind: "on_variable_change" },
  consumeNightsoul: { eventName: "onChangeVariable", kind: "on_variable_change" },
  gainNightsoul: { eventName: "onChangeVariable", kind: "on_variable_change" },
  gainUsage: { eventName: "onChangeVariable", kind: "on_variable_change" },
  selectCard: { eventName: "onPlayCard", kind: "on_play_card" },
  adventure: { eventName: "onEnter", kind: "on_enter" },
  customEvent: { eventName: "onCustomEvent", kind: "on_custom" },
}

// ── DSL effect method → EffectKind 映射 ──

function parseDamageType(arg: string): DamageTypeSpecifier | undefined {
  const map: Record<string, DamageTypeSpecifier> = {
    "DamageType.Physical": "Physical",
    "DamageType.Pyro": "Pyro",
    "DamageType.Hydro": "Hydro",
    "DamageType.Cryo": "Cryo",
    "DamageType.Electro": "Electro",
    "DamageType.Dendro": "Dendro",
    "DamageType.Anemo": "Anemo",
    "DamageType.Geo": "Geo",
    "DamageType.Piercing": "Piercing",
  }
  return map[arg]
}

function parseNumeric(arg: string | undefined): number | string | undefined {
  if (!arg) return undefined
  const n = parseInt(arg, 10)
  return isNaN(n) ? arg : n
}

interface EffectMethodSpec {
  kind: EffectKind
  argExtractor?: (args: string[]) => Record<string, unknown>
  target?: TargetSpecifier
}

const DSL_EFFECT_METHODS: Record<string, EffectMethodSpec> = {
  damage: {
    kind: "damage",
    argExtractor: (args) => ({
      damageType: parseDamageType(args[0]),
      value: parseNumeric(args[1]),
    }),
  },
  heal: {
    kind: "heal",
    argExtractor: (args) => ({ value: parseNumeric(args[0]) }),
  },
  drawCards: {
    kind: "draw_cards",
    argExtractor: (args) => ({ count: parseNumeric(args[0]) }),
  },
  generateDice: {
    kind: "generate_dice",
    argExtractor: (args) => ({ diceType: args[0], count: parseNumeric(args[1]) }),
  },
  convertDice: {
    kind: "convert_dice",
    argExtractor: (args) => ({ count: parseNumeric(args[0]) }),
  },
  gainEnergy: {
    kind: "gain_energy",
    argExtractor: (args) => ({ value: parseNumeric(args[0]) }),
  },
  decreaseDamage: {
    kind: "decrease_damage",
    argExtractor: (args) => ({ value: parseNumeric(args[0]) }),
  },
  increaseDamage: {
    kind: "increase_damage",
    argExtractor: (args) => ({ value: parseNumeric(args[0]) }),
  },
  continueNextTurn: { kind: "continue_next_turn" },
  switchActive: {
    kind: "switch_active",
    argExtractor: (args) => ({ targetSpec: args[0] }),
  },
  disposeMaxCostHands: {
    kind: "dispose_hand",
    argExtractor: (args) => ({ count: parseNumeric(args[0]), strategy: "maxCost" }),
  },
  disposeCard: { kind: "dispose_hand" },
  createHandCard: {
    kind: "create_hand_card",
    argExtractor: (args) => ({ cardId: parseNumeric(args[0]) }),
  },
  createPileCards: { kind: "create_hand_card" },
  summon: {
    kind: "create_entity",
    argExtractor: () => ({ entityType: "summon" }),
  },
  combatStatus: {
    kind: "create_entity",
    argExtractor: () => ({ entityType: "combatStatus" }),
  },
  characterStatus: {
    kind: "create_entity",
    argExtractor: () => ({ entityType: "status" }),
  },
  support: {
    kind: "create_entity",
    argExtractor: () => ({ entityType: "support" }),
  },
  equip: { kind: "equip" },
  shield: {
    kind: "shield",
    argExtractor: (args) => ({ value: parseNumeric(args[0]) }),
  },
  revive: { kind: "revive" },
}

/**
 * 从方法调用行中提取参数。
 * 例如 .damage(DamageType.Cryo, 2, "opp active") → ["DamageType.Cryo", "2", "opp active"]
 */
function extractMethodArgs(line: string, method: string): string[] {
  const regex = new RegExp(`\\.${method}\\(([^)]*)\\)`)
  const match = line.match(regex)
  if (!match) return []
  return match[1]
    .split(",")
    .map((a) => a.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

/**
 * 检测 damage 调用的目标是否为自伤。
 * .damage(type, value, "my active") 或 target 包含 "my" → self_damage
 */
function detectSelfDamage(line: string, effect: ParsedEffect): ParsedEffect {
  if (effect.kind === "damage" && line.includes('"my')) {
    return { ...effect, kind: "self_damage", target: "my_active" }
  }
  return effect
}

/**
 * 解析单个技能块（从 .on/.once 开始到下一个 .on/.once/.done 之前）。
 * 返回 triggers + effects。
 */
function parseSkillBlock(
  lines: string[],
  startIdx: number,
  cardType: CardEffectData["type"],
): { triggers: ParsedTrigger[]; effects: ParsedEffect[]; nextIdx: number } {
  const triggers: ParsedTrigger[] = []
  const effects: ParsedEffect[] = []
  let scope: TriggerScope = cardType === "equipment" || cardType === "status" || cardType === "combatStatus" || cardType === "summon"
    ? "sameArea"
    : "samePlayer"
  let idx = startIdx
  let isFirstLine = true

  while (idx < lines.length) {
    const line = lines[idx].trim()

    // .on("event") 或 .once("event") — 先解析（起始行也是 .on）
    const onMatch = line.match(/^\.(on|once)\s*\(\s*"(\w+)"/)
    if (onMatch) {
      if (!isFirstLine) {
        // 遇到下一个 .on/.once → 结束当前技能块
        break
      }
      const dslEvent = onMatch[2]
      const mapping = DSL_EVENT_MAP[dslEvent]
      const eventName = mapping?.eventName ?? ("onCustomEvent" as InternalEventName)
      const kind = mapping?.kind ?? ("on_custom" as TriggerKind)
      const hasFilter = line.includes(",") || line.includes("=>")
      triggers.push({
        eventName,
        kind,
        scope,
        perRound: false,
        usageLimit: onMatch[1] === "once" ? 1 : null,
        duration: null,
        hasCustomFilter: hasFilter,
        filterDescription: hasFilter ? line.slice(0, 120) : undefined,
      })
      isFirstLine = false
      idx++
      continue
    }

    // 遇到 .done → 结束当前技能块
    if (/\.done\s*\(\s*\)/.test(line)) {
      break
    }

    // .listenToAll() / .listenToPlayer()
    if (line.includes(".listenToAll()")) {
      scope = "all"
      if (triggers.length > 0) triggers[triggers.length - 1].scope = "all"
      idx++
      continue
    }
    if (line.includes(".listenToPlayer()")) {
      scope = "samePlayer"
      if (triggers.length > 0) triggers[triggers.length - 1].scope = "samePlayer"
      idx++
      continue
    }

    // .usagePerRound(n) / .usage(n)
    const usageMatch = line.match(/^\.usage\s*\(\s*(\d+)/)
    if (usageMatch && triggers.length > 0) {
      triggers[triggers.length - 1].usageLimit = parseInt(usageMatch[1], 10)
      idx++
      continue
    }
    const usagePerRoundMatch = line.match(/^\.usagePerRound\s*\(\s*(\d+)/)
    if (usagePerRoundMatch && triggers.length > 0) {
      triggers[triggers.length - 1].usageLimit = parseInt(usagePerRoundMatch[1], 10)
      triggers[triggers.length - 1].perRound = true
      idx++
      continue
    }

    // 效果方法
    let effectParsed = false
    for (const [method, spec] of Object.entries(DSL_EFFECT_METHODS)) {
      if (line.includes(`.${method}(`)) {
        const args = extractMethodArgs(line, method)
        const effect: ParsedEffect = {
          kind: spec.kind,
          args: spec.argExtractor ? spec.argExtractor(args) : {},
        }
        if (spec.target) effect.target = spec.target
        // 检测自伤
        const finalEffect = method === "damage" ? detectSelfDamage(line, effect) : effect
        effects.push(finalEffect)
        effectParsed = true
        break
      }
    }
    if (effectParsed) {
      idx++
      continue
    }

    idx++
  }

  return { triggers, effects, nextIdx: idx }
}

/**
 * 从 DSL 源码提取 CardEffectData。
 * 源码格式为去 JSDoc 后的 builder 链式调用，如：
 *   card(322016).costSame(1).support("ally")
 *     .on("deductOmniDiceCard", ...).usagePerRound(1).deductOmniCost(1)
 *     .on("playCard", ...).usage(1).drawCards(1)
 *     .done();
 */
export function parseEffectFromDslSource(
  source: string,
  id: number,
  name: string,
  type: CardEffectData["type"],
  tags: string[] = [],
): CardEffectData | null {
  const lines = source.split("\n")
  const skills: ParsedSkill[] = []
  let isInitiative = true
  let hasOnBlock = false

  // 扫描 .on/.once 块
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const onMatch = line.match(/^\.(on|once)\s*\(/)
    if (!onMatch) continue

    hasOnBlock = true
    isInitiative = false
    const { triggers, effects, nextIdx } = parseSkillBlock(lines, i, type)
    skills.push({
      id: 0,
      triggers,
      effects,
      isInitiative: false,
      isDisposeEffect: triggers.some((t) => t.kind === "on_discard" || t.kind === "on_dispose"),
      doSameWhenDisposed: false,
    })
    i = nextIdx - 1 // -1 因为 for 循环会 i++
  }

  // 提取 initiative 效果（.on() 之前的效果方法，或无 .on() 的纯打出效果）
  const firstOnIdx = lines.findIndex((l) => /^\.(on|once)\s*\(/.test(l.trim()))
  const initLines = firstOnIdx >= 0 ? lines.slice(0, firstOnIdx) : lines
  const initEffects: ParsedEffect[] = []
  for (const line of initLines) {
    for (const [method, spec] of Object.entries(DSL_EFFECT_METHODS)) {
      if (line.includes(`.${method}(`)) {
        const args = extractMethodArgs(line, method)
        const effect: ParsedEffect = {
          kind: spec.kind,
          args: spec.argExtractor ? spec.argExtractor(args) : {},
        }
        if (spec.target) effect.target = spec.target
        initEffects.push(method === "damage" ? detectSelfDamage(line, effect) : effect)
        break
      }
    }
  }

  // 如果有 initiative 效果（打出时直接生效），加为 initiative skill
  if (initEffects.length > 0) {
    skills.unshift({
      id: 0,
      triggers: [{
        eventName: "onPlayCard" as InternalEventName,
        kind: "initiative" as TriggerKind,
        scope: "samePlayer" as TriggerScope,
        perRound: false,
        usageLimit: null,
        duration: null,
        hasCustomFilter: false,
      }],
      effects: initEffects,
      isInitiative: true,
      isDisposeEffect: false,
      doSameWhenDisposed: false,
    })
  }

  if (skills.length === 0) return null

  return {
    id,
    name,
    type,
    tags,
    isGenerated: false,
    skills,
    generatedBy: [],
  }
}
