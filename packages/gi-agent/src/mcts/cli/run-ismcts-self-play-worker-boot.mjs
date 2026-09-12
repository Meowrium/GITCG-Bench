// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D3 P0 — worker bootstrap.
 *
 * `worker_threads` spawned from a tsx-loaded parent do NOT automatically
 * inherit the tsx loader registration. tsx only auto-registers on
 * `isMainThread === true` (see `tsx/dist/esm/index.mjs` last line).
 *
 * This `.mjs` shim:
 *   1. polyfills the `__name` / `__esm` esbuild helpers (matches
 *      `packages/config/src/preload/node.js`),
 *   2. explicitly registers tsx's ESM loader hooks via `module.register()`
 *      using the package path resolved through `@gi-tcg/config` (the
 *      workspace package that already depends on tsx for the gnx wrapper),
 *   3. dynamically imports the real `.ts` worker entry.
 *
 * Without this shim, the worker fails with `ERR_MODULE_NOT_FOUND` on the
 * first relative `.js → .ts` source-tree import (e.g. `../../db/data-lake.js`).
 */

import { register } from "node:module";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.__name = (fn, name) => {
  Object.defineProperty(fn, "name", { value: name });
  return fn;
};
globalThis.__esm = (fn, mod) => () => (fn(mod), mod.exports);

// Locate the tsx package. It is hoisted to the workspace root via pnpm.
// `createRequire(import.meta.url)` walks up node_modules from this file;
// `require.resolve("tsx")` then returns the loader entry (`dist/loader.mjs`).
// We pass it directly to Node's `module.register()` to install the loader.
// Note: tsx requires non-null initialize `data` (it asserts on it to
// distinguish `--loader` from `--import` usage); pass an empty object.
const requireFromHere = createRequire(import.meta.url);
const tsxLoaderPath = requireFromHere.resolve("tsx");
register(pathToFileURL(tsxLoaderPath).href, {
  parentURL: pathToFileURL("./").href,
  data: {},
});

await import("./run-ismcts-self-play-worker.ts");
