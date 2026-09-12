import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { CardDefinitionKind, CardIndexFile, CardIndexItem } from "./types";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getMcpRoot(currentDir: string): string {
  let cursor = currentDir;
  for (let depth = 0; depth < 8; depth++) {
    const packageJsonPath = path.join(cursor, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
        if (pkg.name === "@gi-tcg/mcp") {
          return cursor;
        }
      } catch {
        // ignore invalid package.json and continue walking up
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return path.resolve(currentDir, "..");
}

export function getDefaultDataSourceRoot(currentDir = path.dirname(fileURLToPath(import.meta.url))): string {
  const mcpRoot = getMcpRoot(currentDir);
  return path.resolve(mcpRoot, "../data/src");
}

export function getDefaultIndexPath(currentDir = path.dirname(fileURLToPath(import.meta.url))): string {
  const mcpRoot = getMcpRoot(currentDir);
  return path.resolve(mcpRoot, ".cache/card_index.latest.json");
}

function detectTypeByPath(relPath: string): string {
  const p = relPath.replace(/\\/g, "/");
  if (p.startsWith("characters/")) {
    const [, element = "unknown"] = p.split("/");
    return `character:${element}`;
  }
  if (p.startsWith("cards/equipment/")) {
    return "equipment";
  }
  if (p.startsWith("cards/event/")) {
    return "event";
  }
  if (p.startsWith("cards/support/")) {
    return "support";
  }
  return "unknown";
}

function detectDefinitionKind(definitionExpr: string): CardDefinitionKind {
  if (definitionExpr.includes("card(")) {
    return "card";
  }
  if (definitionExpr.includes("character(")) {
    return "character";
  }
  if (definitionExpr.includes("skill(")) {
    return "skill";
  }
  if (definitionExpr.includes("summon(")) {
    return "summon";
  }
  if (definitionExpr.includes("combatStatus(")) {
    return "combatStatus";
  }
  if (definitionExpr.includes("status(")) {
    return "status";
  }
  if (definitionExpr.includes("extension(")) {
    return "extension";
  }
  if (definitionExpr.includes("entity(")) {
    return "entity";
  }
  return "unknown";
}

function parseBlock(commentBlock: string): {
  definitionId?: number;
  canonicalName?: string;
  effectText?: string;
} {
  const idMatch = commentBlock.match(/@id\s+(\d+)/);
  const nameMatch = commentBlock.match(/@name\s+(.+)/);
  const descriptionMatch = commentBlock.match(/@description\s*([\s\S]*?)$/);

  const description = descriptionMatch?.[1]
    ?.split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();

  return {
    definitionId: idMatch ? Number(idMatch[1]) : undefined,
    canonicalName: nameMatch?.[1]?.trim(),
    effectText: description ?? "",
  };
}

function parseItemsFromFile(relPath: string, content: string): { items: CardIndexItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const items: CardIndexItem[] = [];
  const pattern = /\/\*\*([\s\S]*?)\*\/\s*export\s+const\s+[\s\S]*?=\s*([a-zA-Z_]+\(.*?\)\s*[\s\S]*?)\.done\(\);/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const comment = match[1] ?? "";
    const definitionExpr = match[2] ?? "";
    const parsed = parseBlock(comment);

    if (!parsed.definitionId) {
      continue;
    }
    if (!parsed.canonicalName) {
      warnings.push(`missing @name for id ${parsed.definitionId} in ${relPath}`);
      continue;
    }

    const sinceMatch = definitionExpr.match(/\.since\("([^"]+)"\)/);
    const tagsMatches = [...definitionExpr.matchAll(/\.tags\(([^)]*)\)/g)]
      .flatMap((m) => m[1]?.split(",") ?? [])
      .map((s) => s.replace(/["'`]/g, "").trim())
      .filter(Boolean);
    const costMatches = [...definitionExpr.matchAll(/\.cost([A-Z][a-zA-Z]*)\((\d+)\)/g)];
    const cost = costMatches.reduce((sum, m) => sum + (Number(m[2]) || 0), 0);

    items.push({
      definitionId: parsed.definitionId,
      canonicalName: parsed.canonicalName,
      effectText: parsed.effectText ?? "",
      type: detectTypeByPath(relPath),
      tags: tagsMatches,
      cost,
      definitionKind: detectDefinitionKind(definitionExpr),
      since: sinceMatch?.[1],
      sourcePath: relPath.replace(/\\/g, "/"),
      sourceExcerpt: definitionExpr.slice(0, 600),
      contentHash: sha256(`${relPath}\n${comment}\n${definitionExpr}`),
      version: "latest",
    });
  }

  return { items, warnings };
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
      continue;
    }
    if (entry.isFile() && abs.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

export async function buildCardIndexFromDataSource(dataSourceRoot = getDefaultDataSourceRoot()): Promise<CardIndexFile> {
  const files = await walk(dataSourceRoot);
  const warnings: string[] = [];
  const items: CardIndexItem[] = [];

  for (const absFile of files) {
    const relPath = path.relative(dataSourceRoot, absFile);
    if (
      relPath.startsWith("old_versions") ||
      (!relPath.startsWith(`cards${path.sep}`) && !relPath.startsWith(`characters${path.sep}`))
    ) {
      continue;
    }

    const content = await fs.readFile(absFile, "utf-8");
    const parsed = parseItemsFromFile(relPath, content);
    warnings.push(...parsed.warnings);
    items.push(...parsed.items);
  }

  const seen = new Map<number, string>();
  for (const item of items) {
    const dup = seen.get(item.definitionId);
    if (dup) {
      warnings.push(`duplicate definitionId ${item.definitionId}: ${dup} <-> ${item.sourcePath}`);
    } else {
      seen.set(item.definitionId, item.sourcePath);
    }
  }

  return {
    version: "latest",
    builtAt: new Date().toISOString(),
    sourceRoot: dataSourceRoot.replace(/\\/g, "/"),
    total: items.length,
    items,
    warnings,
  };
}

export async function buildAndWriteLatestIndex(outputPath = getDefaultIndexPath()): Promise<CardIndexFile> {
  const index = await buildCardIndexFromDataSource();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(index, null, 2), "utf-8");
  return index;
}
