import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
const d = getData(CURRENT_VERSION) as unknown as { characters: Map<number, unknown> }
for (const id of [1605, 1602, 1309, 1506, 2201, 2301, 2701, 1408, 1101, 1601]) {
  const c = d.characters.get(id) as Record<string, unknown> | undefined
  if (c) {
    const tags = (c as { tags?: unknown[] }).tags ?? []
    console.log(id, "tags:", JSON.stringify(tags))
  } else {
    console.log(id, "NOT FOUND")
  }
}
