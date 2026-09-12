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

import type { StandaloneMcpClient } from "../StandaloneMcpClient";
import { checkDiceRequirement } from "./shared-utils";

const ACTION_CASE_NAMES = ["useSkill", "playCard", "switchActive", "elementalTuning", "declareEnd"];

export class StandaloneActionExecutor {
  private client: StandaloneMcpClient;

  constructor(client: StandaloneMcpClient) {
    this.client = client;
  }

  private extractOneofValue(pendingRequest: unknown, caseName: string): Record<string, unknown> | null {
    if (!pendingRequest || typeof pendingRequest !== "object") return null;
    const pr = pendingRequest as Record<string, unknown>;
    if (pr.$case === caseName && pr.value && typeof pr.value === "object") {
      return pr.value as Record<string, unknown>;
    }
    const inline = pr[caseName];
    if (inline && typeof inline === "object") {
      return inline as Record<string, unknown>;
    }
    return null;
  }

  private extractOneofCase(envelope: unknown, knownNames: string[]): string | null {
    if (!envelope || typeof envelope !== "object") return null;
    const obj = envelope as Record<string, unknown>;
    if (typeof obj.$case === "string" && knownNames.includes(obj.$case)) {
      return obj.$case;
    }
    for (const name of knownNames) {
      if (name in obj) return name;
    }
    return null;
  }

  private extractIntArray(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((v) => Number.isInteger(v)) : [];
  }

  private validateDiceSelection(availableDice: number[] | null, selectedDice: number[], fieldName: string): string | null {
    if (!Array.isArray(availableDice)) {
      return null;
    }
    const remaining = [...availableDice];
    for (const die of selectedDice) {
      const idx = remaining.indexOf(die);
      if (idx === -1) {
        return `Invalid ${fieldName}: dice type ${die} is not available in current dice pool`;
      }
      remaining.splice(idx, 1);
    }
    return null;
  }

  private validateCardSelection(availableIds: number[] | null, selectedIds: number[], fieldName: string): string | null {
    if (!Array.isArray(availableIds)) {
      return null;
    }
    const remaining = [...availableIds];
    for (const id of selectedIds) {
      const idx = remaining.indexOf(id);
      if (idx === -1) {
        return `Invalid ${fieldName}: id ${id} is not available`;
      }
      remaining.splice(idx, 1);
    }
    return null;
  }

  private buildCommandContext(status: any, expectedMethod: string, skipStatePoll?: boolean) {
    return {
      expectedPendingMethod: expectedMethod,
      expectedSnapshotUpdatedAt:
        typeof status?.snapshotUpdatedAt === "number" ? status.snapshotUpdatedAt : undefined,
      skipStatePoll,
    };
  }

  /**
   * Whether the pending action at actionIndex (1-indexed) is a fast action
   * (playCard / switchActive / elementalTuning with isFast=true).
   * Fast actions do not change pendingMethod / gamePhase / currentPlayer,
   * so the post-execution state-polling loop in StandaloneMcpClient.chooseAction
   * must be skipped (skipStatePoll=true) to avoid a false 18s timeout that
   * would otherwise return success=false despite the command being queued.
   */
  isActionFast(pendingRequest: unknown, actionIndex: number): boolean {
    const pr = pendingRequest as Record<string, unknown> | null | undefined;
    if (!pr) return false;
    const actionData = pr.$case === "action" ? pr.value : pr.action;
    if (actionData && typeof actionData === "object" && Array.isArray((actionData as any).action)) {
      const actions = (actionData as any).action as any[];
      const selected = actions[actionIndex - 1];
      return selected?.isFast === true;
    }
    return false;
  }

  private resolveElementalTuningAction(
    actions: any[],
    removedCardId?: number,
    targetDice?: number,
  ): { actionIndex: number; action: any } | null {
    const candidates = actions
      .map((action, actionIndex) => ({ action, actionIndex }))
      .filter(({ action }) => this.extractOneofCase(action?.action, ACTION_CASE_NAMES) === "elementalTuning" && action?.validity === 0)
      .filter(({ action }) => {
        if (!Number.isInteger(removedCardId)) {
          return true;
        }
        const etData = this.extractOneofValue(action?.action, "elementalTuning");
        return etData?.removedCardId === removedCardId;
      })
      .filter(({ action }) => {
        if (!Number.isInteger(targetDice)) {
          return true;
        }
        const etData = this.extractOneofValue(action?.action, "elementalTuning");
        return etData?.targetDice === targetDice;
      });

    return candidates[0] ?? null;
  }

