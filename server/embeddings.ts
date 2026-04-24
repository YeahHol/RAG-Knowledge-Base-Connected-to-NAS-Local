type EmbeddingResp = {
  data?: Array<{ embedding?: number[] }>
}

type DashScopeResp = {
  output?: unknown
}

function normalizeVec(vec: number[]): number[] {
  let norm = 0
  for (const v of vec) norm += v * v
  const denom = Math.sqrt(norm) || 1
  return vec.map((v) => v / denom)
}

function clipInput(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  return trimmed.length > 6000 ? trimmed.slice(0, 6000) : trimmed
}

/** 将常见计费类错误转成可读中文，便于前端「向量错误」展示 */
function embeddingHttpError(provider: string, status: number, body: string): Error {
  const raw = body.slice(0, 800)
  if (/Arrearage|overdue-payment|good standing|欠费/i.test(raw)) {
    return new Error(
      `阿里云百炼账号欠费或不可用（Arrearage）：请登录阿里云/Model Studio 检查余额、按量付费与账单。说明：https://help.aliyun.com/zh/model-studio/error-code#overdue-payment 。临时可设 ENABLE_VECTOR_SEARCH=false 仅用关键词检索。原始：HTTP ${status}`,
    )
  }
  if (/AllocationQuota\.FreeTierOnly|free tier of the model has been exhausted|use free tier only/i.test(raw)) {
    return new Error(
      `该模型免费额度已用完（AllocationQuota.FreeTierOnly）：请在阿里云百炼/Model Studio 控制台关闭「仅使用免费额度」或开通按量付费后再调用；否则无法继续使用此 embedding。临时可设 ENABLE_VECTOR_SEARCH=false 仅用关键词检索。说明见控制台计费与模型额度。原始：HTTP ${status}`,
    )
  }
  return new Error(`${provider} Embedding 错误 ${status}: ${raw.slice(0, 500)}`)
}

export function getEmbeddingConfig() {
  const apiKey = String(process.env.OPENAI_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  const baseURL = String(process.env.OPENAI_EMBEDDING_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim()
  const model = String(process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small").trim()
  const enabled = String(process.env.ENABLE_VECTOR_SEARCH ?? "true").trim().toLowerCase() !== "false"
  const provider = String(process.env.EMBEDDING_PROVIDER ?? "auto").trim().toLowerCase()
  return { enabled, apiKey, baseURL, model, provider }
}

function shouldUseDashScopeNative(cfg: ReturnType<typeof getEmbeddingConfig>): boolean {
  if (cfg.provider === "dashscope") return true
  if (cfg.provider === "openai") return false
  return (
    cfg.model.startsWith("qwen3-vl-embedding") ||
    cfg.model.startsWith("qwen2.5-vl-embedding") ||
    cfg.model.startsWith("tongyi-embedding-vision") ||
    cfg.baseURL.includes("dashscope.aliyuncs.com")
  )
}

function readVectorFromUnknown(obj: unknown): number[] | null {
  if (!obj || typeof obj !== "object") return null
  const v = obj as Record<string, unknown>
  const maybeEmbedding = v.embedding
  if (Array.isArray(maybeEmbedding) && maybeEmbedding.every((x) => typeof x === "number")) {
    return maybeEmbedding as number[]
  }
  for (const key of Object.keys(v)) {
    const child = v[key]
    if (Array.isArray(child) && child.length > 0) {
      const first = child[0]
      const vec = readVectorFromUnknown(first)
      if (vec) return vec
    } else if (typeof child === "object" && child) {
      const vec = readVectorFromUnknown(child)
      if (vec) return vec
    }
  }
  return null
}

async function embedWithOpenAICompatible(cfg: ReturnType<typeof getEmbeddingConfig>, text: string): Promise<number[] | null> {
  const url = `${cfg.baseURL.replace(/\/$/, "")}/embeddings`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: clipInput(text),
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw embeddingHttpError("兼容模式", res.status, t)
  }
  const data = (await res.json()) as EmbeddingResp
  const vec = data.data?.[0]?.embedding
  if (!vec || vec.length === 0) return null
  return normalizeVec(vec)
}

async function embedWithDashScopeNative(cfg: ReturnType<typeof getEmbeddingConfig>, text: string): Promise<number[] | null> {
  const base = cfg.baseURL
    .replace(/\/$/, "")
    .replace(/\/compatible-mode\/v1$/, "")
    .replace(/\/api\/v1$/, "")
  const url = `${base}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: {
        contents: [{ text: clipInput(text) }],
      },
      parameters: {
        enable_fusion: true,
      },
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw embeddingHttpError("DashScope 原生", res.status, t)
  }
  const data = (await res.json()) as DashScopeResp
  const vec = readVectorFromUnknown(data.output)
  if (!vec || vec.length === 0) return null
  return normalizeVec(vec)
}

export async function embedText(text: string): Promise<number[] | null> {
  const cfg = getEmbeddingConfig()
  if (!cfg.enabled || !cfg.apiKey) return null
  if (shouldUseDashScopeNative(cfg)) {
    return embedWithDashScopeNative(cfg, text)
  }
  return embedWithOpenAICompatible(cfg, text)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
