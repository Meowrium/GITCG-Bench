# Game rules reference (numeric basis for writing rules; shared by author/reflect)

## Rounds and resources

- Flow: deal + mulligan (换牌) → choose the active character → roll dice (8 elemental dice per round, one reroll allowed) → action phase (players alternate actions) → end phase → next round rerolls dice.
- **Dice do not carry over to the next round**: unused dice are all discarded at the end of the round — never write a rule like "save dice for the next round"; spend up to 8 dice every round.
- Hand cards carry over between rounds (limit 10); at the end phase both players draw 2 cards; character HP / energy / elemental aura / equipment / summons carry over.
- **Energy economy**: the **only source** of energy is using an initiative skill — every normal attack / elemental skill gives the **user** +1 energy (capped at maxEnergy; burst gives no energy); **taking damage does not grant energy** (engine-specific, differs from some rule memories). Burst consumes the required energy. Therefore the opponent's energy progress depends only on how many skills they have used this round — estimate "when will the opponent have a full-energy burst" this way, not by hits taken. **Rule-writing**: test "energy full" with `energy >= "$<character>.maxEnergy"` (e.g. `self.active.energy >= "$self.active.maxEnergy"`, `opponent.active.energy >= "$opponent.active.maxEnergy"`; for a benched character replace `active` with `characters.<defId>`).
- Summons and supports: at most 4 of each per side. Maximum 15 rounds; if neither side has won by then it is a draw — a turtle plan can only secure a draw, never a win.

## Action costs (dice.* thresholds must follow this table and the playCost in the deck detail)

| Action | Cost | Rule-writing form (canonical shape in `when`) | Notes |
|------|------|------|------|
| normal attack (`action_case: "useSkill"`, `skill_type: "normal_attack"`) | 1 die of the active character's element + 2 any | `dice.<element>+omni >= 1` and `dice.total >= 3` | Grants 1 energy; when the total dice count is even, the charged-attack version can be used |
| elemental skill (`action_case: "useSkill"`, `skill_type: "elemental_skill"`) | usually 3 dice of the active character's element | `dice.<element>+omni >= 3` | Follow the playCost in the deck detail. When a character has **several skills of the same type** (e.g. Nahida 17032 3草 / 17033 5草), name the exact one with `skill_def_id` (the `#<id>` in the deck detail) — otherwise the rule matches any variant of that type |
| burst (`action_case: "useSkill"`, `skill_type: "burst"`) | elemental dice + energy | `dice.<element>+omni >= N` and `energy >= "$<character>.maxEnergy"` | Consumes all required energy; cost follows playCost |
| play a card (`action_case: "playCard"`) | the card's playCost | look up the deck detail; test possession with `hand.hasCard.<defId> == true` | 0-cost cards exist; a card whose card text marks it as a combat action (战斗行动) is slow, all other event cards are fast |
| switch character (`action_case: "switchActive"`) | 1 any | `dice.total >= 1` | **Slow (combat) action**: after switching, the turn passes to the opponent — a switch rule gives away one action |
| elemental tuning (`action_case: "elementalTuning"`) | 1 any + discard 1 hand card | `dice.total >= 1` and `hand.count >= 1` | Converts one die into the active character's element; cannot tune an omni die or a die already of that element; fast action |
| declare end (`action_case: "declareEnd"`) | 0 | — (the `declareEnd` action itself) | The end phase begins once both players have declared |

Cost type meanings: `<n><element>` = n dice of that element (omni dice substitute for any element); `uncolored (无色)` = any die can pay; `same color (同色)` = any element but all dice must be the same element; `energy (充能)` = energy points.
Therefore `dice.total >= N` only says the total dice count is enough, not that the elemental composition is enough — a skill costing 3 geo needs a condition such as `dice.geo+omni >= 3` to be meaningful.

## Charged attack and plunging attack (two normal-attack variants; cost/damage follow the candidate preview)

- **Charged attack**: when the current total dice count is **even**, the normal attack can be used in its charged version (engine `canCharged`); damage and cost are higher — write `damage_min`/`kills` with the preview values.
- **Plunging attack**: after a character is switched in as the active character, **the next normal attack this round is treated as a plunging attack** (the engine sets `canPlunging` on switch-in). Any initiative skill used by that character clears the plunging eligibility immediately (`skill_executor.ts:104-113`), and the end of the round also clears it; a `normalAsPlunging` status can force the flag. So switching does more than change the actor: it also brings one plunging damage bonus — factor the plunging bonus into kill estimates after a switch.

