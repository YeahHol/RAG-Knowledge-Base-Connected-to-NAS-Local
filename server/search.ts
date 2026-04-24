import Fuse from "fuse.js"
import type { StoredChunk } from "./store"
import { cosineSimilarity } from "./embeddings"

/** 避免同一进程内对同一「查询维≠索引维」组合刷屏 */
const warnedEmbeddingDimMismatches = new Set<string>()

export interface SearchHit {
  chunk: StoredChunk
  score: number
}

function splitQueryTerms(query: string): string[] {
  const lower = query.toLowerCase()
  const terms: string[] = []
  const hanSeq = lower.match(/[\p{Script=Han}]{2,}/gu) ?? []
  for (const seq of hanSeq) {
    terms.push(seq)
    const parts = seq.split(/[的地得和及与并在对将把为了于]/g).filter((p) => p.length >= 2)
    for (const p of parts) terms.push(p)
    if (parts.length <= 1 && seq.length >= 8) {
      // 对很长中文短语做轻量滑窗，避免整句成一个词导致检索失灵
      for (let i = 0; i < seq.length && i < 12; i += 2) {
        const w = seq.slice(i, i + 6)
        if (w.length >= 4) terms.push(w)
      }
    }
  }
  const ascii = lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []
  terms.push(...ascii)
  if (terms.length === 0) return []
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const t of terms) {
    const v = t.trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    uniq.push(v)
  }
  return uniq.slice(0, 8)
}

function buildQueryVariants(query: string): Array<{ text: string; weight: number }> {
  const base = query.trim()
  if (!base) return []
  const terms = splitQueryTerms(base)
  const variants: Array<{ text: string; weight: number }> = [{ text: base, weight: 1 }]
  const add = (text: string, weight: number) => {
    const t = text.trim()
    if (!t) return
    if (variants.some((v) => v.text === t)) return
    variants.push({ text: t, weight })
  }

  // 去掉语气/连接词，适配用户随口问法。
  const cleaned = base
    .replace(/[，。！？、；：,.!?;:]/g, " ")
    .replace(/\b(一下|一下子|帮我|给我|有没有|有么|有吗|怎么|如何|关于|那个|这个|这篇|那篇|文章)\b/g, " ")
    .replace(/[的地得]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned && cleaned !== base) add(cleaned, 0.95)
  if (terms.length >= 2) add(terms.join(" "), 0.92)

  const aliasMap: Array<[RegExp, string]> = [
    [/产品手册|手册|资料包/g, "技术方案"],
    [/政策梳理|政策汇总|政策总结/g, "政策"],
    [/商业计划书|bp|business plan/gi, "商业计划书"],
    [/访谈记录|会议纪要|沟通纪要/g, "访谈"],
    [/可行性研究|可研/g, "可行性研究报告"],
  ]
  for (const [pattern, repl] of aliasMap) {
    const next = base.replace(pattern, repl).replace(/\s+/g, " ").trim()
    if (next && next !== base) add(next, 0.88)
  }

  // 最多取 4 个变体，避免检索过慢。
  return variants.slice(0, 4)
}

function normalizeForContainment(s: string): string {
  return s.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
}

function isSectionFocusedQuery(query: string): boolean {
  const q = query.toLowerCase()
  return /章节|章|部分|小节|这一章|本章|该章|负荷分析|专题|专门讲/.test(q)
}

/** 视为「整理层 / LLM Wiki」的路径前缀（相对 NAS 根），逗号分隔，默认 `wiki` → 匹配 `wiki/...` */
export function wikiLayerPrefixes(): string[] {
  const raw = String(process.env.WIKI_LAYER_PREFIXES ?? "wiki").trim()
  if (!raw) return []
  return raw
    .split(/[,;|]/)
    .map((s) => s.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase())
    .filter(Boolean)
}

export function isWikiLayerRel(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
  if (!n) return false
  for (const p of wikiLayerPrefixes()) {
    if (n === p) return true
    const pre = p.endsWith("/") ? p : `${p}/`
    if (n.startsWith(pre)) return true
  }
  return false
}

function wikiLayerEnabled(): boolean {
  return String(process.env.WIKI_LAYER_ENABLED ?? "true").trim().toLowerCase() !== "false"
}

function wikiScoreBonus(): number {
  const n = Number(process.env.WIKI_LAYER_SCORE_BONUS ?? 32)
  if (!Number.isFinite(n)) return 32
  return Math.max(0, Math.min(160, Math.floor(n)))
}

function wikiMaxChunksPerFile(): number {
  const n = Number(process.env.WIKI_MAX_CHUNKS_PER_FILE ?? 4)
  if (!Number.isFinite(n) || n < 1) return 4
  return Math.min(12, Math.floor(n))
}

export type SearchChunksOptions = {
  /** chunk.fileId → 文件相对路径（正斜杠），用于识别整理层 wiki 路径并加权 */
  fileRelByChunkId?: Map<string, string>
}

