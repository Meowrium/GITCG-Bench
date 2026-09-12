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
"""Rating trajectory figure (impl-spec-3 §2.4 #1, design 2026-09-03 §7.2 #1).

Input ``ratings-history.json`` (written by tree-bench analyze):
``{"periods": [{"period": r, "players": [{"id", "mu", "phi", "sigma"}]}]}``
where each period records every player that has entered the pool so far,
*after* that period's Glicko-2 update.

One curve per model: players are ``<model>@r<n>`` (generation n); at each
rating period the curve tracks the model's newest generation present in that
period. The band is mu +/- 2*phi (~95%). Vertical dashed lines mark periods
where new players (new generations) join the pool.

Usage: ``uv run plot_trajectory.py --data <ratings-history.json> --out <dir>``
"""

from __future__ import annotations

import argparse

from _common import check_inputs, fail, load_json, parse_player_id, save_figure

import matplotlib.pyplot as plt


def main() -> None:
    ap = argparse.ArgumentParser(description="Glicko-2 rating trajectory per model")
    ap.add_argument("--data", required=True, help="path to ratings-history.json")
    ap.add_argument("--out", default="plots", help="output directory (default: ./plots)")
    args = ap.parse_args()

    check_inputs({"ratings-history.json": args.data})
    history = load_json(args.data)
    periods = sorted(history.get("periods", []), key=lambda p: p["period"])
    if not periods:
        fail(f"{args.data} contains no rating periods")

    # One entry per model per period: the newest-generation player of that
    # model present in the period (players without a @r suffix are their own
    # "model" and simply track themselves).
    series: dict[str, dict[int, tuple[float, float]]] = {}
    model_order: list[str] = []
    for rec in periods:
        newest: dict[str, tuple[int, dict]] = {}
        for st in rec.get("players", []):
            model, _rest, gen = parse_player_id(st["id"])
            g = gen if gen is not None else 0
            cur = newest.get(model)
            if cur is None or g > cur[0]:
                newest[model] = (g, st)
        for model, (_g, st) in newest.items():
            if model not in series:
                series[model] = {}
                model_order.append(model)
            series[model][rec["period"]] = (st["mu"], st["phi"])

    # Periods (after the first) where new ids join the pool -> vertical lines.
    first_period = periods[0]["period"]
    seen: set[str] = set()
    join_periods: list[int] = []
    for rec in periods:
        ids = {st["id"] for st in rec.get("players", [])}
        fresh = ids - seen
        if fresh and rec["period"] != first_period:
            join_periods.append(rec["period"])
        seen |= ids

    fig, ax = plt.subplots(figsize=(11, 6))
    cmap = plt.get_cmap("tab10")
    for k, model in enumerate(model_order):
        pts = sorted(series[model].items())
        xs = [r for r, _ in pts]
        ys = [mu for _r, (mu, _phi) in pts]
        lo = [mu - 2 * phi for _r, (mu, phi) in pts]
        hi = [mu + 2 * phi for _r, (mu, phi) in pts]
        color = cmap(k % 10)
        ax.fill_between(xs, lo, hi, color=color, alpha=0.15, linewidth=0)
        ax.plot(xs, ys, marker="o", markersize=3.5, linewidth=1.6, color=color, label=model)

    labeled = False
    for r in join_periods:
        ax.axvline(
            r,
            color="0.35",
            linestyle="--",
            linewidth=1.1,
            label=None if labeled else "new generation joins",
        )
        labeled = True

    ax.set_xlabel("rating period (generation)")
    ax.set_ylabel("Glicko-2 rating mu")
    ax.set_title("Rating trajectory (mu +/- 2*phi band; dashed = new generation enters the pool)")
    ax.grid(alpha=0.25)
    if len(model_order) > 12:
        ax.legend(loc="center left", bbox_to_anchor=(1.01, 0.5), fontsize=8)
    else:
        ax.legend(loc="best", fontsize=9)
    save_figure(fig, args.out, "trajectory.png")


if __name__ == "__main__":
    main()
