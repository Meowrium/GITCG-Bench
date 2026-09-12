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
  DiceType,
} from "@gi-tcg/typings";
import { chooseDice } from "@gi-tcg/utils";
import type { ActionInfoWithModification } from "./internal-types.js";
import type { ActionDescription, SimResult } from "../search/types.js";
import { getCharacterSkillProfile } from "../../knowledge/character-skill-profiles.js";
import {
  getCachedLegalActions,
  getCachedLegalActionsWithMeta,
} from "./legal-actions-cache.js";

export class SimAdapter {
  private readonly data: CreateInitialStateConfig["data"];

  constructor(data: CreateInitialStateConfig["data"]) {
    this.data = data;
  }

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

  async legalActions(state: GameState): Promise<ActionInfoWithModification[]> {
    return getCachedLegalActions(state);
  }

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
            // C1/C3: opponent stub only needs the declareEnd index.
            // Use the cached slate (keyed by current engine state) so we
            // never re-run ActionPreviewer for opponent-turn lookups.
            // The engine indexes `chosenActionIndex` into the *full* slate
            // (see core/src/game.ts:723-730), so we use the engine-side
            // index `declareEndIndexFull`.
            const meta = await getCachedLegalActionsWithMeta(game.state);
            if (meta.declareEndIndexFull < 0) {
              // Invariant: `availableActions()` during an action phase
              // always appends `declareEnd` last with VALID validity
              // (core/src/game.ts: skills → cards/tuning → switch →
              // declareEnd; no modifyAction* event invalidates it).
              // Reaching here means the engine's action-slate construction
              // semantics changed — fail loudly instead of silently picking
              // `actions[0]` (which could be a real skill/playCard and would
              // corrupt opponent-turn rollouts in search).
              throw new Error(
                `SimAdapter opponent stub: declareEnd not found in action-phase slate for player ${playerWho}. This indicates an engine semantic change; the cache fast-path is no longer safe.`,
              );
            }
            return rpcResp("action", {
              chosenActionIndex: meta.declareEndIndexFull,
              usedDice: [],
            });
          }
          case "chooseActive": {
            const candidates = (request.request?.value as { candidateIds?: number[] })?.candidateIds ?? [];
            return rpcResp("chooseActive", {
              activeCharacterId: pickBestCharacter(game.state, playerWho, candidates),
            });
          }
          case "selectCard": {
            const candidates = (request.request?.value as { candidateDefinitionIds?: number[] })?.candidateDefinitionIds ?? [];
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

    let pauseCount = 0;
    game.onPause = async (pauseState) => {
      finalState = pauseState;
      pauseCount++;
      if (actionSubmitted && pauseCount > 1) {
        game.terminate();
      }
    };

    try {
      await game.start();
    } catch {
      // termination can reject
    }

    finalState = game.state;

    return {
      newState: finalState,
      exposedMutations: collectedMutations,
      stopped: false,
    };
  }

  async stepByDescription(
    state: GameState,
    desc: ActionDescription,
  ): Promise<SimResult> {
    const actions = await this.legalActions(state);
    const idx = findMatchingAction(actions, desc);
    if (idx === -1) {
      throw new Error(`No matching action found: ${JSON.stringify(desc)}`);
    }
    return this.step(state, idx, actions);
  }
}


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
  let bestPri = 0;
  for (const id of candidateIds) {
    const ch = state.players[who].characters.find((c) => c.id === id);
    if (!ch) continue;
    const hp = ch.variables.health;
    // Opening priority from character skill profile
    const defId = (ch.definition as { id?: number })?.id;
    const profile = defId ? getCharacterSkillProfile(defId) : null;
    const pri = profile?.openingPriority ?? 0;

    if (hp > bestHp || (hp === bestHp && pri > bestPri)) {
      bestHp = hp;
      bestPri = pri;
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
        ) return i;
        break;
      case "declareEnd":
        return i;
    }
  }
  return -1;
}

function rpcResp(method: string, value: Record<string, unknown>): RpcResponse {
  return { response: { $case: method as never, value: value as never } };
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
