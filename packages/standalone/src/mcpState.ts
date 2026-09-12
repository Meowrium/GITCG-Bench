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

type PendingMethod = "action" | "chooseActive" | "rerollDice" | "switchHands" | "selectCard";
type Who = 0 | 1;

export interface McpBridgeSnapshot {
  aiPlayerWho: Who;
  hasPendingRpc: boolean;
  pendingMethod: string | null;
  pendingRequest: unknown;
  gamePhase: string;
  currentPlayer: number;
  round: number;
  state: unknown;
  screen: unknown;
  deckInfo: unknown;
  updatedAt: number;
  /** Accumulated action effects since last read by MCP client */
  actionEffects: unknown[];
  /** Explicit game-over flag. True once the underlying Game reaches the
   *  `gameEnd` phase (or is terminated). Stays true until the bridge is
   *  reset for a new game. Lets MCP clients short-circuit `wait_for_my_turn`
   *  without parsing the protobuf phase enum. */
  gameOver: boolean;
  /** Winner (0 | 1) when `gameOver` is true, null for a draw / unknown. */
  winner: number | null;
}

export interface PendingMcpCommand {
  id: string;
  who: Who;
  method: PendingMethod;
  payload: unknown;
  idempotencyKey: string;
  createdAt: number;
}

export interface McpCommandResult {
  id: string;
  who: Who;
  method: PendingMethod;
  idempotencyKey: string;
  success: boolean;
  message?: string;
  resolvedAt: number;
}

export interface McpIoError {
  who: number | null;
  message: string;
  at: number;
  phase: string | null;
  pendingMethod: string | null;
}

export interface McpBridgeStatus {
  connected: boolean;
  stale: boolean;
  snapshot: McpBridgeSnapshot;
  hasPendingCommand: boolean;
  pendingCommandId: string | null;
  lastCommandResult: McpCommandResult | null;
  lastIoError: McpIoError | null;
}

const STALE_TIMEOUT_MS = 30_000;
const RESOLVED_CACHE_LIMIT = 200;
const IDEMPOTENCY_CACHE_TTL_MS = 60_000;

const defaultSnapshot = (who: Who): McpBridgeSnapshot => ({
  aiPlayerWho: who,
  hasPendingRpc: false,
  pendingMethod: null,
  pendingRequest: null,
  gamePhase: "not_started",
  currentPlayer: -1,
  round: 0,
  state: null,
  screen: null,
  deckInfo: null,
  updatedAt: 0,
  actionEffects: [],
  gameOver: false,
  winner: null,
});

// Per-player state
const snapshots: Record<Who, McpBridgeSnapshot> = {
  0: defaultSnapshot(0),
  1: defaultSnapshot(1),
};

const connected: Record<Who, boolean> = { 0: false, 1: false };
const pendingCommands: Record<Who, PendingMcpCommand | null> = { 0: null, 1: null };
const lastCommandResults: Record<Who, McpCommandResult | null> = { 0: null, 1: null };
const lastIoErrors: Record<Who, McpIoError | null> = { 0: null, 1: null };
let commandSeq = 0;

const resolvedByIdempotency = new Map<string, McpCommandResult>();

const isPendingMethod = (value: string): value is PendingMethod => {
  return value === "action" ||
    value === "chooseActive" ||
    value === "rerollDice" ||
    value === "switchHands" ||
    value === "selectCard";
};

const isStaleSnapshot = (updatedAt: number): boolean => {
  if (!updatedAt) return true;
  return Date.now() - updatedAt > STALE_TIMEOUT_MS;
};

const trimResolvedCache = () => {
  if (resolvedByIdempotency.size <= RESOLVED_CACHE_LIMIT) return;
  const entries = [...resolvedByIdempotency.entries()]
    .sort((a, b) => a[1].resolvedAt - b[1].resolvedAt);
  const toDelete = entries.slice(0, entries.length - RESOLVED_CACHE_LIMIT);
  for (const [key] of toDelete) resolvedByIdempotency.delete(key);
};

