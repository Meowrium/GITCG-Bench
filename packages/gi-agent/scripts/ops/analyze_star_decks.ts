/** Decode and characterize the 就是艺术派大星 deck collection.
 *  For each deck: get char ids + their elements, check vocab coverage. */
import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const data = getData(CURRENT_VERSION) as unknown as { characters: Map<number, Record<string, unknown>> }
const bundle = JSON.parse(readFileSync(resolve(process.argv[2]), "utf-8"))
const cV = new Set(Object.keys(bundle.vocabularies.character.id_to_index).map(Number))
const hV = new Set(Object.keys(bundle.vocabularies.hand_card.id_to_index).map(Number))

const ELEMENTS = ["cryo", "hydro", "pyro", "electro", "geo", "anemo", "dendro"] as const
function elementOf(id: number): string {
  const c = data.characters.get(id)
  if (!c) return "?"
  const tags = ((c.tags ?? []) as string[])
  for (const e of ELEMENTS) if (tags.includes(e)) return e
  return "other"
}

const DECKS: Array<readonly [string, string, string]> = [
  ["①",  "申鹤双风",            "ALBw5ykOAnBg8mIPBiAg85cPCTBw9JgPCUCA9b0PC1HQAskQDLGQC9YQDcFgDNkRDTAA"],
  ["②",  "藏锋贯月矢",          "AHBw6CkOAoBw8Y4PCBDg9JcPCUCA9ZgPC2DQ9r8QDCGgBsoQDWGQCtkQDbHQC+cQDuAA"],
  ["③",  "魔王武装王下鸭",      "ASCg8ikPAEDA9H0PB1DQ9oMPCGAw+ZcQCSFwAr0QCzHQA78QC2HwBskQDLGQC90QD+AA"],
  ["④",  "喵帕斯火刻",          "AUDA5BYOAdAw7U8PBBDw8ZAPCUAA9JcPCVBw9bwPC2DA9skPDNGQC9sQDrEwEeMRDjAA"],
  ["⑤",  "安如磐石",            "AnDg2xQOApCw6YgOCKCA6p0OCdDQ9LMPC0Aw9rgPC5GQArwQCyHAC78QC7HwDsYQDPAA"],
  ["⑥",  "九条激化",            "AcDw7C8PAwAQ8GsPBhCw8X0PByDQ8oMPCFEwA5cQCTFwBL8QC0HwBtQQDmGwE+sRDjAA"],
  ["⑦",  "王下藏锋魔术激化",    "AtAg8i8PASCg9H0PB0DQ9oMPCGEwA5cQCTFwBL8QC1HwBcgQDWEwBuUQDrFQC+0RDjAA"],
  ["⑧",  "宵宫烟花杂技",        "AbDQ5RUOAVDg5lEOBWAQ8ZcPCVBw9r0PDHCA98gQDBHQAs0QDSFAC9QQDbGQDtkRDQAA"],
  ["⑨",  "云来古剑识之律者",    "ArCw6QgOApDQ6ogOCKCA7Z0PCUDQ9LMPC2Aw9rgPC5GwArwQC6HAC78QDLFwDscQDfAA"],
  ["⑩",  "七七老八",            "AMDQvAgLAPCQx0QMBHBA2pEOCRAQ4ZwOCSDQ4p0PC0Aw9LMPC5GAArkQC7GQC7sQC/AA"],
  ["⑪",  "我们联合",            "ATAQ5DcOA0BA8YYPCBBg9ZcPCVBw9sgPDGGAAMkQDAGQAtIQDSEgCtkQDaGQDuMQDuAA"],
  ["⑫",  "雷狼先生",            "AlAA5gQPARCw8UAPBCAA8oYPCUBw9JcPC1Aw9bMQDCGAAsgQDKGQDskQDeGwEOURDgAA"],
  ["⑬",  "香草拿铁",            "AwAQ8A8PARAg8ZcPCUBw9L0PC1DQ9cIPDIAg+cgQDCGACskQDKGQC80QDLHQDtsQD+AA"],
  ["⑭",  "提八激化",            "AkAQ9DAPAlDw9YEPCWBw9pcPDICQ/MkPDsGwAusQDiHACuwQD6EAC/AQD7EQDvEQD+AA"],
  ["⑮",  "正E人迪卢克",         "ATAQ5BYOAUCw7U0OBNDQ8oYPCSBw9JcPDEAw9cMPDFCA9sgPDGHwA88QDTGwC+MQDrAA"],
  ["⑯",  "凝香钟巴",            "BDKi3BQQBJLC638QCaLS7IwRChKi844RCkLC9p8RC1LS97URDWMyB74SDbPCDdUSD+IC"],
  ["⑰",  "钟丘坎离",            "A5Cw6Q8OAqDA6owPCBDA8Z0PCUDQ9LMPC1Aw9bkPC2CQ/bwQC6HAC8cQDLFwDtoQDvAA"],
  ["⑱",  "一局四大",            "AEDA9CEPAlAA9VwPCWBw95cPDIAg+ckPDJGQAs0QDiFQCuUQDqFgC+YQDrHwDO8QD+AA"],
  ["⑲",  "种花儿女",            "AaAgygEMANCgzT0NA3DQ8YoPCBCg8pwPCSDA9rQPDNEgC8IQDLGADcgQDNGQDskQDPAA"],
  ["⑳",  "人均主C",             "ANCwzRUOABCg4VEOBSAQ4nkPCBAA8ZcPCSBw8rMPC2Aw98IPDHCQ/ckPDNGgDsoQDPAA"],
  ["㉑", "运筹帷幄",            "AdHR4jcPBBGx43MPCCFx8noQChFB9poQDFEx97QQDGFB+cMQDZEh/soRDaKRC84RDeEB"],
  ["㉒", "老芭凯亚",            "AZEx4gwPARGR40APBCHx8pIQChFR9JYQDGEx97QQDIFh/rkQDNGB/8MRDbIhD8gRDfEB"],
  ["㉓", "核爆威胁",            "A5Cw6jUOAqCg8WYPBxCg83oPCVBQ9pUPC2Aw+LQPDNAg/ckPDPCQ/8oQDKGgC+kQDvAA"],
  ["㉔", "优菈碎冰",            "AGBg3woNAPBA4EAOBAAA8ZcPCRBw9MIPDFAg9cgPDGCA9skPDICQ/c0QDLHQDNYQDeAA"],
  ["㉕", "双风颠勺",            "AWGx1yUPA3FR6GEPB4EB6ZIQChFR8pkQCiGB9LUQDUEh/sMQDdKRDMoRDeKhEMsRDvEB"],
  ["㉖", "炎龙之力",            "AUAw5DcPARDQ8U8PBCDw9ZcPCVBw9rMPC2Aw+MIPDNAg/ckQDJGQCs0QDrEwC+MRDgAA"],
  ["㉗", "三色之光",            "ARCg8QsPACAQ8j0PBTBg9JcPCVBw9bQPDGAg9sIPDJCQ+ckPDNCg/coQDKHQC80QD/AA"],
  ["㉘", "水镜皇女",            "ASCg8TUPAxBg8nEPByAQ85UPCVBQ9cIPDGAg9skPDICQ/coPDNGgCuEQDrEQDuIQDvAA"],
  ["㉙", "鸡你太美",            "AsDw8TwPARDw8msPCSBw88IPDDAg9MMPDFCQ9ckPDGCg9s0PDHDQ+esPDtGwCuwQDrAA"],
]