  async executeChooseAction(
    args: Record<string, unknown>,
    status: any,
    ensurePlan: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
    errorCode?: string;
  }> {
    const planGuard = await ensurePlan();
    if (!planGuard.ok) {
      return { ok: false, error: planGuard.error, errorCode: "PLAN_V1_CREATE_FAILED" };
    }

    const actionIndex = args.action_index;
    if (!Number.isInteger(actionIndex) || (actionIndex as number) <= 0) {
      return {
        ok: false,
        error: "Invalid action_index: must be an integer starting from 1",
        errorCode: "INVALID_ACTION_INDEX",
      };
    }

    const usedDiceRaw = args.used_dice;
    if (
      typeof usedDiceRaw !== "undefined" &&
      (!Array.isArray(usedDiceRaw) || usedDiceRaw.some((d) => !Number.isInteger(d)))
    ) {
      return {
        ok: false,
        error: "Invalid used_dice: must be an integer array",
        errorCode: "INVALID_USED_DICE",
      };
    }
    const usedDice = (usedDiceRaw as number[]) || [];

    const pendingRequest = status.pendingRequest as any;
    const actionData = this.extractOneofValue(pendingRequest, "action");
    if (actionData && Array.isArray(actionData.action)) {
      const actions = actionData.action as any[];
      const selectedAction = actions[(actionIndex as number) - 1];
      if (!selectedAction) {
        return {
          ok: false,
          error: `Invalid action_index: must be between 1 and ${actions.length}`,
          errorCode: "INVALID_ACTION_INDEX",
        };
      }
      if (selectedAction.validity !== 0) {
        return {
          ok: false,
          error: `Invalid action_index: selected action is not valid (validity=${selectedAction.validity})`,
          errorCode: "INVALID_ACTION",
        };
      }
      if (!checkDiceRequirement(selectedAction.requiredCost ?? [], usedDice)) {
        return {
          ok: false,
          error: "Invalid used_dice: selected dice do not satisfy the required cost of chosen action",
          errorCode: "INVALID_USED_DICE",
        };
      }
      // Verify cached action_case matches current pending action (stale digest guard)
      const expectedActionCase = args.expected_action_case;
      if (typeof expectedActionCase === "string" && expectedActionCase.length > 0) {
        const freshActionCase = this.extractOneofCase(selectedAction.action, ACTION_CASE_NAMES) ?? "unknown";
        if (freshActionCase !== expectedActionCase) {
          return {
            ok: false,
            error: `Action case mismatch: cached digest expects '${expectedActionCase}' but current pending action at index ${actionIndex} is '${freshActionCase}'. Digest is stale — call get_turn_digest_v1 to get a fresh digest before submitting again.`,
            errorCode: "STALE_ACTION_CASE",
          };
        }
      }
    }

    const screen = await this.client.getScreenState().catch(() => null);
    const currentDice = (screen as any)?.player?.dice;
    const diceValidationError = this.validateDiceSelection(
      Array.isArray(currentDice) ? (currentDice as number[]) : null,
      usedDice,
      "used_dice",
    );
    if (diceValidationError) {
      return {
        ok: false,
        error: diceValidationError,
        errorCode: "INVALID_USED_DICE",
      };
    }

    const isFast = this.isActionFast(status.pendingRequest, actionIndex as number);
    const actionContext = this.buildCommandContext(status, "action", isFast);
    if (typeof args.explanation === "string") {
      actionContext.explanation = args.explanation;
    }
    const result = await this.client.chooseAction(
      actionIndex as number,
      usedDice,
      actionContext,
    );

    // Command was queued (commandId non-null) — treat as success regardless of
    // the 18s state-poll outcome or idempotent hits.  Fast actions don't change
    // pendingMethod/gamePhase/currentPlayer, so the polling loop in chooseAction
    // would always time out and return success=false with a valid commandId.
    if (result.commandId != null) {
      return { ok: true, result: { ...result, success: true } };
    }

    // Idempotent alreadyResolved: previous command with same key succeeded.
    const lastResult = result.lastCommandResult as { success?: boolean; id?: string } | null;
    if (result.alreadyResolved && lastResult?.success) {
      return {
        ok: true,
        result: { ...result, success: true, commandId: lastResult.id },
      };
    }

    // Genuine failure (bridge rejected, network error, etc.)
    return {
      ok: false,
      error: result.error ?? result.message ?? "choose_action rejected by bridge",
      errorCode: result.errorCode ?? "EXECUTION_ERROR",
    };
  }

