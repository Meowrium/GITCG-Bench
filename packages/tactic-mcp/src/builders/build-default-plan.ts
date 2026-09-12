import type { PlanV1, PlanV2 } from "../contracts"

export type BuildPlanV1Args = {
  session_id: string
  plan_id?: string
  deck_fingerprint: string
  source_skills: string[]
  global_goal?: string
  turn1_3_priorities?: string[]
  risk_rules?: string[]
  pivot_rules?: string[]
}

export function buildDefaultPlanV1(args: BuildPlanV1Args, now = new Date()): PlanV1 {
  const nowIso = now.toISOString()

  return {
    version: "PlanV1",
    plan_id:
      typeof args.plan_id === "string" && args.plan_id.trim().length > 0
        ? args.plan_id
        : `plan_${args.session_id}_${now.getTime()}`,
    session_id: args.session_id,
    deck_fingerprint: args.deck_fingerprint,
    source_skills: args.source_skills,
    global_goal:
      typeof args.global_goal === "string" && args.global_goal.trim().length > 0
        ? args.global_goal
        : "优先建立前 3 回合节奏优势，避免无效换血。",
    turn1_3_priorities:
      Array.isArray(args.turn1_3_priorities) && args.turn1_3_priorities.length > 0
        ? args.turn1_3_priorities
        : ["建立元素附着", "争取高价值反应", "保留关键换人窗口"],
    risk_rules:
      Array.isArray(args.risk_rules) && args.risk_rules.length > 0
        ? args.risk_rules
        : ["避免为低收益动作透支骰子", "避免暴露核心角色于可斩杀线"],
    pivot_rules:
      Array.isArray(args.pivot_rules) && args.pivot_rules.length > 0
        ? args.pivot_rules
        : ["未达成开局目标时转入保守换血", "关键组件缺失时优先保资源与血线"],
    created_at: nowIso,
    updated_at: nowIso,
  }
}

export type BuildPlanV2Args = {
  session_id: string
  plan_id?: string
  deck_fingerprint: string
  source_skills: string[]
  global_goal?: string
  opening_window?: {
    start_turn?: number
    end_turn?: number
  }
  turn_priorities?: PlanV2["turn_priorities"]
  risk_rules?: PlanV2["risk_rules"]
  pivot_rules?: PlanV2["pivot_rules"]
  trigger_rules?: PlanV2["trigger_rules"]
  fallback_rules?: PlanV2["fallback_rules"]
  notes?: string
}

export function buildDefaultPlanV2(args: BuildPlanV2Args, now = new Date()): PlanV2 {
  const startTurn = Number.isInteger(args.opening_window?.start_turn) ? args.opening_window!.start_turn! : 1
  const endTurnRaw = Number.isInteger(args.opening_window?.end_turn) ? args.opening_window!.end_turn! : 3
  const endTurn = Math.max(startTurn, endTurnRaw)
  const nowIso = now.toISOString()

  return {
    version: "PlanV2",
    plan_id:
      typeof args.plan_id === "string" && args.plan_id.trim().length > 0
        ? args.plan_id
        : `plan_${args.session_id}_${now.getTime()}`,
    session_id: args.session_id,
    deck_fingerprint: args.deck_fingerprint,
    source_skills: args.source_skills,
    global_goal:
      typeof args.global_goal === "string" && args.global_goal.trim().length > 0
        ? args.global_goal
        : "优先建立前 3 回合节奏优势，避免无效换血。",
    opening_window: {
      start_turn: startTurn,
      end_turn: endTurn,
    },
    turn_priorities:
      Array.isArray(args.turn_priorities) && args.turn_priorities.length > 0
        ? args.turn_priorities
        : [
            {
              turn: 1,
              objectives: ["建立元素附着", "避免低价值透支骰子"],
            },
            {
              turn: 2,
              objectives: ["争取高价值反应", "保持核心角色安全血线"],
            },
          ],
    risk_rules: Array.isArray(args.risk_rules) ? args.risk_rules : [],
    pivot_rules: Array.isArray(args.pivot_rules) ? args.pivot_rules : [],
    trigger_rules: Array.isArray(args.trigger_rules) ? args.trigger_rules : [],
    fallback_rules: Array.isArray(args.fallback_rules) ? args.fallback_rules : [],
    created_at: nowIso,
    updated_at: nowIso,
    ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
  }
}