console.log("idx  name                       chars (element)                          chars-OOD  cards-OOD  uniq-cards")
console.log("-".repeat(110))
const oodChars = new Set<number>()
const oodCharsByElem: Record<string, Set<number>> = {}
let decodeFails = 0
const summary: Array<{idx: string; name: string; chars: number[]; elements: string[]; cardOOD: number; uniqCards: number; isInPool: boolean}> = []

for (const [idx, name, code] of DECKS) {
  let d: { characters: number[]; cards: number[] }
  try {
    d = DEFAULT_ASSETS_MANAGER.decode(code) as { characters: number[]; cards: number[] }
  } catch (e) {
    console.log(`${idx} ${name}: DECODE FAILED - ${(e as Error).message}`)
    decodeFails++; continue
  }
  const chars = d.characters
  const elems = chars.map(elementOf)
  const oods = chars.filter((id) => !cV.has(id))
  for (const id of oods) {
    oodChars.add(id)
    const e = elementOf(id)
    ;(oodCharsByElem[e] ??= new Set()).add(id)
  }
  const uniqCards = Array.from(new Set(d.cards))
  const cardOOD = uniqCards.filter((id) => !hV.has(id)).length
  const charsLabel = chars.map((id, i) => `${id}(${elems[i]})${cV.has(id) ? "" : "!"}`).join(" ")
  console.log(`${idx.padEnd(4)} ${name.padEnd(20)} ${charsLabel.padEnd(45)} ${oods.length}/${chars.length}        ${cardOOD}/${uniqCards.length}`)
  summary.push({idx, name, chars, elements: elems, cardOOD, uniqCards: uniqCards.length, isInPool: oods.length === 0 && cardOOD === 0})
}

console.log(`\n=== Decode failures: ${decodeFails}/${DECKS.length} ===`)

console.log(`\n=== Unique OOD characters across this collection: ${oodChars.size} ===`)
const elemBuckets: Record<string, number> = {}
for (const [e, set] of Object.entries(oodCharsByElem)) {
  elemBuckets[e] = set.size
  console.log(`  ${e.padEnd(10)} ${set.size} new chars: ${Array.from(set).sort((a, b) => a - b).join(", ")}`)
}

console.log(`\n=== Element gap closure if we adopt ALL these decks ===`)
console.log(`element       gen3 has    new chars in OOD set   if added: covers`)
for (const e of ELEMENTS) {
  const newCt = elemBuckets[e] ?? 0
  console.log(`${e.padEnd(12)} ${("[" + Array.from(cV).filter((id) => elementOf(id) === e).sort((a, b) => a - b).join(",") + "]").padEnd(20)} +${newCt}`)
}

console.log(`\n=== In-pool vs OOD this collection ===`)
const inPool = summary.filter(s => s.isInPool)
console.log(`Already in-pool (no OOD chars+cards): ${inPool.length}/${summary.length}`)
console.log(`OOD: ${summary.filter(s => !s.isInPool).length}/${summary.length}`)
