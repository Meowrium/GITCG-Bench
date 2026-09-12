// Copyright (C) 2024-2025 Guyutongxue
//
// Flatten a nested record into dot-notation scalar features.
// Exported from a single source of truth to avoid 7+ duplicate implementations.

export function flattenNumericRecord(
  value: Record<string, unknown> | null | undefined,
  prefix = "",
): Record<string, number> {
  const result: Record<string, number> = {}
  if (!value || typeof value !== "object") return result
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === "number" && Number.isFinite(child)) {
      result[path] = child
      continue
    }
    if (typeof child === "boolean") {
      result[path] = child ? 1 : 0
      continue
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flattenNumericRecord(child as Record<string, unknown>, path))
    }
  }
  return result
}
