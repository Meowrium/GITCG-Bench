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

import { afterEach, describe, expect, test } from "bun:test"
import { probeStandalone } from "./probeStandalone"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("probeStandalone", () => {
  test("classifies invalid token response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        error: "Forbidden: invalid MCP HTTP API token",
        errorCode: "MCP_HTTP_API_TOKEN_INVALID",
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    const result = await probeStandalone({
      baseUrl: "http://localhost:3901",
      apiToken: "bad-token",
    })

    expect(result.reachable).toBe(true)
    expect(result.authFailed).toBe(true)
    expect(result.httpStatus).toBe(403)
  })

  test("classifies missing token response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        error: "Protected MCP HTTP API is disabled until MCP_HTTP_API_TOKEN is configured",
        errorCode: "MCP_HTTP_API_TOKEN_REQUIRED",
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    const result = await probeStandalone({
      baseUrl: "http://localhost:3901",
    })

    expect(result.reachable).toBe(true)
    expect(result.tokenRequired).toBe(true)
    expect(result.httpStatus).toBe(503)
  })

  test("marks bridge ready only after status succeeds", async () => {
    let callCount = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      callCount += 1
      const url = String(input)
      if (url.endsWith("/api/mcp/ping")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({
        connected: true,
        stale: false,
        gamePhase: "action",
        pendingMethod: "action",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    const result = await probeStandalone({
      baseUrl: "http://localhost:3901",
      apiToken: "token",
    })

    expect(callCount).toBe(2)
    expect(result.reachable).toBe(true)
    expect(result.pingOk).toBe(true)
    expect(result.statusOk).toBe(true)
    expect(result.bridgeConnected).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.gamePhase).toBe("action")
  })

  test("returns unreachable on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof fetch

    const result = await probeStandalone({
      baseUrl: "http://localhost:3901",
    })

    expect(result.reachable).toBe(false)
    expect(result.rawError).toContain("ECONNREFUSED")
  })
})
