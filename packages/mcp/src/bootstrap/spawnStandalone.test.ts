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
import { buildSpawnPlan } from "./spawnStandalone"

describe("buildSpawnPlan", () => {
  test("uses platform-specific one-click script", () => {
    const plan = buildSpawnPlan({
      repoRoot: "D:/AI/GTCG/genius-invokation",
      baseUrl: "http://localhost:3901",
      logFilePath: "D:/AI/GTCG/genius-invokation/packages/mcp/log/bootstrap-standalone.log",
    })

    if (process.platform === "win32") {
      expect(plan.command).toBe("pwsh.exe")
      expect(plan.scriptPath.endsWith("start-gi-standalone-oneclick.ps1")).toBe(true)
    } else {
      expect(plan.command).toBe("bash")
      expect(plan.scriptPath.endsWith("start-gi-standalone-oneclick.sh")).toBe(true)
    }
  })
})
