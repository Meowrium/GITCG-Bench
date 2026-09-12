import { StandaloneMcpClient, type StandaloneGameState, type StandaloneStatus } from "../src/StandaloneMcpClient";
import { StandaloneMcpToolHandler } from "../src/mcp/StandaloneMcpToolHandler";

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ParsedToolResult = {
  isError: boolean;
  payload: Record<string, unknown>;
};

type SkillDocument = {
  skillId: string;
  skillPath: string;
  excerpt: string;
};

type ReasoningAssets = {
  promptText: string;
  promptExcerpt: string;
  skillDocuments: SkillDocument[];
};

type ReasonerProfile = {
  version: "ReasonerProfileV1";
  selectedSkills: string[];
  globalGoal: string;
  tacticalGoal: string;
  openingPriorities: string[];
  turnObjectives: string[];
  promptDirectives: string[];
  skillHints: string[];
  preferredActionCases: ActionCase[];
  avoidActionCases: ActionCase[];
  flags: {
    prioritizeAuraSetup: boolean;
    prioritizeReactionTempo: boolean;
    prioritizeSupportPlay: boolean;
    allowPivotSwitch: boolean;
    allowElementalTuning: boolean;
    avoidOmniWaste: boolean;
    preserveResources: boolean;
    protectCoreHp: boolean;
    forbidEarlyEnd: boolean;
  };
  summaryLines: string[];
};

type ReasonerProfileArtifact = {
  artifact_type: "ReasonerProfileArtifactV1";
  session_id: string;
  plan_id: string;
  shard_id: string;
  created_at: string;
  profile: ReasonerProfile;
};

type ActionCase = "useSkill" | "playCard" | "switchActive" | "elementalTuning" | "declareEnd" | "unknown";

type ActionCandidate = {
  index: number;
  actionCase: ActionCase;
  raw: Record<string, unknown>;
  requiredCost: Array<{ type: number; count: number }>;
  autoSelectedDice: number[];
  validity: number;
  isFast: boolean;
};

type ActionEvaluation = {
  index: number;
  actionCase: ActionCase;
  score: number;
  usedDice: number[];
  summary: string;
  reasons: string[];
};

function shouldSkipCriticEvaluation(actionRes: ParsedToolResult, chosen: ActionEvaluation | null): boolean {
  if (chosen) {
    return false;
  }
  const errorCode = typeof actionRes.payload.error_code === "string"
    ? actionRes.payload.error_code
    : "";
  return errorCode === "NO_ACTION_PENDING" || errorCode === "NO_EXECUTABLE_ACTION";
}

