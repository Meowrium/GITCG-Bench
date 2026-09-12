import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/heuristics.ts"],
  format: ["esm"],
  dts: !process.env.NO_TYPING,
  splitting: false,
  sourcemap: true,
  clean: true,
})
