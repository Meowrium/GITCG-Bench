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

import type { ProbeResult } from "./types"

const MCP_HTTP_API_TOKEN_HEADER = "x-gi-tcg-mcp-token"

export interface ProbeStandaloneOptions {
  baseUrl: string
  apiToken?: string | null
  timeoutMs?: number
}

function buildHeaders(apiToken?: string | null): Record<string, string> {
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    return {}
  }
  return {
    [MCP_HTTP_API_TOKEN_HEADER]: apiToken.trim(),
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return null
  }
}

function createUnreachableResult(error: unknown): ProbeResult {
  return {
    reachable: false,
    pingOk: false,
    authFailed: false,
    tokenRequired: false,
    statusOk: false,
    bridgeConnected: false,
    stale: null,
    gamePhase: null,
    pendingMethod: null,
    hasPendingCommand: null,
    pendingCommandId: null,
    lastIoError: null,
    httpStatus: null,
    rawError: error instanceof Error ? error.message : String(error),
  }
}

export async function probeStandalone(
  options: ProbeStandaloneOptions,
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  const headers = buildHeaders(options.apiToken)

  try {
    const pingResponse = await fetch(`${options.baseUrl}/api/mcp/ping`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const pingBody = await safeJson(pingResponse)

    if (pingResponse.status === 403) {
      return {
        reachable: true,
        pingOk: false,
        authFailed: true,
        tokenRequired: false,
        statusOk: false,
        bridgeConnected: false,
        stale: null,
        gamePhase: null,
        pendingMethod: null,
        hasPendingCommand: null,
        pendingCommandId: null,
        lastIoError: null,
        httpStatus: pingResponse.status,
        rawError:
          typeof pingBody?.errorCode === "string"
            ? pingBody.errorCode
            : typeof pingBody?.error === "string"
              ? pingBody.error
              : pingResponse.statusText,
      }
    }

    if (pingResponse.status === 503 && pingBody?.errorCode === "MCP_HTTP_API_TOKEN_REQUIRED") {
      return {
        reachable: true,
        pingOk: false,
        authFailed: false,
        tokenRequired: true,
        statusOk: false,
        bridgeConnected: false,
        stale: null,
        gamePhase: null,
        pendingMethod: null,
        hasPendingCommand: null,
        pendingCommandId: null,
        lastIoError: null,
        httpStatus: pingResponse.status,
        rawError:
          typeof pingBody?.errorCode === "string"
            ? pingBody.errorCode
            : typeof pingBody?.error === "string"
              ? pingBody.error
              : pingResponse.statusText,
      }
    }

    if (!pingResponse.ok) {
      return {
        reachable: true,
        pingOk: false,
        authFailed: false,
        tokenRequired: false,
        statusOk: false,
        bridgeConnected: false,
        stale: null,
        gamePhase: null,
        pendingMethod: null,
        hasPendingCommand: null,
        pendingCommandId: null,
        lastIoError: null,
        httpStatus: pingResponse.status,
        rawError:
          typeof pingBody?.error === "string"
            ? pingBody.error
            : pingResponse.statusText,
      }
    }

    const statusResponse = await fetch(`${options.baseUrl}/api/mcp/status`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const statusBody = await safeJson(statusResponse)

    if (!statusResponse.ok) {
      return {
        reachable: true,
        pingOk: true,
        authFailed: statusResponse.status === 403,
        tokenRequired:
          statusResponse.status === 503 && statusBody?.errorCode === "MCP_HTTP_API_TOKEN_REQUIRED",
        statusOk: false,
        bridgeConnected: false,
        stale: null,
        gamePhase: null,
        pendingMethod: null,
        hasPendingCommand: null,
        pendingCommandId: null,
        lastIoError: null,
        httpStatus: statusResponse.status,
        rawError:
          typeof statusBody?.error === "string"
            ? statusBody.error
            : statusResponse.statusText,
      }
    }

    const lastIoError =
      typeof statusBody?.lastIoError === "object" && statusBody.lastIoError !== null
        ? statusBody.lastIoError as Record<string, unknown>
        : null

    return {
      reachable: true,
      pingOk: true,
      authFailed: false,
      tokenRequired: false,
      statusOk: true,
      bridgeConnected: statusBody?.connected === true,
      stale: typeof statusBody?.stale === "boolean" ? statusBody.stale : null,
      gamePhase: typeof statusBody?.gamePhase === "string" ? statusBody.gamePhase : null,
      pendingMethod:
        typeof statusBody?.pendingMethod === "string" ? statusBody.pendingMethod : null,
      hasPendingCommand:
        typeof statusBody?.hasPendingCommand === "boolean"
          ? statusBody.hasPendingCommand
          : null,
      pendingCommandId:
        typeof statusBody?.pendingCommandId === "string"
          ? statusBody.pendingCommandId
          : null,
      lastIoError: lastIoError
        ? {
            who: typeof lastIoError.who === "number" ? lastIoError.who : null,
            message:
              typeof lastIoError.message === "string"
                ? lastIoError.message
                : "Unknown IoError",
            at: typeof lastIoError.at === "number" ? lastIoError.at : 0,
            phase: typeof lastIoError.phase === "string" ? lastIoError.phase : null,
            pendingMethod:
              typeof lastIoError.pendingMethod === "string"
                ? lastIoError.pendingMethod
                : null,
          }
        : null,
      httpStatus: statusResponse.status,
      rawError: null,
    }
  } catch (error) {
    return createUnreachableResult(error)
  }
}