export function searchChunks(
  chunks: StoredChunk[],
  query: string,
  limit = 15,
  queryEmbedding?: number[] | null,
  opts?: SearchChunksOptions,
): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  const queryVariants = buildQueryVariants(q)

  const fuse = new Fuse(chunks, {
    keys: [
      { name: "title", weight: 0.35 },
      { name: "content", weight: 0.65 },
    ],
    threshold: 0.38,
    ignoreLocation: true,
    includeScore: true,
  })

  const keywordByChunkId = new Map<string, number>()
  for (const v of queryVariants) {
    for (const r of fuse.search(v.text, { limit: limit * 6 })) {
      if (!r.item || r.score == null) continue
      const s = Math.max(0, 100 * (1 - r.score)) * v.weight
      const prev = keywordByChunkId.get(r.item.id) ?? 0
      if (s > prev) keywordByChunkId.set(r.item.id, s)
    }
  }
  // 口语问法经常与文档原句不一致；严格召回偏少时，用更宽松阈值补一轮候选。
  if (keywordByChunkId.size < Math.max(3, Math.floor(limit * 0.7))) {
    const relaxed = new Fuse(chunks, {
      keys: [
        { name: "title", weight: 0.45 },
        { name: "content", weight: 0.55 },
      ],
      threshold: 0.62,
      ignoreLocation: true,
      includeScore: true,
    })
    for (const v of queryVariants) {
      for (const r of relaxed.search(v.text, { limit: limit * 12 })) {
        if (!r.item || r.score == null) continue
        const s = Math.max(0, 100 * (1 - r.score)) * 0.82 * v.weight
        const prev = keywordByChunkId.get(r.item.id) ?? 0
        if (s > prev) keywordByChunkId.set(r.item.id, s)
      }
    }
  }
  // 再做分词子查询，给包含关键术语的 chunk 额外加权。
  const terms = splitQueryTerms(q)
  for (const term of terms) {
    for (const r of fuse.search(term, { limit: limit * 8 })) {
      if (!r.item || r.score == null) continue
      const termScore = Math.max(0, 100 * (1 - r.score)) * 0.7
      const titleBonus = r.item.title.toLowerCase().includes(term) ? 8 : 0
      const prev = keywordByChunkId.get(r.item.id) ?? 0
      const boosted = Math.max(prev, termScore + titleBonus)
      keywordByChunkId.set(r.item.id, boosted)
    }
  }
  // 直接词项匹配（不依赖 Fuse）：提高“文件名/标题有关键词”的召回概率。
  if (terms.length > 0) {
    const normalizedQ = normalizeForContainment(q)
    for (const c of chunks) {
      const t = c.title.toLowerCase()
      const b = c.content.toLowerCase()
      const normalizedTitle = normalizeForContainment(c.title)
      let titleHits = 0
      let bodyHits = 0
      for (const term of terms) {
        if (t.includes(term)) titleHits++
        else if (b.includes(term)) bodyHits++
      }
      if (titleHits === 0 && bodyHits === 0) continue
      const allInTitle = titleHits === terms.length
      const exactTitleBoost =
        normalizedQ.length >= 6 && (normalizedTitle.includes(normalizedQ) || normalizedQ.includes(normalizedTitle))
          ? 140
          : 0
      const lexicalScore = titleHits * 14 + bodyHits * 5 + (allInTitle ? 28 : 0) + exactTitleBoost
      const prev = keywordByChunkId.get(c.id) ?? 0
      keywordByChunkId.set(c.id, Math.max(prev, lexicalScore))
    }
  }

  const vectorByChunkId = new Map<string, number>()
  if (queryEmbedding) {
    const qDim = queryEmbedding.length
    for (const c of chunks) {
      if (!c.embedding || c.embedding.length === 0) continue
      if (c.embedding.length !== qDim) {
        const key = `${qDim}≠${c.embedding.length}`
        if (!warnedEmbeddingDimMismatches.has(key)) {
          warnedEmbeddingDimMismatches.add(key)
          console.warn(
            `[search] 查询向量维度 ${qDim} 与部分 chunk 向量维度 ${c.embedding.length} 不一致，已跳过向量相似度；请使用同一 embedding 模型对资料全量重建索引（否则只能依赖关键词分）。`,
          )
        }
        continue
      }
      const sim = cosineSimilarity(queryEmbedding, c.embedding)
      const vectorScore = Math.max(0, Math.min(100, (sim + 1) * 50))
      vectorByChunkId.set(c.id, vectorScore)
    }
  }

  const nq = normalizeForContainment(q)
  const anchorChunkIds = new Set<string>()
  if (nq.length >= 6) {
    for (const c of chunks) {
      const nt = normalizeForContainment(c.title)
      if (!nt) continue
      const titleTermHits = terms.filter((term) => term.length >= 2 && nt.includes(normalizeForContainment(term))).length
      if (nt.includes(nq) || nq.includes(nt) || titleTermHits >= 2) {
        anchorChunkIds.add(c.id)
      }
    }
  }
  const hasAnchor = anchorChunkIds.size > 0

  const merged: SearchHit[] = []
  for (const c of chunks) {
    const keyword = keywordByChunkId.get(c.id) ?? 0
    const vector = vectorByChunkId.get(c.id) ?? 0
    const hasVector = vectorByChunkId.has(c.id)
    const isAnchor = anchorChunkIds.has(c.id)
    let combined = hasVector ? keyword * 0.45 + vector * 0.55 : keyword
    if (hasAnchor) {
      if (isAnchor) {
        // 专名/项目名命中标题时，以关键词为主，向量只做微调，防止“语义泛化”把真命中挤掉。
        combined = hasVector ? keyword * 0.88 + vector * 0.12 : keyword
        combined += 160
      } else {
        combined = hasVector ? keyword * 0.78 + vector * 0.22 : keyword * 0.9
      }
    }
    const rel = opts?.fileRelByChunkId?.get(c.fileId) ?? ""
    if (wikiLayerEnabled() && combined > 0 && rel && isWikiLayerRel(rel)) {
      combined += wikiScoreBonus()
    }
    if (combined > 0) merged.push({ chunk: c, score: combined })
  }

  merged.sort((a, b) => b.score - a.score)
  const basePerFileCap = Math.max(1, Number(process.env.SEARCH_MAX_CHUNKS_PER_FILE ?? 2) || 2)
  const perFileCap = isSectionFocusedQuery(q) ? Math.max(basePerFileCap, 5) : basePerFileCap
  const wikiCap = Math.max(perFileCap, wikiMaxChunksPerFile())
  const perFileCount = new Map<string, number>()
  const diversified: SearchHit[] = []
  for (const h of merged) {
    const rel = opts?.fileRelByChunkId?.get(h.chunk.fileId) ?? ""
    const cap = wikiLayerEnabled() && rel && isWikiLayerRel(rel) ? wikiCap : perFileCap
    const used = perFileCount.get(h.chunk.fileId) ?? 0
    if (used >= cap) continue
    diversified.push(h)
    perFileCount.set(h.chunk.fileId, used + 1)
    if (diversified.length >= limit) break
  }
  if (diversified.length >= limit) return diversified
  // 若去重后不足 K，再补回高分剩余项，保证结果条数稳定。
  const pickedIds = new Set(diversified.map((h) => h.chunk.id))
  for (const h of merged) {
    if (pickedIds.has(h.chunk.id)) continue
    diversified.push(h)
    if (diversified.length >= limit) break
  }
  return diversified
}

