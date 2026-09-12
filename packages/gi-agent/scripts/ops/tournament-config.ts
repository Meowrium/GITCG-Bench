// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * tournament-config — tournament.json 契约（WP1，impl-spec-1 §2）：类型、fail-fast
 * 校验（列全错误再退出）、命名与 seed 派生约定（impl-spec-0 §4）。
 *
 * 校验原则：
 * - 全部错误收集后一次性列出（不逐条中断）；
 * - 任何文件/日志不得出现 key 明文——apiKeyEnv 只存环境变量名；
 *   **凭据存在性不做全局 fail-fast**（否则失败隔离验收无法进行）：由 author 子命令
 *   在调度每个模型时检查，缺失 → 该模型全部调用隔离记录失败，其余模型继续；
 * - gameVersion 经 plan-oneshot/version.ts 的 parseGameVersion 封闭校验（core VERSIONS）；
 * - deckCode 用 DEFAULT_ASSETS_MANAGER.decode 试解码（decode 与版本无关，静态映射）；
 * - models[].concurrency 可选（正整数，钳 1-8；缺省回退全局 llmConcurrency——LLM 池逐模型分桶）。
 *
 * 命名约定（impl-spec-0 §4）：
 * - 选手 id = `<model>@r<n>`；
 * - pair 目录名 = plan 侧选手在前：`<planPlayerId>__vs__<oppPlayerId>`（impl-spec-1 §3
 *   示例 glm-5.3@r1__vs__glm-5.3@r0 即链批 plan 侧在前；plan 侧在前使同一 pair 的
 *   双向批（X plan / Y plan）目录不冲突）；
 * - 格目录 = `<di>-vs-<dj>`（di/dj = 环境 decks 数组下标，di = plan 侧本方牌）。
 *
 * seed 派生（确定性、可复现）：`S = seedBase + fnv1a(<用途|...坐标>) % 100000`。
 */

import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { DeckConfig, Version } from "@gi-tcg/core"
import { parseGameVersion } from "../../src/runtime/plan-oneshot/version.js"
import type { TournamentSchedule } from "./tournament-schedule.js"

// ── schema ───────────────────────────────────────────────────────────────

export interface TournamentModel {
  /** 模型 id（API.txt 原名；用作产物目录名，需路径安全） */
  name: string
  baseUrl: string
  /** API 侧模型名（注入子进程 OPENAI_MODEL） */
  model: string
  /** 凭据环境变量名（只存名；值从进程 env 解析后注入子进程，任何文件不得落盘 key 值） */
  apiKeyEnv: string
  /** 可选；单次 LLM 调用输出上限（author/reflect 的 --max-tokens；长推理模型如 GLM/qwen 建议 128000，缺省走 CLI 默认 32768） */
  maxTokens?: number
  /**
   * 可选；该模型 LLM 起草/反思单元的独立并发上限（正整数，钳 1-8——API 限速友好）。
   * 缺省回退全局 llmConcurrency（旧 config 行为逐一致）。每模型一个独立有界池，
   * 慢供应商不队头阻塞其余模型（见 model-tournament.ts 的逐模型分桶）。
   */
  concurrency?: number
}

export interface TournamentEnvironment {
  /** 环境标签（形如 v6.3；唯一；用作产物目录名） */
  label: string
  /** 钉扎的游戏版本（core VERSIONS 封闭校验，如 v6.3.0） */
  gameVersion: string
  /** 本环境卡组（分享码；≥1 且唯一；索引 = 数组下标 = di/dj） */
  decks: string[]
}

