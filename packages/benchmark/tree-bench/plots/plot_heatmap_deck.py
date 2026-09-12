# Copyright (C) 2026 Piovium Labs
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# /// script
# requires-python = ">=3.9"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Deck-level win-rate heatmap, latest generation only (impl-spec-3 §2.4 #4, design 09-03 §7.2 #4).

Input: ``heatmap.json`` from the **by-model-deck** view, whose player ids are
``<model>@<env>/<deckIdx>@r<n>``. Only the newest generation present in the
file is plotted (deck-level grids across the full history are unreadable);
cells with n == 0 games are grey + hatched.

Usage: ``uv run plot_heatmap_deck.py --data <heatmap.json> --out <dir>``
"""

from __future__ import annotations

import argparse

from _common import (
    check_inputs,
    draw_winrate_heatmap,
    fail,
    games_matrix_from_pairs,
    generation_key,
    load_json,
    parse_player_id,
    save_figure,
)

import matplotlib.pyplot as plt


def main() -> None:
    ap = argparse.ArgumentParser(description="Deck-level win-rate heatmap (latest generation)")
    ap.add_argument("--data", required=True, help="path to heatmap.json (by-model-deck view)")
    ap.add_argument("--out", default="plots", help="output directory (default: ./plots)")
    args = ap.parse_args()

    check_inputs({"heatmap.json": args.data})
    data = load_json(args.data)
    ids: list[str] = data.get("agents") or []
    win = data.get("winProbMatrix")
    if not ids or not win:
        fail(f"{args.data} has no agents/winProbMatrix")

    games = data.get("gamesMatrix")
    if not games:
        games = games_matrix_from_pairs(data.get("pairs", []), ids)

    # Keep only the newest generation (ids carry @r<n>); without any suffix,
    # treat the whole file as a single generation and show everything.
    gens = {pid: parse_player_id(pid)[2] for pid in ids}
    suffixed = [g for g in gens.values() if g is not None]
    if suffixed:
        latest = max(suffixed)
        keep = [i for i, pid in enumerate(ids) if gens[pid] == latest]
        subtitle = f"deck level, latest generation r{latest}"
    else:
        keep = list(range(len(ids)))
        subtitle = "deck level (no @r suffix found — showing all ids)"
    if not keep:
        fail(f"{args.data}: no players in the latest generation")

    ids = [ids[i] for i in keep]
    win = [[win[i][j] for j in keep] for i in keep]
    games = [[games[i][j] for j in keep] for i in keep]

    # Order rows/cols by model, then deck, then generation.
    order = sorted(range(len(ids)), key=lambda i: generation_key(ids[i]))
    ids = [ids[i] for i in order]
    win = [[win[i][j] for j in order] for i in order]
    games = [[games[i][j] for j in order] for i in order]

    n = len(ids)
    fig, ax = plt.subplots(figsize=(max(9, n * 0.6), max(8, n * 0.55)))
    draw_winrate_heatmap(ax, ids, win, games)
    fig.colorbar(ax.images[0], ax=ax, shrink=0.75, label="row player win rate")
    ax.set_title(f"Pairwise win rate — {subtitle}", fontsize=11)
    save_figure(fig, args.out, "heatmap-deck-latest.png")


if __name__ == "__main__":
    main()