export function updateMcpBridgeSnapshot(
  who: Who,
  next: Omit<McpBridgeSnapshot, "updatedAt" | "aiPlayerWho"> & { updatedAt?: number },
): McpBridgeSnapshot {
  const now = typeof next.updatedAt === "number" ? next.updatedAt : Date.now();
  snapshots[who] = {
    aiPlayerWho: who,
    hasPendingRpc: !!next.hasPendingRpc,
    pendingMethod: typeof next.pendingMethod === "string" ? next.pendingMethod : null,
    pendingRequest: next.pendingRequest ?? null,
    gamePhase: typeof next.gamePhase === "string" ? next.gamePhase : "not_started",
    currentPlayer: Number.isInteger(next.currentPlayer) ? next.currentPlayer : -1,
    round: Number.isInteger(next.round) ? next.round : 0,
    state: next.state ?? null,
    screen: next.screen ?? null,
    deckInfo: next.deckInfo ?? null,
    updatedAt: now,
    actionEffects: Array.isArray(next.actionEffects) ? next.actionEffects : [],
    gameOver: next.gameOver === true,
    winner: next.winner === 0 || next.winner === 1 ? next.winner : null,
  };
  connected[who] = true;
  return snapshots[who];
}

/**
 * Explicitly mark a player's bridge snapshot as game-over with the final
 * winner. Used by the standalone parent to "directly send" the end-of-game
 * signal to both AI players the moment the underlying Game reaches its
 * `gameEnd` phase, without waiting for the periodic snapshot sync timer.
 *
 * Unlike `updateMcpBridgeSnapshot`, this only sets the game-over fields and
 * leaves the rest of the snapshot (state/screen/round/...) untouched, so the
 * AI can still inspect the final board via get_game_state/get_screen_state.
 */
export function markGameOver(who: Who, winner: number | null): McpBridgeSnapshot {
  const snapshot = snapshots[who];
  snapshots[who] = {
    ...snapshot,
    gameOver: true,
    winner: winner === 0 || winner === 1 ? winner : null,
    // Clear any stale pending RPC — the game will never issue another one.
    hasPendingRpc: false,
    pendingMethod: null,
    pendingRequest: null,
  };
  connected[who] = true;
  return snapshots[who];
}

export function clearActionEffects(who: Who): void {
  snapshots[who].actionEffects = [];
}

export function getActionEffects(who: Who): unknown[] {
  return snapshots[who].actionEffects;
}

export function disconnectMcpBridge(who?: Who): void {
  if (typeof who === "number") {
    connected[who] = false;
    pendingCommands[who] = null;
  } else {
    connected[0] = false;
    connected[1] = false;
    pendingCommands[0] = null;
    pendingCommands[1] = null;
  }
}

/**
 * Reset per-player bridge state for a new game.
 * Clears idempotency cache (prevents "already resolved" false positives
 * when the AI repeats the same action across games) and stale commands.
 */
export function resetMcpBridgeForNewGame(who?: Who): void {
  if (typeof who === "number") {
    pendingCommands[who] = null;
    lastCommandResults[who] = null;
    snapshots[who].actionEffects = [];
    // Clear game-over signal so the next game starts fresh.
    snapshots[who].gameOver = false;
    snapshots[who].winner = null;
    // Clear idempotency entries for this player
    for (const [key, result] of resolvedByIdempotency) {
      if (result.who === who) resolvedByIdempotency.delete(key);
    }
  } else {
    pendingCommands[0] = null;
    pendingCommands[1] = null;
    lastCommandResults[0] = null;
    lastCommandResults[1] = null;
    snapshots[0].gameOver = false;
    snapshots[0].winner = null;
    snapshots[1].gameOver = false;
    snapshots[1].winner = null;
    resolvedByIdempotency.clear();
  }
}

export function getMcpBridgeStatus(who: Who): McpBridgeStatus {
  const snapshot = snapshots[who];
  const stale = connected[who] && isStaleSnapshot(snapshot.updatedAt);
  const pending = pendingCommands[who];
  return {
    connected: connected[who],
    stale,
    snapshot,
    hasPendingCommand: !!pending,
    pendingCommandId: pending?.id ?? null,
    lastCommandResult: lastCommandResults[who],
    lastIoError: lastIoErrors[who],
  };
}

