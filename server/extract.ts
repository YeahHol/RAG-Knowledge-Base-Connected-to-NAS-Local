import { createRequire } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"

import "./node-pdf-polyfill"
import { resolveArtifactFile } from "./mineru-artifacts.js"
import { tryMinerUExtract } from "./mineru"

const require = createRequire(import.meta.url)
const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{ text: string }>
const mammoth = require("mammoth") as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> }
const { createCanvas } = require("@napi-rs/canvas") as {
  createCanvas: (width: number, height: number) => {
    getContext: (type: "2d") => unknown
    toBuffer: (mimeType?: string) => Buffer
  }
}
const { createWorker, OEM } = require("tesseract.js") as {
  createWorker: (
    langs: string,
    oem: number,
    opts: { langPath?: string; gzip?: boolean; cachePath?: string },
  ) => Promise<{
    recognize: (image: Buffer) => Promise<{ data?: { text?: string } }>
    terminate: () => Promise<void>
  }>
  OEM: { LSTM_ONLY: number }
}
const JSZip = require("jszip") as {
  loadAsync: (data: Buffer) => Promise<{
    files: Record<
      string,
      {
        async: (type: "string" | "nodebuffer") => Promise<string | Buffer>
      }
    >
  }>
}
const XLSX = require("xlsx") as {
  read: (data: Buffer, opts?: { type?: "buffer" }) => {
    SheetNames: string[]
    Sheets: Record<string, unknown>
  }
  utils: {
    sheet_to_json: (sheet: unknown, opts?: { header?: 1; defval?: string }) => unknown[][]
  }
}
const WordExtractor = require("word-extractor") as new () => {
  extract: (source: Buffer | string) => Promise<{ getBody: () => string }>
}
const wordDocExtractor = new WordExtractor()

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"])

/** 常见源码/数据/标记文本：按 UTF-8 读入（大文件仍受扫描层单文件上限约束） */
const PLAIN_TEXT_EXT = new Set([
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".html",
  ".htm",
  ".xhtml",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".ini",
  ".cfg",
  ".conf",
  ".css",
  ".scss",
  ".less",
  ".rtf",
  ".py",
  ".pyw",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".mdx",
  ".java",
  ".go",
  ".rs",
  ".sql",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".r",
  ".rb",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".c",
  ".h",
  ".cpp",
  ".cxx",
  ".cc",
  ".hpp",
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".m",
  ".mm",
  ".tex",
  ".bib",
  ".svg",
  ".graphql",
  ".gql",
  ".toml",
  ".gradle",
  ".cmake",
  ".proto",
  ".thrift",
])

const OFFICE_EXT = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".xlsx", ".xls", ".pptx", ...IMAGE_EXT])
const EXT = new Set([...OFFICE_EXT, ...PLAIN_TEXT_EXT])

export interface PdfChartCandidate {
  index: number
  label: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

export function isRasterImagePath(filePath: string): boolean {
  return IMAGE_EXT.has(path.extname(filePath).toLowerCase())
}

function stripHtmlLikeToText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

/** RTF 粗略去控制符（复杂版式可能残留噪声，仅服务检索） */
function stripRtfLoose(rtf: string): string {
  let s = rtf.replace(/\r\n/g, "\n")
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => {
    const code = Number.parseInt(hex, 16)
    return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : ""
  })
  s = s.replace(/\\[a-z]{1,40}(-?\d*) ?/gi, "")
  s = s.replace(/[{}]/g, " ")
  s = s.replace(/\\[^\s\\]*/g, "")
  return s.replace(/\s+/g, " ").trim()
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<a:br\s*\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function decodeWordXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, " ")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function extractDocxTables(documentXml: string): string[] {
  const out: string[] = []
  const tables = documentXml.match(/<w:tbl[\s\S]*?<\/w:tbl>/g) ?? []
  let tIndex = 0
  for (const tbl of tables) {
    tIndex++
    const rows = tbl.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? []
    const rowLines: string[] = []
    let rIndex = 0
    for (const row of rows) {
      rIndex++
      const cells = row.match(/<w:tc[\s\S]*?<\/w:tc>/g) ?? []
      const vals = cells
        .map((c) => decodeWordXmlText(c))
        .map((v) => v.replace(/\s+/g, " ").trim())
        .filter(Boolean)
      if (vals.length > 0) {
        rowLines.push(`[Row ${rIndex}] ${vals.join(" | ")}`)
      }
    }
    if (rowLines.length > 0) {
      out.push(`[DOCX_TABLE ${tIndex}]\n${rowLines.join("\n")}`)
    }
  }
  return out
}

