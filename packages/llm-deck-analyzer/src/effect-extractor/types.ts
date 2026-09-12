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

// ============================================================
// Step 0: Effect extraction types
// These types define the structured representation of card effects
// extracted from runtime EntityDefinition and AST builder DSL.
// ============================================================

/**
 * Internal event names from the game engine.
 * These are the `triggerOn` values found on TriggeredSkillDefinition.
 * Each corresponds to a specific game event that can trigger a skill.
 */
export type InternalEventName =
  | "onBattleBegin"
  | "onRoundBegin"
  | "onRoundEnd"
  | "onActionPhase"
  | "onEndPhase"
  | "modifyRoll"
  | "modifyAction0"
  | "modifyAction1"
  | "modifyAction2"
  | "modifyAction3"
  | "onAction"
  | "onBeforeUseSkill"
  | "onUseSkill"
  | "onBeforePlayCard"
  | "onPlayCard"
  | "onSwitchActive"
  | "onHandCardInserted"
  | "onReaction"
  | "onTransformDefinition"
  | "onGenerateDice"
  | "modifyChangeVariable"
  | "onChangeVariable"
  | "modifyDamage0"
  | "modifyDamage1"
  | "modifyDamage2"
  | "modifyDamage3"
  | "modifyHeal0"
  | "modifyHeal1"
  | "onDamageOrHeal"
  | "onEnter"
  | "onDispose"
  | "modifyZeroHealth"
  | "onRevive"
  | "onCustomEvent"
  | "onBeforeAction"
  | "replaceAction"
  | "modifyReaction"

/**
 * Semantic trigger category derived from internal event names.
 * Maps the ~30 game-internal events to ~15 human-readable trigger kinds
 * that represent the *player-facing* meaning of the trigger.
 */
export type TriggerKind =
  | "on_damaged"           // 受到伤害时 (modifyDamage3, onDamageOrHeal with isDamage)
  | "on_damage_dealt"      // 造成伤害时 (onDamageOrHeal with isDamage as source)
  | "on_defeated"          // 被击倒时 (onDamageOrHeal with causeDefeated)
  | "on_round_end"         // 回合结束时 (onRoundEnd)
  | "on_round_begin"       // 回合开始时 (onRoundBegin)
  | "on_swap"              // 切换角色时 (onSwitchActive)
  | "on_skill_use"         // 使用技能时 (onUseSkill, onBeforeUseSkill)
  | "on_play_card"         // 打出牌时 (onPlayCard)
  | "on_discard"           // 舍弃手牌时 (onDispose with isDiscard)
  | "on_dispose"           // 弃置实体时 (onDispose)
  | "on_draw"              // 抽牌时 (onHandCardInserted)
  | "on_reaction"          // 引发反应时 (onReaction)
  | "on_damage_increase"   // 造成伤害增加时 (modifyDamage1 as source)
  | "on_damage_decrease"   // 受到伤害减少时 (modifyDamage3)
  | "on_heal"              // 受到治疗时 (onDamageOrHeal with isHeal)
  | "on_enter"             // 进场时 (onEnter)
  | "on_generate_dice"     // 生成骰子时 (onGenerateDice)
  | "on_battle_begin"      // 战斗开始时 (onBattleBegin)
  | "on_defeated_check"    // 被击倒前 (modifyZeroHealth)
  | "on_action_phase"      // 行动阶段 (onActionPhase)
  | "on_end_phase"         // 结束阶段 (onEndPhase)
  | "on_variable_change"   // 变量变化时 (onChangeVariable)
  | "on_custom"            // 自定义事件 (onCustomEvent)
  | "initiative"           // 打出时主动技能 (not a trigger, but the card play effect)

/**
 * Semantic effect category - what a card/effect *does*.
 * Derived from builder method names and SkillContext methods.
 */
