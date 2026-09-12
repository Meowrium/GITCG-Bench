#!/usr/bin/env bun
/**
 * merge.ts — 将云端挖掘结果合并到本地 ComboRegistry
 *
 * 用法：
 *   bun run deploy/merge.ts <cloud-output-dir> [local-registry.json]
 *
 * 示例：
 *   bun run deploy/merge.ts ./cloud-results/
 *   bun run deploy/merge.ts ./cloud-results/ ./data/combo-registry.json
 *
 * 合并逻辑：
 *   1. 扫描 cloud-output-dir 中所有 combos-*.json
 *   2. 按 combo ID 去重（相同 action sequence → 取 sampleCount 更高的）
 *   3. 合并到本地 registry 文件
 *   4. 输出统计信息
 */

import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { ComboRegistry } from "../src/combo-registry";
import type { ComboEntry } from "../src/types";

const cloudDir = process.argv[2];
const localFile = process.argv[3] ?? resolve(
  import.meta.dirname!,
  "../data/combo-registry.json",
);

if (!cloudDir) {
  console.error(`
Usage: bun run deploy/merge.ts <cloud-output-dir> [local-registry.json]

  <cloud-output-dir>    云端输出目录（含 combos-*.json 文件）
  [local-registry.json] 本地 registry 文件路径
                         默认: packages/tactic-search/data/combo-registry.json
`);
  process.exit(1);
}

const resolvedCloudDir = resolve(cloudDir);
if (!existsSync(resolvedCloudDir)) {
  console.error(`❌ Cloud output dir not found: ${resolvedCloudDir}`);
  process.exit(1);
}

// ─── 加载本地已有数据 ───

const registry = new ComboRegistry();
let localCount = 0;

if (existsSync(localFile)) {
  const localEntries: ComboEntry[] = JSON.parse(
    readFileSync(localFile, "utf-8"),
  );
  registry.importAll(localEntries);
  localCount = registry.size;
  console.log(`📦 Loaded ${localCount} combos from local registry`);
} else {
  console.log(`📦 No existing local registry, starting fresh`);
}

// ─── 扫描云端结果文件 ───

const comboFiles = readdirSync(resolvedCloudDir)
  .filter((f: string) => f.startsWith("combos-") && f.endsWith(".json"))
  .sort(); // 按时间戳排序

if (comboFiles.length === 0) {
  console.error(`❌ No combos-*.json files found in ${resolvedCloudDir}`);
  process.exit(1);
}

console.log(`\n☁️  Found ${comboFiles.length} result files in cloud output:`);
let cloudTotal = 0;

for (const file of comboFiles) {
  const filePath = join(resolvedCloudDir, file);
  const entries: ComboEntry[] = JSON.parse(readFileSync(filePath, "utf-8"));
  cloudTotal += entries.length;
  registry.importAll(entries);
  console.log(`   📄 ${file}: ${entries.length} combos`);
}

// ─── 统计 ───

const mergedCount = registry.size;
const newCombos = mergedCount - localCount;
const deduped = cloudTotal + localCount - mergedCount;

console.log(`\n📊 Merge results:`);
console.log(`   Local (before):    ${localCount}`);
console.log(`   Cloud (total):     ${cloudTotal}`);
console.log(`   Deduplicated:      ${deduped}`);
console.log(`   New combos added:  ${newCombos}`);
console.log(`   Final registry:    ${mergedCount}`);

// ─── 保存 ───

const resolvedLocalFile = resolve(localFile);
const dir = resolve(resolvedLocalFile, "..");
if (!existsSync(dir)) {
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
}

const entries = registry.exportAll();
writeFileSync(resolvedLocalFile, JSON.stringify(entries, null, 2));
console.log(`\n✅ Saved merged registry → ${resolvedLocalFile}`);

// ─── 也输出统计 ───

if (existsSync(join(resolvedCloudDir, "stats.json"))) {
  const stats = JSON.parse(
    readFileSync(join(resolvedCloudDir, "stats.json"), "utf-8"),
  );
  console.log(`\n📈 Cloud mining stats:`);
  console.log(`   Duration: ${stats.elapsedSeconds}s`);
  console.log(`   Deck pairs: ${stats.totalDeckPairs}`);
  console.log(`   Game version: ${stats.gameVersion}`);
}
