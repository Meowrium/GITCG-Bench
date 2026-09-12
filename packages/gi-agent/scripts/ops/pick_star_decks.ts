/** D6: Pick 4 decks from the 大星 collection that best cover gen3's element/char gaps.
 *  Strategy: pick decks that introduce the most NEW characters in element groups
 *  where gen3 has 0-1 covered, minimising card-OOD where possible. */
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
const elementOf = (id: number) => {
  const c = data.characters.get(id); if (!c) return "?"
  const tags = ((c.tags ?? []) as string[])
  for (const e of ELEMENTS) if (tags.includes(e)) return e
  return "other"
}

// Element-coverage scores: gaps get more weight.
const ELEM_GAP_WEIGHT: Record<string, number> = {
  dendro: 5.0,  // 0% covered, top priority
  anemo: 3.0,   // 6% covered
  geo: 1.5,     // 15% covered
  cryo: 1.0, hydro: 1.0, pyro: 0.8, electro: 0.8,
  other: 0.3,
}

// All 29 大星 decks
const STAR: Array<readonly [string, string, string]> = [
  ["①", "申鹤双风", "ALBw5ykOAnBg8mIPBiAg85cPCTBw9JgPCUCA9b0PC1HQAskQDLGQC9YQDcFgDNkRDTAA"],
  ["②", "藏锋贯月矢", "AHBw6CkOAoBw8Y4PCBDg9JcPCUCA9ZgPC2DQ9r8QDCGgBsoQDWGQCtkQDbHQC+cQDuAA"],
  ["③", "魔王武装王下鸭", "ASCg8ikPAEDA9H0PB1DQ9oMPCGAw+ZcQCSFwAr0QCzHQA78QC2HwBskQDLGQC90QD+AA"],
  ["④", "喵帕斯火刻", "AUDA5BYOAdAw7U8PBBDw8ZAPCUAA9JcPCVBw9bwPC2DA9skPDNGQC9sQDrEwEeMRDjAA"],
  ["⑤", "安如磐石", "AnDg2xQOApCw6YgOCKCA6p0OCdDQ9LMPC0Aw9rgPC5GQArwQCyHAC78QC7HwDsYQDPAA"],
  ["⑥", "九条激化", "AcDw7C8PAwAQ8GsPBhCw8X0PByDQ8oMPCFEwA5cQCTFwBL8QC0HwBtQQDmGwE+sRDjAA"],
  ["⑦", "王下藏锋魔术激化", "AtAg8i8PASCg9H0PB0DQ9oMPCGEwA5cQCTFwBL8QC1HwBcgQDWEwBuUQDrFQC+0RDjAA"],
  ["⑧", "宵宫烟花杂技", "AbDQ5RUOAVDg5lEOBWAQ8ZcPCVBw9r0PDHCA98gQDBHQAs0QDSFAC9QQDbGQDtkRDQAA"],
  ["⑨", "云来古剑识之律者", "ArCw6QgOApDQ6ogOCKCA7Z0PCUDQ9LMPC2Aw9rgPC5GwArwQC6HAC78QDLFwDscQDfAA"],
  ["⑩", "七七老八", "AMDQvAgLAPCQx0QMBHBA2pEOCRAQ4ZwOCSDQ4p0PC0Aw9LMPC5GAArkQC7GQC7sQC/AA"],
  ["⑪", "我们联合", "ATAQ5DcOA0BA8YYPCBBg9ZcPCVBw9sgPDGGAAMkQDAGQAtIQDSEgCtkQDaGQDuMQDuAA"],
  ["⑫", "雷狼先生", "AlAA5gQPARCw8UAPBCAA8oYPCUBw9JcPC1Aw9bMQDCGAAsgQDKGQDskQDeGwEOURDgAA"],
  ["⑬", "香草拿铁", "AwAQ8A8PARAg8ZcPCUBw9L0PC1DQ9cIPDIAg+cgQDCGACskQDKGQC80QDLHQDtsQD+AA"],
  ["⑭", "提八激化", "AkAQ9DAPAlDw9YEPCWBw9pcPDICQ/MkPDsGwAusQDiHACuwQD6EAC/AQD7EQDvEQD+AA"],
  ["⑮", "正E人迪卢克", "ATAQ5BYOAUCw7U0OBNDQ8oYPCSBw9JcPDEAw9cMPDFCA9sgPDGHwA88QDTGwC+MQDrAA"],
  ["⑯", "凝香钟巴", "BDKi3BQQBJLC638QCaLS7IwRChKi844RCkLC9p8RC1LS97URDWMyB74SDbPCDdUSD+IC"],
  ["⑰", "钟丘坎离", "A5Cw6Q8OAqDA6owPCBDA8Z0PCUDQ9LMPC1Aw9bkPC2CQ/bwQC6HAC8cQDLFwDtoQDvAA"],
  ["⑱", "一局四大", "AEDA9CEPAlAA9VwPCWBw95cPDIAg+ckPDJGQAs0QDiFQCuUQDqFgC+YQDrHwDO8QD+AA"],
  ["⑲", "种花儿女", "AaAgygEMANCgzT0NA3DQ8YoPCBCg8pwPCSDA9rQPDNEgC8IQDLGADcgQDNGQDskQDPAA"],
  ["⑳", "人均主C", "ANCwzRUOABCg4VEOBSAQ4nkPCBAA8ZcPCSBw8rMPC2Aw98IPDHCQ/ckPDNGgDsoQDPAA"],
  ["㉑", "运筹帷幄", "AdHR4jcPBBGx43MPCCFx8noQChFB9poQDFEx97QQDGFB+cMQDZEh/soRDaKRC84RDeEB"],
  ["㉒", "老芭凯亚", "AZEx4gwPARGR40APBCHx8pIQChFR9JYQDGEx97QQDIFh/rkQDNGB/8MRDbIhD8gRDfEB"],
  ["㉓", "核爆威胁", "A5Cw6jUOAqCg8WYPBxCg83oPCVBQ9pUPC2Aw+LQPDNAg/ckPDPCQ/8oQDKGgC+kQDvAA"],
  ["㉔", "优菈碎冰", "AGBg3woNAPBA4EAOBAAA8ZcPCRBw9MIPDFAg9cgPDGCA9skPDICQ/c0QDLHQDNYQDeAA"],
  ["㉕", "双风颠勺", "AWGx1yUPA3FR6GEPB4EB6ZIQChFR8pkQCiGB9LUQDUEh/sMQDdKRDMoRDeKhEMsRDvEB"],
  ["㉖", "炎龙之力", "AUAw5DcPARDQ8U8PBCDw9ZcPCVBw9rMPC2Aw+MIPDNAg/ckQDJGQCs0QDrEwC+MRDgAA"],
  ["㉗", "三色之光", "ARCg8QsPACAQ8j0PBTBg9JcPCVBw9bQPDGAg9sIPDJCQ+ckPDNCg/coQDKHQC80QD/AA"],
  ["㉘", "水镜皇女", "ASCg8TUPAxBg8nEPByAQ85UPCVBQ9cIPDGAg9skPDICQ/coPDNGgCuEQDrEQDuIQDvAA"],
  ["㉙", "鸡你太美", "AsDw8TwPARDw8msPCSBw88IPDDAg9MMPDFCQ9ckPDGCg9s0PDHDQ+esPDtGwCuwQDrAA"],
]