function shouldEnableOcr() {
  return String(process.env.ENABLE_OCR ?? "true").trim().toLowerCase() !== "false"
}

/** tesseract：本机/下载语言包；http：调用自建 OCR 网关（推荐企业内网）；off：不做 OCR */
function ocrProvider(): "tesseract" | "http" | "off" {
  const raw = String(process.env.OCR_PROVIDER ?? "").trim().toLowerCase()
  if (raw === "off" || raw === "none" || raw === "false") return "off"
  if (raw === "http") return "http"
  if (raw === "tesseract") return "tesseract"
  if (String(process.env.OCR_HTTP_URL ?? "").trim()) return "http"
  return "tesseract"
}

function shouldOcrPdfByDefault() {
  return String(process.env.ENABLE_PDF_OCR ?? "true").trim().toLowerCase() !== "false"
}

function pdfOcrAlways() {
  return String(process.env.PDF_OCR_ALWAYS ?? "false").trim().toLowerCase() === "true"
}

function pdfOcrMaxPages() {
  const n = Number(process.env.PDF_OCR_MAX_PAGES ?? 5)
  if (!Number.isFinite(n) || n <= 0) return 5
  return Math.min(30, Math.floor(n))
}

/** 超过该大小的 PDF 不做逐页渲染 OCR（避免大文件 + pdf.js 在 Node 下刷屏/卡死） */
function pdfOcrMaxFileBytes() {
  const mb = Number(process.env.PDF_OCR_MAX_FILE_MB ?? 12)
  if (!Number.isFinite(mb) || mb <= 0) return 12 * 1024 * 1024
  return Math.min(80, Math.floor(mb)) * 1024 * 1024
}

function ocrLang() {
  const fallback = "chi_sim+eng"
  // 只接受 ASCII；每段至少 3 字符（如 eng、osd、chi_sim），杜绝 2 字乱码、CJK、错误编码片段进入 Tesseract。
  const raw = String(process.env.OCR_LANG ?? fallback)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
  const ascii = raw.replace(/[^a-z0-9_+]/g, "")
  if (!ascii || !/^[a-z0-9_+]+$/.test(ascii)) return fallback
  const partRe = /^[a-z][a-z0-9_]{2,63}$/
  const parts = ascii
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => partRe.test(p))
  if (parts.length === 0) return fallback
  return parts.join("+")
}

function ocrLangPath() {
  // 显式指定语言包来源，避免默认走本地 ./xxx.traineddata 导致报错。
  return String(process.env.OCR_LANG_PATH ?? "https://tessdata.projectnaptha.com/4.0.0").trim()
}

function normalizePathToPosix(p: string) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

function decodeXmlAttr(v: string): string {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function extractPptVisualHints(slideXml: string): string[] {
  const out: string[] = []
  const re = /<p:cNvPr\b([^>]*)\/?>/g
  let m: RegExpExecArray | null = null
  while ((m = re.exec(slideXml)) !== null) {
    const attrs = m[1] ?? ""
    const name = attrs.match(/\bname="([^"]*)"/)?.[1]
    const descr = attrs.match(/\bdescr="([^"]*)"/)?.[1]
    const n = name ? decodeXmlAttr(name) : ""
    const d = descr ? decodeXmlAttr(descr) : ""
    if (!n && !d) continue
    if (/^(标题|内容占位符|Subtitle|Title|Content)\s*\d*$/i.test(n)) continue
    out.push(d ? `${n} (${d})` : n)
  }
  return Array.from(new Set(out)).slice(0, 20)
}

