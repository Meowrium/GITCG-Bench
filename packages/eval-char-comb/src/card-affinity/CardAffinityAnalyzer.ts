/**
 * CardAffinityAnalyzer
 *
 * 分析卡牌与角色之间的静态相性。
 *
 * 数据源优先级：
 * 1. deck.json（assets-manager 导出的权威数据，含 relatedCharacterId/tags）
 * 2. 角色源码（天赋牌 .talent() 关联）
 *
 * shareId 过滤：仅处理有 shareId 的角色和卡牌（实际可用池）。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CardAffinityType,
  CardCharacterAffinity,
  CharacterOutputProfile,
} from "../profiler/types.js";

// ═════════════════════════════════════════════════════════════
//  武器标签映射
// ═════════════════════════════════════════════════════════════

const GCG_WEAPON_TAG_TO_WEAPON: Record<string, string> = {
  "GCG_TAG_WEAPON_SWORD": "sword",
  "GCG_TAG_WEAPON_CLAYMORE": "claymore",
  "GCG_TAG_WEAPON_POLE": "pole",
  "GCG_TAG_WEAPON_CATALYST": "catalyst",
  "GCG_TAG_WEAPON_BOW": "bow",
};

const ELEMENT_TAG_MAP: Record<string, string> = {
  "GCG_TAG_ELEMENT_CRYO": "cryo",
  "GCG_TAG_ELEMENT_HYDRO": "hydro",
  "GCG_TAG_ELEMENT_PYRO": "pyro",
  "GCG_TAG_ELEMENT_ELECTRO": "electro",
  "GCG_TAG_ELEMENT_ANEMO": "anemo",
  "GCG_TAG_ELEMENT_GEO": "geo",
  "GCG_TAG_ELEMENT_DENDRO": "dendro",
};

/** 可用角色 ID 集合（从 share_id.json 中的角色 ID） */
type ValidIdSet = Set<number>;

/**
 * 从 assets-manager 的 deck.json 加载权威卡牌-角色关联数据。
 * deck.json 中每张卡有 relatedCharacterId（天赋牌）和 tags（武器/元素限定）。
 */
function loadDeckJsonCards(
  deckDataPath: string,
  profiles: CharacterOutputProfile[],
  validCharIds: ValidIdSet,
  validCardIds: ValidIdSet,
): CardCharacterAffinity[] {
  let deckJson: any;
  try {
    deckJson = JSON.parse(require("node:fs").readFileSync(deckDataPath, "utf-8"));
  } catch {
    return [];
  }

  const affinities: CardCharacterAffinity[] = [];
  const actionCards: Record<string, any> = deckJson.actionCards;
  if (!actionCards) return affinities;

  // 建 charId → weapon tag 映射
  const charWeaponMap = new Map<number, string>();
  for (const p of profiles) {
    charWeaponMap.set(p.definitionId, p.base.weapon);
  }

  // 建 charId → element 映射
  const charElementMap = new Map<number, string>();
  const elemTagSet = new Set(Object.values(ELEMENT_TAG_MAP));
  for (const p of profiles) {
    for (const t of p.tags) {
      if (elemTagSet.has(t)) {
        charElementMap.set(p.definitionId, t);
        break;
      }
    }
  }

  for (const [cardIdStr, cardInfo] of Object.entries(actionCards)) {
    const cardId = Number(cardIdStr);
    if (!validCardIds.has(cardId)) continue;

    const tags: string[] = cardInfo.tags || [];
    const relatedCharId: number | null = cardInfo.relatedCharacterId;

    // 1. 天赋牌：relatedCharacterId 直接关联
    if (relatedCharId !== null && relatedCharId !== undefined && validCharIds.has(relatedCharId)) {
      affinities.push({
        cardDefinitionId: cardId,
        characterDefinitionId: relatedCharId,
        affinityType: "talent",
        strength: 1.0,
        needsSimulation: false,
      });
    }

    // 2. 武器牌：通过武器 tag 匹配
    const weaponTag = tags.find(t => t in GCG_WEAPON_TAG_TO_WEAPON);
    if (weaponTag) {
      const weapon = GCG_WEAPON_TAG_TO_WEAPON[weaponTag];
      for (const p of profiles) {
        if (!validCharIds.has(p.definitionId)) continue;
        if (p.base.weapon === weapon) {
          affinities.push({
            cardDefinitionId: cardId,
            characterDefinitionId: p.definitionId,
            affinityType: "weapon_match",
            strength: 0.6,
            needsSimulation: false,
          });
        }
      }
    }

    // 3. 元素限定牌（非武器、非天赋）：元素共鸣等，匹配所有同元素角色
    const elemTag = tags.find(t => t in ELEMENT_TAG_MAP);
    if (elemTag && !weaponTag) {
      const element = ELEMENT_TAG_MAP[elemTag];
      for (const p of profiles) {
        if (!validCharIds.has(p.definitionId)) continue;
        const pElem = charElementMap.get(p.definitionId);
        if (pElem === element) {
          affinities.push({
            cardDefinitionId: cardId,
            characterDefinitionId: p.definitionId,
            affinityType: "element_match",
            strength: 0.3,
            needsSimulation: false,
          });
        }
      }
    }

    // 4. 角色标签匹配（relatedCharacterTag）：部分牌通过角色标签关联
    if (cardInfo.relatedCharacterTag) {
      // 匹配所有该元素的角色
      const element = ELEMENT_TAG_MAP[cardInfo.relatedCharacterTag];
      if (element) {
        for (const p of profiles) {
          if (!validCharIds.has(p.definitionId)) continue;
          const pElem = charElementMap.get(p.definitionId);
          if (pElem === element) {
            affinities.push({
              cardDefinitionId: cardId,
              characterDefinitionId: p.definitionId,
              affinityType: "reaction_synergy",
              strength: 0.4,
              needsSimulation: false,
            });
          }
        }
      }
    }
  }

  return affinities;
}

