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
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { Mutation } from "@gi-tcg/core";

export interface ActionEffectV1 {
  round: number;
  who: 0 | 1;
  actionType: "combat" | "fast" | "other";
  skillUsed: {
    callerDefinitionId: number;
    skillDefinitionId: number;
  } | null;
  damageDealt: Array<{
    targetDefinitionId: number;
    value: number;
    type: number;
    causeDefeated: boolean;
  }>;
  reactions: Array<{ type: number }>;
  switchActiveToDefinitionId: number | null;
  declaredEnd: boolean;
  /** Natural language summary of the action, e.g. "后手使用「星斗归位」对前台角色造成3点雷元素伤害" */
  description: string;
}

interface ExtractedDamage {
  targetDefinitionId: number;
  value: number;
  type: number;
  causeDefeated: boolean;
}

/**
 * Extracts a human-readable effect summary from a batch of mutations.
 */
function extractEffects(mutations: readonly Mutation[]): {
  skillUsed: { callerDefinitionId: number; skillDefinitionId: number } | null;
  damages: ExtractedDamage[];
  reactions: { type: number }[];
  switchActiveTo: number | null;
  declaredEnd: boolean;
} {
  let skillUsed: { callerDefinitionId: number; skillDefinitionId: number } | null = null;
  const damages: ExtractedDamage[] = [];
  const reactions: { type: number }[] = [];
  let switchActiveTo: number | null = null;
  let declaredEnd = false;

  for (const m of mutations) {
    switch (m.type) {
      case "pushRoundSkillLog": {
        skillUsed = {
          callerDefinitionId: m.caller.definition.id,
          skillDefinitionId: m.skillId,
        };
        break;
      }
      case "pushPhaseDamageLog": {
        const di = m.damageEvent.damageInfo;
        damages.push({
          targetDefinitionId: di.target.definition.id,
          value: di.value,
          type: di.type,
          causeDefeated: !!di.causeDefeated,
        });
        break;
      }
      case "pushPhaseReactionLog": {
        reactions.push({ type: m.reactionEvent.reactionInfo.type });
        break;
      }
      case "switchActive": {
        switchActiveTo = m.value.definition.id;
        break;
      }
      case "setPlayerFlag": {
        if (m.flagName === "declaredEnd" && m.value) {
          declaredEnd = true;
        }
        break;
      }
    }
  }

  return { skillUsed, damages, reactions, switchActiveTo, declaredEnd };
}

/**
 * Accumulates mutations across micro-pauses and segments them
 * at action boundaries (canResume pauses within action phase).
 */
export class McpActionEffectTracker {
  private pendingMutations: Mutation[] = [];
  private segments: ActionEffectV1[] = [];
  private lastSegmentWho: 0 | 1 | null = null;
  private nameResolver: (id: number) => string | null;

  constructor(nameResolver?: (id: number) => string | null) {
    this.nameResolver = nameResolver ?? (() => null);
  }

  setNameResolver(resolver: (id: number) => string | null): void {
    this.nameResolver = resolver;
  }

  /**
   * Build natural language description for an action segment.
   */
  private buildDescription(
    who: 0 | 1,
    actionType: "combat" | "fast",
    skillUsed: { callerDefinitionId: number; skillDefinitionId: number } | null,
    damages: ExtractedDamage[],
    switchActiveTo: number | null,
    declaredEnd: boolean,
  ): string {
    const R = this.nameResolver;
    const whoLabel = who === 0 ? "先手" : "后手";
    const typeLabel = actionType === "combat" ? "战斗行动" : "快速行动";
    const parts: string[] = [];

    if (skillUsed) {
      const skillName = R(skillUsed.skillDefinitionId);
      const callerName = R(skillUsed.callerDefinitionId);
      parts.push(
        skillName
          ? `使用「${skillName}」`
          : `使用技能[${skillUsed.skillDefinitionId}]`,
      );
    }

    for (const d of damages) {
      const targetName = R(d.targetDefinitionId);
      const dmgTypes = ["物理", "冰", "水", "火", "雷", "风", "岩", "草", "穿透", "治疗"];
      const typeName = dmgTypes[d.type] ?? `伤害类型[${d.type}]`;
      parts.push(
        `对${targetName ?? `角色[${d.targetDefinitionId}]`}造成${d.value}点${typeName}伤害${d.causeDefeated ? "（击倒）" : ""}`,
      );
    }

    if (switchActiveTo) {
      const charName = R(switchActiveTo);
      parts.push(`切换到${charName ?? `角色[${switchActiveTo}]`}`);
    }

    if (declaredEnd) {
      parts.push("宣布结束");
    }

    if (parts.length === 0) {
      return `${whoLabel}${typeLabel}`;
    }

    return `${whoLabel}${typeLabel}：${parts.join("；")}`;
  }

  /**
   * Feed mutations from each onPause call.
   */
  feed(
    mutations: readonly Mutation[],
    canResume: boolean,
    phase: string,
    round: number,
    currentTurn: 0 | 1,
  ): void {
    this.pendingMutations.push(...mutations);

    if (canResume && phase === "action") {
      const hasSwitchTurn = this.pendingMutations.some(
        (m) => m.type === "switchTurn",
      );
      const who: 0 | 1 = hasSwitchTurn ? (1 - currentTurn) as 0 | 1 : currentTurn;
      const actionType: "combat" | "fast" | "other" = hasSwitchTurn ? "combat" : "fast";

      const { skillUsed, damages, reactions, switchActiveTo, declaredEnd } =
        extractEffects(this.pendingMutations);

      const description = this.buildDescription(
        who, actionType, skillUsed, damages, switchActiveTo, declaredEnd,
      );

      this.segments.push({
        round,
        who,
        actionType,
        skillUsed,
        damageDealt: damages,
        reactions,
        switchActiveToDefinitionId: switchActiveTo,
        declaredEnd,
        description,
      });

      this.lastSegmentWho = who;
      this.pendingMutations = [];
    }
  }

  /**
   * Take all accumulated segments since last call and clear the buffer.
   */
  takeSegments(): ActionEffectV1[] {
    const result = this.segments;
    this.segments = [];
    return result;
  }

  /**
   * Peek at accumulated segments without clearing.
   */
  peekSegments(): readonly ActionEffectV1[] {
    return this.segments;
  }

  reset(): void {
    this.pendingMutations = [];
    this.segments = [];
    this.lastSegmentWho = null;
  }
}