function extractRelTargets(relsXml: string): string[] {
  const targets: string[] = []
  const re = /\bTarget="([^"]+)"/g
  let m: RegExpExecArray | null = null
  while ((m = re.exec(relsXml)) !== null) {
    targets.push(m[1])
  }
  return targets
}

async function ocrFromTesseract(buf: Buffer, label: string): Promise<string> {
  const lang = ocrLang()
  const cacheDir = path.join(process.cwd(), "data", "tess-cache")
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {})
  const worker = await createWorker(lang, OEM.LSTM_ONLY, {
    langPath: ocrLangPath(),
    gzip: true,
    cachePath: cacheDir,
  })
  try {
    const r = await worker.recognize(buf)
    const text = (r.data?.text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
    if (!text) return ""
    return `[OCR ${label}]\n${text}`
  } finally {
    await worker.terminate().catch(() => {})
  }
}

/**
 * 调用自建 OCR 网关：POST JSON
 * { "imageBase64": "<base64>", "mimeType": "image/png", "label": "..." }
 * 响应需为 JSON，且包含字段 `text` 或 `result`（字符串）。
 * 适合内网部署 PaddleOCR / 封装阿里云 OCR 等，不依赖本机 tessdata。
 */
async function ocrFromHttp(buf: Buffer, label: string): Promise<string> {
  const url = String(process.env.OCR_HTTP_URL ?? "").trim()
  if (!url) throw new Error("OCR_PROVIDER=http 但未配置 OCR_HTTP_URL")
  const token = String(process.env.OCR_HTTP_TOKEN ?? "").trim()
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      imageBase64: buf.toString("base64"),
      mimeType: "image/png",
      label,
    }),
  })
  const rawText = await res.text()
  if (!res.ok) {
    throw new Error(`OCR_HTTP ${res.status}: ${rawText.slice(0, 400)}`)
  }
  let text = ""
  try {
    const j = JSON.parse(rawText) as { text?: string; result?: string; data?: { text?: string } }
    text = (j.text ?? j.result ?? j.data?.text ?? "").trim()
  } catch {
    text = rawText.trim()
  }
  if (!text) return ""
  return `[OCR ${label}]\n${text}`
}

async function ocrFromBuffer(buf: Buffer, label: string): Promise<string> {
  if (!shouldEnableOcr()) return ""
  const provider = ocrProvider()
  if (provider === "off") return ""
  try {
    if (provider === "http") return await ocrFromHttp(buf, label)
    return await ocrFromTesseract(buf, label)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[ocr] provider=${provider} label=${label}: ${msg}`)
    return ""
  }
}

/**
 * 为 MinerU 注入的 `[FigureOCR]` 块运行 OCR，使图表可被纯文本向量语义检索（路线 3：图侧语义代理）。
 * 若 `MINERU_FIGURE_OCR=false` 则保留占位说明，不读图文件。
 */
export async function enrichMinerUFigureOcrInText(text: string): Promise<string> {
  if (!text.includes("[MINERU_FIGURE") || !text.includes("[FigureOCR]")) return text
  const skip = String(process.env.MINERU_FIGURE_OCR ?? "true").trim().toLowerCase() === "false"
  const re = /\[MINERU_FIGURE digest=([a-f0-9]{40}) rel=([^\]\r\n]+)\]\s*\n\[FigureOCR\]\s*\n+/gi
  let last = 0
  let out = ""
  const s = text
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index)
    last = m.index + m[0].length
    const digest = m[1]!
    const rel = m[2]!.trim()
    let body = ""
    if (!skip) {
      const full = resolveArtifactFile(digest, rel)
      if (full) {
        try {
          const buf = await fs.readFile(full)
          const ocr = await ocrFromBuffer(buf, `mineru-${path.basename(rel)}`)
          body = ocr.replace(/^\[OCR [^\]]+\]\n?/, "").trim()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[mineru] figure OCR rel=${rel}:`, msg)
        }
      }
    }
    if (!body) body = skip ? "（已跳过图表 OCR：MINERU_FIGURE_OCR=false）" : "（图表区域未识别到文字，仍可按版图检索）"
    out += `[MINERU_FIGURE digest=${digest} rel=${rel}]\n[FigureOCR]\n${body}\n\n`
  }
  out += s.slice(last)
  return out
}

