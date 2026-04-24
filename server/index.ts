import "dotenv/config"
import "./node-pdf-polyfill"
import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import os from "node:os"
import { spawn } from "node:child_process"
import cors from "cors"
import express from "express"
import { isMinerUEnabled } from "./mineru"
import { resolveArtifactFile } from "./mineru-artifacts.js"
import { loadStore, saveStore } from "./store"
import { runScan, getScanProgress, reindexSingleFile } from "./scan"
import {
  buildLlmRagContext,
  estimateChatInputTokens,
  searchChunks,
  wikiLayerPrefixes,
  type SearchHit,
} from "./search"
import { chatCompletion } from "./chat"
import { runMapReduceChat } from "./map-reduce-rag"
import { buildWikiPages, writeWikiPages } from "./wiki-builder"
import { embedText, getEmbeddingConfig } from "./embeddings"
import {
  appendChatHistory,
  clearChatHistory,
  createConversation,
  loadChatHistory,
  loadConversations,
  removeChatHistoryItem,
  removeConversation,
} from "./chat-history"
import { listDirectory } from "./walk"
import { setupFeishuWebhook } from "./feishu-webhook"
import {
  buildPptxPreviewSlides,
  getPdfPageVisualMeta,
  renderPdfPageVisual,
  buildXlsxPreviewSheets,
  chunkText,
  extractText,
  isRasterImagePath,
  isSupportedExt,
} from "./extract"

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: "2mb" }))

const PORT = Number(process.env.PORT) || 8787
const SEARCH_DEBUG =
  String(process.env.SEARCH_DEBUG ?? "").trim().toLowerCase() === "true" ||
  String(process.env.NODE_ENV ?? "").trim().toLowerCase() !== "production"

function debugQueryTerms(input: string): string[] {
  const lower = input.toLowerCase()
  const terms = lower.match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9._-]{1,}/gu) ?? []
  return Array.from(new Set(terms)).slice(0, 10)
}

function buildSearchDebugPayload(
  query: string,
  hits: SearchHit[],
  fileById: Map<string, { relPath: string }>,
  usedVector: boolean,
  vectorError = "",
) {
  if (!SEARCH_DEBUG) return undefined
  const terms = debugQueryTerms(query)
  return {
    usedVector,
    vectorError,
    terms,
    top: hits.slice(0, 10).map((h, i) => {
      const titleLower = h.chunk.title.toLowerCase()
      const matchedTerms = terms.filter((t) => titleLower.includes(t))
      return {
        rank: i + 1,
        score: Math.round(h.score),
        title: h.chunk.title,
        relPath: fileById.get(h.chunk.fileId)?.relPath ?? "",
        matchedTerms,
      }
    }),
  }
}

type NasSession = {
  token: string
  sid: string
  baseUrl: string
  username: string
  createdAt: number
}
const nasSessions = new Map<string, NasSession>()

function normalizeNasBaseUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(s)) throw new Error("NAS 地址需以 http:// 或 https:// 开头")
  return s
}

function nasAuthErrorMessage(code: number | undefined): string {
  if (code === 400) return "NAS 认证失败：账号或密码错误（code=400）"
  if (code === 401) return "NAS 认证失败：账号被停用（code=401）"
  if (code === 402) return "NAS 认证失败：账号无权限使用该服务（code=402）"
  if (code === 403) return "NAS 认证失败：需要二步验证码（code=403）"
  if (code === 404) return "NAS 认证失败：二步验证码错误（code=404）"
  if (code === 406) return "NAS 认证失败：需要 OTP 验证（code=406）"
  if (code === 407) return "NAS 认证失败：IP 已被封锁（code=407）"
  return `NAS 认证失败（code=${code ?? "unknown"}）`
}

async function synoEntry(
  sess: NasSession,
  params: Record<string, string | number | undefined>,
): Promise<unknown> {
  const qp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue
    qp.set(k, String(v))
  }
  qp.set("_sid", sess.sid)
  const url = `${sess.baseUrl}/webapi/entry.cgi?${qp.toString()}`
  const r = await fetch(url)
  const t = await r.text()
  if (!r.ok) throw new Error(`NAS 请求失败 HTTP ${r.status}: ${t.slice(0, 200)}`)
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    throw new Error(`NAS 返回非 JSON: ${t.slice(0, 200)}`)
  }
  const ok = (j as { success?: boolean })?.success
  if (!ok) {
    const code = (j as { error?: { code?: number } })?.error?.code
    throw new Error(`NAS API 调用失败（code=${code ?? "unknown"}）`)
  }
  return (j as { data?: unknown }).data
}

function requireNasSession(req: express.Request): NasSession {
  const token = String(req.header("x-nas-token") ?? req.query.token ?? "").trim()
  if (!token) throw new Error("缺少 x-nas-token，请先登录 NAS")
  const sess = nasSessions.get(token)
  if (!sess) throw new Error("NAS 会话已失效，请重新登录")
  return sess
}

function stripHtmlToText(html: string): string {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  return [title ? `标题：${title}` : "", body].filter(Boolean).join("\n\n")
}

async function convertPptToPptx(inputFile: string, outDir: string): Promise<string> {
  const bin = String(process.env.LIBREOFFICE_BIN ?? "soffice").trim() || "soffice"
  const args = ["--headless", "--convert-to", "pptx", "--outdir", outDir, inputFile]
  const trySoffice = () =>
    new Promise<void>((resolve, reject) => {
      const cp = spawn(bin, args, { windowsHide: true })
      let errText = ""
      cp.stderr.on("data", (d) => {
        errText += String(d ?? "")
      })
      cp.on("error", (e) => reject(new Error(`调用 LibreOffice 失败：${String(e)}`)))
      cp.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`LibreOffice 转换失败（exit=${code}）${errText ? `: ${errText.slice(0, 200)}` : ""}`))
      })
    })

  const tryPowerPointComOnWindows = () =>
    new Promise<void>((resolve, reject) => {
      const psScript = `
$ErrorActionPreference = "Stop"
$in = "${inputFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
$outDir = "${outDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
$out = Join-Path $outDir ([System.IO.Path]::GetFileNameWithoutExtension($in) + ".pptx")
$pp = $null
$pres = $null
try {
  $pp = New-Object -ComObject PowerPoint.Application
  # 某些 Office 环境禁止隐藏窗口运行（Visible=0 会报 Invalid request）
  $pp.Visible = -1
  $pp.DisplayAlerts = 1
  $pres = $pp.Presentations.Open($in, $false, $true, $false)
  $ppSaveAsOpenXMLPresentation = 24
  $pres.SaveAs($out, $ppSaveAsOpenXMLPresentation)
  $pres.Close()
  $pp.Quit()
  Write-Output $out
} catch {
  if ($pres -ne $null) { try { $pres.Close() } catch {} }
  if ($pp -ne $null) { try { $pp.Quit() } catch {} }
  throw
}
`.trim()
      const cp = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], { windowsHide: true })
      let errText = ""
      cp.stderr.on("data", (d) => {
        errText += String(d ?? "")
      })
      cp.on("error", (e) => reject(new Error(`调用 PowerPoint COM 失败：${String(e)}`)))
      cp.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`PowerPoint COM 转换失败（exit=${code}）${errText ? `: ${errText.slice(0, 260)}` : ""}`))
      })
    })

  try {
    await trySoffice()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isWin = process.platform === "win32"
    const sofficeMissing = /ENOENT|not found|无法将.*soffice.*识别|不是内部或外部命令/i.test(msg)
    if (!isWin || !sofficeMissing) throw e
    await tryPowerPointComOnWindows()
  }

  const outPath = path.join(outDir, `${path.basename(inputFile, path.extname(inputFile))}.pptx`)
  await fs.access(outPath)
  return outPath
}

