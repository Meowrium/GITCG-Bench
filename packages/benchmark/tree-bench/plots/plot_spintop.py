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
"""Spinning-top structural diagnostics summary (impl-spec-3 §2.4 #5, design 09-03 §7.2 #5).

Input: ``spin-top.json`` (tree-bench analyze). Three panels:

1. transitive vs cyclic share bars (with the bootstrap 95% interval on the
   transitive share when available);
2. Nash averaging bars (expected win rate against the equilibrium mixture);
3. a matplotlib table of the response-graph clusters (rank, members,
   mean transitive strength, kind).

When the report was computed on a dense sub-tournament (``usedSubset``), the
figure title states the threshold and subset size.

Usage: ``uv run plot_spintop.py --data <spin-top.json> --out <dir>``
"""

from __future__ import annotations

import argparse
import textwrap

from _common import check_inputs, fail, load_json, save_figure

import matplotlib.pyplot as plt


def main() -> None:
    ap = argparse.ArgumentParser(description="Spinning-top diagnostics summary figure")
    ap.add_argument("--data", required=True, help="path to spin-top.json")
    ap.add_argument("--out", default="plots", help="output directory (default: ./plots)")
    args = ap.parse_args()

    check_inputs({"spin-top.json": args.data})
    data = load_json(args.data)
    report = data.get("report")
    if not report:
        fail(f"{args.data} has no 'report' object")

    ids: list[str] = report.get("agentIds", [])
    dec = report.get("decomposition", {})
    nash = report.get("nash", {}).get("ratings", [])
    clusters = report.get("clusters", [])
    boot = data.get("bootstrap")
    used = data.get("usedSubset")

    fig = plt.figure(figsize=(13, 8))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.15, 1], hspace=0.5, wspace=0.22)
    ax_share = fig.add_subplot(gs[0, 0])
    ax_nash = fig.add_subplot(gs[0, 1])
    ax_tab = fig.add_subplot(gs[1, :])

    # -- panel 1: transitive / cyclic share ---------------------------------
    trans = dec.get("transitiveShare", 0) * 100
    cyclic = dec.get("cyclicShare", 0) * 100
    bars = ax_share.bar(["transitive", "cyclic"], [trans, cyclic], color=["#2b6cb0", "#c05621"], width=0.55)
    ci = (boot or {}).get("transitiveShareCI")
    if ci:
        lo, hi = ci[0] * 100, ci[1] * 100
        ax_share.errorbar(
            [0],
            [trans],
            yerr=[[max(0, trans - lo)], [max(0, hi - trans)]],
            fmt="none",
            ecolor="0.2",
            capsize=4,
            linewidth=1.2,
        )
    for rect, v in zip(bars, (trans, cyclic)):
        ax_share.text(rect.get_x() + rect.get_width() / 2, rect.get_height() + 2, f"{v:.1f}%", ha="center", fontsize=9)
    ax_share.set_ylim(0, 108)
    ax_share.set_ylabel("share of ||skew(A)||² (%)")
    ax_share.set_title("Transitive vs cyclic decomposition")

    # -- panel 2: Nash averaging --------------------------------------------
    vals = [r * 100 for r in nash]
    ax_nash.bar(range(len(ids)), vals, color="#2b6cb0", width=0.6)
    if len(ids) > 40:
        ax_nash.set_xticks([])
    else:
        ax_nash.set_xticks(range(len(ids)))
        ax_nash.set_xticklabels(ids, rotation=45, ha="right", fontsize=8 if len(ids) <= 20 else 6)
        for i, v in enumerate(vals):
            ax_nash.text(i, v + 1.5, f"{v:.0f}", ha="center", fontsize=7)
    ax_nash.set_ylim(0, max(100, max(vals, default=0) * 1.15))
    ax_nash.set_ylabel("expected win rate vs equilibrium mix (%)")
    ax_nash.set_title("Nash averaging")

    # -- panel 3: cluster membership table ----------------------------------
    columns = ["rank", "members", "mean strength", "kind"]
    rows = []
    for c in clusters:
        rows.append(
            [
                str(c.get("rank", "")),
                textwrap.fill(", ".join(c.get("members", [])), width=64),
                f"{c.get('meanStrength', 0) * 100:.1f}%",
                "cyclic" if c.get("cyclic") else "transitive",
            ]
        )
    if not rows:
        rows = [["-", "(empty pool)", "-", "-"]]
    ax_tab.axis("off")
    table = ax_tab.table(cellText=rows, colLabels=columns, loc="center", cellLoc="left")
    table.auto_set_font_size(False)
    table.set_fontsize(8 if len(rows) <= 14 else 6)
    table.scale(1, 1.5)
    ax_tab.set_title("Response-graph clusters (rank 0 = strongest; cyclic members are not rankable internally)", fontsize=10)

    suptitle = "Spinning-top structural diagnostics"
    if used:
        suptitle += f" — dense subset: {len(used.get('players', []))} players (minGamesPerPair={used.get('threshold')})"
    fig.suptitle(suptitle, fontsize=13)
    save_figure(fig, args.out, "spintop-summary.png")


if __name__ == "__main__":
    main()
