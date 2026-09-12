// Copyright (C) 2024-2025 Guyutongxue
//
// Auto-generates SKILL_BASE_DAMAGE table for declare-end-constraints.ts.
//
// Reads @gi-tcg/data character source files and extracts base damage
// from .damage() builder calls in skill definitions.
//
// Usage: pnpm exec gnx scripts/generate-skill-damage-table.ts
// Output: stdout — a TypeScript Record<number, { normal, elemental, burst }>

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data", "src", "characters");

interface SkillDamage {
  id: number;
  type: string; // "normal" | "elemental" | "burst"
  damage: number;
}

interface CharDamage {
  id: number;
  name: string;
  element: string;
  skills: SkillDamage[];
}

function extractDamageFromFile(filepath: string): CharDamage | null {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n");

  // Extract character @id and @name from JSDoc
  const charIdMatch = content.match(/@id\s+(\d+)/);
  const charNameMatch = content.match(/@name\s+(.+)/);
  if (!charIdMatch || !charNameMatch) return null;

  const charId = parseInt(charIdMatch[1]);
  const charName = charNameMatch[1].trim();

  // Determine element from directory (e.g., "pyro", "hydro")
  const dirParts = filepath.split("/");
  const element = dirParts[dirParts.length - 2] ?? "unknown";

  // Find all skill definitions in the file
  // Pattern: @id XXXX followed by skill definition with .damage()
  const skillRegex = /@id\s+(\d+)\s*\n\s*\* @name\s+(.+?)\s*\n[\s\S]*?\.type\("(\w+)"\)[\s\S]*?\.damage\(\w+\.(\w+),\s*(\d+)\)/g;
  
  const skills: SkillDamage[] = [];
  
  // Simpler approach: find skill blocks and extract
  const skillBlocks = content.split(/\/\*\*\s*\n\s*\* @id \d+/);
  
  // Alternative: match each skill definition
  let match;
  while ((match = skillRegex.exec(content)) !== null) {
    const skillId = parseInt(match[1]);
    const skillName = match[2].trim();
    const skillType = match[3];
    const damageType = match[4]; // e.g., "Physical", "Hydro", "Pyro"
    const damage = parseInt(match[5]);
    
    // Skip non-initiative skills (they won't have .type())
    if (skillType === "normal" || skillType === "elemental" || skillType === "burst") {
      skills.push({ id: skillId, type: skillType, damage });
    }
  }

  if (skills.length === 0) return null;
  return { id: charId, name: charName, element, skills };
}

function main() {
  const chars: CharDamage[] = [];

  for (const elemDir of readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!elemDir.isDirectory()) continue;
    const elemPath = join(DATA_DIR, elemDir.name);
    
    for (const file of readdirSync(elemPath)) {
      if (!file.endsWith(".ts")) continue;
      const result = extractDamageFromFile(join(elemPath, file));
      if (result) chars.push(result);
    }
  }

  // Output as TypeScript Record
  console.log("// Auto-generated from @gi-tcg/data character definitions.");
  console.log("// Regenerate: pnpm exec gnx scripts/generate-skill-damage-table.ts");
  console.log("const SKILL_BASE_DAMAGE: Record<number, { normal: number; elemental: number; burst: number }> = {");
  
  for (const char of chars.sort((a, b) => a.id - b.id)) {
    const normal = char.skills.find(s => s.type === "normal")?.damage ?? 0;
    const elemental = char.skills.find(s => s.type === "elemental")?.damage ?? 0;
    const burst = char.skills.find(s => s.type === "burst")?.damage ?? 0;
    
    if (normal === 0 && elemental === 0 && burst === 0) continue;
    
    console.log(`  // ${char.name} (${char.element})`);
    console.log(`  ${char.id}: { normal: ${normal}, elemental: ${elemental}, burst: ${burst} },`);
  }
  
  console.log("};");
}

main();