function getArgValue(flag: string): string | undefined {
  const args = ((globalThis as any).process?.argv?.slice(2) ?? []) as string[];
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function parseIntegerArg(flag: string, fallback: number): number {
  const raw = getArgValue(flag);
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseResult(result: ToolCallResult): ParsedToolResult {
  const text = result.content[0]?.text ?? "{}";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {
      ok: false,
      error_code: "TOOL_NON_JSON_ERROR",
      message: text,
    };
  }
  return {
    isError: result.isError === true,
    payload,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sumCost(requiredCost: Array<{ type: number; count: number }>): number {
  return requiredCost.reduce((total, entry) => total + entry.count, 0);
}

function clipText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizePath(path: string): string {
  const replaced = path.replace(/\\/g, "/");
  return replaced.replace(/\/+/g, "/");
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.length > 0).join("/"));
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getRuntimePlansDir(): string {
  return joinPath((((globalThis as any).process?.cwd?.() ?? ".") as string), "runtime-plans");
}

function getReasonerProfilePath(sessionId: string): string {
  return joinPath(getRuntimePlansDir(), `${sanitizeSessionId(sessionId)}_reasoner_profile.json`);
}

function dirnamePath(path: string): string {
  const normalized = normalizePath(path).replace(/\/$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return normalized;
  }
  return normalized.slice(0, lastSlash);
}

async function readTextIfExists(filePath: string | URL): Promise<string | null> {
  try {
    const bunMaybe = (globalThis as any).Bun;
    if (!bunMaybe?.file) {
      return null;
    }
    return await bunMaybe.file(filePath).text();
  } catch {
    return null;
  }
}

function resolveWorkspaceAssetUrl(relativePath: string): URL {
  const sanitized = relativePath.replace(/^(?:\.\/|[\\/])+/u, "");
  return new URL(`../../../../${sanitized}`, import.meta.url);
}

async function writeJsonArtifact(filePath: string, payload: unknown): Promise<void> {
  const bunMaybe = (globalThis as any).Bun;
  if (!bunMaybe?.write) {
    throw new Error("Bun.write is unavailable in current runtime.");
  }
  await bunMaybe.write(filePath, JSON.stringify(payload, null, 2));
}

async function loadReasoningAssets(selectedSkills: string[]): Promise<ReasoningAssets> {
  const promptPath = new URL("../prompt.txt", import.meta.url);
  console.log("[E2E] trace_assets_prompt_begin", JSON.stringify({
    prompt_path: promptPath.toString(),
  }, null, 2));
  const promptText = (await readTextIfExists(promptPath)) ?? "";
  console.log("[E2E] trace_assets_prompt_done", JSON.stringify({
    prompt_length: promptText.length,
  }, null, 2));
  const skillDocuments: SkillDocument[] = [];
  const skillIndexPath = resolveWorkspaceAssetUrl(".opencode/skills.index.json");
  console.log("[E2E] trace_assets_skill_index_begin", JSON.stringify({
    skill_index_path: skillIndexPath.toString(),
  }, null, 2));
  const skillIndexText = await readTextIfExists(skillIndexPath);
  console.log("[E2E] trace_assets_skill_index_done", JSON.stringify({
    skill_index_length: skillIndexText?.length ?? 0,
  }, null, 2));
  const skillIndex = skillIndexText ? JSON.parse(skillIndexText) as unknown : [];
  const skillPathMap = new Map<string, string>();

  if (Array.isArray(skillIndex)) {
    for (const entry of skillIndex) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const skillId = typeof record.skill_id === "string" ? record.skill_id : "";
      const skillPath = typeof record.skill_path === "string" ? record.skill_path : "";
      if (skillId && skillPath) {
        skillPathMap.set(skillId, skillPath);
      }
    }
  }

  for (const skillId of selectedSkills) {
    const relativePath = skillPathMap.get(skillId) ?? joinPath(".opencode", "skills", skillId, "SKILL.md");
    const skillUrl = resolveWorkspaceAssetUrl(relativePath);
    console.log("[E2E] trace_assets_skill_doc_begin", JSON.stringify({
      skill_id: skillId,
      skill_path: skillUrl.toString(),
    }, null, 2));
    const skillText = await readTextIfExists(skillUrl);
    console.log("[E2E] trace_assets_skill_doc_done", JSON.stringify({
      skill_id: skillId,
      skill_length: skillText?.length ?? 0,
    }, null, 2));
    if (!skillText) {
      continue;
    }
    skillDocuments.push({
      skillId,
      skillPath: skillUrl.toString(),
      excerpt: clipText(skillText, 1200),
    });
  }

  return {
    promptText,
    promptExcerpt: clipText(promptText, 1500),
    skillDocuments,
  };
}

function extractPendingActions(status: StandaloneStatus): ActionCandidate[] {
  const pendingRequest = status.pendingRequest as Record<string, unknown> | null | undefined;
  if (pendingRequest?.$case !== "action") {
    return [];
  }

  const value = pendingRequest.value as Record<string, unknown> | undefined;
  const actions = Array.isArray(value?.action) ? value.action : [];

  return actions.map((action, index) => {
    const record = (typeof action === "object" && action !== null ? action : {}) as Record<string, unknown>;
    const actionEnvelope = record.action as Record<string, unknown> | undefined;
    const actionCase = typeof actionEnvelope?.$case === "string" ? actionEnvelope.$case : "unknown";
    const requiredCost = Array.isArray(record.requiredCost)
      ? record.requiredCost.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const type = (entry as { type?: unknown }).type;
          const count = (entry as { count?: unknown }).count;
          if (!Number.isInteger(type) || !Number.isInteger(count)) {
            return [];
          }
          return [{ type: type as number, count: count as number }];
        })
      : [];
    const autoSelectedDice = Array.isArray(record.autoSelectedDice)
      ? record.autoSelectedDice.filter((die): die is number => Number.isInteger(die))
      : [];

    return {
      index: index + 1,
      actionCase: (
        actionCase === "useSkill" ||
        actionCase === "playCard" ||
        actionCase === "switchActive" ||
        actionCase === "elementalTuning" ||
        actionCase === "declareEnd"
      ) ? actionCase : "unknown",
      raw: record,
      requiredCost,
      autoSelectedDice,
      validity: Number.isInteger(record.validity) ? (record.validity as number) : -1,
      isFast: record.isFast === true,
    };
  });
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function collectTurnObjectives(planV2: Record<string, unknown>): string[] {
  if (!Array.isArray(planV2.turn_priorities)) {
    return [];
  }
  const result: string[] = [];
  for (const item of planV2.turn_priorities as Array<Record<string, unknown>>) {
    result.push(...normalizeStringArray(item.objectives));
  }
  return dedupeStrings(result);
}

function extractPromptDirectives(promptText: string): string[] {
  return dedupeStrings(
    promptText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-") || /^\d+\./.test(line))
      .map((line) => line.replace(/^[-\d.\s]+/, "").trim())
      .filter((line) => line.length > 0)
      .slice(0, 8),
  );
}

