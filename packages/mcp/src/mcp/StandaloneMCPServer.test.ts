// Copyright (C) 2025 Guyutongxue
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

import { describe, expect, test } from "bun:test"
import { StandaloneMCPServer } from "./StandaloneMCPServer"

describe("StandaloneMCPServer", () => {
  test("passes player identity and exposure mode to the tool handler", () => {
    const server = new StandaloneMCPServer(
      "http://localhost:3901",
      1,
      "fragmented-decision",
    )

    const handler = server.getToolHandler()

    expect(handler.getWho()).toBe(1)
    expect(handler.getToolExposureMode()).toBe("fragmented-decision")
  })
})
