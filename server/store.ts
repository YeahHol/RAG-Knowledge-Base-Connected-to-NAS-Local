import fs from "node:fs/promises"
import path from "node:path"

export interface StoredFile {
  id: string
  /** 绝对路径（NAS UNC 或映射盘） */
  absPath: string
  relPath: string
  mtime: number
  size: number
  status: "pending" | "indexed" | "error" | "skipped"
  error?: string
}

export interface StoredChunk {
  id: string
  fileId: string
  /** 展示用短标题 */
  title: string
  content: string
  chunkIndex: number
  embedding?: number[]
}

export interface StoreShape {
  rootPath: string
  updatedAt: string
  files: StoredFile[]
  chunks: StoredChunk[]
}

const DATA_DIR = path.join(process.cwd(), "data")
const STORE_FILE = path.join(DATA_DIR, "store.json")

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

export async function loadStore(): Promise<StoreShape> {
  await ensureDataDir()
  try {
    const raw = await fs.readFile(STORE_FILE, "utf-8")
    return JSON.parse(raw) as StoreShape
  } catch {
    return { rootPath: "", updatedAt: new Date().toISOString(), files: [], chunks: [] }
  }
}

export async function saveStore(store: StoreShape) {
  await ensureDataDir()
  store.updatedAt = new Date().toISOString()
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf-8")
}
