import fs from "node:fs/promises"
import path from "node:path"
import type { StoreShape } from "./store"
import { chatCompletion } from "./chat"
import { isWikiLayerRel } from "./search"

type TopicBucket = {
  key: string
  title: string
  chunks: Array<{ relPath: string; title: string; content: string }>
}

export type BuildWikiOptions = {
  store: StoreShape
  baseURL: string
  apiKey: string
  model: string
  topicLimit: number
  chunksPerTopic: number
  maxCharsPerTopic: number
}

export type BuildWikiResult = {
  generated: Array<{
    title: string
    relPath: string
    sourceCount: number
    content: string
  }>
}


function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "")
}

function slugify(input: string): string {
  const clean = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return clean || "topic"
}

function topicTitleFromKey(key: string): string {
  if (key === "_root") return "通用主题"
  return key.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
}

function buildBuckets(store: StoreShape): TopicBucket[] {
  const fileById = new Map(
    store.files.map((f) => [f.id, normalizeRel(f.relPath)]),
  )
  const grouped = new Map<string, TopicBucket>()
  for (const c of store.chunks) {
    const rel = fileById.get(c.fileId)
    if (!rel || isWikiLayerRel(rel)) continue
    const top = rel.split("/")[0] || "_root"
    const key = top === rel ? "_root" : top
    const bucket = grouped.get(key) ?? {
      key,
      title: topicTitleFromKey(key),
      chunks: [],
    }
    bucket.chunks.push({
      relPath: rel,
      title: c.title,
      content: c.content,
    })
    grouped.set(key, bucket)
  }
  return Array.from(grouped.values()).sort((a, b) => b.chunks.length - a.chunks.length)
}

function buildContext(
  bucket: TopicBucket,
  chunksPerTopic: number,
  maxCharsPerTopic: number,
): { context: string; sourceCount: number } {
  const sorted = bucket.chunks
    .slice()
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, Math.max(1, chunksPerTopic * 2))
  const blocks: string[] = []
  let total = 0
  let used = 0
  for (const item of sorted) {
    const content = item.content.slice(0, 900)
    const block = `来源: ${item.relPath}\n标题: ${item.title}\n内容: ${content}`
    const addLen = block.length + 2
    if (total + addLen > maxCharsPerTopic && used > 0) break
    blocks.push(block)
    total += addLen
    used++
    if (used >= chunksPerTopic) break
  }
  return { context: blocks.join("\n\n"), sourceCount: used }
}

async function generateOneTopicPage(opts: {
  title: string
  context: string
  baseURL: string
  apiKey: string
  model: string
}): Promise<string> {
  const system = `你是企业知识库编辑。请把给定资料整理成一页团队 Wiki（Markdown）。要求：
1) 结构固定为：# 标题、## 结论速览、## 关键事实、## 实施建议、## 风险与边界、## 参考来源。
2) 只使用资料中出现的信息，不要编造。
3) “关键事实”尽量使用表格。
4) “参考来源”列出资料中的来源路径。`
  const user = `请整理主题：${opts.title}\n\n资料如下：\n${opts.context}`
  return chatCompletion({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    model: opts.model,
    system,
    user,
  })
}

export async function buildWikiPages(opts: BuildWikiOptions): Promise<BuildWikiResult> {
  const buckets = buildBuckets(opts.store).slice(0, Math.max(1, opts.topicLimit))
  const generated: BuildWikiResult["generated"] = []
  for (const b of buckets) {
    const { context, sourceCount } = buildContext(b, opts.chunksPerTopic, opts.maxCharsPerTopic)
    if (!context.trim()) continue
    const content = await generateOneTopicPage({
      title: b.title,
      context,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
    })
    generated.push({
      title: b.title,
      relPath: `wiki/topics/${slugify(b.title)}.md`,
      sourceCount,
      content: content.trim(),
    })
  }
  return { generated }
}

export async function writeWikiPages(
  rootPath: string,
  pages: BuildWikiResult["generated"],
) {
  const wikiRoot = path.join(rootPath, "wiki")
  const topicsDir = path.join(wikiRoot, "topics")
  await fs.mkdir(topicsDir, { recursive: true })
  for (const p of pages) {
    const abs = path.join(rootPath, p.relPath.replace(/\//g, path.sep))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, `${p.content}\n`, "utf-8")
  }
  const indexBody = [
    "# 团队 Wiki 索引",
    "",
    ...pages.map((p) => `- [${p.title}](./${p.relPath.replace(/^wiki\//, "")})（来源片段: ${p.sourceCount}）`),
    "",
    `更新时间：${new Date().toISOString()}`,
  ].join("\n")
  await fs.writeFile(path.join(wikiRoot, "_index.md"), `${indexBody}\n`, "utf-8")
}
