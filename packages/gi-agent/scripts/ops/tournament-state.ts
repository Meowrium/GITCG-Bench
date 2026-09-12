// Copyright (C) 2026 Piovium Labs
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

/**
 * tournament-state — 编排状态（outRoot/state.json）读写（impl-spec-1 §3）。
 * state.json 是续跑真值来源：子命令启动时读，完成一批置位一批；
 * 写盘原子化（临时文件 + rename，失败兜底直写）。
 *
 * key 约定（model-tournament.ts 各子命令）：
 *   author|<model>|<env>|single|<di>-vs-<dj>
 *   author|<model>|<env>|general|<di>
 *   author|<model>|<env>|manifest|<di>
 *   evolve|<model>|<env>|<di>|r<r>
 *   battle|r<r>|<env>|<pairDir>|<di>-vs-<dj>
 *   export|r<r>|<env>（导出按全量重建幂等，不置位；预留）
 *   analyze|<view>
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface TournamentFailure {
  /** 失败单元 key（同上约定） */
  key: string
  /** 所属子命令（author/evolve/battle/…） */
  subcommand: string
  /** 错误摘要（截断；不含凭据） */
  error: string
  at: string
}

export interface TournamentState {
  version: 1
  configPath: string
  done: Record<string, true>
  failures: TournamentFailure[]
}

/** 载入 state.json；不存在或损坏（打印警告）→ 新建空状态 */
export async function loadState(path: string, configPath: string): Promise<TournamentState> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<TournamentState>
    if (raw?.version === 1 && typeof raw.done === "object" && raw.done !== null) {
      return {
        version: 1,
        configPath: typeof raw.configPath === "string" ? raw.configPath : configPath,
        done: raw.done as Record<string, true>,
        failures: Array.isArray(raw.failures) ? raw.failures : [],
      }
    }
    console.warn(`[state] ${path} 结构不认识（version=${String((raw as { version?: unknown })?.version)}）——按空状态重建`)
  } catch {
    // 首次运行：文件不存在
  }
  return { version: 1, configPath, done: {}, failures: [] }
}

/** 原子写盘：临时文件 + rename；rename 失败（个别文件系统限制）兜底直写 */
export async function saveState(path: string, state: TournamentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const text = `${JSON.stringify(state, null, 2)}\n`
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, text, "utf-8")
    await rename(tmp, path)
  } catch {
    await writeFile(path, text, "utf-8")
  }
}

export function isDone(state: TournamentState, key: string): boolean {
  return state.done[key] === true
}

export function markDone(state: TournamentState, key: string): void {
  state.done[key] = true
  // 单元成功即清其历史失败记录（重跑补缺成功后失败清单不残留）
  state.failures = state.failures.filter((f) => f.key !== key)
}

/** 记录失败（同 key 去重——保留最近一条） */
export function recordFailure(
  state: TournamentState,
  key: string,
  subcommand: string,
  error: string,
): void {
  state.failures = state.failures.filter((f) => f.key !== key)
  state.failures.push({
    key,
    subcommand,
    error: error.length > 2000 ? `${error.slice(0, 2000)}…（截断）` : error,
    at: new Date().toISOString(),
  })
}

/** 统计某前缀下的完成数 */
export function countDone(state: TournamentState, prefix: string): number {
  return Object.keys(state.done).filter((k) => k.startsWith(prefix)).length
}
