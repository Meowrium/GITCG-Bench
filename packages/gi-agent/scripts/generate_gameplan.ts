/**
 * generate_gameplan.ts
 *
 * Orchestrator: extracts deck profile → builds LLM prompt → validates output.
 * Uses eval-char-comb for character profiles and assets-manager for card data.
 *
 * Usage:
 *   pnpm exec gnx scripts/generate_gameplan.ts <deck_code> [--model deepseek-chat] [--output gameplan.json]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Configuration ─────────────────────────────────────────

interface CliOptions {
  deckCode: string;
  model: string;
  output: string;
  apiKey: string;
  apiBaseUrl: string;
  profileJson: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const deckCode = args.find(a => !a.startsWith("--")) ?? "";
  return {
    deckCode,
    model: getArg(args, "--model") ?? process.env.GAMEPLAN_MODEL ?? "deepseek-chat",
    output: getArg(args, "--output") ?? `gameplan-${deckCode.slice(0, 12)}.json`,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    apiBaseUrl: process.env.GAMEPLAN_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com/v1",
    profileJson: getArg(args, "--profiles") ?? "../../eval-char-comb/output/character-profiles.json",
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ─── Deck Profile Builder ──────────────────────────────────

const ELEMENT_MAP: Record<number, string> = {
  0: "物理", 1: "冰", 2: "水", 3: "火", 4: "雷", 5: "风", 6: "岩", 7: "草",
};

interface SkillBrief {
  name: string;
  type: string;
  cost: string;            // compact: "3冰" or "3冰+2e"
  effect: string;          // compact: "3冰伤→召唤箓灵(回合末1冰伤×2)"
  phase: string;           // "e1.2/m1.3/l0.8" or ""
  noEnergy?: boolean;      // E skill does not generate energy (e.g. 宵宫)
  teammateTrigger?: boolean; // Q creates combat status that allies trigger
}

interface CharBrief {
  name: string;
  element: string;
  hp: number;
  energy: number;
  skills: SkillBrief[];
  note: string;
  talentCard?: string;     // talent card name if in deck
}

interface CardBrief {
  name: string;
  type: string;
  cost: string;
  effect: string;
}

function buildDeckBrief(opts: CliOptions): { chars: CharBrief[]; cards: CardBrief[]; reactions: string; diceNote: string } {
  const { staticDecode, getNameSync, DEFAULT_ASSETS_MANAGER } = require("../../assets-manager/src/index");

  // Load profiles
  let profiles: any[] = [];
  if (existsSync(opts.profileJson)) {
    profiles = JSON.parse(readFileSync(opts.profileJson, "utf8"));
  }
  const profileById = new Map<number, any>();
  for (const p of profiles) profileById.set(p.definitionId, p);

  const decoded = staticDecode(opts.deckCode);
  const chars: CharBrief[] = [];
  const cards: CardBrief[] = [];

  // Talent card detection: map character name → "有天赋"  
  // Talent card IDs follow pattern: 21 + charId.slice(1) + 1 (e.g. 宵宫 1305 → 213051)
  const talentByCharName = new Map<string, boolean>();
  for (const cardId of decoded.cards) {
    if (cardId === 0) continue;
    if (cardId >= 210000 && cardId < 220000) {
      // Extract character ID: talent id = 21 + charIdWithoutFirstDigit + 1
      // e.g. 213051 → "305" → charId = 1305
      const mid = String(cardId).slice(2, -1); // "305" from "213051"
      const charId = parseInt("1" + mid, 10);   // "1305"
      if (decoded.characters.includes(charId)) {
        const charName = getNameSync(charId);
        if (charName) talentByCharName.set(charName, true);
      }
    }
  }

  // Characters from eval-char-comb profiles
  for (const charId of decoded.characters) {
    const name = getNameSync(charId);
    const p = profileById.get(charId);
    const skills: SkillBrief[] = [];

    if (p?.skills) {
      for (const sk of p.skills) {
        if (sk.type === "passive" || sk.type === "technique") continue;

        const costParts: string[] = [];
        if (sk.cost.elementDice > 0) costParts.push(`${sk.cost.elementDice}${ELEMENT_MAP[p.base?.element] ?? "?"}`);
        if (sk.cost.voidDice > 0) costParts.push(`${sk.cost.voidDice}无`);
        if (sk.cost.energyCost > 0) costParts.push(`${sk.cost.energyCost}e`);
        const cost = costParts.join("+") || `${sk.cost.totalDice}骰`;

        const effectParts: string[] = [];
        if (sk.output?.mainDamageValue) {
          const el = ELEMENT_MAP[sk.output.mainDamageType] ?? "伤";
          effectParts.push(`${sk.output.mainDamageValue}${el}伤`);
        }
        if (sk.output?.createsSummon && sk.output.summonProfile) {
          const sp = sk.output.summonProfile;
          effectParts.push(`召唤(回合末${sp.endPhaseDamage}伤×${sp.duration})`);
        }
        if (sk.output?.createsStatus && sk.output.statusProfile) {
          const sp = sk.output.statusProfile;
          const tags: string[] = [];
          if (sp.teammateTriggerable) tags.push("队友触发");
          effectParts.push(`状态(${sp.duration ?? "?"}回合${tags.length ? ";" + tags.join(";") : ""})`);
        }

        const phase = sk.phaseValues
          ? `${sk.phaseValues.earlyGame.toFixed(1)}/${sk.phaseValues.midGame.toFixed(1)}/${sk.phaseValues.lateGame.toFixed(1)}`
          : "";

        skills.push({
          name: getNameSync(sk.definitionId) ?? `技${sk.definitionId}`,
          type: sk.type,
          cost,
          effect: effectParts.join("→"),
          phase,
          noEnergy: sk.type === "elemental" && !sk.gainEnergy || undefined,
          teammateTrigger: sk.output?.statusProfile?.teammateTriggerable || undefined,
        });
      }
    }

    let note = "";
    if (p?.rhythm) {
      const r = p.rhythm;
      const parts: string[] = [];
      if (r.minBurstCycle) parts.push(`充能${r.minBurstCycle}回合`);
      if (r.dotDamagePerRound > 0) parts.push(`后台${r.dotDamagePerRound}伤/回合`);
      if (r.hasDeferredBurst) parts.push("延迟爆发");
      note = parts.join("; ");
    }

    chars.push({
      name,
      element: ELEMENT_MAP[p?.base?.element] ?? getNameSync(charId) ?? "?",
      hp: p?.base?.health ?? 10,
      energy: p?.base?.maxEnergy ?? 3,
      skills,
      note,
      talentCard: talentByCharName.has(name) ? getNameSync(
        parseInt("21" + String(charId).slice(1) + "1")
      ) ?? undefined : undefined,
    });
  }

  for (const cardId of decoded.cards) {
    if (cardId === 0) continue;
    const name = getNameSync(cardId);
    if (!name) continue;

    let cost = "?";
    let desc = "";
    let type = "事件";
    try {
      const mgr = DEFAULT_ASSETS_MANAGER;
      const data = mgr.getDataSync?.(cardId) as any;
      if (data) {
        desc = (data.description ?? "").replace(/\n/g, " ").slice(0, 120);
        const pc = data.playCost ?? [];
        cost = pc.map((c: any) => typeof c.count === "number" && typeof c.type === "string"
          ? `${c.count}${c.type}` : "").filter(Boolean).join("+") || "0";
        if (data.tags?.includes("equipment")) type = "装备";
        else if (data.tags?.includes("support")) type = "支援";
      }
    } catch {}
    cards.push({ name, type, cost, effect: desc });
  }

  // Element reactions
  const els = [...new Set(chars.map(c => c.element).filter(e => e.length <= 2))];
  const reactMap: Record<string, Record<string, string>> = {
    "冰": { "雷": "超导(冰伤+1,AOE减抗)" },
    "雷": { "冰": "超导" },
  };
  const reacts: string[] = [];
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++) {
      const r = reactMap[els[i]]?.[els[j]];
      if (r) reacts.push(`${els[i]}+${els[j]}=${r}`);
    }

  const diceNote = els.length >= 3 ? "三元素" : els.length === 2 ? "双元素" : "单元素";

  return { chars, cards, reactions: reacts.join(", ") || "单元素", diceNote };
}

// ─── LLM Prompt Builder ────────────────────────────────────

function buildPrompt(brief: ReturnType<typeof buildDeckBrief>): string {
  const charsText = brief.chars.map(c => {
    const lines = [`## ${c.name} ${c.element} HP${c.hp} E${c.energy}${c.talentCard ? " [天赋在卡组]" : ""} ${c.note}`];
    for (const sk of c.skills) {
      const flags: string[] = [];
      if (sk.noEnergy) flags.push("⛔不充能");
      if (sk.teammateTrigger) flags.push("🔗队友触发");
      const flagStr = flags.length ? ` ${flags.join(" ")}` : "";
      lines.push(`  [${sk.type}] ${sk.name} | ${sk.cost} | ${sk.effect}${flagStr}${sk.phase ? " | φ" + sk.phase : ""}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  // All card names for strict reference
  const cardNames = brief.cards.map(c => c.name).join(", ");
  const cardsWithEffect = brief.cards.filter(c => c.effect);
  const cardsText = cardsWithEffect
    .map(c => `- [${c.type}:${c.cost}] ${c.name}: ${c.effect}`)
    .join("\n");

  // Detect deck characteristics
  const hasMona = brief.chars.some(c => c.name === "莫娜");
  const elements = [...new Set(brief.chars.map(c => c.element).filter(e => e.length <= 2))];

  // Detect OTK/burst decks: any Q with teammateTriggerable + high-burst character
  const hasTeammateTriggerQ = brief.chars.some(c =>
    c.skills.some(sk => sk.teammateTrigger)
  );
  const hasNoEnergyE = brief.chars.some(c =>
    c.skills.some(sk => sk.noEnergy)
  );

  let specialRules = "";
  if (hasMona) specialRules += "\n- **莫娜被动速切**: T1用莫娜elemental(不是normal!)挂水召唤虚影,再利用被动快速切人抢节奏";
  if (elements.includes("冰") && elements.includes("水")) specialRules += "\n- **冻结**: 水+冰=冻结(无法行动),优先冻结对方出战角色";
  if (elements.includes("冰") && elements.includes("雷")) specialRules += "\n- **超导**: 冰+雷=超导(AOE全体1冰伤+物理减抗)";
  if (hasTeammateTriggerQ && hasNoEnergyE) specialRules += `
- **OTK节奏**: 该卡组为蓄爆斩杀型。T1可以接受让节奏(铺垫装备/蓄能/过牌)，优先为🔗队友触发Q充能，斩杀回合集中爆发。开局角色应选择能最快铺开蓄爆链条的角色。`;

  return `你是七圣召唤策略专家。根据卡组精确数据生成回合级战略计划JSON。

## 角色技能
${charsText}

## 行动牌(${brief.cards.length}张) — 只能用这些名字:
${cardsText}

## 可用卡牌名(严格): ${cardNames}
${specialRules}

## 局势
元素: ${brief.reactions} | 骰子: ${brief.diceNote}

## 🎯 开局角色选择 (必填)
- 分析每个角色的开局价值：E技能类型(召唤/自buff/直伤)、是否⛔不充能、Q的🔗队友触发价值、天赋卡是否在卡组中
- 如有天赋卡：天赋卡上场立即使用E(免费)，显著提高该角色开局价值
- 如有🔗队友触发Q：该Q为全队提供增益，应优先充能开幕
- ⛔不充能的E：充Q只能靠普攻，考虑是否值得跳过E打物伤攒Q
- 输出选择理由到openingActive.reason字段

---
生成JSON(只返回JSON,无markdown):

{
  "archetype": "midrange_reaction | burst_otk | aggro_rush | freeze_control | summon_value | overload_tempo | dual_element_combo",
  "turnPlans": [
    {
      "turn": 1, "goal": "一句话目标",
      "preferredActions": ["...", "..."],  // 最多4个, 按优先级
      "avoidActions": ["..."],
      "diceBudget": {"min": 3, "ideal": 6, "elements": [{"el": "冰", "n": 3}]},
      "endCondition": "..."
    }
  ],
  "winConditions": [
    {"name": "名", "trigger": "条件", "steps": [{"action": "X_burst", "dmg": N, "dice": N, "energy": N}]}
  ],
  "openingActive": {"default": "角色名", "reason": "选择理由"},
  "keyCards": [{"cardName": "精确卡名", "priority": 8, "timing": "early|mid|late|always", "reason": "原因"}]
}

⛔ 严格规则:
- **角色动作格式**: \"{角色名}_{技能类型}\" (如 \"莫娜_elemental\", \"流浪者_burst\") — 不加play_前缀!
- **卡牌动作格式**: \"play_{卡牌名}\" (如 \"play_派蒙\") — 卡牌名必须精确匹配上面的列表
- **切人**: \"switch_to_{角色名}\" 或 \"fast_switch_to_{角色名}\"
- T1开局优先elemental(挂元素/召唤物), 不是normal!
- 每回合preferredActions最多4个, end_turn总是最后一个
- 每回合骰子预算≤8; 斩杀链单步骰子=技能实际费用(通常3)
- keyCards.cardName必须严格匹配上面的卡牌名
- 禁止编造卡牌名如\"冰元素共鸣\"\"能量牌\"\"重攻击\" — 只使用上面列出的名字`;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (!opts.deckCode) { console.error("Usage: pnpm exec gnx scripts/generate_gameplan.ts <deck_code>"); process.exit(1); }

  console.error("📊 Building brief...");
  const brief = buildDeckBrief(opts);
  const prompt = buildPrompt(brief);

  if (!opts.apiKey) {
    console.log(JSON.stringify({ _note: "DRY RUN — set OPENAI_API_KEY", brief, promptLen: prompt.length }, null, 2));
    process.exit(0);
  }

  console.error(`🤖 LLM (${opts.model})...  prompt=${prompt.length}chars`);
  const resp = await callLlm(prompt, opts);

  let plan;
  try {
    const t = resp.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
    plan = JSON.parse(t);
  } catch {
    console.error("❌ JSON parse failed");
    console.log(JSON.stringify({ error: "parse_failed", raw: resp.slice(0, 2000) }));
    process.exit(1);
  }

  writeFileSync(opts.output, JSON.stringify(plan, null, 2));
  console.error(`✅ ${opts.output}`);
  console.log(JSON.stringify(plan, null, 2));
}

async function callLlm(prompt: string, opts: CliOptions): Promise<string> {
  const body = JSON.stringify({
    model: opts.model, max_tokens: 8192, temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });
  const resp = await fetch(`${opts.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.apiKey}` },
    body,
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "?");
    throw new Error(`API ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
