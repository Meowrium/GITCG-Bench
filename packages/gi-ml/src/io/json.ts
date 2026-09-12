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

import { createReadStream, createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { finished } from "node:stream/promises"
import type { MlRankingDataset, MlRankingQueryGroup, MlValueDataset } from "../contracts/index.js"

export async function readJsonFile<T>(path: string): Promise<T> {
  const resolved = resolve(path)
  const raw = await readFile(resolved, "utf8")
  return JSON.parse(raw) as T
}

export async function writeJsonFile(path: string, value: unknown): Promise<string> {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  return resolved
}

export async function writeRankingDatasetFile(
  path: string,
  dataset: MlRankingDataset
): Promise<string> {
  return writeJsonObjectWithArrayProperty(path, dataset, "query_groups", dataset.query_groups)
}

export async function writeValueDatasetFile(path: string, dataset: MlValueDataset): Promise<string> {
  return writeJsonObjectWithArrayProperty(path, dataset, "samples", dataset.samples)
}

export async function visitRankingDatasetQueryGroups(
  path: string,
  visitor: (group: MlRankingQueryGroup) => void | Promise<void>,
): Promise<{ dataset_id: string }> {
  const resolved = resolve(path)
  const stream = createReadStream(resolved, {
    encoding: "utf8",
    highWaterMark: 256 * 1024,
  })

  let prefixBuffer = ""
  let arrayBuffer = ""
  let datasetId: string | null = null
  let inQueryGroups = false
  let reachedArrayEnd = false

  for await (const chunk of stream) {
    if (!inQueryGroups) {
      prefixBuffer += chunk
      datasetId ??= readTopLevelStringProperty(prefixBuffer, "dataset_id")

      const queryGroupsStart = findTopLevelArrayPropertyStart(prefixBuffer, "query_groups")
      if (queryGroupsStart === null) {
        continue
      }

      inQueryGroups = true
      arrayBuffer = prefixBuffer.slice(queryGroupsStart + 1)
      prefixBuffer = ""
    } else {
      arrayBuffer += chunk
    }

    const result = await drainTopLevelObjectArrayBuffer(arrayBuffer, visitor)
    arrayBuffer = result.remaining
    reachedArrayEnd = result.done
    if (reachedArrayEnd) {
      break
    }
  }

  if (!datasetId) {
    throw new Error(`dataset_id not found in ranking dataset: ${resolved}`)
  }
  if (!inQueryGroups) {
    throw new Error(`query_groups array not found in ranking dataset: ${resolved}`)
  }
  if (!reachedArrayEnd) {
    const finalResult = await drainTopLevelObjectArrayBuffer(arrayBuffer, visitor)
    reachedArrayEnd = finalResult.done
    arrayBuffer = finalResult.remaining
  }
  if (!reachedArrayEnd) {
    throw new Error(`query_groups array terminated unexpectedly in ranking dataset: ${resolved}`)
  }

  return { dataset_id: datasetId }
}

async function writeJsonObjectWithArrayProperty<T extends object>(
  path: string,
  value: T,
  arrayKey: string,
  items: readonly unknown[]
): Promise<string> {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true })

  const stream = createWriteStream(resolved, { encoding: "utf8" })
  try {
    await writeChunk(stream, "{\n")
    const entries = Object.entries(value).filter(
      ([key, entryValue]) => key !== arrayKey && entryValue !== undefined
    )

    let wroteProperty = false
    for (const [key, entryValue] of entries) {
      if (wroteProperty) {
        await writeChunk(stream, ",\n")
      }
      await writeChunk(stream, formatProperty(key, entryValue))
      wroteProperty = true
    }

    if (wroteProperty) {
      await writeChunk(stream, ",\n")
    }
    await writeChunk(stream, `  ${JSON.stringify(arrayKey)}: [`)

    if (items.length > 0) {
      await writeChunk(stream, "\n")
      for (let index = 0; index < items.length; index += 1) {
        if (index > 0) {
          await writeChunk(stream, ",\n")
        }
        // Use compact JSON (no pretty-print) for array items — much faster
        // and produces smaller files with less temporary string allocation
        await writeChunk(stream, "    " + JSON.stringify(items[index]))
      }
      await writeChunk(stream, "\n  ")
    }

    await writeChunk(stream, "]\n}\n")
    stream.end()
    await finished(stream)
    return resolved
  } catch (error) {
    stream.destroy(error as Error)
    throw error
  }
}

