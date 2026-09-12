import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  clean: true,
  sourcemap: true,
  dts: !process.env.NO_TYPING,
  minify: false,
  external: [
    "@gi-tcg/core",
    "@gi-tcg/data",
    "@gi-tcg/mcp",
    "@gi-tcg/utils",
    "better-sqlite3",
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
  ],
});