  async executeElementalTuning(
    args: Record<string, unknown>,
    status: any,
    executeChooseAction: (args: Record<string, unknown>) => Promise<any>,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
  }> {
    const removedCardId = args.removed_card_id;
    if (typeof removedCardId !== "undefined" && !Number.isInteger(removedCardId)) {
      return { ok: false, error: "Invalid removed_card_id: must be an integer" };
    }

    const targetDice = args.target_dice;
    if (typeof targetDice !== "undefined" && !Number.isInteger(targetDice)) {
      return { ok: false, error: "Invalid target_dice: must be an integer" };
    }

    const usedDiceRaw = args.used_dice;
    if (
      typeof usedDiceRaw !== "undefined" &&
      (!Array.isArray(usedDiceRaw) || usedDiceRaw.some((d) => !Number.isInteger(d)))
    ) {
      return { ok: false, error: "Invalid used_dice: must be an integer array" };
    }

    const pendingRequest = status.pendingRequest as any;
    const actionData = this.extractOneofValue(pendingRequest, "action");
    const actions = actionData && Array.isArray(actionData.action)
      ? (actionData.action as any[])
      : [];

    const resolved = this.resolveElementalTuningAction(
      actions,
      removedCardId as number | undefined,
      targetDice as number | undefined,
    );

    if (!resolved) {
      return { ok: false, error: "No valid elemental tuning action matches the provided filters" };
    }

    const autoSelected = Array.isArray(resolved.action?.autoSelectedDice)
      ? (resolved.action.autoSelectedDice as unknown[]).filter((d): d is number => Number.isInteger(d))
      : [];
    const usedDice = Array.isArray(usedDiceRaw)
      ? (usedDiceRaw as number[])
      : autoSelected;

    return executeChooseAction({
      action_index: resolved.actionIndex + 1,
      used_dice: usedDice,
    });
  }

  async executeChooseActive(
    args: Record<string, unknown>,
    status: any,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
  }> {
    const characterId = args.character_id;
    if (!Number.isInteger(characterId)) {
      return { ok: false, error: "Invalid character_id: must be an integer" };
    }

    const pendingRequest = status.pendingRequest as any;
    const chooseActiveData = this.extractOneofValue(pendingRequest, "chooseActive");
    if (chooseActiveData) {
      const candidateIds = this.extractIntArray(chooseActiveData.candidateIds);
      if (candidateIds.length > 0 && !candidateIds.includes(characterId as number)) {
        return {
          ok: false,
          error: `Invalid character_id: must be one of candidate ids ${JSON.stringify(candidateIds)}`,
        };
      }
    }

    const result = await this.client.chooseActive(
      characterId as number,
      this.buildCommandContext(status, "chooseActive"),
    );
    return { ok: true, result };
  }

  async executeRerollDice(
    args: Record<string, unknown>,
    status: any,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
  }> {
    const diceToRerollRaw = args.dice_to_reroll;
    if (!Array.isArray(diceToRerollRaw) || diceToRerollRaw.some((d) => !Number.isInteger(d))) {
      return { ok: false, error: "Invalid dice_to_reroll: must be an integer array of dice types" };
    }
    const diceToReroll = diceToRerollRaw as number[];

    const screen = await this.client.getScreenState().catch(() => null);
    const currentDice = (screen as any)?.player?.dice;
    const diceValidationError = this.validateDiceSelection(
      Array.isArray(currentDice) ? (currentDice as number[]) : null,
      diceToReroll,
      "dice_to_reroll",
    );
    if (diceValidationError) {
      return { ok: false, error: diceValidationError };
    }

    const result = await this.client.rerollDice(
      diceToReroll,
      this.buildCommandContext(status, "rerollDice"),
    );
    return { ok: true, result };
  }

  async executeSwitchHands(
    args: Record<string, unknown>,
    status: any,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
  }> {
    const removedHandIdsRaw = args.removed_hand_ids;
    if (!Array.isArray(removedHandIdsRaw) || removedHandIdsRaw.some((id) => !Number.isInteger(id))) {
      return { ok: false, error: "Invalid removed_hand_ids: must be an integer array" };
    }
    const removedHandIds = removedHandIdsRaw as number[];

    const screen = await this.client.getScreenState().catch(() => null);
    const handCards = (screen as any)?.player?.handCard;
    const handCardIds = Array.isArray(handCards)
      ? handCards
          .map((card: any) => card?.id)
          .filter((id: any) => Number.isInteger(id))
      : null;
    const handValidationError = this.validateCardSelection(
      Array.isArray(handCardIds) ? (handCardIds as number[]) : null,
      removedHandIds,
      "removed_hand_ids",
    );
    if (handValidationError) {
      return { ok: false, error: handValidationError };
    }

    const result = await this.client.switchHands(
      removedHandIds,
      this.buildCommandContext(status, "switchHands"),
    );
    return { ok: true, result };
  }

