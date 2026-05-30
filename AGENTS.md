# AGENTS.md

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
typings → config/utils → core → data → (everything else)
```

**After modifying `@gi-tcg/typings`**: must `bun run build` (or `bun run build:buf` inside typings) to regenerate protobuf code in `typings/src/gen/` and JSON schemas. Core validation will fail against stale schemas.

**After modifying `@gi-tcg/core` Ohm grammar** (`core/src/query/query.ohm`): must `bun run build:ohm` inside core, or `bun run build`.

## Monorepo structure

27 packages in `packages/*`, all under `@gi-tcg/` namespace. Key packages:

| Package | Role | Entry |
|---------|------|-------|
| `typings` | Proto-generated types for cross-language RPC | `src/gen/` is auto-generated from `proto/*.proto` via buf |
| `core` | Game logic, state machine, query engine | `Game` class, Ohm-based query DSL |
| `data` | Official card definitions | Builder DSL from `@gi-tcg/core/builder` |
| `test` | Test framework for core + data | Uses `#test` and `#jsx` import aliases |
| `config` | Shared tsup/build config | No source, just build tooling |
| `utils` | Shared utilities | |
| `web-ui-core` | Solid.js UI components | `bun dev` to test |
| `standalone` | Integrated debug web UI | `bun dev` to launch |
| `server` | Battle platform (NestJS + Fastify + Prisma) | Needs `prisma:generate` before build; uses `#prisma/*` import alias |
| `mcp` | MCP server for AI agent integration | |
| `gi-agent` | Multi-agent battle AI (LangGraph) | |
| `cbinding` | C/C++ binding (rollup + cmake) | `bun scripts/prepare.ts` then cmake |

## Card data definitions (`@gi-tcg/data`)

Characters: `src/characters/{element}/{name}.ts` (7 element dirs)
Cards: `src/cards/{equipment|event|support}/*.ts`

All definitions use the builder DSL imported from `@gi-tcg/core/builder`:
```ts
import { character, skill, summon, card, DamageType, SummonHandle } from "@gi-tcg/core/builder";
```

`bun run regenerate_data` in data package regenerates data from generators.

## Code conventions

- **ESM only**, `"type": "module"` everywhere
- **No semicolons** (ESLint rule `semi: 0`; `@typescript-eslint/semi: 1`)
- **Strict TypeScript** with `verbatimModuleSyntax`, `isolatedModules`
- **Bun customConditions**: workspace packages resolve to source via `"bun"` condition in exports, so cross-package imports work without building
- **AGPLv3 license header** on every source file (copy from any existing file)
- **Error hierarchy**: all custom errors extend `GiTcgError` (in `core/src/error.ts`)

## Gotchas

- **Patched deps** (in root `package.json` `patchedDependencies`): `ohm-js`, `importx`, `puppeteer-screen-recorder`, `@prisma/client` — do not upgrade these without checking patches still apply
- **`@gi-tcg/data` has `@gi-tcg/core` as a `peerDependency`**, not a regular dependency
- **`@gi-tcg/core` exports subpaths**: `@gi-tcg/core` (main), `@gi-tcg/core/builder` (card DSL), `@gi-tcg/core/builder/internal` (internal)
- **CI builds with** `bun run build -n cbinding standalone` (skips typing, targets only cbinding + standalone + deps)
- **Dev server** for UI testing: `cd packages/standalone && bun dev` (or `cd packages/web-ui-core && bun dev`)

## Architecture docs

`docs/development/` has detailed docs: `state.md` (data structures), `process.md` (settlement flow), `query.md` (Ohm query system), `io.md` (player IO), `log.md` (logging). Note: these may be outdated.
