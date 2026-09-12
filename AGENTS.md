# AGENTS.md

## Toolchain

- **Package manager: pnpm** (`pnpm@11.3.0`). **Do NOT use `bun`** — `@gi-tcg/config` ships a `bun` shim that throws `"We do not use bun anymore!"`.
- **Node `^26.1.0`** required (root `engines`).
- **`gnx`** is the TS script runner (tsx-based, provided by `@gi-tcg/config`). Run repo TS scripts via `pnpm exec gnx scripts/foo.ts`. Replaces the old `bun scripts/foo.ts`.
- **Bundlers**: `tsdown` by default (typings, core, utils, data, config); a few use `tsup` (`mcp`, `agent`), `vite build` (`standalone`, `web-ui-core`), `gnx scripts/build.ts` (`server`), `gnx scripts/prepare.ts` (`cbinding`).
- **Workspace source resolution**: packages export `"development"` -> source TS, `"import"` -> built `dist`. `gnx` enables the `development` condition **only when `NODE_ENV=development`**. By default deps resolve to `dist`, so build deps first (`pnpm build`) or set `NODE_ENV=development` for dev against source.

## Commands

```bash
pnpm install                       # install deps
pnpm build                        # build all (root .filter -> pnpm -r build)
pnpm .filter build core,data       # build only named packages (comma-sep; does NOT pull deps)
pnpm build:no-typing              # build with NO_TYPING=1 (skip type generation)
pnpm test                         # run all package tests (pnpm -r test)
```

Single-package (run inside the package dir):
```bash
pnpm check                        # tsc --noEmit (packages that define it)
pnpm test                         # vitest (most) / vitest run (agent, ml)
pnpm test path/to/file.test.ts    # single test file (vitest path filter)
pnpm exec gnx scripts/foo.ts      # run an ad-hoc TS script in package context
```

No root-level lint or typecheck exists. ESLint (flat `eslint.config.js`) lives in: `web-ui-core`, `standalone`, `web-client`, `deck-builder`, `card-data-viewer`, `mcp`, `state-editor`, `agent`, `llm-deck-analyzer` — run `pnpm lint` where defined.

## Build dependency chain

Root `.filter` script (`scripts/filter.ts`) wraps `pnpm --recursive --filter`. Critical order:

```
typings -> utils -> core -> data -> (everything else)
```

- **After editing `.proto` (root `proto/`)**: run `pnpm build` (or `pnpm build:buf` inside `typings`, which runs `buf generate` at repo root) to regenerate `typings/src/gen/` + JSON schemas. Core validation fails against stale schemas.
- **After editing Ohm grammar `core/src/query-legacy/query.ohm`**: run `pnpm build:ohm` inside `core` (or `pnpm build`). A newer s-expr query system lives in `core/src/query/` (checked-in `query.ohm-bundle.js`); the maintained `.ohm` source is under `query-legacy/`.

## Per-package AGENTS.md

`packages/gi-agent/AGENTS.md` and `packages/gi-ml/AGENTS.md` hold detailed package-specific guidance (structure, CLI entrypoints, dependency boundaries). Read them when working in those packages. Note dir -> package name: `gi-agent` -> `@gi-tcg/agent`, `gi-ml` -> `@gi-tcg/ml`.

## Monorepo structure

Packages under `packages/*`, `@gi-tcg/` namespace. Key packages:

| Dir | Package | Role |
|-----|---------|------|
| `typings` | `@gi-tcg/typings` | Proto-generated types for cross-language RPC (`src/gen/` from root `proto/*.proto` via buf) |
| `core` | `@gi-tcg/core` | Game logic, state machine, mutation system, query engine; `Game` class; subpaths `@gi-tcg/core/builder` + `/builder/internal` |
| `data` | `@gi-tcg/data` | Official card definitions; **peerDepends** on `core` |
| `test` | `@gi-tcg/test` | JSX test DSL (`#test`, `#jsx` import aliases) |
| `config` | `@gi-tcg/config` | Build tooling: provides `gnx` bin + `bun` (disabled) shim, shared tsdown config |
| `utils` | `@gi-tcg/utils` | Shared utilities |
| `web-ui-core` / `standalone` / `web-client` / `deck-builder` | Solid.js UI; `pnpm dev` = vite |
| `server` | `@gi-tcg/server` | NestJS 11 + Fastify 5 + Prisma 7; `#prisma/*` -> `./generated/prisma/*.ts`; build = `pnpm prisma:generate && gnx scripts/build.ts`; dev = `gnx ./src/dev.ts` |
| `mcp` | `@gi-tcg/mcp` | MCP server for AI agent integration |
| `gi-agent` | `@gi-tcg/agent` | Multi-agent battle AI (LangGraph), self-play, benchmarks |
| `gi-ml` | `@gi-tcg/ml` | ML training infra (TS contracts + `python/` training) |
| `cbinding` | `@gi-tcg/cbinding` | C/C++ binding (rollup + cmake): `pnpm build` then `cmake -B build -GNinja && cmake --build build` |

Non-JS siblings (no `package.json`): `pybinding` (Python), `csbinding` / `csbinding-gen` (C#).

## Card data definitions (`@gi-tcg/data`)

- Characters: `src/characters/{element}/{name}.ts` (7 element dirs)
- Cards: `src/cards/{equipment|event|support}/*.ts`
- Builder DSL: `import { character, skill, summon, card, DamageType, SummonHandle } from "@gi-tcg/core/builder";`
- Regenerate from generators: `pnpm regenerate_data` (= `gnx ./scripts/generators/index.ts`).

## Code conventions

- **ESM only**, `"type": "module"` everywhere
- **No semicolons**
- **Strict TS**: `verbatimModuleSyntax`, `isolatedModules`
- **AGPLv3 header** on every source file (copy from any existing file)
- **Errors**: all custom errors extend `GiTcgError` (`core/src/error.ts`)
- **Catalog deps**: shared versions centralized in `pnpm-workspace.yaml` `catalog:`; reference as `"axios": "catalog:"` in deps.

## Gotchas

- **`bun` is intentionally disabled** (shim throws). Use `pnpm` + `gnx`; don't write `bun ...` in scripts or docs.
- **Patched deps** (`pnpm-workspace.yaml` `patchedDependencies`): `ohm-js@17.1.0`, `puppeteer-screen-recorder@3.0.6`. Do not upgrade without re-applying patches.
- **`@gi-tcg/data` peer-depends on `@gi-tcg/core`** (not a regular dep).
- **`@gi-tcg/core` subpath exports**: `@gi-tcg/core`, `@gi-tcg/core/builder`, `@gi-tcg/core/builder/internal`.
- **State is immutable**: mutate only through `Game` / `StateMutator`; never edit state objects directly.
- **Dev server**: `cd packages/standalone && pnpm dev` (or `packages/web-ui-core`).

## Architecture docs

`docs/development/` has detailed docs: `state.md`, `process.md`, `query.md`, `io.md`, `log.md` (may be outdated — trust code over docs). Root `CLAUDE.md` has a longer architecture writeup.
