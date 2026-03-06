import { buildAndWriteLatestIndex, getDefaultIndexPath } from "./buildFromDataSource";

async function main() {
  const outputPath = getDefaultIndexPath();
  const result = await buildAndWriteLatestIndex(outputPath);
  console.log(
    `card index built: ${outputPath}, total=${result.total}, warnings=${result.warnings.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
