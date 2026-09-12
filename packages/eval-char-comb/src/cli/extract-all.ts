/**
 * extract-all.ts — CLI 脚本
 *
 * 提取所有角色档案并输出 JSON。
 *
 * 用法: bun run src/cli/extract-all.ts
 */

import { resolve, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// @gi-tcg/data 默认导出：(version?) => GameData
import getData from "@gi-tcg/data";

import { CharacterProfileService } from "../CharacterProfileService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_SRC_DIR = resolve(__dirname, "../../../data/src");
const OUTPUT_DIR = resolve(__dirname, "../../output");

async function main() {
  console.log("=== eval-char-comb: 提取角色档案 ===\n");

  // 获取 GameData
  console.log("1. 加载 GameData...");
  const data = getData();
  console.log(`   角色数: ${data.characters.size}`);
  console.log(`   实体数: ${data.entities.size}`);

  // 初始化服务
  console.log("\n2. 初始化 CharacterProfileService...");
  const service = new CharacterProfileService();
  await service.init(data, DATA_SRC_DIR);

  const profiles = service.getAllProfiles();
  console.log(`   提取角色档案: ${profiles.length} 个`);

  // 输出统计
  const simRequired = profiles.filter((p) => p.complexity.requiresSimulation);
  console.log(`   需要模拟验证: ${simRequired.length} 个`);
  console.log(`   可纯静态分析: ${profiles.length - simRequired.length} 个`);

  // 保存 JSON
  await mkdir(OUTPUT_DIR, { recursive: true });

  const profilesPath = resolve(OUTPUT_DIR, "character-profiles.json");
  await writeFile(profilesPath, JSON.stringify(profiles, null, 2));
  console.log(`\n3. 档案已保存到 ${profilesPath}`);

  // 获取 top-50 候选牌组
  console.log("\n4. 计算 top-50 候选牌组...");
  const topDecks = service.getTopDecks(50);
  const decksPath = resolve(OUTPUT_DIR, "top-decks.json");
  await writeFile(decksPath, JSON.stringify(topDecks, null, 2));
  console.log(`   前50牌组已保存到 ${decksPath}`);

  // 卡牌相性
  const affinities = service.getAllAffinities();
  const affinitiesPath = resolve(OUTPUT_DIR, "card-affinities.json");
  await writeFile(affinitiesPath, JSON.stringify(affinities, null, 2));
  console.log(`   卡牌相性 (${affinities.length} 条) 已保存到 ${affinitiesPath}`);

  // 打印几个示例
  console.log("\n5. 示例角色档案:");
  const examples = profiles.slice(0, 3);
  for (const p of examples) {
    console.log(`   [${p.definitionId}] tags=${p.tags.join(",")} ` +
      `HP=${p.base.health} energy=${p.base.maxEnergy} ` +
      `burstCycle=${p.rhythm.minBurstCycle} ` +
      `phaseDmg=[${p.rhythm.phaseDamage.join(",")}] ` +
      `requiresSim=${p.complexity.requiresSimulation}`);
  }

  if (topDecks.length > 0) {
    console.log("\n6. Top-5 候选牌组:");
    for (const d of topDecks.slice(0, 5)) {
      console.log(`   chars=[${d.characters.join(",")}] ` +
        `score=${d.compatibility.overallScore} ` +
        `burstStagger=${d.compatibility.tempo.burstStagger} ` +
        `diceConflict=${d.compatibility.cost.overallDiceConflict}`);
    }
  }

  console.log("\n=== 完成 ===");
}

main().catch(console.error);
