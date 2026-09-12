import { buildToolCallResult } from "./MCPProtocol";

const OPPONENT_DECK_ENV = "MCP_ALLOW_OPP_DECK";

export function isOpponentDeckAllowed(): boolean {
  const raw = process.env[OPPONENT_DECK_ENV];
  if (!raw) {
    return true;
  }
  const normalized = raw.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function buildStructuredError(
  errorCode: string,
  message: string,
  recoverHint: string,
  extra: Record<string, unknown> = {}
) {
  return buildToolCallResult(
    JSON.stringify({
      ok: false,
      error_code: errorCode,
      message,
      recover_hint: recoverHint,
      ...extra,
    }),
    true
  );
}

export function checkDiceRequirement(
  requiredCost: Array<{ type?: number; count?: number }>,
  usedDice: number[]
): boolean {
  const VOID = 0;
  const OMNI = 8;
  const ALIGNED = 8;
  const ENERGY = 9;

  const requirementEntries = requiredCost.filter(
    (entry) => Number.isInteger(entry.type) && Number.isInteger(entry.count) && (entry.count as number) > 0,
  );

  const alignedEntry = requirementEntries.find((entry) => entry.type === ALIGNED);
  if (alignedEntry) {
    const requiredCount = alignedEntry.count as number;
    if (requiredCount !== usedDice.length) {
      return false;
    }
    const chosenSet = new Set(usedDice);
    return (
      (chosenSet.size === 0 && requiredCount === 0) ||
      chosenSet.size === 1 ||
      (chosenSet.size === 2 && chosenSet.has(OMNI))
    );
  }

  const requiredList: number[] = [];
  for (const entry of requirementEntries) {
    const type = entry.type as number;
    const count = entry.count as number;
    for (let i = 0; i < count; i++) {
      requiredList.push(type);
    }
  }

  const chosen = [...usedDice];
  let voidCount = 0;
  for (const req of requiredList) {
    if (req === ENERGY) {
      continue;
    }
    if (req === VOID) {
      voidCount++;
      continue;
    }
    const sameTypeIndex = chosen.indexOf(req);
    if (sameTypeIndex !== -1) {
      chosen.splice(sameTypeIndex, 1);
      continue;
    }
    const omniIndex = chosen.indexOf(OMNI);
    if (omniIndex === -1) {
      return false;
    }
    chosen.splice(omniIndex, 1);
  }

  return chosen.length === voidCount;
}
