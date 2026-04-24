import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

/** MinerU 解析产物根目录（相对进程 cwd），用于图表持久化与语义检索 */
export function mineruArtifactsRoot(): string {
  return path.join(process.cwd(), "data", "mineru-artifacts")
}

export function mineruArtifactDigest(absPath: string, mtimeMs: number, size: number): string {
  const h = crypto.createHash("sha256")
  h.update(path.resolve(absPath), "utf8")
  h.update("\0")
  h.update(String(mtimeMs))
  h.update("\0")
  h.update(String(size))
  return h.digest("hex").slice(0, 40)
}

/** 防止 digest / rel 穿越目录 */
export function isSafeArtifactRel(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").trim()
  if (!n || n.includes("..")) return false
  if (path.isAbsolute(n)) return false
  return true
}

export function resolveArtifactFile(digest: string, rel: string): string | null {
  if (!/^[a-f0-9]{40}$/i.test(digest)) return null
  if (!isSafeArtifactRel(rel)) return null
  const root = path.normalize(path.join(mineruArtifactsRoot(), digest))
  const full = path.normalize(path.join(root, rel))
  const rootPref = root.endsWith(path.sep) ? root : root + path.sep
  if (full !== root && !full.startsWith(rootPref)) return null
  return full
}
