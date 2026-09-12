// Copyright (C) 2025 Guyutongxue
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

import type { TurnDigestV1 } from "../scoring/types";

const AURA_LABELS: Record<number, string> = {
  1: "冰", 2: "水", 3: "火", 4: "雷",
  5: "风", 6: "岩", 7: "草",
};

const DICE_LABELS: Record<number, string> = {
  1: "冰", 2: "水", 3: "火", 4: "雷",
  5: "风", 6: "岩", 7: "草", 8: "万能",
};

const ACTION_CASE_LABELS: Record<string, string> = {
  useSkill: "技能",
  playCard: "打牌",
  switchActive: "切人",
  declareEnd: "结束",
  elementalTuning: "调和",
  chooseActive: "选出战",
  rerollDice: "重投骰子",
  switchHands: "换手牌",
  selectCard: "选卡",
};

type CharacterSummary = {
  id: number;
  hp: number;
  max_hp: number;
  energy: number;
  max_energy: number;
  alive: boolean;
  aura: number | null;
};

type ActiveEffect = {
  zone: string;
  definition_id: number;
  name: string;
  description: string;
  usage: number | null;
  shield: number | null;
};

type CandidateAction = {
  candidate_id: string;
  action_case: string;
  is_fast?: boolean;
  cost?: { required_cost?: Array<{ type: number; count: number }> };
  damage_estimate?: number;
  reaction_type?: string | null;
  reaction_bonus?: number;
  total_damage?: number;
  target_char_name?: string;
  target_hp_after?: number;
  kills?: boolean;
  dice_cost_detail?: {
    required: Record<string, number>;
    available: Record<string, number>;
    affordable: boolean;
    omni_needed: number;
  };
  self_energy_after?: number | null;
  aura_change?: string | null;
  tempo_value?: number;
  survival_risk?: number;
  tags?: string[];
  notes?: string[];
};

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

function safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function safeBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function safeArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function auraLabel(aura: number | null | undefined): string {
  if (aura == null || aura === 0) return "无";
  return AURA_LABELS[aura] ?? `aura_${aura}`;
}

function diceLabel(dice: number): string {
  return DICE_LABELS[dice] ?? `dice_${dice}`;
}