async function ocrPdfPages(buf: Buffer): Promise<string[]> {
  if (!shouldEnableOcr() || !shouldOcrPdfByDefault()) return []
  const maxBytes = pdfOcrMaxFileBytes()
  if (buf.length > maxBytes) {
    console.warn(`[pdf-ocr] 跳过逐页 OCR：PDF 大小 ${buf.length} 超过上限 ${maxBytes}（可调 PDF_OCR_MAX_FILE_MB）`)
    return []
  }
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const verbosity =
      typeof (pdfjs as { VerbosityLevel?: { ERRORS: number } }).VerbosityLevel?.ERRORS === "number"
        ? (pdfjs as { VerbosityLevel: { ERRORS: number } }).VerbosityLevel.ERRORS
        : 0
    ;(pdfjs as { setVerbosityLevel?: (n: number) => void }).setVerbosityLevel?.(verbosity)
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      verbosity,
    })
    const doc = await task.promise
    const maxPages = Math.min(doc.numPages, pdfOcrMaxPages())
    const out: string[] = []

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1.6 })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext("2d")
      await page.render({
        canvasContext: ctx as object,
        viewport,
      }).promise
      const png = canvas.toBuffer("image/png")
      const ocr = await ocrFromBuffer(png, `pdf-page-${i}`)
      if (ocr) out.push(`[PDF_PAGE_${i}] ${ocr.replace(/^\[OCR [^\]]+\]\n?/, "")}`)
    }
    return out
  } catch {
    return []
  }
}

async function loadPdfDocumentFromBuffer(buf: Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const verbosity =
    typeof (pdfjs as { VerbosityLevel?: { ERRORS: number } }).VerbosityLevel?.ERRORS === "number"
      ? (pdfjs as { VerbosityLevel: { ERRORS: number } }).VerbosityLevel.ERRORS
      : 0
  ;(pdfjs as { setVerbosityLevel?: (n: number) => void }).setVerbosityLevel?.(verbosity)
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    verbosity,
  })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy?.() }
}

function detectPdfChartCandidates(
  textItems: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>,
  pageWidth: number,
  pageHeight: number,
): PdfChartCandidate[] {
  const out: PdfChartCandidate[] = []
  const regex = /(图\s*\d+|表\s*\d+|图表|曲线|趋势|对比|负荷)/i
  for (const it of textItems) {
    const raw = String(it.str ?? "").trim()
    if (!raw) continue
    if (!regex.test(raw)) continue
    const tf = Array.isArray(it.transform) ? it.transform : []
    const x = Number(tf[4] ?? 0)
    const yBase = Number(tf[5] ?? 0)
    const w = Math.max(140, Number(it.width ?? 120) * 2.4)
    const h = Math.max(120, Number(it.height ?? 24) * 10)
    const y = pageHeight - yBase - h * 0.45
    const cx = Math.max(0, Math.min(pageWidth - w, x - 30))
    const cy = Math.max(0, Math.min(pageHeight - h, y))
    out.push({
      index: out.length,
      label: raw.slice(0, 40),
      title: raw.slice(0, 80),
      x: Math.floor(cx),
      y: Math.floor(cy),
      width: Math.floor(Math.min(pageWidth, w)),
      height: Math.floor(Math.min(pageHeight, h)),
    })
    if (out.length >= 4) break
  }
  return out
}