export type EffectKind =
  // 伤害类
  | "damage"               // 造成伤害
  | "self_damage"          // 对己方造成伤害
  | "increase_damage"      // 增加伤害
  | "decrease_damage"      // 减少伤害
  | "multiply_damage"      // 伤害乘除
  // 治疗类
  | "heal"                 // 治疗
  | "cancel_heal"          // 取消治疗
  | "decrease_heal"        // 减少治疗
  // 资源类
  | "generate_dice"        // 生成骰子
  | "convert_dice"         // 转换骰子
  | "draw_cards"           // 抓牌
  | "gain_energy"          // 获得充能
  // 弃牌类
  | "dispose_hand"         // 舍弃手牌 (specific or max-cost)
  | "do_same_when_disposed" // 弃置时复用效果
  // 创建实体类
  | "create_entity"        // 创建状态/召唤物/支援
  | "create_hand_card"     // 生成手牌
  | "equip"                // 装备
  | "transform"            // 转化定义
  // 变量/状态类
  | "add_variable"         // 增加变量值
  | "set_variable"         // 设置变量值
  | "consume_usage"        // 消耗使用次数
  // 行动类
  | "switch_active"        // 切换角色
  | "continue_next_turn"   // 额外行动
  | "use_skill"            // 使用技能
  // 元素附着
  | "apply_element"        // 附着元素
  // 护盾/免疫
  | "shield"               // 提供护盾
  | "immune"               // 免疫被击倒
  | "revive"               // 复活
  // 其他
  | "custom"               // 自定义逻辑 (.do() 闭包)

/**
 * Target specifier for effects.
 * Simple string union for common targeting patterns.
 */
export type TargetSpecifier =
  | "opp_active"           // 对方出战角色
  | "my_active"            // 己方出战角色
  | "self"                 // 自身（所附属角色/实体）
  | "all_opp"              // 所有对方角色
  | "all_my"               // 所有己方角色
  | "opp_off_field"        // 对方后台角色
  | "my_off_field"         // 己方后台角色
  | "event_target"          // 事件目标（运行时决定）
  | "unspecified"           // 未指定/复杂逻辑

/**
 * Damage type specifier matching the game's DamageType enum.
 */
export type DamageTypeSpecifier =
  | "Physical"
  | "Pyro"
  | "Hydro"
  | "Cryo"
  | "Electro"
  | "Dendro"
  | "Anemo"
  | "Geo"
  | "Piercing"

/**
 * Listen scope for triggered skills.
 * Determines which entities' events can trigger this skill.
 */
export type TriggerScope =
  | "self"          // Only the entity itself
  | "sameArea"      // Same character area (default for equipment/status)
  | "samePlayer"    // Same player side
  | "all"           // Both players

/**
 * Probability of a trigger chain occurring.
 * Used when the chain depends on game state (e.g., "discard highest cost card"
 * might or might not discard a specific card).
 */
export type ChainProbability = "certain" | "likely" | "possible"

/**
 * A parsed trigger condition extracted from a skill definition.
 */
export interface ParsedTrigger {
  /** Internal game event name */
  eventName: InternalEventName
  /** Semantic trigger category */
  kind: TriggerKind
  /** Listen scope (how far events propagate) */
  scope: TriggerScope
  /** Whether this trigger has a per-round usage limit */
  perRound: boolean
  /** Usage limit count (from varConfigs) */
  usageLimit: number | null
  /** Duration limit (from varConfigs) */
  duration: number | null
  /** Whether this is a filter-restricted trigger (has custom conditions) */
  hasCustomFilter: boolean
  /** Human-readable description of filter conditions, if known */
  filterDescription?: string
}

/**
 * A parsed effect (what a skill does when triggered).
 */
export interface ParsedEffect {
  /** Effect category */
  kind: EffectKind
  /** Effect-specific arguments */
  args: Record<string, unknown>
  /** Target of the effect */
  target?: TargetSpecifier
  /** Damage element, if applicable */
  damageType?: DamageTypeSpecifier
  /** Damage/heal value, if applicable */
  value?: number | string  // string for variable references like "solidarity"
  /** Entity ID being created, if applicable */
  createsEntityId?: number
  /** Entity name being created, if applicable */
  createsEntityName?: string
}

/**
 * A parsed skill within an entity (one trigger + its effects).
 */
export interface ParsedSkill {
  /** Unique ID from the SkillDefinition */
  id: number
  /** Trigger conditions (empty for initiative skills) */
  triggers: ParsedTrigger[]
  /** Effects produced by this skill */
  effects: ParsedEffect[]
  /** Whether this is the card's play action (vs a triggered passive) */
  isInitiative: boolean
  /** Whether this effect is triggered on card disposal */
  isDisposeEffect: boolean
  /** Whether this skill uses .doSameWhenDisposed() pattern */
  doSameWhenDisposed: boolean
}

/**
 * Complete effect data for a single card/entity.
 */
