import { promises as fs } from "node:fs";
import type { CardIndexFile, CardIndexItem, CardLanguage } from "./types";
import { buildAndWriteLatestIndex, getDefaultIndexPath } from "./buildFromDataSource";

export type CardListFilter = {
  type?: string;
  tags?: string[];
  nameLike?: string;
};

export class CardIndexStore {
  private cache: CardIndexFile | null = null;

  private async loadLatest(): Promise<CardIndexFile> {
    if (this.cache) {
      return this.cache;
    }
    const indexPath = getDefaultIndexPath();
    try {
      const raw = await fs.readFile(indexPath, "utf-8");
      this.cache = JSON.parse(raw) as CardIndexFile;
      return this.cache;
    } catch {
      this.cache = await buildAndWriteLatestIndex(indexPath);
      return this.cache;
    }
  }

  async listCards(params: {
    version?: string;
    language?: CardLanguage;
    filter?: CardListFilter;
    page?: number;
    pageSize?: number;
  }): Promise<{ total: number; items: CardIndexItem[]; version: string }> {
    const index = await this.loadLatest();
    const filter = params.filter ?? {};

    let items = index.items;
    if (filter.type) {
      const typeText = filter.type.toLowerCase();
      items = items.filter((item) => item.type.toLowerCase().includes(typeText));
    }

    if (filter.tags?.length) {
      const wantedTags = filter.tags.map((t) => t.toLowerCase());
      items = items.filter((item) => wantedTags.every((tag) => item.tags.some((x) => x.toLowerCase() === tag)));
    }

    if (filter.nameLike) {
      const q = filter.nameLike.toLowerCase();
      items = items.filter((item) => item.canonicalName.toLowerCase().includes(q));
    }

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.max(1, Math.min(200, params.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    return {
      total: items.length,
      version: index.version,
      items: items.slice(offset, offset + pageSize),
    };
  }

  async getCardById(definitionId: number): Promise<CardIndexItem | null> {
    const index = await this.loadLatest();
    return index.items.find((item) => item.definitionId === definitionId) ?? null;
  }

  async getCardsByIds(definitionIds: number[]): Promise<Map<number, CardIndexItem>> {
    const index = await this.loadLatest();
    const idSet = new Set(definitionIds);
    const byId = new Map(index.items.map((item) => [item.definitionId, item]));
    const result = new Map<number, CardIndexItem>();
    for (const id of idSet) {
      const item = byId.get(id);
      if (item) result.set(id, item);
    }
    return result;
  }

  async resolveCard(query: string, topK = 5): Promise<Array<CardIndexItem & { score: number }>> {
    const index = await this.loadLatest();
    const q = query.trim().toLowerCase();

    if (q.length === 0) {
      return [];
    }

    const scored = index.items
      .map((item) => {
        let score = 0;
        if (`${item.definitionId}` === q) {
          score += 100;
        }
        const name = item.canonicalName.toLowerCase();
        if (name === q) {
          score += 80;
        } else if (name.includes(q)) {
          score += 45;
        }
        if (item.effectText.toLowerCase().includes(q)) {
          score += 10;
        }
        return { ...item, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, topK)));

    return scored;
  }

  async validateCardMapping(items: Array<{ definitionId: number; name: string }>): Promise<
    Array<{
      definitionId: number;
      inputName: string;
      canonicalName: string | null;
      matched: boolean;
      reason: string;
      contentHash: string | null;
    }>
  > {
    const output = [] as Array<{
      definitionId: number;
      inputName: string;
      canonicalName: string | null;
      matched: boolean;
      reason: string;
      contentHash: string | null;
    }>;

    for (const item of items) {
      const card = await this.getCardById(item.definitionId);
      if (!card) {
        output.push({
          definitionId: item.definitionId,
          inputName: item.name,
          canonicalName: null,
          matched: false,
          reason: "CARD_NOT_FOUND",
          contentHash: null,
        });
        continue;
      }

      const matched = card.canonicalName.trim().toLowerCase() === item.name.trim().toLowerCase();
      output.push({
        definitionId: item.definitionId,
        inputName: item.name,
        canonicalName: card.canonicalName,
        matched,
        reason: matched ? "OK" : "NAME_MISMATCH",
        contentHash: card.contentHash,
      });
    }

    return output;
  }
}
