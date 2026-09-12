import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DamageType } from "@gi-tcg/typings";
import type {
  AdditionalDamage,
  DamageTypeValue,
  SummonProfile,
} from "./types.js";

export interface SourceDamageInfo {
  mainDamageType: DamageTypeValue;
  mainDamageValue: number;
  additionalDamage: AdditionalDamage[];
  createsSummon: boolean;
  summonProfile?: SummonProfile;
  createsStatus: boolean;
}

export interface SourceComplexityInfo {
  ifCount: number;
  doCount: number;
  onCount: number;
  hasCrossCharInteraction: boolean;
  hasStateMachine: boolean;
  requiresReactionTrigger: boolean;
  hasDeferredBurst: boolean;
}

const DAMAGE_TYPE_MAP: Record<string, DamageTypeValue> = {
  Physical: DamageType.Physical,
  Cryo: DamageType.Cryo,
  Hydro: DamageType.Hydro,
  Pyro: DamageType.Pyro,
  Electro: DamageType.Electro,
  Anemo: DamageType.Anemo,
  Geo: DamageType.Geo,
  Dendro: DamageType.Dendro,
  Piercing: DamageType.Piercing,
  Heal: DamageType.Heal,
};

const ELEMENT_DIRS = ["anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro"];

export async function parseAllCharacterSources(
  dataPackageSrcDir: string,
): Promise<{
  damageMap: Map<number, SourceDamageInfo>;
  complexityMap: Map<number, SourceComplexityInfo>;
}> {
  const damageMap = new Map<number, SourceDamageInfo>();
  const complexityMap = new Map<number, SourceComplexityInfo>();
  const charsDir = join(dataPackageSrcDir, "characters");

  for (const elemDir of ELEMENT_DIRS) {
    const dirPath = join(charsDir, elemDir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(join(dirPath, file), "utf-8");
      parseCharacterFile(source, damageMap, complexityMap);
    }
  }

  return { damageMap, complexityMap };
}

function parseCharacterFile(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
  complexityMap: Map<number, SourceComplexityInfo>,
): void {
  parseSkillBlocks(source, damageMap);
  parseSummonBlocks(source, damageMap);
  parseCharacterComplexity(source, complexityMap);
}

function parseSkillBlocks(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
): void {
  const skillBlockRegex = /skill\((\d+)\)\s*([\s\S]*?)\.done\(\)/g;
  let match: RegExpExecArray | null;

  while ((match = skillBlockRegex.exec(source)) !== null) {
    const skillId = parseInt(match[1], 10);
    const block = match[2];
    const dmgMatch = block.match(/\.damage\(DamageType\.(\w+),\s*(\d+)/);
    const mainDamageType = dmgMatch
      ? (DAMAGE_TYPE_MAP[dmgMatch[1]] ?? DamageType.Physical)
      : DamageType.Physical;
    const mainDamageValue = dmgMatch ? parseInt(dmgMatch[2], 10) : 0;

    const allDmg = [...block.matchAll(/\.damage\(DamageType\.(\w+),\s*(\d+)/g)];
    const additionalDamage: AdditionalDamage[] = allDmg.slice(1).map((d) => ({
      type: DAMAGE_TYPE_MAP[d[1]] ?? DamageType.Physical,
      value: parseInt(d[2], 10),
    }));

    damageMap.set(skillId, {
      mainDamageType,
      mainDamageValue,
      additionalDamage,
      createsSummon: /\.summon\(/.test(block),
      createsStatus: /\.combatStatus\(/.test(block) || /\.characterStatus\(/.test(block),
    });
  }
}

function parseSummonBlocks(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
): void {
  const summonBlockRegex = /summon\((\d+)\)\s*([\s\S]*?)\.done\(\)/g;
  let match: RegExpExecArray | null;

  while ((match = summonBlockRegex.exec(source)) !== null) {
    const entityId = parseInt(match[1], 10);
    const block = match[2];
    const epdMatch = block.match(/\.endPhaseDamage\(DamageType\.(\w+),\s*(\d+)/);
    if (!epdMatch) continue;

    const usageMatch = block.match(/\.usage\((\d+)/);
    const profile: SummonProfile = {
      definitionId: entityId,
      endPhaseDamage: parseInt(epdMatch[2], 10),
      endPhaseDamageElement: DAMAGE_TYPE_MAP[epdMatch[1]] ?? DamageType.Physical,
      duration: usageMatch ? parseInt(usageMatch[1], 10) : 1,
    };

    const varNameRegex = new RegExp(
      `(?:export\\s+)?(?:const|let)\\s+(\\w+)\\s*(?::\\s*\\w+)?\\s*=\\s*summon\\(${entityId}\\)`,
    );
    const varMatch = source.match(varNameRegex);
    if (!varMatch) continue;

    const refRegex = new RegExp(
      `skill\\((\\d+)\\)[\\s\\S]*?\\.summon\\(${varMatch[1]}\\)[\\s\\S]*?\\.done\\(\\)`,
      "g",
    );
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(source)) !== null) {
      const skillId = parseInt(refMatch[1], 10);
      const existing = damageMap.get(skillId);
      if (existing) {
        damageMap.set(skillId, {
          ...existing,
          createsSummon: true,
          summonProfile: profile,
        });
      }
    }
  }
}

function parseCharacterComplexity(
  source: string,
  complexityMap: Map<number, SourceComplexityInfo>,
): void {
  const charRegex = /character\((\d+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = charRegex.exec(source)) !== null) {
    const charId = parseInt(match[1], 10);
    const ifCount = (source.match(/\.if\s*\(/g) || []).length;

    complexityMap.set(charId, {
      ifCount,
      doCount: (source.match(/\.do\s*\(/g) || []).length,
      onCount: (source.match(/\.on\s*\(/g) || []).length,
      hasCrossCharInteraction: /customEvent|listenToPlayer|"all opp characters"|"all my characters"/.test(source),
      hasStateMachine:
        /stance|melee.*ranged|ranged.*melee|姿态|switchActive/.test(source) ||
        (ifCount >= 3 && /addVariable\("(?!usage|hintIcon)/.test(source)),
      requiresReactionTrigger: /getReaction|isReaction|Reaction\.|reaction|elementalReaction|Seed/.test(source),
      hasDeferredBurst:
        /usage\(0,?\s*\{[^}]*autoDispose:\s*false/.test(source) ||
        /addVariable\("usage"/.test(source),
    });
  }
}

export { parseSkillDamageFromSource, parseComplexityFromSource };

function parseSkillDamageFromSource(source: string): Map<number, SourceDamageInfo> {
  const map = new Map<number, SourceDamageInfo>();
  parseSkillBlocks(source, map);
  parseSummonBlocks(source, map);
  return map;
}

function parseComplexityFromSource(source: string): Map<number, SourceComplexityInfo> {
  const map = new Map<number, SourceComplexityInfo>();
  parseCharacterComplexity(source, map);
  return map;
}