  async executeSelectCard(
    args: Record<string, unknown>,
    status: any,
  ): Promise<{
    ok: boolean;
    result?: any;
    error?: string;
  }> {
    const selectedDefinitionId = args.selected_definition_id;
    if (!Number.isInteger(selectedDefinitionId)) {
      return { ok: false, error: "Invalid selected_definition_id: must be an integer" };
    }

    const pendingRequest = status.pendingRequest as any;
    const selectCardData = this.extractOneofValue(pendingRequest, "selectCard");
    if (selectCardData) {
      const candidateDefinitionIds = this.extractIntArray(selectCardData.candidateDefinitionIds);
      if (candidateDefinitionIds.length > 0 && !candidateDefinitionIds.includes(selectedDefinitionId as number)) {
        return {
          ok: false,
          error: `Invalid selected_definition_id: must be one of candidate definition ids ${JSON.stringify(candidateDefinitionIds)}`,
        };
      }
    }

    const result = await this.client.selectCard(
      selectedDefinitionId as number,
      this.buildCommandContext(status, "selectCard"),
    );
    return { ok: true, result };
  }

  async executeActionDispatch(
    tool: string,
    args: Record<string, unknown>,
    dispatchCtx?: { skipStatePoll?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const liveStatus = await this.client.getStatus().catch(() => null);
      switch (tool) {
        case "choose_action": {
          const isFast = this.isActionFast(liveStatus?.pendingRequest, args.action_index as number);
          const actionCtx = {
            ...this.buildCommandContext(liveStatus ?? {}, "action"),
            skipStatePoll: dispatchCtx?.skipStatePoll ?? isFast,
          };
          if (typeof args.explanation === "string") {
            actionCtx.explanation = args.explanation;
          }
          const result = await this.client.chooseAction(
            args.action_index as number,
            (args.used_dice as number[]) ?? [],
            actionCtx,
          );
          if (result?.alreadyResolved || result?.idempotentHit) {
            if (result?.commandId != null) {
              return { ok: true };
            }
            const lastResult = result?.lastCommandResult as { success?: boolean } | null;
            if (result?.alreadyResolved && lastResult?.success) {
              return { ok: true };
            }
            return {
              ok: result?.commandId != null,
              error: result?.commandId != null ? undefined
                : "Idempotent hit but no command was queued. Retry with a fresh digest.",
            };
          }
          return {
            ok: result?.commandId != null,
            error: result?.commandId != null ? undefined
              : (result as any)?.error ?? (result as any)?.message ?? "choose_action rejected by bridge",
          };
        }
        case "choose_active": {
          const result = await this.client.chooseActive(
            args.character_id as number,
            this.buildCommandContext(liveStatus ?? {}, "chooseActive"),
          );
          if (result?.alreadyResolved || result?.idempotentHit) {
            return {
              ok: result?.commandId != null,
              error: result?.commandId != null ? undefined
                : "Idempotent hit but no command was queued — game may not have advanced. Retry with a fresh status.",
            };
          }
          return { ok: !!result?.success, error: result?.success ? undefined : (result as any)?.error ?? "chooseActive rejected by bridge" };
        }
        case "reroll_dice": {
          const result = await this.client.rerollDice(
            (args.dice_to_reroll as number[]) ?? [],
            this.buildCommandContext(liveStatus ?? {}, "rerollDice"),
          );
          if (result?.alreadyResolved || result?.idempotentHit) {
            return {
              ok: result?.commandId != null,
              error: result?.commandId != null ? undefined
                : "Idempotent hit but no command was queued — game may not have advanced. Retry with a fresh status.",
            };
          }
          return { ok: !!result?.success, error: result?.success ? undefined : (result as any)?.error ?? "rerollDice rejected by bridge" };
        }
        case "switch_hands": {
          const result = await this.client.switchHands(
            (args.removed_hand_ids as number[]) ?? [],
            this.buildCommandContext(liveStatus ?? {}, "switchHands"),
          );
          if (result?.alreadyResolved || result?.idempotentHit) {
            return {
              ok: result?.commandId != null,
              error: result?.commandId != null ? undefined
                : "Idempotent hit but no command was queued — game may not have advanced. Retry with a fresh status.",
            };
          }
          return { ok: !!result?.success, error: result?.success ? undefined : (result as any)?.error ?? "switchHands rejected by bridge" };
        }
        case "select_card": {
          const result = await this.client.selectCard(
            args.selected_definition_id as number,
            this.buildCommandContext(liveStatus ?? {}, "selectCard"),
          );
          if (result?.alreadyResolved || result?.idempotentHit) {
            return {
              ok: result?.commandId != null,
              error: result?.commandId != null ? undefined
                : "Idempotent hit but no command was queued — game may not have advanced. Retry with a fresh status.",
            };
          }
          return { ok: !!result?.success, error: result?.success ? undefined : (result as any)?.error ?? "selectCard rejected by bridge" };
        }
        default:
          return { ok: false, error: `Unknown tool: ${tool}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}
