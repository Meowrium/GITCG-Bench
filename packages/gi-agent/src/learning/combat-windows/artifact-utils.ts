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

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

export type RuntimeArtifactKind = "plan" | "digest" | "fragment" | "feedback" | "shard" | "critic"

export interface ParsedRuntimeArtifactPath {
  path: string
  filename: string
  session_id: string
  kind: RuntimeArtifactKind
  timestamp: number | null
}

const TIMESTAMPED_ARTIFACT_RE = /^(.*)_(digest|fragment|feedback|shard|critic)_(\d+)\.json$/i

export function parseRuntimeArtifactPath(path: string): ParsedRuntimeArtifactPath | null {
  const filename = basename(path)
  const match = filename.match(TIMESTAMPED_ARTIFACT_RE)
  if (match) {
    return {
      path,
      filename,
      session_id: match[1] ?? "",
      kind: (match[2] ?? "plan") as RuntimeArtifactKind,
      timestamp: Number(match[3]),
    }
  }
  if (!filename.endsWith(".json")) {
    return null
  }
  return {
    path,
    filename,
    session_id: filename.slice(0, -".json".length),
    kind: "plan",
    timestamp: null,
  }
}

export async function listRuntimeArtifacts(directory: string): Promise<ParsedRuntimeArtifactPath[]> {
  const resolved = resolve(directory)
  const entries = await readdir(resolved, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => parseRuntimeArtifactPath(join(resolved, entry.name)))
    .filter((value): value is ParsedRuntimeArtifactPath => value != null)
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
