/**
 * Generator: scans @gi-tcg/data card definitions and produces
 * a complete CARD_EFFECT_HINTS table for MCTS rapid effect simulation.
 *
 * Usage: cd packages/gi-agent && pnpm exec gnx scripts/generate-card-hints.ts
 * Output: src/runtime/policy/card-effect-hints.generated.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const DATA_DIR = new URL("../../data/src", import.meta.url).pathname;

function* findFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* findFiles(full);
    } else if (entry.endsWith(".ts") && !entry.includes(".test.") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/** Classify by ID range (card type is implicit in the numbering scheme) */
function classifyById(definitionId: number): "equip" | "summonPlace" | "event" | "unknown" {
  const lo = Math.floor(definitionId / 1000);
  // Talent cards: 21xxxx (Mondstadt), 22xxxx (Liyue), etc.
  if (lo >= 210 && lo <= 280) return "equip";
  // Equipment: 31xxxx
  if (lo === 310 || lo === 311 || lo === 312 || lo === 313) return "equip";
  // Support: 32xxxx
  if (lo >= 320 && lo <= 329) return "summonPlace";
  // Event: 30xxxx, 33xxxx
  if (lo === 300 || lo === 330 || lo === 331 || lo === 332 || lo === 333) return "event";
  return "unknown";
}

function extractEffect(block: string): string | null {
  // Filter to code lines only (exclude JSDoc comments)
  const codeLines = block.split('\n')
    .filter(l => {
      const t = l.trim();
      return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**') && !t.startsWith('@');
    });
  const code = codeLines.join(' ');

  // Draw cards (priority: higher draw count = more impactful)
  const drawMatch = code.match(/drawCards\((\d+)\)/);
  if (drawMatch) return "draw1";  // simplified to draw1 for MCTS

  // Heal
  if (/\.heal\(|heal\(\d+/.test(code)) return "heal1";

  // Dice generation
  if (/generateDice\(/.test(code)) return "diceGen1";

  // Damage (piercing event cards)
  if (/damage\(/.test(code) && /piercing/i.test(code)) return "damage1";

  // Food cards: most apply buffs → approximate as heal
  if (/\.food\(/.test(code)) return "heal1";

  return null;
}

interface CardHint {
  definitionId: number;
  name: string;
  hint: string;
}

const allHints: CardHint[] = [];

// Scan card files
for (const fp of findFiles(join(DATA_DIR, "cards"))) {
  const text = readFileSync(fp, "utf-8");
  const blocks = text.split(/\n(?=\/\*\*)/);

  for (const block of blocks) {
    const idMatch = block.match(/@id\s+(\d{6})/);
    const nameMatch = block.match(/@name\s+(.+)/);
    if (!idMatch) continue;

    const defId = parseInt(idMatch[1]);
    const category = classifyById(defId);
    if (category === "unknown") continue;

    const name = nameMatch?.[1]?.trim() ?? "?";

    if (category === "equip") {
      allHints.push({ definitionId: defId, name, hint: "equip" });
    } else if (category === "summonPlace") {
      allHints.push({ definitionId: defId, name, hint: "summonPlace" });
    } else if (category === "event") {
      const effect = extractEffect(block);
      if (effect) {
        allHints.push({ definitionId: defId, name, hint: effect });
      }
      // else: event with unrecognizable effect → no hint (= empty simulation)
    }
  }
}

// Scan character talent cards
for (const fp of findFiles(join(DATA_DIR, "characters"))) {
  const text = readFileSync(fp, "utf-8");
  const blocks = text.split(/\n(?=\/\*\*)/);

  for (const block of blocks) {
    const idMatch = block.match(/@id\s+(\d{6})/);
    const nameMatch = block.match(/@name\s+(.+)/);
    if (!idMatch) continue;

    const defId = parseInt(idMatch[1]);
    const category = classifyById(defId);
    if (category === "equip") {
      allHints.push({ definitionId: defId, name: nameMatch?.[1]?.trim() ?? "?", hint: "equip" });
    }
  }
}

// Deduplicate by definitionId
const seen = new Set<number>();
const deduped = allHints.filter(c => {
  if (seen.has(c.definitionId)) return false;
  seen.add(c.definitionId);
  return true;
});
deduped.sort((a, b) => a.definitionId - b.definitionId);

// Generate output
const lines: string[] = [
  "// Auto-generated from @gi-tcg/data card definitions.",
  "// Regenerate: cd packages/gi-agent && pnpm exec gnx scripts/generate-card-hints.ts",
  "//",
  'import type { EngineActionInfo } from "../../mcts/index.js";',
  "",
  "/** Complete card effect hints for MCTS rapid simulation. */",
  "export const CARD_EFFECT_HINTS: Record<number, EngineActionInfo[\"cardEffectHint\"]> = {",
];

for (const card of deduped) {
  lines.push(`  ${card.definitionId}: "${card.hint}", // ${card.name}`);
}

lines.push("};");
lines.push("");

const output = lines.join("\n");
const outPath = "src/runtime/policy/card-effect-hints.generated.ts";
writeFileSync(outPath, output);

// Summary
const counts: Record<string, number> = {};
for (const c of deduped) counts[c.hint] = (counts[c.hint] || 0) + 1;
console.log(`Generated ${deduped.length} card hints → ${outPath}`);
for (const [hint, n] of Object.entries(counts).sort()) {
  console.log(`  ${hint}: ${n}`);
}

// Verify known cards
const check = {332001:"最好的伙伴", 332004:"运筹帷幄", 331001:"N/A", 333001:"绝云锅巴", 333005:"甜甜花酿鸡"};
const byId = new Map(deduped.map(c => [c.definitionId, c]));
for (const [id, name] of Object.entries(check)) {
  const c = byId.get(Number(id));
  console.log(`  verify ${id} (${name}): ${c ? c.hint + " ✓" : "MISSING ✗"}`);
}
