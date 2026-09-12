# Candidate drafting mode (enabled this round)

You will draft **{{CANDIDATE_COUNT}} route candidates in this single conversation**, one per round. The candidates you have already produced stay in the conversation above as assistant messages, so you can see their full JSON; in each round produce **only the current round's candidate** and make it **explicitly different** from every earlier candidate along the route dimensions below. A reviewer then picks one to adopt based on the anchor-layer argument, and the rest are kept as "替代路线参考" (alternative route reference) for reflection.

# Output format (strict JSON, output nothing else)

```
{
  "archetype": "self-labeled route tag (aggro/midrange/control/combo/OTK/tempo, or a more fitting custom label)",
  "plan": { ...complete GamePlanV1 (schema and closed field set in the system prompt)... }
}
```

# Route differentiation discipline

- Each new candidate must make a **clear and self-consistent** route choice along the following dimensions and must be **visibly different from the candidates already in the conversation** (the reviewer judges by route difference and argument, not by length or rule count):
  - proactive vs reactive opening: rush damage vs stabilize and develop;
  - early vs late kill timing: bank energy for one burst vs continuous HP trading;
  - resource exchange vs banking for a burst: draw/cost-reduction snowball vs keeping cards and dice for a burst turn;
  - opener and element axis, reaction-axis preference (melt/overloaded/swirl/bloom/crystallize, etc.);
  - defensive weight: attacking trade vs survival rotation (switch/heal/shield).
- Repeating an earlier candidate's route, or emitting a near-identical tree, is rejected by a mechanical duplicate check and must be redone within the repair budget.
- Differentiation shows only in the **route**, not in errors: the tree must still be mechanically valid — every defId must be inside the deck list, `when` fields must be inside the closed set, and numbers must match the deck list (machine checks reject otherwise).
- `archetype` must match the tree's actual route (the reviewer checks name against shape).
