/**
 * SourceParser
 *
 * 从 @gi-tcg/data 的角色 TypeScript 源文件中用正则提取：
 * 1. 技能的 .damage(DamageType.X, N) 调用 → 伤害值
 * 2. .summon(Handle) / .combatStatus(Handle) → 召唤物/状态创建
 * 3. .endPhaseDamage(DamageType.X, N) → 召唤物回合伤害
 * 4. .if() / .do() / .on() 调用计数 → 复杂度
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DamageType } from "@gi-tcg/typings";
import type {
  AdditionalDamage,
  DamageTypeValue,
  SummonProfile,
  StatusProfile,
} from "./types.js";

/** 战斗状态/角色状态的额外信息（从源文件解析） */
interface ParsedStatusInfo {
  definitionId: number;
  type: "status" | "combatStatus";
  duration: number;
  usage: number;
  teammateTriggerable: boolean;
  varName: string;
}

// ═════════════════════════════════════════════════════════════
//  公共类型
// ═════════════════════════════════════════════════════════════

export interface SourceDamageInfo {
  mainDamageType: DamageTypeValue;
  mainDamageValue: number;
  additionalDamage: AdditionalDamage[];
  createsSummon: boolean;
  summonProfile?: SummonProfile;
  createsStatus: boolean;
  statusProfile?: StatusProfile;
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

// ═════════════════════════════════════════════════════════════
//  DamageType 映射
// ═════════════════════════════════════════════════════════════

const DAMAGE_TYPE_MAP: Record<string, DamageTypeValue> = {
  "Physical": DamageType.Physical,
  "Cryo": DamageType.Cryo,
  "Hydro": DamageType.Hydro,
  "Pyro": DamageType.Pyro,
  "Electro": DamageType.Electro,
  "Anemo": DamageType.Anemo,
  "Geo": DamageType.Geo,
  "Dendro": DamageType.Dendro,
  "Piercing": DamageType.Piercing,
  "Heal": DamageType.Heal,
};

// ═════════════════════════════════════════════════════════════
//  解析角色源码目录
// ═════════════════════════════════════════════════════════════

const ELEMENT_DIRS = [
  "anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro",
];

/**
 * 解析所有角色源文件，返回 skillId → damage info 和 charId → complexity info。
 * @param dataPackageSrcDir - `packages/data/src` 的绝对路径
 */
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
      continue; // 目录不存在则跳过
    }

    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const filePath = join(dirPath, file);
      const source = await readFile(filePath, "utf-8");
      parseCharacterFile(source, damageMap, complexityMap);
    }
  }

  return { damageMap, complexityMap };
}

// ═════════════════════════════════════════════════════════════
//  单文件解析
// ═════════════════════════════════════════════════════════════

function parseCharacterFile(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
  complexityMap: Map<number, SourceComplexityInfo>,
): void {
  // ── 提取所有 skill() 定义块 ──
  parseSkillBlocks(source, damageMap);

  // ── 提取所有 summon() 定义块 ──
  parseSummonBlocks(source, damageMap);

  // ── 提取所有 combatStatus/status 定义块 ──
  parseCombatStatusBlocks(source, damageMap);

  // ── 提取角色定义并计算复杂度 ──
  parseCharacterComplexity(source, complexityMap);
}

// ─── skill 块解析 ────────────────────────────────────────────

/**
 * 匹配 `skill(ID)...done()` 块并提取伤害信息。
 *
 * 可靠提取的模式：
 *   .damage(DamageType.Pyro, 3)
 *   .summon(SomeName)
 *   .combatStatus(SomeName) / .characterStatus(SomeName)
 */
