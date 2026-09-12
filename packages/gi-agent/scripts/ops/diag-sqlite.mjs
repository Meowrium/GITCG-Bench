// V30 diagnostics — replicate the require() path that DataLake uses,
// under gnx's environment, and report exactly where it fails.

console.log("--- runtime ---")
console.log("process.versions:", JSON.stringify(process.versions))
console.log("typeof Bun:", typeof globalThis.Bun)
console.log("NODE_PATH:", process.env.NODE_PATH ?? "(unset)")
console.log("cwd:", process.cwd())

console.log("\n--- direct require ---")
try {
  const mod = await import("better-sqlite3")
  const Database = mod.default ?? mod
  const db = new Database(":memory:")
  db.exec("CREATE TABLE t (x)")
  console.log("import('better-sqlite3') OK")
  db.close()
} catch (err) {
  console.log("import('better-sqlite3') FAIL:", err instanceof Error ? err.message.split("\n")[0] : String(err))
}

console.log("\n--- createRequire from data-lake ---")
import { createRequire } from "node:module"
const req = createRequire(import.meta.url)
try {
  const Database = req("better-sqlite3")
  const db = new Database(":memory:")
  db.exec("CREATE TABLE t (x)")
  console.log("createRequire('better-sqlite3') OK")
  db.close()
} catch (err) {
  console.log("createRequire('better-sqlite3') FAIL:", err instanceof Error ? err.message.split("\n")[0] : String(err))
}

console.log("\n--- locate binary ---")
import { existsSync } from "node:fs"
const candidates = [
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/better-sqlite3/build/Debug/better_sqlite3.node",
  "../../node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "../../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
]
for (const c of candidates) {
  console.log(`  ${existsSync(c) ? "FOUND " : "      "} ${c}`)
}
