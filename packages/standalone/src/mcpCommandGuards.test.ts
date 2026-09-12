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

import { expect, test } from "bun:test";
import { buildActionCandidateSignature } from "../../mcp/src/candidateSignature";
import { validatePendingActionPayload } from "./mcpCommandGuards";

test("validatePendingActionPayload rejects stale action index before core injection", () => {
  const livePendingRequest = {
    $case: "action",
    value: {
      action: [
        {
          validity: 1,
          requiredCost: [],
          autoSelectedDice: [],
          action: { $case: "playCard", value: { cardDefinitionId: 1001 } },
        },
        {
          validity: 0,
          requiredCost: [],
          autoSelectedDice: [],
          action: { $case: "declareEnd", value: {} },
        },
      ],
    },
  };

  const stalePayload = {
    chosenActionIndex: 0,
    usedDice: [],
    candidateId: "cand_1",
    candidateSignature: buildActionCandidateSignature({
      validity: 0,
      requiredCost: [],
      autoSelectedDice: [],
      action: { $case: "playCard", value: { cardDefinitionId: 1001 } },
    }),
  };

  expect(validatePendingActionPayload(livePendingRequest, stalePayload)).toEqual({
    ok: false,
    reason: "Chosen action is stale or invalid",
  });
});
