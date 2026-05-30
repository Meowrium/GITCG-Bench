import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const PROJECT = "packages/llm-deck-analyzer"

export const server: Plugin = async (ctx) => {
  const run = (cmd: string) =>
    ctx.$`cd ${ctx.directory} && ${cmd}`.quiet().nothrow()

  // ── Simple file-based key-value store for strategy anchors ──
  const storeDir = join(ctx.directory, ".opencode", "strategy-store")
  const storeFile = join(storeDir, "store.json")

  function readStore(): Record<string, unknown> {
    if (!existsSync(storeFile)) return {}
    try {
      return JSON.parse(readFileSync(storeFile, "utf-8"))
    } catch {
      return {}
    }
  }

  function writeStore(data: Record<string, unknown>): void {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(storeFile, JSON.stringify(data, null, 2), "utf-8")
  }

  return {
    tool: {
      /** 分析单个七圣召唤卡组（增强版），返回完整上下文供 AI 自行合成策略锚点 */
      analyze_deck: tool({
        description:
          "分析七圣召唤卡组（增强版）。输入卡组分享码（base64），返回完整卡组上下文：角色（含技能/费用/描述）、卡牌（含效果/费用/标签）、实体描述（召唤物/状态）、分析数据（技能经济效率、组合技爆发窗口、资源循环、抽牌期望、支援区压力、免费牌检测）以及启发式基线分析。AI 应基于此上下文自行合成策略锚点，而非依赖启发式模板。",
        args: {
          deck_code: tool.schema.string().describe(
            "卡组分享码（base64编码的卡组代码字符串）"
          ),
          deck_name: tool.schema.string().optional().describe(
            "卡组名称（可选，用于标注分析结果）"
          ),
        },
        async execute(args) {
          const name = args.deck_name ?? "Deck"
          const result = await run(
            `DECK_CODE="${args.deck_code}" DECK_NAME="${name}" bun run ${PROJECT}/src/cli/analyze-deck-rich.ts`
          )
          if (result.exitCode !== 0) {
            return `分析失败 (exit ${result.exitCode}):\n${result.stderr.toString()}`
          }
          return result.stdout.toString()
        },
      }),

      /** 分析两组卡组的对局优劣势（增强版），返回双方完整上下文供 AI 自行合成对局策略 */
      analyze_matchup: tool({
        description:
          "分析两组七圣召唤卡组的对局优劣势（增强版）。输入双方卡组分享码，返回：双方完整卡组上下文（角色技能/卡牌效果/分析数据）、启发式对局基线（优势/关键互动/策略/预测胜率）。AI 应基于此上下文自行合成对局策略锚点。",
        args: {
          deck_a: tool.schema.string().describe("卡组A分享码"),
          deck_b: tool.schema.string().describe("卡组B分享码"),
          version: tool.schema.string().optional().describe(
            "游戏版本号（可选，如 v6.4.0）"
          ),
        },
        async execute(args) {
          const verFlag = args.version ? `DECK_VERSION="${args.version}"` : ""
          const result = await run(
            `${verFlag} DECK_A="${args.deck_a}" DECK_B="${args.deck_b}" bun run ${PROJECT}/src/cli/analyze-matchup-rich.ts`
          )
          if (result.exitCode !== 0) {
            return `对局分析失败 (exit ${result.exitCode}):\n${result.stderr.toString()}`
          }
          return result.stdout.toString()
        },
      }),

      /** 持久化策略锚点——用于保存/读取对局策略，跨回合保持记忆 */
      strategy_store: tool({
        description:
          "持久化键值存储，用于在对局中保存和读取策略锚点。action='save' 保存一个值（覆盖同名 key），action='load' 读取一个值，action='list' 列出所有 key。用于保存 StrategyAnchor JSON，在后续回合中检索对照。注意：p0 和 p1 共享此存储，建议使用带 player 标识的 key 名（如 'p0_anchor'、'p1_anchor'）以避免冲突。",
        args: {
          action: tool.schema.enum("save", "load", "list").describe(
            "操作类型：save 保存值，load 读取值，list 列出所有 key"
          ),
          key: tool.schema.string().optional().describe(
            "键名（save/load 时必填，建议如 'p0_anchor'、'p1_threats'）"
          ),
          value: tool.schema.string().optional().describe(
            "要保存的值（JSON 字符串，仅 save 时需要）"
          ),
        },
        async execute(args) {
          const store = readStore()

          if (args.action === "list") {
            const keys = Object.keys(store)
            if (keys.length === 0) return "(空)"
            return keys.map((k) => `  ${k}`).join("\n")
          }

          if (!args.key) {
            return "错误：save/load 操作需要提供 key 参数"
          }

          if (args.action === "save") {
            if (args.value === undefined) {
              return "错误：save 操作需要提供 value 参数"
            }
            store[args.key] = args.value
            writeStore(store)
            return `已保存 key='${args.key}'`
          }

          // action === "load"
          if (!(args.key in store)) {
            return `key='${args.key}' 不存在。已存储的 keys: ${Object.keys(store).join(", ") || "(无)"}`
          }
          return store[args.key] as string
        },
      }),

      /** 批量分析多套卡组 */
      analyze_batch: tool({
        description:
          "批量分析多套七圣召唤卡组。输入 JSON 文件路径（文件内容为卡组代码数组或对象），输出批量分析结果。适用于一次性评估多套卡组的强度。",
        args: {
          input_file: tool.schema.string().describe(
            "输入 JSON 文件路径，内容为卡组代码数组 [code1, code2, ...] 或对象 {name: code, ...}"
          ),
        },
        async execute(args) {
          const result = await run(
            `bun run --filter @gi-tcg/llm-deck-analyzer analyze:batch "${args.input_file}"`
          )
          if (result.exitCode !== 0) {
            return `批量分析失败 (exit ${result.exitCode}):\n${result.stderr.toString()}`
          }
          return result.stdout.toString()
        },
      }),

      /** 提取卡组特征向量（V2） */
      extract_deck_features: tool({
        description:
          "提取七圣召唤卡组的 V2 特征向量（纯本地运算，不涉及 LLM）。输入卡组分享码，返回 dense/sparse/actionCards/graph/labels/diagnostics 六层结构化特征。用于机器学习训练、卡组聚类等。",
        args: {
          deck_code: tool.schema.string().describe("卡组分享码"),
          version: tool.schema.string().optional().describe(
            "游戏版本号（可选）"
          ),
        },
        async execute(args) {
          const verFlag = args.version ? ` --version ${args.version}` : ""
          const result = await run(
            `bun run --filter @gi-tcg/llm-deck-analyzer extract:features:v2 -- deck "${args.deck_code}"${verFlag}`
          )
          if (result.exitCode !== 0) {
            return `特征提取失败 (exit ${result.exitCode}):\n${result.stderr.toString()}`
          }
          return result.stdout.toString()
        },
      }),

      /** 提取对局特征向量（V2） */
      extract_matchup_features: tool({
        description:
          "提取七圣召唤对局的 V2 特征向量（纯本地运算）。输入双方卡组分享码，返回对局级结构化特征。用于对局预测模型的训练数据生成。",
        args: {
          deck_a: tool.schema.string().describe("卡组A分享码"),
          deck_b: tool.schema.string().describe("卡组B分享码"),
          version: tool.schema.string().optional().describe(
            "游戏版本号（可选）"
          ),
        },
        async execute(args) {
          const verFlag = args.version ? ` --version ${args.version}` : ""
          const result = await run(
            `bun run --filter @gi-tcg/llm-deck-analyzer extract:features:v2 -- matchup "${args.deck_a}" "${args.deck_b}"${verFlag}`
          )
          if (result.exitCode !== 0) {
            return `对局特征提取失败 (exit ${result.exitCode}):\n${result.stderr.toString()}`
          }
          return result.stdout.toString()
        },
      }),
    },
  }
}
