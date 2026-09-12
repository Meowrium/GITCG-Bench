export type CardLanguage = "zh-CN" | "en-US";

export type CardDefinitionKind =
  | "card"
  | "character"
  | "skill"
  | "summon"
  | "status"
  | "combatStatus"
  | "extension"
  | "entity"
  | "unknown";

export type CardIndexItem = {
  definitionId: number;
  canonicalName: string;
  effectText: string;
  type: string;
  tags: string[];
  /** Total dice cost (sum of all .cost*() calls). */
  cost: number;
  definitionKind: CardDefinitionKind;
  since?: string;
  sourcePath: string;
  sourceExcerpt: string;
  contentHash: string;
  version: string;
};

export type CardIndexFile = {
  version: string;
  builtAt: string;
  sourceRoot: string;
  total: number;
  items: CardIndexItem[];
  warnings: string[];
};
