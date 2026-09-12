#!/usr/bin/env python3
"""
Mirror a self-play benchmark config so GiMlPolicy also plays as sideB (player 1).
Halves the original games-per to keep total games manageable.

Usage:
  python3 mirror_selfplay_config.py <input.json> <output.json> [--halve-games]
"""
import json, sys, copy

def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else None
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    halve = "--halve-games" in sys.argv

    if not input_path or not output_path:
        print("Usage: mirror_selfplay_config.py <input.json> <output.json> [--halve-games]")
        sys.exit(1)

    with open(input_path) as f:
        config = json.load(f)

    mirrored = []
    for m in config["matchups"]:
        # Halve the games per matchup (original + mirrored = same total)
        games = m["games"]
        if halve:
            games = max(1, games // 2)

        # Original: GiMlPolicy = sideA (player 0)
        m["games"] = games
        mirrored.append(m)

        # Mirrored: GiMlPolicy = sideB (player 1)
        m2 = copy.deepcopy(m)
        m2["id"] = m["id"].replace("iter1-", "iter1-mirror-")
        m2["deck0"], m2["deck1"] = m["deck1"], m["deck0"]
        m2["sideA"], m2["sideB"] = copy.deepcopy(m["sideB"]), copy.deepcopy(m["sideA"])
        m2["sideA"]["name"] = m["sideB"]["name"]  # baseline stays baseline
        m2["sideB"]["name"] = m["sideA"]["name"]  # GiMlPolicy goes to player 1
        m2["games"] = games
        mirrored.append(m2)

    config["matchups"] = mirrored

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    total_games = sum(m["games"] for m in config["matchups"])
    print(f"Mirrored: {len(config['matchups'])} matchups × ~{total_games/len(config['matchups']):.0f}g = {total_games} games")
    print(f"  Original: {len(config['matchups'])//2} matchups (GiMlPolicy = player 0)")
    print(f"  Mirrored: {len(config['matchups'])//2} matchups (GiMlPolicy = player 1)")
    print(f"Output: {output_path}")

if __name__ == "__main__":
    main()
