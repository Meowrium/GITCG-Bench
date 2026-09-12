# Patching Guide

Use this guide when integrating MCP into a simulator client that requires source modifications.

## Goals

- Keep MCP package open and reusable.
- Keep simulator modifications minimal and auditable.
- Avoid maintaining a large long-lived fork.

## Layout

- Patch files: `packages/mcp/patches/*.patch`
- Apply scripts:
  - `packages/mcp/scripts/apply-standalone-patch.sh`
  - `packages/mcp/scripts/apply-standalone-patch.ps1`

## Create a New Patch

1. Checkout a clean upstream ref in the simulator repository.
2. Apply your MCP integration edits (prefer adapter injection points, avoid broad rewrites).
3. Generate patch files:

```bash
git diff -- packages/standalone/src > packages/mcp/patches/standalone-v1.patch
```

4. Add or update a row in `packages/mcp/COMPATIBILITY.md`.
5. Document behavior and known limits in patch header comments.

## Apply Patch (Bash)

```bash
bash packages/mcp/scripts/apply-standalone-patch.sh packages/mcp/patches/standalone-v1.patch
```

## Apply Patch (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File packages/mcp/scripts/apply-standalone-patch.ps1 -PatchFile packages/mcp/patches/standalone-v1.patch
```

## Rollback

If a patch was applied but not committed yet, prefer restoring only touched files:

```bash
git restore --worktree --source=HEAD -- packages/standalone/src
```

Or discard all unstaged changes in current repo when you are sure it is safe:

```bash
git restore --worktree --source=HEAD .
```

## Review Checklist

- MCP can initialize and list tools.
- State listener still reports pause updates.
- UI-controlled player path remains usable.
- No unrelated files changed.
