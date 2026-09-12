// Value-only artifact builder
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRlDatasetInput } from "../../datasets/rl-input.js";
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js";
import { buildLinearValueArtifactFromDataset } from "../../value/build-linear-value-artifact.js";

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output" },
      prefix: { type: "string", default: "v14" },
      version: { type: "string", default: "" },
      "top-features": { type: "string", default: "64" },
    },
  });

  const inputPath = resolve(values.input as string);
  const outputDir = resolve(values["output-dir"] as string);
  const prefix = values.prefix as string;
  const version = (values.version as string) || prefix;
  mkdirSync(outputDir, { recursive: true });

  console.log("Loading RL dataset for value...");
  const rlDataset = await loadRlDatasetInput(inputPath);
  console.log(`  Loaded ${rlDataset.sample_count} samples`);

  console.log("Building value dataset...");
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset, { datasetId: `${version}_value` });
  console.log(`  ${valueDataset.samples.length} samples`);

  console.log("Building artifact...");
  const valueArtifact = buildLinearValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${version}_value`,
    topFeatureCount: Number(values["top-features"]),
  });

  const valueArtifactPath = resolve(outputDir, `${prefix}.value-artifact.json`);
  writeFileSync(valueArtifactPath, JSON.stringify(valueArtifact) + "\n");
  console.log(`Value artifact: ${valueArtifactPath}`);
  console.log("Done!");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