/** 与常见 OpenAI 兼容接口相近的粗估（中文偏多时偏保守），用于控制总 prompt 不超模型上限 */
export function estimateChatInputTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 1.5))
}

export interface BuildLlmRagContextOptions {
  /** 所有片段正文+标题拼接后的总字符上限（不含片段间分隔符的精确意义，按整体控制） */
  maxTotalChars: number
  /** 单条片段正文最多取多少字符 */
  maxCharsPerChunk?: number
  /** chunk.fileId → 相对路径，用于在上下文中标注「整理层」 */
  fileRelByChunkId?: Map<string, string>
}

/**
 * 在字符预算内组装 RAG 上下文；返回的 `hits` 与片段编号 [1]、[2]… 一一对应（可能少于检索到的条数）。
 */
export function buildLlmRagContext(
  hits: SearchHit[],
  opts: BuildLlmRagContextOptions,
): { context: string; hits: SearchHit[] } {
  const maxCharsPerChunk = opts.maxCharsPerChunk ?? 1400
  const blocks: string[] = []
  const used: SearchHit[] = []
  let total = 0
  const sep = "\n\n---\n\n"

  for (const h of hits) {
    const t = h.chunk.title
    const body = h.chunk.content.slice(0, maxCharsPerChunk)
    const n = used.length + 1
    const rel = opts.fileRelByChunkId?.get(h.chunk.fileId) ?? ""
    const wikiMark =
      wikiLayerEnabled() && rel && isWikiLayerRel(rel) ? "（整理层/Wiki） " : ""
    const block = `### 片段 ${n}: ${wikiMark}${t}\n${body}`
    const add = (blocks.length ? sep.length : 0) + block.length
    if (total + add <= opts.maxTotalChars) {
      blocks.push(block)
      total += add
      used.push(h)
      continue
    }
    if (blocks.length > 0) break
    const rel0 = opts.fileRelByChunkId?.get(h.chunk.fileId) ?? ""
    const wikiMark0 =
      wikiLayerEnabled() && rel0 && isWikiLayerRel(rel0) ? "（整理层/Wiki） " : ""
    const header = `### 片段 1: ${wikiMark0}${t}\n`
    const room = Math.max(0, opts.maxTotalChars - header.length - 2)
    const truncated = body.slice(0, Math.min(body.length, room))
    blocks.push(header + truncated + (truncated.length < body.length ? "\n…" : ""))
    used.push(h)
    break
  }

  return { context: blocks.join(sep), hits: used }
}

/** @deprecated 请用 buildLlmRagContext，以便与截断后的 hits 对齐 */
export function formatContextForLlm(hits: SearchHit[]): string {
  return buildLlmRagContext(hits, { maxTotalChars: 50_000, maxCharsPerChunk: 3500 }).context
}
