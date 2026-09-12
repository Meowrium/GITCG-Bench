/** Correct per-element character coverage using engine `tags` (not def_id heuristic). */
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const data = getData(CURRENT_VERSION) as unknown as { characters: Map<number, Record<string, unknown>> }
const bundle = JSON.parse(readFileSync(resolve(process.argv[2]), "utf-8"))
const cV = new Set(Object.keys(bundle.vocabularies.character.id_to_index).map(Number))

const ELEMENTS = ["cryo", "hydro", "pyro", "electro", "geo", "anemo", "dendro"] as const

function elementOf(id: number, c: Record<string, unknown>): string {
  const tags = ((c.tags ?? []) as string[])
  for (const e of ELEMENTS) if (tags.includes(e)) return e
  return "other"
}

const byElem: Record<string, { all: number[]; inVocab: number[] }> = {}
for (const e of ELEMENTS) byElem[e] = { all: [], inVocab: [] }
byElem["other"] = { all: [], inVocab: [] }

for (const [id, c] of data.characters) {
  const e = elementOf(id, c)
  byElem[e].all.push(id)
  if (cV.has(id)) byElem[e].inVocab.push(id)
}

console.log("=== Per-element character coverage (using engine tags, FIXED) ===")
console.log("element     engine   in_vocab   pct   in-vocab ids")
for (const e of [...ELEMENTS, "other"]) {
  const { all, inVocab } = byElem[e]
  const pct = all.length > 0 ? (100 * inVocab.length / all.length).toFixed(1) : "0.0"
  console.log(`${e.padEnd(10)}  ${String(all.length).padEnd(8)} ${String(inVocab.length).padEnd(10)} ${pct.padStart(5)}%  [${inVocab.sort((a, b) => a - b).join(",")}]`)
}

// Per-deck OOD with correct elements
import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
const KPIB: ReadonlyArray<readonly [string, string]> = [
  ["水八",   "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA"],
  ["神宵",   "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA"],
  ["水凝",   "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA"],
  ["雷鹤",   "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"],
  ["雷狼",   "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA"],
  ["莫优",   "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA"],
  ["红牛",   "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"],
  ["水债",   "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA"],
]

console.log("\n=== kpib deck character elements (real, from engine tags) ===")
for (const [name, code] of KPIB) {
  const d = DEFAULT_ASSETS_MANAGER.decode(code)
  const labels = d.characters.map((id) => {
    const c = data.characters.get(id)
    const e = c ? elementOf(id, c) : "?"
    return `${id}(${e})`
  })
  console.log(`${name.padEnd(8)} ${labels.join(", ")}`)
}
