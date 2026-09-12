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

import { IncomingMessage, ServerResponse } from "node:http";
import {
  getMcpBridgeStatus,
  getPendingMcpCommand,
  resolvePendingMcpCommand,
  setPendingMcpCommand,
  updateMcpBridgeSnapshot,
  disconnectMcpBridge,
  resetMcpBridgeForNewGame,
  recordMcpIoError,
  clearActionEffects,
  getActionEffects,
  markGameOver,
  type McpBridgeStatus,
} from "./mcpState";

type Who = 0 | 1;

const OPPONENT_DECK_ENV = "MCP_ALLOW_OPP_DECK";
const isOpponentDeckAllowed = (): boolean => {
  const raw = process.env[OPPONENT_DECK_ENV];
  if (!raw) return true;
  const normalized = raw.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const isIntegerArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

function parseWho(segments: string[]): Who | null {
  const raw = segments[0];
  if (raw === "0") return 0;
  if (raw === "1") return 1;
  return null;
}

// Helpers that operate on a player-specific snapshot
function failIfNoPendingRpc(bridge: McpBridgeStatus, expectedMethod?: string): string | null {
  if (!bridge.connected) return "Standalone bridge is not connected";
  if (!bridge.snapshot.hasPendingRpc || !bridge.snapshot.pendingMethod)
    return "No pending action request";
  if (expectedMethod && bridge.snapshot.pendingMethod !== expectedMethod)
    return `Pending RPC is '${bridge.snapshot.pendingMethod}', expected '${expectedMethod}'`;
  return null;
}

function getPlayerDice(bridge: McpBridgeStatus): number[] | null {
  const stateAny = bridge.snapshot.state as any;
  const who = bridge.snapshot.aiPlayerWho;
  const player = stateAny?.player;
  // player may be a single PlayerState object (new bridge snapshot format)
  // or an array of two PlayerState objects (legacy format).
  const dice = Array.isArray(player) ? player[who]?.dice : player?.dice;
  return Array.isArray(dice) ? (dice as number[]) : null;
}

function getPlayerHandCardIds(bridge: McpBridgeStatus): number[] | null {
  const stateAny = bridge.snapshot.state as any;
  const who = bridge.snapshot.aiPlayerWho;
  const player = stateAny?.player;
  // player may be a single PlayerState object (new bridge snapshot format)
  // or an array of two PlayerState objects (legacy format).
  const handCards = Array.isArray(player) ? player[who]?.handCard : player?.handCard;
  if (!Array.isArray(handCards)) return null;
  return handCards
    .map((card: any) => card?.id)
    .filter((id: any) => Number.isInteger(id)) as number[];
}

function getPendingRequest(bridge: McpBridgeStatus): any | null {
  const pr = (bridge.snapshot as any).pendingRequest;
  return pr && typeof pr === "object" ? pr : null;
}

function getPendingActions(bridge: McpBridgeStatus): any[] | null {
  const pr = getPendingRequest(bridge);
  if (!pr || typeof pr !== "object") return null;
  // Protobuf runtime format: { $case: "action", value: { action: [...] } }
  if ((pr as any).$case === "action" && Array.isArray((pr as any).value?.action))
    return (pr as any).value.action as any[];
  // JSON-ified format: { action: { action: [...] } }
  const data = (pr as any).action;
  if (data && typeof data === "object" && Array.isArray(data.action))
    return data.action as any[];
  return null;
}

function checkDiceRequirement(
  requiredCost: Array<{ type?: number; count?: number }>,
  usedDice: number[],
): boolean {
  const VOID = 0, OMNI = 8, ALIGNED = 8, ENERGY = 9;
  const entries = requiredCost.filter(
    (e) => Number.isInteger(e.type) && Number.isInteger(e.count) && (e.count as number) > 0,
  );
  const alignedEntry = entries.find((e) => e.type === ALIGNED);
  if (alignedEntry) {
    if ((alignedEntry.count as number) !== usedDice.length) return false;
    const chosenSet = new Set(usedDice);
    return chosenSet.size <= 1 || (chosenSet.size === 2 && chosenSet.has(OMNI));
  }
  const requiredList: number[] = [];
  for (const entry of entries) {
    for (let i = 0; i < (entry.count as number); i++) requiredList.push(entry.type as number);
  }
  const chosen = [...usedDice];
  let voidCount = 0;
  for (const req of requiredList) {
    if (req === ENERGY) continue;
    if (req === VOID) { voidCount++; continue; }
    const idx = chosen.indexOf(req);
    if (idx !== -1) { chosen.splice(idx, 1); continue; }
    const omniIdx = chosen.indexOf(OMNI);
    if (omniIdx === -1) return false;
    chosen.splice(omniIdx, 1);
  }
  return chosen.length === voidCount;
}

function validateDiceSelection(available: number[] | null, selected: number[], field: string): string | null {
  if (!available) return null;
  const remaining = [...available];
  for (const die of selected) {
    const idx = remaining.indexOf(die);
    if (idx === -1) return `Invalid ${field}: dice type ${die} not in pool`;
    remaining.splice(idx, 1);
  }
  return null;
}

function validateSnapshotGuard(
  bridge: McpBridgeStatus,
  expectedPendingMethod?: unknown,
  expectedSnapshotUpdatedAt?: unknown,
): string | null {
  if (typeof expectedPendingMethod === "string" && bridge.snapshot.pendingMethod &&
      expectedPendingMethod !== bridge.snapshot.pendingMethod) {
    return `Stale: expected pending '${expectedPendingMethod}', current '${bridge.snapshot.pendingMethod}'`;
  }
  if (typeof expectedSnapshotUpdatedAt === "number" && Number.isFinite(expectedSnapshotUpdatedAt) &&
      expectedSnapshotUpdatedAt !== bridge.snapshot.updatedAt) {
    return `Stale snapshot: expected updatedAt=${expectedSnapshotUpdatedAt}, current=${bridge.snapshot.updatedAt}`;
  }
  return null;
}

function createDefaultIdempotencyKey(method: string, expectedMethod: string, payload: unknown): string {
  const text = (() => { try { return JSON.stringify(payload); } catch { return String(payload); } })();
  return `${method}:${expectedMethod}:${text}`;
}

export function mcpBridgePlugin(): any {
  return {
    name: "mcp-bridge",
    configureServer(server: any) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url || "";
        if (!url.startsWith("/api/mcp/")) { next(); return; }

        // Parse /api/mcp/:who/:path
        const subpath = url.slice("/api/mcp/".length);
        const segments = subpath.split("/").filter(Boolean);
        const who = parseWho(segments);
        if (who === null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing or invalid player identifier in path /api/mcp/:who/..." }));
          return;
        }
        const path = segments.slice(1).join("/") || "";

        res.setHeader("Content-Type", "application/json");

        try {
          await handleRoute(req, res, who, path);
        } catch (e: any) {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "Internal error", detail: e?.message }));
          }
        }
      });
    },
  };
}

