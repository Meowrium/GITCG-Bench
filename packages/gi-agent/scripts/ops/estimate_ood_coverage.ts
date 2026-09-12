/** Cross-reference @gi-tcg/data engine entity tables with the gen3 encoder
 *  vocabularies to estimate which fraction of unseen content the encoder can
 *  represent (in-vocab) vs would silently UNK (information loss).
 */
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const data = getData(CURRENT_VERSION) as unknown as {
  characters: Map<number, unknown>
  entities: Map<number, unknown>
  attachments: Map<number, unknown>
}

const bundle = JSON.parse(readFileSync(resolve(process.argv[2]), "utf-8"))
const vocabs = bundle.vocabularies as Record<string, { size: number; id_to_index: Record<string, number> }>
const vSet = (kind: string) => new Set(Object.keys(vocabs[kind].id_to_index).map(Number))
const cV = vSet("character")
const sV = vSet("summon")
const supV = vSet("support")
const csV = vSet("combat_status")
const cstV = vSet("character_status")
const hV = vSet("hand_card")
const tV = vSet("action_target")

console.log("=== Engine ground truth (current data version) ===")
console.log(`characters:  ${data.characters.size}`)
console.log(`entities:    ${data.entities.size}`)
console.log(`attachments: ${data.attachments.size}`)

console.log("\n=== Gen3 vocabulary coverage of *every engine character* ===")
const allChars = Array.from(data.characters.keys()).sort((a, b) => a - b)
const inVocab = allChars.filter((id) => cV.has(id))
const ood = allChars.filter((id) => !cV.has(id))
console.log(`In-vocab:  ${inVocab.length}/${allChars.length} = ${(100 * inVocab.length / allChars.length).toFixed(1)}%`)
console.log(`OOD:       ${ood.length}/${allChars.length} = ${(100 * ood.length / allChars.length).toFixed(1)}%`)
console.log(`First few OOD char_ids: ${ood.slice(0, 30).join(", ")}`)

// Card-ish entities (3xxxxx ids are hand cards)
const cardIds = Array.from(data.entities.keys()).filter((id) => id >= 300000 && id < 400000)
const cardInVocab = cardIds.filter((id) => hV.has(id))
console.log("\n=== Gen3 vocabulary coverage of *every engine hand-card* ===")
console.log(`Hand cards in engine: ${cardIds.length}`)
console.log(`In gen3 vocab:        ${cardInVocab.length} = ${(100 * cardInVocab.length / cardIds.length).toFixed(1)}%`)

// Action-target is the union of skill IDs and card IDs the search has surfaced
// during training. Roughly = (skills of trained chars) + (cards of trained decks).
console.log("\n=== Action-target vocab (155 entries) ===")
const targets = Array.from(tV).sort((a, b) => a - b)
const skillTargets = targets.filter((id) => id >= 10000 && id < 20000)
const cardTargets = targets.filter((id) => id >= 300000 && id < 400000)
const otherTargets = targets.filter((id) => !skillTargets.includes(id) && !cardTargets.includes(id))
console.log(`  skills:     ${skillTargets.length}`)
console.log(`  cards:      ${cardTargets.length}`)
console.log(`  other (incl PAD/UNK + switchActive chars): ${otherTargets.length}`)

// Per-deck OOD: for each test deck, how many chars / unique cards UNK?
console.log("\n=== Per-deck OOD severity ===")
function coverage(deckCode: string, name: string) {
  const d = DEFAULT_ASSETS_MANAGER.decode(deckCode)
  const chars = d.characters
  const uniqCards = Array.from(new Set(d.cards))
  const oodChars = chars.filter((id) => !cV.has(id))
  const oodCards = uniqCards.filter((id) => !hV.has(id))
  const oodPct = 100 * (oodChars.length / chars.length + oodCards.length / uniqCards.length) / 2
  console.log(`${name.padEnd(28)} chars OOD=${oodChars.length}/${chars.length} cards OOD=${oodCards.length}/${uniqCards.length} (${oodChars.length ? "chars=" + oodChars.join(",") + " " : ""}${oodCards.length ? "cards=" + oodCards.slice(0, 5).join(",") + (oodCards.length > 5 ? "..." : "") : ""})`)
  return { oodChars, oodCards, oodPct }
}

// Pool: kpib (8) + D3 control + 6 hand-picked OOD decks made up of unseen chars/cards
console.log("\n--- in-pool kpib (should all be 100% covered) ---")
const KPIB: Array<readonly [string, string]> = [
  ["水八",   "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA"],
  ["神宵",   "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA"],
  ["水凝",   "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA"],
  ["雷鹤",   "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"],
  ["雷狼",   "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA"],
  ["莫优",   "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA"],
  ["红牛",   "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"],
  ["水债",   "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA"],
]
for (const [n, c] of KPIB) coverage(c, n)

console.log("\n--- D3/D4 control decks (different but characters overlap with kpib?) ---")
for (const [n, c] of [
  ["pyroke (D3)",  "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"] as const,
  ["cryohe (D3)",  "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"] as const,
]) coverage(c, n)

console.log("\n=== Bottom line: how many engine chars total is gen3 missing? ===")
console.log(`Engine total chars: ${allChars.length}, gen3 vocab covers ${inVocab.length} = ${(100 * inVocab.length / allChars.length).toFixed(1)}%`)
console.log(`Engine total cards: ${cardIds.length}, gen3 vocab covers ${cardInVocab.length} = ${(100 * cardInVocab.length / cardIds.length).toFixed(1)}%`)
