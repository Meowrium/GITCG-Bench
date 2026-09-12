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
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Vite plugin that serves card images from a local directory (packages/card_images),
 * and auto-downloads missing images from the remote assets API.
 *
 * Route: GET /card_images/:id  →  serve {dir}/{id}.webp
 *   - if file exists locally → stream it
 *   - if not → fetch from remote API, save locally, then stream
 */
export function cardImagesPlugin(): any {
  // Absolute path to the card_images directory (resolved at plugin init time)
  let cardImagesDir: string;

  const API_BASE = "https://gi-tcg-assets-api-hf.guyutongxue.site/api/v4";

  const EXTENSION = ".webp";
  const CONTENT_TYPE = "image/webp";
  const CACHE_MAX_AGE = 86400; // 1 day

  function parseId(pathname: string): number | null {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const id = parseInt(parts[1], 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  async function serveFile(
    res: ServerResponse,
    filePath: string,
  ): Promise<boolean> {
    try {
      await access(filePath);
    } catch {
      return false;
    }
    return new Promise((resolvePromise) => {
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPE,
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
    id: number,
    filePath: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/image/${id}`);
      if (!response.ok) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Image not found");
        return;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      // Write to disk (fire-and-forget; don't block the response)
      writeFile(filePath, buffer).catch((e) =>
        console.warn(`[card-images] Failed to save ${id}: ${e.message}`),
      );
      // Serve the downloaded image
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPE,
        "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
      });
      res.end(buffer);
    } catch (e: any) {
      console.error(`[card-images] Download failed for ${id}: ${e.message}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Failed to fetch image");
    }
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = req.url || "";
    if (!url.startsWith("/card_images/")) return false;

    const id = parseId(url);
    if (id === null) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid card ID");
      return true;
    }

    const filePath = join(cardImagesDir, `${id}${EXTENSION}`);

    // Try local file first
    const served = await serveFile(res, filePath);
    if (served) return true;

    // Download from remote API
    await downloadAndServe(res, id, filePath);
    return true;
  }

  async function ensureDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // Directory already exists or cannot be created
    }
  }

  return {
    name: "card-images-plugin",
    configureServer(server: any) {
      // Resolve card_images directory relative to the monorepo root
      // When running from packages/standalone, the card_images dir is ../card_images/
      const standaloneDir = resolve(process.cwd());
      cardImagesDir = join(standaloneDir, "..", "card_images");
      ensureDir(cardImagesDir).catch(() => {});

      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          try {
            const handled = await handleRequest(req, res);
            if (!handled) next();
          } catch (e) {
            console.error("[card-images] Middleware error:", e);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal error");
            }
          }
        },
      );

      console.log(
        `[card-images] Serving card images from ${cardImagesDir} (${API_BASE})`,
      );
    },
  };
}
