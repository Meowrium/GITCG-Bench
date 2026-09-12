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

import type { ToolDefinition } from "./MCPProtocol";
import {
  createToolDefinition,
  createInputSchema,
  createProperty,
} from "./MCPProtocol";
import { isOpponentDeckAllowed } from "./shared-utils";

const ACTION_TOOL_NAMES = new Set([
  "choose_action",
  "elemental_tuning",
  "choose_active",
  "reroll_dice",
  "switch_hands",
  "select_card",
]);

const FRAGMENTED_HIDDEN_TOOL_NAMES = new Set([
  "choose_action",
  "elemental_tuning",
  "select_card",
  "get_game_state",
  "get_screen_state",
  "get_available_commands",
]);

export class StandaloneToolRegistry {
  private toolExposureMode: "direct-action" | "fragmented-decision";

  constructor(toolExposureMode: "direct-action" | "fragmented-decision" = "fragmented-decision") {
    this.toolExposureMode = toolExposureMode;
  }

  getToolExposureMode(): "direct-action" | "fragmented-decision" {
    return this.toolExposureMode;
  }

  isToolHiddenInFragmentedMode(toolName: string): boolean {
    return this.toolExposureMode === "fragmented-decision" && FRAGMENTED_HIDDEN_TOOL_NAMES.has(toolName);
  }

  isActionTool(toolName: string): boolean {
    return ACTION_TOOL_NAMES.has(toolName);
  }

  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    tools.push(
      createToolDefinition(
        "standalone_ping",
        "Check connection to the standalone game",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "wait_for_my_turn",
        "Wait (blocking) until it's your turn to act. Polls game status until hasPendingRpc=true or game ends. Returns a ready-to-use TurnDigestV1 in the 'digest' field and an 'action_effects' array summarizing opponent actions since your last turn (skill used, damage dealt, reactions, character switches). Use poll_interval_ms to control poll frequency (default 500ms), timeout_ms for max wait (default 5 min, 0 = no timeout).",
        createInputSchema({
          poll_interval_ms: createProperty("integer", "Poll interval in milliseconds (default 500)"),
          timeout_ms: createProperty("integer", "Maximum wait in milliseconds (default 300000, 0 = no timeout)"),
        })
      )
    );

    tools.push(
      createToolDefinition(
        "get_game_status",
        "Get current game status including pending RPC and game phase",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_game_result",
        "Check whether the game has ended and return the result. Call this proactively to detect game-over without needing to be inside an action or wait_for_my_turn call. Returns game_over (bool), winner (0|1|null), you_won (bool|null), game_phase, and a message. Available in both direct-action and fragmented-decision modes.",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_game_state",
        "Get complete game state from the standalone game",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_screen_state",
        "Get lightweight screen state (recommended for most use cases)",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_available_commands",
        "Get context-aware list of available commands for current state",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_player0_deck",
        "Get initial deck list for player 0",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "get_turn_digest_v1",
        "Build TurnDigestV1 for the current pending decision point. Returns structured game state (characters, resources, candidates) for LLM analysis. Note: submit_decision_fragment_v1 auto-refreshes the digest on success and returns next_digest in its response — prefer using that over calling this tool again.",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "submit_decision_fragment_v1",
        "Submit DecisionFragmentV1 with DSL rules for structured decision-making. ⚠️ Always use the 'rules' array — tag-based fields (intent/must_do/avoid) are deprecated and will be removed. Each rule has priority (int, lower=higher), optional when conditions, then action_spec, and reason. IMPORTANT: Check the response for 'next_digest' — when present, use it directly for the next submit_decision_fragment_v1 instead of calling get_turn_digest_v1. Always use digest_ref from the latest digest (whether from get_turn_digest_v1 or next_digest).",
        createInputSchema({
          session_id: createProperty("string", "Session ID from TurnDigestV1"),
          digest_ref: createProperty("string", "Digest ref from get_turn_digest_v1 or from the previous response's next_digest"),
          rules: {
            type: "array",
            items: { type: "object" },
            description: "⚠️ REQUIRED: DSL rule chain. Always provide at least 3 rules: (1) playCard rules for any useful hand cards at priority 0-4, (2) useSkill rules with when conditions at priority 5-50, (3) a fallback rule at priority 99. Each rule: { priority: int, when?: [{field, op, value}], then: {action_case, skill_type?, card_def_id?, require_tag?}, reason: string }. Example in prompt.",
          },
          resource: {
            type: "object",
            description: "Resource budget for DSL mode: { max_dice: int, allow_tuning: bool, tuning_target: string }. Recommend { max_dice: 3, allow_tuning: false }.",
          },
          explanation: createProperty("string", "Brief explanation of the overall strategy this fragment represents"),
          anchor_candidate_id: createProperty("string", "Optional: directly anchor to a specific candidate_id to bypass scoring"),
          intent: createProperty("string", "DEPRECATED: Use rules instead"),
          must_do: createProperty("array", "DEPRECATED: Use rules instead"),
          avoid: createProperty("array", "DEPRECATED: Use rules instead"),
          preference_order: createProperty("array", "DEPRECATED: Use rules instead"),
          resource_policy: createProperty("string", "DEPRECATED: Use rules instead"),
          target_policy: createProperty("string", "DEPRECATED"),
          fallback_rule: createProperty("string", "DEPRECATED"),
        })
      )
    );

