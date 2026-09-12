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
 * Standalone LLM Agent - plays one side of a game without opencode TUI.
 *
 * Connects to a running HeadlessGameRunner via HTTP (StandaloneMcpClient),
 * uses StandaloneMcpToolHandler for all game tools, and drives an
 * OpenAI-compatible chat/completions loop with tool calling.
 *
 * Every LLM request/response/tool_call is logged to a JSONL file for
 * post-hoc analysis.
 *
 * Usage:
 *   gnx packages/mcp/src/headless/llm-agent.ts \
 *     --url http://localhost:3901 \
 *     --who 0 \
 *     --model GLM-5 \
 *     --api-base https://api.example.com/v1 \
 *     --api-key sk-xxx \
 *     --system-prompt .opencode/prompts/p0-start.md \
 * --log-dir .opencode/tmp/batch-results/game_001
 */

/// <reference types="node" />

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { StandaloneMcpToolHandler } from "../mcp/StandaloneMcpToolHandler.js";
import { StandaloneMcpClient } from "../StandaloneMcpClient.js";
import type { ToolDefinition } from "../mcp/MCPProtocol.js";
import { DigestRenderer } from "../mcp/DigestRenderer.js";
import type { TurnDigestV1 } from "../scoring/types.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface CliArgs {
  url: string;
  who: 0 | 1;
  model: string;
  apiBase: string;
  apiKey: string;
  systemPrompt: string;
  logDir: string;
  maxRounds: number;
  temperature: number;
  maxToolCallsPerTurn: number;
  toolExposureMode: "direct-action" | "fragmented-decision";
  sessionId: string;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  sandboxDir: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      "url": { type: "string", default: "http://localhost:3901" },
      "who": { type: "string", default: "0" },
      "model": { type: "string", default: "GLM-5" },
      "api-base": { type: "string", default: "" },
      "api-key": { type: "string", default: "" },
      "system-prompt": { type: "string", default: "" },
      "log-dir": { type: "string", default: ".opencode/tmp/batch-results" },
      "max-rounds": { type: "string", default: "60" },
      "temperature": { type: "string", default: "0.2" },
      "max-tool-calls-per-turn": { type: "string", default: "15" },
      "tool-exposure-mode": { type: "string", default: "direct-action" },
      "session-id": { type: "string", default: "" },
      "poll-interval-ms": { type: "string", default: "500" },
      "wait-timeout-ms": { type: "string", default: "300000" },
      "sandbox-dir": { type: "string", default: "" },
    },
    strict: false,
  });

  const whoNum = parseInt(values["who"] as string, 10);
  if (whoNum !== 0 && whoNum !== 1) {
    throw new Error(`--who must be 0 or 1, got: ${values["who"]}`);
  }

  const apiBase = (values["api-base"] as string) || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "";
  const apiKey = (values["api-key"] as string) || process.env.OPENAI_API_KEY || "";
  if (!apiBase || !apiKey) {
    throw new Error("--api-base and --api-key (or OPENAI_API_BASE/OPENAI_API_KEY env) are required");
  }

  const mode = values["tool-exposure-mode"] as string;
  if (mode !== "direct-action" && mode !== "fragmented-decision") {
    throw new Error(`--tool-exposure-mode must be direct-action or fragmented-decision, got: ${mode}`);
  }

  return {
    url: values["url"] as string,
    who: whoNum as 0 | 1,
    model: values["model"] as string,
    apiBase,
    apiKey,
    systemPrompt: values["system-prompt"] as string,
    logDir: values["log-dir"] as string,
    maxRounds: parseInt(values["max-rounds"] as string, 10),
    temperature: parseFloat(values["temperature"] as string),
    maxToolCallsPerTurn: parseInt(values["max-tool-calls-per-turn"] as string, 10),
    toolExposureMode: mode as "direct-action" | "fragmented-decision",
    sessionId: (values["session-id"] as string) || `agent_${Date.now()}`,
    pollIntervalMs: parseInt(values["poll-interval-ms"] as string, 10),
    waitTimeoutMs: parseInt(values["wait-timeout-ms"] as string, 10),
    sandboxDir: values["sandbox-dir"] as string,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── LLM Logger ───────────────────────────────────────────────────────────

class LlmLogger {
  private logPath: string;

  constructor(logDir: string, who: 0 | 1) {
    mkdirSync(logDir, { recursive: true });
    this.logPath = join(logDir, `p${who}_llm.jsonl`);
  }

  log(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(this.logPath, line + "\n", "utf8");
  }
}

// ─── Tool Definition Converter ─────────────────────────────────────────────

function toOpenAITools(tools: ToolDefinition[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ─── LLM Agent ─────────────────────────────────────────────────────────────

class LlmAgent {
  private cli: CliArgs;
  private handler: StandaloneMcpToolHandler;
  private client: StandaloneMcpClient;
  private logger: LlmLogger;
  private conversation: ChatMessage[] = [];
  private consecutiveErrors = 0;
  private requestCounter = 0;

  constructor(cli: CliArgs) {
    this.cli = cli;
    this.client = new StandaloneMcpClient(cli.url, cli.who);
    this.handler = new StandaloneMcpToolHandler(cli.url, {
      who: cli.who,
      toolExposureMode: cli.toolExposureMode,
    });
    this.logger = new LlmLogger(cli.logDir, cli.who);
  }

  async run(): Promise<void> {
    console.log(`[Agent P${this.cli.who}] Starting. model=${this.cli.model} url=${this.cli.url}`);

    // Wait for bridge to be reachable
    await this.waitForBridge();

    // Build system prompt
    const systemPrompt = this.loadSystemPrompt();
    this.conversation.push({ role: "system", content: systemPrompt });

    // Get tool definitions
    const tools = this.handler.getToolDefinitions();
    const openaiTools = toOpenAITools(tools);
    console.log(`[Agent P${this.cli.who}] ${tools.length} tools available`);

    // ── Pipeline: automated opening phase ──
    await this.runOpeningPhase();

    // Initial user message for the turn loop
    this.conversation.push({
      role: "user",
      content: "开局阶段已完成。请开始对战：分析局面并选择最优操作。",
    });

    // Main loop
    let round = 0;
    while (round < this.cli.maxRounds) {
      round++;
      const gameOver = await this.checkGameOver();
      if (gameOver) {
        console.log(`[Agent P${this.cli.who}] Game over detected at round ${round}.`);
        break;
      }

      // Call LLM
      let toolCallCount = 0;
      let shouldEnd = false;

      while (toolCallCount < this.cli.maxToolCallsPerTurn) {
        const result = await this.callLLM(openaiTools);

        if (result.toolCalls.length === 0) {
          // No tool calls - LLM wants to talk or is done
          if (result.content) {
            this.conversation.push({
              role: "assistant",
              content: result.content,
              tool_calls: undefined,
            });
          }
          break;
        }

        // Add assistant message with tool_calls
        this.conversation.push({
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls,
        });

        // Execute each tool call
        for (const tc of result.toolCalls) {
          toolCallCount++;
          const toolResult = await this.executeToolCall(tc.function.name, tc.function.arguments);

          // Add tool result to conversation
          this.conversation.push({
            role: "tool",
            content: toolResult,
            tool_call_id: tc.id,
          });

          // Check if this was a game-over check
          if (tc.function.name === "get_game_result") {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.game_over === true) {
                shouldEnd = true;
              }
            } catch { /* ignore */ }
          }

          // After any action tool, check if game ended
          if (tc.function.name === "choose_action" || tc.function.name === "switch_hands" ||
              tc.function.name === "choose_active" || tc.function.name === "reroll_dice" ||
              tc.function.name === "select_card") {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.game_over === true || parsed.you_won !== undefined) {
                shouldEnd = true;
              }
            } catch { /* ignore */ }
            // Also check via status endpoint
            if (!shouldEnd) {
              const go = await this.checkGameOver();
              if (go) shouldEnd = true;
            }
          }
        }

        if (shouldEnd) break;
      }

      if (shouldEnd) {
        console.log(`[Agent P${this.cli.who}] Game over from get_game_result.`);
        break;
      }

      // If no tool calls were made, send a nudge
      if (toolCallCount === 0) {
        this.conversation.push({
          role: "user",
          content: "请继续使用工具进行操作。调用 wait_for_my_turn 等待你的回合，然后调用 choose_action 选择行动。如果你不确定游戏状态，可以调用 get_game_status 或 get_game_result。",
        });
      }

      // Brief pause before next round
      await sleep(200);
    }

    // Final game result
    const finalResult = await this.getGameResult();
    this.logger.log({
      type: "final_result",
      round,
      game_result: finalResult,
    });
    console.log(`[Agent P${this.cli.who}] Finished. rounds=${round}`);
  }

  // ── Pipeline: Automated Opening Phase ──

  /**
   * Automated opening phase:
   * 1. Fetch + analyze both decks (auto, no LLM)
   * 2. Inject strategy anchor into system prompt (auto)
   * 3. wait_for_my_turn -> switchHands (LLM decides)
   * 4. wait_for_my_turn -> chooseActive (LLM decides)
   * 5. wait_for_my_turn -> rerollDice (auto strategy)
   */
  private async runOpeningPhase(): Promise<void> {
    console.log(`[Agent P${this.cli.who}] Opening phase: fetching decks...`);

    // 1. Try loading sandbox strategy
    const sandboxLoaded = await this.tryLoadSandboxStrategy();

    if (!sandboxLoaded) {
      // Fallback: legacy deck analysis path
      console.log(`[Agent P${this.cli.who}] No sandbox strategy, using legacy deck analysis...`);

      // Fetch decks
      const myDeckTool = this.cli.who === 0 ? "get_player0_deck" : "get_player0_deck";
      const oppDeckTool = "get_player1_deck";
      const myDeckResult = await this.handler.executeTool(myDeckTool, {});
      const myDeck = JSON.parse(myDeckResult.content?.[0]?.text ?? "{}");
      const oppDeckResult = await this.handler.executeTool(oppDeckTool, {});
      const oppDeck = JSON.parse(oppDeckResult.content?.[0]?.text ?? "{}");
      console.log(`[Agent P${this.cli.who}] Decks fetched.`);

      // Analyze decks
      const analysisResult = await this.handler.executeTool("analyze_deck", {
        deck_code: myDeck.deck_code ?? myDeck.code ?? "",
        deck_name: `P${this.cli.who}`,
      });
      const analysis = JSON.parse(analysisResult.content?.[0]?.text ?? "{}")?.analysis;
      const oppAnalysisResult = await this.handler.executeTool("analyze_deck", {
        deck_code: oppDeck.deck_code ?? oppDeck.code ?? "",
        deck_name: `P${this.cli.who === 0 ? 1 : 0}`,
      });
      const oppAnalysis = JSON.parse(oppAnalysisResult.content?.[0]?.text ?? "{}")?.analysis;
      const matchupResult = await this.handler.executeTool("analyze_matchup", {
        my_deck_code: myDeck.deck_code ?? myDeck.code ?? "",
        my_deck_name: `P${this.cli.who}`,
        opponent_deck_code: oppDeck.deck_code ?? oppDeck.code ?? "",
        opponent_deck_name: `P${this.cli.who === 0 ? 1 : 0}`,
      });
      const matchup = JSON.parse(matchupResult.content?.[0]?.text ?? "{}")?.matchup;
      console.log(`[Agent P${this.cli.who}] Decks analyzed.`);

      // Inject strategy anchor into system prompt
      this.injectStrategyAnchor(analysis, oppAnalysis, matchup);
    }

    // Enter switchHands phase
    await this.handler.executeTool("wait_for_my_turn", {});
    console.log(`[Agent P${this.cli.who}] Entered switchHands phase.`);

    // LLM mulligan decision
    await this.askLLMForMulligan();

    // Enter chooseActive phase
    await this.handler.executeTool("wait_for_my_turn", {});
    console.log(`[Agent P${this.cli.who}] Entered chooseActive phase.`);

    // LLM active character selection
    await this.askLLMForActive();

    // Enter rerollDice phase
    await this.handler.executeTool("wait_for_my_turn", {});
    console.log(`[Agent P${this.cli.who}] Entered rerollDice phase.`);

    // Auto reroll
    await this.autoRerollDice();
    console.log(`[Agent P${this.cli.who}] Opening phase complete.`);
  }

  /**
   * Try to load strategy from sandbox directory.
   * If sandboxDir is set and strategy.json exists, inject it into the
   * system prompt and return true. Otherwise return false.
   */
  private async tryLoadSandboxStrategy(): Promise<boolean> {
    if (!this.cli.sandboxDir) return false;
    const strategyPath = join(this.cli.sandboxDir, "strategy.json");
    if (!existsSync(strategyPath)) {
      console.log(`[Agent P${this.cli.who}] Sandbox strategy not found at ${strategyPath}`);
      return false;
    }

    try {
      const strategyRaw = readFileSync(strategyPath, "utf8");
      const strategy = JSON.parse(strategyRaw);
      console.log(`[Agent P${this.cli.who}] Sandbox strategy loaded (${strategyRaw.length} bytes).`);

      // Build strategy text from sandbox strategy JSON
      const parts: string[] = [];

      if (strategy.archetype) parts.push(`卡组类型: ${strategy.archetype}`);
      if (strategy.winCondition) parts.push(`胜利条件: ${strategy.winCondition}`);
      if (Array.isArray(strategy.keyCards) && strategy.keyCards.length > 0) {
        parts.push(`关键卡牌: ${strategy.keyCards.join(", ")}`);
      }
      if (Array.isArray(strategy.comboChains) && strategy.comboChains.length > 0) {
        const comboTexts = strategy.comboChains.map((c: any) =>
          `${c.name}: ${Array.isArray(c.steps) ? c.steps.join(" -> ") : ""}${c.condition ? ` (${c.condition})` : ""}`
        );
        parts.push(`Combo 链:\n${comboTexts.map((t: string) => `  - ${t}`).join("\n")}`);
      }
      if (strategy.resourceCurve) {
        const rc = strategy.resourceCurve;
        parts.push(`资源曲线: 前期[${rc.earlyGame ?? "?"}] / 中期[${rc.midGame ?? "?"}] / 后期[${rc.lateGame ?? "?"}]`);
      }
      if (strategy.matchupStrategy) {
        const ms = strategy.matchupStrategy;
        if (ms.myAdvantage) parts.push(`我方优势: ${ms.myAdvantage}`);
        if (ms.opponentThreat) parts.push(`对手威胁: ${ms.opponentThreat}`);
        if (ms.gamePlan) parts.push(`对局计划: ${ms.gamePlan}`);
      }
      if (strategy.openingPriorities) {
        const op = strategy.openingPriorities;
        if (op.activeCharacter) parts.push(`推荐首发: ${op.activeCharacter}`);
        if (Array.isArray(op.mulliganKeep) && op.mulliganKeep.length > 0) {
          parts.push(`优先保留: ${op.mulliganKeep.join(", ")}`);
        }
        if (Array.isArray(op.mulliganDiscard) && op.mulliganDiscard.length > 0) {
          parts.push(`优先替换: ${op.mulliganDiscard.join(", ")}`);
        }
        if (op.rerollStrategy) parts.push(`重投策略: ${op.rerollStrategy}`);
      }
      if (Array.isArray(strategy.turnByTurnPlan) && strategy.turnByTurnPlan.length > 0) {
        const planTexts = strategy.turnByTurnPlan.map((t: any) =>
          `T${t.turn}: ${t.goal ?? "?"}${Array.isArray(t.priorityActions) ? ` [${t.priorityActions.join(", ")}]` : ""}`
        );
        parts.push(`回合计划:\n${planTexts.map((t: string) => `  ${t}`).join("\n")}`);
      }
      if (strategy.riskManagement) {
        const rm = strategy.riskManagement;
        if (rm.lethalThresholds) parts.push(`斩杀线: ${rm.lethalThresholds}`);
        if (rm.resourceReserves) parts.push(`保留资源: ${rm.resourceReserves}`);
        if (rm.defensivePriorities) parts.push(`防守优先: ${rm.defensivePriorities}`);
      }
      if (strategy.customAnalysis) {
        parts.push(`额外分析: ${strategy.customAnalysis}`);
      }

      if (parts.length > 0) {
        const strategyText = "\n\n## 卡组策略锚点 (沙箱深度分析)\n" + parts.join("\n");
        this.conversation[0]!.content += strategyText;
      }

      return true;
    } catch (e) {
      console.warn(`[Agent P${this.cli.who}] Failed to load sandbox strategy: ${e}`);
      return false;
    }
  }

  /**
   * Inject strategy anchor from deck analysis into system prompt.
   * New format: analysis is a DeckContext-like object with characters, cards, summary.
   * matchup has myDeck / opponentDeck with the same structure.
   */
  private injectStrategyAnchor(
    analysis: any,
    oppAnalysis: any,
    matchup: any,
  ): void {
    const parts: string[] = [];
    const myDeck = matchup?.myDeck ?? analysis;
    const oppDeck = matchup?.opponentDeck ?? oppAnalysis;

    // Characters
    if (myDeck?.characters?.length > 0) {
      const chars = myDeck.characters.map((c: any) =>
        `${c.name}(${c.elements?.join("/") ?? "?"}, HP:${c.hp}, 能量:${c.maxEnergy})`
      ).join(", ");
      parts.push(`我方角色: ${chars}`);
    }
    if (oppDeck?.characters?.length > 0) {
      const chars = oppDeck.characters.map((c: any) =>
        `${c.name}(${c.elements?.join("/") ?? "?"}, HP:${c.hp}, 能量:${c.maxEnergy})`
      ).join(", ");
      parts.push(`对手角色: ${chars}`);
    }

    // Summary
    if (myDeck?.summary) {
      const s = myDeck.summary;
      parts.push(`卡组统计: 装备${s.equipmentCount}/事件${s.eventCount}/支援${s.supportCount}/天赋${s.talentCount}/武器${s.weaponCount}/圣遗物${s.artifactCount}/共鸣${s.resonanceCount}`);
    }
    if (myDeck?.summary?.elementCounts) {
      const els = Object.entries(myDeck.summary.elementCounts).map(([k, v]) => `${k}:${v}`).join(", ");
      parts.push(`元素分布: ${els}`);
    }

    // Key cards (talent cards with related character)
    if (myDeck?.cards?.length > 0) {
      const keyCards = myDeck.cards.filter((c: any) =>
        c.tags?.includes("天赋") || c.subtype === "天赋"
      ).map((c: any) => c.name);
      if (keyCards.length > 0) {
        parts.push(`天赋卡: ${keyCards.join(", ")}`);
      }
    }

    // Opponent key cards
    if (oppDeck?.cards?.length > 0) {
      const oppKeyCards = oppDeck.cards.filter((c: any) =>
        c.tags?.includes("天赋") || c.subtype === "天赋"
      ).map((c: any) => `${c.name}(${c.relatedCharacterTag ?? "?"})`);
      if (oppKeyCards.length > 0) {
        parts.push(`对手天赋卡: ${oppKeyCards.join(", ")}`);
      }
    }

    // Entities (summons/statuses)
    if (myDeck?.entityDescriptions) {
      const entityNames = Object.keys(myDeck.entityDescriptions);
      if (entityNames.length > 0) {
        parts.push(`卡组引用实体: ${entityNames.slice(0, 5).join(", ")}`);
      }
    }

    if (parts.length > 0) {
      const strategyText = "\n\n## 卡组策略锚点\n" + parts.join("\n");
      this.conversation[0]!.content += strategyText;
    }
  }

  /**
   * Ask LLM to decide which cards to replace in the mulligan phase.
   */
  private async askLLMForMulligan(): Promise<void> {
    const digestResult = await this.handler.executeTool("get_turn_digest_v1", {});
    const digestText = digestResult.content?.[0]?.text ?? "{}";
    const digestData = JSON.parse(digestText);
    const digest = digestData?.digest;
    if (!digest) {
      console.log(`[Agent P${this.cli.who}] No digest for mulligan, skipping.`);
      return;
    }

    // Render digest for LLM context
    const rendered = DigestRenderer.render(digest);
    const prompt = `${rendered}\n\n## 换手牌决策\n请决定要替换哪些手牌。回复格式：{"removed_hand_ids": [id1, id2, ...]}\n传空数组表示保留全部。`;

    // Call LLM without tools for text response
    const response = await this.callLLMSimple(prompt);
    const decision = this.parseMulliganResponse(response, digest);
    console.log(`[Agent P${this.cli.who}] Mulligan: removing ${decision.removed_hand_ids.length} cards.`);

    await this.handler.executeTool("switch_hands", decision);
  }

  /**
   * Ask LLM to choose active character.
   */
  private async askLLMForActive(): Promise<void> {
    const digestResult = await this.handler.executeTool("get_turn_digest_v1", {});
    const digestText = digestResult.content?.[0]?.text ?? "{}";
    const digestData = JSON.parse(digestText);
    const digest = digestData?.digest;
    if (!digest) {
      console.log(`[Agent P${this.cli.who}] No digest for chooseActive, skipping.`);
      return;
    }

    const rendered = DigestRenderer.render(digest);
    const prompt = `${rendered}\n\n## 选出战角色\n请选择初始出战角色。回复格式：{"character_id": <id>}`;

    const response = await this.callLLMSimple(prompt);
    const decision = this.parseActiveResponse(response, digest);
    console.log(`[Agent P${this.cli.who}] Choose active: ${decision.character_id}`);

    await this.handler.executeTool("choose_active", decision);
  }

  /**
   * Auto reroll dice based on simple strategy:
   * Keep active character's element dice + omni, reroll the rest.
   */
  private async autoRerollDice(): Promise<void> {
    const digestResult = await this.handler.executeTool("get_turn_digest_v1", {});
    const digestText = digestResult.content?.[0]?.text ?? "{}";
    const digestData = JSON.parse(digestText);
    const digest = digestData?.digest;
    if (!digest) return;

    const self = (digest.self_summary ?? {}) as Record<string, unknown>;
    const chars = (Array.isArray(self.characters) ? self.characters : []) as Array<{ id: number }>;
    const activeId = self.active_character_id;
    const activeChar = chars.find((c) => c.id === activeId) ?? chars[0];
    if (!activeChar) return;

    // Find active character's element from character_definitions
    const charDefs = digest.character_definitions ?? [];
    const activeDef = charDefs.find((d: any) => d.id === activeChar.id);
    const activeElement = activeDef?.element;
    const elementToDice: Record<string, number> = {
      cryo: 1, hydro: 2, pyro: 3, electro: 4,
      anemo: 5, geo: 6, dendro: 7,
    };
    const keepType = activeElement ? elementToDice[activeElement] : undefined;

    const dice = (Array.isArray((digest.resource_summary as any)?.dice) ? (digest.resource_summary as any).dice : []) as number[];
    // Reroll dice that are neither the active element nor omni (8)
    const diceToReroll = dice.filter((d) => d !== 8 && d !== keepType);

    console.log(`[Agent P${this.cli.who}] Reroll: ${diceToReroll.length} dice.`);
    await this.handler.executeTool("reroll_dice", { dice_to_reroll: diceToReroll });
  }

  /**
   * Call LLM with a simple text prompt (no tools) and return the text response.
   */
  private async callLLMSimple(prompt: string): Promise<string> {
    const messages = [...this.conversation, { role: "user" as const, content: prompt }];
    const body: Record<string, unknown> = {
      model: this.cli.model,
      messages,
      temperature: this.cli.temperature,
    };
    const normalizedBase = this.cli.apiBase.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
    const url = `${normalizedBase}/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.cli.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = await response.json() as ChatCompletionResponse;
    const choice = data.choices?.[0];
    return choice?.message?.content ?? "";
  }

  /**
   * Parse LLM mulligan response into { removed_hand_ids }.
   */
  private parseMulliganResponse(response: string, digest: any): { removed_hand_ids: number[] } {
    try {
      // Try to find JSON in the response
      const jsonMatch = response.match(/\{[^}]*removed_hand_ids[^}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.removed_hand_ids)) {
          return { removed_hand_ids: parsed.removed_hand_ids.filter((id: any) => Number.isInteger(id)) };
        }
      }
    } catch { /* fall through */ }
    // Default: keep all
    return { removed_hand_ids: [] };
  }

  /**
   * Parse LLM active character response into { character_id }.
   */
  private parseActiveResponse(response: string, digest: any): { character_id: number } {
    try {
      const jsonMatch = response.match(/\{[^}]*character_id[^}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Number.isInteger(parsed.character_id)) {
          return { character_id: parsed.character_id };
        }
      }
    } catch { /* fall through */ }
    // Default: pick first candidate
    const candidates = digest?.candidate_actions ?? [];
    for (const c of candidates) {
      if (c?.action_case === "chooseActive") {
        const match = String(c.candidate_id ?? "").match(/cand_choose_active_(\d+)/);
        if (match) return { character_id: parseInt(match[1], 10) };
      }
    }
    // Ultimate fallback: first character
    const selfChars = (digest?.self_summary?.characters as any[]) ?? [];
    return { character_id: selfChars[0]?.id ?? 0 };
  }

  private async waitForBridge(): Promise<void> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      const ok = await this.client.ping();
      if (ok) {
        console.log(`[Agent P${this.cli.who}] Bridge connected.`);
        return;
      }
      await sleep(500);
    }
    throw new Error(`Failed to connect to bridge at ${this.cli.url} after ${maxAttempts} attempts`);
  }

  private loadSystemPrompt(): string {
    if (this.cli.systemPrompt && existsSync(this.cli.systemPrompt)) {
      return readFileSync(this.cli.systemPrompt, "utf8");
    }
    // Default system prompt (simplified - harness handles opening phase)
    return [
      "你是七圣召唤 AI 选手。",
      "",
      "## 对局流程",
      "1. 开局阶段已由 harness 自动完成。",
      "2. 每回合：分析局面和可用操作，选最优编号提交。",
      "3. 快速行动后可继续行动。慢速行动后轮到对手。",
      "",
      "## 决策框架",
      "1. 即时收益：这个操作当回合能拿到什么？",
      "2. 即时风险：消耗了什么关键资源？暴露了什么弱点？",
      "3. 未来收益：为后续回合解锁了什么？",
      "4. 斩杀优先：能杀就杀，不要犹豫",
      "5. 对手已结束则最大化行动",
      "",
      "candidate_id 格式 cand_N，N 即 action_index。",
      "快速行动后返回值自动附带 digest，直接用不要调 wait_for_my_turn。",
      "异常恢复：连续3次提交失败时系统自动 declareEnd 兜底。",
    ].join("\n");
  }

  private async callLLM(tools: Array<{ type: "function"; function: Record<string, unknown> }>): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> {
    this.requestCounter++;
    const requestId = `req_${this.requestCounter}_${Date.now()}`;

    const body: Record<string, unknown> = {
      model: this.cli.model,
      messages: this.conversation,
      temperature: this.cli.temperature,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
    };

    const normalizedBase = this.cli.apiBase.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
    const url = `${normalizedBase}/chat/completions`;
    const startTime = Date.now();

    this.logger.log({
      type: "llm_request",
      request_id: requestId,
      url,
      model: this.cli.model,
      messages: this.conversation.map((m) => ({
        role: m.role,
        content_length: typeof m.content === "string" ? m.content.length : 0,
        tool_calls: m.tool_calls?.length ?? 0,
      })),
      message_count: this.conversation.length,
    });

    const maxRetries = 5;
    let response: Response;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.cli.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        this.logger.log({
          type: "llm_error",
          request_id: requestId,
          error: (e as Error).message,
        });
        throw e;
      }

      const elapsedMs = Date.now() - startTime;

      if (response.status === 429 && attempt < maxRetries) {
        const errorText = await response.text();
        const waitMs = this.parseRateLimitWait(errorText);

        this.logger.log({
          type: "llm_rate_limited",
          request_id: requestId,
          attempt: attempt + 1,
          max_retries: maxRetries,
          raw_error: errorText.slice(0, 1000),
          wait_ms: waitMs,
          will_retry: true,
        });

        console.log(`[Agent P${this.cli.who}] Rate limited (429). Waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.log({
          type: "llm_http_error",
          request_id: requestId,
          status: response.status,
          error: errorText.slice(0, 2000),
          elapsed_ms: elapsedMs,
          attempt: attempt + 1,
        });
        throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(0, 500)}`);
      }

      break;
    }

    const elapsedMs = Date.now() - startTime;
    const data = (await response!.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("LLM returned no choices");
    }

    const content = choice.message.content;
    const toolCalls = choice.message.tool_calls ?? [];

    this.logger.log({
      type: "llm_response",
      request_id: requestId,
      content: content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      finish_reason: choice.finish_reason,
      usage: data.usage,
      elapsed_ms: elapsedMs,
    });

    // Also log full raw response for complete traceability
    this.logger.log({
      type: "llm_raw_response",
      request_id: requestId,
      raw: data,
    });

    this.consecutiveErrors = 0;
    return { content, toolCalls };
  }

  /**
   * Parse rate limit wait time from 429 error response.
   * Handles formats like:
   *   "Resets in 1hr 46min"
   *   "Resets in 46min"
   *   "Resets in 30sec"
   *   "Retry after 60s"
   * Fallback: 60s if parse fails.
   * Always adds 1-2 min buffer.
   */
  private parseRateLimitWait(errorBody: string): number {
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

      if (totalSeconds > 0) {
        waitMs = totalSeconds * 1000;
      }
    } catch {
      // Not JSON, try plain text
      const hrMatch = errorBody.match(/(\d+)\s*hr/i);
      const minMatch = errorBody.match(/(\d+)\s*min/i);
      const secMatch = errorBody.match(/(\d+)\s*sec/i);

      let totalSeconds = 0;
      if (hrMatch) totalSeconds += parseInt(hrMatch[1]!, 10) * 3600;
      if (minMatch) totalSeconds += parseInt(minMatch[1]!, 10) * 60;
      if (secMatch) totalSeconds += parseInt(secMatch[1]!, 10);

      if (totalSeconds > 0) {
        waitMs = totalSeconds * 1000;
      }
    }

    // Add 1-2 min buffer
    const bufferMs = (60 + Math.floor(Math.random() * 60)) * 1000;
    return waitMs + bufferMs;
  }

  private async executeToolCall(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson);
    } catch {
      // Some models return non-JSON arguments
      args = {};
    }

    const startTime = Date.now();
    let result: { content: Array<{ type: string; text: string }>; isError?: boolean };

    try {
      result = await this.handler.executeTool(name, args);
    } catch (e) {
      const errorMsg = (e as Error).message;
      this.logger.log({
        type: "tool_error",
        tool: name,
        args,
        error: errorMsg,
        elapsed_ms: Date.now() - startTime,
      });
      this.consecutiveErrors++;
      return JSON.stringify({ ok: false, error: errorMsg });
    }

    const resultText = result.content?.[0]?.text ?? "{}";
    const elapsedMs = Date.now() - startTime;

    this.logger.log({
      type: "tool_result",
      tool: name,
      args,
      result: resultText,
      is_error: result.isError ?? false,
      elapsed_ms: elapsedMs,
    });

    if (result.isError) {
      this.consecutiveErrors++;
    } else {
      this.consecutiveErrors = 0;
    }

    // Auto-remediation: if 3 consecutive errors, find and submit declareEnd
    if (this.consecutiveErrors >= 3) {
      this.logger.log({ type: "auto_remediate", reason: "3 consecutive errors" });
      try {
        const declareEndIndex = await this.findDeclareEndIndex();
        if (declareEndIndex !== null) {
          this.logger.log({ type: "auto_remediate_declareEnd", action_index: declareEndIndex });
          const fallback = await this.handler.executeTool("choose_action", {
            action_index: declareEndIndex,
          });
          this.consecutiveErrors = 0;
          return fallback.content?.[0]?.text ?? "{}";
        } else {
          this.logger.log({ type: "auto_remediate_failed", reason: "declareEnd candidate not found" });
        }
      } catch {
        // ignore
      }
    }

    // Dual-channel rendering: append rendered text after raw JSON
    // for any tool result that contains a digest.
    const enhancedText = this.tryRenderDigest(resultText, name);
    return enhancedText;
  }

  /**
   * If the tool result JSON contains a digest (or next_digest),
   * append rendered text after the raw JSON for LLM readability.
   * Also adds a hint about whether to wait or continue acting.
   */
  private tryRenderDigest(rawText: string, toolName: string): string {
    try {
      const parsed = JSON.parse(rawText);
      // wait_for_my_turn / choose_action / elemental_tuning / choose_active / etc. -> digest
      // submit_decision_fragment_v1 -> next_digest
      const digest: TurnDigestV1 | undefined = parsed?.digest ?? parsed?.next_digest;
      if (digest && typeof digest === "object" && digest.version === "TurnDigestV1") {
        let hint = "";
        if (toolName === "choose_action" || toolName === "elemental_tuning") {
          // After a fast action, digest is present - LLM should continue without wait
          hint = "\n⏩ 快速行动完成 - digest 已包含在上面，请直接调用 choose_action 继续操作，不要调用 wait_for_my_turn。";
        } else if (toolName === "wait_for_my_turn") {
          hint = "\n📌 轮到你了 - digest 已包含在上面，请分析后调用 choose_action。";
        }
        return DigestRenderer.wrapToolResult(rawText, digest) + hint;
      }
      // For choose_action without digest (slow action) - tell LLM to wait
      if (toolName === "choose_action" || toolName === "elemental_tuning") {
        if (parsed?.success === true || parsed?.ok === true) {
          // Check game_over
          if (parsed?.game_over === true) {
            return rawText + "\n🏁 对局已结束。";
          }
          return rawText + "\n⏳ 慢速行动完成 - 请调用 wait_for_my_turn 等待下一轮。";
        }
      }
    } catch {
      // Not JSON or no digest - return as-is
    }
    return rawText;
  }

  /**
   * Find the real action_index for declareEnd by fetching a fresh digest
   * and searching candidate_actions[] for action_case === "declareEnd".
   * Returns null if not found (e.g., no pending RPC, game over, or
   * declareEnd is not among current candidates).
   */
  private async findDeclareEndIndex(): Promise<number | null> {
    try {
      const digestResult = await this.handler.executeTool("get_turn_digest_v1", {});
      const digestText = digestResult.content?.[0]?.text ?? "{}";
      const digestData = JSON.parse(digestText);
      const digest = digestData?.digest;
      if (!digest || !Array.isArray(digest.candidate_actions)) return null;
      for (const candidate of digest.candidate_actions) {
        if (candidate?.action_case === "declareEnd") {
          const candidateId = String(candidate.candidate_id ?? "");
          const match = candidateId.match(/cand_(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async checkGameOver(): Promise<boolean> {
    try {
      const status = await this.client.getStatus();
      if (status.gameOver) return true;
      const phase = status.gamePhase;
      if (phase === "finished" || phase === "terminated" || phase === "gameEnd" || phase === "5") {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async getGameResult(): Promise<Record<string, unknown>> {
    try {
      const result = await this.handler.executeTool("get_game_result", {});
      const text = result.content?.[0]?.text ?? "{}";
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseCli();
  const agent = new LlmAgent(cli);

  try {
    await agent.run();
  } catch (e) {
    console.error(`[Agent P${cli.who}] Fatal error:`, e);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
