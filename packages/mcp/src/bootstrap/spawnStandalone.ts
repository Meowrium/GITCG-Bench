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

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SpawnPlan, SpawnResult } from "./types"

export interface SpawnStandaloneOptions {
  repoRoot: string
  baseUrl: string
  logFilePath: string
}

export interface SpawnStandaloneProcessResult {
  child: ChildProcess
  spawnResult: SpawnResult
}

export function buildSpawnPlan(options: SpawnStandaloneOptions): SpawnPlan {
  if (process.platform === "win32") {
    const scriptPath = join(options.repoRoot, "scripts", "start-gi-standalone-oneclick.ps1")
    return {
      command: "pwsh.exe",
      args: [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-BaseUrl",
        options.baseUrl,
      ],
      cwd: options.repoRoot,
      logFilePath: options.logFilePath,
      scriptPath,
    }
  }

  const scriptPath = join(options.repoRoot, "scripts", "start-gi-standalone-oneclick.sh")
  return {
    command: "bash",
    args: [scriptPath, options.baseUrl],
    cwd: options.repoRoot,
    logFilePath: options.logFilePath,
    scriptPath,
  }
}

export function spawnStandalone(
  options: SpawnStandaloneOptions,
): SpawnStandaloneProcessResult {
  const plan = buildSpawnPlan(options)
  if (!existsSync(plan.scriptPath)) {
    throw new Error(`START_SCRIPT_NOT_FOUND:${plan.scriptPath}`)
  }

  mkdirSync(dirname(plan.logFilePath), { recursive: true })
  const logFd = openSync(plan.logFilePath, "a")
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    detached: false,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    windowsHide: true,
  })

  child.once("error", () => {
    // The bootstrapper handles the failure via polling + exit status.
  })

  return {
    child,
    spawnResult: {
      spawned: true,
      pid: child.pid ?? null,
      plan,
    },
  }
}
