// Copyright (C) 2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Batch LLM Orchestrator
 *
 * Reads a batch-llm.json config, spawns parallel headless game runners +
 * LLM agents, collects results, and writes a summary.
 *
 * Each game runs on its own port (mcpState is a global singleton per
 * process, so each game needs its own process).
 *
 * Usage:
 *   gnx packages/mcp/src/headless/run-batch-llm.ts \
 *     --config .opencode/batch-llm.json \
 *     --api-base https://api.example.com/v1 \
 *     --api-key sk-xxx \
 *     --model-p0 GLM-5 \
 *     --model-p1 MiniMax-M2.5 \
 *     --concurrency 4 \
 *     --output-dir .opencode/tmp/batch-results
 */

/// <reference types="node" />

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { VERSIONS, type Version } from "@gi-tcg/core";
import { generateGameReplay } from "./replay-extractor.js";
import { generateBothSandboxes, type SandboxLlmConfig } from "./sandbox-generator.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface SandboxMatchupConfig {
  enabled?: boolean;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  promptTemplate?: string;
  temperature?: number;
  maxTokens?: number;
}

interface SideMatchupConfig {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  sandbox?: SandboxMatchupConfig;
}

interface BatchMatchup {
  id: string;
  deck0Name?: string;
  deck1Name?: string;
  deck0: string;
  deck1: string;
  /** Data version used only for pre-game deck analysis. Defaults to current data. */
  deck0Version?: string;
  /** Data version used only for pre-game deck analysis. Defaults to current data. */
  deck1Version?: string;
  games: number;
  p0?: SideMatchupConfig;
  p1?: SideMatchupConfig;
}

interface BatchConfig {
  version?: string;
  agentP0?: string;
  agentP1?: string;
  headlessPort?: number;
  apiBase?: string;
  apiKey?: string;
  modelP0?: string;
  modelP1?: string;
  systemPromptP0?: string;
  systemPromptP1?: string;
  matchups: BatchMatchup[];
}

interface CliArgs {
  configPath: string;
  apiBase: string;
  apiKey: string;
  modelP0: string;
  modelP1: string;
  systemPromptP0: string;
  systemPromptP1: string;
  concurrency: number;
  outputDir: string;
  basePort: number;
  toolExposureMode: "direct-action" | "fragmented-decision";
  startOffset: number;
  gameCount: number;
  sandboxEnabled: boolean;
  sandboxPromptTemplate: string;
  sandboxModel: string;
  sandboxTemperature: number;
  sandboxMaxTokens: number;
}

interface ResolvedSideConfig {
  model: string;
  apiBase: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  sandbox: {
    enabled: boolean;
    llm: SandboxLlmConfig;
  };
}

interface GameTask {
  matchupId: string;
  gameIndex: number;
  deck0: string;
  deck1: string;
  deck0Version?: string;
  deck1Version?: string;
  gameVersion?: Version;
  deck0Name: string;
  deck1Name: string;
  port: number;
  outputSubDir: string;
  p0Config: ResolvedSideConfig;
  p1Config: ResolvedSideConfig;
  sandboxBaseDir: string;
}

