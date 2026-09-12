// Copyright (C) 2024-2025 Guyutongxue
//
// ── V2 Framework: Full 8×8 A/B Benchmark (High Concurrency) ──
//
// Usage: pnpm exec gnx src/evaluation/benchmark/run-v2-ab-test.ts [--games N] [--concurrency C] [--output path.json]

import { writeFile, appendFile } from "node:fs/promises";
import { CURRENT_VERSION } from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { DEFAULT_ASSETS_MANAGER } from "../../../../../assets-manager/src/index";
import { SandboxRunner } from "../../../sandbox/runner.js";
import { PolicyPlayerIO } from "../../../runtime/io/policy-player-io.js";
import { BaselinePolicy } from "../../../runtime/policy/baseline-policy.js";
import type { BenchmarkMatchup } from "../benchmark-suite.js";
import { runBenchmarkSuite } from "../benchmark-suite.js";

interface DeckInfo { name: string; code: string }
const ALL_DECKS: DeckInfo[] = [
  { name: "LeiHe",    code: "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA" },
  { name: "HongNiu",  code: "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA" },
  { name: "ShuiZhai", code: "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA" },
  { name: "ShuiBa",   code: "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA" },
  { name: "LeiLang",  code: "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA" },
  { name: "ShenXiao", code: "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA" },
  { name: "MoYou",    code: "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA" },
  { name: "ShuiNing", code: "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA" },
];

const gamesPer = (() => {
  const idx = process.argv.indexOf("--games");
  if (idx >= 0 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10) || 4;
  return 4;
})();

const concurrency = (() => {
  const idx = process.argv.indexOf("--concurrency");
  if (idx >= 0 && process.argv[idx + 1]) return Math.max(1, parseInt(process.argv[idx + 1], 10) || 8);
  return 8;
})();

const outputPath = (() => {
  const idx = process.argv.indexOf("--output");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return `/tmp/v2-ab-result-full-${Date.now()}.json`;
})();

const PROGRESS_FILE = "/tmp/v2-bench-progress.txt";

// ── Build all 64 matchups (ordered pairs, V2_ON as side 0) ──

function buildMatchups(): BenchmarkMatchup[] {
  const matchups: BenchmarkMatchup[] = [];
  for (let i = 0; i < ALL_DECKS.length; i++) {
    for (let j = 0; j < ALL_DECKS.length; j++) {
      const dA = DEFAULT_ASSETS_MANAGER.decode(ALL_DECKS[i].code);
      const dB = DEFAULT_ASSETS_MANAGER.decode(ALL_DECKS[j].code);
      matchups.push({
        id: `${ALL_DECKS[i].name}-vs-${ALL_DECKS[j].name}`,
        decks: [dA, dB] as [any, any],
        games: gamesPer,
        sideA: { name: `${ALL_DECKS[i].name}(V2_ON)`, createPlayerIO: () => new PolicyPlayerIO({ side: 0, policy: new BaselinePolicy(), v2Enabled: true }) },
        sideB: { name: `${ALL_DECKS[j].name}(V2_OFF)`, createPlayerIO: () => new PolicyPlayerIO({ side: 1, policy: new BaselinePolicy(), v2Enabled: false }) },
      });
    }
  }
  return matchups;
}

// ── Run a single matchup (with its own SandboxRunner for true isolation) ──

async function runSingle(m: BenchmarkMatchup, data: any): Promise<{ id: string; sideAName: string; sideBName: string; winsP0: number; winsP1: number; draws: number; total: number }> {
  const runner = new SandboxRunner();
  const result = await runBenchmarkSuite({ data, matchups: [m] }, runner);
  const r = result.results[0];
  return {
    id: r.matchupId,
    sideAName: r.sideAName,
    sideBName: r.sideBName,
    winsP0: r.batch.winsP0,
    winsP1: r.batch.winsP1,
    draws: r.batch.draws,
    total: r.batch.total,
  };
}

// ── Main ──

