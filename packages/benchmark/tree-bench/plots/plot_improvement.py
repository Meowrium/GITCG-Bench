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
"""Iteration gain figure (impl-spec-3 §2.4 #2, design 2026-09-03 §7.2 #2).

For every model X and generation r >= 1, aggregate the win rate of X@r
against X@(r-1) (the same-model chain games in the by-model results view;
draws count 0.5). A bootstrap confidence interval (numpy, 200 resamples by
default) is computed here because analyze does not emit one.

Usage::

    uv run plot_improvement.py --data <results.json> \
        --ratings-history <ratings-history.json> --out <dir>

``--ratings-history`` is optional; when given, chain generations beyond the
last recorded rating period are dropped with a warning.
"""

from __future__ import annotations

import argparse
import sys

from _common import check_inputs, fail, load_json, parse_player_id, save_figure

import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser(description="Same-model chain win rate X@r vs X@(r-1)")
    ap.add_argument("--data", required=True, help="path to results.json (by-model view)")
    ap.add_argument("--ratings-history", default=None, help="optional ratings-history.json")
    ap.add_argument("--out", default="plots", help="output directory (default: ./plots)")
    ap.add_argument("--boot", type=int, default=200, help="bootstrap resamples (default 200, 0 disables CI)")
    ap.add_argument("--seed", type=int, default=42, help="bootstrap RNG seed")
    args = ap.parse_args()

    inputs = {"results.json": args.data}
    if args.ratings_history is not None:
        inputs["ratings-history.json"] = args.ratings_history
    check_inputs(inputs)

    rows = load_json(args.data)
    if not isinstance(rows, list) or not rows:
        fail(f"{args.data} is not a non-empty game array")

    # Aggregate chain games: (model, new generation) -> [score of the newer side]
    chains: dict[tuple[str, int], list[float]] = {}
    for g in rows:
        m1, _r1, g1 = parse_player_id(g.get("p1", ""))
        m2, _r2, g2 = parse_player_id(g.get("p2", ""))
        if m1 != m2 or g1 is None or g2 is None or abs(g1 - g2) != 1:
            continue
        newer_is_p1 = g1 > g2
        winner = g.get("winner")
        if winner == "draw":
            score = 0.5
        elif (winner == "p1") == newer_is_p1:
            score = 1.0
        else:
            score = 0.0
        key = (m1 if newer_is_p1 else m2, max(g1, g2))
        chains.setdefault(key, []).append(score)

    if not chains:
        fail(
            "no cross-generation games (X@r vs X@(r-1), same model) found in "
            f"{args.data} — player ids must look like <model>@r<n>; nothing to plot"
        )

    if args.ratings_history is not None:
        history = load_json(args.ratings_history)
        hperiods = [p.get("period") for p in history.get("periods", [])]
        if hperiods:
            max_period = max(hperiods)
            dropped = sorted(k for k in chains if k[1] > max_period)
            for k in dropped:
                print(f"warning: dropping chain {k[0]}@r{k[1]}: beyond last history period {max_period}", file=sys.stderr)
                del chains[k]
            if not chains:
                fail("all chain generations are beyond the last rating period in ratings-history.json")

    rng = np.random.default_rng(args.seed)
    models: dict[str, list[tuple[int, float, float, float]]] = {}
    for (model, gen), scores in sorted(chains.items()):
        arr = np.asarray(scores, dtype=float)
        mean = float(arr.mean())
        if args.boot > 0:
            idx = rng.integers(0, arr.size, size=(args.boot, arr.size))
            means = arr[idx].mean(axis=1)
            lo, hi = (float(v) for v in np.percentile(means, [5, 95]))
        else:
            lo = hi = mean
        models.setdefault(model, []).append((gen, mean, lo, hi))

    fig, ax = plt.subplots(figsize=(11, 6))
    cmap = plt.get_cmap("tab10")
    for k, model in enumerate(sorted(models)):
        pts = sorted(models[model])
        gens = [g for g, _m, _lo, _hi in pts]
        means = [m for _g, m, _lo, _hi in pts]
        lo = [m - l for _g, m, l, _h in pts]
        hi = [h - m for _g, m, _l, h in pts]
        ax.errorbar(
            gens,
            means,
            yerr=[lo, hi],
            marker="o",
            markersize=5,
            capsize=3,
            linewidth=1.6,
            color=cmap(k % 10),
            label=model,
        )
    ax.axhline(0.5, color="0.3", linestyle="--", linewidth=1.2, label="50% baseline")
    ax.set_xlabel("generation r (X@r vs X@(r-1))")
    ax.set_ylabel("win rate of the newer generation")
    ax.set_ylim(0, 1)
    ax.set_title("Iteration gain: same-model chain win rate (95% bootstrap CI)")
    ax.set_xticks(sorted({g for pts in models.values() for g, _m, _l, _h in pts}))
    ax.grid(alpha=0.25)
    if len(models) > 12:
        ax.legend(loc="center left", bbox_to_anchor=(1.01, 0.5), fontsize=8)
    else:
        ax.legend(loc="best", fontsize=9)
    save_figure(fig, args.out, "improvement.png")


if __name__ == "__main__":
    main()