/**
 * 解析所有卡牌相性。
 *
 * @param dataPackageSrcDir - `packages/data/src` 的绝对路径
 * @param profiles - 角色档案列表
 * @param validCharIds - 可用角色 ID 集合（有 shareId 的）
 * @param validCardIds - 可用卡牌 ID 集合（有 shareId 的）
 */
export async function parseCardAffinities(
  dataPackageSrcDir: string,
  profiles: CharacterOutputProfile[],
  validCharIds?: Set<number>,
  validCardIds?: Set<number>,
): Promise<CardCharacterAffinity[]> {
  // 默认：所有角色/卡牌都可用
  const charSet = validCharIds ?? new Set(profiles.map(p => p.definitionId));
  const cardSet = validCardIds ?? new Set<number>();

  // 优先使用 deck.json（权威数据）
  const deckJsonPath = join(
    dataPackageSrcDir, "..", "..", "assets-manager", "src", "data", "deck.json"
  );

  const affinities = loadDeckJsonCards(deckJsonPath, profiles, charSet, cardSet);

  // 补充：从角色源码提取天赋牌关联（作为 fallback）
  const existingTalentCardIds = new Set(
    affinities.filter(a => a.affinityType === "talent").map(a => a.cardDefinitionId)
  );
  const sourceTalents = await parseTalentCardsFromSource(dataPackageSrcDir, charSet);
  for (const t of sourceTalents) {
    if (!existingTalentCardIds.has(t.cardDefinitionId)) {
      affinities.push(t);
    }
  }

  return affinities;
}

// ─── 源码天赋牌解析（fallback）───────────────────────────────

async function parseTalentCardsFromSource(
  dataPackageSrcDir: string,
  validCharIds: ValidIdSet,
): Promise<CardCharacterAffinity[]> {
  const affinities: CardCharacterAffinity[] = [];
  const charVarNameToId = new Map<string, number>();

  const charsDir = join(dataPackageSrcDir, "characters");
  const elementDirs = [
    "anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro",
  ];

  for (const elemDir of elementDirs) {
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

      const charMatches = source.matchAll(
        /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*character\((\d+)\)/g
      );
      for (const m of charMatches) {
        charVarNameToId.set(m[1], parseInt(m[2], 10));
      }

      const talentMatches = source.matchAll(
        /(?:export\s+)?(?:const|let)\s+\w+\s*=\s*card\((\d+)\)[\s\S]*?\.talent\((\w+)\)[\s\S]*?\.done\(\)/g
      );
      for (const m of talentMatches) {
        const cardId = parseInt(m[1], 10);
        const charVarName = m[2];
        const charId = charVarNameToId.get(charVarName);
        if (charId && validCharIds.has(charId)) {
          affinities.push({
            cardDefinitionId: cardId,
            characterDefinitionId: charId,
            affinityType: "talent",
            strength: 1.0,
            needsSimulation: false,
          });
        }
      }
    }
  }

  return affinities;
}