function extractCandidateIndex(candidateId: string): number | null {
  const match = candidateId.match(/cand_(?:.*?_)?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function renderCostLabel(requiredCost: Array<{ type: number; count: number }> | undefined): string {
  if (!requiredCost || requiredCost.length === 0) return "0费";
  const parts: string[] = [];
  for (const entry of requiredCost) {
    const t = entry.type;
    const n = entry.count;
    if (t === 0) {
      parts.push(`${n}任意`);
    } else if (t === 9) {
      parts.push(`${n}能量`);
    } else if (t === 8) {
      parts.push(`${n}对齐`);
    } else {
      parts.push(`${n}${diceLabel(t)}`);
    }
  }
  return parts.join("+") || "0费";
}

export class DigestRenderer {
  /**
   * Render a TurnDigestV1 as natural language text.
   * Covers ALL digest fields - zero information loss.
   */
  static render(digest: TurnDigestV1): string {
    const lines: string[] = [];
    const self = (digest.self_summary ?? {}) as Record<string, unknown>;
    const opp = (digest.opponent_summary ?? {}) as Record<string, unknown>;
    const res = (digest.resource_summary ?? {}) as Record<string, unknown>;

    const selfChars = safeArr<CharacterSummary>(self.characters);
    const oppChars = safeArr<CharacterSummary>(opp.characters);
    const selfActiveId = self.active_character_id;
    const oppActiveId = opp.active_character_id;
    const charDefs = digest.character_definitions ?? [];
    const cardDefs = digest.card_definitions ?? [];

    // ── 局面概要 ──
    lines.push("### 局面概要");
    const selfActive = selfChars.find((c) => c.id === selfActiveId) ?? selfChars[0];
    const oppActive = oppChars.find((c) => c.id === oppActiveId) ?? oppChars[0];
    const selfActiveName = this.lookupCharName(selfActive?.id, charDefs);
    const oppActiveName = this.lookupCharName(oppActive?.id, charDefs);
    lines.push(`- 回合 R${digest.round} | 你的出战：${selfActiveName}(${selfActive ? `HP:${selfActive.hp}/${selfActive.max_hp}, 能量:${selfActive.energy}/${selfActive.max_energy}, 附${auraLabel(selfActive.aura)}` : "未知"})`);
    lines.push(`- 对手出战：${oppActiveName}(${oppActive ? `HP:${oppActive.hp}/${oppActive.max_hp}, 能量:${oppActive.energy}/${oppActive.max_energy}, 附${auraLabel(oppActive.aura)}` : "未知"})`);

    const diceArr = safeArr<number>(res.dice);
    const diceDist = this.formatDiceDistribution(diceArr);
    const handCount = safeNum(self.hand_count, safeArr(cardDefs).length);
    const oppHandCount = safeNum(opp.hand_count);
    const deckRem = safeNum(self.deck_remaining_count);
    const oppDeckRem = safeNum(opp.deck_remaining_count);
    lines.push(`- 骰子：${diceDist} (${diceArr.length}个) | 手牌：${handCount}张 | 对手手牌：${oppHandCount}张 | 牌库：${deckRem}张 | 对手牌库：${oppDeckRem}张`);
    lines.push("");

    // ── 角色详情 ──
    lines.push("### 角色详情");
    lines.push("#### 我方角色");
    for (const c of selfChars) {
      const name = this.lookupCharName(c.id, charDefs);
      const active = c.id === selfActiveId ? " [出战]" : "";
      const aliveTag = c.alive ? "" : " [已阵亡]";
      lines.push(`- ${name}(id:${c.id}, HP:${c.hp}/${c.max_hp}, 能量:${c.energy}/${c.max_energy}, 附${auraLabel(c.aura)}${active}${aliveTag})`);
    }
    lines.push("#### 对手角色");
    for (const c of oppChars) {
      const name = this.lookupCharName(c.id, charDefs);
      const active = c.id === oppActiveId ? " [出战]" : "";
      const aliveTag = c.alive ? "" : " [已阵亡]";
      lines.push(`- ${name}(id:${c.id}, HP:${c.hp}/${c.max_hp}, 能量:${c.energy}/${c.max_energy}, 附${auraLabel(c.aura)}${active}${aliveTag})`);
    }
    lines.push("");

    // ── 场上效果 ──
    const selfEffects = safeArr<ActiveEffect>(self.active_effects);
    const oppEffects = safeArr<ActiveEffect>(opp.active_effects);
    if (selfEffects.length > 0 || oppEffects.length > 0) {
      lines.push("### 场上效果");
      if (selfEffects.length > 0) {
        lines.push("#### 我方");
        for (const e of selfEffects) {
          lines.push(`- [${e.zone}] ${e.name}(usage:${e.usage ?? "N/A"}, shield:${e.shield ?? "N/A"}) - ${this.truncate(e.description, 80)}`);
        }
      }
      if (oppEffects.length > 0) {
        lines.push("#### 对手");
        for (const e of oppEffects) {
          lines.push(`- [${e.zone}] ${e.name}(usage:${e.usage ?? "N/A"}, shield:${e.shield ?? "N/A"}) - ${this.truncate(e.description, 80)}`);
        }
      }
      lines.push("");
    }

    // ── 资源 ──
    lines.push("### 资源");
    lines.push(`- 骰子明细：${this.formatDiceList(diceArr)}`);
    const diceDistMap = res.dice_distribution as Record<string, number> | undefined;
    if (diceDistMap) {
      lines.push(`- 骰子分布：${Object.entries(diceDistMap).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    lines.push(`- 万能骰：${safeNum(res.omni_count)} | 骰子总数：${safeNum(res.dice_count)}`);
    lines.push(`- 手牌：${safeNum(res.cards_in_hand, handCount)}张 | 牌库剩余：${deckRem}张 | 对手牌库：${oppDeckRem}张`);
    lines.push(`- 传说牌已用：${safeBool(self.legend_used) ? "是" : "否"} | 对手传说牌已用：${safeBool(opp.legend_used) ? "是" : "否"}`);
    if (safeBool(opp.declared_end)) {
      lines.push(`- 对手已宣告结束 ✅`);
    }
    const costMods = safeArr<string>(res.cost_modifiers);
    if (costMods.length > 0) {
      lines.push(`- 费用修饰：${costMods.join("; ")}`);
    }
    const initSkills = safeArr<{ definition_id: number; cost: Array<{ type: number; count: number }> }>(self.initiative_skills);
    if (initSkills.length > 0) {
      lines.push(`- 初始技能：${initSkills.map((s) => `def_${s.definition_id}(${renderCostLabel(s.cost)})`).join(", ")}`);
    }
    lines.push("");

    // ── 关键信息 ──
    const keyInfoLines = this.renderKeyInfo(digest, selfChars, oppChars, selfActive, oppActive, oppActiveName);
    if (keyInfoLines.length > 0) {
      lines.push("### 关键信息");
      lines.push(...keyInfoLines);
      lines.push("");
    }

    // ── 可用操作（全量，按类型分组）──
    const candidates = safeArr<CandidateAction>(digest.candidate_actions);
    if (candidates.length > 0) {
      lines.push("### 可用操作（全量，按类型分组）");
      lines.push(...this.renderCandidatesGrouped(candidates, digest.pending_method));
      lines.push("");
    }

    // ── 手牌详情 ──
    const handCards = cardDefs.filter((c) => c.in_hand);
    if (handCards.length > 0) {
      lines.push("### 手牌详情");
      for (const c of handCards) {
        const count = c.count_in_hand && c.count_in_hand > 1 ? ` x${c.count_in_hand}` : "";
        const dur = c.duration ? ` [${c.duration}]` : "";
        lines.push(`- ${c.name}(${c.type}, ${c.cost}费${dur})${count} - ${this.truncate(c.effect_text, 80)}`);
      }
      lines.push("");
    }

    // ── 角色技能 ──
    if (charDefs.length > 0) {
      lines.push("### 角色技能");
      for (const cd of charDefs) {
        if (cd.skills && cd.skills.length > 0) {
          lines.push(`#### ${cd.name}(${cd.element}/${cd.weapon_type})`);
          for (const sk of cd.skills) {
            lines.push(`- ${sk.name}(${sk.cost}费): ${this.truncate(sk.description, 80)} [伤害类型:${sk.damage_type}]`);
          }
        }
      }
      lines.push("");
    }

    // ── 开局计划 ──
    if (digest.opening_plan) {
      const plan = digest.opening_plan;
      lines.push("### 开局计划");
      lines.push(`- 目标：${plan.global_goal}`);
      if (plan.turn1_3_priorities.length > 0) {
        lines.push(`- T1-3优先：${plan.turn1_3_priorities.join("; ")}`);
      }
      if (plan.risk_rules.length > 0) {
        lines.push(`- 风险规则：${plan.risk_rules.join("; ")}`);
      }
      if (plan.pivot_rules.length > 0) {
        lines.push(`- 转换规则：${plan.pivot_rules.join("; ")}`);
      }
      lines.push("");
    }

    // ── 斩杀威胁详情 ──
    if (digest.lethal_info) {
      const li = digest.lethal_info;
      const myThreats = li.my_kill_threats ?? [];
      const oppThreats = li.opponent_kill_threats ?? [];
      if (myThreats.length > 0 || oppThreats.length > 0) {
        lines.push("### 斩杀威胁详情");
        if (myThreats.length > 0) {
          lines.push("#### 我方可斩杀");
          for (const t of myThreats) {
            const targetName = this.lookupCharNameByDefId(t.target_definition_id, charDefs) ?? t.target;
            lines.push(`- ${targetName}(HP:${t.target_hp}, 预估伤害:${t.max_possible_damage}${t.likely_kill ? " ⚠️可斩杀" : ""}${t.requires_reaction ? " [需反应]" : ""})`);
          }
        }
        if (oppThreats.length > 0) {
          lines.push("#### 对手可斩杀我方");
          for (const t of oppThreats) {
            lines.push(`- id:${t.my_character_id}(HP:${t.my_hp}, 预估伤害:${t.max_possible_damage}${t.likely_kill ? " ⚠️高危" : ""})`);
          }
        }
        lines.push("");
      }
    }

    // ── 硬约束 ──
    if (digest.hard_constraints.length > 0) {
      lines.push("### 硬约束");
      for (const hc of digest.hard_constraints) {
        lines.push(`- ${hc}`);
      }
      lines.push("");
    }

    lines.push("请选择操作编号：");
    return lines.join("\n");
  }

  private static lookupCharName(charId: number | undefined, charDefs: TurnDigestV1["character_definitions"]): string {
    if (charId == null) return "未知";
    const def = charDefs.find((d) => d.id === charId);
    return def?.name ?? `角色${charId}`;
  }

  private static lookupCharNameByDefId(defId: number, charDefs: TurnDigestV1["character_definitions"]): string | null {
    const def = charDefs.find((d) => d.definition_id === defId);
    return def?.name ?? null;
  }

  private static formatDiceDistribution(dice: number[]): string {
    const counts: Record<string, number> = {};
    for (const d of dice) {
      const label = diceLabel(d);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return Object.entries(counts).map(([k, v]) => `${v}${k}`).join(" ");
  }

  private static formatDiceList(dice: number[]): string {
    if (dice.length === 0) return "无";
    return `[${dice.join(",")}]`;
  }

  private static truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.substring(0, max) + "...";
  }

  private static renderKeyInfo(
    digest: TurnDigestV1,
    selfChars: CharacterSummary[],
    oppChars: CharacterSummary[],
    selfActive: CharacterSummary | undefined,
    oppActive: CharacterSummary | undefined,
    oppActiveName: string,
  ): string[] {
    const lines: string[] = [];

    // 斩杀机会
    if (digest.lethal_info) {
      const myKills = (digest.lethal_info.my_kill_threats ?? []).filter((t) => t.likely_kill);
      if (myKills.length > 0) {
        lines.push(`- ⚠️ 斩杀机会：可击杀 ${myKills.length} 个对手角色`);
      }
      const oppKills = (digest.lethal_info.opponent_kill_threats ?? []).filter((t) => t.likely_kill);
      if (oppKills.length > 0) {
        lines.push(`- ⚠️ 被斩杀风险：对手可能击杀 ${oppKills.length} 个我方角色`);
      }
    }

    // 对手能量满
    if (oppActive && oppActive.max_energy > 0 && oppActive.energy >= oppActive.max_energy) {
      lines.push(`- ⚠️ 对手能量已满，大招就绪（${oppActiveName}）`);
    }

    // 对手已结束
    const opp = (digest.opponent_summary ?? {}) as Record<string, unknown>;
    if (safeBool(opp.declared_end)) {
      lines.push("- 对手已宣告结束 ✅ 本回合无响应风险");
    }

    // 我方角色濒危
    const selfEndangered = selfChars.filter((c) => c.alive && c.hp <= 3);
    for (const c of selfEndangered) {
      const name = this.lookupCharName(c.id, digest.character_definitions);
      lines.push(`- ⚠️ 我方角色濒危：${name}(HP:${c.hp})`);
    }

    // 对手角色濒危
    const oppEndangered = oppChars.filter((c) => c.alive && c.hp <= 3);
    for (const c of oppEndangered) {
      const name = this.lookupCharName(c.id, digest.character_definitions);
      lines.push(`- ⚠️ 对手角色濒危：${name}(HP:${c.hp})`);
    }

    // 我方能量满
    if (selfActive && selfActive.max_energy > 0 && selfActive.energy >= selfActive.max_energy) {
      const name = this.lookupCharName(selfActive.id, digest.character_definitions);
      lines.push(`- ✅ 我方大招就绪：${name}`);
    }

    return lines;
  }

  private static renderCandidatesGrouped(
    candidates: CandidateAction[],
    pendingMethod: string,
  ): string[] {
    const lines: string[] = [];

    // For non-action pending methods (chooseActive, switchHands, etc.),
    // render all candidates in a single list without grouping.
    if (pendingMethod !== "action") {
      for (const c of candidates) {
        const idx = extractCandidateIndex(c.candidate_id);
        const label = ACTION_CASE_LABELS[c.action_case] ?? c.action_case;
        const notes = safeArr<string>(c.notes).join(" | ");
        lines.push(`${idx ?? "?"}. [${label}] ${notes}`);
      }
      return lines;
    }

    // For "action" pending method, group by fast/slow/end
    const fastGroup: CandidateAction[] = [];
    const slowGroup: CandidateAction[] = [];
    const endGroup: CandidateAction[] = [];

    for (const c of candidates) {
      if (c.action_case === "declareEnd") {
        endGroup.push(c);
      } else if (c.is_fast === true) {
        fastGroup.push(c);
      } else {
        slowGroup.push(c);
      }
    }

    if (fastGroup.length > 0) {
      lines.push("#### 快速行动（执行后可继续行动）");
      for (const c of fastGroup) {
        lines.push(this.renderCandidateLine(c));
      }
      lines.push("");
    }

    if (slowGroup.length > 0) {
      lines.push("#### 慢速行动（执行后轮到对手）");
      for (const c of slowGroup) {
        lines.push(this.renderCandidateLine(c));
      }
      lines.push("");
    }

    if (endGroup.length > 0) {
      lines.push("#### 回合控制");
      for (const c of endGroup) {
        lines.push(this.renderCandidateLine(c));
      }
      lines.push("");
    }

    return lines;
  }

  private static renderCandidateLine(c: CandidateAction): string {
    const idx = extractCandidateIndex(c.candidate_id);
    const label = ACTION_CASE_LABELS[c.action_case] ?? c.action_case;
    const fastTag = c.is_fast === true ? "·快速" : c.action_case === "declareEnd" ? "" : "·慢速";
    const continueTag = c.is_fast === true ? " | ⏩可继续行动" : "";

    // Build description from notes
    const notes = safeArr<string>(c.notes);
    const descParts: string[] = [];

    // Extract key info from notes (first 2 notes usually contain name + effect)
    if (notes.length > 0) descParts.push(notes[0]);
    if (notes.length > 1) descParts.push(notes[1]);

    // Add damage info
    if (c.total_damage && c.total_damage > 0) {
      let dmgStr = `${c.total_damage}伤害`;
      if (c.reaction_type) {
        dmgStr += `+${c.reaction_type}`;
      }
      descParts.push(dmgStr);
    }

    // Add cost
    const requiredCost = c.cost?.required_cost;
    const costStr = renderCostLabel(requiredCost);
    descParts.push(costStr);

    // Add energy change
    if (c.self_energy_after != null) {
      descParts.push(`能量->${c.self_energy_after}`);
    }

    // Add target info
    if (c.target_char_name && c.target_char_name !== "none") {
      let targetStr = `目标:${c.target_char_name}`;
      if (c.target_hp_after != null) {
        targetStr += `(HP->${c.target_hp_after})`;
      }
      descParts.push(targetStr);
    }

    // Add kills flag
    if (c.kills === true) {
      descParts.push("⚠️可斩杀");
    }

    // Add dice affordability
    if (c.dice_cost_detail && !c.dice_cost_detail.affordable) {
      descParts.push(`❌骰子不足(需${c.dice_cost_detail.omni_needed}万能)`);
    }

    const desc = descParts.join(" | ");
    return `${idx ?? "?"}. [${label}${fastTag}] ${desc}${continueTag}`;
  }

  /**
   * Wrap a raw JSON tool result with rendered text appended.
   * This is the dual-channel output: raw JSON first, rendered text after.
   */
  static wrapToolResult(rawJson: string, digest: TurnDigestV1): string {
    const rendered = DigestRenderer.render(digest);
    return `${rawJson}\n\n--- rendered_text ---\n${rendered}`;
  }
}
