/**
 * Scoring utility functions — extracted from StandaloneMcpToolHandler.resolveFragmentCandidate.
 */

/** Safely coerce an unknown value to a finite number, defaulting to 0. */
export function safeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

/** Trim and lower-case a label for comparison. */
export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

/** Check if any of `labels` is a substring of `source` (case-insensitive). */
export function containsLabel(source: string, labels: string[]): boolean {
  const normalizedSource = normalizeLabel(source);
  return labels.some((label) => normalizedSource.includes(normalizeLabel(label)));
}

/** Sum the `count` fields inside a candidate's `cost.required_cost` array. */
export function totalCostFromCandidate(candidate: Record<string, unknown>): number {
  const costRecord = (candidate.cost ?? null) as Record<string, unknown> | null;
  const entries = Array.isArray(costRecord?.required_cost)
    ? (costRecord.required_cost as Array<Record<string, unknown>>)
    : [];
  return entries.reduce((sum, entry) => {
    const count = entry.count;
    return sum + (typeof count === "number" && Number.isFinite(count) ? count : 0);
  }, 0);
}
