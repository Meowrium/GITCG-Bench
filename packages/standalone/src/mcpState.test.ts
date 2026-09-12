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

import { describe, expect, test } from "bun:test"
import {
  getMcpBridgeStatus,
  markGameOver,
  recordMcpIoError,
  resetMcpBridgeForNewGame,
  updateMcpBridgeSnapshot,
} from "./mcpState"

describe("mcpState", () => {
  test("records IO errors for the reported player", () => {
    recordMcpIoError(1, {
      who: 1,
      message: "switchHands return unknown card -1",
      phase: "initHands",
      pendingMethod: "switchHands",
    })

    expect(getMcpBridgeStatus(1).lastIoError).toMatchObject({
      who: 1,
      message: "switchHands return unknown card -1",
      phase: "initHands",
      pendingMethod: "switchHands",
    })
    expect(getMcpBridgeStatus(0).lastIoError).toBeNull()
  })

  test("markGameOver atomically flags the bridge as game-over with the winner", () => {
    // Seed a snapshot with a stale pending RPC.
    updateMcpBridgeSnapshot(0, {
      hasPendingRpc: true,
      pendingMethod: "action",
      pendingRequest: null,
      gamePhase: "5",
      currentPlayer: 0,
      round: 3,
      state: {},
      screen: {},
      deckInfo: null,
      actionEffects: [],
    })
    expect(getMcpBridgeStatus(0).snapshot.gameOver).toBe(false)

    const snapshot = markGameOver(0, 1)

    expect(snapshot.gameOver).toBe(true)
    expect(snapshot.winner).toBe(1)
    // markGameOver clears any stale pending RPC so AI polling stops waiting.
    expect(snapshot.hasPendingRpc).toBe(false)
    expect(snapshot.pendingMethod).toBeNull()
    // Status endpoint reflects the new fields.
    expect(getMcpBridgeStatus(0).snapshot.gameOver).toBe(true)
    expect(getMcpBridgeStatus(0).snapshot.winner).toBe(1)
  })

  test("markGameOver accepts null winner for a draw", () => {
    markGameOver(1, null)
    expect(getMcpBridgeStatus(1).snapshot.gameOver).toBe(true)
    expect(getMcpBridgeStatus(1).snapshot.winner).toBeNull()
  })

  test("resetMcpBridgeForNewGame clears the game-over signal for the next game", () => {
    markGameOver(0, 1)
    expect(getMcpBridgeStatus(0).snapshot.gameOver).toBe(true)

    resetMcpBridgeForNewGame(0)

    expect(getMcpBridgeStatus(0).snapshot.gameOver).toBe(false)
    expect(getMcpBridgeStatus(0).snapshot.winner).toBeNull()
  })

  test("updateMcpBridgeSnapshot propagates gameOver + winner from a sync payload", () => {
    updateMcpBridgeSnapshot(1, {
      hasPendingRpc: false,
      pendingMethod: null,
      pendingRequest: null,
      gamePhase: "gameEnd",
      currentPlayer: -1,
      round: 5,
      state: {},
      screen: {},
      deckInfo: null,
      actionEffects: [],
      gameOver: true,
      winner: 0,
    })
    const snapshot = getMcpBridgeStatus(1).snapshot
    expect(snapshot.gameOver).toBe(true)
    expect(snapshot.winner).toBe(0)
  })
})

