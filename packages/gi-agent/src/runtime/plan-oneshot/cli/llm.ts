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
 * plan-oneshot CLI 共用的最小 OpenAI 兼容 chat 客户端 + .env 加载。
 * 环境变量：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（与仓库其他 LLM 工具一致）。
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

/** 缺省时从包目录 .env 加载（不覆盖已有环境变量） */
export function loadDotEnvFallback(): void {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
  const envPath = join(pkgDir, ".env")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    const [, key, raw] = m
    if (process.env[key] !== undefined && process.env[key] !== "") continue
    process.env[key] = raw.replace(/^["']|["']$/g, "")
  }
}

/** 多轮对话消息（harness agent 循环用；assistant 轮内容为模型原始输出） */
export interface HarnessChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmCallOptions {
  system?: string
  user?: string
  /** 多轮对话：存在时直接作为 messages 发出，system/user 被忽略 */
  messages?: HarnessChatMessage[]
  model?: string
  /** 推理模型结构化输出需要大 maxTokens（findings §3），默认 32768 */
  maxTokens?: number
  /** 采样温度：结构化计划生成默认 0.2（高温度对长 JSON 是格式错误的主要来源之一） */
  temperature?: number
  /** 采样种子（OpenAI 兼容 seed 参数；记录进 plan.sampling 以便复现） */
  seed?: number
  /**
   * 是否启用推理（thinking）。三态：
   * - false：发 enable_thinking:false（edgefn/MiniMax 必须，否则烧穿 maxTokens 空输出）；
   * - true：不发任何推理开关（scnet DeepSeek-V4-Flash-0731 默认推理，16K 可靠——findings §3）；
   * - undefined（默认）：发 enable_thinking:false（当前默认通道的安全行为）。
   */
  thinking?: boolean
  /**
   * SSE 流式接收。长推理 + 大 maxTokens（如 131072）的非流式请求会被网关
   * HTTP/2 300s 流超时掐断（"stream timeout after 300000"）；流式下 token 持续
   * 回流，无空闲超时。采样参数不变，仅传输层差异。
   */
  stream?: boolean
}

export interface LlmCallResult {
  content: string
  /** 推理模型的思考通道内容（部分模型把答案留在 reasoning_content 而 content 为空） */
  reasoningContent?: string
  model: string
  usage?: Record<string, unknown>
}

/** 读取 SSE 流式响应，累积 content / reasoning_content（网关在末块给 usage 时一并捕获） */
export async function readSseStream(resp: Response): Promise<{ content: string; reasoningContent: string; finishReason?: string; usage?: Record<string, unknown> }> {
  if (!resp.body) throw new Error("流式响应无 body")
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let content = ""
  let reasoning = ""
  let finishReason: string | undefined
  let usage: Record<string, unknown> | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") continue
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }>
          usage?: Record<string, unknown>
        }
        const ch = chunk.choices?.[0]
        if (ch?.delta?.content) content += ch.delta.content
        // 推理字段名不统一：智谱官方/edgefn 走 reasoning_content，OpenRouter 走 reasoning
        // （GLM-5.3 系列实测），两者都收，避免推理流丢失导致烧穿 maxTokens 时误判空内容
        if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content
        else if (ch?.delta?.reasoning) reasoning += ch.delta.reasoning
        if (ch?.finish_reason) finishReason = ch.finish_reason
        if (chunk.usage) usage = chunk.usage
      } catch {
        // 半行/心跳等非 JSON 负载，忽略
      }
    }
  }
  return { content, reasoningContent: reasoning, finishReason, usage }
}

