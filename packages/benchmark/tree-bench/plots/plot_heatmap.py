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
"""Full-history pairwise win-rate heatmap (impl-spec-3 §2.4 #3, design 09-03 §7.2 #3).

Input: ``heatmap.json`` from the **by-model** view (all generations). Rows and
columns are re-ordered model-major then generation so same-generation blocks
sit on the diagonal and same-model chains appear as off-diagonal stripes.
Cells with n == 0 games are grey + hatched (never read as a 0.5 tie), every
played cell is annotated with win rate and n, and coverage (played pairs /
total pairs) is shown in the title.

Usage: ``uv run plot_heatmap.py --data <heatmap.json> --out <dir>``
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
    save_figure,
)

import matplotlib.pyplot as plt


def main() -> None:
    ap = argparse.ArgumentParser(description="Full-history by-model win-rate heatmap")
    ap.add_argument("--data", required=True, help="path to heatmap.json (by-model view)")
    ap.add_argument("--out", default="plots", help="output directory (default: ./plots)")
    args = ap.parse_args()

    check_inputs({"heatmap.json": args.data})
    data = load_json(args.data)
    ids = data.get("agents")
    win = data.get("winProbMatrix")
    if not ids or not win:
        fail(f"{args.data} has no agents/winProbMatrix")

    games = data.get("gamesMatrix")
    if not games:
        games = games_matrix_from_pairs(data.get("pairs", []), ids)

    # Model x generation block ordering.
    order = sorted(range(len(ids)), key=lambda i: generation_key(ids[i]))
    ids = [ids[i] for i in order]
    win = [[win[i][j] for j in order] for i in order]
    games = [[games[i][j] for j in order] for i in order]

    n = len(ids)
    fig, ax = plt.subplots(figsize=(max(9, n * 0.55), max(8, n * 0.5)))
    draw_winrate_heatmap(ax, ids, win, games)
    fig.colorbar(ax.images[0], ax=ax, shrink=0.75, label="row player win rate")

    title = "Pairwise win rate — all generations (rows ordered model x generation)"
    coverage = data.get("coverage")
    if coverage:
        title += (
            f"\ncoverage: {coverage.get('pairsPlayed', '?')}/{coverage.get('pairsTotal', '?')}"
            f" pairs played ({coverage.get('ratio', 0) * 100:.1f}%) — hatched = never played"
        )
    ax.set_title(title, fontsize=11)
    save_figure(fig, args.out, "heatmap-full.png")


if __name__ == "__main__":
    main()
