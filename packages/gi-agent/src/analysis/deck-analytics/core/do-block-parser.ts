// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Do-block parser — extracts damage and summon data from `.do((c) => { ... })` blocks.
 *
 * These blocks contain imperative game-logic code that our simple regex parser
 * cannot extract from the dot-chain pattern. Example:
 *
 *   .do((c) => {
 *     c.damage(DamageType.Pyro, 2);
 *     c.summon(GrinmalkinHat);
 *     if (c.self.health >= 6) {
 *       c.damage(DamageType.Piercing, 1, "@self");
 *     }
 *   })
 *
 * We extract:
 *   1. c.damage(DamageType.X, N [, "@self"]) → damage entries
 *   2. c.summon(Name) → summon creation flag
 *   3. Simple conditions (health threshold, status check)
 */

export interface DoBlockDamage {
  type: string;       // DamageType enum value, e.g. "Pyro", "Piercing"
  amount: number;
  target: string;     // "opponent" | "self"
  condition?: string; // e.g. "c.self.health >= 6"
  /** Whether this is the primary damage or a side effect (self-damage, etc.) */
  sideEffect: boolean;
}

export interface DoBlockResult {
  damages: DoBlockDamage[];
  createsSummon: boolean;
  /** Whether this skill has self-damage effects (relevant for risk assessment) */
  hasSelfDamage: boolean;
}

/**
 * Parse a .do() block and extract structured damage data.
 *
 * @param block — the raw text content of the .do() block (between .do( and the closing }))
 */
export function parseDoBlock(block: string): DoBlockResult {
  const result: DoBlockResult = {
    damages: [],
    createsSummon: false,
    hasSelfDamage: false,
  };

  // Extract c.damage(DamageType.X, N) — target opponent
  const damageRe = /c\.damage\(DamageType\.(\w+),\s*(\d+)\)/g;
  for (const match of block.matchAll(damageRe)) {
    // Check if this damage is inside a conditional
    const before = block.slice(0, match.index!);
    const condition = extractCondition(before);

    result.damages.push({
      type: match[1],
      amount: parseInt(match[2], 10),
      target: "opponent",
      condition,
      sideEffect: false,
    });
  }

  // Extract c.damage(DamageType.X, N, "@self") — self damage
  const selfDamageRe = /c\.damage\(DamageType\.(\w+),\s*(\d+),\s*"@self"\)/g;
  for (const match of block.matchAll(selfDamageRe)) {
    const before = block.slice(0, match.index!);
    const condition = extractCondition(before);

    result.damages.push({
      type: match[1],
      amount: parseInt(match[2], 10),
      target: "self",
      condition,
      sideEffect: true,
    });
    result.hasSelfDamage = true;
  }

  // Extract c.summon(Name)
  if (/c\.summon\(/.test(block)) {
    result.createsSummon = true;
  }

  return result;
}

/**
 * Extract the condition from code before a damage call.
 * Looks for the nearest `if (...)` condition.
 */
function extractCondition(codeBefore: string): string | undefined {
  // Find the last if-statement before this point
  const ifMatch = codeBefore.match(/if\s*\(([^)]+)\)\s*\{[^}]*$/);
  if (ifMatch) {
    return ifMatch[1].trim();
  }
  return undefined;
}

/**
 * Extract the .do() block content from a skill definition.
 * Returns the text between .do( and the matching closing brace.
 */
export function extractDoBlock(skillBlock: string): string | null {
  const doIdx = skillBlock.indexOf(".do(");
  if (doIdx < 0) return null;

  // Find the matching closing brace
  let depth = 0;
  let inBlock = false;
  let start = -1;
  let end = -1;

  for (let i = doIdx; i < skillBlock.length; i++) {
    const ch = skillBlock[i];
    if (ch === "(" && !inBlock) {
      depth++;
      if (depth === 2 && start < 0) {
        // Second '(' — the arrow function body
        // Find the opening brace
        const arrowBody = skillBlock.slice(i);
        const braceMatch = arrowBody.match(/\)\s*=>\s*\{/);
        if (braceMatch) {
          const bracePos = i + (braceMatch.index ?? 0) + (braceMatch[0].length - 1);
          start = bracePos + 1; // after opening brace
          depth = 1;
          inBlock = true;
          i = bracePos;
          continue;
        }
      }
    } else if (ch === ")" && !inBlock) {
      depth--;
    } else if (ch === "{" && inBlock) {
      depth++;
    } else if (ch === "}" && inBlock) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (start >= 0 && end >= 0) {
    return skillBlock.slice(start, end);
  }

  // Fallback: simple heuristic — find .do((...) => { ... })
  const simpleMatch = skillBlock.match(/\.do\([^)]*\)\s*=>\s*\{([^]*)\}\s*\)/);
  if (simpleMatch) {
    return simpleMatch[1];
  }

  return null;
}

/**
 * Merge do-block results with existing simple SkillData.
 */
export function mergeDoBlockResults(
  existingDamage: { type: string; amount: number }[],
  doResult: DoBlockResult | null,
  existingCreatesSummon: boolean,
): {
  damage: { type: string; amount: number }[];
  createsSummon: boolean;
  hasSelfDamage: boolean;
} {
  const damage = [...existingDamage];

  if (doResult) {
    // Add opponent-targeted damage (prioritize primary over side effects)
    for (const d of doResult.damages) {
      if (d.target === "opponent" && !d.sideEffect) {
        damage.push({ type: d.type, amount: d.amount });
      }
    }
  }

  return {
    damage,
    createsSummon: existingCreatesSummon || (doResult?.createsSummon ?? false),
    hasSelfDamage: doResult?.hasSelfDamage ?? false,
  };
}