    tools.push(
      createToolDefinition(
        "get_execution_feedback_v1",
        "Get the latest ExecutionFeedbackV1 from the previous submit_decision_fragment_v1 call. Also contains auto-refreshed next_digest when the action succeeded.",
        createInputSchema({})
      )
    );

    tools.push(
      createToolDefinition(
        "create_opening_plan_v1",
        "Create or update PlanV1 and save to runtime-plans/{session_id}.json before opening actions",
        createInputSchema({
          session_id: createProperty("string", "Session ID used for plan file name"),
          source_skills: {
            type: "array",
            items: { type: "string" },
            description: "Selected skills from pre-filter stage",
          },
          deck_fingerprint: createProperty("string", "Deck fingerprint string"),
          global_goal: createProperty("string", "Global opening goal"),
          turn1_3_priorities: {
            type: "array",
            items: { type: "string" },
            description: "Turn 1-3 priorities",
          },
          risk_rules: {
            type: "array",
            items: { type: "string" },
            description: "Risk control rules",
          },
          pivot_rules: {
            type: "array",
            items: { type: "string" },
            description: "Pivot/transition rules when behind",
          },
        })
      )
    );

    if (isOpponentDeckAllowed()) {
      tools.push(
        createToolDefinition(
          "get_player1_deck",
          "Get initial deck list for player 1",
          createInputSchema({})
        )
      );
    }

