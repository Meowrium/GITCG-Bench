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
import { buildConceptBank } from "./build.js"
import type { MlConceptHypothesis } from "../contracts/index.js"

test("buildConceptBank filters by status and dedupes by freshest concept", () => {
  const concepts: MlConceptHypothesis[] = [
    {
      concept_id: "concept:a",
      name: "a-old",
      scope: "window",
      description: "old",
      evidence_refs: ["ref:1"],
      status: "draft",
      updated_at: "2026-03-20T00:00:00.000Z",
    },
    {
      concept_id: "concept:a",
      name: "a-new",
      scope: "window",
      description: "new",
      evidence_refs: ["ref:2"],
      status: "validated",
      updated_at: "2026-03-21T00:00:00.000Z",
    },
    {
      concept_id: "concept:b",
      name: "b-deprecated",
      scope: "state",
      description: "deprecated",
      evidence_refs: ["ref:3"],
      status: "deprecated",
      updated_at: "2026-03-21T00:00:00.000Z",
    },
  ]

  const bank = buildConceptBank(concepts, {
    bankVersion: "bank_v1",
    includeStatuses: ["validated"],
  })

  expect(bank.bank_version).toBe("bank_v1")
  expect(bank.concepts).toHaveLength(1)
  expect(bank.concepts[0]).toMatchObject({
    concept_id: "concept:a",
    name: "a-new",
    status: "validated",
  })
})
