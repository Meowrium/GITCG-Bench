import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
const KPIB = [
  ["水八",   "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA"],
  ["神宵",   "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA"],
  ["水凝",   "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA"],
  ["雷鹤",   "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"],
  ["雷狼",   "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA"],
  ["莫优",   "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA"],
  ["红牛",   "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"],
  ["水债",   "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA"],
] as const
const elem: Record<number, string> = { 1: "cryo", 2: "hydro", 3: "pyro", 4: "electro", 5: "geo", 6: "anemo", 7: "dendro" }
for (const [name, code] of KPIB) {
  const d = DEFAULT_ASSETS_MANAGER.decode(code)
  const labels = d.characters.map((id) => {
    const s = id.toString()
    const e = s.length === 4 ? parseInt(s[1], 10) : -1
    return `${id}(${elem[e] ?? "?"})`
  })
  console.log(`${name.padEnd(8)} chars: ${labels.join(", ")}`)
}
