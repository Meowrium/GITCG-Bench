# Contributing

Thanks for improving `@gi-tcg/mcp`.

## Scope

This package accepts contributions in three areas:

- MCP protocol and tool behavior.
- Integration adapters and patch assets.
- Documentation and skills assets under `.opencode/skills`.

## Contribution Types

1. `core`: changes under `packages/mcp/src` without simulator source edits.
2. `adapter`: minimal simulator integration points.
3. `patch`: explicit diff files under `packages/mcp/patches`.
4. `skills`: reusable skill prompts and strategy docs.

## Pull Request Requirements

- Explain which category the PR belongs to (`core`/`adapter`/`patch`/`skills`).
- Link or update `packages/mcp/COMPATIBILITY.md` when integration behavior changes.
- For patch updates, provide the tested upstream ref.
- Keep changes focused; avoid unrelated formatting sweeps.

## Local Checks

```bash
cd packages/mcp
bun run check
bun run build
bun run build:card-index
```

## License

By contributing, you agree your contribution is licensed under AGPL-3.0.
