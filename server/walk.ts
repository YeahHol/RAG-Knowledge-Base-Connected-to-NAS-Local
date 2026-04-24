import fs from "node:fs/promises"
import path from "node:path"

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
])

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string) {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        await walk(full)
      } else if (ent.isFile()) {
        out.push(full)
      }
    }
  }

  await walk(root)
  return out
}

export interface DirNode {
  name: string
  absPath: string
  relPath: string
  hasChildren: boolean
}

export interface FileNode {
  name: string
  absPath: string
  relPath: string
  size: number
  mtime: number
  ext: string
}

/**
 * 仅列出某目录下一层内容，便于前端做可交互文件管理。
 */
export async function listDirectory(root: string, relDir: string): Promise<{
  dirs: DirNode[]
  files: FileNode[]
}> {
  const base = path.resolve(root)
  const target = path.resolve(base, relDir || ".")
  if (!target.startsWith(base)) {
    throw new Error("非法路径：超出根目录范围")
  }

  const entries = await fs.readdir(target, { withFileTypes: true })
  const dirs: DirNode[] = []
  const files: FileNode[] = []

  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue
    const absPath = path.join(target, ent.name)
    const relPath = path.relative(base, absPath)
    if (ent.isDirectory()) {
      let hasChildren = false
      try {
        const sub = await fs.readdir(absPath)
        hasChildren = sub.length > 0
      } catch {
        hasChildren = false
      }
      dirs.push({ name: ent.name, absPath, relPath, hasChildren })
    } else if (ent.isFile()) {
      const st = await fs.stat(absPath)
      files.push({
        name: ent.name,
        absPath,
        relPath,
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(ent.name).toLowerCase(),
      })
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  return { dirs, files }
}