interface GameResult {
  task: GameTask;
  winner: number | null;
  elapsedMs: number;
  error: string | null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      "config": { type: "string", default: ".opencode/batch-llm.json" },
      "api-base": { type: "string", default: "" },
      "api-key": { type: "string", default: "" },
      "model-p0": { type: "string", default: "GLM-5" },
      "model-p1": { type: "string", default: "MiniMax-M2.5" },
      "system-prompt-p0": { type: "string", default: ".opencode/prompts/p0-start.md" },
      "system-prompt-p1": { type: "string", default: ".opencode/prompts/p1-start.md" },
      "concurrency": { type: "string", default: "1" },
      "output-dir": { type: "string", default: ".opencode/tmp/batch-results" },
      "base-port": { type: "string", default: "3901" },
      "tool-exposure-mode": { type: "string", default: "direct-action" },
      "start-offset": { type: "string", default: "0" },
      "game-count": { type: "string", default: "0" },
      "sandbox-enabled": { type: "string", default: "0" },
      "sandbox-prompt-template": { type: "string", default: ".opencode/prompts/sandbox-analysis-gen.md" },
      "sandbox-model": { type: "string", default: "" },
      "sandbox-temperature": { type: "string", default: "0.4" },
      "sandbox-max-tokens": { type: "string", default: "8192" },
    },
    strict: false,
  });

  const apiBase = (values["api-base"] as string) || process.env.OPENAI_API_BASE || "";
  const apiKey = (values["api-key"] as string) || process.env.OPENAI_API_KEY || "";
  if (!apiBase || !apiKey) {
    throw new Error("--api-base and --api-key (or OPENAI_API_BASE/OPENAI_API_KEY env) are required");
  }

  const mode = values["tool-exposure-mode"] as string;
  if (mode !== "direct-action" && mode !== "fragmented-decision") {
    throw new Error(`--tool-exposure-mode must be direct-action or fragmented-decision`);
  }

  return {
    configPath: values["config"] as string,
    apiBase,
    apiKey,
    modelP0: values["model-p0"] as string,
    modelP1: values["model-p1"] as string,
    systemPromptP0: values["system-prompt-p0"] as string,
    systemPromptP1: values["system-prompt-p1"] as string,
    concurrency: parseInt(values["concurrency"] as string, 10),
    outputDir: values["output-dir"] as string,
    basePort: parseInt(values["base-port"] as string, 10),
    toolExposureMode: mode as "direct-action" | "fragmented-decision",
    startOffset: parseInt(values["start-offset"] as string, 10),
    gameCount: parseInt(values["game-count"] as string, 10),
    sandboxEnabled: values["sandbox-enabled"] === "1" || values["sandbox-enabled"] === "true",
    sandboxPromptTemplate: values["sandbox-prompt-template"] as string,
    sandboxModel: (values["sandbox-model"] as string) || "",
    sandboxTemperature: parseFloat(values["sandbox-temperature"] as string),
    sandboxMaxTokens: parseInt(values["sandbox-max-tokens"] as string, 10),
  };
}

// ─── Config Loader ─────────────────────────────────────────────────────────

function loadConfig(path: string): BatchConfig {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = readFileSync(resolved, "utf8");
  return JSON.parse(raw) as BatchConfig;
}

function resolveSideConfig(
  who: 0 | 1,
  matchup: BatchMatchup,
  cli: CliArgs,
): ResolvedSideConfig {
  const sideOverride = who === 0 ? matchup.p0 : matchup.p1;
  const defaultModel = who === 0 ? cli.modelP0 : cli.modelP1;
  const defaultPrompt = who === 0 ? cli.systemPromptP0 : cli.systemPromptP1;

  const model = sideOverride?.model ?? defaultModel;
  const apiBase = sideOverride?.apiBase ?? cli.apiBase;
  const apiKey = sideOverride?.apiKey ?? cli.apiKey;
  const systemPrompt = sideOverride?.systemPrompt ?? defaultPrompt;
  const temperature = sideOverride?.temperature ?? 0.2;

  const sandboxEnabled = sideOverride?.sandbox?.enabled ?? cli.sandboxEnabled;
  const sandboxModel = sideOverride?.sandbox?.model ?? cli.sandboxModel ?? model;
  const sandboxApiBase = sideOverride?.sandbox?.apiBase ?? apiBase;
  const sandboxApiKey = sideOverride?.sandbox?.apiKey ?? apiKey;
  const sandboxPrompt = sideOverride?.sandbox?.promptTemplate ?? cli.sandboxPromptTemplate;
  const sandboxTemp = sideOverride?.sandbox?.temperature ?? cli.sandboxTemperature;
  const sandboxMaxTokens = sideOverride?.sandbox?.maxTokens ?? cli.sandboxMaxTokens;

  return {
    model,
    apiBase,
    apiKey,
    systemPrompt,
    temperature,
    sandbox: {
      enabled: sandboxEnabled,
      llm: {
        model: sandboxModel,
        apiBase: sandboxApiBase,
        apiKey: sandboxApiKey,
        promptTemplate: sandboxPrompt,
        temperature: sandboxTemp,
        maxTokens: sandboxMaxTokens,
      },
    },
  };
}

