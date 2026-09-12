# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                    # install deps
bun run build                  # build all packages (respects dep graph via scripts/build.ts)
bun run build <target>         # build only named package(s) + their deps (e.g. "bun run build core data")
bun run build -n               # build skipping type generation (NO_TYPING=1)
bun run test                   # run all package tests
```

Single-package commands (run inside package dir):
```bash
bun run check                  # tsc --noEmit (packages that have it)
bun test                       # run that package's tests
bun test path/to/file.test.ts  # single test file
```

No root-level lint or typecheck command exists. ESLint configs only live in UI packages (standalone, web-ui-core, web-client, deck-builder, card-data-viewer).

## Build dependency chain

Root build script (`scripts/build.ts`) resolves topological order automatically. The critical chain is:

```
typings → utils → core → data → (everything else)
```

**After modifying `@gi-tcg/typings`**: must `bun run build` (or `bun run build:buf` inside typings) to regenerate protobuf code in `typings/src/gen/` and JSON schemas. Core validation will fail against stale schemas.

**After modifying `@gi-tcg/core` Ohm grammar** (`core/src/query/query.ohm`): must `bun run build:ohm` inside core, or `bun run build`.

## High-level architecture

This is a **Genius Invokation TCG** (Genshin Impact card game) simulator and AI platform. The core is a game state machine that advances through phases by applying **mutations** (Immer-based immutable state updates) and dispatching **events** to trigger card skills.

### Game state machine

The `Game` class (`packages/core/src/game.ts`) drives the game loop through phases:
```
initHands → initActives → roll → action → end → (back to roll or gameEnd)
```

- `Game.state` is the immutable `GameState` tree (with `StateSymbol` brand on every node)
- `Game.mutate(mutation)` applies a `Mutation` (from `core/src/base/mutation.ts`) via the `StateMutator`
- `StateMutator` uses Immer `produce()` for immutable updates and emits change notifications
- Player IO is abstracted via RPC: the game calls `rpc(who, method, request)` to ask players for decisions (choose active, reroll, select action, switch hands, select card). The `Player` class has an `io` object that sends/receives protobuf messages.
- `SkillExecutor` (`core/src/skill_executor.ts`) handles both executing skills (useSkill/playCard) and dispatching events to triggered skills. Skills are defined with the builder DSL.

### State data model

All state objects have a `StateSymbol` brand identifying their kind: `"game"`, `"player"`, `"character"`, `"entity"`, `"extension"`, `"attachment"`.

Key state types in `core/src/base/state.ts`:
- `GameState` — top-level: players, phase, round, extensions, iterators (random seed + id counter)
- `PlayerState` — characters, hands, pile, dice, summons, supports, combatStatuses, flags
- `CharacterState` — definition, variables (health/energy/aura/etc.), attached entities (equipment/status)
- `EntityState` — definition, variables (usage/duration/shield/etc.), attachments
- `ExtensionState` — extension definition + arbitrary state (for game-wide mechanics)

Cards in hand/pile, summons, supports, combat statuses, equipment, and statuses are all `EntityState` with `"entity"` brand — differentiated by which area they live in and their `EntityDefinition.type`.

### Event system

Skills are either **initiative** (actively played: useSkill, playCard) or **triggered** (react to events). The event system is defined in `core/src/base/skill.ts`:

- Events are strings like `"onBattleBegin"`, `"onBeforeUseSkill"`, `"onAction"`, `"onDispose"`, etc.
- `SkillExecutor.handleEvent(mutator, eventName, eventArg)` finds all triggered skills that listen to that event and executes them in priority order
- Event args carry context: `EventArg` (general), `UseSkillEventArg`, `PlayCardEventArg`, `DamageOrHealEventArg`, `SwitchActiveEventArg`, etc.
- Skills can emit inline events (sub-events) during execution, which are handled recursively

### Ohm query DSL

`core/src/query/query.ohm` defines a query language for searching game state. The grammar compiles to a parser via `ohm generateBundles`. Queries look like:
```
my characters with tag("pyro") and has equipment with tag("weapon")
```
Used extensively by card skill definitions to find targets and check conditions. The semantic actions that execute queries are in `core/src/query/semantic.ts`.

### IO layer

`core/src/io.ts` handles serialization between internal state and protobuf-typed messages (`@gi-tcg/typings`). Key functions:
- `exposeState(who, state)` — converts internal `GameState` to `PbGameState` (hiding opponent's hand/pile)
- `exposeMutation(who, mutation)` — converts internal mutations to `ExposedMutation` (filtering by visibility)
- `exposeAction(actionInfo)` — converts internal action info to the `Action` protobuf type for RPC

### Card data definitions (`@gi-tcg/data`)

Characters: `src/characters/{element}/{name}.ts` (7 element dirs: anemo, cryo, dendro, electro, geo, hydro, pyro)
Cards: `src/cards/{equipment|event|support}/*.ts`

All definitions use the builder DSL imported from `@gi-tcg/core/builder`:
```ts
import { character, skill, summon, card, DamageType, SummonHandle } from "@gi-tcg/core/builder";
```

`bun run regenerate_data` in the data package regenerates data from generators.

### Mutation system

`core/src/base/mutation.ts` defines all possible state mutations as a discriminated union on `type`. Examples: `"createEntity"`, `"removeEntity"`, `"modifyEntityVar"`, `"resetDice"`, `"switchActive"`, `"changePhase"`, `"stepRound"`, `"setWinner"`, etc. Mutations are applied via Immer `produce()` on the state tree. `StateMutator` (`core/src/mutator.ts`) wraps mutation application with logging, notification, and pause hooks.

### Error hierarchy

`core/src/error.ts`:
- `GiTcgError` (abstract base)
  - `GiTcgCoreInternalError` — bugs in core logic (includes `GiTcgCoreInternalEntityNotFoundError`)
  - `GiTcgDataError` — invalid card data (includes `GiTcgQueryError`)
  - `GiTcgIoError` — player IO errors (timeout, invalid response)

`Game.config.errorLevel` controls behavior on errors: `"strict"` (throw), `"toleratePreview"` (skip preview errors), `"skipPhase"` (skip entire phase on error).

## Test framework

`@gi-tcg/test` provides a **JSX-based DSL** for constructing game state in tests:

```ts
import { setup, Character, Summon, Card, Status, State, Ref } from "#test";

const c = setup(
  <State>
    <Character my active def={CharacterHandle.Diluc} health={10} energy={2}>
      <Equipment def={EquipmentHandle.WolfsGravestone} />
    </Character>
    <Character opp def={CharacterHandle.Kaeya} health={6} />
    <Summon my def={SummonHandle.OceanicMimicFrog} usage={2} />
    <Card my def={CardHandle.Paimon} />
  </State>
);
// c.game — the Game instance
// c.state — current GameState
// c.player(idx) — player proxy for making moves
```

Import aliases `#test` and `#jsx` are defined in `packages/test/package.json` imports field. `TestController` wraps `Game` with convenience methods for test scenarios.

## Monorepo packages (27 total, `packages/*`, all under `@gi-tcg/`)

| Package | Role | Key details |
|---------|------|-------------|
| `typings` | Proto-generated types for cross-language RPC | `src/gen/` auto-generated from `proto/*.proto` via buf |
| `core` | Game logic, state machine, query engine | `Game` class, Ohm query DSL, mutation system, `StateMutator`, `SkillExecutor` |
| `data` | Official card definitions | Builder DSL from `@gi-tcg/core/builder`; peerDepends on core |
| `test` | Test framework for core + data | JSX DSL with `#test` and `#jsx` import aliases |
| `config` | Shared tsup/build config | No source, just build tooling |
| `utils` | Shared utilities | `flip`, `checkDice`, `pair`, etc. |
| `web-ui-core` | Solid.js UI components | `bun dev` to test |
| `standalone` | Integrated debug web UI | `bun dev` to launch |
| `server` | Battle platform (NestJS + Fastify + Prisma) | Needs `prisma:generate` before build; uses `#prisma/*` import alias |
| `mcp` | MCP server for AI agent integration | |
| `gi-agent` | Multi-agent battle AI (LangGraph) | Scoring calibration, battle agents, RL training, self-play |
| `gi-ml` | ML training infrastructure | |
| `cbinding` | C/C++ binding (rollup + cmake) | `bun scripts/prepare.ts` then cmake |
| `llm-deck-analyzer` | LLM-based deck analysis | |
| `eval-char-comb` | Character combination evaluation | |

## Code conventions

- **ESM only**, `"type": "module"` everywhere
- **No semicolons** (ESLint rule `semi: 0`; `@typescript-eslint/semi: 1`)
- **Strict TypeScript** with `verbatimModuleSyntax`, `isolatedModules`
- **Bun customConditions**: workspace packages resolve to source via `"bun"` condition in exports, so cross-package imports work without building
- **AGPLv3 license header** on every source file
- **Error hierarchy**: all custom errors extend `GiTcgError` (in `core/src/error.ts`)

## Gotchas

- **Patched deps** (in root `package.json` `patchedDependencies`): `ohm-js`, `importx`, `puppeteer-screen-recorder`, `@prisma/client` — do not upgrade these without checking patches still apply
- **`@gi-tcg/data` has `@gi-tcg/core` as a `peerDependency`**, not a regular dependency
- **`@gi-tcg/core` exports subpaths**: `@gi-tcg/core` (main), `@gi-tcg/core/builder` (card DSL), `@gi-tcg/core/builder/internal` (internal)
- **CI builds with** `bun run build -n cbinding standalone` (skips typing, targets only cbinding + standalone + deps)
- **Dev server** for UI testing: `cd packages/standalone && bun dev` (or `cd packages/web-ui-core && bun dev`)
- **State mutations are immutable**: always use a `Game` instance or `StateMutator` to change state; never mutate state objects directly
- **Random seed** in `GameState.iterators.random` is stepped via `nextRandom()` — determinism depends on this being sequential

## Architecture docs

`docs/development/` has detailed docs: `state.md` (data structures), `process.md` (settlement flow), `query.md` (Ohm query system), `io.md` (player IO), `log.md` (logging). Note: these may be outdated.
