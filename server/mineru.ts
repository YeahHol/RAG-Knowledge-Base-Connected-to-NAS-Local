import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { mineruArtifactDigest, mineruArtifactsRoot, isSafeArtifactRel } from "./mineru-artifacts.js"

function persistMinerUArtifacts(): boolean {
  return String(process.env.MINERU_PERSIST_ARTIFACTS ?? "true").trim().toLowerCase() !== "false"
}

function mineruEnabled() {
  return String(process.env.MINERU_ENABLED ?? "").trim().toLowerCase() === "true"
}

/** 为 true 时 `tryMinerUExtract` 才会调本机 `mineru` CLI；否则立即返回 null，不会执行 MinerU。 */
export function isMinerUEnabled(): boolean {
  return mineruEnabled()
}

function mineruTimeoutMs() {
  const n = Number(process.env.MINERU_TIMEOUT_MS ?? 600_000)
  if (!Number.isFinite(n) || n < 10_000) return 600_000
  return Math.min(3_600_000, Math.floor(n))
}

function runMinerU(cli: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      /** 继承 HF_ENDPOINT 等，避免子进程拉 Hub 时丢镜像环境 */
      env: process.env,
    })
    let stderr = ""
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8")
    })
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        /* ignore */
      }
      reject(new Error(`mineru 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(t)
      resolve({ code, stderr })
    })
    child.on("error", (err) => {
      clearTimeout(t)
      reject(err)
    })
  })
}

async function collectMarkdownFromDir(dir: string, stem: string): Promise<string | null> {
  const hit = await findMinerMarkdownInWorkdir(dir, stem)
  return hit?.text ?? null
}

/** 定位 MinerU 输出的主 Markdown 路径与正文（用于落盘图表与改写链接） */
async function findMinerMarkdownInWorkdir(
  dir: string,
  stem: string,
): Promise<{ mdPath: string; text: string } | null> {
  const tryRead = async (p: string) => {
    try {
      const s = await fs.readFile(p, "utf-8")
      return s.trim() ? s : null
    } catch {
      return null
    }
  }

  const direct = path.join(dir, `${stem}.md`)
  const a = await tryRead(direct)
  if (a) return { mdPath: direct, text: a }

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const mdTop = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .filter((n) => !/_layout\.md$/i.test(n))
    .sort()
  for (const name of mdTop) {
    const p = path.join(dir, name)
    const s = await tryRead(p)
    if (s) return { mdPath: p, text: s }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name)
    const pStem = path.join(sub, `${stem}.md`)
    const b = await tryRead(pStem)
    if (b) return { mdPath: pStem, text: b }
    const subEntries = await fs.readdir(sub, { withFileTypes: true }).catch(() => [])
    for (const f of subEntries) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".md")) continue
      if (/_layout\.md$/i.test(f.name)) continue
      const p = path.join(sub, f.name)
      const s = await tryRead(p)
      if (s) return { mdPath: p, text: s }
    }
  }

  return null
}

/**
 * 将 Markdown 中的本地图片改为 `/api/mineru-artifact`，并在每张图前注入 [MINERU_FIGURE] + 空 [FigureOCR]（由 extract 填 OCR）。
 * `rel` 为相对于 `artifactRoot`（即 `data/mineru-artifacts/<digest>`）的路径。
 */
function injectMinerUFigureMarkers(md: string, mdAbsInArtifact: string, artifactRoot: string, digest: string): string {
  const mdDir = path.dirname(mdAbsInArtifact)
  const workRoot = path.resolve(artifactRoot)
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  const parts: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(md)) !== null) {
    parts.push(md.slice(last, m.index))
    last = m.index + m[0].length
    const alt = m[1] ?? ""
    let href = String(m[2] ?? "").trim()
    if (/^https?:\/\//i.test(href) || href.startsWith("/api/mineru-artifact")) {
      parts.push(m[0])
      continue
    }
    href = (href.split("#")[0] ?? href).trim()
    try {
      href = decodeURIComponent(href)
    } catch {
      /* keep href */
    }
    const absImg = path.resolve(mdDir, href)
    const normImg = path.normalize(absImg)
    const base = workRoot.endsWith(path.sep) ? workRoot : workRoot + path.sep
    if (normImg !== workRoot && !normImg.startsWith(base)) {
      parts.push(m[0])
      continue
    }
    const rel = path.relative(artifactRoot, absImg).replace(/\\/g, "/")
    if (!isSafeArtifactRel(rel)) {
      parts.push(m[0])
      continue
    }
    const marker = `[MINERU_FIGURE digest=${digest} rel=${rel}]\n[FigureOCR]\n\n`
    const url = `/api/mineru-artifact?digest=${encodeURIComponent(digest)}&rel=${encodeURIComponent(rel)}`
    parts.push(`${marker}![${alt}](${url})`)
  }
  parts.push(md.slice(last))
  return parts.join("")
}

/**
 * 使用 MinerU CLI（`mineru -p <文件> -o <目录>`）生成 Markdown。
 * 需本机已安装 MinerU，且 `mineru` 在 PATH 中或通过 MINERU_CLI 指定。
 * 文档：https://opendatalab.github.io/MinerU/usage/cli_tools/
 */
export async function tryMinerUExtract(absPath: string): Promise<string | null> {
  if (!mineruEnabled()) return null

  const cli = String(process.env.MINERU_CLI ?? "mineru").trim() || "mineru"
  const stem = path.basename(absPath).replace(/\.[^.]+$/, "")
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-rag-mineru-"))

  try {
    const args: string[] = ["-p", absPath, "-o", workDir]
    const apiUrl = String(process.env.MINERU_API_URL ?? "").trim()
    if (apiUrl) {
      args.push("--api-url", apiUrl)
    }
    const method = String(process.env.MINERU_METHOD ?? "auto").trim().toLowerCase()
    if (method === "auto" || method === "txt" || method === "ocr") {
      args.push("-m", method)
    }
    const backend = String(process.env.MINERU_BACKEND ?? "").trim()
    if (backend) {
      args.push("-b", backend)
    }
    const lang = String(process.env.MINERU_LANG ?? "").trim()
    if (lang) {
      args.push("-l", lang)
    }

    const timeoutMs = mineruTimeoutMs()
    const { code, stderr } = await runMinerU(cli, args, timeoutMs)
    if (code !== 0) {
      const tail = stderr.trim().slice(-800)
      console.warn(`[mineru] 退出码 ${code}${tail ? `: ${tail}` : ""}`)
      return null
    }

    const hit = await findMinerMarkdownInWorkdir(workDir, stem)
    if (!hit?.text.trim()) {
      console.warn(`[mineru] 未在输出目录找到 Markdown：${workDir}`)
      return null
    }

    let body = hit.text.trim()
    let header = `[MinerU ${path.basename(absPath)}]`

    if (persistMinerUArtifacts()) {
      const st = await fs.stat(absPath).catch(() => null)
      if (st) {
        const digest = mineruArtifactDigest(absPath, st.mtimeMs, st.size)
        const artifactBase = path.join(mineruArtifactsRoot(), digest)
        try {
          await fs.rm(artifactBase, { recursive: true, force: true })
          await fs.mkdir(artifactBase, { recursive: true })
          const top = await fs.readdir(workDir, { withFileTypes: true })
          for (const e of top) {
            await fs.cp(path.join(workDir, e.name), path.join(artifactBase, e.name), { recursive: true })
          }
          const mdUnderArtifact = path.join(artifactBase, path.relative(workDir, hit.mdPath))
          body = injectMinerUFigureMarkers(hit.text, mdUnderArtifact, artifactBase, digest)
          header = `[MinerU ${path.basename(absPath)} digest=${digest}]`
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[mineru] 落盘图表产物失败，退回纯 Markdown：${msg}`)
        }
      }
    }

    return `${header}\n\n${body.trim()}`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[mineru] ${msg}`)
    return null
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
