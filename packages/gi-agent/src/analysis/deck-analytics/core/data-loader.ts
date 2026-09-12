// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Data Loader — extracts character and card data from TypeScript source files.
 *
 * Strategy: read .ts files as text and regex-extract structured data.
 * This avoids importing the full game engine (heavy, circular deps).
 * Consistent with the eval-char-comb approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CharacterData, SkillData, SkillCost, SkillType,
  CardData, CardCategory, ColoredCost, ElementType,
} from "./types.js";
import { ALL_ELEMENTS, damageTypeToElement, zeroCost } from "./types.js";
import { extractDoBlock, parseDoBlock, mergeDoBlockResults } from "./do-block-parser.js";

// ── Helpers ───────────────────────────────────────────────────

/** Normalize element name from TypeScript method name: "costPyro" → "pyro" */
function methodToElement(method: string): ElementType | null {
  const el = method.replace(/^cost/, "").toLowerCase() as ElementType;
  return ALL_ELEMENTS.includes(el) ? el : null;
}

/** Normalize DamageType enum: "DamageType.Cryo" → "Cryo" */
function stripDamageType(s: string): string {
  return s.replace(/^DamageType\./, "");
}

// ── Character Parser ──────────────────────────────────────────

const CHAR_SKILL_RE = /export\s+const\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*skill\((\d+)\)/g;
const CHAR_DEF_RE = /export\s+const\s+(\w+)\s*=\s*character\((\d+)\)/;
const CHAR_HEALTH_RE = /\.health\((\d+)\)/;
const CHAR_ENERGY_RE = /\.energy\((\d+)\)/;
const CHAR_TAGS_RE = /\.tags\(([^)]+)\)/;

