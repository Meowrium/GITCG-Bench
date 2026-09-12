export function resolveDatasetCapturePaths(args: {
  currentRunCapturePaths: readonly string[]
  fallbackCapturePaths?: readonly string[]
}): string[] {
  const sourcePaths =
    args.currentRunCapturePaths.length > 0
      ? args.currentRunCapturePaths
      : (args.fallbackCapturePaths ?? [])
  return [...new Set(sourcePaths)].sort((a, b) => a.localeCompare(b))
}
