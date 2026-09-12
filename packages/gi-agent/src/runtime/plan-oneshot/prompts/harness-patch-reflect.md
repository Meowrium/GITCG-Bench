# patch revision protocol (enabled this round)

Revision **does not resend the full plan**: you submit restricted ops and the harness merges them server-side into the **current decision tree** (the original plan + patches already merged this round), validates the merged result, and sends it back. Rules not touched by any op are kept exactly as they are — this is a hard discipline: only touch rules with evidence supporting the change.

## Command: patch

```json
{"action": "patch", "ops": [...], "predictionPostmortem": "prediction-gap postmortem (provide with the first patch)", "predictions": {"winRateEstimate": 0.4, "expectedRounds": 7, "confidence": 0.5, "keyThreats": ["..."]}}
```

`predictions` must refill all fields (can be provided together with the postmortem on any patch).

## op types (closed set)

| op | fields | semantics |
|---|---|---|
| `revise` | `ruleRef`, `when`?, `then`?, `reason`, `falsifiableClaim`? | rewrite an existing rule; omitted when/then/reason keep their original values; priority is unchanged (blame keys stay stable) |
| `remove` | `ruleRef`, `reason`, `falsifiableClaim`? | delete a rule (before deleting, confirm some new rule takes over its matching scenarios, except thenMiss dead rules) |
| `add` | `scope`?, `position`?, `when`?, `then`, `reason`, `falsifiableClaim`? | add a rule; `scope` defaults to "global"; `position` defaults to "end" (evaluated last) and may be "start" or `{"before": "global:5"}` / `{"after": "global:5"}` — the harness inserts with a half priority and does not reorder existing rules |
| `set_fallback` | `policy`, `reason` | change the fallback policy (baseline / conservative / declare_end) |

- `ruleRef` has the form `global:5` / `phase:burst:20` (closed set: it must exist in the current tree).
- One patch carries at most {{MAX_OPS}} ops; if you need more, submit several patches.
- Every op must carry a `reason` (citing concrete evidence: statistics / game-N:seq / rule_drilldown results); a falsifiable `falsifiableClaim` is encouraged (the automated ablation pipeline verifies it).
- `falsifiableClaim` may also anchor **numeric checks** (these revisions produce no thenMiss/fallback signal, so they must be re-verified via the card-face/anchor check sections or an ablation arm): cost assertions ("after changing the dice gate from 4 electro to 3 electro, that card-face check finding should disappear"), HP thresholds ("after changing the threshold to ≤10 it no longer trips the HP-cap check"), damage values ("after changing damage_min to 3 it no longer exceeds base damage +2").

## Authorization boundary (hard constraints)

- A patch only affects **this side's current decision tree** (held by the harness; you do not resend the full text); ops are pure data with no file paths and cannot touch other plans.
- System fields such as `context` / `author` / `planId` / `parentPlanId` / `opening` are not expressible in ops; an unknown key inside an op causes the whole op to be rejected.
- Corpora and evidence come only from this side's trace/eval (the opponent's hand and decision tree are neither visible nor queryable).

## Merge feedback

After each patch is merged you receive: the merged shape (rule count/coverage) + **static replay verification** (a hit-matrix diff over all decision points from the previous round: fallback-rate change, per-rule hit-surface change, hit-migration samples) + **per-op assertions** (whether the rule you revised no longer matches at its blunder points / has moved into fallback). Use this to decide whether to add or withdraw — a local revision changes the hit surface of every rule after it, so look at the diff before continuing.

## Finalize

```json
{"action": "final"}
```

In patch mode `final` may omit the payload: the plan merged from the accumulated patches is the output (`predictionPostmortem`/`predictions` missing gets it rejected; alternatively use `{"action":"final","result":{...}}` to carry a full draft). `final` first passes a closing verification (replay diff + assertion summary); if it fails you get the report back and may `final` again to force it through once you are sure.

If you have already submitted patches and then submit a **full** draft/final (carrying a complete `result`): that draft wholesale overwrites the merged patch results (patch revisions not folded into this draft are lost), and the harness rejects it once to ask for confirmation — to confirm the overwrite, add `"overwritePatches": true` at the top level of `result` and resubmit; if you want to keep the patch results, keep revising with the patch command, or fold the merged content into the full draft before confirming the overwrite.

## Route switch: the switch_route command (**only available when the first round injected the "替代路线参考" section**; otherwise it is rejected as a protocol error)