function expandMatchups(config: BatchConfig, cli: CliArgs, basePort: number, outputDir: string): GameTask[] {
  const allTasks: GameTask[] = [];
  let portOffset = 0;

  for (const matchup of config.matchups) {
    const hasDeck0Version = matchup.deck0Version !== undefined;
    const hasDeck1Version = matchup.deck1Version !== undefined;
    if (hasDeck0Version !== hasDeck1Version) {
      throw new Error(`Matchup ${matchup.id}: deck0Version and deck1Version must be set together for a historical game`);
    }
    if (matchup.deck0Version !== matchup.deck1Version) {
      throw new Error(`Matchup ${matchup.id}: both decks must use the same version for one game`);
    }
    if (matchup.deck0Version && !VERSIONS.includes(matchup.deck0Version as Version)) {
      throw new Error(`Matchup ${matchup.id}: unsupported version ${matchup.deck0Version}`);
    }
    const gameVersion = matchup.deck0Version as Version | undefined;
    const p0Config = resolveSideConfig(0, matchup, cli);
    const p1Config = resolveSideConfig(1, matchup, cli);

    for (let i = 0; i < matchup.games; i++) {
      const port = basePort + portOffset;
      const gameLabel = `${matchup.id}_game${i + 1}`;
      const gameOutputDir = join(outputDir, gameLabel);
      allTasks.push({
        matchupId: matchup.id,
        gameIndex: i,
        deck0: matchup.deck0,
        deck1: matchup.deck1,
        deck0Version: matchup.deck0Version,
        deck1Version: matchup.deck1Version,
        gameVersion,
        deck0Name: matchup.deck0Name ?? "Deck0",
        deck1Name: matchup.deck1Name ?? "Deck1",
        port,
        outputSubDir: gameOutputDir,
        p0Config,
        p1Config,
        sandboxBaseDir: join(gameOutputDir, "sandbox"),
      });
      portOffset++;
    }
  }

  // Apply startOffset and gameCount slicing
  const start = Math.max(0, cli.startOffset);
  const end = cli.gameCount > 0 ? start + cli.gameCount : allTasks.length;
  const tasks = allTasks.slice(start, end);

  // Reassign ports to be contiguous starting from basePort
  tasks.forEach((task, idx) => {
    task.port = basePort + idx;
  });

  return tasks;
}

// ─── Process Spawner ───────────────────────────────────────────────────────

