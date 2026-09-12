import { FlatCompat } from "@eslint/eslintrc";
import tsParser from "@typescript-eslint/parser";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const compat = new FlatCompat({
  baseDirectory: __dirname,
  resolvePluginsRelativeTo: __dirname,
});

export default [
  ...compat.extends("plugin:@typescript-eslint/recommended"),
  ...compat.plugins("only-warn"),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // 🎯 抓漏写 await
      "@typescript-eslint/no-floating-promises": "error",

      // 🎯 抓 async 函数里没有 await
      "@typescript-eslint/require-await": "warn",

      // 🎯 抓把 Promise 放在不该放的地方
      "@typescript-eslint/no-misused-promises": "error",

      "@typescript-eslint/no-unused-vars": "warn",
      "no-unused-vars": 0,
    },
  },
];