The patch protocol structurally freezes `opening` and can only change existing rules — when the evidence shows that **the route itself was chosen wrong** (not a rule mapping error), use `switch_route` to perform a **unit-level graft** from a candidate tree in the "替代路线参考" section:

```json
{"action": "switch_route", "candidateIndex": 1, "units": ["opening"], "reason": "cite concrete evidence / route argument", "falsifiableClaim": "after switching the opening, the fallback rate should drop and coverage should not regress"}
```

- `candidateIndex`: the candidate index in the alternate-route section, which **must not be the one already adopted in this run** (chosenIndex).
- `units`: GamePlanV1 structural units, **1–2 per switch and ≤2 accumulated per run**:
  - `"opening"` = the three opening sections as a whole (chooseActive/mulligan/reroll);
  - `"fallback"` = the fallback policy;
  - `"rules"` = the whole global rule chain (priorities kept from the candidate);
  - `"phase:<phaseId>"` = that phase's whole chain (when + rules); the phaseId must exist in the **candidate tree**, and if the working tree lacks it, it is appended to the end of `phases`.
- `reason` and `falsifiableClaim` are required and non-empty (a route switch is a single-variable arm; the ablation pipeline verifies it); a `falsifiableClaim` example: "after switching to candidate 1's opening, the same-seed ladder of 20 games should show a lower fallback rate".
- Everything not listed in `units` keeps the current tree; the same unit (or a unit inside that candidate's adoptedUnits) must not be grafted twice.
- After the graft the harness returns: the validate result + static lint (including the card-face check) + a **static replay hit-matrix diff** (fallback rate / hit-surface change / migration samples, baseline = the working tree before the graft). If it fails, the whole command is rejected and the current tree is unchanged.
- Route switches and patches can alternate; a full draft/final overwrites the route-switch results (same patch-overwrite confirmation gate).

## Discipline

- Minimal change: a reflection round usually needs only 3–8 ops; keep is the default. Wholesale rewrite-style revision (rewriting most rules every round) breaks verified rules and causes metric rebound — it is a forbidden anti-pattern.
- The `plan_simulate` module (no id needed) can be requested at any time for the current plan's static replay matrix — look before you change when unsure about the impact.

## portfolio mode (applies only with --portfolio; legacy single-tree mode ignores this section)

In two-layer portfolio mode the merge target is a set of **layered trees** (General + several Singles). Op targeting must be explicit down to the layer:

- **`ruleRef` of revise / remove must carry the layer prefix**: `general:global:5` / `single:hongniu:global:5` / `single:hongniu:phase:burst:20`. Old-format keys without a prefix (`global:5`) point at no layer and the whole op is rejected.
- **add / set_fallback must carry a `layer` key**: `"layer": "general"` or `"layer": "single:hongniu"` (the label is non-empty and contains no `:`). Omitting it rejects the whole op.
- If `position.before/after` in an add carries a layer prefix, it must agree with the add's `layer`; without a prefix it is a reference inside that layer.

Valid example:

```json
{"action":"patch","ops":[
  {"op":"revise","ruleRef":"general:global:30","then":{"action_case":"switchActive","target":"opponent.active"},"reason":"cross-group common gap: both opponent groups hit this rule with high blunder"},
  {"op":"remove","ruleRef":"single:hongniu:phase:burst:20","reason":"this single dead rule: perRuleHits=0 and thenMiss=4"},
  {"op":"add","layer":"single:hongniu","scope":"global","when":[{"field":"dice.total","op":">=","value":6}],"then":{"action_case":"elementalTuning"},"reason":"hongniu specialization: tune to fill in when the opening dice are short"},
  {"op":"set_fallback","layer":"general","policy":"conservative","reason":"keep the General fallback unchanged, just declare the layer explicitly"}
]}
```

Invalid example (will be rejected):

```json
{"action":"patch","ops":[
  {"op":"revise","ruleRef":"global:30","then":{"action_case":"declareEnd"},"reason":"missing layer prefix — points at no layer"},
  {"op":"add","scope":"global","then":{"action_case":"declareEnd"},"reason":"missing layer key"},
  {"op":"set_fallback","policy":"declare_end","reason":"missing layer key"}
]}
```

For layer-routing discipline and D6 advice, see the "Two-layer portfolio revision discipline" chapter of the system prompt: General takes only cross-group common revisions (evidence in ≥2 groups), Single takes only that opponent's specialized revisions; a general key appearing in a single group risks overfitting; known dead rules in a Single are fixed as usual as an exception. Trees in a touched layer have their planId recomputed at closing, with parentPlanId pointing at that layer's old planId — untouched layer trees are kept as-is.