function spawnHeadlessRunner(task: GameTask, projectDir: string): ChildProcess {
  const args = [
    "exec", "gnx",
    "packages/mcp/src/headless/run-headless.ts",
    "--deck0", task.deck0,
    "--deck1", task.deck1,
    ...(task.gameVersion ? ["--version", task.gameVersion] : []),
    "--port", String(task.port),
  ];

  const proc = spawn("pnpm", args, {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  return proc;
}

function spawnLlmAgent(
  task: GameTask,
  who: 0 | 1,
  projectDir: string,
  toolExposureMode: string,
  sandboxDir?: string,
): ChildProcess {
  const sideConfig = who === 0 ? task.p0Config : task.p1Config;

  const args = [
    "exec", "gnx",
    "packages/mcp/src/headless/llm-agent.ts",
    "--url", `http://localhost:${task.port}`,
    "--who", String(who),
    "--model", sideConfig.model,
    "--api-base", sideConfig.apiBase,
    "--api-key", sideConfig.apiKey,
    "--system-prompt", resolve(projectDir, sideConfig.systemPrompt),
    "--log-dir", resolve(projectDir, task.outputSubDir),
    "--tool-exposure-mode", toolExposureMode,
    "--temperature", String(sideConfig.temperature),
  ];

  if (sandboxDir && existsSync(sandboxDir)) {
    args.push("--sandbox-dir", sandboxDir);
  }

  const proc = spawn("pnpm", args, {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  return proc;
}

// ─── Port Readiness Check ──────────────────────────────────────────────────

async function waitForPort(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/mcp/0/ping`);
      if (response.ok) return true;
    } catch {
      // Port not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ─── Game Runner ───────────────────────────────────────────────────────────

async function runSingleGame(task: GameTask, cli: CliArgs, projectDir: string): Promise<GameResult> {
  const startTime = Date.now();
  const logPrefix = `[${task.matchupId}/g${task.gameIndex + 1} port=${task.port}]`;
  console.log(`${logPrefix} Starting game: ${task.deck0Name} vs ${task.deck1Name}`);

  const gameDirAbs = resolve(projectDir, task.outputSubDir);
  mkdirSync(gameDirAbs, { recursive: true });

  // 0. Sandbox generation phase (before headless runner, no port needed)
  let p0SandboxDir = "";
  let p1SandboxDir = "";

  if (task.p0Config.sandbox.enabled || task.p1Config.sandbox.enabled) {
    const sandboxBaseAbs = resolve(projectDir, task.sandboxBaseDir);
    mkdirSync(sandboxBaseAbs, { recursive: true });
    console.log(`${logPrefix} Generating sandboxes...`);

    const sandboxResult = await generateBothSandboxes(
      task.deck0,
      task.deck1,
      task.deck0Version,
      task.deck1Version,
      task.p0Config.sandbox.enabled ? task.p0Config.sandbox.llm : task.p1Config.sandbox.llm,
      task.p1Config.sandbox.enabled ? task.p1Config.sandbox.llm : task.p0Config.sandbox.llm,
      sandboxBaseAbs,
      projectDir,
      (who, msg) => console.log(`${logPrefix} [Sandbox P${who}] ${msg}`),
    );

    if (sandboxResult.p0.success) {
      p0SandboxDir = sandboxResult.p0.sandboxDir;
      console.log(`${logPrefix} P0 sandbox ready: ${p0SandboxDir}`);
    } else {
      console.warn(`${logPrefix} P0 sandbox failed: ${sandboxResult.p0.error} (falling back to legacy)`);
    }
    if (sandboxResult.p1.success) {
      p1SandboxDir = sandboxResult.p1.sandboxDir;
      console.log(`${logPrefix} P1 sandbox ready: ${p1SandboxDir}`);
    } else {
      console.warn(`${logPrefix} P1 sandbox failed: ${sandboxResult.p1.error} (falling back to legacy)`);
    }
  }

  // 1. Start headless runner
  const runnerProc = spawnHeadlessRunner(task, projectDir);
  const runnerLog = join(gameDirAbs, "headless.log");
  const runnerLogStream = (await import("node:fs")).createWriteStream(runnerLog);

  runnerProc.stdout?.pipe(runnerLogStream);
  runnerProc.stderr?.pipe(runnerLogStream);

  // 2. Wait for port to be ready
  const ready = await waitForPort(task.port, 30000);
  if (!ready) {
    console.error(`${logPrefix} Headless runner did not become ready`);
    runnerProc.kill("SIGKILL");
    return {
      task,
      winner: null,
      elapsedMs: Date.now() - startTime,
      error: "Headless runner did not start",
    };
  }
  console.log(`${logPrefix} Headless runner ready`);

  // 3. Spawn both LLM agents (with sandbox dirs if available)
  const agentP0 = spawnLlmAgent(task, 0, projectDir, cli.toolExposureMode, p0SandboxDir || undefined);
  const agentP1 = spawnLlmAgent(task, 1, projectDir, cli.toolExposureMode, p1SandboxDir || undefined);

  const p0Log = join(gameDirAbs, "agent_p0.log");
  const p1Log = join(gameDirAbs, "agent_p1.log");
  agentP0.stdout?.pipe((await import("node:fs")).createWriteStream(p0Log));
  agentP1.stdout?.pipe((await import("node:fs")).createWriteStream(p1Log));
  agentP0.stderr?.pipe((await import("node:fs")).createWriteStream(p0Log, { flags: "a" }));
  agentP1.stderr?.pipe((await import("node:fs")).createWriteStream(p1Log, { flags: "a" }));

  // 4. Wait for both agents to finish (30 min timeout per agent)
  let winner: number | null = null;
  let error: string | null = null;

  try {
    const [p0Result, p1Result] = await Promise.allSettled([
      waitForProcess(agentP0, 3_600_000), // 30 min timeout per agent
      waitForProcess(agentP1, 3_600_000),
    ]);

    let p0Crashed = false;
    let p1Crashed = false;

    if (p0Result.status === "rejected") {
      p0Crashed = true;
      error = `P0 error: ${p0Result.reason}`;
    } else if (p0Result.value !== 0) {
      p0Crashed = true;
      error = `P0 exited with code ${p0Result.value}`;
    }
    if (p1Result.status === "rejected") {
      p1Crashed = true;
      error = `${error ?? ""} P1 error: ${p1Result.reason}`;
    } else if (p1Result.value !== 0) {
      p1Crashed = true;
      error = `${error ?? ""} P1 exited with code ${p1Result.value}`;
    }

    // 5. Try to determine winner via HTTP status endpoint
    winner = await tryGetWinner(task.port);

    // 5b. Fallback: parse the headless log for "Game over! Winner: Player X"
    if (winner === null) {
      winner = parseHeadlessLogForWinner(runnerLog);
    }

    // If no winner found and agents crashed, mark as error
    if (winner === null && (p0Crashed || p1Crashed)) {
      if (!error) error = "Agents exited abnormally but no winner detected";
    }
  } finally {
    // Kill all processes
    if (!agentP0.killed) agentP0.kill("SIGTERM");
    if (!agentP1.killed) agentP1.kill("SIGTERM");
    if (!runnerProc.killed) {
      runnerProc.kill("SIGTERM");
      // Force kill after 3s
      setTimeout(() => {
        if (!runnerProc.killed) runnerProc.kill("SIGKILL");
      }, 3000);
    }
  }

  const elapsedMs = Date.now() - startTime;
  console.log(`${logPrefix} Game finished: winner=${winner ?? "unknown"} elapsed=${elapsedMs}ms`);

  // Generate structured replay from both players' LLM logs
  try {
    generateGameReplay({
      gameDir: gameDirAbs,
      meta: {
        matchupId: task.matchupId,
        gameIndex: task.gameIndex,
        deck0Name: task.deck0Name,
        deck1Name: task.deck1Name,
        deck0Code: task.deck0,
        deck1Code: task.deck1,
        deck0Version: task.deck0Version,
        deck1Version: task.deck1Version,
        gameVersion: task.gameVersion,
        modelP0: task.p0Config.model,
        modelP1: task.p1Config.model,
        winner,
        error,
        elapsedMs,
      },
    });
    console.log(`${logPrefix} Replay exported: ${join(gameDirAbs, "game_replay.json")}`);
  } catch (e) {
    console.warn(`${logPrefix} Failed to generate replay: ${(e as Error).message}`);
  }

  return { task, winner, elapsedMs, error };
}

function waitForProcess(proc: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function tryGetWinner(port: number): Promise<number | null> {
  // Try both player 0 and player 1 status endpoints.
  // The game might have ended with a winner that one side sees but the other doesn't.
  for (const who of [0, 1] as const) {
    try {
      const response = await fetch(`http://localhost:${port}/api/mcp/${who}/status`);
      if (!response.ok) continue;
      const status = await response.json() as { gameOver?: boolean; winner?: number | null; gamePhase?: string };
      const isGameOver = status.gameOver === true
        || status.gamePhase === "finished"
        || status.gamePhase === "terminated"
        || status.gamePhase === "gameEnd"
        || status.gamePhase === "5";
      if (isGameOver && (status.winner === 0 || status.winner === 1)) {
        return status.winner;
      }
      if (isGameOver) {
        // Game over but no clear winner -> draw
        return null;
      }
    } catch {
      // ignore - try next player
    }
  }
  return null;
}

function parseHeadlessLogForWinner(logPath: string): number | null {
  try {
    if (!existsSync(logPath)) return null;
    const content = readFileSync(logPath, "utf8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.includes("Game over! Winner: Player 0")) return 0;
      if (line.includes("Game over! Winner: Player 1")) return 1;
      if (line.includes("Game over! Winner: draw")) return null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Concurrency Pool ──────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= items.length) return;
      results[myIndex] = await fn(items[myIndex]!, myIndex);
    }
  }

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Port Cleanup ──────────────────────────────────────────────────────────

async function killProcessesOnPorts(startPort: number, endPort: number): Promise<void> {
  if (process.platform !== "win32") return;

  const ports: number[] = [];
  for (let p = startPort; p <= endPort; p++) ports.push(p);

  for (const port of ports) {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn("powershell", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
        ], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.on("close", () => resolve(out.trim()));
        proc.on("error", reject);
      });

      if (!result) continue;
      const pids = result.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (Number.isNaN(pid)) continue;
        try {
          process.kill(pid, "SIGTERM");
          console.log(`  [Cleanup] Killed PID ${pid} on port ${port}`);
        } catch { /* already dead */ }
      }
    } catch { /* port not in use */ }
  }

  // Brief wait for ports to be released
  await new Promise((r) => setTimeout(r, 1000));
}

