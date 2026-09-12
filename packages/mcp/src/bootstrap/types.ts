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

export type StartupMode = "external" | "attach" | "spawn"

export type BootstrapStage =
  | "resolve_token"
  | "probe_existing"
  | "spawn_if_needed"
  | "wait_ready"

export type BootstrapErrorCode =
  | "MCP_HTTP_API_TOKEN_MISSING"
  | "START_SCRIPT_NOT_FOUND"
  | "START_SCRIPT_FAILED"
  | "STANDALONE_UNREACHABLE"
  | "STANDALONE_AUTH_FAILED"
  | "STANDALONE_HTTP_NOT_READY"
  | "STANDALONE_BRIDGE_NOT_CONNECTED"
  | "STANDALONE_START_TIMEOUT"

export interface BootstrapOptions {
  baseUrl: string
  startupMode: StartupMode
  startupTimeoutMs: number
  startupPollMs: number
  shutdownChildOnExit: boolean
  logBootstrap: boolean
}

export interface ProbeLastIoError {
  who: number | null
  message: string
  at: number
  phase: string | null
  pendingMethod: string | null
}

export interface ProbeResult {
  reachable: boolean
  pingOk: boolean
  authFailed: boolean
  tokenRequired: boolean
  statusOk: boolean
  bridgeConnected: boolean
  stale: boolean | null
  gamePhase: string | null
  pendingMethod: string | null
  hasPendingCommand: boolean | null
  pendingCommandId: string | null
  lastIoError: ProbeLastIoError | null
  httpStatus: number | null
  rawError: string | null
}

export interface SpawnPlan {
  command: string
  args: string[]
  cwd: string
  logFilePath: string
  scriptPath: string
}

export interface SpawnResult {
  spawned: boolean
  pid: number | null
  plan: SpawnPlan
}

export interface BootstrapSuccess {
  ok: true
  source: "existing" | "spawned"
  baseUrl: string
  tokenPresent: boolean
  childPid: number | null
  probe: ProbeResult
}

export interface BootstrapFailure {
  ok: false
  stage: BootstrapStage
  error_code: BootstrapErrorCode
  message: string
  recover_hint: string
  diagnostics: Record<string, unknown>
}

export type BootstrapResult = BootstrapSuccess | BootstrapFailure
