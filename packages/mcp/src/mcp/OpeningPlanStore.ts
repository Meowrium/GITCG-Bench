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

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { StandaloneMcpClient } from "../StandaloneMcpClient";

export type PlanV1 = {
  plan_id: string;
  session_id: string;
  deck_fingerprint: string;
  source_skills: string[];
  global_goal: string;
  turn1_3_priorities: string[];
  risk_rules: string[];
  pivot_rules: string[];
  created_at: string;
  updated_at: string;
  version: string;
};

export class OpeningPlanStore {
  private static readonly PLAN_V1_VERSION = "PlanV1";

  private sessionId: string | null = null;
  private client: StandaloneMcpClient;

  constructor(client: StandaloneMcpClient) {
    this.client = client;
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  resolveSessionId(): string {
    if (typeof this.sessionId === "string" && this.sessionId.trim().length > 0) {
      return this.sessionId;
    }
    this.sessionId = `sess_${randomUUID()}`;
    return this.sessionId;
  }

  private sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  getRuntimePlansDir(): string {
    return resolve(process.cwd(), "runtime-plans");
  }

  getPlanFilePath(sessionId: string): string {
    return join(this.getRuntimePlansDir(), `${this.sanitizeSessionId(sessionId)}.json`);
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async findWorkspaceRoot(startDir: string): Promise<string | null> {
    let cursor = resolve(startDir);
    while (true) {
      const opencodePath = join(cursor, ".opencode");
      if (await this.pathExists(opencodePath)) {
        return cursor;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
    return null;
  }

  private async loadSelectedSkillsFromActiveSkills(): Promise<string[]> {
    const root = await this.findWorkspaceRoot(process.cwd());
    if (!root) {
      return ["base-skill"];
    }
    const selectedSkillsPath = join(root, ".opencode", "active-skills", "selected_skills.json");
    if (!(await this.pathExists(selectedSkillsPath))) {
      return ["base-skill"];
    }

    try {
      const raw = await readFile(selectedSkillsPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const skills = this.normalizeStringArray(parsed);
        return skills.length > 0 ? skills : ["base-skill"];
      }
      if (typeof parsed === "object" && parsed !== null) {
        const selectedSkills = this.normalizeStringArray(
          (parsed as { selected_skills?: unknown }).selected_skills,
        );
        if (selectedSkills.length > 0) {
          return selectedSkills;
        }
      }
    } catch (e) {
      console.error("[OpeningPlanStore] Failed to read selected_skills.json:", e);
    }

    return ["base-skill"];
  }

  private async resolveDeckFingerprint(): Promise<string> {
    try {
      const deck = await this.client.getDeck0();
      const ids = deck.characters
        .map((character) => character.definition_id)
        .filter((id) => Number.isInteger(id))
        .sort((a, b) => a - b);
      if (ids.length === 0) {
        return "unknown-deck";
      }
      return ids.join("-");
    } catch {
      return "unknown-deck";
    }
  }

  async buildPlanV1(args: Record<string, unknown>): Promise<PlanV1> {
    const sessionId =
      typeof args.session_id === "string" && args.session_id.trim().length > 0
        ? args.session_id
        : this.resolveSessionId();
    this.sessionId = sessionId;

    const sourceSkillsArg = this.normalizeStringArray(args.source_skills);
    const sourceSkills =
      sourceSkillsArg.length > 0 ? sourceSkillsArg : await this.loadSelectedSkillsFromActiveSkills();

    const deckFingerprint =
      typeof args.deck_fingerprint === "string" && args.deck_fingerprint.trim().length > 0
        ? args.deck_fingerprint
        : await this.resolveDeckFingerprint();

    const now = new Date().toISOString();
    return {
      plan_id: typeof args.plan_id === "string" && args.plan_id.trim().length > 0
        ? args.plan_id
        : `plan_${sessionId}_${Date.now()}`,
      session_id: sessionId,
      deck_fingerprint: deckFingerprint,
      source_skills: sourceSkills,
      global_goal: typeof args.global_goal === "string" && args.global_goal.trim().length > 0
        ? args.global_goal
        : "优先建立前 3 回合节奏优势，避免无效换血。",
      turn1_3_priorities: (() => {
        const value = this.normalizeStringArray(args.turn1_3_priorities);
        return value.length > 0
          ? value
          : ["建立元素附着", "争取高价值反应", "保留关键换人窗口"];
      })(),
      risk_rules: (() => {
        const value = this.normalizeStringArray(args.risk_rules);
        return value.length > 0
          ? value
          : ["避免为低收益动作透支骰子", "避免暴露核心角色于可斩杀线"];
      })(),
      pivot_rules: (() => {
        const value = this.normalizeStringArray(args.pivot_rules);
        return value.length > 0
          ? value
          : ["未达成开局目标时转入保守换血", "关键组件缺失时优先保资源与血线"];
      })(),
      created_at: now,
      updated_at: now,
      version: OpeningPlanStore.PLAN_V1_VERSION,
    };
  }

  async writePlanV1(plan: PlanV1): Promise<string> {
    const runtimePlansDir = this.getRuntimePlansDir();
    await mkdir(runtimePlansDir, { recursive: true });
    const planPath = this.getPlanFilePath(plan.session_id);
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf-8");
    return planPath;
  }

  async ensurePlanV1BeforeAction(): Promise<{ ok: true } | { ok: false; error: string }> {
    const sessionId = this.resolveSessionId();
    const planPath = this.getPlanFilePath(sessionId);
    if (await this.pathExists(planPath)) {
      console.error(`[OpeningPlanStore] OPENING_PLAN_READY session=${sessionId} path=${planPath} source=existing`);
      return { ok: true };
    }

    try {
      const plan = await this.buildPlanV1({ session_id: sessionId });
      await this.writePlanV1(plan);
      console.error(`[OpeningPlanStore] OPENING_PLAN_READY session=${sessionId} path=${planPath} source=auto-created`);
      return { ok: true };
    } catch (e) {
      const error = e as Error;
      return {
        ok: false,
        error: `Failed to create PlanV1 before action: ${error.message}`,
      };
    }
  }
}
