# Compatibility Matrix

This file tracks tested combinations for the MCP package, simulator upstream versions, and integration patches.

## Version Matrix

| MCP Version | Upstream Repo | Upstream Ref | Patch Version | Status | Notes |
|---|---|---|---|---|---|
| 0.17.x | `@gi-tcg/genius-invokation` | `TODO: fill tag or commit` | `standalone-v1` | planned | First public release baseline |

## Support Policy

- `stable`: Verified in CI or manual regression checklist.
- `planned`: Documentation and patch layout prepared, pending full verification.
- `deprecated`: Kept for reference only, no bugfix commitment.

## Upgrade Rules

1. Update this matrix before releasing a new MCP minor version.
2. Keep at least one `stable` row for quick onboarding.
3. When upstream `StandaloneParent` has breaking changes, publish a new patch version instead of silently mutating old patches.
