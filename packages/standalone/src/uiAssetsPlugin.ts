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

import { access, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Vite plugin that serves UI assets (dice faces, element icons, energy/legend icons,
 * status icons, etc.) from a local directory, auto-downloading missing files from the
 * remote UI assets CDN.
 *
 * Route: GET /ui_assets/:name  →  serve {dir}/{name}
 *   - if file exists locally → stream it
 *   - if not → fetch from remote CDN, save locally, then stream
 */
export function uiAssetsPlugin(): any {
  let uiAssetsDir: string;

  const CDN_BASE = "https://ui.assets.gi-tcg.guyutongxue.site";

  const CACHE_MAX_AGE = 86400; // 1 day

  const CONTENT_TYPES: Record<string, string> = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  /**
   * Fallback map for assets that don't exist on the CDN.
   * Key = requested asset name, Value = CDN-available alternative.
   *
   * Known missing:
   * - UI_Gcg_DiceL_heal_Glow*: heal color glow (used by Legend dice) → fall back to Energy
   */
  const FALLBACK_MAP: Record<string, string> = {
    "UI_Gcg_DiceL_heal_Glow.webp": "UI_Gcg_DiceL_Energy.webp",
    "UI_Gcg_DiceL_heal_Glow_01.webp": "UI_Gcg_DiceL_Energy.webp",
    "UI_Gcg_DiceL_heal_Glow_02.webp": "UI_Gcg_DiceL_Energy.webp",
  };

  function getContentType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  async function serveFile(
    res: ServerResponse,
    filePath: string,
    contentType: string,
  ): Promise<boolean> {
    try {
      await access(filePath);
    } catch {
      return false;
    }
    return new Promise((resolvePromise) => {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
      });
      const stream = createReadStream(filePath);
      stream.pipe(res);
      stream.on("error", () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
        resolvePromise(true);
      });
      stream.on("end", () => resolvePromise(true));
    });
  }

  async function downloadAndServe(
    res: ServerResponse,
    name: string,
    filePath: string,
    remoteUrl: string,
    contentType: string,
  ): Promise<void> {
    try {
      let response = await fetch(remoteUrl);
      if (!response.ok) {
        // Try fallback URL if this asset is known to be missing on CDN
        const fallbackName = FALLBACK_MAP[name];
        if (fallbackName) {
          const fallbackUrl = `${CDN_BASE}/${fallbackName}`;
          console.warn(
            `[ui-assets] ${name} not found on CDN, trying fallback ${fallbackName}`,
          );
          response = await fetch(fallbackUrl);
        }
      }
      if (!response.ok) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("UI asset not found");
        return;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      // Write to disk (fire-and-forget)
      writeFile(filePath, buffer).catch((e) =>
        console.warn(`[ui-assets] Failed to save ${name}: ${e.message}`),
      );
      // Serve the downloaded asset
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
      });
      res.end(buffer);
    } catch (e: any) {
      console.error(`[ui-assets] Download failed for ${name}: ${e.message}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Failed to fetch UI asset");
    }
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = req.url || "";
    if (!url.startsWith("/ui_assets/")) return false;

    // Extract asset name (everything after /ui_assets/)
    const name = url.slice("/ui_assets/".length).split("?")[0];
    if (!name || name.includes("..")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid asset name");
      return true;
    }

    const filePath = join(uiAssetsDir, name);
    const contentType = getContentType(name);

    // Try local file first
    const served = await serveFile(res, filePath, contentType);
    if (served) return true;

    // Download from remote CDN (with fallback support)
    const remoteUrl = `${CDN_BASE}/${name}`;
    await downloadAndServe(res, name, filePath, remoteUrl, contentType);
    return true;
  }

  return {
    name: "ui-assets-plugin",
    configureServer(server: any) {
      const standaloneDir = resolve(process.cwd());
      uiAssetsDir = join(standaloneDir, "..", "ui_assets");
      mkdir(uiAssetsDir, { recursive: true }).catch(() => {});

      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          try {
            const handled = await handleRequest(req, res);
            if (!handled) next();
          } catch (e) {
            console.error("[ui-assets] Middleware error:", e);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal error");
            }
          }
        },
      );

      console.log(
        `[ui-assets] Serving UI assets from ${uiAssetsDir} (${CDN_BASE})`,
      );
    },
  };
}
