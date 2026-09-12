# Multi-round reflection protocol (harness mode)

This reflection is not a single-shot draft: you can interact with the local harness through JSON commands, drill into raw match data as needed, submit revised drafts for validation round by round, and finalize at the end. **Output exactly one JSON command per round** and nothing else.

Already injected above: the full original plan, authoritative statistics (win rate / coverage / rule hit heatmap / thenMiss probe / oracle attribution table), the complete decision-point stream, and the fallback coverage aggregate report (clustered gap view, injected by default). The following modules add **raw-text-level** detail:

## Command 1: request supplementary modules

```json
{"action": "request_modules", "requests": [{"kind": "module kind", "id": optional identifier}], "reason": "why you need it"}
```

| kind | id | content |
|---|---|---|
| `decision_detail` | `game-N:seq` (e.g. `game-003:42`) | the full trace entry of that decision point + the oracle replay text + adjacent decision points |
| `rule_drilldown` | ruleRef (e.g. `global:11` / `phase:burst:20`) | every hit point of that rule, listed one by one (position + choice + oracle comparison), including thenMiss dead-rule records |
| `fallback_detail` | not needed | the complete list of fallback decision points (uncovered positions that ran the fallback) |
| `fallback_report` | not needed | the fallback coverage aggregate report (active character × round clustering + hand/dice/threat distributions) — already injected by default, no need to request it |
| `game_summary` | game directory name (e.g. `game-003`) | that game's result/rounds/coverage + per-decision-point digest |
| `plan_simulate` | not needed | the static replay matrix of the current plan's rule chain (historical decision-point hit distribution + diff against the original plan — a rehearsal of revision disturbance) |
| `fewshot_plan` | not needed | a GamePlanV1 example in healthy shape (a different deck; learn the shape only) |
| `field_reference` | not needed | field-by-field in-depth `when` manual |
| `dice_prior` | not needed | dice-distribution prior table (payment probabilities for opening 8 dice / after reroll / n remaining dice) — check it when revising dice thresholds |
| `card_detail` / `character_detail` / `character_profile` | defId | same as the drafting side: verify card/character raw text and play profile |

At most {{PER_TURN_MODULES}} modules are delivered per round, with a whole-run budget of {{MODULE_BUDGET}}; anything beyond that is truncated.

## Command 2: submit a draft for validation

```json
{"action": "draft", "result": { ReflectPlanResultV1 }}
```

The harness validates the revisedPlan (including an advisory check that ruleRefs exist in the original plan) and returns a list of issues. You can see your previous draft — revise on top of it.

## Command 3: finalize

```json
{"action": "final", "result": { ReflectPlanResultV1 }}
```

`final` is the **only** way to count as output; if it fails you get the error list back and keep revising.

## Discipline

- The total round cap is {{MAX_TURNS}} rounds (including the current reply). When rounds run out, the last validated `draft` becomes the output; if no draft ever validated, this reflection fails.
- Every ruleVerdict's justification must cite concrete evidence (statistics, decision-point seq, rule_drilldown results); pure narrative is not accepted, and falsifiableClaim remains mandatory.
- Small-sample discipline is unchanged: N<10 forbids directional strong claims, and revisedPredictions must be refilled.
- Revisions keep a coverage floor: before deleting a rule, confirm some new rule takes over its matching scenarios (except dead rules with high thenMiss but zero hits — they never produced coverage anyway).
- Module requests and round counts are recorded as efficiency metrics: request on demand, do not hoard.
