import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCanonicalToolName,
  TacticToolContractValidator,
} from "../src/index";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const schemasRoot = resolve(__dirname, "../schemas");
const examplesRoot = join(schemasRoot, "examples");

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("TacticToolContractValidator", () => {
  test("passes all mcp example requests and responses", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    const openingReq = await readJson(join(examplesRoot, "mcp", "create-opening-plan-v2.request.example.json"));
    const openingRes = await readJson(join(examplesRoot, "mcp", "create-opening-plan-v2.response.example.json"));
    const shardReq = await readJson(join(examplesRoot, "mcp", "create-decision-shard-v1.request.example.json"));
    const shardRes = await readJson(join(examplesRoot, "mcp", "create-decision-shard-v1.response.example.json"));
    const criticReq = await readJson(join(examplesRoot, "mcp", "critic-evaluate-v1.request.example.json"));
    const criticRes = await readJson(join(examplesRoot, "mcp", "critic-evaluate-v1.response.example.json"));

    expect(
      validator.validateRequest(
        "create_opening_plan_v2",
        (openingReq.arguments ?? {}) as Record<string, unknown>,
      ),
    ).toEqual({ ok: true });
    expect(validator.validateResponse("create_opening_plan_v2", openingRes)).toEqual({ ok: true });

    expect(
      validator.validateRequest(
        "create_decision_shard_v1",
        (shardReq.arguments ?? {}) as Record<string, unknown>,
      ),
    ).toEqual({ ok: true });
    expect(validator.validateResponse("create_decision_shard_v1", shardRes)).toEqual({ ok: true });

    expect(
      validator.validateRequest(
        "critic_evaluate_v1",
        (criticReq.arguments ?? {}) as Record<string, unknown>,
      ),
    ).toEqual({ ok: true });
    expect(validator.validateResponse("critic_evaluate_v1", criticRes)).toEqual({ ok: true });
  });

  test("returns request error details on invalid payload", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    const result = validator.validateRequest("create_decision_shard_v1", {
      session_id: "",
      plan_id: "p1",
      tactical_goal: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unexpected ok result");
    }
    expect(result.error.error_code).toBe("TACTIC_SCHEMA_REQUEST_INVALID");
    expect((result.error.details ?? []).length).toBeGreaterThan(0);
  });

  test("returns response error details on invalid payload", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    const result = validator.validateResponse("critic_evaluate_v1", {
      ok: true,
      critic_result: {
        version: "CriticResultV1",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unexpected ok result");
    }
    expect(result.error.error_code).toBe("TACTIC_SCHEMA_RESPONSE_INVALID");
    expect((result.error.details ?? []).length).toBeGreaterThan(0);
  });

  test("returns semantic request error for invalid turn ordering", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    const result = validator.validateRequest("create_opening_plan_v2", {
      session_id: "sess-1",
      deck_fingerprint: "1-2-3",
      source_skills: ["base-skill"],
      global_goal: "tempo",
      opening_window: {
        start_turn: 3,
        end_turn: 1,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unexpected ok result");
    }
    expect(result.error.error_code).toBe("TACTIC_SEMANTIC_REQUEST_INVALID");
    expect((result.error.details ?? [])[0]?.rule).toBe("range_order");
  });

  test("returns semantic response error for inconsistent critic replan fields", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    const result = validator.validateResponse("critic_evaluate_v1", {
      ok: true,
      critic_result: {
        version: "CriticResultV1",
        session_id: "sess-1",
        plan_id: "plan-1",
        turn: 1,
        step_id: "step-1",
        outcome: "success",
        score: 0.8,
        violations: [],
        observations: [],
        suggested_adjustments: [],
        should_replan: false,
        replan_scope: "micro",
        reason: "bad state",
        next_constraints: [],
        evaluated_at: "2026-03-19T00:00:00.000Z",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unexpected ok result");
    }
    expect(result.error.error_code).toBe("TACTIC_SEMANTIC_RESPONSE_INVALID");
    expect((result.error.details ?? [])[0]?.rule).toBe("replan_consistency");
  });

  test("returns unknown tool error", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });
    const result = validator.validateRequest("unknown_tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unexpected ok result");
    }
    expect(result.error.error_code).toBe("TACTIC_SCHEMA_UNKNOWN_TOOL");
  });

  test("resolves create_decision_shard_v2 alias to v1 contract", async () => {
    const validator = await TacticToolContractValidator.create({ schemasRoot });

    expect(resolveCanonicalToolName("create_decision_shard_v2")).toBe("create_decision_shard_v1");

    const shardReq = await readJson(join(examplesRoot, "mcp", "create-decision-shard-v1.request.example.json"));
    const shardRes = await readJson(join(examplesRoot, "mcp", "create-decision-shard-v1.response.example.json"));

    expect(
      validator.validateRequest(
        "create_decision_shard_v2",
        (shardReq.arguments ?? {}) as Record<string, unknown>,
      ),
    ).toEqual({ ok: true });
    expect(validator.validateResponse("create_decision_shard_v2", shardRes)).toEqual({ ok: true });
  });
});
