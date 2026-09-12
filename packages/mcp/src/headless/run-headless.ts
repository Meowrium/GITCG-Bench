// Copyright (C) 2025 Guyutongxue
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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VERSIONS, type Version } from "@gi-tcg/core";
import { HeadlessGameRunner } from "./HeadlessGameRunner";

function parseArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk.toString(); });
    req.on("end", () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function main() {
  const deck0 = parseArg("--deck0");
  const deck1 = parseArg("--deck1");
  const versionRaw = parseArg("--version");
  const port = parseInt(parseArg("--port") ?? "3901", 10);

  if (!deck0 || !deck1) {
    console.error("Usage: gnx packages/mcp/src/headless/run-headless.ts --deck0 <code> --deck1 <code> [--version v5.5.0] [--port 3901]");
    process.exit(1);
  }
  if (versionRaw && !VERSIONS.includes(versionRaw as Version)) {
    console.error(`Unsupported game version: ${versionRaw}. Expected one of: ${VERSIONS.join(", ")}`);
    process.exit(1);
  }

  console.error("[Headless] Starting HeadlessGameRunner...");
  const runner = new HeadlessGameRunner({
    deck0,
    deck1,
    version: versionRaw as Version | undefined,
    player0Type: "ai",
    player1Type: "ai",
  });
  await runner.start();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/mcp/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const subpath = url.slice("/api/mcp/".length);
    const segments = subpath.split("/").filter(Boolean);
    const whoRaw = segments[0];
    const who = whoRaw === "0" ? 0 : whoRaw === "1" ? 1 : null;
    if (who === null) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid player identifier" }));
      return;
    }
    const path = segments.slice(1).join("/") || "";

    res.setHeader("Content-Type", "application/json");

    try {
      // Defer import of mcpState to avoid circular dependency issues
      const {
        getMcpBridgeStatus,
        getPendingMcpCommand,
        setPendingMcpCommand,
        resolvePendingMcpCommand,
        getSnapshot,
        getActionEffects,
        clearActionEffects,
        markGameOver,
        disconnectMcpBridge,
        recordMcpIoError,
      } = await import("../../../standalone/src/mcpState");

      const w = who as 0 | 1;
      const bridge = getMcpBridgeStatus(w);
      const snapshot = bridge.snapshot;

      switch (path) {
        case "ping": {
          res.end(JSON.stringify({
            status: "ok",
            who: w,
            connected: bridge.connected,
            stale: bridge.stale,
            gameRunning: bridge.connected && snapshot.gamePhase !== "not_started",
          }));
          break;
        }
        case "status": {
          res.end(JSON.stringify({
            who: w,
            hasPendingRpc: snapshot.hasPendingRpc,
            pendingMethod: snapshot.pendingMethod,
            pendingRequest: snapshot.pendingRequest,
            pendingActionCount: 0,
            gamePhase: snapshot.gamePhase,
            gameOver: snapshot.gameOver,
            winner: snapshot.winner,
            currentPlayer: snapshot.currentPlayer,
            round: snapshot.round,
            snapshotUpdatedAt: snapshot.updatedAt,
            aiPlayerWho: snapshot.aiPlayerWho,
            connected: bridge.connected,
            stale: bridge.stale,
            hasPendingCommand: bridge.hasPendingCommand,
            pendingCommandId: bridge.pendingCommandId,
            lastCommandResult: bridge.lastCommandResult,
            lastIoError: bridge.lastIoError,
          }));
          break;
        }
        case "sync": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          // Sync is handled by HeadlessGameRunner directly (memory), so this is a no-op
          res.end(JSON.stringify({ ok: true, who: w }));
          break;
        }
        case "game-over": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const winner = body?.winner === 0 || body?.winner === 1 ? body.winner : null;
          markGameOver(w, winner);
          res.end(JSON.stringify({ ok: true, who: w, gameOver: true, winner }));
          break;
        }
        case "next-command": {
          const command = getPendingMcpCommand(w);
          res.end(JSON.stringify({ command: command ?? null, who: w }));
          break;
        }
        case "command-result": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const resolved = resolvePendingMcpCommand(body.id, !!body.success, body.message);
          res.end(JSON.stringify(resolved));
          break;
        }
        case "io-error": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const targetWho = body?.who === 0 || body?.who === 1 ? body.who : w;
          const recorded = recordMcpIoError(targetWho, body ?? {});
          res.end(JSON.stringify({ ok: true, who: targetWho, lastIoError: recorded }));
          break;
        }
        case "disconnect": {
          disconnectMcpBridge(w);
          res.end(JSON.stringify({ ok: true, who: w }));
          break;
        }
        case "available-commands": {
          const availableTools: Array<{ tool: string; description: string }> = [
            { tool: "wait_for_my_turn", description: "Wait (blocking) until it's your turn to act" },
          ];
          if (snapshot.hasPendingRpc && snapshot.pendingMethod) {
            switch (snapshot.pendingMethod) {
              case "action": availableTools.push({ tool: "choose_action", description: "Choose an action" }); break;
              case "chooseActive": availableTools.push({ tool: "choose_active", description: "Choose active character" }); break;
              case "rerollDice": availableTools.push({ tool: "reroll_dice", description: "Reroll dice" }); break;
              case "switchHands": availableTools.push({ tool: "switch_hands", description: "Switch hand cards" }); break;
              case "selectCard": availableTools.push({ tool: "select_card", description: "Select a card" }); break;
            }
          }
          res.end(JSON.stringify({
            available_tools: availableTools,
            has_pending_rpc: snapshot.hasPendingRpc,
            pending_method: snapshot.pendingMethod,
            connected: bridge.connected,
            who: w,
          }));
          break;
        }
        case "state": {
          if (!snapshot.state) { res.end(JSON.stringify({ error: "Game not initialized" })); return; }
          res.end(JSON.stringify(snapshot.state));
          break;
        }
        case "screen": {
          if (!snapshot.screen) { res.end(JSON.stringify({ error: "Game not initialized" })); return; }
          res.end(JSON.stringify(snapshot.screen));
          break;
        }
        case "deck0":
        case "deck1": {
          const targetWho = path === "deck0" ? 0 : 1;
          const deckInfoAny = (snapshot as any)?.deckInfo;
          const players = deckInfoAny?.players;
          if (!Array.isArray(players) || !players[targetWho]) {
            res.end(JSON.stringify({ error: "Deck info not available" }));
            return;
          }
          res.end(JSON.stringify(players[targetWho]));
          break;
        }
        case "action-effects": {
          const effects = getActionEffects(w);
          clearActionEffects(w);
          res.end(JSON.stringify({ who: w, effects }));
          break;
        }
        case "action": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const { actionIndex, usedDice, idempotencyKey } = body;
          const normDice = Array.isArray(usedDice) ? usedDice : [];
          const response: Record<string, unknown> = { chosenActionIndex: actionIndex - 1, usedDice: normDice };
          if (typeof body.explanation === "string") {
            response.explanation = body.explanation;
          }
          const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : `action:action:${JSON.stringify(response)}`;
          const queued = setPendingMcpCommand(w, "action", response, key);
          res.end(JSON.stringify({
            success: queued.ok,
            message: queued.ok ? "Queued" : queued.reason,
            commandId: queued.command?.id ?? null,
            idempotencyKey: key,
            idempotentHit: !!queued.idempotentHit,
            alreadyResolved: !!queued.alreadyResolved,
            lastCommandResult: queued.lastResult ?? null,
          }));
          break;
        }
        case "chooseActive": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const { activeCharacterId, idempotencyKey } = body;
          const response = { activeCharacterId };
          const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : `chooseActive:chooseActive:${JSON.stringify(response)}`;
          const queued = setPendingMcpCommand(w, "chooseActive", response, key);
          res.end(JSON.stringify({
            success: queued.ok,
            message: queued.ok ? "Queued" : queued.reason,
            commandId: queued.command?.id ?? null,
            idempotencyKey: key,
            idempotentHit: !!queued.idempotentHit,
            alreadyResolved: !!queued.alreadyResolved,
            lastCommandResult: queued.lastResult ?? null,
          }));
          break;
        }
        case "rerollDice": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const { diceToReroll, idempotencyKey } = body;
          const response = { diceToReroll: diceToReroll ?? [] };
          const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : `rerollDice:rerollDice:${JSON.stringify(response)}`;
          const queued = setPendingMcpCommand(w, "rerollDice", response, key);
          res.end(JSON.stringify({
            success: queued.ok,
            message: queued.ok ? "Queued" : queued.reason,
            commandId: queued.command?.id ?? null,
            idempotencyKey: key,
            idempotentHit: !!queued.idempotentHit,
            alreadyResolved: !!queued.alreadyResolved,
            lastCommandResult: queued.lastResult ?? null,
          }));
          break;
        }
        case "switchHands": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const { removedHandIds, idempotencyKey } = body;
          const response = { removedHandIds: removedHandIds ?? [] };
          const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : `switchHands:switchHands:${JSON.stringify(response)}`;
          const queued = setPendingMcpCommand(w, "switchHands", response, key);
          res.end(JSON.stringify({
            success: queued.ok,
            message: queued.ok ? "Queued" : queued.reason,
            commandId: queued.command?.id ?? null,
            idempotencyKey: key,
            idempotentHit: !!queued.idempotentHit,
            alreadyResolved: !!queued.alreadyResolved,
            lastCommandResult: queued.lastResult ?? null,
          }));
          break;
        }
        case "selectCard": {
          if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
          const body: any = await readJsonBody(req);
          const { selectedDefinitionId, idempotencyKey } = body;
          const response = { selectedDefinitionId };
          const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
            ? idempotencyKey.trim()
            : `selectCard:selectCard:${JSON.stringify(response)}`;
          const queued = setPendingMcpCommand(w, "selectCard", response, key);
          res.end(JSON.stringify({
            success: queued.ok,
            message: queued.ok ? "Queued" : queued.reason,
            commandId: queued.command?.id ?? null,
            idempotencyKey: key,
            idempotentHit: !!queued.idempotentHit,
            alreadyResolved: !!queued.alreadyResolved,
            lastCommandResult: queued.lastResult ?? null,
          }));
          break;
        }
        default: {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown endpoint: /api/mcp/${w}/${path}` }));
        }
      }
    } catch (e: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error", detail: e?.message }));
      }
    }
  });

  server.listen(port, () => {
    console.error(`[Headless] HTTP bridge listening on http://localhost:${port}`);
    console.error(`[Headless] MCP servers can connect to http://localhost:${port}`);
    console.error("[Headless] Launch agents with: .opencode/start-both.ps1");
  });

  const shutdown = () => {
    console.error("\n[Headless] Shutting down...");
    runner.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
