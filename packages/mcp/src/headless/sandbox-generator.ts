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
 * Sandbox Generator
 *
 * Before a game starts, generates an enhanced deck analysis by:
 * 1. Creating pure-data deck contexts (createDeckContext)
 * 2. Sending data to an LLM which writes a TypeScript analysis script
 * 3. Running the script via gnx (can import from @gi-tcg/llm-deck-analyzer)
 * 4. Capturing stdout as strategy.json
 *
 * Each side (P0/P1) gets its own sandbox directory, isolated from the other.
 * If sandbox generation fails, the agent falls back to the legacy
 * analyze_deck + injectStrategyAnchor path.
 */

/// <reference types="node" />

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────

export interface SandboxLlmConfig {
  model: string;
  apiBase: string;
  apiKey: string;
  promptTemplate: string;
  temperature: number;
  maxTokens: number;
}

export interface SandboxConfig {
  enabled: boolean;
  llm: SandboxLlmConfig;
}

export interface SandboxResult {
  sandboxDir: string;
  strategyPath: string;
  scriptPath: string;
  success: boolean;
  error?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Deck Context Builder ──────────────────────────────────────────────────

/**
 * Build a simplified JSON representation of a deck for the LLM prompt.
 * Uses createDeckContext (pure data layer) to extract all card/skill info.
 */
async function buildDeckDataJson(
  deckCode: string,
  label: string,
  version?: string,
): Promise<string> {
  const manager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER;
  const context = await createDeckContext(deckCode, manager);

  const data = {
    label,
    deckCode,
    version: version ?? null,
    characters: context.characterFullInfo.map((ch) => ({
      name: ch.name,
      elements: ch.elements,
      weapon: ch.weapon,
      nations: ch.nations,
      hp: ch.hp,
      maxEnergy: ch.maxEnergy,
      skills: ch.skills.map((s) => ({
        name: s.name,
        type: s.type,
        description: s.description,
        playCost: s.playCost,
      })),
    })),
    cards: context.cards.map((c) => ({
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      description: c.description,
      playingDescription: c.playingDescription || undefined,
      playCost: c.playCost,
      tags: c.meaningfulTags,
      relatedCharacterTag: c.relatedCharacterTag,
    })),
    cardCounts: context.summary.cardFrequencies
      .filter((f) => f.count > 1)
      .map((f) => ({ name: f.name, count: f.count })),
    entityDescriptions: Object.fromEntries(context.entityDescriptions),
    generatedHandCards: Object.fromEntries(context.generatedHandCardDescriptions),
    summary: {
      elementCounts: context.summary.elementCounts,
      nations: context.summary.nations,
      equipmentCount: context.summary.equipmentCount,
      eventCount: context.summary.eventCount,
      supportCount: context.summary.supportCount,
      talentCount: context.summary.talentCount,
      weaponCount: context.summary.weaponCount,
      artifactCount: context.summary.artifactCount,
      resonanceCount: context.summary.resonanceCount,
    },
  };

  return JSON.stringify(data, null, 2);
}

// ─── LLM Caller ────────────────────────────────────────────────────────────

async function callLlm(
  config: SandboxLlmConfig,
  systemPrompt: string,
  userPrompt: string,
  maxRetries: number = 3,
): Promise<string> {
  const normalizedBase = config.apiBase.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  const url = `${normalizedBase}/chat/completions`;

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      const errorText = await response.text();
      const waitMs = parseRateLimitWait(errorText);
      console.error(`[Sandbox] Rate limited. Waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("LLM returned no choices");
    }
    return choice.message.content ?? "";
  }

  throw new Error(`LLM call failed after ${maxRetries} retries (rate limited)`);
}

function parseRateLimitWait(errorBody: string): number {
  let waitMs = 60_000;
  try {
    const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
    const message = parsed.error?.message ?? "";
    const hrMatch = message.match(/(\d+)\s*hr/i);
    const minMatch = message.match(/(\d+)\s*min/i);
    const secMatch = message.match(/(\d+)\s*sec/i);
    let totalSeconds = 0;
    if (hrMatch) totalSeconds += parseInt(hrMatch[1]!, 10) * 3600;
    if (minMatch) totalSeconds += parseInt(minMatch[1]!, 10) * 60;
    if (secMatch) totalSeconds += parseInt(secMatch[1]!, 10);
    if (totalSeconds > 0) waitMs = totalSeconds * 1000;
  } catch {
    // fallback: 60s
  }
  return waitMs + 60_000;
}

// ─── Script Extraction ─────────────────────────────────────────────────────

/**
 * Extract TypeScript code from LLM response.
 * Looks for ```typescript ... ``` blocks, falls back to raw content.
 */
function extractScript(llmResponse: string): string {
  const codeBlockMatch = llmResponse.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1]!.trim();
  }
  // Fallback: try generic code block
  const genericMatch = llmResponse.match(/```\n([\s\S]*?)```/);
  if (genericMatch) {
    return genericMatch[1]!.trim();
  }
  // Last resort: return raw content if it looks like TS
  if (llmResponse.includes("import ") || llmResponse.includes("export ")) {
    return llmResponse.trim();
  }
  throw new Error("Could not extract TypeScript code from LLM response");
}

// ─── Script Runner ──────────────────────────────────────────────────────────

/**
 * Run a TypeScript script via gnx.
 * The script receives deck codes via env vars and should output JSON to stdout.
 * Returns { stdout, stderr, exitCode }.
 */
function runScript(
  scriptPath: string,
  projectDir: string,
  env: Record<string, string>,
  timeoutMs: number = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "pnpm",
      ["exec", "gnx", scriptPath],
      {
        cwd: projectDir,
        shell: true,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Try to parse stdout as JSON. If it fails, try to extract JSON from the output.
 */
function extractJsonFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();

  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Try to find first { ... last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonStr);
    } catch { /* continue */ }
  }

  throw new Error(`Could not extract JSON from script stdout. First 500 chars: ${trimmed.slice(0, 500)}`);
}

// ─── Main Sandbox Generator ──────────────────────────────────────────────────

/**
 * Generate a sandbox for one side (P0 or P1).
 *
 * @param who          0 or 1
 * @param myDeckCode   This side's deck code
 * @param myDeckVersion Data version used to resolve this side's deck code
 * @param oppDeckCode  Opponent's deck code
 * @param oppDeckVersion Data version used to resolve the opponent deck code
 * @param config       Sandbox LLM config
 * @param sandboxDir   Directory to write sandbox files
 * @param projectDir   Project root (for running gnx)
 * @param logCallback  Optional callback for progress logging
 * @returns            SandboxResult with paths and success status
 */
export async function generateSandbox(
  who: 0 | 1,
  myDeckCode: string,
  myDeckVersion: string | undefined,
  oppDeckCode: string,
  oppDeckVersion: string | undefined,
  config: SandboxLlmConfig,
  sandboxDir: string,
  projectDir: string,
  logCallback?: (msg: string) => void,
): Promise<SandboxResult> {
  const log = logCallback ?? ((msg: string) => console.log(`[Sandbox P${who}] ${msg}`));
  mkdirSync(sandboxDir, { recursive: true });

  const scriptPath = join(sandboxDir, "analysis.ts");
  const strategyPath = join(sandboxDir, "strategy.json");
  const generationLogPath = join(sandboxDir, "generation_log.jsonl");

  // 1. Build deck data JSON
  log("Building deck contexts...");
  const myDeckData = await buildDeckDataJson(myDeckCode, `P${who}`, myDeckVersion);
  const oppDeckData = await buildDeckDataJson(oppDeckCode, `P${who === 0 ? 1 : 0}`, oppDeckVersion);

  // Save input data
  writeFileSync(join(sandboxDir, "my_deck_data.json"), myDeckData, "utf8");
  writeFileSync(join(sandboxDir, "opp_deck_data.json"), oppDeckData, "utf8");

  // 2. Build prompt
  const promptTemplate = readFileSync(config.promptTemplate, "utf8");
  const systemPrompt = promptTemplate
    .replace("{myDeckData}", myDeckData)
    .replace("{oppDeckData}", oppDeckData);

  // 3. Call LLM to generate analysis script
  log(`Calling LLM (${config.model}) to generate analysis script...`);
  const llmStartTime = Date.now();
  let scriptContent = "";
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    const userPrompt = attempt === 1
      ? "请根据上述卡组数据，编写一个 TypeScript 分析脚本，输出结构化的策略 JSON。"
      : `上次的脚本执行失败，请修复后重新输出。\n\n错误信息:\n${(scriptContent as any)._lastError ?? ""}\n\n请重新输出完整的 TypeScript 脚本。`;

    const response = await callLlm(config, systemPrompt, userPrompt);

    appendLog(generationLogPath, {
      attempt,
      type: "llm_response",
      content: response,
      elapsed_ms: Date.now() - llmStartTime,
    });

    try {
      scriptContent = extractScript(response);
      writeFileSync(scriptPath, scriptContent, "utf8");
      log(`Script generated (${scriptContent.length} chars). Running...`);

      // 4. Run the script
      const runResult = await runScript(
        scriptPath,
        projectDir,
        {
          MY_DECK_CODE: myDeckCode,
          MY_DECK_VERSION: myDeckVersion ?? "",
          OPP_DECK_CODE: oppDeckCode,
          OPP_DECK_VERSION: oppDeckVersion ?? "",
          SANDBOX_DIR: sandboxDir,
        },
      );

      appendLog(generationLogPath, {
        attempt,
        type: "script_run",
        exit_code: runResult.exitCode,
        stdout_length: runResult.stdout.length,
        stderr: runResult.stderr.slice(0, 2000),
      });

      if (runResult.exitCode !== 0) {
        const errorMsg = `Script exited with code ${runResult.exitCode}. stderr: ${runResult.stderr.slice(0, 500)}`;
        log(`Attempt ${attempt}/${maxAttempts}: ${errorMsg}`);
        if (attempt < maxAttempts) {
          (scriptContent as any)._lastError = errorMsg;
          continue;
        }
        return {
          sandboxDir,
          strategyPath,
          scriptPath,
          success: false,
          error: errorMsg,
        };
      }

      // 5. Parse stdout as JSON
      try {
        const strategy = extractJsonFromStdout(runResult.stdout);
        writeFileSync(strategyPath, JSON.stringify(strategy, null, 2) + "\n", "utf8");
        log(`Strategy JSON saved (${runResult.stdout.length} bytes).`);
        return {
          sandboxDir,
          strategyPath,
          scriptPath,
          success: true,
        };
      } catch (e) {
        const errorMsg = `Failed to parse script output as JSON: ${(e as Error).message}`;
        log(`Attempt ${attempt}/${maxAttempts}: ${errorMsg}`);
        if (attempt < maxAttempts) {
          (scriptContent as any)._lastError = `${errorMsg}\nStdout:\n${runResult.stdout.slice(0, 1000)}`;
          continue;
        }
        return {
          sandboxDir,
          strategyPath,
          scriptPath,
          success: false,
          error: errorMsg,
        };
      }
    } catch (e) {
      const errorMsg = `Failed to extract/parse script: ${(e as Error).message}`;
      log(`Attempt ${attempt}/${maxAttempts}: ${errorMsg}`);
      if (attempt < maxAttempts) {
        (scriptContent as any)._lastError = errorMsg;
        continue;
      }
      return {
        sandboxDir,
        strategyPath,
        scriptPath,
        success: false,
        error: errorMsg,
      };
    }
  }

  return {
    sandboxDir,
    strategyPath,
    scriptPath,
    success: false,
    error: "Max attempts reached",
  };
}

function appendLog(path: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    appendFileSync(path, line, "utf8");
  } catch {
    // ignore log errors
  }
}

// ─── Convenience: generate both sandboxes in parallel ──────────────────────

export interface DualSandboxResult {
  p0: SandboxResult;
  p1: SandboxResult;
}

export async function generateBothSandboxes(
  deck0Code: string,
  deck1Code: string,
  deck0Version: string | undefined,
  deck1Version: string | undefined,
  p0Config: SandboxLlmConfig,
  p1Config: SandboxLlmConfig,
  sandboxBaseDir: string,
  projectDir: string,
  logCallback?: (who: 0 | 1, msg: string) => void,
): Promise<DualSandboxResult> {
  const p0Dir = join(sandboxBaseDir, "p0");
  const p1Dir = join(sandboxBaseDir, "p1");
  mkdirSync(p0Dir, { recursive: true });
  mkdirSync(p1Dir, { recursive: true });

  const [p0Result, p1Result] = await Promise.allSettled([
    generateSandbox(0, deck0Code, deck0Version, deck1Code, deck1Version, p0Config, p0Dir, projectDir,
      (msg) => logCallback?.(0, msg)),
    generateSandbox(1, deck1Code, deck1Version, deck0Code, deck0Version, p1Config, p1Dir, projectDir,
      (msg) => logCallback?.(1, msg)),
  ]);

  const p0: SandboxResult = p0Result.status === "fulfilled"
    ? p0Result.value
    : { sandboxDir: p0Dir, strategyPath: "", scriptPath: "", success: false, error: String(p0Result.reason) };

  const p1: SandboxResult = p1Result.status === "fulfilled"
    ? p1Result.value
    : { sandboxDir: p1Dir, strategyPath: "", scriptPath: "", success: false, error: String(p1Result.reason) };

  return { p0, p1 };
}