export interface TournamentConfig {
  models: TournamentModel[]
  environments: TournamentEnvironment[]
  /** 每格局数（格 = (di, dj, 先手方)；实际批 games = 2×，正反手由 alternateFirstPlayer 均分） */
  gamesPerCell: number
  /** 代数上限；饱和判定提前停由调用方（人肉/脚本）执行 */
  rounds: number
  /** 证据口径（唯一实现口径，其他值非法） */
  evidenceScope: "own-generations"
  seedBase: number
  /** 产物根目录（相对 gi-agent 包目录解析） */
  outRoot: string
  /** game-* 目录恒留（R9 证据）；game_state_log.json 按抽样率写（跨模型批；链批恒全量） */
  gameArchive: { stateLogSample: number }
  /** 可选；battle 批间进程并发（默认 4，对齐设备核数；批内引擎并发恒 1——node 单线程，进程级并行才有效） */
  concurrency?: number
  /** 可选；LLM 起草/反思单元并发（默认 3，钳制 1-8——API 限速友好） */
  llmConcurrency?: number
  /**
   * 可选；battle 批的 trace 签名模式（impl-spec-1 件 1，仅编排层读取——plan:batch
   * CLI 缺省仍 full）：缺省/显式 "lean" = 批配置注入 traceSignatures:"lean"（单局
   * 产物 1.87MB → ≤0.45MB，trace 签名改短哈希指针、消费侧从 state log 反查）；
   * "full" = 内嵌整份签名（与旧产物逐字节同形态）。
   */
  traceSignatures?: "full" | "lean"
  /**
   * 可选；赛程枚举开关（纯逻辑在 tournament-schedule.ts）：缺省 = 现行赛程
   * （同代跨模型全矩阵 + 同模型相邻代链批）；`crossGeneration: "vs-previous"` 追加
   * 跨模型跨代 X@r vs Y@s（X≠Y，s<r）全格对批；`chainGap: k>1` 追加同模型隔代链
   * X@r vs X@(r-k)（k=2..chainGap）全格对批。
   */
  schedule?: TournamentSchedule
}

/** 校验后的单个环境（扁平化；label/gameVersion 已校验、deck 已试解码） */
export interface ResolvedEnvironment {
  /** 环境标签（形如 v6.3；产物目录名） */
  label: string
  gameVersion: Version
  /** 卡组分享码数组（索引 = di/dj） */
  decks: string[]
  deckSummaries: Array<{ index: number; deckCode: string; characters: string[] }>
}

/** 校验后的运行时配置 */
export interface ResolvedTournament {
  config: TournamentConfig
  envs: ResolvedEnvironment[]
}

// ── 校验 ─────────────────────────────────────────────────────────────────

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * 解析 + fail-fast 校验。任何错误（schema/唯一性/范围/版本封闭/deck 解码）
 * 全部收集后一次性抛出；调用方捕获打印并 exit 1。
 * 注意：apiKeyEnv 的进程 env 存在性**不在此校验**（见文件头——失败隔离需要），
 * 由 model-tournament 的 author 路径逐模型检查。
 */