function parseSkillBlocks(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
): void {
  // 匹配 skill(ID) 块（非贪婪到 .done()）
  const skillBlockRegex = /skill\((\d+)\)\s*([\s\S]*?)\.done\(\)/g;
  let match;

  while ((match = skillBlockRegex.exec(source)) !== null) {
    const skillId = parseInt(match[1], 10);
    const block = match[2];

    // 提取第一个 .damage() 调用（主伤害）
    const dmgMatch = block.match(
      /\.damage\(DamageType\.(\w+),\s*(\d+)/,
    );
    const mainDamageType = dmgMatch
      ? (DAMAGE_TYPE_MAP[dmgMatch[1]] ?? DamageType.Physical)
      : DamageType.Physical;
    const mainDamageValue = dmgMatch ? parseInt(dmgMatch[2], 10) : 0;

    // 提取所有额外 .damage() 调用
    const allDmg = [...block.matchAll(/\.damage\(DamageType\.(\w+),\s*(\d+)/g)];
    const additionalDamage: AdditionalDamage[] = allDmg.slice(1).map((d) => ({
      type: DAMAGE_TYPE_MAP[d[1]] ?? DamageType.Physical,
      value: parseInt(d[2], 10),
    }));

    // 召唤物
    const createsSummon = /\.summon\(/.test(block);

    // 状态
    const createsStatus =
      /\.combatStatus\(/.test(block) || /\.characterStatus\(/.test(block);

    damageMap.set(skillId, {
      mainDamageType,
      mainDamageValue,
      additionalDamage,
      createsSummon,
      createsStatus,
    });
  }
}

// ─── summon 块解析 ──────────────────────────────────────────

function parseSummonBlocks(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
): void {
  // 匹配 summon(ID) 块
  const summonBlockRegex = /summon\((\d+)\)\s*([\s\S]*?)\.done\(\)/g;
  let match;

  while ((match = summonBlockRegex.exec(source)) !== null) {
    const entityId = parseInt(match[1], 10);
    const block = match[2];

    // 提取 .endPhaseDamage(DamageType.X, N)
    const epdMatch = block.match(
      /\.endPhaseDamage\(DamageType\.(\w+),\s*(\d+)/,
    );
    if (!epdMatch) continue;

    const element = DAMAGE_TYPE_MAP[epdMatch[1]] ?? DamageType.Physical;
    const endPhaseDamage = parseInt(epdMatch[2], 10);

    // 提取 .usage(N)
    const usageMatch = block.match(/\.usage\((\d+)/);
    const duration = usageMatch ? parseInt(usageMatch[1], 10) : 1;

    // 将召唤物信息附加到引用该召唤物的技能上
    // 需要回溯匹配：找到哪些 skill 块里有 .summon(VarName)
    // 此处存储到 entityId 键，后续关联
    const profile: SummonProfile = {
      definitionId: entityId,
      endPhaseDamage,
      endPhaseDamageElement: element,
      duration,
    };

    // 查找引用此召唤物的 skill 块
    // 先找到该召唤物的变量名
    const varNameRegex = new RegExp(
      `(?:export\\s+)?(?:const|let)\\s+(\\w+)\\s*(?::\\s*\\w+)?\\s*=\\s*summon\\(${entityId}\\)`,
    );
    const varMatch = source.match(varNameRegex);
    if (!varMatch) continue;

    const varName = varMatch[1];

    // 找到所有 skill() 块中引用 .summon(varName) 的
    const refRegex = new RegExp(
      `skill\\((\\d+)\\)[\\s\\S]*?\\.summon\\(${varName}\\)[\\s\\S]*?\\.done\\(\\)`,
      "g",
    );
    let refMatch;
    while ((refMatch = refRegex.exec(source)) !== null) {
      const skillId = parseInt(refMatch[1], 10);
      const existing = damageMap.get(skillId);
      if (existing) {
        // 合并召唤物信息
        damageMap.set(skillId, {
          ...existing,
          createsSummon: true,
          summonProfile: profile,
        });
      }
    }
  }
}

// ─── combat status 块解析 ────────────────────────────────────

function parseCombatStatusBlocks(
  source: string,
  damageMap: Map<number, SourceDamageInfo>,
): void {
  // 匹配 combatStatus(ID) 和 status(ID) 块
  const statusBlockRegex = /(?:combatStatus|status)\((\d+)\)\s*([\s\S]*?)\.done\(\)/g;
  let match;

  while ((match = statusBlockRegex.exec(source)) !== null) {
    const entityId = parseInt(match[1], 10);
    const block = match[2];

    // 提取 .duration(N)
    const durMatch = block.match(/\.duration\((\d+)/);
    const duration = durMatch ? parseInt(durMatch[1], 10) : 1;

    // 提取 .usage(N)
    const usageMatch = block.match(/\.usage\((\d+)/);
    const usage = usageMatch ? parseInt(usageMatch[1], 10) : 1;

    // 检测 teammate-triggerable:
    // .on("useSkill", ..., e.skill.caller.definition.id !== CharName)
    const teammateTriggerable =
      /\.on\("useSkill".*caller\.definition\.id\s*!==/.test(block) ||
      /\.on\("useSkill".*who\s*!==/.test(block);

    const statusInfo: ParsedStatusInfo = {
      definitionId: entityId,
      type: /combatStatus/.test(match[0]) ? "combatStatus" : "status",
      duration,
      usage,
      teammateTriggerable,
      varName: "",
    };

    // 找到该状态的变量名
    const varNameRegex = new RegExp(
      `(?:export\\s+)?(?:const|let)\\s+(\\w+)\\s*(?::\\s*(?:\\w+|<[^>]+>))?\\s*=\\s*(?:combatStatus|status)\\(${entityId}\\)`,
    );
    const varMatch = source.match(varNameRegex);
    if (!varMatch) continue;
    statusInfo.varName = varMatch[1];

    // 链接到技能：找到 .combatStatus(varName) 或 .characterStatus(varName) 引用
    const refRegex = new RegExp(
      `skill\\((\\d+)\\)[\\s\\S]*?\\.(?:combatStatus|characterStatus)\\(${statusInfo.varName}\\)`,
      "g",
    );
    let refMatch;
    while ((refMatch = refRegex.exec(source)) !== null) {
      const skillId = parseInt(refMatch[1], 10);
      const existing = damageMap.get(skillId);
      if (existing) {
        const statusProfile: StatusProfile = {
          definitionId: entityId,
          type: statusInfo.type,
          duration: statusInfo.duration,
          usage: statusInfo.usage,
          teammateTriggerable: statusInfo.teammateTriggerable || undefined,
        };
        damageMap.set(skillId, {
          ...existing,
          createsStatus: true,
          statusProfile,
        });
      }
    }
  }
}

// ─── character complexity 解析 ──────────────────────────────

function parseCharacterComplexity(
  source: string,
  complexityMap: Map<number, SourceComplexityInfo>,
): void {
  // 匹配 character(ID)
  const charRegex = /character\((\d+)\)/g;
  let match;

  while ((match = charRegex.exec(source)) !== null) {
    const charId = parseInt(match[1], 10);

    // 统计整个文件的复杂度指标（一个文件通常对应一个角色）
    const ifCount = (source.match(/\.if\s*\(/g) || []).length;
    const doCount = (source.match(/\.do\s*\(/g) || []).length;
    const onCount = (source.match(/\.on\s*\(/g) || []).length;

    // 跨角色交互：检查是否有 customEvent、listenToPlayer 等明确的跨角色协作
    const hasCrossCharInteraction =
      /customEvent|listenToPlayer|"all opp characters"|"all my characters"/.test(source);

    // 状态机：检查是否有姿态切换相关关键词（严格匹配）
    const hasStateMachine =
      /stance|melee.*ranged|ranged.*melee|姿态|switchActive/.test(source) ||
      // 有多个自定义变量且有条件分支切换
      (ifCount >= 3 && /addVariable\("(?!usage|hintIcon)/.test(source));

    // 元素反应依赖
    const requiresReactionTrigger =
      /getReaction|isReaction|Reaction\.|reaction|elementalReaction|Seed/.test(source);

    // 延迟爆发：usage(0, { autoDispose: false }) 模式
    const hasDeferredBurst =
      /usage\(0,?\s*\{[^}]*autoDispose:\s*false/.test(source) ||
      /addVariable\("usage"/.test(source);

    complexityMap.set(charId, {
      ifCount,
      doCount,
      onCount,
      hasCrossCharInteraction,
      hasStateMachine,
      requiresReactionTrigger,
      hasDeferredBurst,
    });
  }
}

/**
 * 单个源码文件解析入口（供测试使用）
 */
export { parseSkillDamageFromSource, parseComplexityFromSource };

function parseSkillDamageFromSource(
  source: string,
): Map<number, SourceDamageInfo> {
  const map = new Map<number, SourceDamageInfo>();
  parseSkillBlocks(source, map);
  parseSummonBlocks(source, map);
  parseCombatStatusBlocks(source, map);
  return map;
}

function parseComplexityFromSource(
  source: string,
): Map<number, SourceComplexityInfo> {
  const map = new Map<number, SourceComplexityInfo>();
  parseCharacterComplexity(source, map);
  return map;
}
