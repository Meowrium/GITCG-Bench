/**
 * BattleAgent — CLI entry point for the autonomous TCG decision agent.
 *
 * Connects to a running standalone game server, attaches the BattleGraph,
 * and plays the game autonomously until completion.
 *
 * Usage:
 *   pnpm exec gnx src/agents/battle-agent.ts [--base-url URL] [--model MODEL] [--weights PATH]
 */

import { buildBattleGraph, type BattleGraphOptions } from "../graphs/battle-graph.js";
import { LogisticCalibrator, type CalibratedWeights } from "../learning/scoring/logistic-reg.js";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseCli() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string", default: process.env.GI_SERVER_URL ?? "http://localhost:3901" },
      model: { type: "string", default: process.env.OPENAI_MODEL ?? "gpt-4o" },
      weights: { type: "string", default: "" },
      "max-loops": { type: "string", default: "30" },
      temperature: { type: "string", default: process.env.OPENAI_TEMPERATURE ?? "0.2" },
      watch: { type: "boolean", default: false },
      "poll-ms": { type: "string", default: "1500" },
      "max-turns": { type: "string", default: "0" },
      "continue-on-error": { type: "boolean", default: true },
      "session-id": { type: "string", default: "" },
    },
    strict: false,
  });

  return {
    baseUrl: values["base-url"] as string,
    model: values["model"] as string,
    weightsPath: values["weights"] as string,
    maxLoops: parseInt(values["max-loops"] as string, 10),
    temperature: parseFloat(values["temperature"] as string),
    watch: Boolean(values["watch"]),
    pollMs: parseInt(values["poll-ms"] as string, 10),
    maxTurns: parseInt(values["max-turns"] as string, 10),
    continueOnError: Boolean(values["continue-on-error"]),
    sessionId: values["session-id"] as string,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseCli();

  console.log("=== GI-TCG BattleAgent ===");
  console.log(`Server:  ${cli.baseUrl}`);
  console.log(`Model:   ${cli.model}`);
  console.log(`Weights: ${cli.weightsPath || "(none)"}`);
  console.log(`Watch:   ${cli.watch ? `on (${cli.pollMs}ms)` : "off"}`);

  // Load calibrated weights if provided
  let calibratedWeights: CalibratedWeights | undefined;
  if (cli.weightsPath && existsSync(cli.weightsPath)) {
    const raw = readFileSync(cli.weightsPath, "utf-8");
    calibratedWeights = JSON.parse(raw) as CalibratedWeights;
    console.log(`Loaded ${calibratedWeights.coefficients.length} calibrated coefficients.`);
  }

  const graphOptions: BattleGraphOptions = {
    baseUrl: cli.baseUrl,
    model: cli.model,
    temperature: cli.temperature,
    calibratedWeights,
    maxLoops: cli.maxLoops,
  };

  const graph = buildBattleGraph(graphOptions);

  const sessionId = cli.sessionId || `session_${Date.now()}`;
  console.log(`Session: ${sessionId}`);
  console.log("Starting battle loop...\n");

  let turnCount = 0;
  while (true) {
    turnCount += 1;
    const result = await graph.invoke({
      sessionId,
      maxLoops: cli.maxLoops,
    });

    console.log(`\n=== Battle Turn #${turnCount} Complete ===`);
    console.log(`Loops: ${result.loopCount}`);
    console.log(`Verdict: ${result.criticVerdict}`);
    console.log(`Messages: ${result.messages.length} total`);

    const last5 = result.messages.slice(-5);
    for (const msg of last5) {
      console.log(`  [${msg.role}] ${msg.content}`);
    }

    if (!cli.watch) {
      break;
    }
    if (cli.maxTurns > 0 && turnCount >= cli.maxTurns) {
      console.log(`Reached max-turns=${cli.maxTurns}, exiting.`);
      break;
    }
    if (result.criticVerdict === "error" && !cli.continueOnError) {
      console.log("Encountered error verdict and continue-on-error=false, exiting.");
      break;
    }

    await sleep(Math.max(200, cli.pollMs));
  }
}

main().catch((err) => {
  console.error("BattleAgent fatal error:", err);
  process.exit(1);
});