async function extractPdfFigureTitleMarkers(buf: Buffer): Promise<string[]> {
  try {
    const { doc, destroy } = await loadPdfDocumentFromBuffer(buf)
    try {
      const maxPages = Math.min(doc.numPages, Math.max(1, Number(process.env.PDF_FIGURE_TITLE_MAX_PAGES ?? 20) || 20))
      const out: string[] = []
      for (let i = 1; i <= maxPages; i++) {
        const page = await doc.getPage(i)
        const text = (await page.getTextContent()) as { items?: Array<{ str?: string }> }
        const lines = (text.items ?? [])
          .map((x) => String(x.str ?? "").trim())
          .filter(Boolean)
        if (lines.length === 0) continue
        const joined = lines.join("\n")
        const matches = joined.match(/(?:图|表)\s*\d+[\s\S]{0,50}/g) ?? []
        for (const m of matches.slice(0, 6)) {
          const title = m.replace(/\s+/g, " ").trim().slice(0, 80)
          if (!title) continue
          out.push(`[PDF_FIGURE_TITLE page=${i}] ${title}`)
        }
      }
      return out
    } finally {
      destroy()
    }
  } catch {
    return []
  }
}

export async function getPdfPageVisualMeta(absPath: string, pageNo: number): Promise<{ chartCandidates: PdfChartCandidate[] }> {
  const buf = await fs.readFile(absPath)
  const { doc, destroy } = await loadPdfDocumentFromBuffer(buf)
  try {
    const page = await doc.getPage(Math.max(1, pageNo))
    const viewport = page.getViewport({ scale: 1.5 })
    const text = (await page.getTextContent()) as { items?: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }
    const items = Array.isArray(text.items) ? text.items : []
    const chartCandidates = detectPdfChartCandidates(items, viewport.width, viewport.height)
    return { chartCandidates }
  } finally {
    destroy()
  }
}

