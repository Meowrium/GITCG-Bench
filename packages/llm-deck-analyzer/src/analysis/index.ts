// Copyright (C) 2024-2025 Guyutongxue
//
// Analysis module barrel export.
// Enhanced deck analysis beyond the baseline heuristic.

export { detectStateDependencies } from "./state-dependency"
export type { StateDependencyEdge } from "./state-dependency"

export { computeEffectiveCost, computeAllEffectiveCosts, findFreeCards } from "./cost-stacking"
export type { CostDiscount, EffectiveCost } from "./cost-stacking"

export { estimateDrawExpectation } from "./draw-expectation"
export type { DrawEstimate } from "./draw-expectation"

export { estimateComboClock } from "./combo-clock"
export type { ComboClockResult } from "./combo-clock"

export { detectResourceCycles } from "./resource-cycles"
export type { ResourceCycle } from "./resource-cycles"

export { analyzeZonePressure } from "./zone-pressure"
export type { ZonePressureReport } from "./zone-pressure"

export { computeSkillEfficiency } from "./skill-efficiency"
export type { SkillEfficiency } from "./skill-efficiency"
