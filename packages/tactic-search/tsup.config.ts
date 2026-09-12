import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  clean: true,
  sourcemap: true,
  dts: !process.env.NO_TYPING,
  minify: true,
  external: [
    "@gi-tcg/core",
    "@gi-tcg/data",
    "@gi-tcg/typings",
    "@gi-tcg/utils",
  ],
});
