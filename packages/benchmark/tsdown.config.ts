// gi-knowledge 子项目的打包配置。
// 注意：build 脚本以 gi-knowledge/ 为 cwd 运行（tsdown 向上查找配置文件），
// 因此入口与输出目录使用基于本文件位置的绝对路径。
import { join } from "node:path"
import { defineConfig } from "tsdown"

export default defineConfig({
  entry: [join(import.meta.dirname, "gi-knowledge/src/index.ts")],
  outDir: join(import.meta.dirname, "gi-knowledge/dist"),
})