// ─── Summary ───────────────────────────────────────────────────────────────

interface SummaryByMatchup {
  matchupId: string;
  deck0Name: string;
  deck1Name: string;
  total: number;
  winsP0: number;
  winsP1: number;
  draws: number;
  errors: number;
  avgElapsedMs: number;
}

function buildSummary(results: GameResult[]): {
  summary: SummaryByMatchup[];
  totalGames: number;
} {
  const byMatchup = new Map<string, GameResult[]>();
  for (const r of results) {
    const list = byMatchup.get(r.task.matchupId) ?? [];
    list.push(r);
    byMatchup.set(r.task.matchupId, list);
  }

  const summary: SummaryByMatchup[] = [];
  for (const [matchupId, games] of byMatchup) {
    const first = games[0]!;
    let winsP0 = 0, winsP1 = 0, draws = 0, errors = 0;
    let totalElapsed = 0;
    for (const g of games) {
      if (g.error) {
        errors++;
      } else if (g.winner === 0) {
        winsP0++;
      } else if (g.winner === 1) {
        winsP1++;
      } else {
        draws++;
      }
      totalElapsed += g.elapsedMs;
    }
    summary.push({
      matchupId,
      deck0Name: first.task.deck0Name,
      deck1Name: first.task.deck1Name,
      total: games.length,
      winsP0,
      winsP1,
      draws,
      errors,
      avgElapsedMs: Math.round(totalElapsed / games.length),
    });
  }

  return { summary, totalGames: results.length };
}

