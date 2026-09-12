// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import {
  Game,
  type GameState,
  type DeckConfig,
  type CreateInitialStateConfig,
  type PlayerIO,
} from "@gi-tcg/core";
import {
  type ExposedMutation,
  type RpcResponse,
  ActionValidity,
  DiceType,
} from "@gi-tcg/typings";
import { chooseDice } from "@gi-tcg/utils";
import type { ActionInfoWithModification } from "./internal-types";
import type { SimResult, ActionDescription } from "./types";

/**
 * Layer 0: Simulation Engine Adapter
 *
 * Wraps @gi-tcg/core's Game class to provide a deterministic
 * (state, action) → state' interface for the search system.
 *
 * Strategy: use Game.availableActions() for legal action enumeration
 * (which internally runs the preview system), then use a full Game
 * instance with programmatic IO for state transitions.
 */
export class SimAdapter {
  private readonly data: CreateInitialStateConfig["data"];

  constructor(data: CreateInitialStateConfig["data"]) {
    this.data = data;
  }

  /**
   * Create an initial game state from two deck configurations.
   */
  createInitialState(
    deck0: DeckConfig,
    deck1: DeckConfig,
    opts?: Partial<Omit<CreateInitialStateConfig, "data" | "decks">>,
  ): GameState {
    return Game.createInitialState({
      data: this.data,
      decks: [deck0, deck1],
      ...opts,
    });
  }

  /**
   * Get all VALID legal actions for the current turn player.
   * Returns the internal ActionInfo objects for use with `step()`.
   */
  async legalActions(state: GameState): Promise<ActionInfoWithModification[]> {
    if (state.phase !== "action") return [];
    const game = new Game(state);
    try {
      const all = await game.availableActions();
      return all.filter((a) => a.validity === ActionValidity.VALID);
    } finally {
      game.terminate();
    }
  }

  /**
   * Execute a single action on a game state.
   *
   * This creates a Game from the given state, provides programmatic IO
   * that immediately responds with the chosen action, captures all
   * mutations, and returns the resulting state.
   *
   * The game is terminated after the action completes (one action phase).
   */
  async step(
    state: GameState,
    actionIndex: number,
    actions: ActionInfoWithModification[],
  ): Promise<SimResult> {
    const who = state.currentTurn as 0 | 1;
    const actionInfo = actions[actionIndex];
    if (!actionInfo) {
      throw new Error(`Invalid action index: ${actionIndex}`);
    }

    const collectedMutations: ExposedMutation[] = [];
    let finalState = state;
    let stopped = false;
    let actionSubmitted = false;

    const selectedDice = autoSelectDice(state.players[who].dice, actionInfo);
    const game = new Game(state);

    const makeIo = (playerWho: 0 | 1): PlayerIO => ({
      notify: (notification) => {
        if (notification.mutation) {
          for (const m of notification.mutation) {
            if (m.mutation) {
              const em = flattenMutation(m.mutation);
              if (em) collectedMutations.push(em);
            }
          }
        }
      },
      rpc: async (request): Promise<RpcResponse> => {
        const method = request.request?.$case;
        if (!method) throw new Error("Invalid RPC request");

        switch (method) {
          case "action": {
            if (!actionSubmitted && playerWho === who) {
              actionSubmitted = true;
              return rpcResp("action", {
                chosenActionIndex: actionIndex,
                usedDice: selectedDice,
              });
            }
            // Opponent turn or subsequent action: declare end
            const oppActions = await game.availableActions();
            const declareIdx = oppActions.findIndex(
              (a) => a.type === "declareEnd",
            );
            return rpcResp("action", {
              chosenActionIndex: declareIdx >= 0 ? declareIdx : 0,
              usedDice: [],
            });
          }
          case "chooseActive": {
            const candidates =
              (request.request?.value as any)?.candidateIds ?? [];
            const bestId = pickBestCharacter(
              game.state,
              playerWho,
              candidates,
            );
            return rpcResp("chooseActive", { activeCharacterId: bestId });
          }
          case "selectCard": {
            const candidates =
              (request.request?.value as any)?.candidateDefinitionIds ?? [];
            return rpcResp("selectCard", {
              selectedDefinitionId: candidates[0] ?? 0,
            });
          }
          case "rerollDice":
            return rpcResp("rerollDice", { diceToReroll: [] });
          case "switchHands":
            return rpcResp("switchHands", { removedHandIds: [] });
          default:
            throw new Error(`Unexpected RPC method: ${method}`);
        }
      },
    });

    game.players[0].io = makeIo(0);
    game.players[1].io = makeIo(1);

    // Capture state at each pause; terminate after our action completes.
    let pauseCount = 0;
    game.onPause = async (pauseState) => {
      finalState = pauseState;
      pauseCount++;
      // After our action has been submitted and a pause occurs, we're done.
      if (actionSubmitted && pauseCount > 1) {
        game.terminate();
      }
    };

    try {
      await game.start();
    } catch {
      // Expected: game.terminate() causes rejection
    }

    finalState = game.state;

    return {
      newState: finalState,
      exposedMutations: collectedMutations,
      stopped,
    };
  }

  /**
   * Step using a serializable ActionDescription.
   * Finds the matching action from legal actions and executes it.
   */
  async stepByDescription(
    state: GameState,
    desc: ActionDescription,
  ): Promise<SimResult> {
    const actions = await this.legalActions(state);
    const idx = findMatchingAction(actions, desc);
    if (idx === -1) {
      throw new Error(
        `No matching action found: ${JSON.stringify(desc)}`,
      );
    }
    return this.step(state, idx, actions);
  }
}

// ─── Helpers ───

function autoSelectDice(
  availableDice: readonly DiceType[],
  actionInfo: ActionInfoWithModification,
): DiceType[] {
  if (actionInfo.autoSelectedDice && actionInfo.autoSelectedDice.length > 0) {
    return [...actionInfo.autoSelectedDice];
  }
  const selected = chooseDice(actionInfo.cost, availableDice);
  return availableDice.filter((_, i) => selected[i]);
}

function pickBestCharacter(
  state: GameState,
  who: 0 | 1,
  candidateIds: readonly number[],
): number {
  if (candidateIds.length === 0) return 0;
  let bestId = candidateIds[0];
  let bestHp = -1;
  for (const id of candidateIds) {
    const ch = state.players[who].characters.find((c) => c.id === id);
    if (ch && ch.variables.health > bestHp) {
      bestHp = ch.variables.health;
      bestId = id;
    }
  }
  return bestId;
}

function findMatchingAction(
  actions: ActionInfoWithModification[],
  desc: ActionDescription,
): number {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.type !== desc.type) continue;
    switch (a.type) {
      case "useSkill":
        if (a.skill.definition.id === desc.definitionId) return i;
        break;
      case "playCard":
        if (a.skill.caller.definition.id === desc.definitionId) return i;
        break;
      case "switchActive":
        if (a.to.definition.id === desc.definitionId) return i;
        break;
      case "elementalTuning":
        if (
          desc.tuningCardDefinitionId !== undefined &&
          a.card.definition.id === desc.tuningCardDefinitionId
        )
          return i;
        break;
      case "declareEnd":
        return i;
    }
  }
  return -1;
}

function rpcResp(
  method: string,
  value: Record<string, unknown>,
): RpcResponse {
  return { response: { $case: method as any, value: value as any } };
}

function flattenMutation(
  mutation: { $case: string; value: unknown },
): ExposedMutation | null {
  if (!mutation.$case || mutation.value === undefined) return null;
  return {
    $case: mutation.$case,
    ...(mutation.value as object),
  } as ExposedMutation;
}
