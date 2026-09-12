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

import { resolve } from "node:path"

export function resolveCliPath(inputPath: string): string {
  return resolve(normalizeCliPathForPlatform(inputPath, process.platform))
}

export function normalizeCliPathForPlatform(
  inputPath: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") {
    return inputPath
  }

  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(inputPath)
  if (!match) {
    return inputPath
  }

  const drive = `${match[1]!.toUpperCase()}:`
  const suffix = (match[2] ?? "").replaceAll("/", "\\")
  return suffix ? `${drive}\\${suffix}` : `${drive}\\`
}
