import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CardCharacterAffinity,
  CharacterOutputProfile,
} from "../character-profiles/types.js";

const GCG_WEAPON_TAG_TO_WEAPON: Record<string, string> = {
  GCG_TAG_WEAPON_SWORD: "sword",
  GCG_TAG_WEAPON_CLAYMORE: "claymore",
  GCG_TAG_WEAPON_POLE: "pole",
  GCG_TAG_WEAPON_CATALYST: "catalyst",
  GCG_TAG_WEAPON_BOW: "bow",
};

const ELEMENT_TAG_MAP: Record<string, string> = {
  GCG_TAG_ELEMENT_CRYO: "cryo",
  GCG_TAG_ELEMENT_HYDRO: "hydro",
  GCG_TAG_ELEMENT_PYRO: "pyro",
  GCG_TAG_ELEMENT_ELECTRO: "electro",
  GCG_TAG_ELEMENT_ANEMO: "anemo",
  GCG_TAG_ELEMENT_GEO: "geo",
  GCG_TAG_ELEMENT_DENDRO: "dendro",
};

type ValidIdSet = Set<number>;

function loadDeckJsonCards(
  deckDataPath: string,
  profiles: CharacterOutputProfile[],
  validCharIds: ValidIdSet,
  validCardIds: ValidIdSet,
): CardCharacterAffinity[] {
  let deckJson: { actionCards?: Record<string, any> };
  try {
    deckJson = JSON.parse(readFileSync(deckDataPath, "utf-8")) as { actionCards?: Record<string, any> };
  } catch {
    return [];
  }

  const affinities: CardCharacterAffinity[] = [];
  const actionCards = deckJson.actionCards;
  if (!actionCards) return affinities;

  const charWeaponMap = new Map<number, string>();
  const charElementMap = new Map<number, string>();
  const elemTagSet = new Set(Object.values(ELEMENT_TAG_MAP));

  for (const p of profiles) {
    charWeaponMap.set(p.definitionId, p.base.weapon);
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

    if (relatedCharId !== null && relatedCharId !== undefined && validCharIds.has(relatedCharId)) {
      affinities.push({
        cardDefinitionId: cardId,
        characterDefinitionId: relatedCharId,
        affinityType: "talent",
        strength: 1,
        needsSimulation: false,
      });
    }

    const weaponTag = tags.find((t) => t in GCG_WEAPON_TAG_TO_WEAPON);
    if (weaponTag) {
      const weapon = GCG_WEAPON_TAG_TO_WEAPON[weaponTag];
      for (const p of profiles) {
        if (!validCharIds.has(p.definitionId)) continue;
        if (charWeaponMap.get(p.definitionId) === weapon) {
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

    const elemTag = tags.find((t) => t in ELEMENT_TAG_MAP);
    if (elemTag && !weaponTag) {
      const element = ELEMENT_TAG_MAP[elemTag];
      for (const p of profiles) {
        if (!validCharIds.has(p.definitionId)) continue;
        if (charElementMap.get(p.definitionId) === element) {
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
  }

  return affinities;
}

export async function parseCardAffinities(
  dataPackageSrcDir: string,
  profiles: CharacterOutputProfile[],
  validCharIds?: Set<number>,
  validCardIds?: Set<number>,
): Promise<CardCharacterAffinity[]> {
  const charSet = validCharIds ?? new Set(profiles.map((p) => p.definitionId));
  const cardSet = validCardIds ?? new Set<number>();

  const deckJsonPath = join(
    dataPackageSrcDir, "..", "..", "assets-manager", "src", "data", "deck.json",
  );

  const affinities = loadDeckJsonCards(deckJsonPath, profiles, charSet, cardSet);
  const existingTalentCardIds = new Set(
    affinities.filter((a) => a.affinityType === "talent").map((a) => a.cardDefinitionId),
  );

  const sourceTalents = await parseTalentCardsFromSource(dataPackageSrcDir, charSet);
  for (const t of sourceTalents) {
    if (!existingTalentCardIds.has(t.cardDefinitionId)) {
      affinities.push(t);
    }
  }

  return affinities;
}

async function parseTalentCardsFromSource(
  dataPackageSrcDir: string,
  validCharIds: ValidIdSet,
): Promise<CardCharacterAffinity[]> {
  const affinities: CardCharacterAffinity[] = [];
  const charVarNameToId = new Map<string, number>();
  const charsDir = join(dataPackageSrcDir, "characters");
  const elementDirs = ["anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro"];

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
        /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*character\((\d+)\)/g,
      );
      for (const m of charMatches) {
        charVarNameToId.set(m[1], parseInt(m[2], 10));
      }

      const talentMatches = source.matchAll(
        /(?:export\s+)?(?:const|let)\s+\w+\s*=\s*card\((\d+)\)[\s\S]*?\.talent\((\w+)\)[\s\S]*?\.done\(\)/g,
      );
      for (const m of talentMatches) {
        const charId = charVarNameToId.get(m[2]);
        if (charId && validCharIds.has(charId)) {
          affinities.push({
            cardDefinitionId: parseInt(m[1], 10),
            characterDefinitionId: charId,
            affinityType: "talent",
            strength: 1,
            needsSimulation: false,
          });
        }
      }
    }
  }

  return affinities;
}
