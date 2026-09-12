# `when` field in-depth manual (field_reference module)

Per-field types, semantics and usable examples. The base closed set is in the system prompt's GamePlanV1 spec; this manual adds **writing details and common mistakes**.

## Process fields

- `round` (number): round number, starting at 1. Use it to segment early/mid/late: `round <= 2` opening, `round >= 4` mid-to-late.
- `actionsTakenThisTurn` (number): number of actions your side has already taken this round (including the current decision, starting at 1). "First action of the round" is `actionsTakenThisTurn == 1`.
- `phase` (string): phaseId of the currently effective phase, `"none"` when no phase matches. You can write `phase == "none"` as a fallback scenario for "not in any phase".
- `turn` (number): **the current actor's index (0/1); at action-decision time it always equals your own side's index and carries no information**. Do not use it as a condition.
- Opponent tempo facts (the opponent's dice faces and hand contents are invisible; counts and flags are visible): `opponent.declaredEnd == true` means the opponent has declared end — all remaining actions this round are yours, so stop hesitating about slow actions; `opponent.dice.total` is the opponent's remaining dice count (0-1 = safe window, you can afford a slow setup action); `opponent.hand.count` is only a rough reference.

## Character fields

- `self.active.hp / energy / maxEnergy` (number): the active character's current HP / energy / energy cap.
- `self.active.aura` (string): the active character's elemental aura, values `none/cryo/hydro/pyro/electro/dendro/cryo_dendro`. Example: `opponent.active.aura == "none"` → apply an element to trigger a reaction.
- `self.characters.<defId>.aura / opponent.characters.<defId>.aura` (string): the elemental aura of a **benched (non-active) character** — the key field for predicting reactions after a switch. Example: before switching in an electro character to trigger overloaded, first check `self.characters.1403.aura != "none"` (that character already carries an aura and can trigger a reaction immediately on switch-in); if an opponent benched character has full energy and a pyro aura, a switch may enable melt — compare `opponent.characters.1104.aura == "pyro"` when planning defensive rotations.
- `self.active.defId` (number): the active character's defId. "The active character is Itto" is `self.active.defId == 1605`.
- `self.active.element` (string): the active character's element.
- `self.active.alive` (boolean): **write `== true`**; `alive >= 1` is always false (type mismatch).
- `self.characters.<defId>.hp / energy / maxEnergy / alive / satied`: a specific character (defId must be in your own deck list, otherwise it is a dead rule). Commonly used for switch conditions: `self.characters.1602.alive == true`. **satied (饱腹) = that character has already eaten food this round** (an engine `oneDuration` status that disappears at the end of the round); the `when` of a food rule must include the target character's `satied == false`, otherwise the whole chain thenMisses once that character is full — such a thenMiss is not noise, it is a real dead rule caused by a missing condition.
- `opponent.active.* / opponent.characters.<defId>.*`: same as above (the defId must be in the opponent's deck list; in unknown-deck arms do not write opponent character conditions).
- `self.aliveCount / opponent.aliveCount` (number): number of surviving characters.

## Resource fields

- `dice.total` (number): total remaining dice. **Valid only for uncolored costs** (`无色` = any die can pay). It does **not** work for same-color costs (`同色`: any element, but all dice must be the same element) — the engine requires a true same-element payment, so `dice.total >= n` on a 3-same-color card thenMisses systematically. For a same-color cost of n, write **one rule per element you might actually pay with**, each using `dice.<element>+omni >= n` (e.g. `dice.geo+omni >= 3` and `dice.pyro+omni >= 3` in a geo/pyro deck; the `+omni` term already covers omni dice); never collapse them into `dice.total >= n`.
- `dice.<element>+omni` (number, e.g. `dice.geo+omni`): the **total** of that element's dice and omni dice — this is the **standard field for elemental costs**: a 3-geo-cost skill is `{"field": "dice.geo+omni", "op": ">=", "value": 3}`, expressing "paying ability after omni substitution" precisely, with no configuration left out (the earlier AND split "geo>=2 and omni>=1" missed the all-omni direct payment case geo=0/omni>=3). **Conditions still do not support arbitrary arithmetic**: `dice.geo+dice.omni` (adding two complete fields) and other self-invented expressions remain illegal; the only legal form is the built-in `dice.<element>+omni`. Using `dice.total` to judge an elemental cost is the number-one source of thenMiss dead rules.
- `dice.omni` (number): number of omni dice.
- `dice.<element>` (number): cryo/hydro/pyro/electro/anemo/geo/dendro. **No `self.` prefix**; element names are lowercase English (`dice.ice` is illegal — the cryo element is spelled `dice.cryo`; `dice.geo` and the other lowercase element names are legal).
- `hand.count` (number), `hand.hasCard.<card defId>` (boolean), `hand.countWithTag.<tag>` (number).
  - **tag vocabulary**: a tag must be the English tag token exactly as listed in the deck detail / `card_detail` (matching is case-insensitive; this field's pattern only accepts `[a-z_]+`, so write the all-lowercase form). Legal card tags: `food`, `weapon`, `sword`, `claymore`, `pole`, `catalyst`, `bow`, `artifact`, `talent`, `technique`, `ally`, `place`, `item`, `blessing`, `adventurespot`, `legend`, `resonance`, `action`, `abyss`, `shield`, `barrier`. The same vocabulary applies to `then.card_tag`, `then.require_tag` and the mulligan `cardTag`. Chinese or invented tag names never match — when unsure, use `hand.hasCard.<defId>` instead.
- `opp.hand.hasCardP.<card defId>` (0–1 probability): hypergeometric estimate that the opponent's hand **currently** holds ≥1 copy of that card, P = 1 − C(U−k,h)/C(U,h). k = copies of that card in the opponent's deck list (**pre-game open-deck information, not omniscience**), h = the opponent's hand size, U = h + the opponent's remaining deck. **Accuracy boundary**: it does not track cards the opponent has already played/discarded (a future improvement), k is always the deck-list count → it systematically overestimates as the game progresses; use it as an upper bound. Typical use: estimate the probability that the opponent holds a damage-boost card (仙跳墙/火共鸣) to tune defensive thresholds, starting from `>= 0.5`; in environments where the opponent deck list is not injected this field is always undefined (the condition is always false), so do not make it your only line of defense.

## Board fields

- `self.summons.count / opponent.summons.count / self.supports.count / opponent.supports.count` (number).

## Threat fields (opp.threat.*, opponent-turn prediction)

Derived from player-visible information + the static skill table + a dice-distribution prior. **Semantic discipline: these are upper bounds / probability estimates, not preview-level precision** — the opponent's hand contents (damage boosters, resonance dice, quick switches) are invisible and can never be estimated; use them as conservative upper bounds in defensive rules and do not rely on them in offensive rules.

- `opp.threat.maxDamage` (number): upper bound of the opponent active character's "maximum damage in one action". Across all skills payable within their dice count (assuming all dice faces are usable; burst additionally requires full energy), take the maximum of base damage + reaction bonus (opponent skill element × our active character's aura). All added-damage segments are included (the bound includes conditional bonuses and may overestimate).
- `opp.threat.lethal` (boolean): `maxDamage ≥ our active HP + visible shields` (only entities exposing a `shield` variable are counted: character entities + combat statuses; damage-reduction statuses are not). **Write "if the opponent can kill me in one action, switch" directly with it; do not hardcode the kill line as hp <= some number**.
- `opp.threat.lethalP` (0–1 probability): estimate of the **actual probability** of a one-action kill — for each skill, check "damage + reaction bonus ≥ our active HP + visible shields", and take the maximum dice-payment probability among the qualifying skills (same binomial treatment as burstP); 0 if no skill qualifies, unknown if damage data is unavailable. **lethal is the upper bound (for the defensive safety net), lethalP is the probability (for the primary defensive trigger, start from `>= 0.5`); rules whose upper bound over-reports should be rewritten as lethalP thresholds, or lethal plus a lower self HP gate**.
- `opp.threat.burstReady` (boolean): the opponent active character has full energy and enough remaining dice for the burst cost.
- `opp.threat.burstP` (0–1 probability): binomial estimate that the opponent "can actually pay the burst cost" given hidden dice faces (remaining dice treated as independent uniform; same-color/uncolored costs only enter the total-dice gate). Always 0 when energy is not full or dice are insufficient. Risk appetite is yours: conservative `>= 0.5`, aggressive `>= 0.2`.
- `opp.threat.maxDamageAfterSwitch` (number): upper bound of the opponent's "switch (1 die) + skill" two-action damage, taking the maximum across all surviving benched characters. When a benched character is highly threatening (full-energy burst / high-damage elemental skill), this has more warning value than maxDamage.

Data basis: damage values are statically parsed from the current version's @gi-tcg/data source; games pinned to an older version may differ in values (the upper-bound nature is unchanged). When data is unavailable the field evaluates to "unknown" and the condition is always false — threat rules must always have a lower-priority non-threat fallback to take over.

```json
{ "priority": 8, "when": [
    { "field": "opp.threat.lethal", "op": "==", "value": true },
    { "field": "self.characters.1602.alive", "op": "==", "value": true },
    { "field": "self.active.defId", "op": "!=", "value": 1602 }
  ],
  "then": { "action_case": "switchActive", "target": 1602 },
  "reason": "opponent can kill our active in one action (threat.lethal upper bound) and Noelle is alive: switch to the high-HP slot to absorb the hit" }
```

```json
{ "priority": 9, "when": [
    { "field": "opp.threat.burstP", "op": ">=", "value": 0.5 },
    { "field": "self.active.hp", "op": "<=", "value": 7 },
    { "field": "self.active.satied", "op": "==", "value": false }
  ],
  "then": { "action_case": "playCard", "card_def_id": 333007, "target": 1602 },
  "reason": "opponent can probably pay for a burst (burstP≥0.5) and our active is in danger: eat food early to raise HP (anti-burst; satied==false prevents the satiated thenMiss; defId form is illustrative)" }
```

## Dynamic references

- `value` may be a `"$<field>"` reference to another field in the same position: `self.active.energy >= "$self.active.maxEnergy"` means "energy is full". This is the only way to write "energy full" (maxEnergy differs per character).

## Example rules (shape reference; replace defIds with your own deck's; every card class should have an answer to "when do I play it")

```json
{ "priority": 5, "when": [
    { "field": "self.active.energy", "op": ">=", "value": "$self.active.maxEnergy" },
    { "field": "dice.geo+omni", "op": ">=", "value": 3 }
  ],
  "then": { "action_case": "useSkill", "skill_type": "burst" },
  "reason": "burst when energy is full and geo+omni can pay 3 (dice.geo+omni is the standard field for elemental costs; all-omni direct payment is not missed)" }
```

```json
{ "priority": 6, "when": [
    { "field": "dice.dendro+omni", "op": ">=", "value": 5 }
  ],
  "then": { "action_case": "useSkill", "skill_type": "elemental_skill", "skill_def_id": 17033 },
  "reason": "the character has two elemental skills (17032 3草 / 17033 5草): skill_def_id names the exact one (#17033, 所闻遍计·真如); without it the rule would match either variant" }
```

```json
{ "priority": 10, "when": [
    { "field": "self.active.hp", "op": "<=", "value": 3 },
    { "field": "self.characters.1602.alive", "op": "==", "value": true }
  ],
  "then": { "action_case": "switchActive", "target": 1602 },
  "reason": "low HP and a surviving shield slot: switch (target takes the numeric character defId from the deck list)" }
```

```json
{ "priority": 30, "when": [
    { "field": "round", "op": "<=", "value": 2 },
    { "field": "hand.hasCard.322001", "op": "==", "value": true },
    { "field": "dice.geo+omni", "op": ">=", "value": 3 }
  ],
  "then": { "action_case": "playCard", "card_def_id": 322001 },
  "reason": "set up a support in the first two rounds (Paimon 3 same-color: +2 omni dice ×2 at action-phase start, 3 dice invested for 4 dice) — support/draw economic investment is independent of the opponent profile and should exist in any matchup. Same-color 3 cost: write one rule per element you may pay with (e.g. dice.pyro+omni >= 3 as a sibling rule), never dice.total" }
```

```json
{ "priority": 25, "when": [
    { "field": "hand.hasCard.312010", "op": "==", "value": true },
    { "field": "dice.geo+omni", "op": ">=", "value": 3 }
  ],
  "then": { "action_case": "playCard", "card_def_id": 312010, "target": 1602 },
  "reason": "have the equipment (千岩牢固, 3 same-color) and enough dice: attach it to the main character (the numeric target = which character receives the equipment, which must satisfy that equipment's restrictions — see the deck detail)" }
```

```json
{ "priority": 6, "when": [
    { "field": "hand.hasCard.333007", "op": "==", "value": true },
    { "field": "self.characters.1602.alive", "op": "==", "value": true },
    { "field": "self.characters.1602.satied", "op": "==", "value": false },
    { "field": "self.characters.1602.hp", "op": "<=", "value": 6 }
  ],
  "then": { "action_case": "playCard", "card_def_id": 333007, "target": 1602 },
  "reason": "Noelle at ≤6 HP, not yet satiated this round, and we hold a Mushroom Pizza (1-cost food): feed the heal (satied==false prevents the satiated cascade thenMiss; food is limited to 1 per character per round)" }
```

```json
{ "priority": 2, "when": [
    { "field": "opponent.active.hp", "op": "<=", "value": 6 },
    { "field": "self.active.energy", "op": ">=", "value": "$self.active.maxEnergy" },
    { "field": "dice.geo+omni", "op": ">=", "value": 3 }
  ],
  "then": { "action_case": "useSkill", "skill_type": "burst", "kills": true },
  "reason": "finisher: when the opponent active's HP ≤ burst damage + reaction/equipment bonuses (compute from the deck detail; the 6 here is illustrative) end it directly" }
```

```json
{ "priority": 12, "when": [
    { "field": "self.characters.1605.energy", "op": ">=", "value": "$self.characters.1605.maxEnergy" },
    { "field": "self.active.defId", "op": "!=", "value": 1605 },
    { "field": "self.characters.1605.alive", "op": "==", "value": true }
  ],
  "then": { "action_case": "switchActive", "target": 1605 },
  "reason": "offensive rotation: Itto has full energy and is benched — switch him in for a higher-value burst turn (switching is a slow action that gives away one action; only worth it when the incoming character's next action is more efficient)" }
```

```json
{ "priority": 50, "when": [
    { "field": "dice.geo", "op": "<=", "value": 1 },
    { "field": "dice.omni", "op": "<=", "value": 0 },
    { "field": "dice.total", "op": ">=", "value": 3 },
    { "field": "hand.count", "op": ">=", "value": 2 },
    { "field": "self.active.defId", "op": "==", "value": 1602 }
  ],
  "then": { "action_case": "elementalTuning" },
  "reason": "want the 3-geo elemental skill but geo+omni is short and the hand has spare cards: tune for a geo die (fast action, does not waste the turn). Note tuning cannot convert an omni die or a die that is already of the target element" }
```

Common dead-rule sources: ① referencing a defId not in the deck list; ② comparing a boolean field with a number; ③ a cost condition below the action's real cost (a 3-cost skill written as `dice.total >= 2`), or **an elemental cost written only as `dice.total` without the elemental composition**; ④ a wrong number of digits in a `hand.hasCard` id; ⑤ **treating an expression as a field name** — the only legal built-in addition form is `dice.<element>+omni`, and self-invented expressions such as `dice.geo+dice.omni` remain illegal; ⑥ a Chinese or invented tag name in `hand.countWithTag.<tag>` — use the exact tag token listed in the deck detail, or switch to `hand.hasCard.<defId>` when unsure; ⑦ a food rule missing the target character's `satied == false` — once satiated the action is not executable and the whole chain thenMisses.