function extractSkillHints(skillDocuments: SkillDocument[]): string[] {
  const hintKeywords = [
    "reaction",
    "tempo",
    "switch",
    "pivot",
    "tuning",
    "support",
    "status",
    "aura",
    "附着",
    "反应",
    "节奏",
    "换人",
    "切人",
    "调和",
    "支援",
    "状态",
  ];
  const hints: string[] = [];
  for (const skill of skillDocuments) {
    const lowered = skill.excerpt.toLowerCase();
    const matched = hintKeywords.filter((keyword) => lowered.includes(keyword.toLowerCase()));
    if (matched.length > 0) {
      hints.push(`${skill.skillId}:${matched.slice(0, 4).join(",")}`);
    } else {
      hints.push(`${skill.skillId}:general`);
    }
  }
  return dedupeStrings(hints);
}

function buildReasonerProfile(
  assets: ReasoningAssets,
  selectedSkills: string[],
  planV1: Record<string, unknown>,
  planV2: Record<string, unknown>,
  shard: Record<string, unknown>,
): ReasonerProfile {
  const globalGoal = typeof planV1.global_goal === "string"
    ? planV1.global_goal
    : (typeof planV2.global_goal === "string" ? planV2.global_goal : "Secure opening tempo while preserving core HP.");
  const tacticalGoal = typeof shard.tactical_goal === "string"
    ? shard.tactical_goal
    : "Pick the highest-value legal action under opening constraints.";
  const openingPriorities = dedupeStrings(normalizeStringArray(planV1.turn1_3_priorities));
  const turnObjectives = collectTurnObjectives(planV2);
  const promptDirectives = extractPromptDirectives(assets.promptText);
  const skillHints = extractSkillHints(assets.skillDocuments);
  const condensedText = [
    assets.promptText,
    globalGoal,
    tacticalGoal,
    ...openingPriorities,
    ...turnObjectives,
    ...promptDirectives,
    ...skillHints,
  ].join("\n");

  const flags = {
    prioritizeAuraSetup: hasAny(condensedText, ["set aura", "aura", "附着", "元素附着"]),
    prioritizeReactionTempo: hasAny(condensedText, ["reaction", "tempo", "反应", "节奏"]),
    prioritizeSupportPlay: hasAny(condensedText, ["support", "status", "装备", "事件牌", "支援", "状态"]),
    allowPivotSwitch: hasAny(condensedText, ["switch", "pivot", "换人", "切人"]),
    allowElementalTuning: hasAny(condensedText, ["tuning", "调和", "修骰"]),
    avoidOmniWaste: hasAny(condensedText, ["avoid omni waste", "避免万能骰浪费", "避免低价值透支骰子"]),
    preserveResources: hasAny(condensedText, ["保留资源", "preserve", "resource", "avoid low value"]),
    protectCoreHp: hasAny(condensedText, ["preserving core hp", "stabilize hp", "保血", "核心血量"]),
    forbidEarlyEnd: true,
  };

  const preferredActionCases: ActionCase[] = dedupeStrings([
    "useSkill",
    ...(flags.prioritizeSupportPlay ? ["playCard"] : []),
    ...(flags.allowElementalTuning ? ["elementalTuning"] : []),
    ...(flags.allowPivotSwitch ? ["switchActive"] : []),
  ]) as ActionCase[];
  const avoidActionCases: ActionCase[] = dedupeStrings([
    ...(flags.forbidEarlyEnd ? ["declareEnd"] : []),
    ...(flags.preserveResources && !flags.allowPivotSwitch ? ["switchActive"] : []),
  ]) as ActionCase[];

  const summaryLines = dedupeStrings([
    `goal:${globalGoal}`,
    `tactical:${tacticalGoal}`,
    `priority:${openingPriorities[0] ?? turnObjectives[0] ?? "use legal high-value action"}`,
    `prefer:${preferredActionCases.join(",")}`,
    `avoid:${avoidActionCases.join(",") || "none"}`,
    ...skillHints.slice(0, 3),
  ]);

  return {
    version: "ReasonerProfileV1",
    selectedSkills,
    globalGoal,
    tacticalGoal,
    openingPriorities,
    turnObjectives,
    promptDirectives,
    skillHints,
    preferredActionCases,
    avoidActionCases,
    flags,
    summaryLines,
  };
}

async function persistReasonerProfile(
  sessionId: string,
  planId: string,
  shardId: string,
  profile: ReasonerProfile,
): Promise<{ artifact: ReasonerProfileArtifact; path: string }> {
  const artifact: ReasonerProfileArtifact = {
    artifact_type: "ReasonerProfileArtifactV1",
    session_id: sessionId,
    plan_id: planId,
    shard_id: shardId,
    created_at: new Date().toISOString(),
    profile,
  };
  const path = getReasonerProfilePath(sessionId);
  await writeJsonArtifact(path, artifact);
  return { artifact, path };
}

