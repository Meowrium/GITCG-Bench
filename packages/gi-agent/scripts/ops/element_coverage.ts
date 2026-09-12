/** Estimate per-element coverage: for each element bucket of characters
 *  (1<E>NN where E=1..7), how many are in vocab? Tells us which elements
 *  the encoder can represent well vs which would silently UNK.
 */
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const data = getData(CURRENT_VERSION) as unknown as { characters: Map<number, unknown> }
const bundle = JSON.parse(readFileSync(resolve(process.argv[2]), "utf-8"))
const cV = new Set(Object.keys(bundle.vocabularies.character.id_to_index).map(Number))

const elem: Record<number, string> = { 1: "cryo", 2: "hydro", 3: "pyro", 4: "electro", 5: "geo", 6: "anemo", 7: "dendro" }

console.log("=== Per-element character coverage (gen3 vocab vs engine) ===")
console.log("element     engine   in_vocab   pct   in-vocab ids")
for (let e = 1; e <= 7; e++) {
  const all = Array.from(data.characters.keys()).filter((id) => Math.floor((id % 1000) / 100) === e)
  const inV = all.filter((id) => cV.has(id))
  console.log(`${elem[e].padEnd(10)}  ${String(all.length).padEnd(8)} ${String(inV.length).padEnd(10)} ${(100 * inV.length / Math.max(1, all.length)).toFixed(1).padStart(5)}%  [${inV.sort((a, b) => a - b).join(",")}]`)
}

// Side note: list all in-vocab chars by element so we know what gen3 actually knows
console.log("\n=== gen3 in-vocab chars (sorted) ===")
const all = Array.from(cV).sort((a, b) => a - b).filter((id) => id >= 1000 && id < 2000)
console.log(all.join(", "))
