/**
 * 多维度本地验证（不启动 HTTP）：整理层路径、检索加权、artifact 安全、store 可读。
 *   npx tsx scripts/multi-verify.ts
 */
import "dotenv/config"
import assert from "node:assert/strict"

import { cosineSimilarity } from "../server/embeddings"
import { resolveArtifactFile } from "../server/mineru-artifacts"
import { isWikiLayerRel, searchChunks, wikiLayerPrefixes } from "../server/search"
import type { StoredChunk } from "../server/store"
import { loadStore } from "../server/store"

let failures = 0
function ok(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}`, e)
  }
}

async function main() {
  process.env.WIKI_LAYER_ENABLED = "true"
  process.env.WIKI_LAYER_SCORE_BONUS = "32"

  console.log("[1] wiki 路径与前缀")
  ok("wikiLayerPrefixes 非空", () => assert.ok(wikiLayerPrefixes().length >= 1))
  ok("wiki/ 下为整理层", () => assert.equal(isWikiLayerRel("wiki/topics/a.md"), true))
  ok("非 wiki 前缀", () => assert.equal(isWikiLayerRel("demo-data/a.pdf"), false))

  console.log("\n[2] 检索：同文条件下 wiki 文件应因加分排在前面")
  ok("searchChunks + fileRelByChunkId 提升 wiki", () => {
    const chunks: StoredChunk[] = [
      { id: "c-pdf", fileId: "f-pdf", title: "报告 #0", content: "储能峰谷套利 相同关键词", chunkIndex: 0 },
      { id: "c-wiki", fileId: "f-wiki", title: "专题 #0", content: "储能峰谷套利 相同关键词", chunkIndex: 0 },
    ]
    const relMap = new Map<string, string>([
      ["f-pdf", "demo-data/某报告.pdf"],
      ["f-wiki", "wiki/topics/口径.md"],
    ])
    const hits = searchChunks(chunks, "储能峰谷套利", 5, null, { fileRelByChunkId: relMap })
    assert.ok(hits.length >= 1)
    assert.equal(hits[0]!.chunk.id, "c-wiki", "首条应为 wiki 路径 chunk")
  })

  console.log("\n[3] MinerU artifact 路径安全")
  ok("非法 digest", () => assert.equal(resolveArtifactFile("gg", "a/b"), null))
  ok("路径穿越", () => assert.equal(resolveArtifactFile("a".repeat(40), "../x"), null))

  console.log("\n[4] 向量维度不一致时余弦为 0")
  ok("cosine 长度不同", () => assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0))

  console.log("\n[5] store.json 可读")
  try {
    const s = await loadStore()
    assert.ok(Array.isArray(s.files))
    assert.ok(Array.isArray(s.chunks))
    const withEmb = s.chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
    console.log(`  ✓ loadStore (files=${s.files.length} chunks=${s.chunks.length} withEmbedding=${withEmb.length})`)
  } catch (e) {
    failures++
    console.error("  ✗ loadStore", e)
  }

  console.log("\n---")
  if (failures > 0) {
    console.error(`失败 ${failures} 项`)
    process.exit(1)
  }
  console.log("multi-verify 全部通过")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
