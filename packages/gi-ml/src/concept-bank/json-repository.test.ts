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

import { expect, test } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { JsonConceptBankRepository } from "./json-repository.js"
import type { MlConceptBank } from "../contracts/index.js"

test("JsonConceptBankRepository saves, loads, and lists versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gi-ml-concept-bank-"))
  try {
    const repo = new JsonConceptBankRepository(root)
    const bank: MlConceptBank = {
      bank_version: "bank_v1",
      created_at: "2026-03-22T00:00:00.000Z",
      compatibility: null,
      concepts: [],
      validation_summary: null,
      deprecation_rules: [],
      metadata: null,
    }

    await repo.save(bank)

    const loaded = await repo.load("bank_v1")
    expect(loaded?.bank.bank_version).toBe("bank_v1")

    const versions = await repo.list_versions()
    expect(versions).toEqual(["bank_v1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
