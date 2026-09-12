import { describe, expect, it } from "vitest"

import { extractJson, readSseStream } from "./llm.js"

describe("extractJson", () => {
  it("解析裸 JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it("容忍尾部多余右括号（流式末块重复伪影）", () => {
    expect(extractJson('{"action":"draft","plan":{"rules":[]}}}')).toEqual({
      action: "draft",
      plan: { rules: [] },
    })
  })

  it("容忍对象后跟随的散文", () => {
    expect(extractJson('{"a": 1} 以上就是计划。')).toEqual({ a: 1 })
  })

  it("取首个括号平衡对象，字符串内的花括号不干扰计数", () => {
    const text = '{"a": "包含 } 与 { 的字符串", "b": {"c": 2}} 尾部垃圾'
    expect(extractJson(text)).toEqual({ a: "包含 } 与 { 的字符串", b: { c: 2 } })
  })

  it("优先取最后一个 ```json 代码块", () => {
    const text = '草稿 {"x":0}\n```json\n{"y": 1}\n```\n说明'
    expect(extractJson(text)).toEqual({ y: 1 })
  })

  it("代码块内带尾部杂质时仍可解析", () => {
    const text = '```json\n{"z": [1, 2]}}\n```'
    expect(extractJson(text)).toEqual({ z: [1, 2] })
  })

  it("无 JSON 时报错", () => {
    expect(() => extractJson("完全没有对象")).toThrow()
  })
})

describe("readSseStream", () => {
  function sse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
        controller.close()
      },
    })
    return { body: stream } as unknown as Response
  }

  it("OpenRouter 口径：reasoning 字段被累积（GLM-5.3 实测字段名）", async () => {
    const r = await readSseStream(sse([
      'data: {"choices":[{"delta":{"reasoning":"思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]))
    expect(r.content).toBe("答案")
    expect(r.reasoningContent).toBe("思考")
    expect(r.finishReason).toBe("stop")
  })

  it("智谱官方口径：reasoning_content 仍被累积（旧字段名兼容）", async () => {
    const r = await readSseStream(sse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考A"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"思考B","content":"答案"}}]}\n\n',
      "data: [DONE]\n\n",
    ]))
    expect(r.content).toBe("答案")
    expect(r.reasoningContent).toBe("思考A思考B")
  })

  it("两类字段并存时 reasoning_content 优先（不重复累积）", async () => {
    const r = await readSseStream(sse([
      'data: {"choices":[{"delta":{"reasoning":"旧","reasoning_content":"新"}}]}\n\n',
      "data: [DONE]\n\n",
    ]))
    expect(r.reasoningContent).toBe("新")
  })
})
