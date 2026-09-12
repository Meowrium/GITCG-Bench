/**
 * DeckCandidateFilter
 *
 * 整合 Phase A/B/C 的输出，生成候选牌组列表，
 * 供 plan-tactic-search-v2 的离线挖掘消费。
 *
 * 这是 eval-char-comb 作为 plan-v2 上游预过滤器的核心输出。
 */

import type {
  CharacterOutputProfile,
  DeckCompatibilityScore,
  CardCharacterAffinity,
} from "./profiler/types.js";
import { computeDeckCompatibility } from "./compatibility/index.js";

/** 候选牌组 */
export interface DeckCandidate {
  readonly characters: readonly [number, number, number];
  readonly compatibility: DeckCompatibilityScore;
  /** 推荐卡牌（top affinity） */
  readonly recommendedCards: readonly CardRecommendation[];
}

export interface CardRecommendation {
  readonly cardId: number;
  readonly affinityType: string;
  readonly strength: number;
  /** 与牌组中哪个角色关联 */
  readonly characterId: number;
}

export class DeckCandidateFilter {
  private readonly profiles: Map<number, CharacterOutputProfile>;
  private readonly affinities: CardCharacterAffinity[];

  constructor(
    profiles: CharacterOutputProfile[],
    affinities: CardCharacterAffinity[],
  ) {
    this.profiles = new Map(profiles.map((p) => [p.definitionId, p]));
    this.affinities = affinities;
  }

  /**
   * 获取 top-N 候选牌组，按综合评分排序。
   *
   * 算法：遍历所有 C(n,3) 组合，计算兼容性评分，取 top-N。
   * n=134 时组合数约 39.5万，纯 JS 数学运算约 1-2s。
   */
  getTopN(n: number): DeckCandidate[] {
    const ids = [...this.profiles.keys()];
    const candidates: DeckCandidate[] = [];

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = j + 1; k < ids.length; k++) {
          const a = this.profiles.get(ids[i])!;
          const b = this.profiles.get(ids[j])!;
          const c = this.profiles.get(ids[k])!;

          const compatibility = computeDeckCompatibility([a, b, c]);

          candidates.push({
            characters: [ids[i], ids[j], ids[k]],
            compatibility,
            recommendedCards: this.getRecommendedCards(
              [ids[i], ids[j], ids[k]],
              10,
            ),
          });
        }
      }
    }

    // 按综合评分降序排序
    candidates.sort(
      (a, b) => b.compatibility.overallScore - a.compatibility.overallScore,
    );

    return candidates.slice(0, n);
  }

  /**
   * 对指定三角色组合计算兼容性。
   */
  scoreDeck(
    charIds: readonly [number, number, number],
  ): DeckCompatibilityScore | null {
    const profiles = charIds.map((id) => this.profiles.get(id));
    if (profiles.some((p) => !p)) return null;
    return computeDeckCompatibility(
      profiles as unknown as [CharacterOutputProfile, CharacterOutputProfile, CharacterOutputProfile],
    );
  }

  /**
   * 获取指定角色组合的推荐卡牌。
   */
  getRecommendedCards(
    charIds: readonly number[],
    topK: number,
  ): CardRecommendation[] {
    const charSet = new Set(charIds);

    // 收集所有与牌组角色有关联的卡牌相性
    const relevant = this.affinities
      .filter((a) => charSet.has(a.characterDefinitionId))
      .map((a) => ({
        cardId: a.cardDefinitionId,
        affinityType: a.affinityType,
        strength: a.strength,
        characterId: a.characterDefinitionId,
      }));

    // 按 strength 排序，取 top-K
    relevant.sort((a, b) => b.strength - a.strength);

    // 去重（同一张卡只保留最高 strength）
    const seen = new Set<number>();
    const result: CardRecommendation[] = [];
    for (const r of relevant) {
      if (!seen.has(r.cardId)) {
        seen.add(r.cardId);
        result.push(r);
        if (result.length >= topK) break;
      }
    }

    return result;
  }
}