export async function chatCompletion(opts: LlmCallOptions): Promise<LlmCallResult> {
  loadDotEnvFallback()
  const apiKey = process.env.OPENAI_API_KEY ?? ""
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "")
  const model = opts.model ?? process.env.OPENAI_MODEL ?? ""
  if (!apiKey || !baseUrl || !model) {
    throw new Error("需要 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（环境变量或 packages/gi-agent/.env）")
  }

  if (!opts.messages && (opts.system === undefined || opts.user === undefined)) {
    throw new Error("chatCompletion 需要 messages 或 system+user")
  }
  const body = JSON.stringify({
    model,
    messages: opts.messages ?? [
      { role: "system", content: opts.system ?? "" },
      { role: "user", content: opts.user ?? "" },
    ],
    // 输出上限参数名按供应商分叉：qwen 系（DashScope/Aliyun maas 兼容端点）只认
    // max_completion_tokens，max_tokens 被忽略（长推理会被平台默认值截断）；
    // GLM/DeepSeek 系认 max_tokens。
    ...(model.toLowerCase().includes("qwen")
      ? { max_completion_tokens: opts.maxTokens ?? 32768 }
      : { max_tokens: opts.maxTokens ?? 32768 }),
    temperature: opts.temperature ?? 0.2,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    // thinking=false/undefined → 显式关（MiniMax 等不关会烧穿预算）；thinking=true → 显式开
    // （Zhipu 默认开、显式 true 等价；DashScope qwen 系非流式默认关，必须显式 true 才有推理）
    ...(opts.thinking === false || opts.thinking === undefined
      ? { enable_thinking: false }
      : { enable_thinking: true }),
    ...(opts.stream ? { stream: true } : {}),
  })

  // 推理模型 + 大 prompt 响应慢：默认 20 分钟超时（LLM_TIMEOUT_MS 可覆盖，GLM 长推理建议 3600000）；网络错误 / 429 / 5xx 退避重试
  // （502 "server is busy" 风暴实测可持续 8 分钟以上，8 次尝试 + 240s 上限 ≈ 16 分钟耐心）
  let resp: Response | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          ...(opts.stream ? { "Accept": "text/event-stream" } : {}),
        },
        body,
        signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 1_200_000),
      })
      if (resp.ok || (resp.status !== 429 && resp.status < 500)) break
      lastErr = new Error(`LLM API ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
      resp = null
    } catch (e) {
      lastErr = e
    }
    const backoffMs = Math.min(15_000 * 2 ** attempt, 240_000)
    console.warn(`LLM 调用失败（第 ${attempt + 1} 次），${backoffMs / 1000}s 后重试: ${String(lastErr).slice(0, 200)}`)
    await new Promise((r) => setTimeout(r, backoffMs))
  }
  if (!resp) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
  if (!resp.ok) {
    throw new Error(`LLM API ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  }
  if (opts.stream) {
    // 流式读取也可能中途被网关掐断（NGHTTP2_INTERNAL_ERROR）：同样退避重试
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { content, reasoningContent, finishReason, usage } = await readSseStream(resp)
        if (!content && !reasoningContent) {
          throw new Error(`LLM 流式返回空内容（finish_reason=${finishReason ?? "?"}）——推理模型可能烧穿了 maxTokens`)
        }
        return { content, reasoningContent, model, usage }
      } catch (e) {
        lastErr = e
        if (attempt >= 4) break
        // 重新发起同一请求（流已损坏，必须重连）
        const backoffMs = 15_000 * 2 ** attempt
        console.warn(`LLM 流式读取失败（第 ${attempt + 1} 次），${backoffMs / 1000}s 后重试: ${String(e).slice(0, 200)}`)
        await new Promise((r) => setTimeout(r, backoffMs))
        resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "text/event-stream",
          },
          body,
          signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 1_200_000),
        })
        if (!resp.ok) {
          throw new Error(`LLM API ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }>
    usage?: Record<string, unknown>
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? ""
  // 同流式：reasoning_content / reasoning 字段名双兼容（OpenRouter 用 reasoning）
  const reasoningContent = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? ""
  if (!content && !reasoningContent) {
    throw new Error(
      `LLM 返回空内容（finish_reason=${choice?.finish_reason ?? "?"}，usage=${JSON.stringify(data.usage ?? {})}）——推理模型可能烧穿了 maxTokens`,
    )
  }
  return { content, reasoningContent, model, usage: data.usage }
}

/** 从 LLM 输出中提取 JSON：优先最后一个 ```json 代码块（推理通道里前面的可能是草稿），否则首尾花括号区间 */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  if (fenced.length > 0) {
    const candidate = fenced[fenced.length - 1][1].trim()
    try {
      return JSON.parse(candidate)
    } catch {
      // 代码块内可能也带尾部杂质，落到下方平衡扫描
      return parseFirstBalancedJson(candidate)
    }
  }
  const start = text.indexOf("{")
  if (start < 0) throw new Error("输出中未找到 JSON 对象")
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1))
  } catch {
    // 尾部杂质（如流式末块重复字符）或对象后还有文本：取首个括号平衡的完整 JSON 值
    return parseFirstBalancedJson(text.slice(start))
  }
}

/** 扫描首个括号平衡的完整 JSON 对象（正确跳过字符串字面量与转义） */
function parseFirstBalancedJson(text: string): unknown {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return JSON.parse(text.slice(0, i + 1))
    }
  }
  throw new Error("输出中未找到括号平衡的 JSON 对象")
}
