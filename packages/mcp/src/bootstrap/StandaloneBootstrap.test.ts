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

import { beforeEach, describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { StandaloneBootstrap } from "./StandaloneBootstrap"
import type { ProbeResult } from "./types"

function createProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    reachable: true,
    pingOk: true,
    authFailed: false,
    tokenRequired: false,
    statusOk: true,
    bridgeConnected: true,
    stale: false,
    gamePhase: "action",
    pendingMethod: "action",
    hasPendingCommand: false,
    pendingCommandId: null,
    lastIoError: null,
    httpStatus: 200,
    rawError: null,
    ...overrides,
  }
}

function createFakeChild(pid = 1234): ChildProcess {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    pid,
    killed: false,
    once(event: string, handler: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
      return this
    },
    kill() {
      return true
    },
  } as unknown as ChildProcess
}

describe("StandaloneBootstrap", () => {
  beforeEach(() => {
    process.env.MCP_HTTP_API_TOKEN = "bootstrap-token"
  })

  test("reuses an existing ready standalone", async () => {
    const bootstrap = new StandaloneBootstrap(
      {
        baseUrl: "http://localhost:3901",
        startupMode: "spawn",
        startupTimeoutMs: 1000,
        startupPollMs: 1,
        shutdownChildOnExit: false,
        logBootstrap: false,
      },
      "D:/AI/GTCG/genius-invokation",
      {
        probeStandalone: async () => createProbe(),
        sleep: async () => {},
      },
    )

    const result = await bootstrap.run()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe("existing")
      expect(result.childPid).toBeNull()
    }
  })

  test("fails fast on token mismatch with existing standalone", async () => {
    const bootstrap = new StandaloneBootstrap(
      {
        baseUrl: "http://localhost:3901",
        startupMode: "spawn",
        startupTimeoutMs: 1000,
        startupPollMs: 1,
        shutdownChildOnExit: false,
        logBootstrap: false,
      },
      "D:/AI/GTCG/genius-invokation",
      {
        probeStandalone: async () => createProbe({
          pingOk: false,
          statusOk: false,
          authFailed: true,
        }),
        sleep: async () => {},
      },
    )

    const result = await bootstrap.run()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error_code).toBe("STANDALONE_AUTH_FAILED")
    }
  })

  test("spawns standalone and waits until bridge is ready", async () => {
    let probeCount = 0
    const bootstrap = new StandaloneBootstrap(
      {
        baseUrl: "http://localhost:3901",
        startupMode: "spawn",
        startupTimeoutMs: 1000,
        startupPollMs: 1,
        shutdownChildOnExit: false,
        logBootstrap: false,
      },
      "D:/AI/GTCG/genius-invokation",
      {
        probeStandalone: async () => {
          probeCount += 1
          if (probeCount === 1) {
            return createProbe({
              reachable: false,
              pingOk: false,
              statusOk: false,
              bridgeConnected: false,
              stale: null,
              httpStatus: null,
              gamePhase: null,
              pendingMethod: null,
            })
          }
          if (probeCount === 2) {
            return createProbe({
              bridgeConnected: false,
            })
          }
          return createProbe()
        },
        spawnStandalone: () => ({
          child: createFakeChild(),
          spawnResult: {
            spawned: true,
            pid: 1234,
            plan: {
              command: "pwsh.exe",
              args: [],
              cwd: "D:/AI/GTCG/genius-invokation",
              logFilePath: "D:/AI/GTCG/genius-invokation/packages/mcp/log/bootstrap-standalone.log",
              scriptPath: "D:/AI/GTCG/genius-invokation/scripts/start-gi-standalone-oneclick.ps1",
            },
          },
        }),
        sleep: async () => {},
      },
    )

    const result = await bootstrap.run()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe("spawned")
      expect(result.childPid).toBe(1234)
    }
  })

  test("reports not-started game separately when bridge never connects", async () => {
    const bootstrap = new StandaloneBootstrap(
      {
        baseUrl: "http://localhost:3901",
        startupMode: "spawn",
        startupTimeoutMs: 5,
        startupPollMs: 1,
        shutdownChildOnExit: false,
        logBootstrap: false,
      },
      "D:/AI/GTCG/genius-invokation",
      {
        probeStandalone: async () => createProbe({
          bridgeConnected: false,
          gamePhase: "not_started",
          pendingMethod: null,
        }),
        spawnStandalone: () => ({
          child: createFakeChild(),
          spawnResult: {
            spawned: true,
            pid: 1234,
            plan: {
              command: "pwsh.exe",
              args: [],
              cwd: "D:/AI/GTCG/genius-invokation",
              logFilePath: "D:/AI/GTCG/genius-invokation/packages/mcp/log/bootstrap-standalone.log",
              scriptPath: "D:/AI/GTCG/genius-invokation/scripts/start-gi-standalone-oneclick.ps1",
            },
          },
        }),
        sleep: async () => {},
      },
    )

    const result = await bootstrap.run()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error_code).toBe("STANDALONE_BRIDGE_NOT_CONNECTED")
      expect(result.message).toContain("no game session has started yet")
      expect(result.recover_hint).toContain("click the start button")
    }
  })

  test("surfaces last IO error in bridge diagnostics", async () => {
    const bootstrap = new StandaloneBootstrap(
      {
        baseUrl: "http://localhost:3901",
        startupMode: "spawn",
        startupTimeoutMs: 5,
        startupPollMs: 1,
        shutdownChildOnExit: false,
        logBootstrap: false,
      },
      "D:/AI/GTCG/genius-invokation",
      {
        probeStandalone: async () => createProbe({
          bridgeConnected: false,
          lastIoError: {
            who: 0,
            message: "AI player sync failed",
            at: Date.now(),
            phase: "action",
            pendingMethod: "action",
          },
        }),
        spawnStandalone: () => ({
          child: createFakeChild(),
          spawnResult: {
            spawned: true,
            pid: 1234,
            plan: {
              command: "pwsh.exe",
              args: [],
              cwd: "D:/AI/GTCG/genius-invokation",
              logFilePath: "D:/AI/GTCG/genius-invokation/packages/mcp/log/bootstrap-standalone.log",
              scriptPath: "D:/AI/GTCG/genius-invokation/scripts/start-gi-standalone-oneclick.ps1",
            },
          },
        }),
        sleep: async () => {},
      },
    )

    const result = await bootstrap.run()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error_code).toBe("STANDALONE_BRIDGE_NOT_CONNECTED")
      expect(result.message).toContain("recent IO error")
      expect(result.diagnostics.last_io_error).toBeTruthy()
    }
  })
})