export interface CardEffectData {
  /** Entity/card ID */
  id: number
  /** Human-readable name (from assets) */
  name: string
  /** Entity type */
  type: "eventCard" | "equipment" | "support" | "status" | "combatStatus" | "summon"
  /** Tags from the EntityDefinition */
  tags: string[]
  /** Whether this is a generated (non-discoverable) card */
  isGenerated: boolean
  /** All skills (initiative + triggered) */
  skills: ParsedSkill[]
  /** Which deck cards generate this card (by ID) */
  generatedBy: number[]
  /** Whether this card uses the doSameWhenDisposed pattern */
  doSameWhenDisposed?: boolean
}

/**
 * A signal emitted by an effect that can trigger another card's skill.
 */
export interface EffectSignal {
  /** The card that produces this signal */
  sourceCardId: number
  sourceCardName: string
  /** What kind of signal */
  kind: SignalKind
  /** Which skill index produces this signal */
  skillIndex: number
  /** Optional target specifier for the signal */
  target?: TargetSpecifier
  /** Additional context */
  detail?: string
}

export type SignalKind =
  | "self_damage"          // Deals damage to own character (e.g., 噔噔)
  | "damage"              // Deals damage to enemy
  | "heal"                // Heals
  | "discard_hand"        // Causes hand card discard (e.g., 勘探钻机)
  | "create_hand_card"    // Generates a hand card (e.g., 夏沃蕾被动)
  | "create_entity"       // Creates a status/summon
  | "switch_active"       // Switches active character
  | "continue_action"     // Grants extra action (e.g., 自由的新风)
  | "generate_dice"       // Generates dice
  | "draw_cards"          // Draws cards
  | "defeat"              // Can defeat a character
  | "apply_element"       // Applies element aura
  | "gain_energy"         // Grants energy/charge to a character
  | "equip"               // Equips a card (talent/weapon/artifact) to a character
  | "shield"              // Provides shield/damage reduction
  | "amplify_damage"      // Increases/multiplies outgoing damage

/**
 * A trigger slot that receives a signal.
 */
export interface TriggerSlot {
  /** The card that has this trigger */
  cardId: number
  cardName: string
  /** The semantic trigger kind */
  kind: TriggerKind
  /** Internal event name */
  eventName: InternalEventName
  /** Listen scope */
  scope: TriggerScope
  /** Skill index */
  skillIndex: number
  /** Whether this trigger has custom filter conditions */
  hasCustomFilter: boolean
  /** Optional filter description */
  filterDescription?: string
}

/**
 * An edge in the trigger chain graph connecting two cards.
 */
export interface TriggerChainEdge {
  /** Signal source card */
  fromCardId: number
  fromCardName: string
  /** Signal receiving card */
  toCardId: number
  toCardName: string
  /** What edge type this represents */
  edgeType: "enables" | "amplifies" | "finishes" | "protects" | "stabilizes"
  /** The signal that triggers the chain */
  signal: SignalKind
  /** The trigger that receives the signal */
  trigger: TriggerKind
  /** Probability assessment */
  probability: ChainProbability
  /** Human-readable description */
  description: string
}

/**
 * A complete trigger chain (multi-step combo).
 */
export interface TriggerChain {
  /** Ordered steps in the chain */
  steps: TriggerChainStep[]
  /** Human-readable description of the entire chain */
  description: string
  /** All card IDs involved */
  involvedCardIds: number[]
  /** All entity names involved (including generated cards) */
  involvedEntityNames: string[]
  /** Chain length (number of edges) */
  chainLength: number
}

/**
 * A single step in a trigger chain.
 */
export interface TriggerChainStep {
  /** Card producing the effect */
  cardId: number
  cardName: string
  /** What this card does */
  effectKind: EffectKind | SignalKind
  /** Which card/entity receives this */
  targetCardId?: number
  targetEntityName?: string
  /** The trigger that connects to the next step */
  triggerKind?: TriggerKind
  /** Whether this step is from a generated card */
  isGenerated?: boolean
}

/**
 * Result of extracting effect data for all cards.
 */
export interface EffectExtractionResult {
  /** Map of card ID to effect data */
  effects: Map<number, CardEffectData>
  /** Reverse lookup: entity name → card ID */
  nameToId: Map<string, number>
  /** Reverse lookup: which cards generate which cards */
  generationGraph: Map<number, number[]>
}