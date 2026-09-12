/**
 * CharacterProfileService
 *
 * 整合 Phase A/B/C 三个子系统的统一入口。
 * 提供查询接口供 plan-v2 和外部消费。
 */

import type { GameData } from "@gi-tcg/core";
import { CharacterProfileExtractor } from "./profiler/CharacterProfileExtractor.js";
import { parseAllCharacterSources } from "./profiler/SourceParser.js";
import { parseCardAffinities } from "./card-affinity/CardAffinityAnalyzer.js";
import { DeckCandidateFilter } from "./DeckCandidateFilter.js";
import type {
  CharacterOutputProfile,
  DeckCompatibilityScore,
  CardCharacterAffinity,
  PairCompatibility,
} from "./profiler/types.js";
import { computePairCompatibility } from "./compatibility/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 从 share_id.json 加载可用角色/卡牌 ID 集合 */
function loadValidIds(
  dataPackageSrcDir: string,
): { validCharIds: Set<number>; validCardIds: Set<number> } {
  const shareIdPath = join(
    dataPackageSrcDir, "..", "..", "assets-manager", "src", "data", "share_id.json"
  );
  const validCharIds = new Set<number>();
  const validCardIds = new Set<number>();

  try {
    const shareMap = JSON.parse(readFileSync(shareIdPath, "utf-8"));
    for (const [sidStr, defId] of Object.entries(shareMap)) {
      const id = Number(defId);
      if (id >= 1000 && id < 3000) {
        validCharIds.add(id);
      } else if (id >= 3000) {
        validCardIds.add(id);
      }
      // 天赋牌 (21xxxx) 也纳入卡牌
      if (id >= 210000 && id < 220000) {
        validCardIds.add(id);
      }
    }
  } catch {
    // share_id.json 不存在时，不过滤
  }

  return { validCharIds, validCardIds };
}

export class CharacterProfileService {
  private profiles: CharacterOutputProfile[] = [];
  private profileMap: Map<number, CharacterOutputProfile> = new Map();
  private affinities: CardCharacterAffinity[] = [];
  private deckFilter: DeckCandidateFilter | null = null;

  /**
   * 初始化服务：提取所有角色档案 + 卡牌相性。
   *
   * @param data - GameData（从 @gi-tcg/data 导入）
   * @param dataPackageSrcDir - `packages/data/src` 的绝对路径（用于源码解析）
   */
  async init(data: GameData, dataPackageSrcDir: string): Promise<void> {
    // 加载 shareId 过滤数据
    const { validCharIds, validCardIds } = loadValidIds(dataPackageSrcDir);

    // Phase A: 提取角色档案（过滤掉无 shareId 的变体角色）
    const extractor = new CharacterProfileExtractor(data);
    const { damageMap, complexityMap } = await parseAllCharacterSources(dataPackageSrcDir);
    extractor.setSourceData(damageMap, complexityMap);

    const allProfiles = extractor.extractAll();
    this.profiles = validCharIds.size > 0
      ? allProfiles.filter(p => validCharIds.has(p.definitionId))
      : allProfiles;
    this.profileMap = new Map(this.profiles.map((p) => [p.definitionId, p]));

    // Phase C: 卡牌相性（只关联有 shareId 的卡牌）
    this.affinities = await parseCardAffinities(
      dataPackageSrcDir, this.profiles, validCharIds, validCardIds,
    );

    // Phase D: 候选牌组过滤器
    this.deckFilter = new DeckCandidateFilter(this.profiles, this.affinities);
  }

  /** 获取所有角色档案 */
  getAllProfiles(): CharacterOutputProfile[] {
    return this.profiles;
  }

  /** 获取单个角色档案 */
  getProfile(characterId: number): CharacterOutputProfile | undefined {
    return this.profileMap.get(characterId);
  }

  /** 获取两角色兼容性 */
  getPairCompatibility(charA: number, charB: number): PairCompatibility | null {
    const a = this.profileMap.get(charA);
    const b = this.profileMap.get(charB);
    if (!a || !b) return null;
    return computePairCompatibility(a, b);
  }

  /** 获取三角色牌组兼容性评分 */
  getDeckCompatibility(
    chars: readonly [number, number, number],
  ): DeckCompatibilityScore | null {
    return this.deckFilter?.scoreDeck(chars) ?? null;
  }

  /** 获取 top-N 候选牌组 */
  getTopDecks(n: number) {
    return this.deckFilter?.getTopN(n) ?? [];
  }

  /** 获取所有卡牌相性 */
  getAllAffinities(): CardCharacterAffinity[] {
    return this.affinities;
  }

  /** 获取指定角色的相关卡牌 */
  getCardAffinities(characterId: number): CardCharacterAffinity[] {
    return this.affinities.filter((a) => a.characterDefinitionId === characterId);
  }
}
