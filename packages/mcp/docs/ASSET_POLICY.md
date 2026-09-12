# Asset Policy (Card Images)

This MCP package does not version card image binaries.

## Why

- Reduce repository size and clone time.
- Keep MCP release assets focused on code, contracts, and docs.
- Avoid syncing large binary updates in source control.

## Policy

1. Do not commit files under `packages/standalone/public/card_images/`.
2. Users should fetch card images from the simulator project's image CDN/source.
3. Image assets are treated as local runtime cache, not source artifacts.

## Recommended Workflow

1. Clone project and install dependencies.
2. Download images into `packages/standalone/public/card_images/`.
3. Start standalone and MCP as usual.

## Helper Scripts

- `packages/mcp/scripts/download-card-images.sh`
- `packages/mcp/scripts/download-card-images.ps1`

Both scripts require:

- a base image URL
- an ID list file
- an output directory

Example output path:

`packages/standalone/public/card_images`