function formatSummaryTable(summary: SummaryByMatchup[]): string {
  const lines: string[] = [
    "Matchup ID       | Deck0        | Deck1        | Total | W-P0 | W-P1 | Draw | Err  | Avg ms",
    "-----------------|--------------|--------------|-------|------|------|------|------|-------",
  ];
  for (const s of summary) {
    lines.push(
      `${s.matchupId.padEnd(16)} | ${s.deck0Name.padEnd(12)} | ${s.deck1Name.padEnd(12)} | ${String(s.total).padStart(5)} | ${String(s.winsP0).padStart(4)} | ${String(s.winsP1).padStart(4)} | ${String(s.draws).padStart(4)} | ${String(s.errors).padStart(4)} | ${String(s.avgElapsedMs).padStart(7)}`,
    );
  }
  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseCli();
  const projectDir = process.cwd();

  // Create timestamped output directory
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(cli.outputDir, `run_${runTimestamp}`);
  const runDirAbs = resolve(projectDir, runDir);
  mkdirSync(runDirAbs, { recursive: true });

  console.log("=== GI-TCG Batch LLM Orchestrator ===");
  console.log(`Config:      ${cli.configPath}`);
  console.log(`Model P0:    ${cli.modelP0}`);
  console.log(`Model P1:    ${cli.modelP1}`);
  console.log(`Concurrency: ${cli.concurrency}`);
  console.log(`Sandbox:     ${cli.sandboxEnabled ? `enabled (model=${cli.sandboxModel || "same as game"})` : "disabled"}`);
  console.log(`Output:      ${runDir}`);
  console.log("");

  const config = loadConfig(cli.configPath);

  const tasks = expandMatchups(config, cli, cli.basePort, runDir);

  // Kill any leftover processes on the port range before starting
  await killProcessesOnPorts(cli.basePort, cli.basePort + tasks.length - 1);

  // Save run config
  const runConfig = {
    timestamp: runTimestamp,
    configPath: cli.configPath,
    modelP0: cli.modelP0,
    modelP1: cli.modelP1,
    apiBase: cli.apiBase,
    apiKey: cli.apiKey.slice(0, 8) + "***",
    concurrency: cli.concurrency,
    basePort: cli.basePort,
    toolExposureMode: cli.toolExposureMode,
    systemPromptP0: cli.systemPromptP0,
    systemPromptP1: cli.systemPromptP1,
    startOffset: cli.startOffset,
    gameCount: cli.gameCount,
    sandbox: {
      enabled: cli.sandboxEnabled,
      model: cli.sandboxModel || "(inherit from game model)",
      temperature: cli.sandboxTemperature,
      maxTokens: cli.sandboxMaxTokens,
      promptTemplate: cli.sandboxPromptTemplate,
    },
    batchConfig: config,
  };
  writeFileSync(
    join(runDirAbs, "run_config.json"),
    JSON.stringify(runConfig, null, 2) + "\n",
    "utf8",
  );

  console.log(`Expanded ${config.matchups.length} matchups into ${tasks.length} games`);
  console.log(`Port range: ${cli.basePort} - ${cli.basePort + tasks.length - 1}`);
  console.log("");

  const allResults: GameResult[] = [];
  const batchStartTime = Date.now();

  const results = await runWithConcurrency(tasks, cli.concurrency, async (task, idx) => {
    console.log(`\n=== Game ${idx + 1}/${tasks.length} ===`);
    const result = await runSingleGame(task, cli, projectDir);
    allResults.push(result);
    return result;
  });

  const totalElapsedMs = Date.now() - batchStartTime;

  // Build summary
  const { summary, totalGames } = buildSummary(results);

  console.log("\n=== Batch Complete ===\n");
  console.log(formatSummaryTable(summary));
  console.log(`\nTotal games: ${totalGames}`);
  console.log(`Total elapsed: ${totalElapsedMs}ms (${(totalElapsedMs / 1000).toFixed(1)}s)`);

  // Write summary JSON
  const summaryPath = join(runDirAbs, "summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      runTimestamp,
      config: {
        modelP0: cli.modelP0,
        modelP1: cli.modelP1,
        apiBase: cli.apiBase,
        concurrency: cli.concurrency,
      },
      totalGames,
      totalElapsedMs,
      summary,
      results: results.map((r) => ({
        matchupId: r.task.matchupId,
        gameIndex: r.task.gameIndex,
        deck0Name: r.task.deck0Name,
        deck1Name: r.task.deck1Name,
        deck0Version: r.task.deck0Version ?? null,
        deck1Version: r.task.deck1Version ?? null,
        gameVersion: r.task.gameVersion ?? null,
        port: r.task.port,
        winner: r.winner,
        elapsedMs: r.elapsedMs,
        error: r.error,
        outputDir: r.task.outputSubDir,
      })),
    }, null, 2) + "\n",
    "utf8",
  );

  console.log(`\nSummary written: ${summaryPath}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