export async function renderPdfPageVisual(
  absPath: string,
  pageNo: number,
  mode: "full" | "chart" = "full",
  chartIndex = 0,
): Promise<Buffer> {
  const buf = await fs.readFile(absPath)
  const { doc, destroy } = await loadPdfDocumentFromBuffer(buf)
  try {
    const page = await doc.getPage(Math.max(1, pageNo))
    const viewport = page.getViewport({ scale: 2.0 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext("2d")
    await page.render({
      canvasContext: ctx as object,
      viewport,
    }).promise
    const full = canvas.toBuffer("image/png")
    if (mode !== "chart") return full

    const text = (await page.getTextContent()) as { items?: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }
    const items = Array.isArray(text.items) ? text.items : []
    const candidates = detectPdfChartCandidates(items, viewport.width, viewport.height)
    const target = candidates[chartIndex]
    if (!target) return full

    const crop = createCanvas(target.width, target.height)
    const cctx = crop.getContext("2d") as {
      drawImage: (
        img: { width: number; height: number },
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
      ) => void
    }
    cctx.drawImage(canvas as unknown as { width: number; height: number }, target.x, target.y, target.width, target.height, 0, 0, target.width, target.height)
    return crop.toBuffer("image/png")
  } finally {
    destroy()
  }
}

export function isSupportedExt(filePath: string) {
  const base = path.basename(filePath)
  const lower = base.toLowerCase()
  // Office 打开文档时生成的锁文件，体积小且常损坏，索引会报错
  if (lower.startsWith("~$")) return false
  if (lower === "thumbs.db") return false
  return EXT.has(path.extname(filePath).toLowerCase())
}

export async function extractText(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase()
  const buf = await fs.readFile(absPath)

  if (ext === ".pdf") {
    const mineruText = await tryMinerUExtract(absPath)
    if (mineruText?.trim()) return await enrichMinerUFigureOcrInText(mineruText.trim())

    const { text } = await pdfParse(buf)
    const extracted = (text ?? "").trim()
    const figureTitleMarkers = await extractPdfFigureTitleMarkers(buf)
    const doOcr = pdfOcrAlways() || extracted.length < 400
    if (!doOcr) return [extracted, ...figureTitleMarkers].filter(Boolean).join("\n\n---\n\n")
    const ocrParts = await ocrPdfPages(buf)
    if (ocrParts.length === 0) return [extracted, ...figureTitleMarkers].filter(Boolean).join("\n\n---\n\n")
    return [extracted, ...figureTitleMarkers, ...ocrParts].filter(Boolean).join("\n\n---\n\n")
  }
  if (ext === ".doc") {
    try {
      const extracted = await wordDocExtractor.extract(buf)
      const body = (extracted.getBody() ?? "").replace(/\r\n/g, "\n").trim()
      return body || "（.doc 已解析，但未抽取到正文文本）"
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn("[extract] .doc word-extractor:", msg)
      return `[.doc 解析失败] ${msg}`
    }
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf })
    let tableBlocks: string[] = []
    try {
      const zip = await JSZip.loadAsync(buf)
      const docFile = zip.files["word/document.xml"]
      if (docFile) {
        const xml = (await docFile.async("string")) as string
        tableBlocks = extractDocxTables(xml)
      }
    } catch {
      tableBlocks = []
    }
    const body = (value ?? "").trim()
    if (tableBlocks.length === 0) return body
    return [body, ...tableBlocks].filter(Boolean).join("\n\n---\n\n")
  }
  if (ext === ".txt" || ext === ".md") {
    return buf.toString("utf-8")
  }
  if (IMAGE_EXT.has(ext)) {
    const fileName = path.basename(absPath)
    const tokenized = fileName
      .replace(/\.[^.]+$/, "")
      .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20)
      .join(" | ")
    const ocr = await ocrFromBuffer(buf, fileName)
    return [`[Image] ${fileName}`, tokenized ? `[ImageTags] ${tokenized}` : "", ocr].filter(Boolean).join("\n\n")
  }
  if (ext === ".xlsx" || ext === ".xls") {
    let wb: ReturnType<(typeof XLSX)["read"]>
    try {
      wb = XLSX.read(buf, { type: "buffer" })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn("[extract] xlsx/xls:", msg)
      return `[表格解析失败] ${msg}`
    }
    const sheetTexts: string[] = []
    const maxRowsPerSheet = 2000
    const maxColsPerSheet = 80

    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName]
      if (!sheet) continue
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })
      if (!rows || rows.length === 0) continue

      const normalizeCell = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()
      const firstNonEmptyRowIdx = rows.findIndex((r) => (r ?? []).some((x) => normalizeCell(x)))
      if (firstNonEmptyRowIdx < 0) continue

      const headerRow = rows[firstNonEmptyRowIdx] ?? []
      const headers = headerRow.slice(0, maxColsPerSheet).map((v, i) => {
        const h = normalizeCell(v)
        return h || `col_${i + 1}`
      })

      const headerSet = new Set(headers.map((h) => h.toLowerCase()))
      const blocks: string[] = []
      blocks.push(`[Sheet] ${sheetName}`)
      blocks.push(
        `[Columns] ${headers.join(" | ")}`,
      )

      let dataRowCount = 0
      for (let i = firstNonEmptyRowIdx + 1; i < Math.min(rows.length, maxRowsPerSheet); i++) {
        const row = rows[i] ?? []
        const rowVals = row.slice(0, maxColsPerSheet).map((x) => normalizeCell(x))
        if (!rowVals.some(Boolean)) continue

        // 跳过重复表头行（很多业务表会在中间重复标题行）
        const lowerVals = rowVals.map((v) => v.toLowerCase()).filter(Boolean)
        if (lowerVals.length > 0 && lowerVals.every((v) => headerSet.has(v))) continue

        const cells: string[] = []
        for (let c = 0; c < rowVals.length; c++) {
          const raw = rowVals[c]
          if (!raw) continue
          const key = headers[c] || `col_${c + 1}`
          cells.push(`${key}: ${raw}`)
        }
        if (cells.length === 0) continue

        dataRowCount++
        blocks.push(`[Row ${i + 1}] ${cells.join(" | ")}`)
      }

      if (dataRowCount > 0) {
        // 给 LLM 一个轻量摘要提示，便于问答先定位到相关 sheet
        blocks.splice(1, 0, `[Stats] data_rows=${dataRowCount}, columns=${headers.length}`)
        sheetTexts.push(blocks.join("\n\n"))
      }
    }

    return sheetTexts.join("\n\n---\n\n")
  }
  if (ext === ".pptx") {
    const mineruText = await tryMinerUExtract(absPath)
    if (mineruText?.trim()) return await enrichMinerUFigureOcrInText(mineruText.trim())

    const zip = await JSZip.loadAsync(buf)
    const slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const na = Number((a.match(/slide(\d+)\.xml/i) ?? [])[1] ?? 0)
        const nb = Number((b.match(/slide(\d+)\.xml/i) ?? [])[1] ?? 0)
        return na - nb
      })

    const slides: string[] = []
    let ocrImageCount = 0
    const maxPptOcrImages = 8
    for (const p of slidePaths) {
      const m = p.match(/slide(\d+)\.xml/i)
      const slideNo = Number(m?.[1] ?? 0)
      const xml = (await zip.files[p].async("string")) as string
      const txt = decodeXmlText(xml)
      const hints = extractPptVisualHints(xml)

      const parts: string[] = []
      if (txt) parts.push(txt)
      if (hints.length > 0) parts.push(`[VisualHints]\n${hints.map((x) => `- ${x}`).join("\n")}`)

      // 尝试抽取该页关联图片做 OCR，提升“图标/图片”检索能力。
      const relPath = p.replace(/^ppt\/slides\//i, "ppt/slides/_rels/") + ".rels"
      const relFile = zip.files[relPath]
      if (relFile && ocrImageCount < maxPptOcrImages && shouldEnableOcr()) {
        const relXml = (await relFile.async("string")) as string
        const targets = extractRelTargets(relXml)
        for (const t of targets) {
          if (ocrImageCount >= maxPptOcrImages) break
          if (!/image\d+\.(png|jpg|jpeg|webp)$/i.test(t)) continue
          const mediaFile = normalizePathToPosix(path.posix.normalize(path.posix.join("ppt/slides", t)))
          const media = zip.files[mediaFile]
          if (!media) continue
          const imgBuf = (await media.async("nodebuffer")) as Buffer
          const ocrText = await ocrFromBuffer(imgBuf, `slide-${slideNo}-image`)
          if (ocrText) {
            parts.push(ocrText)
            ocrImageCount++
          }
        }
      }

      if (parts.length === 0) continue
      slides.push(`[Slide ${slideNo || slides.length + 1}]\n${parts.join("\n\n")}`)
    }
    return slides.join("\n\n---\n\n")
  }
  if (PLAIN_TEXT_EXT.has(ext)) {
    const raw = buf.toString("utf-8")
    if (ext === ".json") {
      try {
        const j = JSON.parse(raw) as unknown
        const out = JSON.stringify(j, null, 2)
        return out.length > 400_000 ? `${out.slice(0, 400_000)}\n\n...[truncated]` : out
      } catch {
        return raw
      }
    }
    if (ext === ".html" || ext === ".htm" || ext === ".xhtml" || ext === ".xml" || ext === ".svg") {
      const t = stripHtmlLikeToText(raw)
      return t || raw.trim().slice(0, 12_000)
    }
    if (ext === ".rtf") {
      const t = stripRtfLoose(raw)
      return t || raw.trim().slice(0, 12_000)
    }
    return raw
  }
  return ""
}

