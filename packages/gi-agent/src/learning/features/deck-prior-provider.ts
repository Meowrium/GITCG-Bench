// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import {
  extractDeckFeaturesV2,
  extractMatchupFeaturesV2,
  type DeckFeaturesV2,
  type MatchupFeaturesV2,
} from "../../../../llm-deck-analyzer/src/index.js";
import type { PolicyDeckPriorContext } from "../../runtime/policy/prior-types.js";
import { flattenDeckMatchupPriors } from "./deck-prior-flattener.js";

export class DeckPriorProvider {
  private readonly deckCache = new Map<string, Promise<DeckFeaturesV2>>();
  private readonly matchupCache = new Map<string, Promise<MatchupFeaturesV2>>();
  private readonly contextCache = new Map<string, Promise<PolicyDeckPriorContext>>();

  getDeckFeatures(deckCode: string): Promise<DeckFeaturesV2> {
    let cached = this.deckCache.get(deckCode);
    if (!cached) {
      cached = extractDeckFeaturesV2(deckCode);
      this.deckCache.set(deckCode, cached);
    }
    return cached;
  }

  getMatchupFeatures(deckA: string, deckB: string): Promise<MatchupFeaturesV2> {
    const key = `${deckA}__${deckB}`;
    let cached = this.matchupCache.get(key);
    if (!cached) {
      cached = extractMatchupFeaturesV2(deckA, deckB);
      this.matchupCache.set(key, cached);
    }
    return cached;
  }

  getPolicyContext(selfDeckCode: string, opponentDeckCode: string): Promise<PolicyDeckPriorContext> {
    const key = `${selfDeckCode}__${opponentDeckCode}`;
    let cached = this.contextCache.get(key);
    if (!cached) {
      cached = Promise.all([
        this.getDeckFeatures(selfDeckCode),
        this.getDeckFeatures(opponentDeckCode),
        this.getMatchupFeatures(selfDeckCode, opponentDeckCode),
      ]).then(([selfDeck, opponentDeck, matchup]) => ({
        selfDeckCode,
        opponentDeckCode,
        priorFeatures: flattenDeckMatchupPriors(selfDeck, opponentDeck, matchup),
      }));
      this.contextCache.set(key, cached);
    }
    return cached;
  }
}