interface Eval {
  idx: string; name: string; code: string
  chars: number[]; elements: string[]
  newChars: number[]; newElems: string[]
  cardOOD: number; uniqCards: number
  score: number
}

const evals: Eval[] = []
for (const [idx, name, code] of STAR) {
  let d: { characters: number[]; cards: number[] }
  try { d = DEFAULT_ASSETS_MANAGER.decode(code) as { characters: number[]; cards: number[] } }
  catch { continue }
  const chars = d.characters
  const elements = chars.map(elementOf)
  const newChars = chars.filter((id) => !cV.has(id))
  const newElems = newChars.map(elementOf)
  const uniqCards = Array.from(new Set(d.cards))
  const cardOOD = uniqCards.filter((id) => !hV.has(id)).length
  // Score: sum of element-gap weights for each new char, minus card-OOD penalty
  let score = 0
  for (const e of newElems) score += ELEM_GAP_WEIGHT[e] ?? 0.5
  score -= cardOOD * 0.2  // mild penalty for card-OOD (model handles cards via mechanics too)
  evals.push({ idx, name, code, chars, elements, newChars, newElems, cardOOD, uniqCards: uniqCards.length, score })
}

evals.sort((a, b) => b.score - a.score)
console.log("=== All 29 大星 decks scored by element-gap closure value ===")
console.log("rank score idx name                  newChars/3  cardOOD/uniq  new-chars(elem)")
console.log("-".repeat(105))
for (let i = 0; i < evals.length; i++) {
  const e = evals[i]
  const nc = e.newChars.map((id, k) => `${id}(${e.newElems[k]})`).join(",")
  console.log(`${String(i + 1).padStart(3)}  ${e.score.toFixed(2).padStart(5)}  ${e.idx.padEnd(3)} ${e.name.padEnd(20)} ${String(e.newChars.length)}/3        ${e.cardOOD}/${e.uniqCards}        ${nc}`)
}

