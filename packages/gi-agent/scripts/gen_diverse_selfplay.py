#!/usr/bin/env python3
"""
Generate self-play config with diverse opponents for GI-TCG training.

Creates N deck-codes × 3 opponent archetypes = 3N matchups.
SideA uses GiMlPolicy (bootstrap with existing ranker).
SideB randomly uses one of 3 BaselinePolicy archetypes: aggressive/defensive/neutral.

Usage:
  python3 gen_diverse_selfplay.py <output.json> [--games-per 5] [--ranker path/to/ranker.json]
"""

import json, sys, random, os

# 8 canonical deck codes (from benchmark.route-a.json, v6.4.0)
DECK_CODES = [
    "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA",
    "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA",
    "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA",
    "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA",
    "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA",
    "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA",
    "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA",
    "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA",
]

# Deck names for logging (matches benchmark convention)
DECK_NAMES = ["水八", "神宵", "水凝", "雷鹤", "雷狼", "莫优", "红牛", "水债"]

# Opponent archetypes
ARCHETYPES = {
    "aggressive": {
        "endTurnPenalty": 3,
        "temperature": 1.0,
        "adaptiveProfile": True,
    },
    "defensive": {
        "endTurnPenalty": 8,
        "temperature": 2.0,
        "adaptiveProfile": True,
    },
    "neutral": {
        "endTurnPenalty": 5,
        "temperature": 1.5,
        "adaptiveProfile": True,
    },
}

def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else "self-play-diverse.json"
    games_per = 5
    ranker_path = os.path.abspath("output/v5-model/iter3.ranker-artifact.json")

    for arg in sys.argv:
        if arg.startswith("--games-per="):
            games_per = int(arg.split("=")[1])
        if arg.startswith("--ranker="):
            ranker_path = os.path.abspath(arg.split("=")[1])

    matchups = []
    matchup_id = 0

    for i, deck_a in enumerate(DECK_CODES):
        a_name = DECK_NAMES[i] if i < len(DECK_NAMES) else f"Deck{i}"

        for arch_name, arch_opts in ARCHETYPES.items():
            # Pick random opponent deck (different from self)
            opponent_idx = (i + 1 + random.randint(0, len(DECK_CODES) - 2)) % len(DECK_CODES)
            if opponent_idx == i:
                opponent_idx = (i + 1) % len(DECK_CODES)

            deck_b = DECK_CODES[opponent_idx]
            b_name = DECK_NAMES[opponent_idx] if opponent_idx < len(DECK_NAMES) else f"Deck{opponent_idx}"

            matchup_id += 1
            matchups.append({
                "id": f"iter1-{a_name}-vs-{b_name}-{arch_name}",
                "deck0": deck_a,
                "deck1": deck_b,
                "games": games_per,
                "sideA": {
                    "name": f"GiMlPolicy-{a_name}",
                    "kind": "gi-ml-runtime",
                    "rankerArtifactPath": ranker_path,
                "options": {
                    "endTurnPenalty": 5,
                    "temperature": 1.5,
                    "tempoValueWeight": 0.3,
                    "macroPlanWeight": 0,
                },
                },
                "sideB": {
                    "name": f"baseline-{arch_name}",
                    "kind": "baseline",
                    "options": arch_opts,
                },
            })

    config = {
        "version": "v6.4.0",
        "matchups": matchups,
    }

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    total_games = len(matchups) * games_per
    print(f"Generated {len(matchups)} matchups × {games_per} = {total_games} games")
    print(f"SideA: GiMlPolicy (ranker={ranker_path})")
    print(f"SideB: 3 archetypes: {list(ARCHETYPES.keys())}")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    main()
