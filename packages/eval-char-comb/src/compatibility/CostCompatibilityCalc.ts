/**
 * CostCompatibilityCalc
 *
 * 计算两角色之间的骰子费用兼容性。
 * 同元素角色争抢骰子（高冲突），异元素角色允许元素调和（低冲突）。
 */

import type { CostCompatibility } from "../profiler/types.js";
import type { CharacterOutputProfile } from "../profiler/types.js";

/** 每回合可用骰子数 */
const DICE_PER_ROUND = 8;

/**
 * 计算两角色之间的费用兼容性。
 */
export function computeCostCompatibility(
  profileA: CharacterOutputProfile,
  profileB: CharacterOutputProfile,
): CostCompatibility {
  const elemA = profileA.resourceProfile.primaryElement;
  const elemB = profileB.resourceProfile.primaryElement;
  const idealA = profileA.resourceProfile.idealDicePerRound;
  const idealB = profileB.resourceProfile.idealDicePerRound;

  // 骰子冲突度：同元素 = 1.0，异元素 = 基于各自 elementDice 需求相对于总骰量
  const sameElement = elemA === elemB;

  let diceConflictRate: number;
  if (sameElement) {
    // 同元素完全竞争同色骰
    diceConflictRate = 1.0;
  } else {
    // 异元素：综合 elementDice + voidDice 需求
    // voidDice 完全冲突（万能骰对所有角色都等价）
    // elementDice 不直接冲突（不同色），但占用总骰池
    const elemDiceA = getMaxElementDice(profileA);
    const elemDiceB = getMaxElementDice(profileB);
    const voidA = getMaxVoidDice(profileA);
    const voidB = getMaxVoidDice(profileB);

    // 两角色同时满操作时的总骰需求 vs 双回合可用量
    const totalDemand = elemDiceA + voidA + elemDiceB + voidB;
    diceConflictRate = Math.min(1, totalDemand / (DICE_PER_ROUND * 2));
  }

  // 最少骰子需求
  const minDiceForFullRotation = sameElement
    ? idealA + idealB // 同元素需要全部同色基
    : Math.max(idealA, idealB) + Math.min(idealA, idealB) * 0.5; // 异元素可调和

  // 8骰是否够双角色同回合操作
  const canDualOutputInOneRound = minDiceForFullRotation <= DICE_PER_ROUND;

  return {
    diceConflictRate: Math.round(diceConflictRate * 100) / 100,
    minDiceForFullRotation: Math.round(minDiceForFullRotation * 10) / 10,
    canDualOutputInOneRound,
  };
}

/** 获取角色非爆发技能中 void 骰最大需求 */
function getMaxVoidDice(profile: CharacterOutputProfile): number {
  let maxVoid = 0;
  for (const sk of profile.skills) {
    if (sk.type !== "burst" && sk.type !== "passive") {
      maxVoid = Math.max(maxVoid, sk.cost.voidDice);
    }
  }
  return maxVoid;
}

/** 获取角色非爆发技能中 element 骰最大需求 */
function getMaxElementDice(profile: CharacterOutputProfile): number {
  let maxElem = 0;
  for (const sk of profile.skills) {
    if (sk.type !== "burst" && sk.type !== "passive") {
      maxElem = Math.max(maxElem, sk.cost.elementDice);
    }
  }
  return maxElem;
}