export function getSnapshot(who: Who): McpBridgeSnapshot {
  return snapshots[who];
}

export function isConnected(who: Who): boolean {
  return connected[who];
}

export function getPendingMcpCommand(who: Who): PendingMcpCommand | null {
  return pendingCommands[who];
}

export function setPendingMcpCommand(
  who: Who,
  method: string,
  payload: unknown,
  idempotencyKey: string,
): {
  ok: boolean;
  reason?: string;
  command?: PendingMcpCommand;
  idempotentHit?: boolean;
  alreadyResolved?: boolean;
  lastResult?: McpCommandResult | null;
} {
  if (!isPendingMethod(method)) {
    return { ok: false, reason: `Unsupported method '${method}'` };
  }
  if (!connected[who]) {
    return { ok: false, reason: `Standalone bridge for player ${who} is not connected` };
  }
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return { ok: false, reason: "idempotencyKey is required" };
  }

  const normalizedKey = idempotencyKey.trim();
  const resolved = resolvedByIdempotency.get(normalizedKey);
  if (resolved && resolved.method === method && resolved.who === who) {
    if (Date.now() - resolved.resolvedAt < IDEMPOTENCY_CACHE_TTL_MS) {
      return {
        ok: true,
        alreadyResolved: true,
        idempotentHit: true,
        command: undefined,
        lastResult: resolved,
      };
    }
    resolvedByIdempotency.delete(normalizedKey);
  }

  const pending = pendingCommands[who];
  if (pending) {
    if (pending.idempotencyKey === normalizedKey && pending.method === method) {
      return {
        ok: true,
        idempotentHit: true,
        command: pending,
        lastResult: lastCommandResults[who],
      };
    }
    return {
      ok: false,
      reason: `Another command is pending for player ${who} (${pending.id})`,
      lastResult: lastCommandResults[who],
    };
  }

  commandSeq += 1;
  const command: PendingMcpCommand = {
    id: `mcp_p${who}_${Date.now()}_${commandSeq}`,
    who,
    method,
    payload,
    idempotencyKey: normalizedKey,
    createdAt: Date.now(),
  };
  pendingCommands[who] = command;
  return {
    ok: true,
    command,
    idempotentHit: false,
    alreadyResolved: false,
    lastResult: lastCommandResults[who],
  };
}

export function resolvePendingMcpCommand(
  id: string,
  success: boolean,
  message?: string,
): { ok: boolean; reason?: string; who?: Who } {
  for (const who of [0, 1] as Who[]) {
    const pending = pendingCommands[who];
    if (pending && pending.id === id) {
      const result: McpCommandResult = {
        id: pending.id,
        who: pending.who,
        method: pending.method,
        idempotencyKey: pending.idempotencyKey,
        success: !!success,
        message: typeof message === "string" ? message : undefined,
        resolvedAt: Date.now(),
      };
      lastCommandResults[who] = result;
      resolvedByIdempotency.set(result.idempotencyKey, result);
      trimResolvedCache();
      pendingCommands[who] = null;
      return { ok: true, who };
    }
  }
  return { ok: false, reason: `No pending command with id ${id}` };
}

export function recordMcpIoError(
  who: Who,
  error: {
    who?: number | null;
    message?: unknown;
    phase?: unknown;
    pendingMethod?: unknown;
    at?: unknown;
  },
): McpIoError {
  const normalized: McpIoError = {
    who: typeof error.who === "number" ? error.who : null,
    message: typeof error.message === "string" ? error.message : "Unknown IoError",
    at: typeof error.at === "number" ? error.at : Date.now(),
    phase: typeof error.phase === "string" ? error.phase : null,
    pendingMethod: typeof error.pendingMethod === "string" ? error.pendingMethod : null,
  };
  lastIoErrors[who] = normalized;
  return normalized;
}
