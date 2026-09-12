/**
 * FeatureExtractor — Extract game-state features from scoring candidates.
 *
 * Takes a TurnDigestV1 + a candidate action record and produces a numeric
 * feature vector suitable for logistic regression / any downstream ML model.
 *
 * Design principle:
 *   Each feature must be a measurable property of (state, action) that could
 *   plausibly correlate with the probability of winning the game.  We avoid
 *   "magic bias" constants — those will be learned by the calibrator.
 */

// ── Inline utilities (mirrored from @gi-tcg/mcp scoring-utils) ──

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function containsLabel(source: string, labels: string[]): boolean {
  const lower = source.toLowerCase();
  return labels.some((l) => lower.includes(l.toLowerCase()));
}

function totalCostFromCandidate(candidate: Record<string, unknown>): number {
  const cost = candidate.cost ?? candidate.total_cost ?? candidate.dice_cost;
  if (typeof cost === "number") return cost;
  if (Array.isArray(cost)) return cost.length;
  return safeNumber(cost);
}

function computeEntropy(values: number[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const total = values.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Flat numeric vector extracted from (digest, candidateAction). */
export interface ScoringFeatureVector {
  // ── Action identity (one-hot) ──
  isUseSkill: number;        // 1 if useSkill, else 0
  isPlayCard: number;
  isSwitchActive: number;
  isDeclareEnd: number;
  isOtherAction: number;

  // ── Skill sub-type (P0: distinguish normal / elemental / burst) ──
  isNormalAttack: number;     // 1 if normal attack (A)
  isElementalSkill: number;   // 1 if elemental skill (E)
  isBurst: number;            // 1 if elemental burst (Q)
  isPureUtility: number;      // 1 if skill has zero immediate damage AND zero immediate healing
  isEventCard: number;
  isSupportCard: number;
  isEquipmentCard: number;
  isWeaponCard: number;
  isArtifactCard: number;
  isTechniqueCard: number;

  // ── Raw gain signals ──
  damageEstimate: number;    // from CandidateEnricher preview
  healingEstimate: number;
  selfHealValue: number;
  teamHealValue: number;
  reactionValue: number;
  tempoValue: number;
  drawValue: number;
  diceFixValue: number;
  energyGainValue: number;
  createSupportValue: number;
  createSummonValue: number;
  createEquipmentValue: number;
  forcedSwitchValue: number;
  selfSwitchValue: number;
  targetCount: number;
  willBeEffectless: number;

  // ── Cost ──
  totalCost: number;         // sum of required dice
  costRatio: number;         // totalCost / max(1, diceCount)

  // ── Self state ──
  selfActiveHpRatio: number;       // active char HP / maxHP
  selfTeamAvgHpRatio: number;      // mean HP ratio across alive chars
  selfAliveCount: number;          // how many chars still alive (1-3)
  selfActiveEnergyGap: number;     // maxEnergy - energy for active char
  selfNearBurstCount: number;      // count chars where energyGap <= 1

  // ── Opponent state ──
  opponentActiveHpRatio: number;
  opponentTeamAvgHpRatio: number;
  opponentAliveCount: number;
  opponentBurstReady: number;      // 1 if any opp char has full energy

  // ── Resource state ──
  diceCount: number;
  omniCount: number;
  cardsInHand: number;
  supportCount: number;
  summonCount: number;
  supportRoom: number;
  summonRoom: number;
  round: number;

  // ── Contextual signals ──
  hpAdvantage: number;             // selfTeamAvgHpRatio - opponentTeamAvgHpRatio
  aliveAdvantage: number;          // selfAliveCount - opponentAliveCount
  energyUrgency: number;           // 1/(selfActiveEnergyGap+1) — higher when close to burst
  healUrgency: number;
  canKillTarget: number;           // 1 if damageEstimate >= opponent active HP, else 0
  hasReaction: number;             // 1 if reactionValue > 0
  isFastAction: number;            // 1 if candidate has "fast" tag

  // ── HC-05: 集中击杀相关 ──
  opponentMinHp: number;           // 对手最低血量角色的绝对 HP 值
  selfMinHpRatio: number;          // 自身最低血量角色 HP/maxHP
  damageToMinHpTarget: number;     // 伤害 / 对手出战角色 HP（击杀接近度）

  // ── HC-07: 元素反应链 ──
  oppActiveHasAura: number;        // 对手出战角色是否有元素附着 (0/1)
  selfActiveHasAura: number;       // 自身出战角色是否有元素附着 (0/1)
  reactionChainReady: number;      // 是否满足反应链条件 (0/1)

  // ── HC-06: 骰子颜色匹配 ──
  diceSkillAlignment: number;      // 可负担候选动作数 / 总候选数
  diceColorEntropy: number;        // 骰子颜色分布熵

  // ── HC-02: 先后手 ──
  opponentDeclaredEnd: number;     // 对手是否已声明结束 (0/1)
  selfActionCountInRound: number;  // 本回合自方已执行动作数

  // ── HC-10: 阶段切换（V31 F2: 离散标签 → 连续进度量，P5 反过早分类）──
  setupCompletion: number;         // 展开完成度 (0~1)
  executionReadiness: number;      // V31 F2: 执行就位度 (0~1)，取代 execution 离散判定
  closingPressure: number;         // V31 F2: 收尾压力 (0~1)，取代 closing 离散判定
  /** @deprecated-P5 风险应由 V(s) 吸收，仅引导期保留；阶段 3 encoder 接管(α≥0.5)后移除。见 docs/v31-theory-alignment-fixes.md F4。 */
  opponentThreatScore: number;     // 对手威胁评分

  // ── H1: Burst window ──
  burstWindowUrgency: number;        // 出战角色爆发窗口紧迫度 (0~3)
  anyCharacterNearBurst: number;     // 有角色能量 gap ≤ 1 (0/1)

  // ── H2: Character functional tier ──
  activeCharTier: number;            // 0=residual, 1=tactical, 2=core
  coreCharHpRatio: number;          // 核心角色的 HP 比例（最低）
  /** @deprecated-P5 风险应由 V(s) 吸收，仅引导期保留；阶段 3 encoder 接管(α≥0.5)后移除。 */
  coreCharCollapseDistance: number;  // 核心角色的坍缩距离

  // ── H3: Turn plan alignment ──
  turnPlanAlignment: number;         // 当前动作是否与回合计划一致 (0/1)

  // ── H7: Character count adaptation ──
  selfCharacterAdvantage: number;    // selfAliveCount - opponentAliveCount

  // ── H8: Functional collapse ──
  // @deprecated-P5 下列坍缩距离 / 伤害容量都是"工程单列风险"，与理论 §九.1 (P5)
  // "风险完全分散到 V(s)" 冲突。仅在引导期 (GBDT/logistic 浅层模型) 保留；阶段 3
  // encoder 在 α≥0.5 稳定后随 feature-extractor 一起移除。见 v31 F4 / V30 §8。
  minCollapseDistance: number;        // 我方所有角色中最小坍缩距离
  avgCollapseDistance: number;        // 我方所有角色平均坍缩距离
  opponentMinCollapseDistance: number; // 对手最小坍缩距离
  opponentDamageCapacity: number;    // 对手当前轮最大伤害容量估计
  opponentReactionBonus: number;     // V31 F1: 对手反应增伤固定加值估计 (+2/+1/0, 引擎对齐)

  // ── Burst waste tracking ──
  wastedEnergyThisGame: number;      // 本局已浪费的总能量
}

/** A labeled training sample: features + whether the player eventually won. */
export interface LabeledSample {
  features: ScoringFeatureVector;
  /** 1 if the player who took this action won the game, 0 otherwise. */
  label: number;
  /** Sample weight for importance-weighted training (default 1.0). */
  weight?: number;
  /**
   * V30 Stage 2.E — Optional FeatureExtension flat array (PreviewMutationVector
   * + Fingerprint). When `undefined` / empty, the trainer treats the extension
   * contribution as zero. Must have constant length across all samples within
   * a single training run.
   */
  featuresExt?: number[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface CharSummary {
  character_id?: number;
  id?: number;
  hp?: number;
  max_hp?: number;
  energy?: number;
  max_energy?: number;
  alive?: boolean;
}

function parseChars(summary: Record<string, unknown>): CharSummary[] {
  const chars = (summary as any)?.characters;
  return Array.isArray(chars) ? chars : [];
}

function aliveChars(chars: CharSummary[]): CharSummary[] {
  return chars.filter((c) => c.alive !== false && (c.hp ?? 1) > 0);
}

function avgHpRatio(chars: CharSummary[]): number {
  const alive = aliveChars(chars);
  if (alive.length === 0) return 0;
  const sum = alive.reduce(
    (acc, c) => acc + (c.hp ?? 0) / Math.max(1, c.max_hp ?? 10),
    0,
  );
  return sum / alive.length;
}

function findActive(
  chars: CharSummary[],
  activeId: unknown,
): CharSummary | undefined {
  const id = Number(activeId);
  return chars.find(
    (c) => (c.character_id ?? c.id) === id,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor
// ─────────────────────────────────────────────────────────────────────────────

export class FeatureExtractor {
  /**
   * Extract a feature vector from a digest + candidate pair.
   *
   * @param digest  The TurnDigestV1 (self_summary, opponent_summary, resource_summary, round)
   * @param candidate  A single candidate_actions entry
   */
  extract(
    digest: {
      self_summary: Record<string, unknown>;
      opponent_summary: Record<string, unknown>;
      resource_summary: Record<string, unknown>;
      round: number;
      opponent_declared_end?: boolean;
      candidate_actions?: Record<string, unknown>[];
    },
    candidate: Record<string, unknown>,
    observation?: {
      point?: { action_count_in_round?: number };
      self?: { characters?: Array<{ aura?: number | null; is_active?: boolean }> };
      opponent?: { characters?: Array<{ aura?: number | null; is_active?: boolean }> };
      public_state?: { opponent_declared_end?: boolean };
      derived?: {
        game_phase_estimate?: number;
        game_setup_completion?: number;
        execution_readiness?: number;
        closing_pressure?: number;
        opp_damage_capacity_now?: number;
        opp_ko_pressure_now?: number;
        opp_reaction_bonus_now?: number;
      };
    } | null,
  ): ScoringFeatureVector {
    const actionCase = String(candidate.action_case ?? "unknown");

    // ── Action identity ──
    const isUseSkill = actionCase === "useSkill" ? 1 : 0;
    
    // ── Skill sub-type (P0) ──
    const skillType = String(candidate.skill_type ?? "");
    const isNormalAttack = isUseSkill && skillType === "normal" ? 1 : 0;
    const isElementalSkill = isUseSkill && skillType === "elemental" ? 1 : 0;
    const isBurst = isUseSkill && skillType === "burst" ? 1 : 0;
    
    const isPlayCard = actionCase === "playCard" ? 1 : 0;
    const isSwitchActive =
      actionCase === "switchActive" || actionCase === "chooseActive" ? 1 : 0;
    const isDeclareEnd = actionCase === "declareEnd" ? 1 : 0;
    const isOtherAction =
      1 - isUseSkill - isPlayCard - isSwitchActive - isDeclareEnd;
    const entityType = safeNumber(candidate.card_entity_type);
    const equipmentType = safeNumber(candidate.card_equipment_type);
    const isEventCard = entityType === 1 ? 1 : 0;
    const isSupportCard = entityType === 5 ? 1 : 0;
    const isEquipmentCard = entityType === 6 ? 1 : 0;
    const isWeaponCard = equipmentType === 1 ? 1 : 0;
    const isArtifactCard = equipmentType === 2 ? 1 : 0;
    const isTechniqueCard = equipmentType === 3 ? 1 : 0;

    // ── Raw gain signals ──
    const damageEstimate = safeNumber(candidate.damage_estimate);
    const healingEstimate = safeNumber(candidate.healing_estimate);
    const selfHealValue = safeNumber(candidate.self_heal_value);
    const teamHealValue = safeNumber(candidate.team_heal_value);
    const reactionValue = safeNumber(candidate.reaction_value);
    const tempoValue = safeNumber(candidate.tempo_value);
    const drawValue = safeNumber(candidate.draw_value);
    const diceFixValue = safeNumber(candidate.dice_fix_value);
    const energyGainValue = safeNumber(candidate.energy_gain_value);
    const createSupportValue = safeNumber(candidate.create_support_value);
    const createSummonValue = safeNumber(candidate.create_summon_value);
    const createEquipmentValue = safeNumber(candidate.create_equipment_value);
    const forcedSwitchValue = safeNumber(candidate.forced_switch_value);
    const selfSwitchValue = safeNumber(candidate.self_switch_value);
    const targetCount = safeNumber(candidate.target_count);
    const willBeEffectless = candidate.will_be_effectless ? 1 : 0;

    // ── Cost ──
    const totalCost = totalCostFromCandidate(candidate);

    // ── Self state ──
    const selfChars = parseChars(digest.self_summary);
    const selfActiveId = (digest.self_summary as any)?.active_character_id;
    const selfActive = findActive(selfChars, selfActiveId);
    const selfAlive = aliveChars(selfChars);

    const selfActiveHpRatio = selfActive
      ? (selfActive.hp ?? 0) / Math.max(1, selfActive.max_hp ?? 10)
      : 0;
    const selfTeamAvgHpRatio = avgHpRatio(selfChars);
    const selfAliveCount = selfAlive.length;

    const selfActiveEnergyGap = selfActive
      ? Math.max(0, (selfActive.max_energy ?? 3) - (selfActive.energy ?? 0))
      : 3;
    const selfNearBurstCount = selfAlive.filter(
      (c) => (c.max_energy ?? 3) - (c.energy ?? 0) <= 1,
    ).length;

    // ── Opponent state ──
    const oppChars = parseChars(digest.opponent_summary);
    const oppActiveId = (digest.opponent_summary as any)?.active_character_id;
    const oppActive = findActive(oppChars, oppActiveId);
    const oppAlive = aliveChars(oppChars);

    const opponentActiveHpRatio = oppActive
      ? (oppActive.hp ?? 0) / Math.max(1, oppActive.max_hp ?? 10)
      : 0;
    const opponentTeamAvgHpRatio = avgHpRatio(oppChars);
    const opponentAliveCount = oppAlive.length;
    const opponentBurstReady = oppAlive.some(
      (c) => (c.energy ?? 0) >= (c.max_energy ?? 3),
    )
      ? 1
      : 0;

    // ── Resource state ──
    const diceCount = safeNumber((digest.resource_summary as any)?.dice_count);
    const omniCount = safeNumber((digest.resource_summary as any)?.omni_count);
    const cardsInHand = safeNumber(
      (digest.resource_summary as any)?.cards_in_hand,
    );
    const supportCount = safeNumber((digest.resource_summary as any)?.support_count);
    const summonCount = safeNumber((digest.resource_summary as any)?.summon_count);
    const maxSupportCount = safeNumber((digest.resource_summary as any)?.max_support_count) || 4;
    const maxSummonCount = safeNumber((digest.resource_summary as any)?.max_summon_count) || 4;
    const supportRoom = Math.max(0, maxSupportCount - supportCount);
    const summonRoom = Math.max(0, maxSummonCount - summonCount);
    const round = digest.round;

    const costRatio = totalCost / Math.max(1, diceCount);

    // ── Contextual signals ──
    const hpAdvantage = selfTeamAvgHpRatio - opponentTeamAvgHpRatio;
    const aliveAdvantage = selfAliveCount - opponentAliveCount;
    const energyUrgency = 1 / (selfActiveEnergyGap + 1);
    const healUrgency = 1 - selfActiveHpRatio;
    const oppActiveHp = oppActive ? (oppActive.hp ?? 10) : 10;
    const canKillTarget = damageEstimate >= oppActiveHp && damageEstimate > 0 ? 1 : 0;
    const hasReaction = reactionValue > 0 ? 1 : 0;

    // ── P0: Pure utility skill (zero immediate output) ──
    const isPureUtility = isUseSkill 
      && damageEstimate === 0 && healingEstimate === 0 
      && selfHealValue === 0 && teamHealValue === 0 ? 1 : 0;

    const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
    const notes = Array.isArray(candidate.notes) ? candidate.notes : [];
    const searchable = [actionCase, ...tags, ...notes].join(" ");
    const isFastAction = containsLabel(searchable, ["fast"]) ? 1 : 0;

    // ── HC-05: 集中击杀相关 ──
    const oppAliveHps = oppAlive.map((c) => c.hp ?? 10);
    const opponentMinHp = oppAliveHps.length > 0 ? Math.min(...oppAliveHps) : 10;
    const selfAliveHpRatios = aliveChars(selfChars).map(
      (c) => (c.hp ?? 0) / Math.max(1, c.max_hp ?? 10),
    );
    const selfMinHpRatio = selfAliveHpRatios.length > 0 ? Math.min(...selfAliveHpRatios) : 1;
    const damageToMinHpTarget = oppActiveHp > 0 ? damageEstimate / oppActiveHp : 0;

    // ── HC-07: 元素反应链 ──
    const obsOppChars = observation?.opponent?.characters ?? [];
    const obsOppActive = obsOppChars.find((c) => c.is_active);
    const oppActiveHasAura = obsOppActive && obsOppActive.aura != null && obsOppActive.aura !== 0 ? 1 : 0;
    const obsSelfChars = observation?.self?.characters ?? [];
    const obsSelfActive = obsSelfChars.find((c) => c.is_active);
    const selfActiveHasAura = obsSelfActive && obsSelfActive.aura != null && obsSelfActive.aura !== 0 ? 1 : 0;
    const reactionChainReady = (oppActiveHasAura === 1 && reactionValue > 0) ? 1 : 0;

    // ── HC-06: 骰子颜色匹配 ──
    const allCandidates = digest.candidate_actions ?? [];
    const affordableCount = allCandidates.filter(
      (c) => totalCostFromCandidate(c) <= diceCount,
    ).length;
    const diceSkillAlignment = allCandidates.length > 0
      ? affordableCount / allCandidates.length
      : 0;
    const diceValues = Array.isArray((digest.resource_summary as any)?.dice_values)
      ? ((digest.resource_summary as any).dice_values as number[])
      : [];
    const diceColorEntropy = computeEntropy(diceValues);

    // ── HC-02: 先后手 ──
    const opponentDeclaredEnd = (
      observation?.public_state?.opponent_declared_end ??
      digest.opponent_declared_end ??
      false
    ) ? 1 : 0;
    const selfActionCountInRound = safeNumber(observation?.point?.action_count_in_round);

    // ── HC-10: 阶段切换（V31 F2: 连续进度量）──
    const setupCompletion = safeNumber(observation?.derived?.game_setup_completion);
    // execution_readiness / closing_pressure 缺省 (-1 哨兵或 undefined) 时归 0。
    const executionReadinessRaw = observation?.derived?.execution_readiness;
    const executionReadiness =
      typeof executionReadinessRaw === "number" && executionReadinessRaw >= 0
        ? executionReadinessRaw
        : 0;
    const closingPressureRaw = observation?.derived?.closing_pressure;
    const closingPressure =
      typeof closingPressureRaw === "number" && closingPressureRaw >= 0
        ? closingPressureRaw
        : 0;
    const opponentThreatScore =
      safeNumber(observation?.derived?.opp_damage_capacity_now) +
      safeNumber(observation?.derived?.opp_ko_pressure_now);

    return {
      isUseSkill,
      isPlayCard,
      isSwitchActive,
      isDeclareEnd,
      isOtherAction,
      // ── P0: Skill sub-type ──
      isNormalAttack,
      isElementalSkill,
      isBurst,
      isPureUtility,
      isEventCard,
      isSupportCard,
      isEquipmentCard,
      isWeaponCard,
      isArtifactCard,
      isTechniqueCard,
      damageEstimate,
      healingEstimate,
      selfHealValue,
      teamHealValue,
      reactionValue,
      tempoValue,
      drawValue,
      diceFixValue,
      energyGainValue,
      createSupportValue,
      createSummonValue,
      createEquipmentValue,
      forcedSwitchValue,
      selfSwitchValue,
      targetCount,
      willBeEffectless,
      totalCost,
      costRatio,
      selfActiveHpRatio,
      selfTeamAvgHpRatio,
      selfAliveCount,
      selfActiveEnergyGap,
      selfNearBurstCount,
      opponentActiveHpRatio,
      opponentTeamAvgHpRatio,
      opponentAliveCount,
      opponentBurstReady,
      diceCount,
      omniCount,
      cardsInHand,
      supportCount,
      summonCount,
      supportRoom,
      summonRoom,
      round,
      hpAdvantage,
      aliveAdvantage,
      energyUrgency,
      healUrgency,
      canKillTarget,
      hasReaction,
      isFastAction,
      // ── New HC features ──
      opponentMinHp,
      selfMinHpRatio,
      damageToMinHpTarget,
      oppActiveHasAura,
      selfActiveHasAura,
      reactionChainReady,
      diceSkillAlignment,
      diceColorEntropy,
      opponentDeclaredEnd,
      selfActionCountInRound,
      setupCompletion,
      executionReadiness,
      closingPressure,
      opponentThreatScore,
      // ── H1: Burst window ──
      burstWindowUrgency: 0,
      anyCharacterNearBurst: selfNearBurstCount > 0 ? 1 : 0,
      // ── H2: Character functional tier ──
      activeCharTier: 1,
      coreCharHpRatio: selfMinHpRatio,
      coreCharCollapseDistance: 1,
      // ── H3: Turn plan alignment ──
      turnPlanAlignment: 0,
      // ── H7: Character count adaptation ──
      selfCharacterAdvantage: aliveAdvantage,
      // ── H8: Functional collapse ──
      minCollapseDistance: 1,
      avgCollapseDistance: 1,
      opponentMinCollapseDistance: 1,
      opponentDamageCapacity: opponentThreatScore,
      opponentReactionBonus: safeNumber(observation?.derived?.opp_reaction_bonus_now),
      // ── Burst waste tracking ──
      wastedEnergyThisGame: 0,
    };
  }

  /** Get ordered feature names (same order as vector values). */
  static featureNames(): (keyof ScoringFeatureVector)[] {
    return [
      "isUseSkill", "isPlayCard", "isSwitchActive", "isDeclareEnd", "isOtherAction",
      "isNormalAttack", "isElementalSkill", "isBurst", "isPureUtility",
      "isEventCard", "isSupportCard", "isEquipmentCard", "isWeaponCard", "isArtifactCard", "isTechniqueCard",
      "damageEstimate", "healingEstimate", "selfHealValue", "teamHealValue", "reactionValue", "tempoValue",
      "drawValue", "diceFixValue", "energyGainValue", "createSupportValue", "createSummonValue", "createEquipmentValue",
      "forcedSwitchValue", "selfSwitchValue", "targetCount", "willBeEffectless",
      "totalCost", "costRatio",
      "selfActiveHpRatio", "selfTeamAvgHpRatio", "selfAliveCount",
      "selfActiveEnergyGap", "selfNearBurstCount",
      "opponentActiveHpRatio", "opponentTeamAvgHpRatio", "opponentAliveCount",
      "opponentBurstReady",
      "diceCount", "omniCount", "cardsInHand", "supportCount", "summonCount", "supportRoom", "summonRoom", "round",
      "hpAdvantage", "aliveAdvantage", "energyUrgency", "healUrgency",
      "canKillTarget", "hasReaction", "isFastAction",
      "opponentMinHp", "selfMinHpRatio", "damageToMinHpTarget",
      "oppActiveHasAura", "selfActiveHasAura", "reactionChainReady",
      "diceSkillAlignment", "diceColorEntropy",
      "opponentDeclaredEnd", "selfActionCountInRound",
      "setupCompletion", "executionReadiness", "closingPressure", "opponentThreatScore",
      "burstWindowUrgency", "anyCharacterNearBurst",
      "activeCharTier", "coreCharHpRatio", "coreCharCollapseDistance",
      "turnPlanAlignment",
      "selfCharacterAdvantage",
      "minCollapseDistance", "avgCollapseDistance", "opponentMinCollapseDistance",
      "opponentDamageCapacity", "opponentReactionBonus",
      "wastedEnergyThisGame",
    ];
  }

  /** Convert a feature vector to a flat number array (in canonical order). */
  static toArray(vec: ScoringFeatureVector): number[] {
    return FeatureExtractor.featureNames().map((k) => vec[k]);
  }

  /** Reconstruct a ScoringFeatureVector from a flat number array. */
  static fromArray(arr: number[]): ScoringFeatureVector {
    const names = FeatureExtractor.featureNames();
    const vec: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      vec[names[i]] = arr[i] ?? 0;
    }
    return vec as unknown as ScoringFeatureVector;
  }
}
