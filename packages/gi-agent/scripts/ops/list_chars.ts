import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
const d = getData(CURRENT_VERSION) as unknown as Record<string, unknown>
console.log("keys:", Object.keys(d))
console.log("characters type:", typeof d.characters, Array.isArray(d.characters) ? d.characters.length : "?")
if (d.characters && (d.characters as Iterable<unknown>)) {
  const arr = d.characters as Map<number, unknown> | unknown[]
  if (arr instanceof Map) {
    console.log("characters Map size:", arr.size)
    console.log("first 30 char ids:", Array.from(arr.keys()).sort((a, b) => a - b).slice(0, 30).join(","))
    console.log("last 30 char ids:", Array.from(arr.keys()).sort((a, b) => a - b).slice(-30).join(","))
  } else if (Array.isArray(arr)) {
    console.log("characters array length:", arr.length)
  }
}