    tools.push(
      createToolDefinition(
        "analyze_deck",
        "Analyze a deck code and return structured analysis (characters, cards, skill economy, combos, key cards, archetype).",
        createInputSchema(
          {
            deck_code: createProperty("string", "Base64-encoded deck code"),
            deck_name: createProperty("string", "Human-readable deck name for labeling"),
          },
          ["deck_code"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "analyze_matchup",
        "Analyze a matchup between two decks. Returns cross-analysis with reaction matrix, speed comparison, threats, and suggested gameplan.",
        createInputSchema(
          {
            my_deck_code: createProperty("string", "Base64-encoded deck code for your side"),
            my_deck_name: createProperty("string", "Name for your deck"),
            opponent_deck_code: createProperty("string", "Base64-encoded deck code for opponent"),
            opponent_deck_name: createProperty("string", "Name for opponent deck"),
          },
          ["my_deck_code", "opponent_deck_code"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "strategy_store",
        "Persist or retrieve strategic state (strategy anchors, gameplan notes) across turns.",
        createInputSchema(
          {
            action: createProperty("string", "One of: save, load, delete"),
            key: createProperty("string", "Storage key (e.g. 'p0_anchor')"),
            value: createProperty("object", "JSON value to store (required for 'save' action)"),
          },
          ["action", "key"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "list_cards",
        "List indexed cards/characters with canonical info",
        createInputSchema({
          version: {
            type: "string",
            description: "Version label, defaults to latest",
          },
          language: {
            type: "string",
            enum: ["zh-CN", "en-US"],
            description: "Response language",
          },
          filter: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Filter by type, e.g. character:event:equip...",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Filter by tags (all tags must match)",
              },
              nameLike: {
                type: "string",
                description: "Case-insensitive fuzzy match by canonical name",
              },
            },
            additionalProperties: false,
            description: "Optional filter object",
          },
          page: {
            type: "integer",
            description: "Page index starting from 1",
          },
          pageSize: {
            type: "integer",
            description: "Page size, max 200",
          },
        })
      )
    );

    tools.push(
      createToolDefinition(
        "get_card_by_id",
        "Get canonical card/character content by definitionId",
        createInputSchema(
          {
            definitionId: createProperty("integer", "Definition ID"),
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            include_source: createProperty("boolean", "Include sourcePath/sourceExcerpt"),
          },
          ["definitionId"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "resolve_card",
        "Resolve card by id/name/effect text and return ranked candidates",
        createInputSchema(
          {
            query: createProperty("string", "Card query text, name or definitionId"),
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            topK: createProperty("integer", "Top-k candidates, max 20"),
          },
          ["query"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "validate_card_mapping",
        "Validate whether definitionId and name mappings are correct",
        createInputSchema(
          {
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
            items: {
              type: "array",
              description: "Array of { definitionId, name } entries",
              items: {
                type: "object",
                required: ["definitionId", "name"],
                properties: {
                  definitionId: { type: "integer" },
                  name: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          ["items"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "get_cards_by_ids",
        "Batch query card/character definitions by an array of definitionIds. Returns a map of definitionId → { canonicalName, type, tags, cost, effectText, ... }. More efficient than calling get_card_by_id repeatedly.",
        createInputSchema(
          {
            definition_ids: {
              type: "array",
              items: { type: "integer" },
              description: "Array of definition IDs to look up",
            },
            version: createProperty("string", "Version label, defaults to latest"),
            language: {
              type: "string",
              enum: ["zh-CN", "en-US"],
              description: "Response language",
            },
          },
          ["definition_ids"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "choose_active",
        "Choose active character at the beginning of the game",
        createInputSchema(
          {
            character_id: createProperty(
              "integer",
              "Character ID to choose as active"
            ),
          },
          ["character_id"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "reroll_dice",
        "Choose which dice to reroll at the start of each round",
        createInputSchema(
          {
            dice_to_reroll: createProperty(
              "array",
              "Array of dice types to reroll"
            ),
          },
          ["dice_to_reroll"]
        )
      )
    );

    tools.push(
      createToolDefinition(
        "switch_hands",
        "Choose which cards to remove from initial hand (mulligan/换手牌)",
        createInputSchema(
          {
            removed_hand_ids: createProperty(
              "array",
              "Array of card IDs to remove from hand"
            ),
          },
          ["removed_hand_ids"]
        )
      )
    );

    if (this.toolExposureMode === "direct-action") {
      tools.push(
        createToolDefinition(
          "choose_action",
          "Choose an action by index when it's your turn to act. Returns action_feedback with per-character before/after deltas (hp, energy, aura, shield) and enriched action_effects with resolved character/skill names and damage/reaction type labels.",
          createInputSchema(
            {
              action_index: createProperty(
                "integer",
                "1-indexed action index to choose"
              ),
              used_dice: createProperty(
                "array",
                "Array of dice types to use for the action (optional)"
              ),
              explanation: createProperty(
                "string",
                "Brief reasoning from the LLM for this action (optional)"
              ),
            },
            ["action_index"]
          )
        )
      );

      tools.push(
        createToolDefinition(
          "elemental_tuning",
          "Perform elemental tuning explicitly (discard a hand card and convert one die)",
          createInputSchema({
            removed_card_id: createProperty(
              "integer",
              "Optional hand card entity ID to discard for tuning"
            ),
            target_dice: createProperty(
              "integer",
              "Optional target dice type after tuning"
            ),
            used_dice: createProperty(
              "array",
              "Optional source dice to consume; defaults to auto_selected_dice of matched tuning action"
            ),
          })
        )
      );

      tools.push(
        createToolDefinition(
          "select_card",
          "Select a card from candidates",
          createInputSchema(
            {
              selected_definition_id: createProperty(
                "integer",
                "Card definition ID to select"
              ),
            },
            ["selected_definition_id"]
          )
        )
      );
    }

    if (this.toolExposureMode === "fragmented-decision") {
      return tools.filter((tool) => !FRAGMENTED_HIDDEN_TOOL_NAMES.has(tool.name));
    }

    return tools;
  }
}
