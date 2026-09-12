// Copyright (C) 2024-2025 Guyutongxue
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

import { expect, test } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CombatWindowExtractor } from "./window-extractor.js"
import type {
  RuntimeDigestArtifact,
  RuntimeFeedbackArtifact,
  RuntimeFragmentArtifact,
  RuntimePlanArtifact,
} from "./types.js"

test("CombatWindowExtractor builds 2-4 action candidate windows from runtime artifacts", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "gi-agent-combat-window-"))
  const sessionId = "sess_extract"
  const plan: RuntimePlanArtifact = {
    version: "PlanV1",
    session_id: sessionId,
    deck_fingerprint: "1411-1510-2102",
    global_goal: "Take tempo with a short burst window.",
  }
  await writeFile(join(runtimeDir, `${sessionId}.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf8")

  for (let i = 0; i < 3; i += 1) {
    const digest: RuntimeDigestArtifact = {
      version: "TurnDigestV1",
      digest_ref: `digest_${i}`,
      session_id: sessionId,
      round: 1,
      turn: 0,
      pending_method: "action",
      strategic_profile_ref: join(runtimeDir, `${sessionId}.json`),
      self_summary: {
        active_character_id: -1,
        hand_count: 3,
        characters: [
          { id: -1, hp: 8, max_hp: 10, energy: i, max_energy: 2, alive: true },
          { id: -2, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true },
        ],
      },
      opponent_summary: {
        active_character_id: -101,
        characters: [
          { id: -101, hp: 9 - i, max_hp: 10, energy: 0, max_energy: 2, alive: true },
        ],
      },
      resource_summary: {
        dice_count: 5 - i,
        omni_count: 1,
      },
      character_definitions: [
        {
          id: -1,
          definition_id: 1411,
          name: "Character A",
          element: "hydro",
          weapon_type: "catalyst",
        },
        {
          id: -2,
          definition_id: 1510,
          name: "Character B",
          element: "electro",
          weapon_type: "sword",
        },
        {
          id: -101,
          definition_id: 2304,
          name: "Character X",
          element: "pyro",
          weapon_type: "pole",
        },
      ],
      candidate_actions: [
        {
          candidate_id: `cand_${i}`,
          action_case: i === 1 ? "switchActive" : "useSkill",
          tags: i === 1 ? ["switchActive", "fast_switch", "valid"] : ["useSkill", "reaction", "valid"],
          notes: [],
        },
        {
          candidate_id: `alt_${i}`,
          action_case: "declareEnd",
          tags: ["declareEnd", "valid"],
          notes: [],
        },
      ],
      active_combat_window: {
        window_id: "r1_window",
        active_node_id: `node_${i}`,
        actions_taken: i,
        max_actions: 3,
      },
    }
    const fragment: RuntimeFragmentArtifact = {
      version: "DecisionFragmentV1",
      fragment_ref: `fragment_${i}`,
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      intent: i === 1 ? "pivot" : "convert",
      must_do: [],
      avoid: [],
      preference_order: [],
      created_at: `2026-03-20T12:00:0${i}.000Z`,
    }
    const feedback: RuntimeFeedbackArtifact = {
      version: "ExecutionFeedbackV1",
      session_id: sessionId,
      digest_ref: digest.digest_ref,
      fragment_ref: fragment.fragment_ref,
      selected_candidate_id: `cand_${i}`,
      execution_ok: true,
      fallback_used: false,
      active_window_id: "r1_window",
      active_node_id: `node_${i}`,
      created_at: `2026-03-20T12:00:0${i}.500Z`,
    }
    const ts = 1000 + i
    await writeFile(join(runtimeDir, `${sessionId}_digest_${ts}.json`), `${JSON.stringify(digest, null, 2)}\n`, "utf8")
    await writeFile(join(runtimeDir, `${sessionId}_fragment_${ts}.json`), `${JSON.stringify(fragment, null, 2)}\n`, "utf8")
    await writeFile(join(runtimeDir, `${sessionId}_feedback_${ts}.json`), `${JSON.stringify(feedback, null, 2)}\n`, "utf8")
  }

  const extractor = new CombatWindowExtractor()
  const result = await extractor.extract({
    runtime_plans_dir: runtimeDir,
    min_actions: 2,
    max_actions: 3,
    top_k_per_session: 10,
  })

  expect(result.sessions_scanned).toBe(1)
  expect(result.windows.length).toBe(3)
  expect(result.windows.some((window) => window.action_count === 3)).toBe(true)
  expect(result.windows[0]?.deck_fingerprint_self).toBe("1411-1510-2102")
  expect(result.windows[0]?.deck_fingerprint_opp).toBe("2304")
  expect(result.windows[0]?.state_fingerprint.pending_method).toBe("action")
})
