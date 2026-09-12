# Multi-round drafting protocol (harness mode)

This is not a single-shot draft: you can interact with the local harness through JSON commands, request supplementary material as needed, submit drafts for validation round by round, and finalize at the end. **Output exactly one JSON command per round** and nothing else.

## Command 1: request supplementary modules

Before writing or while revising, if you need extra material:

```json
{"action": "request_modules", "requests": [{"kind": "module kind", "id": optional identifier}], "reason": "why you need it"}
```

| kind | id | content |
|---|---|---|
| `fewshot_plan` | not needed | a complete GamePlanV1 worked example in healthy shape (a different deck; learn the shape only, never copy its defIds) |
| `field_reference` | not needed | field-by-field in-depth `when` manual: types, semantics, example rules, common dead rules |
| `dice_prior` | not needed | dice-distribution prior table: probability of ≥ k dice of a given element / element+omni (opening 8 dice, after reroll, n remaining dice) — check it before writing dice thresholds |
| `card_detail` | card defId | look up one action card's official effect/cost/tags in the full card library (verify your memory; plan rules may still only reference ids in your own deck list) |
| `character_detail` | character defId | full character skill text (cost/effect/energy/HP) |
| `character_profile` | character defId | that character's aggregated play profile (elemental-skill payoff type, opener priority) |

At most {{PER_TURN_MODULES}} modules are delivered per round, with a whole-run budget of {{MODULE_BUDGET}}; anything beyond that is truncated.

## Command 2: submit a draft for validation

```json
{"action": "draft", "plan": { GamePlanV1 }}
```

The harness returns a list of validation issues (including dead-rule auto-repair notes) or "validated + shape statistics". You can see the full content of your previous draft — revise on top of it, do not rewrite from scratch.

## Command 3: finalize

```json
{"action": "final", "plan": { GamePlanV1 }}
```

`final` is the **only** way to count as output; it still passes the same validator, and if it fails you get the error list back and may keep revising.

## Two-layer portfolio drafting discipline (applies only with --opponent-set (General) / --opponent-deck (Single))

In the two-layer portfolio you produce exactly one layer; do not mix the two layers' responsibilities into one tree:

- **General layer (--opponent-set)**: the shared tree. Write only cross-opponent common rules — `when` may only use fields robust against any opponent (open-deck priors); do not reference defIds / deck-list details unique to a single opponent. Set `context.opponent` to `unknown_deck` (the system forces the override). The deck detail contains several opponents, but every rule you write should state a common justification that "holds for all opponents".
- **Single layer (--opponent-deck)**: the specialized tree for that one opponent. You may reference their exclusive details, but at execution the Single layer is prepended as a whole and unmatched decisions descend to General — Single should contain only the necessary specialization and leave common fallbacks to General; do not copy common rules into Single.

# Discipline

- The total round cap is {{MAX_TURNS}} rounds (including the current reply). When rounds run out, the last validated `draft` becomes the output; if no draft ever validated, this drafting run fails.
- Think about what information you still need before writing. The deck detail is given above — its cost/damage/energy values are the only basis for writing rules; do not fill in numbers from memory. If a card from memory is not in the deck list, you may use `card_detail` to verify whether it exists and what it does, but you **must not** write it into a rule.
- Submit at least one `draft` before `final`, to avoid burning rounds on validation traps in a single finalization.
- Module requests and round counts are recorded as efficiency metrics: request on demand, do not hoard.
