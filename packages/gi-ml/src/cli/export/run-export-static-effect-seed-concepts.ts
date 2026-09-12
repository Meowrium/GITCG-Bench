import { parseArgs } from "node:util"
import { createStaticEffectSeedCollector } from "../../concept-discovery/index.js"
import { resolveCliPath, visitRankingDatasetQueryGroups, writeJsonFile } from "../../io/index.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/static-effect-seed-concepts.json" },
      "min-support": { type: "string", default: "2" },
      "max-evidence-refs": { type: "string", default: "8" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const collector = createStaticEffectSeedCollector({
    minSupport: Number(values["min-support"]),
    maxEvidenceRefsPerConcept: Number(values["max-evidence-refs"]),
  })
  const { dataset_id } = await visitRankingDatasetQueryGroups(resolveCliPath(inputPath), (group) => {
    collector.addQueryGroup(group)
  })
  const concepts = collector.build()

  const outputPath = resolveCliPath(values.output as string)
  await writeJsonFile(outputPath, {
    schema_version: "concepts.v1",
    source_kind: "static_effect_seed",
    dataset_id,
    concept_count: concepts.length,
    concepts,
  })

  console.log(`Static effect seed concepts written: ${outputPath}`)
  console.log(`dataset_id=${dataset_id}`)
  console.log(`concept_count=${concepts.length}`)
}

main().catch((error) => {
  console.error("run-export-static-effect-seed-concepts fatal error:", error)
  process.exit(1)
})