async function main() {
  console.log("=== V2 A/B Full 8×8 Benchmark ===");
  console.log(`Decks: ${ALL_DECKS.map(d => d.name).join(", ")}`);
  console.log(`Games per matchup: ${gamesPer}, Concurrency: ${concurrency}`);
  console.log(`Version: ${CURRENT_VERSION}`);
  console.log("");

  const data = getData(CURRENT_VERSION);
  const matchups = buildMatchups();
  const totalGames = matchups.length * gamesPer;
  console.log(`Total matchups: ${matchups.length}, Total games: ${totalGames}`);
  console.log("");

  await writeFile(PROGRESS_FILE, `Started: ${new Date().toISOString()}\nDecks: ${ALL_DECKS.map(d => d.name).join(", ")}\nGames: ${gamesPer}, Concurrency: ${concurrency}\n\n`);

  // Process in batches of `concurrency`
  const allResults: typeof matchups extends (infer _)[] ? any[] : never = [];
  const startAll = Date.now();

  for (let i = 0; i < matchups.length; i += concurrency) {
    const batch = matchups.slice(i, i + concurrency);
    const t0 = Date.now();

    const batchResults = await Promise.all(batch.map(m => runSingle(m, data)));
    const t1 = Date.now();
    const batchTime = ((t1 - t0) / 1000).toFixed(1);
    const totalElapsed = ((t1 - startAll) / 1000 / 60).toFixed(1);

    for (const r of batchResults) {
      const wr = r.total > 0 ? ((r.winsP0 / r.total) * 100).toFixed(1) : "?";
      const line = `[${allResults.length + 1}/${matchups.length}] ${r.id}: ${wr}% (${r.winsP0}-${r.winsP1}-${r.draws}) | total ${totalElapsed}min`;
      console.log(`  ${line}`);
      await appendFile(PROGRESS_FILE, line + "\n");
      allResults.push(r);
    }
    console.log(`  Batch of ${batch.length} done in ${batchTime}s`);
    await appendFile(PROGRESS_FILE, `  Batch done in ${batchTime}s\n`);
  }

  const elapsedMin = ((Date.now() - startAll) / 1000 / 60).toFixed(1);

  // ── Analysis ──
  let totalV2Wins = 0, totalV2Games = 0;
  const rows: any[] = [];

  for (const r of allResults) {
    const v2Wins = r.winsP0; // V2 is always side 0
    const v2Total = r.winsP0 + r.winsP1 + r.draws;
    const v2WR = v2Total > 0 ? v2Wins / v2Total : 0;
    totalV2Wins += v2Wins; totalV2Games += v2Total;
    rows.push({ id: r.id, v2Wins, v2Total, v2WR });
  }

  const overall = totalV2Games > 0 ? totalV2Wins / totalV2Games : 0;

  console.log(`\n=== RESULTS (${elapsedMin} min) ===`);
  console.log(`Overall V2 win rate: ${(overall * 100).toFixed(2)}% (${totalV2Wins}/${totalV2Games})`);
  console.log("");

  // 8×8 matrix
  const names = ALL_DECKS.map(d => d.name);
  const mat: number[][] = names.map(() => names.map(() => 0));
  const matCnt: number[][] = names.map(() => names.map(() => 0));
  for (const r of rows) {
    const [da, db] = r.id.split("-vs-");
    const ia = names.indexOf(da), ib = names.indexOf(db);
    if (ia >= 0 && ib >= 0) { mat[ia][ib] = r.v2WR; matCnt[ia][ib] = r.v2Total; }
  }

  console.log("V2 Win Rate (row=V2_ON deck, col=opponent):");
  console.log("       " + names.map(n => n.padEnd(10)).join(" "));
  for (let i = 0; i < names.length; i++) {
    const vals = mat[i].map(v => `${(v * 100).toFixed(1)}%`.padStart(8)).join(" ");
    console.log(`${names[i].padEnd(7)} ${vals}`);
  }

  console.log("\nPer-Deck V2 WR (as V2_ON):");
  for (let i = 0; i < names.length; i++) {
    let s = 0, c = 0;
    for (let j = 0; j < names.length; j++) { if (matCnt[i][j] > 0) { s += mat[i][j] * matCnt[i][j]; c += matCnt[i][j]; } }
    console.log(`  ${names[i].padEnd(10)}: ${c > 0 ? (s / c * 100).toFixed(2) : "N/A"}%`);
  }
  console.log("\nPer-Opponent V2 WR (when V2_ON faces this deck):");
  for (let j = 0; j < names.length; j++) {
    let s = 0, c = 0;
    for (let i = 0; i < names.length; i++) { if (matCnt[i][j] > 0) { s += mat[i][j] * matCnt[i][j]; c += matCnt[i][j]; } }
    console.log(`  ${names[j].padEnd(10)}: ${c > 0 ? (s / c * 100).toFixed(2) : "N/A"}%`);
  }

  // Save
  const report = {
    timestamp: new Date().toISOString(),
    version: CURRENT_VERSION,
    gamesPerMatchup: gamesPer,
    concurrency,
    totalMatchups: matchups.length,
    totalGames,
    elapsedMinutes: parseFloat(elapsedMin),
    overallV2WinRate: Math.round(overall * 10000) / 10000,
    v2Wins: totalV2Wins, v2Total: totalV2Games,
    winRateMatrix: mat.map((row, i) => ({
      deck: names[i],
      vs: row.map((v, j) => ({ opponent: names[j], v2WinRate: Math.round(v * 10000) / 10000, total: matCnt[i][j] })),
    })),
  };
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  await appendFile(PROGRESS_FILE, `\nDONE: ${new Date().toISOString()}\nOverall V2 WR: ${(overall * 100).toFixed(2)}%\n`);
  console.log(`\nResults saved: ${outputPath}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
