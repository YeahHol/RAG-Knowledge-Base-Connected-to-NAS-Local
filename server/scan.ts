import fs from "node:fs/promises"
import path from "node:path"
import { v4 as uuid } from "uuid"
import type { StoreShape, StoredChunk, StoredFile } from "./store"
import { loadStore, saveStore } from "./store"
import { chunkText, extractText, isSupportedExt } from "./extract"
import { embedText } from "./embeddings"
import { walkFiles } from "./walk"

const MAX_FILE_BYTES = 40 * 1024 * 1024 // 40MB

export interface ScanProgress {
  phase: "listing" | "extracting" | "done" | "error"
  message: string
  filesDone: number
  filesTotal: number
}

let lastProgress: ScanProgress = { phase: "done", message: "", filesDone: 0, filesTotal: 0 }

export function getScanProgress() {
  return lastProgress
}

async function processOneFile(
  normalizedRoot: string,
  abs: string,
): Promise<{ file: StoredFile; chunks: StoredChunk[] }> {
  const rel = path.relative(normalizedRoot, abs)
  const st = await fs.stat(abs)
  const id = uuid()

  if (st.size > MAX_FILE_BYTES) {
    return {
      file: {
        id,
        absPath: abs,
        relPath: rel,
        mtime: st.mtimeMs,
        size: st.size,
        status: "skipped",
        error: "超过大小上限，已跳过",
      },
      chunks: [],
    }
  }

  try {
    const text = await extractText(abs)
    const parts = chunkText(text)
    if (parts.length === 0) {
      return {
        file: {
          id,
          absPath: abs,
          relPath: rel,
          mtime: st.mtimeMs,
          size: st.size,
          status: "skipped",
          error: "无文本内容",
        },
        chunks: [],
      }
    }
    return {
      file: {
        id,
        absPath: abs,
        relPath: rel,
        mtime: st.mtimeMs,
        size: st.size,
        status: "indexed",
      },
      chunks: parts.map((content, chunkIndex) => ({
        id: uuid(),
        fileId: id,
        title: `${rel} #${chunkIndex + 1}`,
        content,
        chunkIndex,
      })),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      file: {
        id,
        absPath: abs,
        relPath: rel,
        mtime: st.mtimeMs,
        size: st.size,
        status: "error",
        error: msg,
      },
      chunks: [],
    }
  }
}

function embedConcurrency() {
  const n = Number(process.env.EMBED_CONCURRENCY ?? 4)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(16, Math.floor(n))
}

/** 同一文件内多个 chunk 的向量原先逐个请求 API，大目录会非常慢；这里做有界并发。 */
async function enrichChunksWithEmbeddings(chunks: StoredChunk[]) {
  if (chunks.length === 0) return
  const limit = embedConcurrency()
  if (limit === 1) {
    for (const c of chunks) {
      try {
        c.embedding = await embedText(`${c.title}\n${c.content}`)
      } catch {
        c.embedding = undefined
      }
    }
    return
  }

  let next = 0
  const run = async () => {
    while (true) {
      const i = next++
      if (i >= chunks.length) return
      const c = chunks[i]!
      try {
        c.embedding = await embedText(`${c.title}\n${c.content}`)
      } catch {
        c.embedding = undefined
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, chunks.length) }, () => run())
  await Promise.all(workers)
}

export async function runScan(rootPath: string, scopeRelPath = ""): Promise<StoreShape> {
  const normalized = path.normalize(rootPath.trim())
  const scopeAbs = path.resolve(normalized, scopeRelPath || ".")
  try {
    await fs.access(scopeAbs)
  } catch {
    lastProgress = { phase: "error", message: `无法访问路径: ${scopeAbs}`, filesDone: 0, filesTotal: 0 }
    throw new Error(lastProgress.message)
  }

  lastProgress = { phase: "listing", message: "列举文件中…", filesDone: 0, filesTotal: 0 }
  const all = await walkFiles(scopeAbs)
  const candidates = all.filter(isSupportedExt)

  const files: StoredFile[] = []
  const chunks: StoredChunk[] = []

  lastProgress = {
    phase: "extracting",
    message: "抽取与分块中…",
    filesDone: 0,
    filesTotal: candidates.length,
  }

  let done = 0
  for (const abs of candidates) {
    try {
      const { file, chunks: nextChunks } = await processOneFile(normalized, abs)
      await enrichChunksWithEmbeddings(nextChunks)
      files.push(file)
      chunks.push(...nextChunks)
    } catch {
      done++
      lastProgress = { ...lastProgress, filesDone: done }
      continue
    }
    done++
    lastProgress = { ...lastProgress, filesDone: done }
  }

  const prev = await loadStore()
  const prefix = path.relative(normalized, scopeAbs)
  const normalizedPrefix = prefix ? `${prefix}${path.sep}` : ""
  const scopeFileIds = new Set(
    prev.files
      .filter((f) => (normalizedPrefix ? f.relPath.startsWith(normalizedPrefix) : true))
      .map((f) => f.id),
  )

  const keptFiles = prev.files.filter((f) =>
    normalizedPrefix ? !f.relPath.startsWith(normalizedPrefix) : false,
  )
  const keptChunks = prev.chunks.filter((c) => !scopeFileIds.has(c.fileId))

  const store: StoreShape = {
    rootPath: normalized,
    updatedAt: new Date().toISOString(),
    files: normalizedPrefix ? [...keptFiles, ...files] : files,
    chunks: normalizedPrefix ? [...keptChunks, ...chunks] : chunks,
  }
  await saveStore(store)
  lastProgress = { phase: "done", message: "完成", filesDone: done, filesTotal: candidates.length }
  return store
}

export async function reindexSingleFile(rootPath: string, relPath: string): Promise<StoreShape> {
  const normalized = path.normalize(rootPath.trim())
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(normalized, normalizedRel)

  if (!abs.startsWith(path.resolve(normalized))) {
    throw new Error("非法路径：超出根目录范围")
  }

  const prev = await loadStore()
  const old = prev.files.find((f) => f.relPath.replace(/\\/g, "/") === normalizedRel)
  const oldId = old?.id

  let nextFile: StoredFile
  let nextChunks: StoredChunk[] = []
  if (!isSupportedExt(abs)) {
    const st = await fs.stat(abs)
    nextFile = {
      id: uuid(),
      absPath: abs,
      relPath: path.relative(normalized, abs),
      mtime: st.mtimeMs,
      size: st.size,
      status: "skipped",
      error: "暂不支持该格式",
    }
  } else {
    const processed = await processOneFile(normalized, abs)
    nextFile = processed.file
    nextChunks = processed.chunks
    await enrichChunksWithEmbeddings(nextChunks)
  }

  const files = prev.files.filter((f) => f.relPath.replace(/\\/g, "/") !== normalizedRel)
  files.push(nextFile)
  const chunks = prev.chunks.filter((c) => (oldId ? c.fileId !== oldId : true))
  chunks.push(...nextChunks)

  const store: StoreShape = {
    rootPath: normalized,
    updatedAt: new Date().toISOString(),
    files,
    chunks,
  }
  await saveStore(store)
  return store
}