app.get("/api/health", (_req, res) => {
  const emb = getEmbeddingConfig()
  res.json({
    ok: true,
    service: "nas-rag-app",
    mineruEnabled: isMinerUEnabled(),
    searchDebug: SEARCH_DEBUG,
    embedding: {
      vectorSearchEnabled: emb.enabled,
      hasApiKey: Boolean(emb.apiKey),
      baseURL: emb.baseURL.replace(/\/$/, ""),
      model: emb.model,
      provider: emb.provider,
    },
    wikiLayer: {
      prefixes: wikiLayerPrefixes(),
      hint: "将整理层 Markdown 放在 NAS 根下 wiki/ 等路径后重建索引，可在检索与问答中优先利用（见仓库 wiki-seed/）",
    },
  })
})

app.post("/api/nas/login", async (req, res) => {
  const baseUrlRaw = String(req.body?.baseUrl ?? "").trim()
  const username = String(req.body?.username ?? "").trim()
  const password = String(req.body?.password ?? "")
  const otpCode = String(req.body?.otpCode ?? "").trim()
  if (!baseUrlRaw || !username || !password) {
    res.status(400).json({ error: "baseUrl / username / password 必填" })
    return
  }
  try {
    const baseUrl = normalizeNasBaseUrl(baseUrlRaw)
    const infoQp = new URLSearchParams({
      api: "SYNO.API.Info",
      version: "1",
      method: "query",
      query: "SYNO.API.Auth",
    })
    const infoUrl = `${baseUrl}/webapi/query.cgi?${infoQp.toString()}`
    const infoResp = await fetch(infoUrl)
    const infoText = await infoResp.text()
    let authPath = "entry.cgi"
    let authVersion = 7
    if (infoResp.ok) {
      try {
        const ij = JSON.parse(infoText) as {
          success?: boolean
          data?: { [k: string]: { path?: string; maxVersion?: number } }
        }
        const node = ij?.data?.["SYNO.API.Auth"]
        if (node?.path) authPath = String(node.path).replace(/^\/+/, "")
        if (Number.isFinite(node?.maxVersion)) authVersion = Math.max(1, Number(node?.maxVersion))
      } catch {
        // fallback to defaults
      }
    }

    const authParams = new URLSearchParams({
      api: "SYNO.API.Auth",
      version: String(Math.min(7, authVersion)),
      method: "login",
      account: username,
      passwd: password,
      session: "FileStation",
      format: "sid",
    })
    if (otpCode) authParams.set("otp_code", otpCode)

    const authUrl = `${baseUrl}/webapi/${authPath}?${authParams.toString()}`
    const r = await fetch(authUrl)
    const t = await r.text()
    if (!r.ok) {
      res.status(400).json({ error: `NAS 登录失败 HTTP ${r.status}: ${t.slice(0, 200)}` })
      return
    }
    let j: { success?: boolean; data?: { sid?: string }; error?: { code?: number } }
    try {
      j = JSON.parse(t) as { success?: boolean; data?: { sid?: string }; error?: { code?: number } }
    } catch {
      res.status(400).json({ error: `NAS 返回非 JSON: ${t.slice(0, 200)}` })
      return
    }
    if (!j?.success) {
      res.status(401).json({ error: nasAuthErrorMessage(j?.error?.code) })
      return
    }
    const sid = String(j?.data?.sid ?? "").trim()
    if (!sid) {
      res.status(401).json({ error: "NAS 登录失败：未返回 sid" })
      return
    }
    const token = crypto.randomUUID()
    nasSessions.set(token, { token, sid, baseUrl, username, createdAt: Date.now() })
    res.json({ ok: true, token, username, baseUrl })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.post("/api/nas/logout", async (req, res) => {
  try {
    const sess = requireNasSession(req)
    nasSessions.delete(sess.token)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.get("/api/nas/list", async (req, res) => {
  const folderPath = String(req.query.path ?? "/").trim() || "/"
  try {
    const sess = requireNasSession(req)
    const data = ((folderPath === "/" || folderPath === "")
      ? await synoEntry(sess, {
          api: "SYNO.FileStation.List",
          version: 2,
          method: "list_share",
          additional: "real_path,size,time,type",
        })
      : await synoEntry(sess, {
          api: "SYNO.FileStation.List",
          version: 2,
          method: "list",
          folder_path: folderPath,
          additional: "real_path,size,time,type",
        })) as {
      files?: Array<{
        isdir?: boolean
        name?: string
        path?: string
        additional?: { size?: number; time?: { mtime?: number }; type?: string; real_path?: string }
      }>
      shares?: Array<{
        isdir?: boolean
        name?: string
        path?: string
        additional?: { size?: number; time?: { mtime?: number }; type?: string; real_path?: string }
      }>
    }
    const entries = Array.isArray(data?.files)
      ? data.files
      : Array.isArray(data?.shares)
        ? data.shares
        : []
    const dirs = entries
      .filter((x) => !!x.isdir)
      .map((x) => ({
        name: String(x.name ?? ""),
        path: String(x.path ?? ""),
      }))
    const files = entries
      .filter((x) => !x.isdir)
      .map((x) => ({
        name: String(x.name ?? ""),
        path: String(x.path ?? ""),
        size: Number(x.additional?.size ?? 0),
        mtime: Number(x.additional?.time?.mtime ?? 0) * 1000,
        ext: path.extname(String(x.name ?? "")).toLowerCase(),
      }))
    res.json({ ok: true, currentPath: folderPath, dirs, files })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.post("/api/nas/pull", async (req, res) => {
  const remotePath = String(req.body?.path ?? "").trim()
  if (!remotePath) {
    res.status(400).json({ error: "path 必填" })
    return
  }
  try {
    const sess = requireNasSession(req)
    const qp = new URLSearchParams({
      api: "SYNO.FileStation.Download",
      version: "2",
      method: "download",
      path: remotePath,
      mode: "open",
      _sid: sess.sid,
    })
    const url = `${sess.baseUrl}/webapi/entry.cgi?${qp.toString()}`
    const r = await fetch(url)
    if (!r.ok || !r.body) {
      const t = await r.text().catch(() => "")
      res.status(400).json({ error: `NAS 下载失败 HTTP ${r.status}: ${t.slice(0, 200)}` })
      return
    }
    const baseName = path.basename(remotePath)
    const localDir = path.join(process.cwd(), "data", "nas-pull", sess.username)
    await fs.mkdir(localDir, { recursive: true })
    const target = path.join(localDir, baseName)
    const ab = Buffer.from(await r.arrayBuffer())
    await fs.writeFile(target, ab)
    res.json({ ok: true, localPath: target, fileName: baseName, size: ab.length })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.get("/api/nas/preview", async (req, res) => {
  const remotePath = String(req.query.path ?? "").trim()
  if (!remotePath) {
    res.status(400).send("path 必填")
    return
  }
  try {
    const sess = requireNasSession(req)
    const qp = new URLSearchParams({
      api: "SYNO.FileStation.Download",
      version: "2",
      method: "download",
      path: remotePath,
      mode: "open",
      _sid: sess.sid,
    })
    const url = `${sess.baseUrl}/webapi/entry.cgi?${qp.toString()}`
    const r = await fetch(url)
    if (!r.ok || !r.body) {
      const t = await r.text().catch(() => "")
      res.status(400).send(`NAS 预览失败 HTTP ${r.status}: ${t.slice(0, 200)}`)
      return
    }
    const ext = path.extname(remotePath).toLowerCase()
    const mimeByExt: Record<string, string> = {
      ".pdf": "application/pdf",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    }
    res.setHeader("Content-Type", mimeByExt[ext] ?? "application/octet-stream")
    const fileName = path.basename(remotePath)
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    res.setHeader("Cache-Control", "private, max-age=60")
    const ab = Buffer.from(await r.arrayBuffer())
    res.send(ab)
  } catch (e) {
    res.status(400).send(String(e))
  }
})

app.get("/api/nas/preview-info", async (req, res) => {
  const remotePath = String(req.query.path ?? "").trim()
  if (!remotePath) {
    res.status(400).json({ error: "path 必填" })
    return
  }
  let tempDir = ""
  try {
    const sess = requireNasSession(req)
    const qp = new URLSearchParams({
      api: "SYNO.FileStation.Download",
      version: "2",
      method: "download",
      path: remotePath,
      mode: "open",
      _sid: sess.sid,
    })
    const url = `${sess.baseUrl}/webapi/entry.cgi?${qp.toString()}`
    const r = await fetch(url)
    if (!r.ok || !r.body) {
      const t = await r.text().catch(() => "")
      res.status(400).json({ error: `NAS 预览失败 HTTP ${r.status}: ${t.slice(0, 200)}` })
      return
    }
    const ext = path.extname(remotePath).toLowerCase()
    const fileName = path.basename(remotePath)
    const ab = Buffer.from(await r.arrayBuffer())

    if ([".txt", ".md", ".json", ".csv"].includes(ext)) {
      const preview = ab.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 4000)
      res.json({ kind: "text", path: remotePath, fileName, preview: preview || "（文件可读，但无文本内容）" })
      return
    }
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
      res.json({
        kind: "image",
        path: remotePath,
        fileName,
        imageUrl: `/api/nas/preview?path=${encodeURIComponent(remotePath)}&token=${encodeURIComponent(sess.token)}`,
      })
      return
    }
    if (ext === ".pdf") {
      res.json({
        kind: "pdf",
        path: remotePath,
        fileName,
        previewUrl: `/api/nas/preview?path=${encodeURIComponent(remotePath)}&token=${encodeURIComponent(sess.token)}`,
      })
      return
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-preview-"))
    const tempFile = path.join(tempDir, fileName || `preview${ext || ".bin"}`)
    await fs.writeFile(tempFile, ab)

    if (ext === ".xlsx" || ext === ".xls") {
      const sheets = await buildXlsxPreviewSheets(tempFile)
      res.json({ kind: "excel", path: remotePath, fileName, sheets })
      return
    }
    if (ext === ".pptx") {
      const slides = await buildPptxPreviewSlides(tempFile)
      res.json({ kind: "pptx", path: remotePath, fileName, slides })
      return
    }
    if (ext === ".ppt") {
      try {
        const pptxPath = await convertPptToPptx(tempFile, tempDir)
        const slides = await buildPptxPreviewSlides(pptxPath)
        res.json({ kind: "pptx", path: remotePath, fileName, slides, convertedFrom: ".ppt" })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        res.json({
          kind: "unsupported",
          path: remotePath,
          fileName,
          preview: `该 .ppt 未能自动转换预览：${msg}。请安装 LibreOffice（soffice）并在 .env 配置 LIBREOFFICE_BIN，或改用“新标签打开/拉取后本地查看”。`,
        })
      }
      return
    }
    if (isSupportedExt(tempFile)) {
      const text = await extractText(tempFile)
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 4000)
      res.json({ kind: "text", path: remotePath, fileName, preview: preview || "（文件可读，但无文本内容）" })
      return
    }
    res.json({ kind: "unsupported", path: remotePath, fileName, preview: "该格式暂不支持站内预览，可先拉取后本地打开。" })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
})

app.post("/api/url/preview", async (req, res) => {
  const urlRaw = String(req.body?.url ?? "").trim()
  if (!urlRaw) {
    res.status(400).json({ error: "url 必填" })
    return
  }
  let u: URL
  try {
    u = new URL(urlRaw)
  } catch {
    res.status(400).json({ error: "url 格式不合法" })
    return
  }
  if (!/^https?:$/i.test(u.protocol)) {
    res.status(400).json({ error: "仅支持 http/https 链接" })
    return
  }
  try {
    const r = await fetch(u.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      },
    })
    if (!r.ok) {
      const t = await r.text().catch(() => "")
      res.status(400).json({ error: `链接读取失败 HTTP ${r.status}: ${t.slice(0, 160)}` })
      return
    }
    const ct = String(r.headers.get("content-type") ?? "").toLowerCase()
    const html = await r.text()
    const text = /html|xml/.test(ct) ? stripHtmlToText(html) : html
    const normalized = text.replace(/\s+/g, " ").trim()
    const title = normalized.match(/^标题：(.+?)\s{2,}/)?.[1]?.trim() || u.hostname
    res.json({
      ok: true,
      url: u.toString(),
      title,
      preview: normalized.slice(0, 4000) || "（未提取到正文）",
      text: normalized,
      chars: normalized.length,
      contentType: ct || "unknown",
    })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.post("/api/url/ingest", async (req, res) => {
  const urlRaw = String(req.body?.url ?? "").trim()
  const titleRaw = String(req.body?.title ?? "").trim()
  const textRaw = String(req.body?.text ?? "").trim()
  if (!urlRaw) {
    res.status(400).json({ error: "url 必填" })
    return
  }
  if (!textRaw) {
    res.status(400).json({ error: "text 必填，请先执行预览提取" })
    return
  }
  let u: URL
  try {
    u = new URL(urlRaw)
  } catch {
    res.status(400).json({ error: "url 格式不合法" })
    return
  }
  const title = titleRaw || u.hostname
  const body = textRaw.slice(0, 1_000_000)
  const parts = chunkText(body, 1800)
  if (parts.length === 0) {
    res.status(400).json({ error: "正文为空，无法入库" })
    return
  }
  const store = await loadStore()
  const existing = store.files.find((f) => f.absPath === u.toString())
  const existingId = existing?.id ?? ""
  const fileId = crypto.randomUUID()
  const rel = `url/${u.hostname}/${encodeURIComponent(title).slice(0, 80)}.md`
  const nextFile = {
    id: fileId,
    absPath: u.toString(),
    relPath: rel,
    mtime: Date.now(),
    size: body.length,
    status: "indexed" as const,
  }
  const nextChunks = []
  for (let i = 0; i < parts.length; i++) {
    const content = parts[i]!
    const chunk = {
      id: crypto.randomUUID(),
      fileId,
      title: `${title} #${i + 1}`,
      content,
      chunkIndex: i,
      embedding: undefined as number[] | undefined,
    }
    try {
      chunk.embedding = await embedText(`${chunk.title}\n${chunk.content}`) ?? undefined
    } catch {
      chunk.embedding = undefined
    }
    nextChunks.push(chunk)
  }
  store.files = [...store.files.filter((f) => f.absPath !== u.toString()), nextFile]
  store.chunks = [...store.chunks.filter((c) => (existingId ? c.fileId !== existingId : true)), ...nextChunks]
  await saveStore(store)
  res.json({
    ok: true,
    file: { relPath: rel, url: u.toString(), title },
    chunkCount: nextChunks.length,
    embeddedChunks: nextChunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).length,
  })
})

app.get("/api/store", async (_req, res) => {
  try {
    const store = await loadStore()
    res.json({
      rootPath: store.rootPath,
      updatedAt: store.updatedAt,
      fileCount: store.files.length,
      chunkCount: store.chunks.length,
      files: store.files.map((f) => ({
        id: f.id,
        relPath: f.relPath,
        status: f.status,
        error: f.error,
        size: f.size,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post("/api/config", async (req, res) => {
  const rootPath = String(req.body?.rootPath ?? "").trim()
  if (!rootPath) {
    res.status(400).json({ error: "rootPath 必填" })
    return
  }
  const store = await loadStore()
  store.rootPath = path.normalize(rootPath)
  await saveStore(store)
  res.json({ ok: true, rootPath: store.rootPath })
})

app.get("/api/scan/status", (_req, res) => {
  res.json(getScanProgress())
})

app.post("/api/scan", async (req, res) => {
  const bodyRoot = String(req.body?.rootPath ?? "").trim()
  const scopeRelPath = String(req.body?.scopeRelPath ?? "").trim()
  const store = await loadStore()
  const root = bodyRoot || store.rootPath
  if (!root) {
    res.status(400).json({ error: "请先在设置中填写 NAS 根路径，或在请求体传 rootPath" })
    return
  }
  try {
    const next = await runScan(root, scopeRelPath)
    res.json({
      ok: true,
      fileCount: next.files.length,
      chunkCount: next.chunks.length,
      progress: getScanProgress(),
    })
  } catch (e) {
    res.status(400).json({ error: String(e), progress: getScanProgress() })
  }
})

app.post("/api/wiki/build", async (req, res) => {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim()
  const baseURL = String(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim()
  const model = String(process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim()
  if (!apiKey) {
    res.status(400).json({ error: "服务端未配置 OPENAI_API_KEY，无法自动生成 Wiki" })
    return
  }
  const topicLimit = Math.max(1, Math.min(20, Number(req.body?.topicLimit ?? process.env.WIKI_BUILD_TOPIC_LIMIT ?? 6) || 6))
  const chunksPerTopic = Math.max(
    2,
    Math.min(30, Number(req.body?.chunksPerTopic ?? process.env.WIKI_BUILD_CHUNKS_PER_TOPIC ?? 12) || 12),
  )
  const maxCharsPerTopic = Math.max(
    3000,
    Math.min(80_000, Number(req.body?.maxCharsPerTopic ?? process.env.WIKI_BUILD_MAX_CHARS ?? 16_000) || 16_000),
  )

  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).json({ error: "请先配置并扫描知识库根路径，再生成 Wiki" })
    return
  }
  if (store.chunks.length === 0) {
    res.status(400).json({ error: "当前索引为空，请先执行扫描" })
    return
  }
  try {
    const built = await buildWikiPages({
      store,
      baseURL,
      apiKey,
      model,
      topicLimit,
      chunksPerTopic,
      maxCharsPerTopic,
    })
    if (built.generated.length === 0) {
      res.status(400).json({ error: "未生成任何 Wiki 页面（请检查索引内容是否可用）" })
      return
    }
    await writeWikiPages(store.rootPath, built.generated)
    await runScan(store.rootPath, "wiki")
    res.json({
      ok: true,
      generatedCount: built.generated.length,
      pages: built.generated.map((x) => ({
        title: x.title,
        relPath: x.relPath,
        sourceCount: x.sourceCount,
      })),
      reindexed: true,
    })
  } catch (e) {
    res.status(502).json({ error: String(e) })
  }
})

app.get("/api/fs/list", async (req, res) => {
  const relDir = String(req.query.path ?? "").replace(/\\/g, "/")
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).json({ error: "请先配置 NAS 根路径" })
    return
  }
  try {
    const data = await listDirectory(store.rootPath, relDir)
    const fileMeta = new Map(
      store.files.map((f) => [
        f.relPath.replace(/\\/g, "/"),
        {
          status: f.status,
          error: f.error,
          id: f.id,
        },
      ]),
    )
    const chunkCountByFileId = new Map<string, number>()
    for (const c of store.chunks) {
      chunkCountByFileId.set(c.fileId, (chunkCountByFileId.get(c.fileId) ?? 0) + 1)
    }
    res.json({
      rootPath: store.rootPath,
      currentPath: relDir,
      dirs: data.dirs.map((d) => ({
        ...d,
        relPath: d.relPath.replace(/\\/g, "/"),
      })),
      files: data.files.map((f) => {
        const normalizedRelPath = f.relPath.replace(/\\/g, "/")
        const key = normalizedRelPath
        const meta = fileMeta.get(key)
        const chunkCount = meta?.id ? (chunkCountByFileId.get(meta.id) ?? 0) : 0
        return {
          ...f,
          relPath: normalizedRelPath,
          indexStatus: meta?.status ?? "unindexed",
          indexError: meta?.error ?? null,
          chunkCount,
        }
      }),
    })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.get("/api/fs/preview", async (req, res) => {
  const relPath = String(req.query.path ?? "").trim()
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).json({ error: "请先配置 NAS 根路径" })
    return
  }
  if (!relPath) {
    res.status(400).json({ error: "path 必填" })
    return
  }

  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(store.rootPath, normalizedRel)
  if (!abs.startsWith(path.resolve(store.rootPath))) {
    res.status(400).json({ error: "非法路径：超出根目录范围" })
    return
  }

  try {
    await fs.access(abs)
    if (!isSupportedExt(abs)) {
      res.json({
        path: normalizedRel,
        kind: "text",
        preview: "该格式暂不支持在线文本预览，请下载原件查看。",
      })
      return
    }

    const ext = path.extname(abs).toLowerCase()
    if (ext === ".xlsx" || ext === ".xls") {
      const sheets = await buildXlsxPreviewSheets(abs)
      const preview =
        sheets.length > 0
          ? `共 ${sheets.length} 个工作表（表格预览，首屏为每表前若干行）`
          : "（未读取到工作表）"
      res.json({
        path: normalizedRel,
        kind: "excel",
        preview,
        sheets,
      })
      return
    }
    if (ext === ".pptx") {
      const slides = await buildPptxPreviewSlides(abs)
      const preview =
        slides.length > 0 ? `共 ${slides.length} 页（按页文本/图示摘要预览，非放映模式）` : "（未读取到幻灯片）"
      res.json({
        path: normalizedRel,
        kind: "pptx",
        preview,
        slides,
      })
      return
    }
    if (isRasterImagePath(abs)) {
      res.json({
        path: normalizedRel,
        kind: "image",
        preview: "图片预览（检索仍主要依赖文件名与 OCR 文本）",
      })
      return
    }

    const text = await extractText(abs)
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 4000)
    res.json({
      path: normalizedRel,
      kind: "text",
      preview: preview || "（文件可读，但无文本内容）",
    })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

/** 打开原始文件（浏览器新标签页）：用于“查看源文件”而不是文本预览 */
app.get("/api/fs/raw", async (req, res) => {
  const relPath = String(req.query.path ?? "").trim()
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).send("请先配置 NAS 根路径")
    return
  }
  if (!relPath) {
    res.status(400).send("path 必填")
    return
  }
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(store.rootPath, normalizedRel)
  if (!abs.startsWith(path.resolve(store.rootPath))) {
    res.status(400).send("非法路径：超出根目录范围")
    return
  }
  try {
    await fs.access(abs)
    const ext = path.extname(abs).toLowerCase()
    const mimeByExt: Record<string, string> = {
      ".pdf": "application/pdf",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
    res.setHeader("Content-Type", mimeByExt[ext] ?? "application/octet-stream")
    const fileName = path.basename(abs)
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    res.setHeader("Cache-Control", "private, max-age=60")
    res.send(await fs.readFile(abs))
  } catch (e) {
    res.status(400).send(String(e))
  }
})

/** 仅用于 UI 缩略图：在 NAS 根目录内读取 png/jpg/webp，带大小上限 */
app.get("/api/fs/image", async (req, res) => {
  const relPath = String(req.query.path ?? "").trim()
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).send("请先配置 NAS 根路径")
    return
  }
  if (!relPath) {
    res.status(400).send("path 必填")
    return
  }

  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(store.rootPath, normalizedRel)
  if (!abs.startsWith(path.resolve(store.rootPath))) {
    res.status(400).send("非法路径")
    return
  }

  try {
    await fs.access(abs)
    if (!isRasterImagePath(abs)) {
      res.status(400).send("仅支持 png / jpg / jpeg / webp")
      return
    }
    const st = await fs.stat(abs)
    const maxMb = Math.max(1, Math.min(80, Number(process.env.FS_IMAGE_MAX_MB ?? 20) || 20))
    if (st.size > maxMb * 1024 * 1024) {
      res.status(413).send(`图片超过 ${maxMb}MB 上限`)
      return
    }
    const buf = await fs.readFile(abs)
    const ext = path.extname(abs).toLowerCase()
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
    res.setHeader("Content-Type", mime)
    res.setHeader("Cache-Control", "private, max-age=600")
    res.send(buf)
  } catch (e) {
    res.status(400).send(String(e))
  }
})

/** MinerU 持久化图表（`data/mineru-artifacts/<digest>/`），供问答插图与向量侧 OCR 文本 */
app.get("/api/mineru-artifact", async (req, res) => {
  const digest = String(req.query.digest ?? "").trim()
  const rel = String(req.query.rel ?? "").trim()
  const full = resolveArtifactFile(digest, rel)
  if (!full) {
    res.status(400).send("非法 digest 或 rel")
    return
  }
  try {
    await fs.access(full)
    const ext = path.extname(full).toLowerCase()
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/jpeg"
    res.setHeader("Content-Type", mime)
    res.setHeader("Cache-Control", "private, max-age=86400")
    res.send(await fs.readFile(full))
  } catch {
    res.status(404).send("文件不存在")
  }
})

app.get("/api/fs/pdf/page-meta", async (req, res) => {
  const relPath = String(req.query.path ?? "").trim()
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).json({ error: "请先配置 NAS 根路径" })
    return
  }
  if (!relPath) {
    res.status(400).json({ error: "path 必填" })
    return
  }
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(store.rootPath, normalizedRel)
  if (!abs.startsWith(path.resolve(store.rootPath))) {
    res.status(400).json({ error: "非法路径" })
    return
  }
  try {
    const meta = await getPdfPageVisualMeta(abs, page)
    res.json({ page, ...meta })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.get("/api/fs/pdf/page-visual", async (req, res) => {
  const relPath = String(req.query.path ?? "").trim()
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const mode = String(req.query.mode ?? "full").trim().toLowerCase() === "chart" ? "chart" : "full"
  const chartIndex = Math.max(0, Number(req.query.chartIndex ?? 0) || 0)
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).send("请先配置 NAS 根路径")
    return
  }
  if (!relPath) {
    res.status(400).send("path 必填")
    return
  }
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  const abs = path.resolve(store.rootPath, normalizedRel)
  if (!abs.startsWith(path.resolve(store.rootPath))) {
    res.status(400).send("非法路径")
    return
  }
  try {
    const png = await renderPdfPageVisual(abs, page, mode, chartIndex)
    res.setHeader("Content-Type", "image/png")
    res.setHeader("Cache-Control", "private, max-age=120")
    res.send(png)
  } catch (e) {
    res.status(400).send(String(e))
  }
})

app.post("/api/fs/reindex-file", async (req, res) => {
  const relPath = String(req.body?.path ?? "").trim()
  const store = await loadStore()
  if (!store.rootPath) {
    res.status(400).json({ error: "请先配置 NAS 根路径" })
    return
  }
  if (!relPath) {
    res.status(400).json({ error: "path 必填" })
    return
  }
  try {
    const next = await reindexSingleFile(store.rootPath, relPath)
    res.json({
      ok: true,
      fileCount: next.files.length,
      chunkCount: next.chunks.length,
    })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "")
  const store = await loadStore()
  let queryEmbedding: number[] | null = null
  try {
    queryEmbedding = await embedText(q)
  } catch {
    queryEmbedding = null
  }
  const fileRelByChunkId = new Map(store.files.map((f) => [f.id, f.relPath.replace(/\\/g, "/")]))
  const hits = searchChunks(store.chunks, q, 12, queryEmbedding, { fileRelByChunkId })
  const fileById = new Map(store.files.map((f) => [f.id, f]))
  const debug = buildSearchDebugPayload(q, hits, fileById, !!queryEmbedding)
  res.json({
    query: q,
    vectorEnabled: getEmbeddingConfig().enabled,
    usedVector: !!queryEmbedding,
    hits: hits.map((h) => ({
      id: h.chunk.id,
      title: h.chunk.title,
      snippet: h.chunk.content.slice(0, 280),
      score: Math.round(h.score),
      fileId: h.chunk.fileId,
      relPath: fileById.get(h.chunk.fileId)?.relPath ?? "",
    })),
    ...(debug ? { debug } : {}),
  })
})

app.get("/api/chat/history", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)))
    const conversationId = String(req.query.conversationId ?? "").trim()
    const items = await loadChatHistory(conversationId || undefined)
    res.json({ items: items.slice(0, limit) })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get("/api/chat/conversations", async (_req, res) => {
  try {
    const items = await loadConversations()
    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post("/api/chat/conversations", async (req, res) => {
  try {
    const title = String(req.body?.title ?? "").trim()
    const created = await createConversation(title)
    res.json({ item: created })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.delete("/api/chat/conversations/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim()
    if (!id) {
      res.status(400).json({ error: "id 必填" })
      return
    }
    const ok = await removeConversation(id)
    if (!ok) {
      res.status(404).json({ error: "会话不存在" })
      return
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.delete("/api/chat/history/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim()
    const conversationId = String(req.query.conversationId ?? "").trim()
    if (!id) {
      res.status(400).json({ error: "id 必填" })
      return
    }
    const ok = await removeChatHistoryItem(id, conversationId || undefined)
    if (!ok) {
      res.status(404).json({ error: "记录不存在" })
      return
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.delete("/api/chat/history", async (_req, res) => {
  try {
    const conversationId = String(_req.query.conversationId ?? "").trim()
    await clearChatHistory(conversationId || undefined)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.question ?? "").trim()
  const conversationId = String(req.body?.conversationId ?? "").trim()
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim()
  const baseURL = String(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim()
  const model = String(process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim()

  if (!question) {
    res.status(400).json({ error: "question 必填" })
    return
  }
  if (!conversationId) {
    res.status(400).json({ error: "conversationId 必填" })
    return
  }
  if (!apiKey) {
    res.status(400).json({ error: "服务端未配置 OPENAI_API_KEY，请先在 .env 中设置" })
    return
  }

  const store = await loadStore()
  const fileRelByChunkId = new Map(store.files.map((f) => [f.id, f.relPath.replace(/\\/g, "/")]))
  let queryEmbedding: number[] | null = null
  let vectorError = ""
  try {
    queryEmbedding = await embedText(question)
  } catch (e) {
    queryEmbedding = null
    vectorError = e instanceof Error ? e.message : String(e)
    console.warn("[vector] query embedding failed:", vectorError)
  }
  const mapReduce = String(process.env.CHAT_MAP_REDUCE ?? "").trim().toLowerCase() === "true"
  const searchTopK = mapReduce
    ? Math.max(4, Number(process.env.CHAT_MAP_RETRIEVAL_TOP ?? 28) || 28)
    : Math.max(1, Number(process.env.CHAT_SEARCH_TOP_K ?? 10) || 10)
  const hits = searchChunks(store.chunks, question, searchTopK, queryEmbedding, { fileRelByChunkId })
  const fileById = new Map(store.files.map((f) => [f.id, f]))
  const normalizeForContainment = (s: string) => s.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
  const nq = normalizeForContainment(question)
  const topTitleStrongHit =
    nq.length >= 6 &&
    hits.slice(0, 6).some((h) => {
      const nt = normalizeForContainment(h.chunk.title)
      return nt.includes(nq) || nq.includes(nt)
    })
  const sectionFocused =
    /章节|章|部分|小节|这一章|本章|该章|负荷分析|专题|专门讲/.test(question) ||
    hits.slice(0, 8).some((h) => /负荷分析|章节|第.+章|第.+节|chapter/i.test(h.chunk.title))

  const systemWikiLayer = `【知识库整理层（LLM Wiki 思想）】若片段标题带有「（整理层/Wiki）」，表示路径位于 wiki/（或 WIKI_LAYER_PREFIXES 所配前缀）下的**团队维护合成页**。在不与原文矛盾时，**优先采信其对概念、流程、口径的归纳**；若与 PDF/合同/表格等原文片段在**数值、日期、责任条款**上冲突，**必须以原文为准**，用引用编号写明依据，可一句话对比说明。`

  const systemBase = `你是企业内部知识助手。请仅根据下方「检索到的片段」回答用户问题；若片段不足以回答，请明确说明并列出缺失信息类型。

回答格式要求（必须遵守）：
1) 使用中文，结构清晰。
2) 任何有事实依据的句子，都必须在句末添加引用编号，格式只能是 [1]、[2]、[3] 这种数字编号，可多条并列如 [1][3]。
3) 严禁输出 [文件名 #分块]、(来源: xxx)、【出处】等非编号引用格式。
4) 在末尾单独输出一节「参考片段」，按编号列出： [n] 片段标题。
5) 编号必须只引用已提供的检索片段，不可杜撰编号。
6) 若问题在问“财务指标/对比数据/明细清单/参数表”等，且片段里存在明显表格线索（如列名、行项、[Columns]、[Row]），优先输出 Markdown 表格；无法完整还原时，至少输出“字段-数值”二维表。

${systemWikiLayer}`
  const systemSectionExtra =
    "8) 若用户在问某一章/某专题（如“负荷分析”），先给“本章总结”（3-6 条），再给“关键表格”（Markdown 表格），再给“图表要点”（按 图/表 编号列出：图表名称、核心结论、对应数值/趋势）；若图表原图无法直接读取，必须明确写“基于文本提及的图表线索总结”。"
  const systemDirectHitExtra =
    "6) 若检索片段标题已与问题主体高度一致（同名项目/公司/地点），必须优先依据这些片段直接作答，不要笼统回复“资料未直接提及”。"
  const systemMapExtra =
    "7) 另有一份「要点汇总」仅供梳理线索；凡写入正文、需要出处的事实句，其句末引用编号 [n] 必须且只能对应下方「检索到的原文片段」中的编号，不要对要点汇总编引用编号。"
  const system = topTitleStrongHit
    ? mapReduce
      ? `${systemBase}\n${systemDirectHitExtra}\n${systemMapExtra}${sectionFocused ? `\n${systemSectionExtra}` : ""}`
      : `${systemBase}\n${systemDirectHitExtra}${sectionFocused ? `\n${systemSectionExtra}` : ""}`
    : mapReduce
      ? `${systemBase}\n${systemMapExtra}${sectionFocused ? `\n${systemSectionExtra}` : ""}`
      : `${systemBase}${sectionFocused ? `\n${systemSectionExtra}` : ""}`

  const maxHistoryTurns = Math.max(0, Math.min(20, Number(process.env.CHAT_MAX_HISTORY_TURNS ?? 6) || 6))
  const historyItems = await loadChatHistory(conversationId)
  const contextTurns = historyItems
    .slice(0, maxHistoryTurns)
    .reverse()
    .map((x) => ({
      question: x.question.trim().slice(0, 600),
      answer: x.answer.trim().slice(0, 1200),
    }))
    .filter((x) => x.question && x.answer)
  const historyPrefix =
    contextTurns.length > 0
      ? `历史对话（用于延续上下文，优先级低于检索片段）：\n${contextTurns
          .map((x, i) => `Q${i + 1}: ${x.question}\nA${i + 1}: ${x.answer}`)
          .join("\n\n")}\n\n---\n\n`
      : ""
  const userPrefix = `${historyPrefix}当前用户问题：\n${question}\n\n---\n\n检索到的片段：\n`
  const maxInputTokens = Math.max(2048, Number(process.env.CHAT_MODEL_MAX_INPUT_TOKENS ?? 8192) || 8192)
  const safetyTokens = Math.max(64, Number(process.env.CHAT_PROMPT_SAFETY_TOKENS ?? 384) || 384)
  const reserved = estimateChatInputTokens(system) + estimateChatInputTokens(userPrefix) + safetyTokens
  const contextTokenBudget = Math.max(256, maxInputTokens - reserved)
  const contextCharSlack = Math.min(1.35, Math.max(0.85, Number(process.env.CHAT_RAG_CHAR_SLACK ?? 1.2) || 1.2))
  const maxContextChars = Math.floor(contextTokenBudget * contextCharSlack)
  const maxCharsPerChunk = Math.max(400, Math.min(2000, Number(process.env.CHAT_RAG_CHUNK_CHARS ?? 1400) || 1400))
  const effectiveMaxCharsPerChunk = sectionFocused ? Math.max(maxCharsPerChunk, 2400) : maxCharsPerChunk

  try {
    let answer: string
    let promptHits: SearchHit[]

    if (mapReduce) {
      const mr = await runMapReduceChat({
        question,
        hits,
        finalSystem: system,
        maxInputTokens,
        safetyTokens,
        contextCharSlack,
        maxCharsPerChunk: effectiveMaxCharsPerChunk,
        baseURL,
        apiKey,
        model,
        evidenceKOverride: sectionFocused ? 8 : undefined,
        batchMaxCharsOverride: sectionFocused ? 14_000 : undefined,
        perBatchChunkCapOverride: sectionFocused ? 2_400 : undefined,
        fileRelByChunkId,
      })
      answer = mr.answer
      promptHits = mr.promptHits
    } else {
      const { context, hits: ph } = buildLlmRagContext(hits, {
        maxTotalChars: maxContextChars,
        maxCharsPerChunk: effectiveMaxCharsPerChunk,
        fileRelByChunkId,
      })
      promptHits = ph
      const user = `${userPrefix}${context || "（无检索结果）"}`
      answer = await chatCompletion({ baseURL, apiKey, model, system, user })
    }

    const dedupPromptHits = (() => {
      const seen = new Set<string>()
      const out: SearchHit[] = []
      for (const h of promptHits) {
        const relPath = fileById.get(h.chunk.fileId)?.relPath ?? ""
        const key = `${relPath}::${h.chunk.chunkIndex}::${h.chunk.title}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(h)
      }
      return out
    })()
    const sources = dedupPromptHits.map((h, i) => ({
      n: i + 1,
      title: h.chunk.title,
      score: Math.round(h.score),
      relPath: fileById.get(h.chunk.fileId)?.relPath ?? "",
    }))
    const visualSources = (() => {
      type VisualRow = {
        kind: "pdf-page" | "mineru-figure"
        relPath: string
        page: number
        title: string
        imageUrl: string
        chartMetaUrl: string
        figureRel?: string
      }
      const out: VisualRow[] = []
      const seen = new Set<string>()
      const normalize = (s: string) => s.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
      const qn = normalize(question)

      const mineruOcrLine = (content: string, digest: string, rel: string): string => {
        const relEsc = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const digEsc = digest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const re = new RegExp(
          `\\[MINERU_FIGURE digest=${digEsc} rel=${relEsc}\\]\\s*\\r?\\n\\[FigureOCR\\]\\s*\\r?\\n([^\\r\\n]{1,320})`,
          "i",
        )
        const m = content.match(re)
        if (m?.[1]) return m[1].trim().slice(0, 160)
        return `MinerU 图表 · ${path.basename(rel)}`
      }

      for (let i = 0; i < dedupPromptHits.length; i++) {
        const h = dedupPromptHits[i]
        const relPath = fileById.get(h.chunk.fileId)?.relPath ?? ""
        for (const mm of h.chunk.content.matchAll(/\[MINERU_FIGURE digest=([a-f0-9]{40}) rel=([^\]\r\n]+)\]/gi)) {
          const digest = String(mm[1] ?? "").toLowerCase()
          const rel = String(mm[2] ?? "").trim()
          if (!/^[a-f0-9]{40}$/.test(digest) || !rel) continue
          const key = `m:${digest}:${rel}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            kind: "mineru-figure",
            relPath,
            page: 0,
            title: mineruOcrLine(h.chunk.content, digest, rel),
            imageUrl: `/api/mineru-artifact?digest=${encodeURIComponent(digest)}&rel=${encodeURIComponent(rel)}`,
            chartMetaUrl: "",
            figureRel: rel,
          })
          if (out.length >= 8) {
            return out.sort((a, b) => {
              const as = normalize(a.title).includes(qn) || qn.includes(normalize(a.title)) ? 1 : 0
              const bs = normalize(b.title).includes(qn) || qn.includes(normalize(b.title)) ? 1 : 0
              return bs - as
            })
          }
        }
      }

      for (let i = 0; i < dedupPromptHits.length; i++) {
        const h = dedupPromptHits[i]
        const relPath = fileById.get(h.chunk.fileId)?.relPath ?? ""
        if (!/\.pdf$/i.test(relPath)) continue
        const figureTitles = [...h.chunk.content.matchAll(/\[PDF_FIGURE_TITLE page=(\d+)\]\s+([^\n]+)/g)].map((m) => ({
          page: Number(m[1]),
          title: String(m[2] ?? "").trim(),
        }))
        const pagesFromOcr = [...h.chunk.content.matchAll(/\[PDF_PAGE_(\d+)\]/g)]
          .map((m) => Number(m[1]))
          .filter((n) => Number.isFinite(n) && n > 0)
        const pagesFromFigureTitles = figureTitles
          .map((x) => x.page)
          .filter((n) => Number.isFinite(n) && n > 0)
        const pages = Array.from(new Set([...pagesFromOcr, ...pagesFromFigureTitles])).slice(0, 4)
        const titlesByPage = new Map<number, string[]>()
        for (const ft of figureTitles) {
          if (!Number.isFinite(ft.page) || ft.page <= 0 || !ft.title) continue
          const list = titlesByPage.get(ft.page) ?? []
          list.push(ft.title)
          titlesByPage.set(ft.page, list)
        }
        for (const page of pages) {
          const key = `p:${relPath}#${page}`
          if (seen.has(key)) continue
          seen.add(key)
          const titles = titlesByPage.get(page) ?? []
          const title =
            titles
              .map((t) => ({ text: t, match: normalize(t).includes(qn) || qn.includes(normalize(t)) ? 1 : 0 }))
              .sort((a, b) => b.match - a.match)[0]?.text ?? `第 ${page} 页图表`
          out.push({
            kind: "pdf-page",
            relPath,
            page,
            title,
            imageUrl: `/api/fs/pdf/page-visual?path=${encodeURIComponent(relPath)}&page=${page}&mode=full`,
            chartMetaUrl: `/api/fs/pdf/page-meta?path=${encodeURIComponent(relPath)}&page=${page}`,
          })
          if (out.length >= 8) {
            return out.sort((a, b) => {
              const as = normalize(a.title).includes(qn) || qn.includes(normalize(a.title)) ? 1 : 0
              const bs = normalize(b.title).includes(qn) || qn.includes(normalize(b.title)) ? 1 : 0
              return bs - as
            })
          }
        }
      }
      return out.sort((a, b) => {
        const as = normalize(a.title).includes(qn) || qn.includes(normalize(a.title)) ? 1 : 0
        const bs = normalize(b.title).includes(qn) || qn.includes(normalize(b.title)) ? 1 : 0
        return bs - as
      })
    })()
    const answerWithVisuals =
      visualSources.length > 0
        ? `${answer}\n\n## 图表截图\n${visualSources
            .map((v, i) => {
              if (v.kind === "mineru-figure") {
                return `### 图表 ${i + 1}：${v.title}\n来源：${v.relPath}（MinerU）\n\n![${v.title}](${v.imageUrl})`
              }
              return `### 图表 ${i + 1}：${v.title}\n来源：${v.relPath} 第 ${v.page} 页\n\n![${v.title}](${v.imageUrl})\n\n[图表候选详情](${v.chartMetaUrl})`
            })
            .join("\n\n")}`
        : answer
    const historyItem = await appendChatHistory({
      conversationId,
      question,
      answer: answerWithVisuals,
      sources,
    })
    const debug = buildSearchDebugPayload(question, hits, fileById, !!queryEmbedding, vectorError)
    res.json({
      answer: answerWithVisuals,
      sources,
      visualSources,
      historyItem,
      vectorEnabled: getEmbeddingConfig().enabled,
      usedVector: !!queryEmbedding,
      vectorError,
      usedMapReduce: mapReduce,
      retrievalTopK: searchTopK,
      ...(debug ? { debug } : {}),
    })
  } catch (e) {
    res.status(502).json({ error: String(e) })
  }
})

const internalApiBase = String(process.env.INTERNAL_API_BASE_URL ?? `http://127.0.0.1:${PORT}`).trim()
setupFeishuWebhook(app, { internalApiBase })

app.listen(PORT, () => {
  console.log(`[nas-rag-app] API http://127.0.0.1:${PORT}`)
  console.log(
    `[nas-rag-app] MinerU: ${
      isMinerUEnabled()
        ? "已启用 — 抽取 PDF/PPTX 时会先调 mineru CLI（MINERU_CLI / MINERU_API_URL 等），失败则自动回退内置解析"
        : "未启用 — 环境变量 MINERU_ENABLED 未设为 true，不会调用 MinerU（与是否安装 CLI 无关）"
    }`,
  )
})