/** 文件管理侧表格预览：按工作表返回二维字符串（不做 OCR，体量可控） */
export type XlsxPreviewSheet = { name: string; rows: string[][] }

export async function buildXlsxPreviewSheets(absPath: string): Promise<XlsxPreviewSheet[]> {
  const buf = await fs.readFile(absPath)
  let wb: ReturnType<(typeof XLSX)["read"]>
  try {
    wb = XLSX.read(buf, { type: "buffer" })
  } catch {
    return []
  }
  const MAX_SHEETS = 8
  const MAX_ROWS = 120
  const MAX_COLS = 28
  const sheets: XlsxPreviewSheet[] = []

  for (const sheetName of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][]
    const rows: string[][] = []
    for (let i = 0; i < Math.min(raw.length, MAX_ROWS); i++) {
      const r = raw[i] ?? []
      rows.push(
        r.slice(0, MAX_COLS).map((c) => {
          if (c == null) return ""
          if (typeof c === "number" && Number.isFinite(c)) return String(c)
          return String(c).replace(/\r\n/g, "\n").trim()
        }),
      )
    }
    sheets.push({ name: sheetName, rows })
  }
  return sheets
}

/** 文件管理侧 PPT 预览：按页抽取文本与图示占位名（不调 MinerU、不做逐图 OCR，保证响应快） */
export type PptxPreviewSlide = { n: number; text: string }

