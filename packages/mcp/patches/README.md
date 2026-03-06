# Patch Assets

This directory stores integration patch files for simulator-side modifications.

## Naming

Use explicit and versioned names:

- `standalone-v1.patch`
- `standalone-v2.patch`

## Header Convention

Each patch should start with comments describing:

- Target upstream repository and ref.
- Compatible MCP version range.
- Breaking integration notes.

## Important

Do not mix unrelated refactors into integration patches. Keep patch diffs easy to review and rebase.
