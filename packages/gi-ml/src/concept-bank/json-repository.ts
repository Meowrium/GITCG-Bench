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

import { readdir } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { MlConceptBank } from "../contracts/index.js"
import { readJsonFile, writeJsonFile } from "../io/index.js"
import type { ConceptBankLoadResult, ConceptBankRepository } from "./types.js"

export class JsonConceptBankRepository implements ConceptBankRepository {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  async load(version: string): Promise<ConceptBankLoadResult | null> {
    const sourceRef = this.pathForVersion(version)
    try {
      const bank = await readJsonFile<MlConceptBank>(sourceRef)
      return {
        bank,
        source_ref: sourceRef,
      }
    } catch {
      return null
    }
  }

  async save(bank: MlConceptBank): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    await writeJsonFile(this.pathForVersion(bank.bank_version), bank)
  }

  async list_versions(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.replace(/\.json$/i, ""))
        .sort()
    } catch {
      return []
    }
  }

  private pathForVersion(version: string): string {
    return join(this.rootDir, `${version}.json`)
  }
}