export async function buildPptxPreviewSlides(absPath: string): Promise<PptxPreviewSlide[]> {
  const buf = await fs.readFile(absPath)
  const zip = await JSZip.loadAsync(buf)
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)\.xml/i) ?? [])[1] ?? 0)
      const nb = Number((b.match(/slide(\d+)\.xml/i) ?? [])[1] ?? 0)
      return na - nb
    })

  const out: PptxPreviewSlide[] = []
  const MAX_SLIDES = 80
  const MAX_CHARS = 12_000

  for (const p of slidePaths.slice(0, MAX_SLIDES)) {
    const m = p.match(/slide(\d+)\.xml/i)
    const slideNo = Number(m?.[1] ?? out.length + 1)
    const file = zip.files[p]
    if (!file) continue
    const xml = (await file.async("string")) as string
    const txt = decodeXmlText(xml)
    const hints = extractPptVisualHints(xml)
    const parts: string[] = []
    if (txt) parts.push(txt)
    if (hints.length > 0) parts.push(`[图示/形状]\n${hints.map((h) => `· ${h}`).join("\n")}`)
    let combined = parts.join("\n\n").trim()
    if (combined.length > MAX_CHARS) combined = `${combined.slice(0, MAX_CHARS)}\n…`
    if (!combined) combined = `（第 ${slideNo} 页无可抽取文本，可能主要为图片或空白版式）`
    out.push({ n: slideNo, text: combined })
  }
  return out
}

/** 按段落切分，控制单块大小，便于 RAG */
export function chunkText(text: string, maxLen = 1800): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim()
  if (!normalized) return []
  const paras = normalized.split(/\n{2,}/)
  const chunks: string[] = []
  let cur = ""
  for (const p of paras) {
    const piece = p.trim()
    if (!piece) continue
    if (cur.length + piece.length + 2 <= maxLen) {
      cur = cur ? `${cur}\n\n${piece}` : piece
    } else {
      if (cur) chunks.push(cur)
      if (piece.length <= maxLen) {
        cur = piece
      } else {
        for (let i = 0; i < piece.length; i += maxLen) {
          chunks.push(piece.slice(i, i + maxLen))
        }
        cur = ""
      }
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}
