import { chatCompletion } from "./chat"
import type { SearchHit } from "./search"
import { buildLlmRagContext, estimateChatInputTokens } from "./search"

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const mapBatchSystem = `你是企业内部知识库的「检索压缩」助手。根据用户问题和若干文本片段，只输出与问题可能相关的要点，用中文无序列表（每行以「- 」开头），每条不超过 80 字。不得编造片段中没有的信息。若没有相关内容，只输出一行：- （本批无相关要点）
若片段标题含「（整理层/Wiki）」，表示团队维护的合成摘要，要点可优先采信其表述，但仍不得编造各片段中均未出现的具体数字或条款。`

/**
 * Map-Reduce 式 RAG：先把多批检索结果各自压成要点，再带着「要点汇总 + 少量高分原文」做一次最终作答。
 * 适合检索条数多、单模型上下文有限（如 8k）的场景；代价是多轮模型调用。
 */
export async function runMapReduceChat(opts: {
  question: string
  hits: SearchHit[]
  finalSystem: string
  maxInputTokens: number
  safetyTokens: number
  contextCharSlack: number
  maxCharsPerChunk: number
  baseURL: string
  apiKey: string
  model: string
  evidenceKOverride?: number
  batchMaxCharsOverride?: number
  perBatchChunkCapOverride?: number
  /** 用于在 map/reduce 上下文中标注整理层 wiki 片段 */
  fileRelByChunkId?: Map<string, string>
}): Promise<{ answer: string; promptHits: SearchHit[]; digest: string }> {
  const batchSize = Math.max(2, Math.min(14, Number(process.env.CHAT_MAP_BATCH_SIZE ?? 6) || 6))
  const digestMax = Math.max(2000, Math.min(60_000, Number(process.env.CHAT_MAP_DIGEST_MAX_CHARS ?? 8000) || 8000))
  const evidenceK = Math.max(
    2,
    Math.min(20, opts.evidenceKOverride ?? Number(process.env.CHAT_FINAL_EVIDENCE_CHUNKS ?? 5) ?? 5),
  )
  const batchMaxChars = Math.max(
    3000,
    Math.min(36_000, opts.batchMaxCharsOverride ?? Number(process.env.CHAT_MAP_BATCH_MAX_CHARS ?? 9000) ?? 9000),
  )
  const perBatchChunkCap = Math.max(
    600,
    Math.min(3500, opts.perBatchChunkCapOverride ?? Number(process.env.CHAT_MAP_CHUNK_CHARS ?? 1600) ?? 1600),
  )

  if (opts.hits.length === 0) {
    const user = `用户问题：\n${opts.question}\n\n---\n\n检索到的片段：\n（无检索结果）`
    const answer = await chatCompletion({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      system: opts.finalSystem,
      user,
    })
    return { answer, promptHits: [], digest: "" }
  }

  const batches = chunkArray(opts.hits, batchSize)
  const digests: string[] = []
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!
    const { context } = buildLlmRagContext(batch, {
      maxTotalChars: batchMaxChars,
      maxCharsPerChunk: Math.min(opts.maxCharsPerChunk, perBatchChunkCap),
      fileRelByChunkId: opts.fileRelByChunkId,
    })
    const user = `用户问题：\n${opts.question}\n\n---\n本批文本片段：\n${context || "（空）"}`
    const part = await chatCompletion({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      system: mapBatchSystem,
      user,
    })
    digests.push(`【批次 ${bi + 1}】\n${part.trim()}`)
  }

  let digest = digests.join("\n\n").trim()
  if (digest.length > digestMax) digest = `${digest.slice(0, digestMax)}\n…（要点汇总过长已截断）`

  const evidenceHits = opts.hits.slice(0, evidenceK)
  const digestSection = `要点汇总（多批检索压缩，事实依据须以原文为准）：\n${digest}`
  const tail = `\n\n---\n\n检索到的原文片段（引用编号仅本节有效，从 [1] 起）：\n`
  const userHead = `用户问题：\n${opts.question}\n\n---\n${digestSection}${tail}`

  const headTokens =
    estimateChatInputTokens(opts.finalSystem) + estimateChatInputTokens(userHead) + opts.safetyTokens
  const evidenceTokenBudget = Math.max(256, opts.maxInputTokens - headTokens)
  const maxEvidenceChars = Math.floor(evidenceTokenBudget * opts.contextCharSlack)

  const { context: evContext, hits: promptHits } = buildLlmRagContext(evidenceHits, {
    maxTotalChars: Math.max(400, maxEvidenceChars),
    maxCharsPerChunk: opts.maxCharsPerChunk,
    fileRelByChunkId: opts.fileRelByChunkId,
  })

  const finalUser = `${userHead}${evContext || "（无）"}`
  const answer = await chatCompletion({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    model: opts.model,
    system: opts.finalSystem,
    user: finalUser,
  })

  return { answer, promptHits, digest }
}
