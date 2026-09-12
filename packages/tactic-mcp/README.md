# @gi-tcg/tactic-mcp

Runtime JSON Schema contracts and validator for tactic-planning MCP tools.

## Scope

This package owns schema contracts and runtime validation for:

- `create_opening_plan_v2`
- `create_decision_shard_v1`
- `critic_evaluate_v1`

These contracts are consumed by `packages/mcp` when tactic tools are executed.

## Directory Layout

- `schemas/plan-v2.schema.json`: high-level opening/midgame tactical plan.
- `schemas/decision-shard-v1.schema.json`: short-horizon shard for executable policy templates.
- `schemas/critic-result-v1.schema.json`: post-execution evaluation payload.
- `schemas/mcp/*.schema.json`: request/response envelopes for MCP tool I/O.
- `schemas/mcp/tool-contracts.index.json`: source of truth mapping tool name -> request/response schema.
- `schemas/examples/**/*.example.json`: examples for model prompting and regression checks.
- `src/TacticToolContractValidator.ts`: runtime validator implementation.
- `src/index.ts`: package exports.
- `test/`: validator and contract tests.

## Runtime Validator API

Export: `TacticToolContractValidator`

- `TacticToolContractValidator.create(options?)`
Creates validator instance and loads all JSON schemas under `schemas/`.
- `validateRequest(toolName, args)`
Validates `{ name, arguments }` against the request schema.
- `validateResponse(toolName, payload)`
Validates tool output payload against the response schema.

Validation result:

- Success: `{ ok: true }`
- Failure: `{ ok: false, error }`

Error envelope:

- `error_code`
- `message`
- `recover_hint`
- `details?` (field/rule/message/params)

## Notes

- Keep model outputs strictly structured according to these contracts.
- Keep `tool-contracts.index.json` aligned with actual tool names used by `packages/mcp`.
- Trigger replanning only when `CriticResultV1.should_replan` is true or trigger rules explicitly fire.

## Build And Test

```bash
bun run --filter @gi-tcg/tactic-mcp check
bun run --filter @gi-tcg/tactic-mcp test
bun run --filter @gi-tcg/tactic-mcp build
```