// Greedy selection: pick decks that maximise UNION of new chars
console.log("\n=== Greedy top-4 selection (maximise NEW unique chars covered, prefer rare elements) ===")
const picked: Eval[] = []
const covered = new Set<number>(cV)  // start with current vocab
for (let round = 0; round < 4; round++) {
  let best: Eval | null = null
  let bestGain = -1
  for (const e of evals) {
    if (picked.includes(e)) continue
    let gain = 0
    for (let k = 0; k < e.newChars.length; k++) {
      const id = e.newChars[k]
      if (covered.has(id)) continue
      gain += ELEM_GAP_WEIGHT[e.newElems[k]] ?? 0.5
    }
    gain -= e.cardOOD * 0.15
    if (gain > bestGain) { bestGain = gain; best = e }
  }
  if (!best) break
  picked.push(best)
  for (const id of best.newChars) covered.add(id)
  console.log(`pick #${round + 1}: ${best.idx} ${best.name} (gain=${bestGain.toFixed(2)}, adds ${best.newChars.filter(id => !cV.has(id)).map(id => id + "(" + elementOf(id) + ")").join(",")})`)
}

console.log("\n=== Final picked 4 ===")
const finalCovered = new Set(cV)
for (const p of picked) for (const id of p.newChars) finalCovered.add(id)
console.log(`Coverage growth: ${cV.size - 2} (gen3) -> ${finalCovered.size - 2} chars (+${finalCovered.size - cV.size})`)
for (const e of ELEMENTS) {
  const before = Array.from(cV).filter((id) => elementOf(id) === e).length
  const after = Array.from(finalCovered).filter((id) => elementOf(id) === e).length
  console.log(`  ${e.padEnd(8)} ${before} -> ${after} (+${after - before})`)
}

console.log("\n=== Final 12 decks for D6 (kpib 8 + 4 star picks) — share codes ===")
const KPIB: Array<[string, string]> = [
  ["水八",   "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA"],
  ["神宵",   "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA"],
  ["水凝",   "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA"],
  ["雷鹤",   "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"],
  ["雷狼",   "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA"],
  ["莫优",   "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA"],
  ["红牛",   "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"],
  ["水债",   "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA"],
]
const all = [...KPIB.map(([n, c]) => ({ name: n, code: c })), ...picked.map(p => ({ name: p.name, code: p.code }))]
console.log(JSON.stringify(all, null, 2))