export function resolveTournamentConfig(raw: unknown): ResolvedTournament {
  const errors: string[] = []
  const fail = (msg: string): void => {
    errors.push(msg)
  }

  if (!isPlainObject(raw)) {
    throw new Error("tournament config 必须是 JSON 对象")
  }

  // models：≥2；name/baseUrl/model/apiKeyEnv 必填；name 与 apiKeyEnv 唯一
  const models: TournamentModel[] = []
  const names = new Set<string>()
  const keyEnvs = new Set<string>()
  if (!Array.isArray(raw.models) || raw.models.length < 2) {
    fail(`models 必须 ≥2 个（实为 ${Array.isArray(raw.models) ? raw.models.length : "非数组"}）`)
  } else {
    raw.models.forEach((m, i) => {
      if (!isPlainObject(m)) {
        fail(`models[${i}] 必须是对象`)
        return
      }
      const name = typeof m.name === "string" ? m.name : ""
      if (!NAME_PATTERN.test(name)) {
        fail(`models[${i}].name 非法：${JSON.stringify(name)}（需匹配 ${NAME_PATTERN.source}——用作产物目录名）`)
      } else if (names.has(name)) {
        fail(`models[${i}].name 重复：${name}`)
      } else {
        names.add(name)
      }
      const baseUrl = typeof m.baseUrl === "string" ? m.baseUrl : ""
      if (!/^https?:\/\//.test(baseUrl)) {
        fail(`models[${i}].baseUrl 非法：${JSON.stringify(baseUrl)}（需 http(s):// 前缀）`)
      }
      const model = typeof m.model === "string" ? m.model : ""
      if (model.length === 0) fail(`models[${i}].model 必填（API 侧模型名）`)
      const apiKeyEnv = typeof m.apiKeyEnv === "string" ? m.apiKeyEnv : ""
      if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
        fail(`models[${i}].apiKeyEnv 非法：${JSON.stringify(apiKeyEnv)}（需是合法环境变量名）`)
      } else if (keyEnvs.has(apiKeyEnv)) {
        fail(`models[${i}].apiKeyEnv 重复：${apiKeyEnv}（每模型一个独立 env 名——同供应商可令多个 env 变量指向同一 key 值）`)
      } else {
        keyEnvs.add(apiKeyEnv)
      }
      let maxTokens: number | undefined
      if (m.maxTokens !== undefined) {
        if (!Number.isInteger(m.maxTokens) || (m.maxTokens as number) < 1) {
          fail(`models[${i}].maxTokens 必须是 ≥1 的整数（实为 ${JSON.stringify(m.maxTokens)}）`)
        } else {
          maxTokens = m.maxTokens as number
        }
      }
      // 逐模型 LLM 并发上限（可选）：正整数；钳制在消费侧（resolveBucketConcurrency 1-8），
      // 与顶层 llmConcurrency 同口径——非法值进错误清单，缺省回退全局
      let concurrency: number | undefined
      if (m.concurrency !== undefined) {
        if (!Number.isInteger(m.concurrency) || (m.concurrency as number) < 1) {
          fail(`models[${i}].concurrency 必须是 ≥1 的整数（实为 ${JSON.stringify(m.concurrency)}；钳 1-8，缺省回退全局 llmConcurrency）`)
        } else {
          concurrency = m.concurrency as number
        }
      }
      models.push({
        name,
        baseUrl,
        model,
        apiKeyEnv,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      })
    })
  }

  // environments：≥1；label 唯一且路径安全；gameVersion 封闭校验；decks ≥1 唯一且可解码
  const envs: ResolvedTournament["envs"] = []
  const labels = new Set<string>()
  if (!Array.isArray(raw.environments) || raw.environments.length < 1) {
    fail("environments 必须 ≥1 个")
  } else {
    raw.environments.forEach((e, i) => {
      if (!isPlainObject(e)) {
        fail(`environments[${i}] 必须是对象`)
        return
      }
      const label = typeof e.label === "string" ? e.label : ""
      if (!NAME_PATTERN.test(label)) {
        fail(`environments[${i}].label 非法：${JSON.stringify(label)}（需匹配 ${NAME_PATTERN.source}，形如 v6.3）`)
      } else if (labels.has(label)) {
        fail(`environments[${i}].label 重复：${label}`)
      } else {
        labels.add(label)
      }
      let gameVersion: Version | undefined
      const gvRaw = typeof e.gameVersion === "string" ? e.gameVersion : ""
      try {
        gameVersion = parseGameVersion(gvRaw || undefined)
      } catch (err) {
        fail(`environments[${i}].gameVersion：${err instanceof Error ? err.message : String(err)}`)
      }
      if (gameVersion === undefined) fail(`environments[${i}].gameVersion 必填（如 v6.3.0）`)
      const decks: string[] = []
      const deckSummaries: ResolvedTournament["envs"][number]["deckSummaries"] = []
      const seenDecks = new Set<string>()
      if (!Array.isArray(e.decks) || e.decks.length < 1) {
        fail(`environments[${i}].decks 必须 ≥1 个`)
      } else {
        e.decks.forEach((code, j) => {
          if (typeof code !== "string" || code.length === 0) {
            fail(`environments[${i}].decks[${j}] 必须是非空分享码`)
            return
          }
          if (seenDecks.has(code)) {
            fail(`environments[${i}].decks[${j}] 重复：${code.slice(0, 12)}…`)
            return
          }
          seenDecks.add(code)
          try {
            const decoded = DEFAULT_ASSETS_MANAGER.decode(code) as DeckConfig
            const characters = decoded.characters.map((c) => DEFAULT_ASSETS_MANAGER.getNameSync(c) ?? String(c))
            decks.push(code)
            deckSummaries.push({ index: decks.length - 1, deckCode: code, characters })
          } catch (err) {
            fail(`environments[${i}].decks[${j}] 解码失败：${err instanceof Error ? err.message : String(err)}`)
          }
        })
      }
      envs.push({
        label,
        ...(gameVersion !== undefined ? { gameVersion } : {}),
        decks,
        deckSummaries,
      } as ResolvedTournament["envs"][number])
    })
  }

  // 标量字段
  const gamesPerCell = raw.gamesPerCell
  if (!Number.isInteger(gamesPerCell) || (gamesPerCell as number) < 1) {
    fail(`gamesPerCell 必须是 ≥1 的整数（实为 ${JSON.stringify(gamesPerCell)}）`)
  }
  const rounds = raw.rounds
  if (!Number.isInteger(rounds) || (rounds as number) < 1) {
    fail(`rounds 必须是 ≥1 的整数（实为 ${JSON.stringify(rounds)}）`)
  }
  if (raw.evidenceScope !== "own-generations") {
    fail(`evidenceScope 仅支持 "own-generations"（实为 ${JSON.stringify(raw.evidenceScope)}）`)
  }
  if (!Number.isInteger(raw.seedBase)) {
    fail(`seedBase 必须是整数（实为 ${JSON.stringify(raw.seedBase)}）`)
  }
  if (typeof raw.outRoot !== "string" || raw.outRoot.length === 0) {
    fail("outRoot 必填（产物根目录，相对 gi-agent 包目录）")
  }
  const archive = raw.gameArchive
  if (!isPlainObject(archive) || typeof archive.stateLogSample !== "number"
    || archive.stateLogSample < 0 || archive.stateLogSample > 1) {
    fail(`gameArchive.stateLogSample 必须是 [0,1] 内的数字（抽样率；实为 ${JSON.stringify(archive)}）`)
  }
  if (raw.concurrency !== undefined && (!Number.isInteger(raw.concurrency) || (raw.concurrency as number) < 1)) {
    fail(`concurrency 必须是 ≥1 的整数（实为 ${JSON.stringify(raw.concurrency)}）`)
  }
  if (raw.llmConcurrency !== undefined && (!Number.isInteger(raw.llmConcurrency) || (raw.llmConcurrency as number) < 1)) {
    fail(`llmConcurrency 必须是 ≥1 的整数（实为 ${JSON.stringify(raw.llmConcurrency)}）`)
  }
  if (raw.traceSignatures !== undefined && raw.traceSignatures !== "full" && raw.traceSignatures !== "lean") {
    fail(`traceSignatures 非法：${JSON.stringify(raw.traceSignatures)}（可选 "full" | "lean"，缺省 "lean"）`)
  }
  // schedule：封闭集校验（不依赖顶层未知键的静默忽略——schedule 内未知键同样拒绝，
  // 否则 "vs-previos" 这类拼写错误会静默退化为现行赛程）
  let schedule: TournamentSchedule | undefined
  if (raw.schedule !== undefined) {
    if (!isPlainObject(raw.schedule)) {
      fail(`schedule 必须是对象（实为 ${JSON.stringify(raw.schedule)}）`)
    } else {
      const s = raw.schedule
      for (const key of Object.keys(s)) {
        if (key !== "crossGeneration" && key !== "chainGap") {
          fail(`schedule.${key} 未知键（仅支持 crossGeneration | chainGap）`)
        }
      }
      let crossGeneration: "none" | "vs-previous" = "none"
      if (s.crossGeneration !== undefined) {
        if (s.crossGeneration !== "none" && s.crossGeneration !== "vs-previous") {
          fail(`schedule.crossGeneration 非法：${JSON.stringify(s.crossGeneration)}（可选 "none" | "vs-previous"，缺省 "none"）`)
        } else {
          crossGeneration = s.crossGeneration
        }
      }
      let chainGap = 1
      if (s.chainGap !== undefined) {
        if (!Number.isInteger(s.chainGap) || (s.chainGap as number) < 1) {
          fail(`schedule.chainGap 必须是 ≥1 的整数（实为 ${JSON.stringify(s.chainGap)}）`)
        } else {
          chainGap = s.chainGap as number
        }
      }
      schedule = { crossGeneration, chainGap }
    }
  }

  if (errors.length > 0) {
    throw new Error(`tournament config 校验失败（${errors.length} 项）：\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  }
  return {
    config: {
      models,
      environments: envs.map((e) => ({ label: e.label, gameVersion: e.gameVersion, decks: e.decks })),
      gamesPerCell: gamesPerCell as number,
      rounds: rounds as number,
      evidenceScope: "own-generations",
      seedBase: raw.seedBase as number,
      outRoot: raw.outRoot as string,
      gameArchive: { stateLogSample: (archive as { stateLogSample: number }).stateLogSample },
      ...(Number.isInteger(raw.concurrency) ? { concurrency: raw.concurrency as number } : {}),
      ...(Number.isInteger(raw.llmConcurrency) ? { llmConcurrency: raw.llmConcurrency as number } : {}),
      ...(raw.traceSignatures !== undefined ? { traceSignatures: raw.traceSignatures as "full" | "lean" } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
    },
    envs: envs as ResolvedTournament["envs"],
  }
}

// ── 命名约定 ─────────────────────────────────────────────────────────────

/** 选手 id：`<model>@r<n>` */
export function playerIdOf(model: string, round: number): string {
  return `${model}@r${round}`
}

/** 解析选手 id；非法返回 null */
export function parsePlayerId(id: string): { model: string; round: number } | null {
  const m = /^(.+)@r(\d+)$/.exec(id)
  return m ? { model: m[1]!, round: Number(m[2]!) } : null
}

/** pair 目录名：plan 侧选手在前（见文件头命名约定） */
export function pairDirOf(planPlayerId: string, oppPlayerId: string): string {
  return `${planPlayerId}__vs__${oppPlayerId}`
}

/** 解析 pair 目录名；非法返回 null */
export function parsePairDir(name: string): { planPlayerId: string; oppPlayerId: string } | null {
  const i = name.indexOf("__vs__")
  if (i <= 0 || i + 6 >= name.length) return null
  return { planPlayerId: name.slice(0, i), oppPlayerId: name.slice(i + 6) }
}

/** 格目录名：`<di>-vs-<dj>`（di = plan 侧本方牌索引） */
export function cellDirOf(di: number, dj: number): string {
  return `${di}-vs-${dj}`
}

/** 解析格目录名；非法返回 null */
export function parseCellDir(name: string): { di: number; dj: number } | null {
  const m = /^(\d+)-vs-(\d+)$/.exec(name)
  return m ? { di: Number(m[1]!), dj: Number(m[2]!) } : null
}

// ── seed 派生 ────────────────────────────────────────────────────────────

/** FNV-1a 32 位字符串哈希（确定性、跨进程稳定） */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** seed 派生：`seedBase + fnv1a(parts.join("|")) % 100000`（impl-spec-1 §4.1） */
export function deriveSeed(seedBase: number, parts: ReadonlyArray<string | number>): number {
  return seedBase + (fnv1a(parts.join("|")) % 100_000)
}

// ── env 注入 ─────────────────────────────────────────────────────────────

/**
 * author/reflect 子进程 env 注入（impl-spec-1 §4.1）：进程 env + 三元组覆盖
 * （OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）。凭据缺失抛错（只列 env 名，不打印值）。
 */
export function injectedEnvOf(model: TournamentModel): NodeJS.ProcessEnv {
  const key = process.env[model.apiKeyEnv]
  if (!key) {
    throw new Error(`环境变量 ${model.apiKeyEnv} 未设置（模型 ${model.name} 的 API key 凭据；值不入库不打印）`)
  }
  return {
    ...process.env,
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: model.baseUrl,
    OPENAI_MODEL: model.model,
    // 单请求超时（llm.ts 传输层）：长推理模型单轮 20-40 分钟实测会撞缺省 20 分钟
    // 上限（glm-5.3 探针两轮均因此超时重试）；进程 env 已显式设置时尊重外层。
    LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS ?? "3600000",
  }
}