function normalizeReasonerProfileArtifact(value: unknown): ReasonerProfileArtifact | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const profile = record.profile;
  if (
    record.artifact_type !== "ReasonerProfileArtifactV1" ||
    typeof record.session_id !== "string" ||
    typeof record.plan_id !== "string" ||
    typeof record.shard_id !== "string" ||
    typeof record.created_at !== "string" ||
    typeof profile !== "object" ||
    profile === null
  ) {
    return null;
  }

  const normalizedProfile = profile as Record<string, unknown>;
  if (
    normalizedProfile.version !== "ReasonerProfileV1" ||
    typeof normalizedProfile.globalGoal !== "string" ||
    typeof normalizedProfile.tacticalGoal !== "string" ||
    !Array.isArray(normalizedProfile.selectedSkills) ||
    !Array.isArray(normalizedProfile.preferredActionCases) ||
    !Array.isArray(normalizedProfile.avoidActionCases) ||
    !Array.isArray(normalizedProfile.summaryLines)
  ) {
    return null;
  }

  return record as unknown as ReasonerProfileArtifact;
}

async function loadPersistedReasonerProfile(sessionId: string): Promise<{ artifact: ReasonerProfileArtifact; path: string }> {
  const path = getReasonerProfilePath(sessionId);
  const rawText = await readTextIfExists(path);
  if (!rawText) {
    throw new Error(`Reasoner profile artifact is missing: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error(`Reasoner profile artifact is not valid JSON: ${path}`);
  }

  const artifact = normalizeReasonerProfileArtifact(parsed);
  if (!artifact) {
    throw new Error(`Reasoner profile artifact shape is invalid: ${path}`);
  }

  return { artifact, path };
}

function countPreviewByCase(candidate: ActionCandidate, previewCase: string): number {
  const preview = Array.isArray(candidate.raw.preview) ? candidate.raw.preview : [];
  return preview.filter((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    return (entry as { $case?: unknown }).$case === previewCase;
  }).length;
}

function chooseAlignedDice(availableDice: number[], requiredCount: number): number[] | null {
  const OMNI = 8;
  const omniDice = availableDice.filter((die) => die === OMNI);
  const grouped = new Map<number, number[]>();
  for (const die of availableDice) {
    if (die === OMNI) {
      continue;
    }
    const current = grouped.get(die) ?? [];
    current.push(die);
    grouped.set(die, current);
  }

  let bestChoice: number[] | null = null;
  for (const group of grouped.values()) {
    const neededOmni = Math.max(0, requiredCount - group.length);
    if (neededOmni > omniDice.length) {
      continue;
    }
    const candidate = [...group.slice(0, requiredCount), ...omniDice.slice(0, neededOmni)].slice(0, requiredCount);
    if (!bestChoice || candidate.length > bestChoice.length || group.length > bestChoice.filter((die) => die !== OMNI).length) {
      bestChoice = candidate;
    }
  }

  if (bestChoice) {
    return bestChoice;
  }

  if (omniDice.length >= requiredCount) {
    return omniDice.slice(0, requiredCount);
  }
  return null;
}

function chooseDiceForRequirement(
  requiredCost: Array<{ type: number; count: number }>,
  availableDice: number[],
): number[] | null {
  const VOID = 0;
  const OMNI = 8;
  const ALIGNED = 8;
  const ENERGY = 9;
  const selected: number[] = [];
  const remaining = [...availableDice];

  const requirements = requiredCost.filter((entry) => entry.count > 0 && entry.type !== ENERGY);
  if (requirements.length === 0) {
    return [];
  }

  if (requirements.length === 1 && requirements[0].type === ALIGNED) {
    return chooseAlignedDice(availableDice, requirements[0].count);
  }

  let voidCount = 0;
  for (const entry of requirements) {
    if (entry.type === VOID) {
      voidCount += entry.count;
      continue;
    }
    for (let i = 0; i < entry.count; i += 1) {
      const exactIndex = remaining.indexOf(entry.type);
      if (exactIndex >= 0) {
        selected.push(remaining[exactIndex]);
        remaining.splice(exactIndex, 1);
        continue;
      }
      const omniIndex = remaining.indexOf(OMNI);
      if (omniIndex < 0) {
        return null;
      }
      selected.push(remaining[omniIndex]);
      remaining.splice(omniIndex, 1);
    }
  }

  for (let i = 0; i < voidCount; i += 1) {
    const nonOmniIndex = remaining.findIndex((die) => die !== OMNI);
    const targetIndex = nonOmniIndex >= 0 ? nonOmniIndex : remaining.indexOf(OMNI);
    if (targetIndex < 0) {
      return null;
    }
    selected.push(remaining[targetIndex]);
    remaining.splice(targetIndex, 1);
  }

  return selected;
}

function buildActionSummary(candidate: ActionCandidate): string {
  const actionEnvelope = candidate.raw.action as Record<string, unknown> | undefined;
  const value = actionEnvelope?.value as Record<string, unknown> | undefined;
  switch (candidate.actionCase) {
    case "useSkill":
      return `useSkill(skillDefinitionId=${String(value?.skillDefinitionId ?? "unknown")})`;
    case "playCard":
      return `playCard(cardDefinitionId=${String(value?.cardDefinitionId ?? "unknown")})`;
    case "switchActive":
      return `switchActive(characterDefinitionId=${String(value?.characterDefinitionId ?? "unknown")})`;
    case "elementalTuning":
      return `elementalTuning(targetDice=${String(value?.targetDice ?? "unknown")})`;
    case "declareEnd":
      return "declareEnd";
    default:
      return "unknown";
  }
}

function evaluateActionCandidate(
  candidate: ActionCandidate,
  profile: ReasonerProfile,
  availableDice: number[],
  hasOtherValidAction: boolean,
): ActionEvaluation | null {
  if (candidate.validity !== 0) {
    return null;
  }

  const usedDice = candidate.autoSelectedDice.length > 0
    ? [...candidate.autoSelectedDice]
    : (chooseDiceForRequirement(candidate.requiredCost, availableDice) ?? []);
  if (sumCost(candidate.requiredCost) > 0 && usedDice.length === 0) {
    return null;
  }

  const reasons: string[] = [];
  let score = 0;

  switch (candidate.actionCase) {
    case "useSkill":
      score += 80;
      reasons.push("技能行动默认优先级最高，通常最贴近开局计划。", "默认优先建立伤害/附着/反应链。");
      break;
    case "playCard":
      score += 66;
      reasons.push("打牌通常用于补节奏或铺设关键状态。");
      break;
    case "elementalTuning":
      score += 36;
      reasons.push("调和只在资源结构不顺时提升优先级。");
      break;
    case "switchActive":
      score += 24;
      reasons.push("换人是战术动作，但默认不应无收益消耗回合。");
      break;
    case "declareEnd":
      score += 4;
      reasons.push("结束回合仅在缺乏高价值动作时考虑。");
      break;
    default:
      return null;
  }

  if (profile.preferredActionCases.includes(candidate.actionCase)) {
    score += 10;
    reasons.push(`决策画像偏好 ${candidate.actionCase}。`);
  }

  if (profile.avoidActionCases.includes(candidate.actionCase)) {
    score -= 14;
    reasons.push(`决策画像当前回避 ${candidate.actionCase}。`);
  }

  if (candidate.isFast) {
    score += 6;
    reasons.push("快速行动保留回合主动权。");
  }

  const cost = sumCost(candidate.requiredCost);
  score -= cost * 3;
  if (cost > 0) {
    reasons.push(`费用为 ${cost}，按资源效率略降分。`);
  }

  const damagePreviewCount = countPreviewByCase(candidate, "damage");
  if (damagePreviewCount > 0) {
    score += 10 + damagePreviewCount * 2;
    reasons.push(`预览包含 ${damagePreviewCount} 条伤害，提升即时收益。`);
  }

  const auraPreviewCount = countPreviewByCase(candidate, "applyAura");
  if (auraPreviewCount > 0) {
    score += 8 + auraPreviewCount;
    reasons.push(`预览包含 ${auraPreviewCount} 条附着，利于反应展开。`);
  }

  const actionValue = ((candidate.raw.action as Record<string, unknown> | undefined)?.value ?? {}) as Record<string, unknown>;
  if (candidate.actionCase === "playCard" && actionValue.willBeEffectless === true) {
    score -= 30;
    reasons.push("该牌当前会空过效果，显著降权。");
  }

  if (candidate.actionCase === "declareEnd" && hasOtherValidAction) {
    score -= 100;
    reasons.push("当前仍有其他合法动作，避免过早 declareEnd。");
  }

  if (candidate.actionCase === "switchActive" && profile.flags.allowPivotSwitch) {
    score += 14;
    reasons.push("决策画像允许换人转线。\n");
  }

  if (candidate.actionCase === "switchActive" && profile.flags.preserveResources && !profile.flags.allowPivotSwitch) {
    score -= 10;
    reasons.push("当前更偏向保资源，不鼓励主动换人。");
  }

  if (candidate.actionCase === "elementalTuning" && profile.flags.allowElementalTuning) {
    score += 12;
    reasons.push("决策画像允许调和修骰，适当升权。");
  }

  if (candidate.actionCase === "useSkill" && (profile.flags.prioritizeAuraSetup || profile.flags.prioritizeReactionTempo)) {
    score += 12;
    reasons.push("当前目标偏向通过技能建立附着与反应节奏。");
  }

  if (candidate.actionCase === "playCard" && profile.flags.prioritizeSupportPlay) {
    score += 8;
    reasons.push("当前目标允许通过牌张补足节奏组件。\n");
  }

  if (profile.flags.avoidOmniWaste || profile.flags.preserveResources) {
    const omniCount = usedDice.filter((die) => die === 8).length;
    score -= omniCount * 3;
    if (omniCount > 0) {
      reasons.push(`使用 ${omniCount} 个万能骰，按节省资源原则小幅降分。`);
    }
  }

  if (profile.flags.protectCoreHp && candidate.actionCase === "declareEnd" && !hasOtherValidAction) {
    score += 2;
    reasons.push("在无更好动作时允许保血收手。");
  }

  return {
    index: candidate.index,
    actionCase: candidate.actionCase,
    score,
    usedDice,
    summary: buildActionSummary(candidate),
    reasons,
  };
}

async function executeFragmentedDecision(
  handler: StandaloneMcpToolHandler,
  client: StandaloneMcpClient,
  sessionId: string,
): Promise<{
  actionRes: ParsedToolResult;
  chosen: ActionEvaluation | null;
  feedback: Record<string, unknown> | null;
}> {
  const persistedProfile = await loadPersistedReasonerProfile(sessionId);
  const profile = persistedProfile.artifact.profile;

  const digestRes = parseResult(await handler.executeTool("get_turn_digest_v1", {}));
  console.log("[E2E] get_turn_digest_v1", JSON.stringify(digestRes, null, 2));
  const digest = (digestRes.payload.digest as Record<string, unknown> | undefined) ?? {};
  const candidateActions = Array.isArray(digest.candidate_actions)
    ? (digest.candidate_actions as Array<Record<string, unknown>>)
    : [];

  if (digestRes.isError || digestRes.payload.ok !== true || candidateActions.length === 0) {
    const status = await client.getStatus();
    console.log("[E2E] fragmented_decision_skip", JSON.stringify({
      session_id: sessionId,
      pending_method: status.pendingMethod,
      valid_action_count: candidateActions.length,
    }, null, 2));
    return {
      actionRes: {
        isError: true,
        payload: {
          ok: false,
          error_code: "NO_ACTION_PENDING",
          message: "No pending action RPC for fragmented decision execution.",
        },
      },
      chosen: null,
      feedback: null,
    };
  }

  const preferenceOrder = dedupeStrings([
    ...profile.preferredActionCases,
    ...profile.turnObjectives,
    ...profile.openingPriorities,
  ]).slice(0, 8);

  const fragmentRes = parseResult(
    await handler.executeTool("submit_decision_fragment_v1", {
      digest_ref: digest.digest_ref,
      intent: profile.tacticalGoal,
      must_do: profile.turnObjectives,
      avoid: profile.avoidActionCases,
      preference_order: preferenceOrder,
      resource_policy: profile.flags.preserveResources ? "strict" : "balanced",
      target_policy: "maximize_legal_value",
      fallback_rule: "pick_highest_valid_candidate",
      explanation: `Derived from prompt and selected skills (${profile.selectedSkills.join(",") || "none"}).`,
    }),
  );
  console.log("[E2E] submit_decision_fragment_v1", JSON.stringify(fragmentRes, null, 2));

  const feedbackRes = parseResult(await handler.executeTool("get_execution_feedback_v1", {}));
  console.log("[E2E] get_execution_feedback_v1", JSON.stringify(feedbackRes, null, 2));
  const feedback = (feedbackRes.payload.feedback as Record<string, unknown> | undefined) ?? null;

  if (fragmentRes.isError || fragmentRes.payload.ok !== true || feedbackRes.isError || !feedback) {
    return {
      actionRes: fragmentRes,
      chosen: null,
      feedback,
    };
  }

  const selectedCandidateId = typeof feedback.selected_candidate_id === "string"
    ? feedback.selected_candidate_id
    : null;
  const selectedCandidate = selectedCandidateId
    ? candidateActions.find((candidate) => candidate.candidate_id === selectedCandidateId) ?? null
    : null;
  const indexFromCandidate = (() => {
    if (!selectedCandidateId) {
      return 0;
    }
    const match = selectedCandidateId.match(/cand_(\d+)$/);
    if (!match) {
      return 0;
    }
    return Number.parseInt(match[1], 10);
  })();

  console.log("[E2E] reasoner_step_context", JSON.stringify({
    session_id: sessionId,
    reasoner_profile_path: persistedProfile.path,
    reasoner_profile_created_at: persistedProfile.artifact.created_at,
    profile_version: profile.version,
    selected_skills: profile.selectedSkills,
    summary_lines: profile.summaryLines,
    preferred_action_cases: profile.preferredActionCases,
    avoid_action_cases: profile.avoidActionCases,
    flags: profile.flags,
    pending_method: digest.pending_method,
    action_count: candidateActions.length,
    selected_candidate_id: selectedCandidateId,
  }, null, 2));
  const chosen: ActionEvaluation | null = selectedCandidate
    ? {
        index: indexFromCandidate,
        actionCase: String(selectedCandidate.action_case ?? "unknown") as ActionCase,
        score: 0,
        usedDice: [],
        summary: String(selectedCandidate.action_case ?? "unknown"),
        reasons: [String(feedback.resolver_reason ?? "resolver-selected")],
      }
    : null;

  const actionRes: ParsedToolResult = {
    isError: feedback.execution_ok !== true,
    payload: {
      ok: feedback.execution_ok === true,
      executed_tool: feedback.executed_tool,
      selected_candidate_id: feedback.selected_candidate_id,
      resolver_reason: feedback.resolver_reason,
      notes: feedback.notes,
    },
  };

  return {
    actionRes,
    chosen,
    feedback,
  };
}

async function main() {
  const baseUrl = getArgValue("--url") ?? getArgValue("--base-url") ?? "http://localhost:3901";
  const sessionId = getArgValue("--session-id") ?? `sess_${Date.now()}`;
  const handler = new StandaloneMcpToolHandler(baseUrl);
  const client = new StandaloneMcpClient(baseUrl);
  const shardTurnEnd = parseIntegerArg("--turn-end", 1);

  handler.setSessionId(sessionId);

  const skillRes = parseResult(
    await handler.executeTool("auto_select_skills", {
      force_refresh: true,
    }),
  );
  console.log("[E2E] auto_select_skills", JSON.stringify(skillRes, null, 2));
  if (skillRes.isError || skillRes.payload.ok !== true) {
    throw new Error("auto_select_skills failed");
  }

  const selectedSkills = normalizeStringArray(skillRes.payload.selected_skills);

  const planV1Res = parseResult(
    await handler.executeTool("create_opening_plan_v1", {
      session_id: sessionId,
      source_skills: selectedSkills,
    }),
  );
  console.log("[E2E] create_opening_plan_v1", JSON.stringify(planV1Res, null, 2));
  if (planV1Res.isError || planV1Res.payload.ok !== true) {
    throw new Error("create_opening_plan_v1 failed");
  }

  const planV1 = (planV1Res.payload.plan as Record<string, unknown> | undefined) ?? {};

  const planRes = parseResult(
    await handler.executeTool("create_opening_plan_v2", {
      session_id: sessionId,
      source_skills: selectedSkills.length > 0 ? selectedSkills : ["base-skill"],
      global_goal: typeof planV1.global_goal === "string"
        ? planV1.global_goal
        : "Secure opening tempo while preserving core HP.",
      opening_window: { start_turn: 1, end_turn: 3 },
      turn_priorities: [{
        turn: 1,
        objectives: normalizeStringArray(planV1.turn1_3_priorities).length > 0
          ? normalizeStringArray(planV1.turn1_3_priorities)
          : ["set aura", "avoid omni waste"],
      }],
      risk_rules: [],
      pivot_rules: [],
      trigger_rules: [],
      fallback_rules: [],
    }),
  );
  console.log("[E2E] create_opening_plan_v2", JSON.stringify(planRes, null, 2));
  if (planRes.isError || planRes.payload.ok !== true) {
    throw new Error("create_opening_plan_v2 failed");
  }

  const plan = (planRes.payload.plan as Record<string, unknown> | undefined) ?? {};
  const planId = String(plan.plan_id);

  const shardRes = parseResult(
    await handler.executeTool("create_decision_shard_v2", {
      session_id: sessionId,
      plan_id: planId,
      turn_range: { start: 1, end: shardTurnEnd },
      tactical_goal: "Use prompt.txt + selected skills + opening plans to pick the highest-value legal action.",
      candidate_policies: [
        {
          id: "policy_prompt_skill_fragmented_decision",
          priority: 90,
          preconditions: ["has_pending_rpc", "pending_method=action", "opening_plan_ready"],
          action_template: {
            tool: "submit_decision_fragment_v1",
            args: {
              fragment_strategy: "prompt_skill_fragmented_plan_first",
            },
          },
        },
      ],
      execution_constraints: {
        max_actions_this_turn: 3,
        dice_budget_mode: "balanced",
      },
      exit_conditions: ["end_phase_reached"],
    }),
  );
  console.log("[E2E] create_decision_shard_v2", JSON.stringify(shardRes, null, 2));

  const shard = (shardRes.payload.decision_shard as Record<string, unknown> | undefined) ?? {};
  console.log("[E2E] trace_after_shard", JSON.stringify({
    session_id: sessionId,
    shard_id: shard.shard_id,
  }, null, 2));

  console.log("[E2E] trace_load_reasoning_assets_begin", JSON.stringify({
    session_id: sessionId,
    selected_skills: selectedSkills,
  }, null, 2));
  const reasoningAssets = await loadReasoningAssets(selectedSkills);
  console.log("[E2E] trace_load_reasoning_assets_done", JSON.stringify({
    session_id: sessionId,
    prompt_excerpt_length: reasoningAssets.promptExcerpt.length,
    skill_document_count: reasoningAssets.skillDocuments.length,
  }, null, 2));

  const reasonerProfile = buildReasonerProfile(
    reasoningAssets,
    selectedSkills,
    planV1,
    plan,
    shard,
  );
  console.log("[E2E] trace_build_reasoner_profile_done", JSON.stringify({
    session_id: sessionId,
    profile_version: reasonerProfile.version,
    summary_line_count: reasonerProfile.summaryLines.length,
  }, null, 2));

  console.log("[E2E] trace_persist_reasoner_profile_begin", JSON.stringify({
    session_id: sessionId,
    plan_id: planId,
    shard_id: typeof shard.shard_id === "string" ? shard.shard_id : "unknown-shard",
  }, null, 2));
  const persistedReasonerProfile = await persistReasonerProfile(
    sessionId,
    planId,
    typeof shard.shard_id === "string" ? shard.shard_id : "unknown-shard",
    reasonerProfile,
  );
  console.log("[E2E] compiled_reasoner_profile", JSON.stringify(reasonerProfile, null, 2));
  console.log("[E2E] persisted_reasoner_profile", JSON.stringify({
    path: persistedReasonerProfile.path,
    artifact_type: persistedReasonerProfile.artifact.artifact_type,
    session_id: persistedReasonerProfile.artifact.session_id,
    plan_id: persistedReasonerProfile.artifact.plan_id,
    shard_id: persistedReasonerProfile.artifact.shard_id,
  }, null, 2));

  console.log("[E2E] trace_fragmented_decision_begin", JSON.stringify({
    session_id: sessionId,
    reasoner_profile_path: persistedReasonerProfile.path,
  }, null, 2));
  const { actionRes, chosen, feedback } = await executeFragmentedDecision(
    handler,
    client,
    sessionId,
  );

  if (shouldSkipCriticEvaluation(actionRes, chosen)) {
    console.log("[E2E] critic_skipped", JSON.stringify({
      session_id: sessionId,
      reason: actionRes.payload.error_code,
      message: actionRes.payload.message,
    }, null, 2));
    return;
  }

  const criticRes = parseResult(
    await handler.executeTool("critic_evaluate_v1", {
      session_id: sessionId,
      plan_id: planId,
      turn: 1,
      step_id: "turn1_step1",
      expected_policy_id: "policy_prompt_skill_fragmented_decision",
      actual_tool: typeof feedback?.executed_tool === "string" ? feedback.executed_tool : "none",
      actual_args: chosen ? { selected_candidate_id: feedback?.selected_candidate_id ?? null } : {},
      state_delta: {
        self_hp_delta: 0,
        opp_hp_delta: 0,
        dice_spent: chosen ? chosen.usedDice.length : 0,
        cards_spent: chosen?.actionCase === "playCard" ? 1 : 0,
        notes: chosen
          ? `Chosen ${chosen.summary} via prompt+skills reasoner.`
          : "No action was chosen by prompt+skills reasoner.",
      },
      hard_violations: actionRes.isError ? ["ACTION_CALL_FAILED"] : [],
    }),
  );
  console.log("[E2E] trace_critic_evaluate_done", JSON.stringify({
    session_id: sessionId,
    actual_tool: typeof feedback?.executed_tool === "string" ? feedback.executed_tool : "none",
    action_error: actionRes.isError,
  }, null, 2));
  console.log("[E2E] critic_evaluate_v1", JSON.stringify(criticRes, null, 2));

  const criticResult = criticRes.payload.critic_result as Record<string, unknown> | undefined;
  if (criticResult?.should_replan === true) {
    const replanRes = parseResult(
      await handler.executeTool("create_opening_plan_v2", {
        session_id: sessionId,
        plan_id: `${planId}_replan_${Date.now()}`,
        source_skills: selectedSkills.length > 0 ? selectedSkills : ["base-skill"],
        global_goal: "Replan due to critic trigger and stabilize next turn.",
        opening_window: { start_turn: 1, end_turn: 3 },
        turn_priorities: [{ turn: 2, objectives: ["stabilize hp", "recover tempo"] }],
        risk_rules: [],
        pivot_rules: [],
        trigger_rules: [],
        fallback_rules: [],
      }),
    );
    console.log("[E2E] optional_replan", JSON.stringify(replanRes, null, 2));
  }
}

main().catch((error) => {
  console.error("[E2E] tactic flow failed:", error);
  const processMaybe = (globalThis as any).process;
  if (processMaybe?.exit) {
    processMaybe.exit(1);
  }
});
