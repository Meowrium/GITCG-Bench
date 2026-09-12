// Quick script: build ranker artifact from existing ranking dataset JSON
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js";
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js";
import { evaluateRankingDataset } from "../../ranker/evaluate.js";
import type { MlRankingDataset } from "../../contracts/index.js";

const datasetPath = process.argv[2];
const artifactPath = process.argv[3];
const evalPath = process.argv[4];
const version = process.argv[5] || "v14";
const topTags = Number(process.argv[6]) || 32;
const topSlots = Number(process.argv[7]) || 64;

if (!datasetPath || !artifactPath) {
  console.error("Usage: pnpm exec gnx build-ranker.ts <dataset.json> <artifact.json> [eval.json] [version] [top-tags] [top-slots]");
  process.exit(1);
}

console.log(`Loading ranking dataset from ${datasetPath}...`);
const raw = readFileSync(resolve(datasetPath), "utf8");
const dataset = JSON.parse(raw) as MlRankingDataset;
console.log(`  query_groups: ${dataset.query_groups.length}`);

console.log(`Building artifact (topTags=${topTags}, topSlots=${topSlots})...`);
const artifact = buildSlotLinearArtifactFromDataset(dataset, {
  artifactVersion: version,
  topTagCount: topTags,
  topCandidateNumericSlotCount: topSlots,
});

console.log("Evaluating...");
const evaluation = await evaluateRankingDataset(new SlotLinearRanker(artifact), dataset);

function writeCompactJson(path: string, value: unknown) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(value) + "\n", "utf8");
  return resolved;
}

const ap = writeCompactJson(artifactPath, artifact);
console.log(`Artifact written: ${ap}`);
console.log(`artifact_version=${artifact.artifact_version}`);

if (evalPath) {
  const ep = writeCompactJson(evalPath, evaluation);
  console.log(`Eval written: ${ep}`);
}
console.log(`pairwise_support_rate=${evaluation.pairwise_support_rate ?? "null"}`);
console.log(`top1_not_contradicted_rate=${evaluation.top1_not_contradicted_rate ?? "null"}`);