## Fast / slow actions (action sequence inside a round)

- Fast action: playing an event card that is not a combat action (战斗行动), and elemental tuning — after resolving it **you still decide the next action**, so you can play several cards in a row within one round.
- Slow action (combat action): using a skill, switching characters, declaring end — after resolving it the turn passes to the opponent.
- The typical in-round order is "play cards / tune first, then use skills". Rule chains are re-evaluated at every decision point; `actionsTakenThisTurn` distinguishes earlier from later actions in the round.

## Damage and reactions (numeric basis for damage_min / kills / HP thresholds)

- Final damage = max(0, ceil((base damage + increases) × multiplier / divider) − decreases).

| Attached aura | Incoming | Reaction | Effect |
|------|------|------|------|
| cryo | pyro | melt (融化) | +2 |
| hydro | pyro | vaporize (蒸发) | +2 |
| pyro | electro | overloaded (超载) | +2, forces the opponent to switch active |
| cryo | electro | superconduct (超导) | +1, 1 piercing damage to a benched opponent character |
| hydro | electro | electro_charged (感电) | +1, 1 piercing damage to a benched opponent character |
| hydro | cryo | frozen (冻结) | +1, applies the Frozen status |
| cryo/hydro/pyro/electro | anemo | swirl (扩散) | no bonus on the main hit; deals 1 damage of the swirled element to the other characters |
| cryo/hydro/pyro/electro | geo | crystallize (结晶) | +1, creates a shield |
| cryo | dendro | none | no reaction damage; the aura becomes cryo_dendro |
| pyro | dendro | burning (燃烧) | +1, creates the Burning Flame summon |
| electro | dendro | quicken (激化) | +1, creates the Catalyzing Field |
| dendro | hydro | bloom (绽放) | +1, creates a Dendro Core |

- Damage modification order: type change → reaction bonus → increases → multipliers/dividers → decreases.

- Kill estimate = skill base damage + reaction bonus (+2/+1) + equipment/status bonuses, compared against the opponent's HP and shields (shields protect only the active character). When writing `kills`/`damage_min` rules, use this arithmetic to set the kill threshold at its real value instead of staring at hp<=1.
- The end phase resolves in order: clear both sides' declaredEnd → resolve summon damage/effects and statuses → both players draw 2 cards → round number +1 (and check the 15-round limit). When estimating kills, include end-phase damage from your own summons and lasting statuses.

## Healing and defeat

- Heal amount = min(heal value, maxHP − current HP) — overflow is wasted, so a big healing dish on a low-HP character is fine while feeding it at full HP is pure waste.
- A defeated character **can only be brought back by "revive" effects**; ordinary healing does nothing to them.
- HP≤0 means defeat: clear that character's aura, energy and plunging flag (energy reset to zero means the charge a defeated character accumulated is lost — when a low-HP character is close to full energy, weigh protecting them against sacrificing them).
- **When the active character is defeated the engine pauses and forces a replacement**: choosing the new active character costs no action and no dice (it is not a `switchActive` action).
- If all characters of one side are defeated → that side loses immediately; if neither side wins after 15 rounds it is a draw.
- Food: each character can eat at most 1 food card per round (satiated); each side can play at most 1 legend card per game.

## Vocabulary map (for cross-checking while writing rules)

- The most common "game concept → field form" mappings (cost / energy) are given above. For the full `when` field semantics, allowed values, examples and common dead rules, see the **`field_reference` module** — if you are unsure about a field form (e.g. `hand.countWithTag.<tag>`, `opp.hand.hasCardP.<defId>`, the `dice.<element>+omni` boundary), **request it before writing** (use `request_modules` in harness mode; in one-shot mode write directly from the sections above and the schema spec).
- Remember the three iron rules: elemental costs use `dice.<element>+omni` (not `dice.total`); boolean fields are written `== true/false` (not `>= 1`); numeric ids are not quoted (`target: 1605`, not `"1605"`).
