/**
 * 离线评估检索「召回」：与线上一致走 embedText + searchChunks。
 *
 * 用法（在 nas-rag-app 根目录）：
 *   npx tsx scripts/eval-recall.ts
 *   npx tsx scripts/eval-recall.ts path/to/eval.json
 *
 * 标注 JSON 格式见同目录 eval-recall.sample.json。
 * relevantRelPaths 需与索引里文件的 relPath 一致（可在「文件管理」点文件看路径，或查 data/store.json）。
 */
import "dotenv/config"
import path from "node:path"
import fs from "node:fs/promises"

import { embedText } from "../server/embeddings"
import { searchChunks } from "../server/search"
import { loadStore } from "../server/store"

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").trim()
}

function relMatchesGold(hitRel: string, gold: string): boolean {
  const h = normRel(hitRel)
  const g = normRel(gold)
  if (!h || !g) return false
  if (h === g) return true
  if (h.endsWith("/" + g) || g.endsWith("/" + h)) return true
  const hb = path.basename(h)
  const gb = path.basename(g)
  if (hb === gb) return true
  if (h.includes(g) || g.includes(h)) return true
  return false
}

type EvalCase = {
  query: string
  /** 与 store 中 files[].relPath 一致（正斜杠）；任一条在 Top-K 中出现即算该条「被召回」 */
  relevantRelPaths: string[]
}

type EvalFile = {
  k?: number
  cases: EvalCase[]
}

async function main() {
  const argv = process.argv.slice(2)
  const defaultPath = path.join(process.cwd(), "scripts", "eval-recall.sample.json")
  const jsonPath = path.resolve(argv[0] || defaultPath)

  const raw = await fs.readFile(jsonPath, "utf-8")
  const suite = JSON.parse(raw) as EvalFile
  const k = Math.max(1, Math.min(100, Number(suite.k ?? 12) || 12))
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    console.error("eval JSON 需包含非空 cases 数组")
    process.exit(1)
  }

  const store = await loadStore()
  const fileById = new Map(store.files.map((f) => [f.id, f]))
  const fileRelByChunkId = new Map(store.files.map((f) => [f.id, f.relPath.replace(/\\/g, "/")]))

  let sumRecall = 0
  let sumRr = 0
  let nRr = 0

  console.log(`数据集: ${jsonPath}`)
  console.log(`Store: ${store.chunks.length} chunks, k=${k}\n`)

  for (let i = 0; i < suite.cases.length; i++) {
    const c = suite.cases[i]!
    const gold = (c.relevantRelPaths ?? []).map(normRel).filter(Boolean)
    if (gold.length === 0) {
      console.log(`[case ${i + 1}] 跳过：无 relevantRelPaths`)
      continue
    }

    let queryEmbedding: number[] | null = null
    try {
      queryEmbedding = await embedText(c.query)
    } catch {
      queryEmbedding = null
    }
    const hits = searchChunks(store.chunks, c.query, k, queryEmbedding, { fileRelByChunkId })

    let found = 0
    const missed: string[] = []
    for (const g of gold) {
      const ok = hits.some((h) => {
        const rel = fileById.get(h.chunk.fileId)?.relPath ?? ""
        return relMatchesGold(rel, g)
      })
      if (ok) found++
      else missed.push(g)
    }
    const recall = found / gold.length
    sumRecall += recall

    let firstRank = 0
    for (let r = 0; r < hits.length; r++) {
      const rel = fileById.get(hits[r]!.chunk.fileId)?.relPath ?? ""
      if (gold.some((g) => relMatchesGold(rel, g))) {
        firstRank = r + 1
        break
      }
    }
    if (firstRank > 0) {
      sumRr += 1 / firstRank
      nRr++
    }

    console.log(`--- case ${i + 1} ---`)
    console.log(`Q: ${c.query}`)
    console.log(`recall@${k} (按相关文件是否出现在 Top-K): ${(recall * 100).toFixed(1)}% (${found}/${gold.length})`)
    if (missed.length) console.log(`未覆盖的金标路径: ${missed.join(" | ")}`)
    console.log(
      `Top-${Math.min(5, hits.length)}:` +
        (hits.length
          ? hits
              .slice(0, 5)
              .map((h, j) => `\n  ${j + 1}. ${h.chunk.title.slice(0, 72)}… (${Math.round(h.score)})`)
              .join("")
          : " （无命中）"),
    )
    console.log("")
  }

  const n = suite.cases.filter((c) => (c.relevantRelPaths ?? []).length > 0).length || 1
  console.log(`=== 汇总 ===`)
  console.log(`平均 recall@${k}（按 case 算术平均）: ${((sumRecall / n) * 100).toFixed(1)}%`)
  if (nRr > 0) console.log(`MRR（仅统计「至少命中一条金标」的 case）: ${(sumRr / nRr).toFixed(3)}（n=${nRr}）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
