var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
import {
  ActionValidity,
  DiceType
} from "@gi-tcg/typings";
import { checkDice, chooseDiceValue, flip } from "@gi-tcg/utils";
import {
  NATION_TAGS,
  WEAPON_TAGS
} from "./base/character";
import {
  defineSkillInfo
} from "./base/skill";
import {
  GiTcgCoreInternalEntityNotFoundError,
  GiTcgCoreInternalError
} from "./error";
function getEntityById(state, id) {
  for (const player of state.players) {
    for (const ch of player.characters) {
      if (ch.id === id) {
        return ch;
      }
      for (const entity of ch.entities) {
        if (entity.id === id) {
          return entity;
        }
      }
    }
    for (const key of [
      "combatStatuses",
      "summons",
      "supports",
      "hands",
      "pile",
      "removedEntities"
    ]) {
      const area = player[key];
      for (const entity of area) {
        if (entity.id === id) {
          return entity;
        }
        if ("attachments" in entity) {
          for (const attachment of entity.attachments) {
            if (attachment.id === id) {
              return attachment;
            }
          }
        }
      }
    }
  }
  throw new GiTcgCoreInternalError(`Cannot found entity ${id}`);
}
__name(getEntityById, "getEntityById");
function getAllEntities(state, inclRemoved = false) {
  return getAllEntitiesImpl(state, inclRemoved, false);
}
__name(getAllEntities, "getAllEntities");
function getAllEntitiesWithArea(state, inclRemoved = false) {
  return getAllEntitiesImpl(state, inclRemoved, true);
}
__name(getAllEntitiesWithArea, "getAllEntitiesWithArea");
function getAllEntitiesImpl(state, inclRemoved, withArea) {
  const result = [];
  const resultWithArea = [];
  let append;
  if (withArea) {
    append = /* @__PURE__ */ __name((entity, area) => {
      resultWithArea.push({ state: entity, area });
    }, "append");
  } else {
    append = /* @__PURE__ */ __name((entity, _area) => {
      result.push(entity);
    }, "append");
  }
  const characters = [0, 1].map((who) => {
    const player = state.players[who];
    let activeIdx = 0;
    try {
      activeIdx = getActiveCharacterIndex(player);
    } catch {
    }
    return shiftLeft(player.characters, activeIdx);
  });
  for (const who of [state.currentTurn, flip(state.currentTurn)]) {
    for (const ch of characters[who]) {
      if (ch.variables.alive === 0) {
        const area = {
          type: "characters",
          who,
          characterId: ch.id
        };
        append(ch, area);
        for (const entity of ch.entities) {
          append(entity, area);
        }
      }
    }
  }
  for (const who of [state.currentTurn, flip(state.currentTurn)]) {
    const player = state.players[who];
    const [active, ...standby] = characters[who];
    if (active.variables.alive === 1) {
      const activeArea = {
        type: "characters",
        who,
        characterId: active.id
      };
      append(active, activeArea);
      for (const entity of active.entities) {
        append(entity, activeArea);
      }
    }
    const combatStatusArea = {
      type: "combatStatuses",
      who
    };
    for (const combatStatus of player.combatStatuses) {
      append(combatStatus, combatStatusArea);
    }
    for (const ch of standby) {
      if (ch.variables.alive === 1) {
        const area = {
          type: "characters",
          who,
          characterId: ch.id
        };
        append(ch, area);
        for (const entity of ch.entities) {
          append(entity, area);
        }
      }
    }
    const summonsArea = {
      type: "summons",
      who
    };
    for (const summon of player.summons) {
      append(summon, summonsArea);
    }
    const supportsArea = {
      type: "supports",
      who
    };
    for (const support of player.supports) {
      append(support, supportsArea);
    }
    for (const card of player.hands) {
      const area = {
        type: "hands",
        who,
        cardId: card.id
      };
      append(card, area);
      for (const attachment of card.attachments) {
        append(attachment, area);
      }
    }
    for (const card of player.pile.toReversed()) {
      const area = {
        type: "pile",
        who,
        cardId: card.id
      };
      append(card, area);
      for (const attachment of card.attachments) {
        append(attachment, area);
      }
    }
    if (inclRemoved) {
      const removedArea = {
        type: "removedEntities",
        who
      };
      for (const removedEntity of player.removedEntities) {
        append(removedEntity, removedArea);
      }
    }
  }
  return withArea ? resultWithArea : result;
}
__name(getAllEntitiesImpl, "getAllEntitiesImpl");
function initiativeSkillsOfPlayer(player, includesHidden = false) {
  const activeCh = player.characters.find(
    (ch) => player.activeCharacterId === ch.id
  );
  if (!activeCh) {
    return [];
  }
  return [
    ...activeCh.entities.flatMap(
      (st) => st.definition.skills.filter(
        (sk) => sk.triggerOn === "initiative" && sk.skillType !== "playCard" && (includesHidden || !sk.initiativeSkillConfig.hidden)
      ).map((sk) => ({
        caller: st,
        skill: sk
      }))
    ),
    ...activeCh.definition.skills.filter(
      (sk) => sk.triggerOn === "initiative" && (includesHidden || !sk.initiativeSkillConfig.hidden)
    ).map((sk) => ({
      caller: activeCh,
      skill: sk
    }))
  ];
}
__name(initiativeSkillsOfPlayer, "initiativeSkillsOfPlayer");
function allSkills(state, triggerOn) {
  const result = [];
  const activeChId = state.players[state.currentTurn].activeCharacterId;
  if (activeChId) {
    const caller = getEntityById(
      state,
      state.players[state.currentTurn].activeCharacterId
    );
    for (const ext of state.extensions) {
      for (const skill of ext.definition.skills) {
        if (skill.triggerOn === triggerOn) {
          result.push({ caller, skill });
        }
      }
    }
  }
  for (const entity of getAllEntities(state)) {
    for (const skill of entity.definition.skills) {
      if (skill.triggerOn === triggerOn) {
        result.push({ caller: entity, skill });
      }
    }
  }
  return result;
}
__name(allSkills, "allSkills");
function getEntityArea(state, id) {
  for (const who of [0, 1]) {
    const player = state.players[who];
    for (const ch of player.characters) {
      if (ch.id === id || ch.entities.find((e) => e.id === id)) {
        return {
          type: "characters",
          who,
          characterId: ch.id
        };
      }
    }
    for (const key of [
      "combatStatuses",
      "summons",
      "supports",
      "hands",
      "pile",
      "removedEntities"
    ]) {
      for (const entity of player[key]) {
        if (entity.id === id || "attachments" in entity && entity.attachments.find((a) => a.id === id)) {
          return { type: key, who, cardId: entity.id };
        }
      }
    }
  }
  throw new GiTcgCoreInternalEntityNotFoundError(state, id);
}
__name(getEntityArea, "getEntityArea");
function allEntitiesAtArea(state, area) {
  const result = [];
  const player = state.players[area.who];
  if (area.type === "characters") {
    const characters = player.characters;
    const ch = characters.find((ch2) => ch2.id === area.characterId);
    if (!ch) {
      throw new GiTcgCoreInternalEntityNotFoundError(state, area.characterId);
    }
    result.push(ch, ...ch.entities);
  } else if (area.type === "hands" || area.type === "pile") {
    const card = player[area.type].find((c) => c.id === area.cardId);
    if (!card) {
      throw new GiTcgCoreInternalEntityNotFoundError(state, area.cardId);
    }
    result.push(card, ...card.attachments);
  } else {
    result.push(...player[area.type]);
  }
  return result;
}
__name(allEntitiesAtArea, "allEntitiesAtArea");
function removeEntity(state, id) {
  for (const player of state.players) {
    for (const ch of player.characters) {
      const idx = ch.entities.findIndex((e) => e.id === id);
      if (idx !== -1) {
        const [removed] = ch.entities.splice(idx, 1);
        return removed;
      }
    }
    for (const key of [
      "combatStatuses",
      "summons",
      "supports",
      "hands",
      "pile"
    ]) {
      const area = player[key];
      for (let i = 0; i < area.length; i++) {
        if (area[i].id === id) {
          const [removed] = area.splice(i, 1);
          return removed;
        }
        if (key === "hands" || key === "pile") {
          const attachmentIdx = area[i].attachments.findIndex(
            (a) => a.id === id
          );
          if (attachmentIdx !== -1) {
            const [removed] = area[i].attachments.splice(attachmentIdx, 1);
            return removed;
          }
        }
      }
    }
  }
  throw new GiTcgCoreInternalEntityNotFoundError(state, id);
}
__name(removeEntity, "removeEntity");
function isCharacterInitiativeSkill(skill, allowTechnique = false) {
  const allowSkillType = ["normal", "elemental", "burst"];
  if (allowTechnique) {
    allowSkillType.push("technique");
  }
  return skill.definition.triggerOn === "initiative" && allowSkillType.includes(skill.definition.skillType);
}
__name(isCharacterInitiativeSkill, "isCharacterInitiativeSkill");
function getActiveCharacterIndex(player) {
  const activeIdx = player.characters.findIndex(
    (ch) => ch.id === player.activeCharacterId
  );
  if (activeIdx === -1) {
    throw new GiTcgCoreInternalError(
      `Invalid active character id ${player.activeCharacterId}`
    );
  }
  return activeIdx;
}
__name(getActiveCharacterIndex, "getActiveCharacterIndex");
function findReplaceAction(state, eventArg) {
  const skills = allSkills(state, "replaceAction");
  for (const { caller, skill } of skills) {
    const area = getEntityArea(state, caller.id);
    if (area.type !== "characters") {
      continue;
    }
    const skillInfo = defineSkillInfo({
      caller,
      definition: skill
    });
    if (skill.filter(state, skillInfo, eventArg)) {
      return skillInfo;
    }
  }
  return null;
}
__name(findReplaceAction, "findReplaceAction");
function isSkillDisabled(character) {
  return character.entities.some(
    (st) => st.definition.tags.includes("disableSkill")
  );
}
__name(isSkillDisabled, "isSkillDisabled");
function shouldEnterOverride(exists, incoming) {
  if (incoming.type === "character") {
    return null;
  }
  const existOne = exists.find((et) => et.definition.id === incoming.id) ?? null;
  if (incoming.type === "support") {
    if (incoming.tags.includes("adventureSpot")) {
      return existOne;
    } else {
      return null;
    }
  }
  return existOne;
}
__name(shouldEnterOverride, "shouldEnterOverride");
function getInsertedStateVariables({
  state,
  oldState,
  newStateTemplate,
  opt
}) {
  const definition = newStateTemplate.definition;
  const incomingVariables = newStateTemplate.variables ?? opt?.overrideVariables ?? {};
  if (oldState) {
    const { varConfigs } = definition;
    const newValues = {};
    for (const name in varConfigs) {
      if (opt?.modifyOverriddenVariablesOnly && !(name in incomingVariables)) {
        continue;
      }
      let { initialValue, recreateBehavior } = varConfigs[name];
      if (typeof incomingVariables[name] === "number") {
        initialValue = incomingVariables[name];
      }
      const oldValue = oldState.variables[name] ?? 0;
      switch (recreateBehavior.type) {
        case "default": {
          const defaultBehaviorType = state.versionBehavior.defaultRecreateBehavior;
          if (defaultBehaviorType === "overwrite") {
            newValues[name] = initialValue;
          } else if (defaultBehaviorType === "takeMax") {
            newValues[name] = Math.max(initialValue, oldValue);
          }
          break;
        }
        case "keep": {
          break;
        }
        case "overwrite": {
          newValues[name] = initialValue;
          break;
        }
        case "takeMax": {
          newValues[name] = Math.max(initialValue, oldValue);
          break;
        }
        case "append": {
          if (oldValue > recreateBehavior.appendLimit) {
            break;
          }
          const appendValue = incomingVariables[name] ?? recreateBehavior.appendValue;
          const appendResult = appendValue + oldValue;
          newValues[name] = Math.min(
            appendResult,
            recreateBehavior.appendLimit
          );
          break;
        }
        default: {
          const _check = recreateBehavior;
          break;
        }
      }
    }
    return newValues;
  } else {
    return Object.fromEntries(
      Object.entries(definition.varConfigs).map(([name, { initialValue }]) => [
        name,
        incomingVariables[name] ?? initialValue
      ])
    );
  }
}
__name(getInsertedStateVariables, "getInsertedStateVariables");
function isChargedPlunging(skill, player) {
  if (!skill.initiativeSkillConfig) {
    return { charged: false, plunging: false };
  }
  let charged = skill.initiativeSkillConfig.alwaysCharged;
  let plunging = skill.initiativeSkillConfig.alwaysPlunging;
  const isNormal = skill.skillType === "normal";
  if (!isNormal) {
    return { charged, plunging };
  }
  const activeCh = player.characters[getActiveCharacterIndex(player)];
  const asPlunging = activeCh.entities.some(
    (et) => et.definition.tags.includes("normalAsPlunging")
  );
  charged ||= player.canCharged;
  plunging ||= player.canPlunging || asPlunging;
  return { charged, plunging };
}
__name(isChargedPlunging, "isChargedPlunging");
function applyAutoSelectedDiceToAction(actionInfo, player, config) {
  if (actionInfo.validity !== ActionValidity.VALID) {
    return actionInfo;
  }
  if (actionInfo.type === "elementalTuning") {
    const disallowed = config.allowTuningAnyDice ? [] : [actionInfo.result, DiceType.Omni];
    const tuningDice = player.dice.findLast((d) => !disallowed.includes(d));
    if (!tuningDice) {
      return {
        ...actionInfo,
        validity: ActionValidity.NO_DICE
      };
    } else {
      return {
        ...actionInfo,
        autoSelectedDice: [tuningDice]
      };
    }
  }
  const autoSelectedDice = chooseDiceValue(actionInfo.cost, player.dice);
  const ok = checkDice(actionInfo.cost, autoSelectedDice);
  if (!ok) {
    return {
      ...actionInfo,
      validity: ActionValidity.NO_DICE
    };
  }
  const energy = player.characters[getActiveCharacterIndex(player)].variables.energy;
  const requiredEnergy = actionInfo.cost.get(DiceType.Energy) ?? 0;
  if (energy < requiredEnergy) {
    return {
      ...actionInfo,
      validity: ActionValidity.NO_ENERGY
    };
  }
  return {
    ...actionInfo,
    autoSelectedDice
  };
}
__name(applyAutoSelectedDiceToAction, "applyAutoSelectedDiceToAction");
function playSkillOfCard(card) {
  const skillDefinition = card.skills.find(
    (sk) => sk.skillType === "playCard"
  );
  return skillDefinition ?? null;
}
__name(playSkillOfCard, "playSkillOfCard");
function normalizeCost(req) {
  const emptyDice = req.entries().filter(([k, v]) => v === 0).map(([k, v]) => k);
  for (const dice of emptyDice) {
    req.delete(dice);
  }
  if (req.size === 0) {
    req.set(DiceType.Aligned, 0);
  }
  return req;
}
__name(normalizeCost, "normalizeCost");
const EMPTY_MAP = /* @__PURE__ */ new Map([
  [DiceType.Aligned, 0]
]);
function costOfCard(card) {
  return playSkillOfCard(card)?.initiativeSkillConfig.requiredCost ?? EMPTY_MAP;
}
__name(costOfCard, "costOfCard");
function costSize(req) {
  return req.entries().reduce((acc, [dice, count]) => acc + count, 0);
}
__name(costSize, "costSize");
function diceCostSize(req) {
  return req.entries().reduce(
    (acc, [dice, count]) => acc + (dice !== DiceType.Energy ? count : 0),
    0
  );
}
__name(diceCostSize, "diceCostSize");
function originalDiceCostSizeOfCard(definition) {
  return playSkillOfCard(definition)?.initiativeSkillConfig.computed$diceCostSize ?? 0;
}
__name(originalDiceCostSizeOfCard, "originalDiceCostSizeOfCard");
function diceCostSizeOfCard(state, card) {
  const definition = card.definition;
  if (!state.versionBehavior.diceCostApplyAttachments || card.attachments.length === 0) {
    return originalDiceCostSizeOfCard(definition);
  }
  const { requiredCost } = applyAttachmentModifications(state, card);
  return diceCostSize(requiredCost);
}
__name(diceCostSizeOfCard, "diceCostSizeOfCard");
function assertValidActionCard(entity) {
  if (!["support", "equipment", "eventCard"].includes(
    entity.type
  )) {
    throw new GiTcgCoreInternalError(
      `Invalid action card type: ${entity.type}`
    );
  }
}
__name(assertValidActionCard, "assertValidActionCard");
function deductCost(cost, availableType, count) {
  for (const type of availableType) {
    const currentCount = cost.get(type) ?? 0;
    cost.set(type, Math.max(0, currentCount - count));
    count -= currentCount;
    if (count <= 0) {
      return;
    }
  }
  return cost;
}
__name(deductCost, "deductCost");
function appendCost(cost, availableType, count) {
  for (const type of availableType) {
    const currentEntry = cost.get(type);
    if (typeof currentEntry !== "undefined") {
      cost.set(type, currentEntry + count);
      return;
    }
  }
  cost.set(DiceType.Aligned, count);
}
__name(appendCost, "appendCost");
function applyAttachmentModifications(state, card) {
  const { who } = getEntityArea(state, card.id);
  const playSkill = playSkillOfCard(card.definition);
  let costs = new Map(
    playSkill?.initiativeSkillConfig.requiredCost ?? EMPTY_MAP
  );
  let shouldFast = playSkill?.initiativeSkillConfig.shouldFast ?? false;
  let disableTuning = card.definition.disableTuning;
  let willBeEffectless = state.players[who].combatStatuses.some(
    (st) => st.definition.tags.includes("eventEffectless")
  ) && card.definition.type === "eventCard";
  let tunedToType = void 0;
  let changedCostType = null;
  const modifications = card.attachments.flatMap(
    (at) => (0, at.definition.modifications)(state, at.id)
  );
  const priority = [
    DiceType.Aligned,
    DiceType.Cryo,
    DiceType.Hydro,
    DiceType.Pyro,
    DiceType.Electro,
    DiceType.Anemo,
    DiceType.Geo,
    DiceType.Dendro,
    DiceType.Void
  ];
  for (const mod of modifications) {
    switch (mod.type) {
      case "increaseCardCost": {
        appendCost(costs, priority, mod.value);
        break;
      }
      case "decreaseCardCost": {
        deductCost(costs, priority, mod.value);
        break;
      }
      case "changeCardCostType": {
        changedCostType = mod.toType;
        break;
      }
      case "changeCardTuningTarget": {
        tunedToType = mod.tuningTarget;
        break;
      }
      case "disableCardTuning": {
        disableTuning = true;
        break;
      }
      case "makeEffectless": {
        willBeEffectless = true;
        break;
      }
      default: {
        const _check = mod;
        break;
      }
    }
  }
  if (changedCostType !== null) {
    const diceSize = diceCostSize(costs);
    const energyCost = costs.get(DiceType.Energy) ?? 0;
    costs = /* @__PURE__ */ new Map([[changedCostType, diceSize]]);
    if (energyCost > 0) {
      costs.set(DiceType.Energy, energyCost);
    }
  }
  return {
    requiredCost: normalizeCost(costs),
    shouldFast,
    disableTuning,
    willBeEffectless,
    tunedToType
  };
}
__name(applyAttachmentModifications, "applyAttachmentModifications");
function elementOfCharacter(ch) {
  const elementTags = {
    cryo: DiceType.Cryo,
    hydro: DiceType.Hydro,
    pyro: DiceType.Pyro,
    electro: DiceType.Electro,
    anemo: DiceType.Anemo,
    geo: DiceType.Geo,
    dendro: DiceType.Dendro
  };
  const element = ch.tags.find((tag) => tag in elementTags);
  if (typeof element === "undefined") {
    return DiceType.Void;
  }
  return elementTags[element];
}
__name(elementOfCharacter, "elementOfCharacter");
function weaponOfCharacter(ch) {
  const weaponTags = WEAPON_TAGS;
  const weapon = ch.tags.find(
    (tag) => weaponTags.includes(tag)
  );
  return weapon ?? "otherWeapon";
}
__name(weaponOfCharacter, "weaponOfCharacter");
function nationOfCharacter(ch) {
  const nationTags = NATION_TAGS;
  return ch.tags.filter((tag) => nationTags.includes(tag));
}
__name(nationOfCharacter, "nationOfCharacter");
function toSortedBy(arr, projection) {
  return arr.toSorted((a, b) => {
    let projectionA = projection(a);
    let projectionB = projection(b);
    if (!Array.isArray(projectionA)) {
      projectionA = [projectionA];
    }
    if (!Array.isArray(projectionB)) {
      projectionB = [projectionB];
    }
    const size = Math.min(projectionA.length, projectionB.length);
    for (let i = 0; i < size; i++) {
      if (projectionA[i] < projectionB[i]) {
        return -1;
      }
      if (projectionA[i] > projectionB[i]) {
        return 1;
      }
    }
    return projectionA.length - projectionB.length;
  });
}
__name(toSortedBy, "toSortedBy");
function sortDice(player, dice) {
  const characterElements = shiftLeft(
    player.characters,
    getActiveCharacterIndex(player)
  ).map((ch) => elementOfCharacter(ch.definition));
  const countMap = /* @__PURE__ */ new Map();
  for (const d of dice) {
    countMap.set(d, (countMap.get(d) ?? 0) + 1);
  }
  return toSortedBy(dice, (dice2) => [
    dice2 === DiceType.Omni ? -1 : 0,
    characterElements.includes(dice2) ? -1 : 0,
    -countMap.get(dice2),
    dice2
  ]);
}
__name(sortDice, "sortDice");
function shiftLeft(arr, idx) {
  return [...arr.slice(idx), ...arr.slice(0, idx)];
}
__name(shiftLeft, "shiftLeft");
function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
__name(shuffle, "shuffle");
function mixins(derivedCtor, constructors) {
  class Mixed extends derivedCtor {
    static {
      __name(this, "Mixed");
    }
    constructor(...args) {
      super(...args);
      for (const baseCtor of constructors) {
        for (const name of Object.getOwnPropertyNames(baseCtor.prototype)) {
          if (name === "constructor") {
            continue;
          }
          Object.defineProperty(
            Mixed.prototype,
            name,
            Object.getOwnPropertyDescriptor(baseCtor.prototype, name) || /* @__PURE__ */ Object.create(null)
          );
        }
      }
    }
  }
  return Mixed;
}
__name(mixins, "mixins");
export {
  EMPTY_MAP,
  allEntitiesAtArea,
  allSkills,
  appendCost,
  applyAttachmentModifications,
  applyAutoSelectedDiceToAction,
  assertValidActionCard,
  costOfCard,
  costSize,
  deductCost,
  diceCostSize,
  diceCostSizeOfCard,
  elementOfCharacter,
  findReplaceAction,
  getActiveCharacterIndex,
  getAllEntities,
  getAllEntitiesWithArea,
  getEntityArea,
  getEntityById,
  getInsertedStateVariables,
  initiativeSkillsOfPlayer,
  isCharacterInitiativeSkill,
  isChargedPlunging,
  isSkillDisabled,
  mixins,
  nationOfCharacter,
  normalizeCost,
  originalDiceCostSizeOfCard,
  playSkillOfCard,
  removeEntity,
  shiftLeft,
  shouldEnterOverride,
  shuffle,
  sortDice,
  toSortedBy,
  weaponOfCharacter
};
