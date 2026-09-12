import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneMcpToolHandler } from "./StandaloneMcpToolHandler";

type ToolPayload = Record<string, unknown>;

function parsePayload(result: { content: Array<{ type: string; text: string }> }): ToolPayload {
  return JSON.parse(result.content[0]?.text ?? "{}") as ToolPayload;
}

describe("StandaloneMcpToolHandler tactic tools", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "gi-tactic-mcp-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("registers new tactic tools in definitions", () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const names = handler.getToolDefinitions().map((tool) => tool.name);

    expect(names).toContain("get_turn_digest_v1");
    expect(names).toContain("submit_decision_fragment_v1");
    expect(names).toContain("get_execution_feedback_v1");
    // auto_select_skills removed from handler
    // create_opening_plan_v2 removed
    // create_decision_shard_v2 removed
    // critic_evaluate_v1 removed
    expect(names).toContain("create_opening_plan_v1");
    expect(names).not.toContain("choose_action");
  });

  test("keeps direct-action mode for compatibility", () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", {
      toolExposureMode: "direct-action",
    });
    const names = handler.getToolDefinitions().map((tool) => tool.name);

    expect(names).toContain("choose_action");
    expect(names).toContain("choose_active");
    expect(names).toContain("reroll_dice");
    expect(names).toContain("switch_hands");
    expect(names).toContain("select_card");
    expect(names).toContain("elemental_tuning");
  });

  test("exposes get_game_result in both modes", () => {
    const directHandler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", {
      toolExposureMode: "direct-action",
    });
    const directNames = directHandler.getToolDefinitions().map((t) => t.name);
    expect(directNames).toContain("get_game_result");

    const fragmentedHandler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const fragmentedNames = fragmentedHandler.getToolDefinitions().map((t) => t.name);
    expect(fragmentedNames).toContain("get_game_result");
  });

  test("get_game_result reports game_over=false when game is still running", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    (handler as unknown as { client: { getStatus: () => Promise<unknown> } }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        gamePhase: "action",
        currentPlayer: 0,
      }),
    };

    const result = await handler.executeTool("get_game_result", {});
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.game_over).toBe(false);
    expect(payload.game_phase).toBe("action");
  });

  test("get_game_result reports winner and you_won when game is finished", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", { who: 0 });
    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getGameState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: false,
        pendingMethod: null,
        gamePhase: "finished",
        currentPlayer: -1,
      }),
      getGameState: async () => ({ winner: 0 }),
    };

    const result = await handler.executeTool("get_game_result", {});
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.game_over).toBe(true);
    expect(payload.winner).toBe(0);
    expect(payload.you_won).toBe(true);
  });

  test("get_game_result uses explicit gameOver + winner fields without fetching game state", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", { who: 1 });
    let stateFetchCount = 0;
    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getGameState: () => Promise<unknown>;
      };
    }).client = {
      // Simulate the bridge's explicit game-over signal: gameOver=true,
      // winner=1, and the protobuf phase enum string ("5" = GAME_END).
      getStatus: async () => ({
        hasPendingRpc: false,
        pendingMethod: null,
        gamePhase: "5",
        gameOver: true,
        winner: 1,
        currentPlayer: -1,
      }),
      getGameState: async () => { stateFetchCount += 1; return { winner: 1 }; },
    };

    const result = await handler.executeTool("get_game_result", {});
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.game_over).toBe(true);
    expect(payload.winner).toBe(1);
    expect(payload.you_won).toBe(true);
    // Winner was taken from the status snapshot — no state fetch required.
    expect(stateFetchCount).toBe(0);
  });

  test("get_game_result recognizes protobuf gameEnd phase ('5') even without explicit gameOver flag", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", { who: 0 });
    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getGameState: () => Promise<unknown>;
      };
    }).client = {
      // Legacy bridge that only surfaces the protobuf phase enum ("5")
      // without the explicit gameOver field — must still be detected.
      getStatus: async () => ({
        hasPendingRpc: false,
        pendingMethod: null,
        gamePhase: "5",
        currentPlayer: -1,
      }),
      getGameState: async () => ({ winner: 1 }),
    };

    const result = await handler.executeTool("get_game_result", {});
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.game_over).toBe(true);
    expect(payload.winner).toBe(1);
    expect(payload.you_won).toBe(false);
  });

  test("wait_for_my_turn surfaces game-over + winner when bridge reports gameOver=true", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", { who: 0 });
    (handler as unknown as {
      client: {
        waitForMyTurn: () => Promise<unknown>;
        getStatus: () => Promise<unknown>;
        getGameState: () => Promise<unknown>;
        getActionEffects: () => Promise<unknown>;
      };
    }).client = {
      // The client throws a structured error carrying the winner from the
      // bridge's explicit game-over signal.
      waitForMyTurn: async () => {
        const err = new Error("Game ended while waiting for turn (player 0). You lost. winner=1") as Error & { game_over?: boolean; winner?: number | null };
        err.game_over = true;
        err.winner = 1;
        throw err;
      },
      getStatus: async () => ({ gamePhase: "5", gameOver: true, winner: 1, hasPendingRpc: false }),
      getGameState: async () => ({ winner: 1 }),
      getActionEffects: async () => ({ effects: [] }),
    };

    const result = await handler.executeTool("wait_for_my_turn", {});
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.your_turn).toBe(false);
    expect(payload.game_over).toBe(true);
    expect(payload.winner).toBe(1);
    expect(payload.you_won).toBe(false);
  });

  test("action tools surface GAME_OVER signal instead of NO_PENDING_RPC when game is over", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", {
      who: 0,
      toolExposureMode: "direct-action",
    });
    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getGameState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: false,
        pendingMethod: null,
        gamePhase: "5",
        gameOver: true,
        winner: 0,
        currentPlayer: -1,
      }),
      getGameState: async () => ({ winner: 0 }),
    };

    const result = await handler.executeTool("choose_action", { action_index: 1 });
    const payload = parsePayload(result);
    expect(payload.ok).toBe(false);
    expect(payload.error_code).toBe("GAME_OVER");
    expect(payload.game_over).toBe(true);
    expect(payload.winner).toBe(0);
    expect(payload.you_won).toBe(true);
  });

  test("rejects direct-action tools in fragmented mode even if called by name", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");

    const result = await handler.executeTool("choose_action", {
      action_index: 1,
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.ok).toBe(false);
    expect(payload.error_code).toBe("ACTION_TOOL_HIDDEN_IN_FRAGMENTED_MODE");
    expect(payload.tool_name).toBe("choose_action");
  });

  test("rejects non-whitelisted state tools in fragmented mode even if called by name", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");

    const stateResult = await handler.executeTool("get_game_state", {});
    expect(stateResult.isError).toBe(true);

    const statePayload = parsePayload(stateResult);
    expect(statePayload.ok).toBe(false);
    expect(statePayload.error_code).toBe("TOOL_HIDDEN_IN_FRAGMENTED_MODE");
    expect(statePayload.tool_name).toBe("get_game_state");

    const commandsResult = await handler.executeTool("get_available_commands", {});
    expect(commandsResult.isError).toBe(true);

    const commandsPayload = parsePayload(commandsResult);
    expect(commandsPayload.ok).toBe(false);
    expect(commandsPayload.error_code).toBe("TOOL_HIDDEN_IN_FRAGMENTED_MODE");
    expect(commandsPayload.tool_name).toBe("get_available_commands");
  });

  test.skip("returns schema error for invalid tactic tool request", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const result = await handler.executeTool("create_decision_shard_v2", {
      session_id: "sess-a",
      plan_id: "plan-a",
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.ok).toBe(false);
    expect(payload.error_code).toBe("TACTIC_SCHEMA_REQUEST_INVALID");
    expect(Array.isArray(payload.details)).toBe(true);
  });

  test.skip("creates v2 plan/shard/critic artifacts with expected naming", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535", {
      toolExposureMode: "direct-action",
    });

    const planResult = await handler.executeTool("create_opening_plan_v2", {
      session_id: "sess-001",
      plan_id: "plan-sess-001",
      deck_fingerprint: "101-205-309",
      source_skills: ["base-skill"],
      global_goal: "tempo",
      opening_window: { start_turn: 1, end_turn: 3 },
      turn_priorities: [{ turn: 1, objectives: ["set aura"] }],
      risk_rules: [],
      pivot_rules: [],
      trigger_rules: [],
      fallback_rules: [],
    });
    expect(planResult.isError).toBeUndefined();
    const planPayload = parsePayload(planResult);
    expect(planPayload.ok).toBe(true);
    expect(typeof planPayload.plan_path).toBe("string");

    const shardResult = await handler.executeTool("create_decision_shard_v1", {
      session_id: "sess-001",
      plan_id: "plan-sess-001",
      turn_range: { start: 1, end: 1 },
      tactical_goal: "safe reaction",
      candidate_policies: [
        {
          id: "p1",
          priority: 80,
          preconditions: ["has_pending_rpc"],
          action_template: {
            tool: "choose_action",
            args: { action_index: 1 },
          },
        },
      ],
      execution_constraints: {
        max_actions_this_turn: 3,
        dice_budget_mode: "balanced",
      },
      fallback_chain: [],
      exit_conditions: ["end_phase_reached"],
      combat_window_plan: {
        window_id: "r1_window",
        plan_horizon: { min_actions: 2, max_actions: 3 },
        entry_conditions: ["pending_method=action"],
        interrupt_conditions: ["pending_method!=action"],
        success_conditions: ["reaction_ready"],
        fail_conditions: ["core_character_dead"],
        entry_node_id: "setup",
        nodes: [
          {
            id: "setup",
            kind: "setup",
            intent: "establish_setup",
            expected_action_case: ["playCard"],
            when: ["pending_method=action"],
            must_do: ["playCard"],
            avoid: [],
            prefer_tags: ["playCard"],
            resource_policy: "balanced",
            fallback_rule: "pick_highest_valid_candidate",
            next: [],
          },
        ],
      },
    });
    expect(shardResult.isError).toBeUndefined();
    const shardPayload = parsePayload(shardResult);
    expect(shardPayload.ok).toBe(true);
    expect(String(shardPayload.shard_path)).toContain("_shard_");
    expect((shardPayload.decision_shard as { combat_window_plan?: { window_id?: string } }).combat_window_plan?.window_id)
      .toBe("r1_window");

    const criticResult = await handler.executeTool("critic_evaluate_v1", {
      session_id: "sess-001",
      plan_id: "plan-sess-001",
      turn: 1,
      step_id: "turn1_step1",
      expected_policy_id: "p1",
      actual_tool: "choose_action",
      actual_args: { action_index: 1 },
      state_delta: {
        self_hp_delta: 0,
        opp_hp_delta: -2,
        dice_spent: 3,
        cards_spent: 1,
      },
      hard_violations: [],
    });
    expect(criticResult.isError).toBeUndefined();
    const criticPayload = parsePayload(criticResult);
    expect(criticPayload.ok).toBe(true);
    expect(typeof criticPayload.critic_result).toBe("object");

    const runtimeDir = join(tempDir, "runtime-plans");
    const files = await readdir(runtimeDir);
    expect(files.some((f) => f === "sess-001.json")).toBe(true);
    expect(files.some((f) => f.startsWith("sess-001_shard_"))).toBe(true);
    expect(files.some((f) => f.startsWith("sess-001_critic_"))).toBe(true);

    const planPath = String(planPayload.plan_path);
    const planText = await readFile(planPath, "utf-8");
    const planJson = JSON.parse(planText) as {
      protocol_version?: string;
      artifact?: { kind?: string; schema_version?: string };
      payload?: Record<string, unknown>;
    };
    expect(planJson.protocol_version).toBe("1");
    expect(planJson.artifact?.kind).toBe("plan");
    expect(planJson.artifact?.schema_version).toBe("PlanV2");
    expect(planJson.payload?.version).toBe("PlanV2");
  });

  test.skip("creates default fragmented shard through v2 alias", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const result = await handler.executeTool("create_decision_shard_v2", {
      session_id: "sess-fragmented-default",
      plan_id: "plan-fragmented-default",
      turn_range: { start: 2, end: 2 },
      tactical_goal: "safe reaction",
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);
    const decisionShard = payload.decision_shard as {
      candidate_policies: Array<{ action_template: { tool: string } }>;
      combat_window_plan?: { plan_horizon?: { max_actions?: number } };
    };
    expect(decisionShard.candidate_policies[0].action_template.tool).toBe(
      "submit_decision_fragment_v1",
    );
    expect(decisionShard.combat_window_plan).toBeUndefined();
  });

  test.skip("active combat window plan steers consecutive action fragments", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-combat-window";
    handler.setSessionId(sessionId);

    const screenStates = [
      {
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 1, 8],
          character: [{ id: 101, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2 }],
        },
        opponent: {
          activeCharacterId: 201,
          character: [{ id: 201, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2 }],
        },
      },
      {
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 8],
          character: [{ id: 101, hp: 10, maxHp: 10, energy: 1, maxEnergy: 2 }],
        },
        opponent: {
          activeCharacterId: 201,
          character: [{ id: 201, hp: 7, maxHp: 10, energy: 0, maxEnergy: 2 }],
        },
      },
    ];
    let statusIndex = 0;
    let screenIndex = 0;

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "switchActive" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => screenStates[Math.min(screenIndex++, screenStates.length - 1)],
    };

    const attemptedActionIndexes: number[] = [];
    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        const actionIndex = Number(args.action_index);
        attemptedActionIndexes.push(actionIndex);
        statusIndex += 1;
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, mocked: true, args, statusIndex }) }],
        };
      }
      return await originalExecuteTool(name, args);
    };

    await handler.executeTool("create_decision_shard_v1", {
      session_id: sessionId,
      plan_id: "plan-combat-window",
      turn_range: { start: 1, end: 1 },
      tactical_goal: "two-step opening line",
      combat_window_plan: {
        window_id: "opening_line",
        plan_horizon: { min_actions: 2, max_actions: 3 },
        entry_conditions: ["pending_method=action"],
        interrupt_conditions: ["pending_method!=action"],
        success_conditions: [],
        fail_conditions: [],
        entry_node_id: "setup",
        nodes: [
          {
            id: "setup",
            kind: "setup",
            intent: "establish_setup",
            expected_action_case: ["playCard"],
            when: ["pending_method=action"],
            must_do: ["playCard"],
            avoid: ["switchActive"],
            prefer_tags: ["playCard"],
            resource_policy: "balanced",
            fallback_rule: "pick_highest_valid_candidate",
            next: [
              {
                condition: "actions_taken>=1",
                to: "pivot",
                priority: 100,
              },
            ],
          },
          {
            id: "pivot",
            kind: "pivot",
            intent: "fast_pivot",
            expected_action_case: ["switchActive"],
            when: ["pending_method=action"],
            must_do: ["switchActive"],
            avoid: ["playCard"],
            prefer_tags: ["switchActive"],
            resource_policy: "balanced",
            fallback_rule: "pick_highest_valid_candidate",
            next: [],
          },
        ],
      },
    });

    const digest1 = parsePayload(await handler.executeTool("get_turn_digest_v1", {})).digest as { digest_ref: string };
    const submit1 = parsePayload(await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest1.digest_ref,
      intent: "stabilize_tempo",
    })) as {
      feedback: {
        active_node_id?: string;
      };
    };
    expect(submit1.feedback.active_node_id).toBe("setup");

    const digest2Payload = parsePayload(await handler.executeTool("get_turn_digest_v1", {})) as {
      digest: {
        digest_ref: string;
        active_combat_window?: {
          actions_taken?: number;
          active_node_id?: string | null;
        } | null;
      };
    };
    expect(digest2Payload.digest.active_combat_window?.actions_taken).toBe(1);

    const submit2 = parsePayload(await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest2Payload.digest.digest_ref,
      intent: "stabilize_tempo",
    })) as {
      feedback: {
        active_node_id?: string;
      };
    };
    expect(submit2.feedback.active_node_id).toBe("pivot");
    expect(attemptedActionIndexes).toEqual([1, 2]);
  });

  test("keeps create_opening_plan_v1 behavior available", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const result = await handler.executeTool("create_opening_plan_v1", {
      session_id: "sess-v1",
      plan_id: "plan-v1",
      deck_fingerprint: "1-2-3",
      source_skills: ["base-skill"],
      global_goal: "safe start",
      turn1_3_priorities: ["a"],
      risk_rules: ["r"],
      pivot_rules: ["p"],
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);
    expect(typeof payload.plan_path).toBe("string");
  });

  test.skip("auto-selects skills from deck fingerprint and writes selected_skills.json", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    await mkdir(join(tempDir, ".opencode"), { recursive: true });
    await writeFile(
      join(tempDir, ".opencode", "skills.index.json"),
      JSON.stringify([
        {
          skill_id: "genius-invokation-9x",
          skill_path: ".opencode/skills/genius-invokation-9x/SKILL.md",
          characters_fingerprint: "1411-1510-2102",
          key_cards: [],
          priority: 100,
          fallback_to: [],
          version_range: null,
          status: "active",
        },
      ]),
      "utf-8",
    );

    (handler as unknown as { client: { getDeck0: () => Promise<unknown> } }).client = {
      getDeck0: async () => ({
        characters: [
          { definition_id: 2102 },
          { definition_id: 1411 },
          { definition_id: 1510 },
        ],
      }),
    };

    const result = await handler.executeTool("create_opening_plan_v1", {
      session_id: "sess-auto-skill",
      plan_id: "plan-auto-skill",
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);

    const planText = await readFile(join(tempDir, "runtime-plans", "sess-auto-skill.json"), "utf-8");
    const planJson = JSON.parse(planText) as {
      artifact?: { schema_version?: string; tool_name?: string };
      payload?: { source_skills?: string[]; deck_fingerprint?: string };
    };
    expect(planJson.artifact?.schema_version).toBe("PlanV1");
    expect(planJson.artifact?.tool_name).toBe("create_opening_plan_v1");
    expect(planJson.payload?.deck_fingerprint).toBe("1411-1510-2102");
    expect(planJson.payload?.source_skills).toEqual(["genius-invokation-9x"]);

    const selectedSkillsText = await readFile(
      join(tempDir, ".opencode", "active-skills", "selected_skills.json"),
      "utf-8",
    );
    const selectedSkillsJson = JSON.parse(selectedSkillsText) as {
      deck_fingerprint?: string;
      selected_skills?: string[];
    };
    expect(selectedSkillsJson.deck_fingerprint).toBe("1411-1510-2102");
    expect(selectedSkillsJson.selected_skills).toEqual(["genius-invokation-9x"]);
  });

  test.skip("produces digest/fragment/feedback artifacts for fragmented decision contract", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-contract-03";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 8],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, mocked: true, args }) }],
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();
    const digestPayload = parsePayload(digestResult);
    expect(digestPayload.ok).toBe(true);
    expect(String(digestPayload.digest_path)).toContain("_digest_");

    const digest = digestPayload.digest as { digest_ref: string };
    const submitResult = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "pressure",
      must_do: ["playCard"],
      avoid: [],
      preference_order: ["playCard"],
      resource_policy: "balanced",
      decision_mode: "evidence_first",
      local_eval_requests: [
        {
          metric: "opponent_buff_probability_upper_bound",
          target: "active_target",
          estimate_kind: "upper_bound",
          priority: 1,
          notes: "check lethal ceiling",
        },
      ],
      evidence_policy: {
        require_local_eval_first: true,
        separate_verified_from_inferred: true,
        allow_heuristic_when_unavailable: true,
      },
      target_policy: "maximize_legal_value",
      fallback_rule: "pick_highest_valid_candidate",
      explanation: "contract test",
    });

    expect(submitResult.isError).toBeUndefined();
    const submitPayload = parsePayload(submitResult);
    expect(submitPayload.ok).toBe(true);
    expect(String(submitPayload.fragment_path)).toContain("_fragment_");
    expect(String(submitPayload.feedback_path)).toContain("_feedback_");

    const fragment = submitPayload.fragment as {
      session_id: string;
      digest_ref: string;
      decision_mode?: string;
      local_eval_requests?: Array<{ metric: string }>;
      evidence_policy?: { require_local_eval_first?: boolean };
    };
    expect(fragment.session_id).toBe(sessionId);
    expect(fragment.digest_ref).toBe(digest.digest_ref);
    expect(fragment.decision_mode).toBe("evidence_first");
    expect(fragment.local_eval_requests?.[0]?.metric).toBe("opponent_buff_probability_upper_bound");
    expect(fragment.evidence_policy?.require_local_eval_first).toBe(true);

    const runtimeDir = join(tempDir, "runtime-plans");
    const files = await readdir(runtimeDir);
    expect(files.some((f) => f.startsWith(`${sessionId}_digest_`))).toBe(true);
    expect(files.some((f) => f.startsWith(`${sessionId}_fragment_`))).toBe(true);
    expect(files.some((f) => f.startsWith(`${sessionId}_feedback_`))).toBe(true);
  });

  test.skip("rejects fragmented decision payload with forbidden action fields", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-forbidden-03";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();

    const forbidden = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      intent: "illegal-payload",
      action_index: 1,
    });

    expect(forbidden.isError).toBe(true);
    const payload = parsePayload(forbidden);
    expect(payload.error_code).toBe("FRAGMENT_CONTAINS_ACTION_FIELDS");
  });

  test.skip("rejects digest_ref mismatch for submit_decision_fragment_v1", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-mismatch-03";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();

    const mismatch = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: "digest_wrong",
      intent: "pressure",
    });

    expect(mismatch.isError).toBe(true);
    const payload = parsePayload(mismatch);
    expect(payload.error_code).toBe("DIGEST_REF_MISMATCH");
  });

  test.skip("local resolver filters invalid candidates before bridge execution", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-resolver-legality";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 1,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "declareEnd" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 2,
        currentTurn: 2,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 1],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const attemptedActionIndexes: number[] = [];
    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        attemptedActionIndexes.push(Number(args.action_index));
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, mocked: true, args }) }],
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();
    const digest = parsePayload(digestResult).digest as { digest_ref: string };

    const submitResult = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "pressure",
      must_do: ["playCard"],
      avoid: [],
      preference_order: ["playCard"],
      resource_policy: "balanced",
      fallback_rule: "pick_highest_valid_candidate",
    });

    expect(submitResult.isError).toBeUndefined();
    const payload = parsePayload(submitResult) as {
      feedback: {
        selected_candidate_id?: string;
        execution_ok?: boolean;
      };
    };
    expect(payload.feedback.execution_ok).toBe(true);
    expect(payload.feedback.selected_candidate_id).toBe("cand_2");
    expect(attemptedActionIndexes).toEqual([2]);
  });

  test.skip("local resolver retries next candidate when selected execution fails", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-resolver-retry";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "declareEnd" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 3,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 1],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const attemptedActionIndexes: number[] = [];
    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        const actionIndex = Number(args.action_index);
        attemptedActionIndexes.push(actionIndex);
        if (actionIndex === 1) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, mocked: true, args }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, mocked: true, args }) }],
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();
    const digest = parsePayload(digestResult).digest as { digest_ref: string };

    const submitResult = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "pressure",
      must_do: ["playCard"],
      avoid: [],
      preference_order: ["playCard"],
      resource_policy: "balanced",
      fallback_rule: "pick_highest_valid_candidate",
    });

    expect(submitResult.isError).toBeUndefined();
    const payload = parsePayload(submitResult) as {
      feedback: {
        selected_candidate_id?: string;
        execution_ok?: boolean;
        fallback_used?: boolean;
        notes?: string[];
      };
    };
    expect(payload.feedback.execution_ok).toBe(true);
    expect(payload.feedback.selected_candidate_id).toBe("cand_2");
    expect(payload.feedback.fallback_used).toBe(true);
    expect(attemptedActionIndexes).toEqual([1, 2]);
    expect((payload.feedback.notes ?? []).join("\n")).toContain("execution_attempts");
    expect((payload.feedback.notes ?? []).join("\n")).toContain("cand_1");
    expect((payload.feedback.notes ?? []).join("\n")).toContain("cand_2");
  });

  test.skip("invalid action index during fragment execution is treated as stale digest", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-stale-action-index";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "action",
        pendingRequest: {
          value: {
            action: [
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "playCard" },
              },
              {
                validity: 0,
                requiredCost: [],
                autoSelectedDice: [],
                action: { $case: "declareEnd" },
              },
            ],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 3,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 1],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error_code: "INVALID_ACTION_INDEX",
              message: "Invalid action_index: must be between 1 and 1",
            }),
          }],
          isError: true,
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();
    const digest = parsePayload(digestResult).digest as { digest_ref: string };

    const submitResult = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "pressure",
      preference_order: ["playCard"],
      resource_policy: "balanced",
      fallback_rule: "pick_highest_valid_candidate",
    });

    expect(submitResult.isError).toBe(true);
    const payload = parsePayload(submitResult) as {
      error_code?: string;
      feedback?: {
        execution_ok?: boolean;
        resolver_reason?: string;
        notes?: string[];
      };
    };
    expect(payload.error_code).toBe("STALE_DIGEST");
    expect(payload.feedback?.execution_ok).toBe(false);
    expect(payload.feedback?.resolver_reason).toContain("stale");
    expect((payload.feedback?.notes ?? []).join("\n")).toContain("INVALID_ACTION_INDEX");
    expect((payload.feedback?.notes ?? []).join("\n")).toContain("Stale digest invalidated");
  });

  test.skip("pending method mismatch during fragment execution is treated as stale digest", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-stale-pending-method";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "chooseActive",
        pendingRequest: {
          value: {
            candidateIds: [101, 102],
          },
        },
      }),
      getScreenState: async () => ({
        roundNumber: 1,
        currentTurn: 0,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_active") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error_code: "MISMATCH_PENDING_METHOD",
              message: "Pending RPC is 'rerollDice', expected 'chooseActive'",
            }),
          }],
          isError: true,
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestResult = await handler.executeTool("get_turn_digest_v1", {});
    expect(digestResult.isError).toBeUndefined();
    const digest = parsePayload(digestResult).digest as { digest_ref: string };

    const submitResult = await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "stabilize_board",
      resource_policy: "balanced",
      fallback_rule: "pick_highest_valid_candidate",
    });

    expect(submitResult.isError).toBe(true);
    const payload = parsePayload(submitResult) as {
      error_code?: string;
      feedback?: {
        execution_ok?: boolean;
        resolver_reason?: string;
        notes?: string[];
      };
    };
    expect(payload.error_code).toBe("STALE_DIGEST");
    expect(payload.feedback?.execution_ok).toBe(false);
    expect(payload.feedback?.resolver_reason).toContain("stale");
    expect((payload.feedback?.notes ?? []).join("\n")).toContain("MISMATCH_PENDING_METHOD");
    expect((payload.feedback?.notes ?? []).join("\n")).toContain("Stale digest invalidated");
  });

  test.skip("execution feedback reflects bridge apply success followed by core io error", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-feedback-io-error";
    handler.setSessionId(sessionId);

    let feedbackPhase = false;
    let resolvedAt = 0;
    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => {
        if (feedbackPhase) {
          return {
            hasPendingRpc: false,
            pendingMethod: null,
            gamePhase: "action",
            currentPlayer: 1,
            lastCommandResult: {
              method: "action",
              success: true,
              message: "Command applied",
              resolvedAt,
            },
            lastIoError: {
              who: 0,
              message: "Core rejected the action payload",
              at: resolvedAt + 1,
              phase: "action",
              pendingMethod: "action",
            },
          };
        }
        return {
          hasPendingRpc: true,
          pendingMethod: "action",
          pendingRequest: {
            value: {
              action: [
                {
                  validity: 0,
                  requiredCost: [],
                  autoSelectedDice: [],
                  action: { $case: "playCard" },
                },
              ],
            },
          },
          gamePhase: "action",
          currentPlayer: 1,
        };
      },
      getScreenState: async () => ({
        roundNumber: 2,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [0, 1],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
    };

    const originalExecuteTool = handler.executeTool.bind(handler);
    (handler as unknown as {
      executeTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }).executeTool = async (name: string, args: Record<string, unknown>) => {
      if (name === "choose_action") {
        resolvedAt = Date.now();
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, mocked: true, args }) }],
        };
      }
      return await originalExecuteTool(name, args);
    };

    const digestPayload = parsePayload(await handler.executeTool("get_turn_digest_v1", {}));
    const digest = digestPayload.digest as { digest_ref: string };
    const submitPayload = parsePayload(await handler.executeTool("submit_decision_fragment_v1", {
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: "pressure",
      preference_order: ["playCard"],
      resource_policy: "balanced",
      fallback_rule: "pick_highest_valid_candidate",
    })) as {
      feedback: {
        execution_ok?: boolean;
      };
    };

    expect(submitPayload.feedback.execution_ok).toBe(true);

    feedbackPhase = true;
    const feedbackPayload = parsePayload(await handler.executeTool("get_execution_feedback_v1", {})) as {
      feedback: {
        execution_ok?: boolean;
        resolver_reason?: string;
        notes?: string[];
      };
    };

    expect(feedbackPayload.feedback.execution_ok).toBe(false);
    expect(feedbackPayload.feedback.resolver_reason).toContain("IoError");
    expect((feedbackPayload.feedback.notes ?? []).join("\n")).toContain("io_error_after_apply");
    expect((feedbackPayload.feedback.notes ?? []).join("\n")).toContain("Command applied");
  });

  test.skip("selectCard digest includes readable candidate metadata", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    const sessionId = "sess-select-card-digest";
    handler.setSessionId(sessionId);

    (handler as unknown as {
      client: {
        getStatus: () => Promise<unknown>;
        getScreenState: () => Promise<unknown>;
      };
      cardIndexStore: {
        getCardById: (definitionId: number) => Promise<unknown>;
      };
    }).client = {
      getStatus: async () => ({
        hasPendingRpc: true,
        pendingMethod: "selectCard",
        pendingRequest: {
          $case: "selectCard",
          value: {
            candidateDefinitionIds: [330001, 330002],
          },
        },
        gamePhase: "action",
        currentPlayer: 1,
      }),
      getScreenState: async () => ({
        roundNumber: 1,
        currentTurn: 1,
        phase: "action",
        player: {
          activeCharacterId: 101,
          handCard: [],
          dice: [],
        },
        opponent: {
          activeCharacterId: 201,
        },
      }),
      cardIndexStore: {
        getCardById: async (_definitionId: number) => null,
      },
    } as any;

    (handler as unknown as {
      cardIndexStore: {
        getCardById: (definitionId: number) => Promise<unknown>;
      };
    }).cardIndexStore = {
      getCardById: async (definitionId: number) => ({
        definitionId,
        canonicalName: definitionId === 330001 ? "Strategic Reserve" : "Leave It to Me!",
        effectText:
          definitionId === 330001
            ? "Draw 2 cards."
            : "Switch to the next character and treat it as a Fast Action.",
      }),
    };

    const payload = parsePayload(await handler.executeTool("get_turn_digest_v1", {})) as {
      digest: {
        candidate_actions: Array<Record<string, unknown>>;
      };
    };
    const firstCandidate = payload.digest.candidate_actions[0];

    expect(firstCandidate.option_index).toBe(1);
    expect(firstCandidate.definition_id).toBe(330001);
    expect(firstCandidate.name).toBe("Strategic Reserve");
    expect(firstCandidate.description).toBe("Draw 2 cards.");
    expect(firstCandidate.effect_text).toBe("Draw 2 cards.");
    expect(typeof firstCandidate.candidate_signature).toBe("string");
  });

  test.skip("falls back to base-skill when deck fingerprint has no index match", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    await mkdir(join(tempDir, ".opencode"), { recursive: true });
    await writeFile(join(tempDir, ".opencode", "skills.index.json"), "[]", "utf-8");

    (handler as unknown as { client: { getDeck0: () => Promise<unknown> } }).client = {
      getDeck0: async () => ({
        characters: [
          { definition_id: 9991 },
          { definition_id: 9992 },
          { definition_id: 9993 },
        ],
      }),
    };

    const result = await handler.executeTool("create_opening_plan_v1", {
      session_id: "sess-base-skill",
      plan_id: "plan-base-skill",
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.ok).toBe(true);

    const selectedSkillsText = await readFile(
      join(tempDir, ".opencode", "active-skills", "selected_skills.json"),
      "utf-8",
    );
    const selectedSkillsJson = JSON.parse(selectedSkillsText) as {
      deck_fingerprint?: string;
      selected_skills?: string[];
    };
    expect(selectedSkillsJson.deck_fingerprint).toBe("9991-9992-9993");
    expect(selectedSkillsJson.selected_skills).toEqual(["base-skill"]);
  });

  test.skip("auto_select_skills tool returns selected skills and writes cache", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    await mkdir(join(tempDir, ".opencode"), { recursive: true });
    await writeFile(
      join(tempDir, ".opencode", "skills.index.json"),
      JSON.stringify([
        {
          skill_id: "genius-invokation-gui-huo",
          skill_path: ".opencode/skills/genius-invokation-gui-huo/SKILL.md",
          characters_fingerprint: "1408-2103-2104",
          key_cards: ["330010"],
          priority: 100,
          fallback_to: [],
          version_range: null,
          status: "active",
        },
      ]),
      "utf-8",
    );

    (handler as unknown as { client: { getDeck0: () => Promise<unknown> } }).client = {
      getDeck0: async () => ({
        characters: [
          { definition_id: 2104 },
          { definition_id: 1408 },
          { definition_id: 2103 },
        ],
      }),
    };

    const result = await handler.executeTool("auto_select_skills", {});

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result) as {
      ok?: boolean;
      deck_fingerprint?: string;
      selected_skills?: string[];
      source?: string;
      selected_skills_path?: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.deck_fingerprint).toBe("1408-2103-2104");
    expect(payload.selected_skills).toEqual(["genius-invokation-gui-huo"]);
    expect(payload.source).toBe("auto-generated");
    expect(typeof payload.selected_skills_path).toBe("string");
  });

  test.skip("auto_select_skills tool reuses cache when fingerprint matches", async () => {
    const handler = new StandaloneMcpToolHandler("http://127.0.0.1:65535");
    await mkdir(join(tempDir, ".opencode", "active-skills"), { recursive: true });
    await writeFile(
      join(tempDir, ".opencode", "active-skills", "selected_skills.json"),
      JSON.stringify({
        deck_fingerprint: "1411-1510-2102",
        selected_skills: ["genius-invokation-9x"],
        updated_at: "2026-03-07T00:00:00.000Z",
      }),
      "utf-8",
    );

    (handler as unknown as { client: { getDeck0: () => Promise<unknown> } }).client = {
      getDeck0: async () => ({
        characters: [
          { definition_id: 2102 },
          { definition_id: 1411 },
          { definition_id: 1510 },
        ],
      }),
    };

    const result = await handler.executeTool("auto_select_skills", {});

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result) as {
      ok?: boolean;
      selected_skills?: string[];
      source?: string;
      updated_at?: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.selected_skills).toEqual(["genius-invokation-9x"]);
    expect(payload.source).toBe("cache");
    expect(payload.updated_at).toBe("2026-03-07T00:00:00.000Z");
  });
});
