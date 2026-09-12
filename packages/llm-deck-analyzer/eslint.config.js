import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import * as tsParser from "@typescript-eslint/parser";

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const compat = new FlatCompat({ resolvePluginsRelativeTo: __dirname });

export default [
  { ignores: ["src/snapshots/"] },
  js.configs.recommended,
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
      "@typescript-eslint/no-unused-vars": "warn",
      "no-unused-vars": 0,
    },
  },
];
