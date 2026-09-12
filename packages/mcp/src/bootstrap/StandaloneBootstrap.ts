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

import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { probeStandalone } from "./probeStandalone"
import {
  spawnStandalone,
  type SpawnStandaloneOptions,
  type SpawnStandaloneProcessResult,
} from "./spawnStandalone"
import type {
  BootstrapErrorCode,
  BootstrapFailure,
  BootstrapOptions,
  BootstrapResult,
  BootstrapStage,
  ProbeResult,
} from "./types"

const MCP_HTTP_API_TOKEN_ENV = "MCP_HTTP_API_TOKEN"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class StandaloneBootstrap {
  private child: ChildProcess | null = null

  constructor(
    private readonly options: BootstrapOptions,
    private readonly repoRoot: string,
    private readonly dependencies: {
      probeStandalone?: typeof probeStandalone
      spawnStandalone?: (options: SpawnStandaloneOptions) => SpawnStandaloneProcessResult
      sleep?: (ms: number) => Promise<void>
    } = {},
  ) {}

  private log(message: string, extra: Record<string, unknown> = {}): void {
    if (!this.options.logBootstrap) {
      return
    }
    const details = Object.entries(extra)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")
    console.error(`[bootstrap] ${message}${details ? ` ${details}` : ""}`)
  }

  private getApiToken(): string | null {
    const raw = process.env[MCP_HTTP_API_TOKEN_ENV]
    if (typeof raw !== "string") {
      return null
    }
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  private isReady(probe: ProbeResult): boolean {
    return (
      probe.reachable &&
      probe.pingOk &&
      probe.statusOk &&
      probe.bridgeConnected &&
      probe.stale === false
    )
  }

  private buildFailure(
    stage: BootstrapStage,
    errorCode: BootstrapErrorCode,
    message: string,
    recoverHint: string,
    diagnostics: Record<string, unknown> = {},
  ): BootstrapFailure {
    return {
      ok: false,
      stage,
      error_code: errorCode,
      message,
      recover_hint: recoverHint,
      diagnostics: {
        base_url: this.options.baseUrl,
        token_present: !!this.getApiToken(),
        child_pid: this.child?.pid ?? null,
        ...diagnostics,
      },
    }
  }

  private buildBridgeNotConnectedFailure(probe: ProbeResult): BootstrapFailure {
    const commonDiagnostics = {
      probe,
      game_phase: probe.gamePhase,
      pending_method: probe.pendingMethod,
      has_pending_command: probe.hasPendingCommand,
      pending_command_id: probe.pendingCommandId,
      last_io_error: probe.lastIoError,
    }

    if (probe.lastIoError) {
      return this.buildFailure(
        "wait_ready",
        "STANDALONE_BRIDGE_NOT_CONNECTED",
        "Standalone HTTP API is up, but the bridge reported a recent IO error while syncing the game state.",
        "Open the standalone page, restart the current game if needed, and inspect last_io_error in the diagnostics for the failing phase.",
        commonDiagnostics,
      )
    }

    if (probe.gamePhase === "not_started") {
      return this.buildFailure(
        "wait_ready",
        "STANDALONE_BRIDGE_NOT_CONNECTED",
        "Standalone HTTP API is up, but no game session has started yet, so the bridge has not connected.",
        "Open the standalone page in the browser and click the start button to create a game session.",
        commonDiagnostics,
      )
    }

    return this.buildFailure(
      "wait_ready",
      "STANDALONE_BRIDGE_NOT_CONNECTED",
      "Standalone HTTP API is up, but the game bridge never connected.",
      "Open the standalone page and start a game, or verify the MCP-integrated standalone parent is active.",
      commonDiagnostics,
    )
  }

  private async waitUntilReady(): Promise<BootstrapResult> {
    const startedAt = Date.now()
    let lastProbe: ProbeResult | null = null
    let childExitCode: number | null = null

    if (this.child) {
      this.child.once("exit", (code) => {
        childExitCode = code
      })
    }

    while (Date.now() - startedAt < this.options.startupTimeoutMs) {
      await (this.dependencies.sleep ?? sleep)(this.options.startupPollMs)
      const probe = await (this.dependencies.probeStandalone ?? probeStandalone)({
        baseUrl: this.options.baseUrl,
        apiToken: this.getApiToken(),
      })
      lastProbe = probe
      this.log("stage=wait_ready", {
        reachable: probe.reachable,
        pingOk: probe.pingOk,
        bridgeConnected: probe.bridgeConnected,
        stale: probe.stale,
        gamePhase: probe.gamePhase,
        pendingMethod: probe.pendingMethod,
        hasPendingCommand: probe.hasPendingCommand,
        pendingCommandId: probe.pendingCommandId,
        lastIoError: probe.lastIoError,
        childExitCode,
      })
      if (this.isReady(probe)) {
        return {
          ok: true,
          source: "spawned",
          baseUrl: this.options.baseUrl,
          tokenPresent: true,
          childPid: this.child?.pid ?? null,
          probe,
        }
      }
      if (childExitCode !== null && !probe.reachable) {
        return this.buildFailure(
          "wait_ready",
          "START_SCRIPT_FAILED",
          "Standalone start script exited before the MCP HTTP API became reachable.",
          "Check the bootstrap log file and run scripts/start-gi-standalone-oneclick manually.",
          {
            child_exit_code: childExitCode,
            probe,
          },
        )
      }
    }

    if (lastProbe?.reachable && lastProbe.pingOk && lastProbe.statusOk && !lastProbe.bridgeConnected) {
      return this.buildBridgeNotConnectedFailure(lastProbe)
    }

    if (lastProbe?.reachable && !lastProbe.pingOk) {
      return this.buildFailure(
        "wait_ready",
        "STANDALONE_HTTP_NOT_READY",
        "Standalone host responded, but the MCP HTTP API never became ready.",
        "Inspect the standalone bootstrap log and verify the dev server started with MCP_HTTP_API_TOKEN configured.",
        {
          probe: lastProbe,
        },
      )
    }

    return this.buildFailure(
      "wait_ready",
      "STANDALONE_START_TIMEOUT",
      `Standalone did not become ready within ${this.options.startupTimeoutMs}ms.`,
      "Run scripts/start-gi-standalone-oneclick manually and verify the configured port is reachable.",
      {
        probe: lastProbe,
      },
    )
  }

  async run(): Promise<BootstrapResult> {
    const token = this.getApiToken()
    if (!token) {
      return this.buildFailure(
        "resolve_token",
        "MCP_HTTP_API_TOKEN_MISSING",
        "MCP_HTTP_API_TOKEN is missing in the current MCP process environment.",
        "Create the token first or launch via the one-click standalone script so both standalone and MCP share the same token.",
      )
    }

    this.log("stage=probe_existing", { baseUrl: this.options.baseUrl })
    const initialProbe = await (this.dependencies.probeStandalone ?? probeStandalone)({
      baseUrl: this.options.baseUrl,
      apiToken: token,
    })
    this.log("probe_result", {
      reachable: initialProbe.reachable,
      pingOk: initialProbe.pingOk,
      statusOk: initialProbe.statusOk,
      bridgeConnected: initialProbe.bridgeConnected,
      stale: initialProbe.stale,
      gamePhase: initialProbe.gamePhase,
      pendingMethod: initialProbe.pendingMethod,
      hasPendingCommand: initialProbe.hasPendingCommand,
      pendingCommandId: initialProbe.pendingCommandId,
      lastIoError: initialProbe.lastIoError,
      httpStatus: initialProbe.httpStatus,
      rawError: initialProbe.rawError,
    })

    if (this.isReady(initialProbe)) {
      return {
        ok: true,
        source: "existing",
        baseUrl: this.options.baseUrl,
        tokenPresent: true,
        childPid: null,
        probe: initialProbe,
      }
    }

    if (initialProbe.authFailed) {
      return this.buildFailure(
        "probe_existing",
        "STANDALONE_AUTH_FAILED",
        "Standalone HTTP API is reachable, but the MCP HTTP API token does not match.",
        "Close the existing standalone instance or make sure standalone and MCP use the same MCP_HTTP_API_TOKEN.",
        {
          probe: initialProbe,
        },
      )
    }

    if (this.options.startupMode !== "spawn") {
      return this.buildFailure(
        "probe_existing",
        "STANDALONE_UNREACHABLE",
        "Standalone is not ready, and automatic spawning is disabled.",
        "Start the standalone server manually or enable --ensure-standalone/--startup-mode spawn.",
        {
          probe: initialProbe,
        },
      )
    }

    try {
      const { child, spawnResult } = (this.dependencies.spawnStandalone ?? spawnStandalone)({
        repoRoot: this.repoRoot,
        baseUrl: this.options.baseUrl,
        logFilePath: join(this.repoRoot, "packages", "mcp", "log", "bootstrap-standalone.log"),
      })
      this.child = child
      this.log("stage=spawn_if_needed", {
        pid: spawnResult.pid,
        command: spawnResult.plan.command,
        args: spawnResult.plan.args,
        logFilePath: spawnResult.plan.logFilePath,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("START_SCRIPT_NOT_FOUND:")) {
        return this.buildFailure(
          "spawn_if_needed",
          "START_SCRIPT_NOT_FOUND",
          "Standalone start script was not found.",
          "Restore scripts/start-gi-standalone-oneclick for the current platform or start standalone manually.",
          {
            error: message,
          },
        )
      }
      return this.buildFailure(
        "spawn_if_needed",
        "START_SCRIPT_FAILED",
        "Failed to launch the standalone start script.",
        "Run scripts/start-gi-standalone-oneclick manually and inspect the bootstrap log for details.",
        {
          error: message,
        },
      )
    }

    return this.waitUntilReady()
  }

  attachProcessCleanup(): void {
    if (!this.options.shutdownChildOnExit || !this.child) {
      return
    }
    const child = this.child
    const terminate = () => {
      if (!child.killed) {
        child.kill()
      }
    }
    process.on("SIGINT", terminate)
    process.on("SIGTERM", terminate)
    process.on("exit", terminate)
  }
}
