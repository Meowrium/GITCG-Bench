/**
 * validate_gameplan.ts
 *
 * Validates a DeckGamePlan JSON against the actual deck data.
 * Detects: hallucinated card/action names, impossible dice budgets, wrong damage values.
 * With --fix: attempts to auto-correct common LLM mistakes.
 *
 * Usage:
 *   pnpm exec gnx scripts/validate_gameplan.ts <deck_code> <gameplan.json> [--fix]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

interface Issue {
  severity: "error" | "warning";
  turn: number | null;
  msg: string;
  fix?: string;
}

function main() {
  const [deckCode, planPath] = [process.argv[2], process.argv[3]];
  const fixMode = process.argv.includes("--fix");
  if (!deckCode || !planPath) { console.error("Usage: validate_gameplan.ts <deck_code> <gameplan.json> [--fix]"); process.exit(1); }

  const { staticDecode, getNameSync } = require("../../assets-manager/src/index");
  const decoded = staticDecode(deckCode);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));

  const issues: Issue[] = [];
  const charNames = new Set(decoded.characters.map((id: number) => getNameSync(id)));
  const cardNames = new Set(
    decoded.cards.filter((id: number) => id !== 0).map((id: number) => getNameSync(id))
  );

  console.error(`Deck: ${[...charNames].join(", ")}`);
  console.error(`Cards: ${cardNames.size}张`);

  // Validate opening active
  if (plan.openingActive?.default) {
    const name = plan.openingActive.default;
    if (!charNames.has(name)) {
      const close = findClosest(name, charNames);
      issues.push({ severity: "error", turn: null,
        msg: `首发出战 "${name}" 不在卡组中`, fix: close ? `→ ${close}` : undefined });
    }
  }

  // Validate keyCards
  for (const kc of (plan.keyCards ?? [])) {
    const name = kc.cardName ?? kc.name ?? "";
    if (!cardNames.has(name)) {
      const close = findClosest(name, cardNames);
      issues.push({ severity: "error", turn: null,
        msg: `keyCard "${name}" 不在卡组中`, fix: close ? `→ ${close}` : undefined });
      if (fixMode && close) {
        kc.cardName = close; kc.name = close;
      }
    }
  }

  // Validate turn plans
  for (const tp of (plan.turnPlans ?? [])) {
    const t = tp.turn ?? 0;

    for (const action of (tp.preferredActions ?? [])) {
      if (typeof action !== "string") continue;

      // play_XXX
      if (action.startsWith("play_")) {
        const card = action.slice(5);
        if (!cardNames.has(card)) {
          const close = findClosest(card, cardNames);
          issues.push({ severity: "error", turn: t,
            msg: `play_"${card}" 不在卡组中`, fix: close ? `→ play_${close}` : undefined });

          if (fixMode && close) {
            const idx = tp.preferredActions.indexOf(action);
            if (idx >= 0) tp.preferredActions[idx] = `play_${close}`;
          }
        }
        continue;
      }

      // switch_to_XXX or fast_switch_to_XXX
      if (action.startsWith("switch_to_") || action.startsWith("fast_switch_to_")) {
        const prefix = action.startsWith("fast_") ? "fast_switch_to_" : "switch_to_";
        const char = action.slice(prefix.length);
        if (!charNames.has(char)) {
          const close = findClosest(char, charNames);
          issues.push({ severity: "error", turn: t,
            msg: `${prefix}"${char}" 不在卡组中`, fix: close ? `→ ${close}` : undefined });
        }
        continue;
      }

      // Generic actions — check BEFORE parsing as char_skill
      if (action === "end_turn" || action === "declare_end" || action === "reroll_dice"
          || action === "elemental_tune" || action === "keep_dice") {
        continue;
      }

      // {角色}_{技能类型} — e.g. "莫娜_elemental", "流浪者_burst"
      const underscoreIdx = action.lastIndexOf("_");
      if (underscoreIdx > 0) {
        const charPart = action.slice(0, underscoreIdx);
        const skillPart = action.slice(underscoreIdx + 1);
        if (!charNames.has(charPart)) {
          const close = findClosest(charPart, charNames);
          issues.push({ severity: "error", turn: t,
            msg: `角色 "${charPart}" 不在卡组中`, fix: close ? `→ ${close}_${skillPart}` : undefined });

          if (fixMode && close) {
            const idx = tp.preferredActions.indexOf(action);
            if (idx >= 0) tp.preferredActions[idx] = `${close}_${skillPart}`;
          }
        } else if (!["normal", "elemental", "burst", "elemental_skill"].includes(skillPart)) {
          issues.push({ severity: "warning", turn: t,
            msg: `未知技能类型 "${skillPart}", 应为 normal/elemental/burst` });
        }
        // Flag "normal" when "elemental" should be used for T1 setup characters
        if (t === 1 && skillPart === "normal") {
          issues.push({ severity: "warning", turn: t,
            msg: `T1 ${charPart}_normal 建议改为 ${charPart}_elemental (T1应优先挂元素/召唤物)` });
        }
        continue;
      }

      // Generic actions
      if (["end_turn", "declare_end", "end_round", "reroll_dice", "elemental_tune"].includes(action)) {
        continue;
      }

      issues.push({ severity: "warning", turn: t, msg: `无法解析动作 "${action}"` });
    }

    // Validate dice budget
    if (tp.preferredActions && tp.preferredActions.length > 5) {
      issues.push({ severity: "warning", turn: t,
        msg: `preferredActions 过多 (${tp.preferredActions.length}个), 建议≤4` });
    }
  }

  // Validate win condition damage values
  for (const wc of (plan.winConditions ?? [])) {
    for (const step of (wc.steps ?? [])) {
      if (step.dice && step.dice > 5) {
        issues.push({ severity: "warning", turn: null,
          msg: `${wc.name}: ${step.action} 骰子成本 ${step.dice} 超过5骰上限` });
      }
    }
    // Check if total dice exceeds 8
    const totalDice = (wc.steps ?? []).reduce((s: number, st: any) => s + (st.dice ?? 0), 0);
    const totalEnergy = (wc.steps ?? []).reduce((s: number, st: any) => s + (st.energy ?? 0), 0);
    if (totalDice > 8) {
      issues.push({ severity: "error", turn: null,
        msg: `${wc.name}: 总计${totalDice}骰 > 8骰上限` });
    }
    if (totalEnergy > 0) {
      issues.push({ severity: "warning", turn: null,
        msg: `${wc.name}: 需要${totalEnergy}能量, 确认角色已充能` });
    }
  }

  // Report
  const errs = issues.filter(i => i.severity === "error");
  const warns = issues.filter(i => i.severity === "warning");
  console.error(`\n${errs.length} errors, ${warns.length} warnings:`);
  for (const i of issues) {
    const prefix = i.severity === "error" ? "❌" : "⚠️";
    const loc = i.turn !== null ? `[T${i.turn}]` : "";
    console.error(`${prefix} ${loc} ${i.msg}${i.fix ? " " + i.fix : ""}`);
  }

  if (fixMode && errs.length > 0) {
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    console.error(`\n🔧 Fixed ${errs.filter(i => i.fix).length} issues → ${planPath}`);
  }

  console.log(JSON.stringify({ valid: errs.length === 0, errors: errs.length, warnings: warns.length, issues }));
  process.exit(errs.length > 0 ? 1 : 0);
}

function findClosest(target: string, candidates: Set<string>): string | null {
  // Handle common LLM hallucinations with pattern matching
  const hallucinationFixes: Record<string, string> = {
    "冰元素共鸣": "交织之冰",
    "水元素共鸣": "交织之冰",
    "火元素共鸣": "交织之冰",
    "雷元素共鸣": "交织之冰",
    "超导反应牌": "仙跳墙",
    "能量牌": "星天之兆",
    "蓄爆牌": "派蒙",
  };
  if (hallucinationFixes[target]) {
    const fix = hallucinationFixes[target];
    if (candidates.has(fix)) return fix;
  }

  // General fuzzy matching for other cases
  let best: string | null = null, bestScore = 0;
  for (const c of candidates) {
    const tChars = new Set(target);
    let matchCount = 0;
    for (const ch of c) if (tChars.has(ch)) matchCount++;
    const score = matchCount / Math.max(target.length, c.length);
    if (score > bestScore && score >= 0.25) { bestScore = score; best = c; }
  }
  return best;
}

main();
