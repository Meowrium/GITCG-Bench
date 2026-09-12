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

import { GiTcgError } from "@gi-tcg/core"

/** evolve 模块统一错误类型。 */
export class EvolveError extends GiTcgError {}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ApiCredentials {
  apiBase: string
  apiKey: string
  model: string
}

/** 配额耗尽判定：402（余额不足）或 429 中带配额类错误体（周/月上限）。 */
export function isQuotaExhausted(status: number, body: string): boolean {
  if (status === 402) {
    return true
  }
  return (
    status === 429 &&
    /usage limit|insufficient balance|quota|GoUsageLimitError/i.test(body)
  )
}

/** 进程级备用 API 状态：一旦切换，本进程后续所有调用都走备用。 */
let activeFallback: ApiCredentials | null = null

/** 当前生效的备用 API（未切换时为 null）。 */
export function getActiveFallback(): ApiCredentials | null {
  return activeFallback
}

const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]
const REQUEST_TIMEOUT_MS = 120_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 调用 OpenAI 兼容 chat/completions 接口，返回首条 assistant 消息的纯文本内容。
 *
 * 重试策略：fetch 网络错误 / 429 / 5xx 按 5s→60s 指数退避最多重试 5 次；
 * 其余 4xx（参数错误、鉴权失败等）直接抛 EvolveError，不重试。
 * 配额耗尽（402 / 配额类 429）时，若配置了 fallback 则立即切换到备用 API
 * （进程级生效，本进程后续调用全部走备用）并用备用凭据重试当前请求。
 */
export async function chatCompletion(opts: {
  apiBase: string
  apiKey: string
  model: string
  fallback?: ApiCredentials
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}): Promise<string> {
  const { fallback, messages, temperature, maxTokens } = opts
  const creds: ApiCredentials = activeFallback ?? {
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    model: opts.model,
  }
  const url = `${creds.apiBase.replace(/\/+$/, "")}/chat/completions`

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const body: Record<string, unknown> = { model: creds.model, messages }
      if (temperature !== undefined) {
        body.temperature = temperature
      }
      if (maxTokens !== undefined) {
        body.max_tokens = maxTokens
      }
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  let lastError: unknown
  for (let retry = 0; retry <= RETRY_DELAYS_MS.length; retry += 1) {
    let res: Response
    try {
      res = await attempt()
    } catch (err) {
      lastError = err
      if (retry < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retry])
        continue
      }
      throw new EvolveError(
        `LLM 请求失败（网络错误，已重试 ${retry} 次）: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 配额耗尽：不重试，直接切换备用（未配置备用则按普通错误处理）
    if (activeFallback === null && fallback !== undefined) {
      const bodyText = res.ok ? "" : await safeText(res)
      if (isQuotaExhausted(res.status, bodyText)) {
        activeFallback = {
          apiBase: fallback.apiBase,
          apiKey: fallback.apiKey,
          model: fallback.model || opts.model,
        }
        console.error(
          `[llm-client] 主 API 配额耗尽（HTTP ${res.status}），切换备用 API: ${activeFallback.apiBase} (model=${activeFallback.model})`,
        )
        return chatCompletion({ ...opts, messages, temperature, maxTokens })
      }
      if (bodyText !== "" && !res.ok && res.status !== 429 && res.status < 500) {
        throw new EvolveError(`LLM 请求失败（HTTP ${res.status}）: ${bodyText}`)
      }
    }

    if (res.status === 429 || res.status >= 500) {
      if (retry < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retry])
        continue
      }
      throw new EvolveError(
        `LLM 请求失败（HTTP ${res.status}，已重试 ${retry} 次）: ${await safeText(res)}`,
      )
    }
    if (!res.ok) {
      throw new EvolveError(`LLM 请求失败（HTTP ${res.status}）: ${await safeText(res)}`)
    }

    let data: unknown
    try {
      data = await res.json()
    } catch (err) {
      throw new EvolveError(
        `LLM 响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const dataObj = asRecord(data)
    const firstChoice = Array.isArray(dataObj?.choices) ? dataObj.choices[0] : undefined
    const message = asRecord(firstChoice)?.message
    const content = asRecord(message)?.content
    if (typeof content !== "string") {
      throw new EvolveError(`LLM 响应缺少 choices[0].message.content 字段`)
    }
    return content
  }
  throw lastError instanceof Error ? new EvolveError(lastError.message) : new EvolveError(String(lastError))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>
  }
  return null
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return "(响应体不可读)"
  }
}
