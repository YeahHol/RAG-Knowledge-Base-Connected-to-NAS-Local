/**
 * 调用 OpenAI 兼容接口（可接通义、DeepSeek、本地 vLLM 等）
 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function chatCompletion(opts: {
  baseURL: string
  apiKey: string
  model: string
  system: string
  user: string
}): Promise<string> {
  const url = `${opts.baseURL.replace(/\/$/, "")}/chat/completions`
  const maxAttempts = 4
  let lastError = ""

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        temperature: 0.3,
      }),
    })

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = data.choices?.[0]?.message?.content
      if (!text) throw new Error("模型返回空内容")
      return text
    }

    const t = await res.text()
    if (/exceeded model token limit|context_length_exceeded|maximum context length/i.test(t)) {
      lastError = `模型输入过长（超过该模型的 token 上限）：已自动压缩检索上下文；若仍报错，请在 .env 降低 CHAT_MODEL_MAX_INPUT_TOKENS 或调小 CHAT_RAG_CHUNK_CHARS。原始：${t.slice(0, 400)}`
    } else {
      lastError = `模型接口错误 ${res.status}: ${t.slice(0, 500)}`
    }
    const shouldRetry = res.status === 429 || res.status >= 500
    if (!shouldRetry || attempt === maxAttempts) {
      break
    }
    const backoffMs = Math.min(12000, 1200 * 2 ** (attempt - 1))
    await sleep(backoffMs)
  }

  throw new Error(lastError || "模型接口请求失败")
}