async function handleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  who: Who,
  path: string,
): Promise<void> {
  const bridge = getMcpBridgeStatus(who);
  const snapshot = bridge.snapshot;

  switch (path) {
    case "ping": {
      res.end(JSON.stringify({
        status: "ok",
        who,
        connected: bridge.connected,
        stale: bridge.stale,
        gameRunning: bridge.connected && snapshot.gamePhase !== "not_started",
      }));
      break;
    }

    case "status": {
      res.end(JSON.stringify({
        who,
        hasPendingRpc: snapshot.hasPendingRpc,
        pendingMethod: snapshot.pendingMethod,
        pendingRequest: getPendingRequest(bridge),
        pendingActionCount: getPendingActions(bridge)?.length ?? 0,
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
      if (req.method !== "POST") {
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const body: any = await readJsonBody(req);
      const newGamePhase = body.snapshot?.gamePhase ?? "not_started";
      const newRound = body.snapshot?.round ?? 0;

      // Detect game restart: clear idempotency cache so the AI can
      // repeat the same action (e.g. same opening character) across games.
      const prevPhase = snapshot.gamePhase;
      const prevRound = snapshot.round;
      if (
        (newGamePhase === "not_started" && prevPhase !== "not_started") ||
        (newRound === 0 && prevRound > 0)
      ) {
        resetMcpBridgeForNewGame(who);
      }

      updateMcpBridgeSnapshot(who, {
        hasPendingRpc: !!body.snapshot?.hasPendingRpc,
        pendingMethod: body.snapshot?.pendingMethod ?? null,
        pendingRequest: body.snapshot?.pendingRequest ?? null,
        gamePhase: newGamePhase,
        currentPlayer: body.snapshot?.currentPlayer ?? -1,
        round: newRound,
        state: body.snapshot?.state ?? null,
        screen: body.snapshot?.screen ?? null,
        deckInfo: body.snapshot?.deckInfo ?? null,
        gameOver: body.snapshot?.gameOver === true,
        winner: body.snapshot?.winner === 0 || body.snapshot?.winner === 1
          ? body.snapshot.winner
          : null,
      });
      res.end(JSON.stringify({ ok: true, who }));
      break;
    }

    case "game-over": {
      if (req.method !== "POST") {
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const body: any = await readJsonBody(req);
      const winner =
        body?.winner === 0 || body?.winner === 1
          ? (body.winner as Who)
          : null;
      const updated = markGameOver(who, winner);
      res.end(JSON.stringify({
        ok: true,
        who,
        gameOver: true,
        winner: updated.winner,
        you_won: updated.winner === who,
        message: winner === who
          ? "Game over. You won!"
          : winner === null
            ? "Game over. Winner unknown."
            : "Game over. You lost.",
      }));
      break;
    }

    case "next-command": {
      const command = getPendingMcpCommand(who);
      res.end(JSON.stringify({ command: command ?? null, who }));
      break;
    }

    case "command-result": {
      if (req.method !== "POST") {
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const body: any = await readJsonBody(req);
      const resolved = resolvePendingMcpCommand(body.id, !!body.success, body.message);
      res.end(JSON.stringify(resolved));
      break;
    }

    case "io-error": {
      if (req.method !== "POST") {
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const body: any = await readJsonBody(req);
      const targetWho = body?.who === 0 || body?.who === 1 ? body.who as Who : who;
      const recorded = recordMcpIoError(targetWho, body ?? {});
      res.end(JSON.stringify({ ok: true, who: targetWho, lastIoError: recorded }));
      break;
    }

    case "disconnect": {
      disconnectMcpBridge(who);
      res.end(JSON.stringify({ ok: true, who }));
      break;
    }

    case "available-commands": {
      const availableTools: Array<{ tool: string; description: string }> = [];
      // wait_for_my_turn is always available (meta-tool for polling)
      availableTools.push({ tool: "wait_for_my_turn", description: "Wait (blocking) until it's your turn to act" });
      if (snapshot.hasPendingRpc && snapshot.pendingMethod) {
        switch (snapshot.pendingMethod) {
          case "action":
            availableTools.push({ tool: "choose_action", description: "Choose an action from available options" });
            break;
          case "chooseActive":
            availableTools.push({ tool: "choose_active", description: "Choose active character" });
            break;
          case "rerollDice":
            availableTools.push({ tool: "reroll_dice", description: "Reroll selected dice" });
            break;
          case "switchHands":
            availableTools.push({ tool: "switch_hands", description: "Switch initial hand cards" });
            break;
          case "selectCard":
            availableTools.push({ tool: "select_card", description: "Select a card" });
            break;
        }
      }
      res.end(JSON.stringify({
        available_tools: availableTools,
        has_pending_rpc: snapshot.hasPendingRpc,
        pending_method: snapshot.pendingMethod,
        connected: bridge.connected,
        who,
      }));
      break;
    }

    case "action": {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const err = failIfNoPendingRpc(bridge, "action");
      if (err) { res.end(JSON.stringify({ success: false, error: err })); return; }

      const body: any = await readJsonBody(req);
      const { actionIndex, usedDice, idempotencyKey, expectedPendingMethod, expectedSnapshotUpdatedAt } = body;

      const guardErr = validateSnapshotGuard(bridge, expectedPendingMethod, expectedSnapshotUpdatedAt);
      if (guardErr) { res.end(JSON.stringify({ success: false, error: guardErr, errorCode: "STALE_CONTEXT", snapshotUpdatedAt: snapshot.updatedAt })); return; }

      if (!Number.isInteger(actionIndex) || actionIndex <= 0) {
        res.end(JSON.stringify({ success: false, error: "Invalid actionIndex" })); return;
      }
      const normDice = (Array.isArray(usedDice) ? usedDice : []) as number[];

      const pendingActions = getPendingActions(bridge);
      if (pendingActions) {
        const selected = pendingActions[actionIndex - 1];
        if (!selected) { res.end(JSON.stringify({ success: false, error: `actionIndex must be 1-${pendingActions.length}` })); return; }
        if (selected.validity !== 0) { res.end(JSON.stringify({ success: false, error: "Selected action is not valid" })); return; }
        if (!checkDiceRequirement(selected.requiredCost ?? [], normDice)) {
          res.end(JSON.stringify({ success: false, error: "Dice do not satisfy required cost" })); return;
        }
      }
      const diceErr = validateDiceSelection(getPlayerDice(bridge), normDice, "usedDice");
      if (diceErr) { res.end(JSON.stringify({ success: false, error: diceErr })); return; }

      const response: Record<string, unknown> = { chosenActionIndex: actionIndex - 1, usedDice: normDice };
      if (typeof body.explanation === "string") {
        response.explanation = body.explanation;
      }
      const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createDefaultIdempotencyKey("action", "action", response);
      const queued = setPendingMcpCommand(who, "action", response, key);
      res.end(JSON.stringify(buildQueuedResponse(queued, key)));
      break;
    }

    case "chooseActive": {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const err = failIfNoPendingRpc(bridge, "chooseActive");
      if (err) { res.end(JSON.stringify({ success: false, error: err })); return; }

      const body: any = await readJsonBody(req);
      const { activeCharacterId, idempotencyKey, expectedPendingMethod, expectedSnapshotUpdatedAt } = body;
      const guardErr = validateSnapshotGuard(bridge, expectedPendingMethod, expectedSnapshotUpdatedAt);
      if (guardErr) { res.end(JSON.stringify({ success: false, error: guardErr })); return; }
      if (!Number.isInteger(activeCharacterId)) { res.end(JSON.stringify({ success: false, error: "Invalid activeCharacterId" })); return; }

      const response = { activeCharacterId };
      const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createDefaultIdempotencyKey("chooseActive", "chooseActive", response);
      const queued = setPendingMcpCommand(who, "chooseActive", response, key);
      res.end(JSON.stringify(buildQueuedResponse(queued, key)));
      break;
    }

    case "rerollDice": {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const err = failIfNoPendingRpc(bridge, "rerollDice");
      if (err) { res.end(JSON.stringify({ success: false, error: err })); return; }

      const body: any = await readJsonBody(req);
      const { diceToReroll, idempotencyKey, expectedPendingMethod, expectedSnapshotUpdatedAt } = body;
      const guardErr = validateSnapshotGuard(bridge, expectedPendingMethod, expectedSnapshotUpdatedAt);
      if (guardErr) { res.end(JSON.stringify({ success: false, error: guardErr })); return; }
      if (!isIntegerArray(diceToReroll ?? [])) { res.end(JSON.stringify({ success: false, error: "Invalid diceToReroll" })); return; }

      const response = { diceToReroll: (diceToReroll ?? []) as number[] };
      const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createDefaultIdempotencyKey("rerollDice", "rerollDice", response);
      const queued = setPendingMcpCommand(who, "rerollDice", response, key);
      res.end(JSON.stringify(buildQueuedResponse(queued, key)));
      break;
    }

    case "switchHands": {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const err = failIfNoPendingRpc(bridge, "switchHands");
      if (err) { res.end(JSON.stringify({ success: false, error: err })); return; }

      const body: any = await readJsonBody(req);
      const { removedHandIds, idempotencyKey, expectedPendingMethod, expectedSnapshotUpdatedAt } = body;
      const guardErr = validateSnapshotGuard(bridge, expectedPendingMethod, expectedSnapshotUpdatedAt);
      if (guardErr) { res.end(JSON.stringify({ success: false, error: guardErr })); return; }
      if (!isIntegerArray(removedHandIds ?? [])) { res.end(JSON.stringify({ success: false, error: "Invalid removedHandIds" })); return; }

      const response = { removedHandIds: (removedHandIds ?? []) as number[] };
      const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createDefaultIdempotencyKey("switchHands", "switchHands", response);
      const queued = setPendingMcpCommand(who, "switchHands", response, key);
      res.end(JSON.stringify(buildQueuedResponse(queued, key)));
      break;
    }

    case "selectCard": {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const err = failIfNoPendingRpc(bridge, "selectCard");
      if (err) { res.end(JSON.stringify({ success: false, error: err })); return; }

      const body: any = await readJsonBody(req);
      const { selectedDefinitionId, idempotencyKey, expectedPendingMethod, expectedSnapshotUpdatedAt } = body;
      const guardErr = validateSnapshotGuard(bridge, expectedPendingMethod, expectedSnapshotUpdatedAt);
      if (guardErr) { res.end(JSON.stringify({ success: false, error: guardErr })); return; }
      if (!Number.isInteger(selectedDefinitionId)) { res.end(JSON.stringify({ success: false, error: "Invalid selectedDefinitionId" })); return; }

      const response = { selectedDefinitionId };
      const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : createDefaultIdempotencyKey("selectCard", "selectCard", response);
      const queued = setPendingMcpCommand(who, "selectCard", response, key);
      res.end(JSON.stringify(buildQueuedResponse(queued, key)));
      break;
    }

    case "state": {
      if (!snapshot.state) { res.end(JSON.stringify({ error: "Game not initialized" })); return; }
      // Return only this player's perspective
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
      // Only allow opponent deck if MCP_ALLOW_OPP_DECK is set
      if (targetWho !== who && !isOpponentDeckAllowed()) {
        res.end(JSON.stringify({ error: "Opponent deck access is disabled" }));
        return;
      }
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
      const effects = getActionEffects(who);
      clearActionEffects(who);
      res.end(JSON.stringify({ who, effects }));
      break;
    }

    default: {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Unknown MCP endpoint: /api/mcp/${who}/${path}` }));
    }
  }
}

function buildQueuedResponse(
  queued: { ok: boolean; reason?: string; command?: any; idempotentHit?: boolean; alreadyResolved?: boolean; lastResult?: any },
  key: string,
) {
  return {
    success: queued.ok,
    message: queued.ok
      ? queued.alreadyResolved ? "Already resolved (idempotent)"
      : queued.idempotentHit ? "Already queued (idempotent)"
      : "Queued"
      : queued.reason,
    commandId: queued.command?.id ?? null,
    idempotencyKey: key,
    idempotentHit: !!queued.idempotentHit,
    alreadyResolved: !!queued.alreadyResolved,
    lastCommandResult: queued.lastResult ?? null,
  };
}