function formatProperty(key: string, value: unknown): string {
  return `  ${JSON.stringify(key)}: ${indentValue(value)}`
}

function indentValue(value: unknown): string {
  return indentBlock(JSON.stringify(value, null, 2), 2).trimStart()
}

function indentBlock(value: string, spaces: number): string {
  const indent = " ".repeat(spaces)
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n")
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (stream.write(chunk)) {
    return
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onDrain = () => {
      cleanup()
      resolvePromise()
    }
    const onError = (error: Error) => {
      cleanup()
      rejectPromise(error)
    }
    const cleanup = () => {
      stream.off("drain", onDrain)
      stream.off("error", onError)
    }
    stream.on("drain", onDrain)
    stream.on("error", onError)
  })
}

function findTopLevelArrayPropertyStart(source: string, propertyName: string): number | null {
  const valueStart = findTopLevelPropertyValueStart(source, propertyName)
  if (valueStart === null || source[valueStart] !== "[") {
    return null
  }
  return valueStart
}

function readTopLevelStringProperty(source: string, propertyName: string): string | null {
  const valueStart = findTopLevelPropertyValueStart(source, propertyName)
  if (valueStart === null || source[valueStart] !== "\"") {
    return null
  }

  const stringEnd = findStringLiteralEnd(source, valueStart)
  if (stringEnd === -1) {
    return null
  }

  return JSON.parse(source.slice(valueStart, stringEnd + 1)) as string
}

function findTopLevelPropertyValueStart(source: string, propertyName: string): number | null {
  let depth = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\"") {
      const stringEnd = findStringLiteralEnd(source, index)
      if (stringEnd === -1) {
        return null
      }

      if (depth === 1) {
        const key = JSON.parse(source.slice(index, stringEnd + 1)) as string
        let cursor = stringEnd + 1
        while (cursor < source.length && isWhitespace(source[cursor]!)) {
          cursor += 1
        }
        if (cursor >= source.length) {
          return null
        }
        if (source[cursor] === ":" && key === propertyName) {
          cursor += 1
          while (cursor < source.length && isWhitespace(source[cursor]!)) {
            cursor += 1
          }
          return cursor < source.length ? cursor : null
        }
      }

      index = stringEnd
      continue
    }

    if (char === "{" || char === "[") {
      depth += 1
      continue
    }
    if (char === "}" || char === "]") {
      depth -= 1
    }
  }

  return null
}

function findStringLiteralEnd(source: string, start: number): number {
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "\"") {
      return index
    }
  }
  return -1
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t"
}

async function drainTopLevelObjectArrayBuffer(
  source: string,
  visitor: (group: MlRankingQueryGroup) => void | Promise<void>,
): Promise<{ remaining: string; done: boolean }> {
  let remaining = source

  while (true) {
    let objectStart = -1
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = 0; index < remaining.length; index += 1) {
      const char = remaining[index]!

      if (objectStart === -1) {
        if (isWhitespace(char) || char === ",") {
          continue
        }
        if (char === "]") {
          return { remaining: remaining.slice(index + 1), done: true }
        }
        if (char !== "{") {
          throw new Error(`unexpected token in query_groups array: ${char}`)
        }
        objectStart = index
        depth = 1
        inString = false
        escaped = false
        continue
      }

      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (char === "\\") {
          escaped = true
          continue
        }
        if (char === "\"") {
          inString = false
        }
        continue
      }

      if (char === "\"") {
        inString = true
        continue
      }
      if (char === "{" || char === "[") {
        depth += 1
        continue
      }
      if (char === "}" || char === "]") {
        depth -= 1
        if (depth === 0) {
          const rawObject = remaining.slice(objectStart, index + 1)
          await visitor(JSON.parse(rawObject) as MlRankingQueryGroup)
          remaining = remaining.slice(index + 1)
          break
        }
      }
    }

    if (objectStart === -1) {
      return { remaining: "", done: false }
    }
    if (depth > 0) {
      return { remaining: remaining.slice(objectStart), done: false }
    }
  }
}