/** Extract quoted strings from comma-separated .tags() argument */
function parseTags(raw: string): string[] {
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Parse a single .ts character file → CharacterData with all skills.
 */
export function parseCharacterFile(filePath: string): CharacterData | null {
  const content = fs.readFileSync(filePath, "utf-8");

  // ── Character definition ──
  const charMatch = CHAR_DEF_RE.exec(content);
  if (!charMatch) return null;
  const charName = charMatch[1];
  const charId = parseInt(charMatch[2], 10);

  const healthMatch = CHAR_HEALTH_RE.exec(content);
  const health = healthMatch ? parseInt(healthMatch[1], 10) : 10;

  const energyMatch = CHAR_ENERGY_RE.exec(content);
  const maxEnergy = energyMatch ? parseInt(energyMatch[1], 10) : 2;

  const tagsMatch = CHAR_TAGS_RE.exec(content);
  const tags = tagsMatch ? parseTags(tagsMatch[1]) : [];

  // Determine element from tags (always first tag)
  const element = (tags[0] as ElementType | undefined) ?? "pyro";

  // ── Skills ──
  const skills: SkillData[] = [];
  const skillMatches = content.matchAll(CHAR_SKILL_RE);

  for (const sm of skillMatches) {
    const skillName = sm[1];
    const skillId = parseInt(sm[2], 10);

    // Find the skill definition block (from "= skill(ID)" to ".done()")
    const skillStart = sm.index!;
    const afterSkill = content.slice(skillStart);
    const doneIdx = afterSkill.indexOf(".done()");
    const block = doneIdx >= 0 ? afterSkill.slice(0, doneIdx) : afterSkill.slice(0, 400);

    // Type
    const typeMatch = block.match(/\.type\("(\w+)"\)/);
    let skillType: SkillType = "normal";
    if (typeMatch) {
      const t = typeMatch[1];
      if (t === "normal" || t === "elemental" || t === "burst" || t === "passive" || t === "technique") {
        skillType = t;
      }
    }

    // Cost
    const cost = zeroCost();

    // costElement(N) → e.g. .costPyro(3)
    for (const el of ALL_ELEMENTS) {
      const re = new RegExp(`\\.cost${el[0].toUpperCase() + el.slice(1)}\\((\\d+)\\)`);
      const m = block.match(re);
      if (m) cost.colored.push({ element: el, count: parseInt(m[1], 10) });
    }

    // costVoid(N)
    const voidMatch = block.match(/\.costVoid\((\d+)\)/);
    if (voidMatch) cost.void = parseInt(voidMatch[1], 10);

    // costSame(N)
    const sameMatch = block.match(/\.costSame\((\d+)\)/);
    if (sameMatch) cost.same = parseInt(sameMatch[1], 10);

    // costEnergy(N)
    const energyMatch2 = block.match(/\.costEnergy\((\d+)\)/);
    if (energyMatch2) cost.energy = parseInt(energyMatch2[1], 10);

    // Damage — simple .damage(DamageType.X, N) pattern (NOT inside .do() blocks)
    // Filter out any .damage() calls that appear inside .do(...) blocks
    const rawDamageMatches = block.matchAll(/\.damage\(DamageType\.(\w+),\s*(\d+)(?:,\s*"[^"]*")?\)/g);
    const damage: { type: string; amount: number }[] = [];
    for (const dm of rawDamageMatches) {
      // Check if this .damage() is inside a .do() block by seeing if there's an unclosed .do(
      const before = block.slice(0, dm.index);
      const doOpens = (before.match(/\.do\(/g) || []).length;
      const doCloses = (before.match(/\.done\(\)/g) || []).length;
      // If more .do( than .done(), we're inside a .do() → skip (complex skill, not simple damage)
      if (doOpens <= doCloses) {
        damage.push({ type: dm[1], amount: parseInt(dm[2], 10) });
      }
    }

    // Summon creation (from dot-chain .summon())
    let createsSummon = /\.summon\(/.test(block);

    // Attempt .do() block parsing for complex skills
    const doBlock = extractDoBlock(block);
    let doResult = null;
    if (doBlock) {
      doResult = parseDoBlock(doBlock);
    }
    const merged = mergeDoBlockResults(damage, doResult, createsSummon);

    skills.push({
      definitionId: skillId,
      name: skillName,
      type: skillType,
      cost,
      damage: merged.damage,
      createsSummon: merged.createsSummon,
    });
  }

  return {
    definitionId: charId,
    name: charName,
    element,
    health,
    maxEnergy,
    tags,
    skills,
  };
}

// ── Card Parser ───────────────────────────────────────────────

const CARD_DEF_RE = /export\s+const\s+(\w+)\s*=\s*card\((\d+)\)/;

/** Detect card category from the chain calls */
function detectCardCategory(block: string): CardCategory {
  if (/\.talent\(/.test(block)) return "talent";
  if (/\.weapon\(/.test(block)) return "weapon";
  if (/\.artifact\(/.test(block)) return "artifact";
  if (/\.food\(/.test(block)) return "food";
  if (/\.equipment\(/.test(block)) return "equipment";
  if (/\.support\(/.test(block)) return "support";
  if (/\.event\(/.test(block)) return "event";
  return "event";
}

/**
 * Parse a single .ts card file → CardData[] (one file may contain multiple cards).
 */
export function parseCardFile(filePath: string): CardData[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const cards: CardData[] = [];

  const cardMatches = content.matchAll(CARD_DEF_RE);
  for (const cm of cardMatches) {
    const cardName = cm[1];
    const cardId = parseInt(cm[2], 10);

    // Find card block
    const start = cm.index!;
    const after = content.slice(start);
    const doneIdx = after.indexOf(".done()");
    const block = doneIdx >= 0 ? after.slice(0, doneIdx) : after.slice(0, 400);

    const category = detectCardCategory(block);

    // Cost
    const cost = zeroCost();
    for (const el of ALL_ELEMENTS) {
      const re = new RegExp(`\\.cost${el[0].toUpperCase() + el.slice(1)}\\((\\d+)\\)`);
      const m = block.match(re);
      if (m) cost.colored.push({ element: el, count: parseInt(m[1], 10) });
    }
    const voidMatch2 = block.match(/\.costVoid\((\d+)\)/);
    if (voidMatch2) cost.void = parseInt(voidMatch2[1], 10);
    const sameMatch2 = block.match(/\.costSame\((\d+)\)/);
    if (sameMatch2) cost.same = parseInt(sameMatch2[1], 10);

    // Talent character ID (for .talent(Lyney) pattern)
    let characterId: number | undefined;
    const talentMatch = block.match(/\.talent\((\w+)\)/);
    if (talentMatch) {
      // Try to find the character's definitionId from the character variable reference
      // We can't resolve this statically without loading all characters first
      // Store the variable name and resolve later
      characterId = undefined; // resolved by resolveCharacterRefs()
    }

    // Effect tags from @description comments (simple extraction)
    const descMatch = content.slice(
      Math.max(0, start - 500),
      start
    ).match(/@description\s*\n\s*\*\s*(.+)/);
    const effectTags: string[] = [];
    if (descMatch) {
      const desc = descMatch[1];
      if (/伤害\+/.test(desc)) effectTags.push("damage_boost");
      if (/少花费/.test(desc)) effectTags.push("cost_reduction");
      if (/生成.*骰/.test(desc)) effectTags.push("dice_generation");
      if (/充能/.test(desc)) effectTags.push("energy_gain");
      if (/抓\d/.test(desc)) effectTags.push("draw");
      if (/治疗/.test(desc)) effectTags.push("heal");
    }

    cards.push({
      definitionId: cardId,
      name: cardName,
      category,
      cost,
      characterId,
      effectTags,
    });
  }

  return cards;
}

// ── Bulk Loaders ──────────────────────────────────────────────

const DATA_SRC = path.resolve(
  import.meta.dirname ?? __dirname,
  "../../../../../data/src"
);

/**
 * Load ALL character data from packages/data/src/characters/
 */
export function loadAllCharacters(): CharacterData[] {
  const charsDir = path.join(DATA_SRC, "characters");
  const chars: CharacterData[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const data = parseCharacterFile(full);
        if (data) chars.push(data);
      }
    }
  }

  walk(charsDir);
  return chars;
}

/**
 * Load ALL card data from packages/data/src/cards/
 */
export function loadAllCards(): CardData[] {
  const cardsDir = path.join(DATA_SRC, "cards");
  const cards: CardData[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        cards.push(...parseCardFile(full));
      }
    }
  }

  walk(cardsDir);
  return cards;
}
