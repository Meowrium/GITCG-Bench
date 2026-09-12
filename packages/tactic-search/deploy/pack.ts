#!/usr/bin/env bun
/**
 * pack.ts — 将 tactic-search 及其所有依赖打包到一个独立目录
 *
 * 用法：bun run deploy/pack.ts [output_dir]
 * 默认输出到 deploy/dist/
 *
 * 输出结构是一个最小化的 bun workspace monorepo，可直接 scp 到云服务器。
 */

import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

const REPO_ROOT = resolve(import.meta.dirname!, "../../../");
const OUTPUT_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dirname!, "dist");

// 需要的 workspace 包（含传递依赖）
const REQUIRED_PACKAGES = [
  "config",
  "typings",
  "utils",
  "core",
  "data",
  "assets-manager",
  "tactic-search",
];

// 每个包需要复制的目录/文件
const PACKAGE_INCLUDE = [
  "src/",
  "dist/",
  "package.json",
  "tsconfig.json",
  "tsup.config.ts",
];

// 根目录需要复制的文件
const ROOT_FILES = [
  "package.json",
  "bunfig.toml",
  "tsconfig.json",
];

console.log(`📦 Packing tactic-search for cloud deployment...`);
console.log(`   Source: ${REPO_ROOT}`);
console.log(`   Output: ${OUTPUT_DIR}`);

// 清理输出目录
if (existsSync(OUTPUT_DIR)) {
  console.log(`   ⚠️  Output dir exists, removing...`);
  const { rmSync } = await import("fs");
  rmSync(OUTPUT_DIR, { recursive: true });
}
mkdirSync(OUTPUT_DIR, { recursive: true });

// 1. 复制根文件
console.log(`\n📁 Copying root files...`);
for (const f of ROOT_FILES) {
  const src = join(REPO_ROOT, f);
  if (existsSync(src)) {
    cpSync(src, join(OUTPUT_DIR, f));
    console.log(`   ✅ ${f}`);
  } else {
    console.log(`   ⏭️  ${f} (not found, skipping)`);
  }
}

// 2. 重写 root package.json — 只保留需要的 workspace 包 + deps
const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
const minimalRootPkg = {
  name: rootPkg.name ?? "gi-tcg-tactic-search-deploy",
  private: true,
  workspaces: ["packages/*"],
  scripts: {
    "mine": "bun run packages/tactic-search/deploy/mine.ts",
    "mine:resume": "bun run packages/tactic-search/deploy/mine.ts --resume",
    "check": "bun run --filter '@gi-tcg/tactic-search' check",
    "test": "bun run --filter '@gi-tcg/tactic-search' test",
  },
  devDependencies: rootPkg.devDependencies ?? {},
};
writeFileSync(
  join(OUTPUT_DIR, "package.json"),
  JSON.stringify(minimalRootPkg, null, 2),
);
console.log(`   ✅ package.json (rewritten, minimal)`);

// 3. 复制各 workspace 包
console.log(`\n📦 Copying workspace packages...`);
for (const pkg of REQUIRED_PACKAGES) {
  const pkgSrc = join(REPO_ROOT, "packages", pkg);
  const pkgDst = join(OUTPUT_DIR, "packages", pkg);

  if (!existsSync(pkgSrc)) {
    console.error(`   ❌ packages/${pkg} not found!`);
    process.exit(1);
  }

  mkdirSync(pkgDst, { recursive: true });

  for (const item of PACKAGE_INCLUDE) {
    const itemSrc = join(pkgSrc, item);
    if (!existsSync(itemSrc)) continue;

    cpSync(itemSrc, join(pkgDst, item), { recursive: true });
  }

  // tactic-search 额外复制 deploy 脚本（不含 dist/）和 test/
  if (pkg === "tactic-search") {
    // 复制 deploy/ 中的脚本文件（排除 dist/ 输出目录）
    const deploySrc = join(pkgSrc, "deploy");
    if (existsSync(deploySrc)) {
      const deployDst = join(pkgDst, "deploy");
      mkdirSync(deployDst, { recursive: true });
      for (const f of readdirSync(deploySrc)) {
        if (f === "dist") continue; // 排除打包输出
        const s = join(deploySrc, f);
        cpSync(s, join(deployDst, f), { recursive: true });
      }
    }
    // 复制 test/
    const testSrc = join(pkgSrc, "test");
    if (existsSync(testSrc)) {
      cpSync(testSrc, join(pkgDst, "test"), { recursive: true });
    }
  }

  console.log(`   ✅ packages/${pkg}/`);
}

// 4. 创建 output 目录
const outputDir = join(OUTPUT_DIR, "packages", "tactic-search", "output");
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, ".gitkeep"),
  "# Mining results will be saved here\n",
);
console.log(`   ✅ packages/tactic-search/output/ (结果输出目录)`);

// 5. 估算大小
let totalSize = 0;
function countSize(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) countSize(p);
    else totalSize += statSync(p).size;
  }
}
countSize(OUTPUT_DIR);

console.log(`\n✅ Pack complete!`);
console.log(`   Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`\n📋 Next steps:`);
console.log(`   1. scp -r ${OUTPUT_DIR} user@server:~/tactic-search/`);
console.log(`   2. cd tactic-search && bun install`);
console.log(`   3. bun run mine`);
console.log(`   4. Collect results from packages/tactic-search/output/`);
