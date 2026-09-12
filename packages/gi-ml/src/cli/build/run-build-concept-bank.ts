// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { parseArgs } from "node:util"
import { resolve } from "node:path"
import type { MlConceptBank, MlConceptHypothesis, MlConceptStatus } from "../../contracts/index.js"
import { buildConceptBank } from "../../concept-bank/build.js"
import { JsonConceptBankRepository } from "../../concept-bank/json-repository.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"

interface ConceptExportLike {
  concepts: MlConceptHypothesis[]
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "" },
      "output-dir": { type: "string", default: "" },
      "bank-version": { type: "string", default: "" },
      status: { type: "string", default: "all" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const bankVersion = (values["bank-version"] as string) || defaultBankVersion()
  const concepts = await loadConcepts(resolve(inputPath))
  const includeStatuses = parseStatusFilter(values.status as string)
  const bank = buildConceptBank(concepts, {
    bankVersion,
    includeStatuses,
    metadata: {
      source_input: resolve(inputPath),
      source_status_filter: values.status as string,
    },
  })

  const outputDir = values["output-dir"] as string
  if (outputDir) {
    const repo = new JsonConceptBankRepository(resolve(outputDir))
    await repo.save(bank)
    console.log(`Concept bank saved in repository: ${resolve(outputDir)}`)
  }

  const outputPath = values.output as string
  if (outputPath) {
    await writeJsonFile(outputPath, bank)
    console.log(`Concept bank written: ${resolve(outputPath)}`)
  }

  if (!outputDir && !outputPath) {
    const fallbackPath = resolve(`./output/gi-ml/concept-banks/${bank.bank_version}.json`)
    await writeJsonFile(fallbackPath, bank)
    console.log(`Concept bank written: ${fallbackPath}`)
  }

  console.log(`bank_version=${bank.bank_version}`)
  console.log(`concepts=${bank.concepts.length}`)
}

async function loadConcepts(path: string): Promise<MlConceptHypothesis[]> {
  const payload = await readJsonFile<MlConceptHypothesis[] | ConceptExportLike | MlConceptBank>(path)
  if (Array.isArray(payload)) {
    return payload
  }
  if (Array.isArray((payload as ConceptExportLike).concepts)) {
    return (payload as ConceptExportLike).concepts
  }
  if (Array.isArray((payload as MlConceptBank).concepts)) {
    return (payload as MlConceptBank).concepts
  }
  throw new Error("input JSON does not contain a concepts array")
}

function parseStatusFilter(value: string): MlConceptStatus[] | undefined {
  if (!value || value === "all") {
    return undefined
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is MlConceptStatus =>
      item === "draft" || item === "validated" || item === "deprecated")
}

function defaultBankVersion(): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(now.getUTCDate()).padStart(2, "0")
  const hh = String(now.getUTCHours()).padStart(2, "0")
  const mi = String(now.getUTCMinutes()).padStart(2, "0")
  return `bank_${yyyy}${mm}${dd}_${hh}${mi}`
}

main().catch((error) => {
  console.error("run-build-concept-bank fatal error:", error)
  process.exit(1)
})
