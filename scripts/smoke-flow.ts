/**
 * 上线前自检：Embedding 配置、可选一次 embed 调用、store 与向量维度概况。
 *
 * 用法（在 nas-rag-app 根目录）：
 *   npm run smoke
 *   npx tsx scripts/smoke-flow.ts
 */
import "dotenv/config"

import { embedText, getEmbeddingConfig } from "../server/embeddings"
import { resolveArtifactFile } from "../server/mineru-artifacts"
import { loadStore } from "../server/store"

function maskKey(k: string): string {
  const t = k.trim()
  if (t.length < 8) return t ? "****" : "（空）"
  return `${t.slice(0, 4)}…${t.slice(-3)}`
}

async function main() {
  console.log("=== nas-rag-app smoke-flow ===\n")
  const emb = getEmbeddingConfig()
  const keySource = String(process.env.OPENAI_EMBEDDING_API_KEY ?? "").trim()
    ? "OPENAI_EMBEDDING_API_KEY"
    : String(process.env.OPENAI_API_KEY ?? "").trim()
      ? "OPENAI_API_KEY（回退）"
      : "（未配置）"

  console.log("[1] Embedding 配置")
  console.log(`    ENABLE_VECTOR_SEARCH: ${emb.enabled}`)
  console.log(`    密钥来源: ${keySource}  ${emb.apiKey ? maskKey(emb.apiKey) : "（无密钥）"}`)
  console.log(`    OPENAI_EMBEDDING_BASE_URL: ${emb.baseURL || "（默认）"}`)
  console.log(`    OPENAI_EMBEDDING_MODEL: ${emb.model}`)
  console.log(`    EMBEDDING_PROVIDER: ${emb.provider}`)

  if (!emb.enabled) {
    console.log("\n    向量检索已关闭；问答仍可走关键词检索。")
  } else if (!emb.apiKey) {
    console.log(
      "\n    ⚠ 向量已开启但未找到 OPENAI_EMBEDDING_API_KEY / OPENAI_API_KEY；请配置后重启服务，再执行「扫描/重建索引」。",
    )
  } else {
    console.log("\n[2] 试调用 embedText（需网络可达 baseURL）")
    try {
      const vec = await embedText("nas-rag-app 自检短句")
      if (vec?.length) {
        console.log(`    ✓ 成功，向量维度: ${vec.length}`)
      } else {
        console.log("    ⚠ 返回 null（检查模型名与兼容接口是否返回 embedding）")
      }
    } catch (e) {
      console.log(`    ✗ 失败: ${e instanceof Error ? e.message : String(e)}`)
      console.log("    配置好额度/URL 后重试；临时可设 ENABLE_VECTOR_SEARCH=false。")
      if (String(e).includes("429")) {
        console.log("    若为限流：全量扫描前可在 .env 设 EMBED_CONCURRENCY=1（默认 4）降低并发。")
      }
    }
  }

  console.log("\n[3] 本地索引 store")
  const store = await loadStore()
  console.log(`    rootPath: ${store.rootPath || "（未设置，需在 UI 配置 NAS 根路径）"}`)
  console.log(`    files: ${store.files.length}  chunks: ${store.chunks.length}`)
  const withEmb = store.chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
  const dims = new Set(withEmb.map((c) => c.embedding!.length))
  console.log(`    含向量的 chunk: ${withEmb.length}  向量维度集合: ${[...dims].join(", ") || "（无）"}`)
  if (emb.enabled && emb.apiKey && withEmb.length === 0 && store.chunks.length > 0) {
    console.log("    ⚠ 有 chunk 但无 embedding：请在管理端对目录「重建索引」或单文件重建。")
  }

  console.log("\n[4] MinerU 产物路径校验")
  const bad = resolveArtifactFile("00", "../x")
  console.log(`    resolveArtifactFile(非法参数): ${bad === null ? "null（预期）" : "异常"}`)

  console.log("\n[5] MinerU / Hub 提示")
  console.log("    本机 MinerU 需能访问模型：可设 HF_ENDPOINT=https://hf-mirror.com")
  console.log("    子进程已继承当前 shell 环境变量（含 HF_ENDPOINT）。")

  console.log("\n=== 结束 ===")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
