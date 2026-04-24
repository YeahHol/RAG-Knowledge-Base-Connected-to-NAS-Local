import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  Folder,
  FolderSync,
  Layers,
  LayoutDashboard,
  Link2,
  MessageSquare,
  PanelLeft,
  Search,
  Server,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

type StoreInfo = {
  rootPath: string
  updatedAt: string
  fileCount: number
  chunkCount: number
  files: Array<{ id: string; relPath: string; status: string; error?: string; size: number }>
}

type SearchHit = { id: string; title: string; snippet: string; score: number; fileId: string; relPath?: string }
type ChatSource = { n: number; title: string; score: number; relPath: string }
type ChatHistoryItem = {
  id: string
  conversationId: string
  question: string
  answer: string
  sources: ChatSource[]
  createdAt: string
}
type ChatConversation = { id: string; title: string; createdAt: string; updatedAt: string }
type ChatVisualSource = {
  kind?: "pdf-page" | "mineru-figure"
  relPath: string
  page: number
  title: string
  imageUrl: string
  chartMetaUrl: string
  figureRel?: string
}
type FsPreviewApi =
  | { path: string; kind?: "text"; preview: string }
  | { path: string; kind: "excel"; preview: string; sheets: { name: string; rows: string[][] }[] }
  | { path: string; kind: "pptx"; preview: string; slides: { n: number; text: string }[] }
  | { path: string; kind: "image"; preview: string }

type FsRichPreview =
  | { type: "none" }
  | { type: "text"; text: string }
  | { type: "excel"; sheets: { name: string; rows: string[][] }[] }
  | { type: "pptx"; slides: { n: number; text: string }[] }
  | { type: "image"; relPath: string; caption: string }

type FsNodeDir = { name: string; absPath: string; relPath: string; hasChildren: boolean }
/** 文件管理列表每页条数 */
const FILES_PAGE_SIZE = 25

function isImageRelPath(relPath: string): boolean {
  const base = relPath.split(/[/\\]/).pop() ?? ""
  return /\.(png|jpe?g|webp)$/i.test(base)
}

function fsImageSrc(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/")
  return `/api/fs/image?path=${encodeURIComponent(normalized)}`
}

function fsRawSrc(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/")
  return `/api/fs/raw?path=${encodeURIComponent(normalized)}`
}

function canInlineRawPreview(relPath: string): boolean {
  const base = relPath.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  return /\.(pdf|png|jpe?g|webp|txt|md|json|csv)$/i.test(base)
}

type FsNodeFile = {
  name: string
  absPath: string
  relPath: string
  size: number
  mtime: number
  ext: string
  indexStatus: "pending" | "indexed" | "error" | "skipped" | "unindexed"
  indexError: string | null
  chunkCount: number
}
type FsListResp = { rootPath: string; currentPath: string; dirs: FsNodeDir[]; files: FsNodeFile[] }
type NasEntryDir = { name: string; path: string }
type NasEntryFile = { name: string; path: string; size: number; mtime: number; ext: string }
type NasListResp = { ok: true; currentPath: string; dirs: NasEntryDir[]; files: NasEntryFile[] }
type NasPreviewInfo =
  | { kind: "text"; path: string; fileName: string; preview: string }
  | { kind: "image"; path: string; fileName: string; imageUrl: string }
  | { kind: "pdf"; path: string; fileName: string; previewUrl: string }
  | { kind: "excel"; path: string; fileName: string; sheets: { name: string; rows: string[][] }[] }
  | { kind: "pptx"; path: string; fileName: string; slides: { n: number; text: string }[] }
  | { kind: "unsupported"; path: string; fileName: string; preview: string }
type UrlPreviewResp = {
  ok: boolean
  url: string
  title: string
  preview: string
  text: string
  chars: number
  contentType: string
}

type HealthInfo = {
  ok?: boolean
  mineruEnabled?: boolean
  embedding?: {
    vectorSearchEnabled?: boolean
    hasApiKey?: boolean
    model?: string
    provider?: string
  }
}

type Tab = "overview" | "manage" | "nas" | "search" | "chat" | "links"
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "功能概览" },
  { id: "manage", label: "文件管理" },
  { id: "nas", label: "NAS 登录" },
  { id: "links", label: "链接采集" },
  { id: "search", label: "关键词检索" },
  { id: "chat", label: "问答" },
]

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? r.statusText)
  }
  return r.json() as Promise<T>
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildAnswerMarkdown(answerText: string, sources: ChatSource[]): string {
  if (!answerText) return ""
  const validNums = new Set(sources.map((s) => s.n))
  let next = answerText
  for (const s of sources) {
    const exact = `[${s.title}]`
    const re = new RegExp(escapeRegExp(exact), "g")
    next = next.replace(re, `[${s.title}](#source-note-${s.n})`)
  }
  next = next.replace(/\[(\d+)\]/g, (_m, nStr: string) => {
    const n = Number(nStr)
    if (!Number.isFinite(n) || !validNums.has(n)) return `[${nStr}]`
    return `[[${n}]](#source-note-${n})`
  })
  return next
}

function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export default function App() {
  const [tab, setTab] = useState<Tab>("manage")
  const [rootPath, setRootPath] = useState("")
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [opMsg, setOpMsg] = useState<string | null>(null)

  const [currentPath, setCurrentPath] = useState("")
  const [fsList, setFsList] = useState<FsListResp | null>(null)
  const [fsLoading, setFsLoading] = useState(false)
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set([""]))
  const [treeCache, setTreeCache] = useState<Record<string, FsNodeDir[]>>({})
  const [treeLoadingPath, setTreeLoadingPath] = useState<string | null>(null)
  const [selectedRelPath, setSelectedRelPath] = useState("")
  const [selectedDirRelPath, setSelectedDirRelPath] = useState("")
  const [rawViewerRelPath, setRawViewerRelPath] = useState("")
  const [rawViewerPreview, setRawViewerPreview] = useState<FsRichPreview>({ type: "none" })
  const [rawViewerLoading, setRawViewerLoading] = useState(false)
  const [fileFilter, setFileFilter] = useState<"all" | "indexed" | "error" | "skipped" | "unindexed">("all")
  const [fileListPage, setFileListPage] = useState(1)
  const [fsRichPreview, setFsRichPreview] = useState<FsRichPreview>({ type: "none" })
  const [previewLoading, setPreviewLoading] = useState(false)
  const [nasBaseUrl, setNasBaseUrl] = useState("http://27.115.70.62:5000")
  const [nasUser, setNasUser] = useState("")
  const [nasPass, setNasPass] = useState("")
  const [nasOtp, setNasOtp] = useState("")
  const [nasToken, setNasToken] = useState("")
  const [nasCurrentPath, setNasCurrentPath] = useState("/")
  const [nasList, setNasList] = useState<NasListResp | null>(null)
  const [nasLoading, setNasLoading] = useState(false)
  const [nasViewerPath, setNasViewerPath] = useState("")
  const [nasViewerLoading, setNasViewerLoading] = useState(false)
  const [nasViewerInfo, setNasViewerInfo] = useState<NasPreviewInfo | null>(null)
  const [nasViewerError, setNasViewerError] = useState("")
  const [urlInput, setUrlInput] = useState("")
  const [urlPreview, setUrlPreview] = useState<UrlPreviewResp | null>(null)
  const [urlLoading, setUrlLoading] = useState(false)
  const [health, setHealth] = useState<HealthInfo | null>(null)

  const [q, setQ] = useState("")
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searchVectorInfo, setSearchVectorInfo] = useState<{ vectorEnabled: boolean; usedVector: boolean } | null>(null)

  const [question, setQuestion] = useState("")
  const [chatting, setChatting] = useState(false)
  const [chatErr, setChatErr] = useState<string | null>(null)
  const [chatVisualSources, setChatVisualSources] = useState<ChatVisualSource[]>([])
  const [chatVectorInfo, setChatVectorInfo] = useState<{ vectorEnabled: boolean; usedVector: boolean; vectorError?: string } | null>(null)
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>([])
  const [chatConversations, setChatConversations] = useState<ChatConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState("")
  const [historyLoading, setHistoryLoading] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    const s = await api<StoreInfo>("/api/store")
    setStore(s)
    setRootPath(s.rootPath ?? "")
  }, [])

  const nasApi = useCallback(
    async <T,>(p: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers ?? {})
      if (nasToken) headers.set("x-nas-token", nasToken)
      const r = await fetch(p, { ...init, headers })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error ?? r.statusText)
      }
      return r.json() as Promise<T>
    },
    [nasToken],
  )

  const loadDirectory = useCallback(async (nextPath: string) => {
    const normalizedPath = nextPath.replace(/\\/g, "/")
    setFsLoading(true)
    setErr(null)
    try {
      const data = await api<FsListResp>(`/api/fs/list?path=${encodeURIComponent(normalizedPath)}`)
      setFsList(data)
      setCurrentPath(data.currentPath)
      setTreeCache((prev) => ({ ...prev, [data.currentPath]: data.dirs }))
      setSelectedRelPath("")
      setSelectedDirRelPath("")
      setFsRichPreview({ type: "none" })
    } catch (e) {
      setErr(String(e))
    } finally {
      setFsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setHealth(j as HealthInfo))
      .catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    const cachedToken = window.localStorage.getItem("nas-token") ?? ""
    const cachedBaseUrl = window.localStorage.getItem("nas-base-url") ?? ""
    if (cachedToken) setNasToken(cachedToken)
    if (cachedBaseUrl) setNasBaseUrl(cachedBaseUrl)
  }, [])

  useEffect(() => {
    if (nasToken) {
      window.localStorage.setItem("nas-token", nasToken)
    } else {
      window.localStorage.removeItem("nas-token")
    }
  }, [nasToken])

  useEffect(() => {
    if (nasBaseUrl.trim()) {
      window.localStorage.setItem("nas-base-url", nasBaseUrl.trim())
    }
  }, [nasBaseUrl])

  useEffect(() => {
    if (tab !== "overview") return
    void refresh()
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setHealth(j as HealthInfo))
      .catch(() => setHealth(null))
  }, [tab, refresh])

  useEffect(() => {
    if (store?.rootPath) {
      loadDirectory("").catch(() => {})
    } else {
      setFsList(null)
      setTreeCache({})
    }
  }, [store?.rootPath, loadDirectory])

  const loadChatConversations = useCallback(async () => {
    try {
      const data = await api<{ items: ChatConversation[] }>("/api/chat/conversations")
      const items = data.items ?? []
      setChatConversations(items)
      if (!activeConversationId && items.length > 0) {
        setActiveConversationId(items[0].id)
      }
    } catch (e) {
      setErr(String(e))
    }
  }, [activeConversationId])

  const loadChatHistory = useCallback(async (conversationId: string) => {
    if (!conversationId) {
      setChatHistory([])
      return
    }
    setHistoryLoading(true)
    try {
      const data = await api<{ items: ChatHistoryItem[] }>(
        `/api/chat/history?conversationId=${encodeURIComponent(conversationId)}&limit=80`,
      )
      setChatHistory(data.items ?? [])
    } catch (e) {
      setErr(String(e))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const ensureActiveConversation = useCallback(async (): Promise<string> => {
    if (activeConversationId) return activeConversationId
    const data = await api<{ item: ChatConversation }>("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: question.trim().slice(0, 32) || "新会话" }),
    })
    const conv = data.item
    setChatConversations((prev) => [conv, ...prev.filter((x) => x.id !== conv.id)])
    setActiveConversationId(conv.id)
    return conv.id
  }, [activeConversationId, question])

  const clearHistory = async () => {
    if (!activeConversationId) return
    setErr(null)
    try {
      await api(`/api/chat/history?conversationId=${encodeURIComponent(activeConversationId)}`, { method: "DELETE" })
      setChatHistory([])
    } catch (e) {
      setErr(String(e))
    }
  }

  useEffect(() => {
    loadChatConversations().catch(() => {})
  }, [loadChatConversations])

  useEffect(() => {
    if (activeConversationId) {
      loadChatHistory(activeConversationId).catch(() => {})
    } else {
      setChatHistory([])
    }
  }, [activeConversationId, loadChatHistory])

  const saveConfig = async () => {
    setErr(null)
    setOpMsg(null)
    setLoading(true)
    try {
      await api("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath }),
      })
      await refresh()
      await loadDirectory("")
      setOpMsg("路径已保存")
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  const doNasLogin = async () => {
    setErr(null)
    setOpMsg(null)
    setNasLoading(true)
    try {
      const data = await api<{ ok: boolean; token: string; username: string; baseUrl: string }>("/api/nas/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: nasBaseUrl.trim(),
          username: nasUser.trim(),
          password: nasPass,
          otpCode: nasOtp.trim(),
        }),
      })
      setNasToken(data.token)
      setNasPass("")
      setNasOtp("")
      setOpMsg(`NAS 登录成功：${data.username}`)
      const firstResp = await fetch(`/api/nas/list?path=${encodeURIComponent("/")}`, {
        method: "GET",
        headers: {
          "x-nas-token": data.token,
        },
      })
      if (!firstResp.ok) {
        const j = await firstResp.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error ?? firstResp.statusText)
      }
      const first = (await firstResp.json()) as NasListResp
      setNasCurrentPath(first.currentPath)
      setNasList(first)
    } catch (e) {
      setErr(String(e))
    } finally {
      setNasLoading(false)
    }
  }

  const doNasLogout = async () => {
    if (!nasToken) return
    setNasLoading(true)
    try {
      await nasApi<{ ok: boolean }>("/api/nas/logout", { method: "POST" })
    } catch {
      // ignore
    } finally {
      setNasToken("")
      setNasList(null)
      setNasCurrentPath("/")
      setNasViewerPath("")
      setNasViewerInfo(null)
      setNasViewerError("")
      setNasViewerLoading(false)
      setNasLoading(false)
    }
  }

  const loadNasPath = async (p: string) => {
    setErr(null)
    setNasLoading(true)
    try {
      const data = await nasApi<NasListResp>(`/api/nas/list?path=${encodeURIComponent(p)}`, { method: "GET" })
      setNasCurrentPath(data.currentPath)
      setNasList(data)
    } catch (e) {
      setErr(String(e))
    } finally {
      setNasLoading(false)
    }
  }

  useEffect(() => {
    if (!nasToken || nasList) return
    void loadNasPath(nasCurrentPath || "/")
  }, [nasToken, nasList, nasCurrentPath])

  const goNasParent = async () => {
    if (!nasToken) return
    const current = (nasCurrentPath || "/").replace(/\\/g, "/")
    const normalized = current.replace(/\/+$/, "") || "/"
    if (normalized === "/") return
    const segs = normalized.split("/").filter(Boolean)
    const parent = segs.length <= 1 ? "/" : `/${segs.slice(0, -1).join("/")}`
    await loadNasPath(parent)
  }

  const nasBreadcrumbs = useMemo(() => {
    const current = (nasCurrentPath || "/").replace(/\\/g, "/")
    const normalized = current.startsWith("/") ? current : `/${current}`
    const segs = normalized.split("/").filter(Boolean)
    const out: Array<{ label: string; path: string }> = [{ label: "根目录", path: "/" }]
    let acc = ""
    for (const s of segs) {
      acc += `/${s}`
      out.push({ label: s, path: acc })
    }
    return out
  }, [nasCurrentPath])

  const pullNasFile = async (p: string) => {
    setErr(null)
    setNasLoading(true)
    try {
      const data = await nasApi<{ ok: boolean; localPath: string; fileName: string; size: number }>("/api/nas/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      })
      setOpMsg(`已拉取：${data.fileName} -> ${data.localPath}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setNasLoading(false)
    }
  }

  const previewNasFile = (p: string) => {
    if (!nasToken) {
      setErr("请先登录 NAS")
      return
    }
    setErr(null)
    setNasViewerInfo(null)
    setNasViewerError("")
    setNasViewerLoading(true)
    setNasViewerPath(p)
    nasApi<NasPreviewInfo>(`/api/nas/preview-info?path=${encodeURIComponent(p)}`, { method: "GET" })
      .then((data) => setNasViewerInfo(data))
      .catch((e) => {
        const msg = `预览失败：${String(e)}`
        setErr(msg)
        setNasViewerError(msg)
      })
      .finally(() => setNasViewerLoading(false))
  }

  const previewUrlContent = async () => {
    const u = urlInput.trim()
    if (!u) {
      setErr("请先输入链接")
      return
    }
    setErr(null)
    setUrlLoading(true)
    try {
      const data = await api<UrlPreviewResp>("/api/url/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: u }),
      })
      setUrlPreview(data)
      setOpMsg(`链接读取成功：${data.title}（${data.chars} 字符）`)
    } catch (e) {
      setErr(String(e))
      setUrlPreview(null)
    } finally {
      setUrlLoading(false)
    }
  }

  const ingestUrlContent = async () => {
    if (!urlPreview) {
      setErr("请先点“读取预览”")
      return
    }
    setErr(null)
    setUrlLoading(true)
    try {
      const data = await api<{ ok: boolean; chunkCount: number; embeddedChunks: number; file: { relPath: string } }>(
        "/api/url/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: urlPreview.url,
            title: urlPreview.title,
            text: urlPreview.text,
          }),
        },
      )
      await refresh()
      setOpMsg(`链接已入库：${data.file.relPath}，分块 ${data.chunkCount}，向量 ${data.embeddedChunks}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setUrlLoading(false)
    }
  }

  const runScan = async () => {
    setErr(null)
    setOpMsg(null)
    setLoading(true)
    try {
      await api("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      await refresh()
      await loadDirectory(currentPath)
      setOpMsg("全量扫描完成")
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  const runScanPath = async () => {
    setErr(null)
    setOpMsg(null)
    setLoading(true)
    try {
      await api("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopeRelPath: currentPath }),
      })
      await refresh()
      await loadDirectory(currentPath)
      setOpMsg(`目录已重建索引: ${currentPath || "根目录"}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadDirNodes = useCallback(async (relDir: string) => {
    const normalizedRelDir = relDir.replace(/\\/g, "/")
    setTreeLoadingPath(relDir)
    try {
      const data = await api<FsListResp>(`/api/fs/list?path=${encodeURIComponent(normalizedRelDir)}`)
      setTreeCache((prev) => ({ ...prev, [normalizedRelDir]: data.dirs }))
      return data
    } finally {
      setTreeLoadingPath(null)
    }
  }, [])

  const toggleTreeNode = async (relDir: string) => {
    const normalizedRelDir = relDir.replace(/\\/g, "/")
    if (treeExpanded.has(normalizedRelDir)) {
      setTreeExpanded((prev) => {
        const next = new Set(prev)
        next.delete(normalizedRelDir)
        return next
      })
      return
    }
    if (!treeCache[normalizedRelDir]) {
      await loadDirNodes(normalizedRelDir)
    }
    setTreeExpanded((prev) => new Set(prev).add(normalizedRelDir))
  }

  const loadPreview = async (relPath: string) => {
    const normalizedPath = relPath.replace(/\\/g, "/")
    setSelectedRelPath(normalizedPath)
    setSelectedDirRelPath("")
    setFsRichPreview({ type: "none" })
    setPreviewLoading(true)
    setErr(null)
    try {
      const data = await api<FsPreviewApi>(`/api/fs/preview?path=${encodeURIComponent(normalizedPath)}`)
      if (data.kind === "excel" && Array.isArray(data.sheets)) setFsRichPreview({ type: "excel", sheets: data.sheets })
      else if (data.kind === "pptx" && Array.isArray(data.slides)) setFsRichPreview({ type: "pptx", slides: data.slides })
      else if (data.kind === "image") setFsRichPreview({ type: "image", relPath: normalizedPath, caption: data.preview ?? "图片预览" })
      else setFsRichPreview({ type: "text", text: data.preview ?? "（暂无预览）" })
    } catch (e) {
      setErr(String(e))
    } finally {
      setPreviewLoading(false)
    }
  }

  const reindexSelectedFile = async () => {
    if (!selectedRelPath) return
    setErr(null)
    setOpMsg(null)
    setLoading(true)
    try {
      await api("/api/fs/reindex-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedRelPath }),
      })
      await refresh()
      await loadDirectory(currentPath)
      await loadPreview(selectedRelPath)
      setOpMsg(`文件已重建索引: ${selectedRelPath}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  const doSearch = async () => {
    setErr(null)
    try {
      const data = await api<{ hits: SearchHit[]; vectorEnabled?: boolean; usedVector?: boolean }>(
        `/api/search?q=${encodeURIComponent(q)}`,
      )
      setHits(data.hits)
      setSearchVectorInfo({
        vectorEnabled: !!data.vectorEnabled,
        usedVector: !!data.usedVector,
      })
    } catch (e) {
      setErr(String(e))
    }
  }

  const doChat = async () => {
    const ask = question.trim()
    if (!ask) {
      setChatErr("请输入问题后再生成回答")
      return
    }
    setChatErr(null)
    setErr(null)
    setChatting(true)
    setChatVisualSources([])
    try {
      const conversationId = await ensureActiveConversation()
      const data = await api<{
        answer: string
        sources: ChatSource[]
        visualSources?: ChatVisualSource[]
        historyItem?: ChatHistoryItem
        vectorEnabled?: boolean
        usedVector?: boolean
        vectorError?: string
      }>("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: ask,
          conversationId,
        }),
      })
      setChatVectorInfo({
        vectorEnabled: !!data.vectorEnabled,
        usedVector: !!data.usedVector,
        vectorError: data.vectorError ?? "",
      })
      setChatVisualSources(data.visualSources ?? [])
      if (data.historyItem) {
        const newItem = data.historyItem
        setChatHistory((prev) => [newItem, ...prev.filter((x) => x.id !== newItem.id)])
        loadChatConversations().catch(() => {})
        setQuestion("")
      } else {
        loadChatHistory(conversationId).catch(() => {})
      }
    } catch (e) {
      const raw = String(e)
      const friendly =
        /Failed to fetch|ECONNREFUSED|NetworkError/i.test(raw)
          ? "请求失败：后端服务未连接（127.0.0.1:8787）。请确认 dev server 正在运行。"
          : raw
      setChatErr(friendly)
      setErr(friendly)
      setChatVisualSources([])
    } finally {
      setChatting(false)
    }
  }

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [{ label: "根目录", rel: "" }]
    const segs = currentPath.split(/[\\/]+/).filter(Boolean)
    const out: Array<{ label: string; rel: string }> = [{ label: "根目录", rel: "" }]
    let acc = ""
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s
      out.push({ label: s, rel: acc })
    }
    return out
  }, [currentPath])

  const filteredFiles = useMemo(() => {
    if (!fsList) return []
    if (fileFilter === "all") return fsList.files
    return fsList.files.filter((f) => f.indexStatus === fileFilter)
  }, [fsList, fileFilter])

  const filePagination = useMemo(() => {
    const total = filteredFiles.length
    const totalPages = Math.max(1, Math.ceil(total / FILES_PAGE_SIZE))
    const page = Math.min(Math.max(1, fileListPage), totalPages)
    const start = (page - 1) * FILES_PAGE_SIZE
    const slice = filteredFiles.slice(start, start + FILES_PAGE_SIZE)
    const from = total === 0 ? 0 : start + 1
    const to = total === 0 ? 0 : start + slice.length
    return { total, totalPages, page, slice, from, to }
  }, [filteredFiles, fileListPage])

  useEffect(() => {
    setFileListPage(1)
  }, [currentPath, fileFilter])

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredFiles.length / FILES_PAGE_SIZE))
    if (fileListPage > totalPages) setFileListPage(totalPages)
  }, [filteredFiles.length, fileListPage])

  function statusLabel(s: FsNodeFile["indexStatus"]) {
    switch (s) {
      case "indexed":
        return "已索引"
      case "error":
        return "失败"
      case "skipped":
        return "跳过"
      case "pending":
        return "待处理"
      default:
        return "未索引"
    }
  }

  function statusClass(s: FsNodeFile["indexStatus"]) {
    if (s === "indexed") return "text-emerald-700 bg-emerald-50 border-emerald-200"
    if (s === "error") return "text-rose-700 bg-rose-50 border-rose-200"
    if (s === "skipped") return "text-amber-700 bg-amber-50 border-amber-200"
    if (s === "pending") return "text-sky-700 bg-sky-50 border-sky-200"
    return "text-zinc-700 bg-zinc-50 border-zinc-200"
  }

  const renderTree = (parentRel: string, depth = 0) => {
    const nodes = treeCache[parentRel] ?? []
    if (nodes.length === 0) return null
    return nodes.map((d) => {
      const expanded = treeExpanded.has(d.relPath)
      const selected = currentPath === d.relPath
      const hasLoadedChildren = !!treeCache[d.relPath]
      return (
        <div key={d.relPath}>
          <div
            className={`group flex items-center rounded px-1 py-0.5 text-xs ${
              selected ? "bg-sky-100 text-sky-700" : "hover:bg-muted text-muted-foreground"
            }`}
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
          >
            <button
              type="button"
              className="mr-1 inline-flex size-4 items-center justify-center rounded hover:bg-zinc-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => void toggleTreeNode(d.relPath)}
              title={expanded ? "收起" : "展开"}
              disabled={!d.hasChildren}
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 text-left"
              onClick={() => void loadDirectory(d.relPath)}
              title={d.relPath}
            >
              <Folder className="size-3.5 shrink-0 text-sky-400" />
              <span className="truncate">{d.name}</span>
              {treeLoadingPath === d.relPath ? <span className="text-[10px] text-zinc-400">…</span> : null}
            </button>
          </div>
          {expanded ? (
            hasLoadedChildren ? (
              <div>{renderTree(d.relPath, depth + 1)}</div>
            ) : d.hasChildren ? (
              <div className="text-muted-foreground pl-8 text-[10px]">加载中…</div>
            ) : null
          ) : null}
        </div>
      )
    })
  }

  const openSourceInManager = async (source: ChatSource) => {
    const normalized = source.relPath.replace(/\\/g, "/")
    const parts = normalized.split("/").filter(Boolean)
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ""
    setTab("manage")
    await loadDirectory(dir)
    await loadPreview(normalized)
  }

  const openRawFile = (relPath: string) => {
    const normalized = relPath.replace(/\\/g, "/")
    setRawViewerRelPath(normalized)
    if (canInlineRawPreview(normalized)) {
      setRawViewerPreview({ type: "none" })
      return
    }
    setRawViewerLoading(true)
    setRawViewerPreview({ type: "none" })
    api<FsPreviewApi>(`/api/fs/preview?path=${encodeURIComponent(normalized)}`)
      .then((data) => {
        if (data.kind === "excel" && Array.isArray(data.sheets)) setRawViewerPreview({ type: "excel", sheets: data.sheets })
        else if (data.kind === "pptx" && Array.isArray(data.slides)) setRawViewerPreview({ type: "pptx", slides: data.slides })
        else if (data.kind === "image") setRawViewerPreview({ type: "image", relPath: normalized, caption: data.preview ?? "图片预览" })
        else setRawViewerPreview({ type: "text", text: data.preview ?? "（暂无预览）" })
      })
      .catch((e) => setRawViewerPreview({ type: "text", text: `源文件站内预览失败：${String(e)}` }))
      .finally(() => setRawViewerLoading(false))
  }

  const goParentDirectory = async () => {
    const segs = currentPath.split(/[\\/]+/).filter(Boolean)
    const parent = segs.length > 1 ? segs.slice(0, -1).join("/") : ""
    await loadDirectory(parent)
  }

  const newChatSession = async () => {
    setErr(null)
    try {
      const data = await api<{ item: ChatConversation }>("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: question.trim().slice(0, 32) || "新会话" }),
      })
      const conv = data.item
      setChatConversations((prev) => [conv, ...prev.filter((x) => x.id !== conv.id)])
      setActiveConversationId(conv.id)
    } catch (e) {
      setErr(String(e))
      return
    }
    setQuestion("")
    setChatVisualSources([])
  }

  const chatTurns = useMemo(() => [...chatHistory].reverse(), [chatHistory])
  const activeConversation = useMemo(
    () => chatConversations.find((x) => x.id === activeConversationId) ?? null,
    [chatConversations, activeConversationId],
  )

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatTurns.length, chatting])

  const removeConversationById = async (conversationId: string) => {
    setErr(null)
    try {
      await api(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" })
      const rest = chatConversations.filter((x) => x.id !== conversationId)
      setChatConversations(rest)
      if (activeConversationId === conversationId) {
        setActiveConversationId(rest[0]?.id ?? "")
        setChatHistory([])
      }
    } catch (e) {
      setErr(String(e))
    }
  }

  const onChatInputKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!chatting) doChat()
    }
  }

  const scrollToSection = useCallback((id: string) => {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }, [])

  const jumpToDataSource = useCallback(() => {
    setTab("manage")
    setTimeout(() => scrollToSection("section-datasource"), 60)
  }, [scrollToSection])

  const jumpToOverview = useCallback(() => {
    setTab("overview")
    setTimeout(() => scrollToSection("section-overview"), 50)
  }, [scrollToSection])

  const jumpToManage = useCallback(() => {
    setTab("manage")
    setTimeout(() => scrollToSection("section-manage"), 50)
  }, [scrollToSection])

  const jumpToSearch = useCallback(() => {
    setTab("search")
    setTimeout(() => scrollToSection("section-search"), 50)
  }, [scrollToSection])

  const jumpToChat = useCallback(() => {
    setTab("chat")
    setTimeout(() => scrollToSection("section-chat"), 50)
  }, [scrollToSection])

  const jumpToLinks = useCallback(() => {
    setTab("links")
    setTimeout(() => scrollToSection("section-links"), 50)
  }, [scrollToSection])

  const jumpToNas = useCallback(() => {
    setTab("nas")
    setTimeout(() => scrollToSection("section-nas"), 50)
  }, [scrollToSection])

  const indexStatusMix = useMemo(() => {
    const files = store?.files ?? []
    const by = (s: string) => files.filter((f) => f.status === s).length
    const indexed = by("indexed")
    const pending = by("pending")
    const error = by("error")
    const skipped = by("skipped")
    const unindexed = by("unindexed")
    const other = Math.max(0, files.length - indexed - pending - error - skipped - unindexed)
    const total = Math.max(1, files.length)
    return { indexed, pending, error, skipped, unindexed, other, total }
  }, [store?.files])

  const storeUpdatedLabel = useMemo(() => {
    if (!store?.updatedAt) return "—"
    const d = new Date(store.updatedAt)
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
  }, [store?.updatedAt])

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="flex min-h-screen">
        <aside className="border-border/80 bg-card/75 sticky top-0 h-screen w-[236px] shrink-0 border-r px-3 py-4 backdrop-blur-xl">
          <div className="mb-4 flex items-center gap-2 px-2">
            <PanelLeft className="size-4 text-zinc-500" />
            <div>
              <p className="text-[10px] tracking-widest text-zinc-400 uppercase">NAS Workspace</p>
              <p className="text-sm font-semibold">知识库控制台</p>
            </div>
          </div>
          <div className="space-y-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition-all duration-200 ${
                  tab === t.id
                    ? "bg-primary text-primary-foreground shadow-sm shadow-indigo-200/70"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                }`}
              >
                {t.id === "overview" ? <LayoutDashboard className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.id === "manage" ? <Folder className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.id === "nas" ? <Server className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.id === "links" ? <Link2 className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.id === "search" ? <Search className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.id === "chat" ? <MessageSquare className="size-3.5 shrink-0 opacity-90" /> : null}
                {t.label}
              </button>
            ))}
          </div>
          <div className="border-border mt-4 border-t pt-3">
            <p className="text-muted-foreground mb-2 px-2 text-[11px] font-medium uppercase tracking-wide">快捷跳转</p>
            <div className="space-y-1 px-1">
              <button
                type="button"
                onClick={jumpToOverview}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <LayoutDashboard className="size-3.5 shrink-0" />
                功能概览
              </button>
              <button
                type="button"
                onClick={jumpToDataSource}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <Database className="size-3.5 shrink-0" />
                数据源与连接
              </button>
              <button
                type="button"
                onClick={jumpToNas}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <Server className="size-3.5 shrink-0" />
                NAS 登录
              </button>
              <button
                type="button"
                onClick={jumpToLinks}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <Link2 className="size-3.5 shrink-0" />
                链接采集
              </button>
              <button
                type="button"
                onClick={jumpToManage}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <Layers className="size-3.5 shrink-0" />
                本地文件管理
              </button>
              <button
                type="button"
                onClick={jumpToSearch}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <Search className="size-3.5 shrink-0" />
                关键词检索
              </button>
              <button
                type="button"
                onClick={jumpToChat}
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
              >
                <MessageSquare className="size-3.5 shrink-0" />
                知识问答
              </button>
            </div>
          </div>
          <div className="border-border mt-4 border-t pt-4">
            <p className="text-muted-foreground mb-2 px-2 text-xs">连接状态</p>
            <div className="bg-muted/50 rounded-md px-2 py-2 text-xs">
              <div className="text-muted-foreground flex items-center gap-2">
                <Server className="size-3.5" />
                API: 8787
              </div>
              <div className="text-muted-foreground mt-1">Web: 5174</div>
              {health ? (
                <div className="text-muted-foreground mt-2 space-y-0.5 border-t border-border/60 pt-2 text-[10px] leading-relaxed">
                  <div>MinerU：{health.mineruEnabled ? "已启用" : "未启用"}</div>
                  <div>
                    向量：{health.embedding?.vectorSearchEnabled ? "开" : "关"}
                    {health.embedding?.hasApiKey ? " · 已配 Key" : " · 未配 Key"}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
      <header className="border-border/80 bg-card/70 supports-[backdrop-filter]:bg-card/55 sticky top-0 z-10 border-b px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">NAS 知识库 · 检索与问答</h1>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              本地目录索引、Synology NAS、链接采集入库、关键词与向量检索、多会话 RAG 问答（侧栏可快捷跳转各模块）。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="bg-muted/80 text-muted-foreground rounded-md border border-border/60 px-2 py-0.5 text-[10px]">
                索引块 {store?.chunkCount ?? "—"}
              </span>
              <span className="bg-muted/80 text-muted-foreground rounded-md border border-border/60 px-2 py-0.5 text-[10px]">
                文件 {store?.fileCount ?? "—"}
              </span>
              <span className="bg-muted/80 text-muted-foreground rounded-md border border-border/60 px-2 py-0.5 text-[10px]">
                NAS {nasToken ? "已连" : "未连"}
              </span>
              <span className="bg-muted/80 text-muted-foreground rounded-md border border-border/60 px-2 py-0.5 text-[10px]">
                向量 {health?.embedding?.vectorSearchEnabled ? "开" : "—"}
              </span>
              <span className="bg-muted/80 text-muted-foreground rounded-md border border-border/60 px-2 py-0.5 text-[10px]">
                MinerU {health?.mineruEnabled ? "开" : "关"}
              </span>
            </div>
          </div>
          <div className="text-muted-foreground flex shrink-0 flex-col items-start gap-1 text-xs sm:items-end">
            <div className="flex items-center gap-2">
              <Server className="size-3.5" />
              API 8787 · Web 5174
            </div>
            <div className={`text-[11px] ${nasToken ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
              NAS Web：{nasToken ? `已连接（${nasCurrentPath || "/"})` : "未连接"}
            </div>
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={jumpToOverview}
                className="text-primary text-[11px] hover:underline"
              >
                功能概览
              </button>
              <button
                type="button"
                onClick={jumpToDataSource}
                className="text-primary text-[11px] hover:underline"
              >
                去配置数据源
              </button>
              <button
                type="button"
                onClick={jumpToNas}
                className="text-primary text-[11px] hover:underline"
              >
                NAS 登录页
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] space-y-6 px-5 py-7">
        {err && (
          <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm shadow-sm">
            {err}
          </div>
        )}

        {tab === "overview" && (
          <section
            id="section-overview"
            className="border-border/80 bg-card/88 space-y-5 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <LayoutDashboard className="size-4" />
                  功能概览
                </h2>
                <p className="text-muted-foreground mt-1 max-w-xl text-[11px] leading-relaxed">
                  集中查看知识库运行指标与模块入口；进入本页时会刷新索引摘要与健康检查。
                </p>
              </div>
              <p className="text-muted-foreground font-mono text-[10px]">store 更新 · {storeUpdatedLabel}</p>
            </div>

            <div className="border-border/70 from-muted/25 rounded-xl border bg-gradient-to-br to-card/80 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-foreground flex items-center gap-2 text-xs font-semibold tracking-wide">
                  <Server className="size-3.5 text-sky-600" />
                  运行状态
                </h3>
                <span className="text-muted-foreground text-[10px]">向量 / MinerU / NAS / 本地根路径</span>
              </div>

              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="border-border/60 bg-background/55 rounded-lg border px-3 py-2.5 shadow-sm">
                  <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">索引块</p>
                  <p className="text-foreground mt-0.5 font-mono text-2xl font-semibold tabular-nums">
                    {store?.chunkCount ?? "—"}
                  </p>
                  <p className="text-muted-foreground mt-1 text-[10px]">向量与检索切片总量</p>
                </div>
                <div className="border-border/60 bg-background/55 rounded-lg border px-3 py-2.5 shadow-sm">
                  <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">已登记文件</p>
                  <p className="text-foreground mt-0.5 font-mono text-2xl font-semibold tabular-nums">
                    {store?.fileCount ?? "—"}
                  </p>
                  <p className="text-muted-foreground mt-1 text-[10px]">知识库元数据中的文件条目</p>
                </div>
                <div className="border-border/60 bg-background/55 rounded-lg border px-3 py-2.5 shadow-sm">
                  <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">已成功索引</p>
                  <p className="text-foreground mt-0.5 font-mono text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {indexStatusMix.indexed}
                  </p>
                  <p className="text-muted-foreground mt-1 text-[10px]">
                    占条目{" "}
                    {store?.fileCount
                      ? `${Math.round((indexStatusMix.indexed / Math.max(store.fileCount, 1)) * 100)}%`
                      : "—"}
                  </p>
                </div>
                <div className="border-border/60 bg-background/55 rounded-lg border px-3 py-2.5 shadow-sm">
                  <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">异常 / 跳过</p>
                  <p className="text-foreground mt-0.5 font-mono text-2xl font-semibold tabular-nums">
                    <span className="text-rose-600 dark:text-rose-400">{indexStatusMix.error}</span>
                    <span className="text-muted-foreground mx-0.5 text-lg font-normal">/</span>
                    <span className="text-zinc-500">{indexStatusMix.skipped}</span>
                  </p>
                  <p className="text-muted-foreground mt-1 text-[10px]">失败需排查 · 跳过为策略不上索引</p>
                </div>
              </div>

              <div className="mb-2">
                <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px]">
                  <span>文件状态构成（按 store 内条目）</span>
                  <span>
                    待处理 {indexStatusMix.pending} · 未索引 {indexStatusMix.unindexed}
                    {indexStatusMix.other > 0 ? ` · 其他 ${indexStatusMix.other}` : ""}
                  </span>
                </div>
                <div className="bg-muted/80 flex h-3 w-full overflow-hidden rounded-full border border-border/50">
                  {[
                    { n: indexStatusMix.indexed, className: "bg-emerald-500" },
                    { n: indexStatusMix.pending, className: "bg-amber-400" },
                    { n: indexStatusMix.unindexed, className: "bg-sky-500/80" },
                    { n: indexStatusMix.error, className: "bg-rose-500" },
                    { n: indexStatusMix.skipped, className: "bg-zinc-400 dark:bg-zinc-600" },
                    { n: indexStatusMix.other, className: "bg-violet-500/70" },
                  ].map((seg, i) =>
                    seg.n > 0 ? (
                      <div
                        key={i}
                        className={`h-full min-w-[3px] transition-all ${seg.className}`}
                        style={{ width: `${(seg.n / indexStatusMix.total) * 100}%` }}
                        title={`${seg.n}`}
                      />
                    ) : null,
                  )}
                </div>
                <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                  <span className="flex items-center gap-1">
                    <span className="bg-emerald-500 inline-block size-2 rounded-sm" />
                    已索引 {indexStatusMix.indexed}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="bg-amber-400 inline-block size-2 rounded-sm" />
                    待处理 {indexStatusMix.pending}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="bg-sky-500/80 inline-block size-2 rounded-sm" />
                    未索引 {indexStatusMix.unindexed}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="bg-rose-500 inline-block size-2 rounded-sm" />
                    失败 {indexStatusMix.error}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="bg-zinc-400 inline-block size-2 rounded-sm dark:bg-zinc-600" />
                    跳过 {indexStatusMix.skipped}
                  </span>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div
                  className={`rounded-lg border px-3 py-2.5 ${health?.embedding?.vectorSearchEnabled ? "border-l-[3px] border-l-emerald-500 border-border/70" : "border-l-[3px] border-l-amber-500 border-border/70"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground text-xs font-medium">向量检索</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${health?.embedding?.vectorSearchEnabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/15 text-amber-800 dark:text-amber-200"}`}
                    >
                      {health?.embedding?.vectorSearchEnabled ? "已开启" : "未开启"}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-[10px]">
                    {health?.embedding?.hasApiKey ? "Embedding Key 已配置" : "未检测到 API Key（或走本地模型）"}
                    {health?.embedding?.model ? ` · 模型 ${health.embedding.model}` : ""}
                  </p>
                </div>
                <div
                  className={`rounded-lg border px-3 py-2.5 ${health?.mineruEnabled ? "border-l-[3px] border-l-emerald-500 border-border/70" : "border-l-[3px] border-l-zinc-400 border-border/70"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground text-xs font-medium">MinerU 版式解析</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${health?.mineruEnabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
                    >
                      {health?.mineruEnabled ? "已启用" : "未启用"}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-[10px]">复杂 PDF / 图表管线依赖此项</p>
                </div>
                <div
                  className={`rounded-lg border px-3 py-2.5 ${nasToken ? "border-l-[3px] border-l-emerald-500 border-border/70" : "border-l-[3px] border-l-amber-500 border-border/70"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground text-xs font-medium">NAS Web</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${nasToken ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/15 text-amber-800 dark:text-amber-200"}`}
                    >
                      {nasToken ? "已登录" : "未登录"}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-[10px]">浏览器会话 Token，用于 DSM 文件树与预览</p>
                </div>
                <div
                  className={`rounded-lg border px-3 py-2.5 ${store?.rootPath ? "border-l-[3px] border-l-emerald-500 border-border/70" : "border-l-[3px] border-l-rose-500/80 border-border/70"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground text-xs font-medium">本地索引根路径</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${store?.rootPath ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}
                    >
                      {store?.rootPath ? "已配置" : "未配置"}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 truncate font-mono text-[10px]" title={store?.rootPath ?? ""}>
                    {store?.rootPath || "请先在「数据源与连接」中保存 Windows 映射或 UNC 路径"}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-semibold">
                <Layers className="size-3.5" />
                能力入口
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  type="button"
                  onClick={jumpToDataSource}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <Database className="size-3.5 text-sky-600" />
                    数据源与连接
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">本地根路径与扫描索引配置。</p>
                </button>
                <button
                  type="button"
                  onClick={jumpToNas}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <Server className="size-3.5 text-sky-600" />
                    NAS 登录与浏览
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">DSM 登录、目录浏览、预览与拉取单文件。</p>
                </button>
                <button
                  type="button"
                  onClick={jumpToLinks}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <Link2 className="size-3.5 text-sky-600" />
                    链接采集
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">公众号/网页 URL 读取正文、预览后写入知识库并向量化。</p>
                </button>
                <button
                  type="button"
                  onClick={jumpToManage}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <Folder className="size-3.5 text-sky-600" />
                    本地文件管理
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">目录树、筛选、预览、单文件重建索引。</p>
                </button>
                <button
                  type="button"
                  onClick={jumpToSearch}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <Search className="size-3.5 text-sky-600" />
                    关键词检索
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">命中片段与向量状态（受服务端配置影响）。</p>
                </button>
                <button
                  type="button"
                  onClick={jumpToChat}
                  className="border-border bg-muted/20 hover:bg-muted/40 rounded-xl border p-3 text-left transition-colors"
                >
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <MessageSquare className="size-3.5 text-sky-600" />
                    知识问答（RAG）
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">多会话、引用片段、PDF/MinerU 图表辅助。</p>
                </button>
                <div className="border-border bg-background/50 rounded-xl border p-3">
                  <p className="text-foreground flex items-center gap-2 text-xs font-semibold">
                    <File className="size-3.5 text-zinc-500" />
                    预览说明
                  </p>
                  <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                    PDF/图片接近原件；Office 多为文本与表格摘要；PPT/PPTX 为按页抽取，非放映模式。
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {tab === "manage" && (
        <section
          id="section-datasource"
          className="border-border/80 bg-card/88 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
        >
          <h2 className="mb-1 mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <FolderSync className="size-4" />
            数据源与连接
          </h2>
          <p className="text-muted-foreground mb-3 text-[11px]">本地路径用于索引与文件管理。网页/公众号链接请在侧栏「链接采集」中处理。</p>
          <h3 className="text-muted-foreground mb-2 border-b border-border/50 pb-1 text-xs font-semibold tracking-wide">
            ① 本地 NAS 根路径（索引用）
          </h3>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            Windows 示例：<code className="bg-muted rounded px-1">Z:\咨询资料</code> 或{" "}
            <code className="bg-muted rounded px-1">\\NAS\共享\咨询</code>。运行本服务的账户需对该路径有读权限。
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="border-input bg-background/80 h-10 flex-1 rounded-lg border px-3 text-sm"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="Z:\\Consulting 或 \\\\server\\share\\path"
            />
            <button
              type="button"
              disabled={loading}
              onClick={saveConfig}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 rounded-lg px-4 text-sm font-medium transition-colors"
            >
              保存路径
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={runScan}
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 rounded-lg px-4 text-sm font-medium transition-colors"
            >
              {loading ? "处理中…" : "扫描并建索引"}
            </button>
          </div>
          {store && (
            <p className="text-muted-foreground mt-3 text-xs">
              已索引块：<span className="text-foreground font-mono">{store.chunkCount}</span> · 文件记录：{" "}
              <span className="text-foreground font-mono">{store.fileCount}</span>
              {store.updatedAt ? ` · 更新 ${new Date(store.updatedAt).toLocaleString()}` : ""}
            </p>
          )}
          {opMsg && <p className="mt-2 text-xs text-emerald-400">{opMsg}</p>}
          <div className="border-border/60 mt-4 border-t pt-4">
            <p className="text-muted-foreground text-xs">
              Synology NAS 登录与文件浏览已拆分到侧栏「NAS 登录」独立页面，便于持久登录和单独操作。
            </p>
          </div>
        </section>
        )}

        {tab === "nas" && (
          <section
            id="section-nas"
            className="border-border/80 bg-card/88 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <h2 className="mb-1 mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
              <Server className="size-4" />
              Synology NAS（Web 浏览 / 预览 / 拉取）
            </h2>
            <h4 className="mb-2 mt-3 text-sm font-semibold">File Station 登录</h4>
            <p className="text-muted-foreground mb-2 text-xs">
              使用员工 NAS 账号登录（当前探测可用 {`/webapi/entry.cgi`}），登录后可浏览目录并拉取单文件到本地缓存。
            </p>
            <div className="grid gap-2 md:grid-cols-[1.3fr_1fr_1fr_0.8fr_auto_auto]">
              <input
                className="border-input bg-background/80 h-9 rounded-lg border px-3 text-sm"
                value={nasBaseUrl}
                onChange={(e) => setNasBaseUrl(e.target.value)}
                placeholder="http://27.115.70.62:5000"
              />
              <input
                className="border-input bg-background/80 h-9 rounded-lg border px-3 text-sm"
                value={nasUser}
                onChange={(e) => setNasUser(e.target.value)}
                placeholder="NAS 用户名"
              />
              <input
                className="border-input bg-background/80 h-9 rounded-lg border px-3 text-sm"
                type="password"
                value={nasPass}
                onChange={(e) => setNasPass(e.target.value)}
                placeholder="NAS 密码"
              />
              <input
                className="border-input bg-background/80 h-9 rounded-lg border px-3 text-sm"
                value={nasOtp}
                onChange={(e) => setNasOtp(e.target.value)}
                placeholder="OTP(可选)"
              />
              <button
                type="button"
                disabled={nasLoading}
                onClick={doNasLogin}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-9 rounded-lg px-3 text-sm font-medium transition-colors"
              >
                {nasLoading ? "连接中…" : "登录 NAS"}
              </button>
              <button
                type="button"
                disabled={nasLoading || !nasToken}
                onClick={doNasLogout}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-9 rounded-lg px-3 text-sm font-medium transition-colors disabled:opacity-40"
              >
                退出
              </button>
            </div>
            <p className="text-muted-foreground mt-2 text-xs">
              状态：{nasToken ? `已连接（当前目录 ${nasCurrentPath}）` : "未连接"}
            </p>
            {nasToken && (
              <div className="mt-3 space-y-2">
                <div className="bg-muted/30 rounded border px-2 py-1.5 text-xs">
                  <div className="text-muted-foreground mb-1">当前位置</div>
                  <div className="flex flex-wrap items-center gap-1">
                    {nasBreadcrumbs.map((b, idx) => (
                      <button
                        key={`${b.path}-${idx}`}
                        type="button"
                        onClick={() => void loadNasPath(b.path)}
                        className={`rounded px-1.5 py-0.5 ${
                          b.path === nasCurrentPath
                            ? "bg-sky-100 text-sky-700"
                            : "bg-background hover:bg-muted text-muted-foreground hover:text-foreground"
                        }`}
                        title={b.path}
                      >
                        {idx > 0 ? "/ " : ""}
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold">目录</p>
                      <button
                        type="button"
                        onClick={() => void goNasParent()}
                        disabled={nasLoading || nasCurrentPath === "/"}
                        className="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        返回上一级
                      </button>
                    </div>
                    <ul className="max-h-52 space-y-1 overflow-auto text-xs">
                      {nasList?.dirs?.map((d) => (
                        <li key={d.path} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                          <span className="truncate">{d.name}</span>
                          <button
                            type="button"
                            onClick={() => void loadNasPath(d.path)}
                            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded px-2 py-0.5 text-[11px]"
                          >
                            打开
                          </button>
                        </li>
                      ))}
                      {nasList?.dirs?.length === 0 ? <li className="text-muted-foreground">无子目录</li> : null}
                    </ul>
                  </div>
                  <div className="rounded-lg border p-2">
                    <p className="mb-1 text-xs font-semibold">文件（可拉取）</p>
                    <ul className="max-h-52 space-y-1 overflow-auto text-xs">
                      {nasList?.files?.map((f) => (
                        <li key={f.path} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                          <span className="truncate">{f.name}</span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => previewNasFile(f.path)}
                              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded px-2 py-0.5 text-[11px]"
                            >
                              预览
                            </button>
                            <button
                              type="button"
                              onClick={() => void pullNasFile(f.path)}
                              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded px-2 py-0.5 text-[11px]"
                            >
                              拉取
                            </button>
                          </div>
                        </li>
                      ))}
                      {nasList?.files?.length === 0 ? <li className="text-muted-foreground">无文件</li> : null}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "links" && (
          <section
            id="section-links"
            className="border-border/80 bg-card/88 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <h2 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
              <Link2 className="size-4" />
              链接采集
            </h2>
            <p className="text-muted-foreground mb-4 text-xs leading-relaxed">
              粘贴公众号文章或普通网页 URL，服务端抓取 HTML 并抽取正文；确认无误后可写入知识库并尝试生成向量（依赖服务端 Embedding 配置）。
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="border-input bg-background/80 h-10 flex-1 rounded-lg border px-3 text-sm"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://mp.weixin.qq.com/s/... 或 https://example.com/article"
                onKeyDown={(e) => e.key === "Enter" && void previewUrlContent()}
              />
              <button
                type="button"
                disabled={urlLoading}
                onClick={() => void previewUrlContent()}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 rounded-lg px-4 text-sm font-medium transition-colors"
              >
                {urlLoading ? "读取中…" : "读取预览"}
              </button>
              <button
                type="button"
                disabled={urlLoading || !urlPreview}
                onClick={() => void ingestUrlContent()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-40"
              >
                入库并向量化
              </button>
            </div>
            {urlPreview ? (
              <div className="bg-muted/20 mt-4 space-y-2 rounded-xl border border-border p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-foreground font-medium">{urlPreview.title}</p>
                  <p className="text-muted-foreground text-[11px]">
                    {urlPreview.contentType || "unknown"} · {urlPreview.chars} 字符
                  </p>
                </div>
                <p className="text-muted-foreground text-[11px] break-all">{urlPreview.url}</p>
                <pre className="bg-background/60 max-h-[min(52vh,420px)] overflow-auto rounded-lg border border-border/60 p-3 text-xs leading-relaxed whitespace-pre-wrap">
                  {urlPreview.preview || "（暂无预览）"}
                </pre>
              </div>
            ) : (
              <p className="text-muted-foreground mt-4 text-xs">尚未读取链接。部分站点会拦截爬虫，若失败可换正文页 URL 或稍后重试。</p>
            )}
          </section>
        )}

        {tab === "manage" && (
          <section
            id="section-manage"
            className="border-border/80 bg-card/88 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">可交互文件管理</h2>
                {!store?.rootPath ? (
                  <p className="text-muted-foreground mt-1 text-[11px]">请先在上方「数据源与连接」中保存本地根路径，否则无法列出与索引本地文件。</p>
                ) : (
                  <p className="text-muted-foreground mt-1 text-[11px]">
                    当前根：<span className="text-foreground font-mono">{store.rootPath}</span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void goParentDirectory()}
                  disabled={loading || fsLoading || !currentPath}
                  className="bg-secondary text-secondary-foreground h-8 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  上一级
                </button>
                <button
                  type="button"
                  onClick={() => loadDirectory(currentPath)}
                  disabled={loading || fsLoading}
                  className="bg-secondary text-secondary-foreground h-8 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-secondary/80"
                >
                  刷新目录
                </button>
                <button
                  type="button"
                  onClick={runScanPath}
                  disabled={loading || fsLoading}
                  className="bg-secondary text-secondary-foreground h-8 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-secondary/80"
                >
                  索引当前目录
                </button>
              </div>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
              {breadcrumbs.map((b, idx) => (
                <button
                  key={b.rel || "__root"}
                  type="button"
                  onClick={() => loadDirectory(b.rel)}
                  className="bg-muted text-muted-foreground hover:text-foreground rounded px-2 py-1 transition-colors"
                >
                  {idx > 0 ? "/ " : ""}
                  {b.label}
                </button>
              ))}
            </div>
            {fsLoading && <p className="text-muted-foreground text-xs">读取目录中…</p>}
            {!fsLoading && fsList && (
              <div className="grid gap-4 lg:grid-cols-[280px_1fr_380px]">
                <aside className="border-border bg-background/40 rounded-xl border p-2 shadow-inner">
                  <p className="text-muted-foreground mb-1 px-1 text-[11px]">目录树（Windows 风格）</p>
                  <div className="max-h-[560px] overflow-auto pr-1">
                    <div className={`group flex items-center rounded px-1 py-0.5 text-xs ${currentPath === "" ? "bg-sky-100 text-sky-700" : "hover:bg-muted text-muted-foreground"}`}>
                      <button
                        type="button"
                        className="mr-1 inline-flex size-4 items-center justify-center rounded hover:bg-zinc-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                        onClick={() => void toggleTreeNode("")}
                        title={treeExpanded.has("") ? "收起" : "展开"}
                        disabled={(treeCache[""]?.length ?? 0) === 0}
                      >
                        {treeExpanded.has("") ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1.5 text-left"
                        onClick={() => void loadDirectory("")}
                      >
                        <Folder className="size-3.5 shrink-0 text-sky-400" />
                        <span className="truncate">根目录</span>
                      </button>
                    </div>
                    {treeExpanded.has("") ? <div>{renderTree("", 1)}</div> : null}
                  </div>
                </aside>

                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <p className="text-muted-foreground text-xs">文件筛选</p>
                    <select
                      className="bg-background border-border h-7 rounded-md border px-2 text-xs"
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value as typeof fileFilter)}
                    >
                      <option value="all">全部</option>
                      <option value="indexed">已索引</option>
                      <option value="unindexed">未索引</option>
                      <option value="error">失败</option>
                      <option value="skipped">跳过</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1 grid grid-cols-[1fr_90px] items-center px-2 text-[11px]">
                      <span>文件夹（{fsList.dirs.length}）</span>
                      <span className="text-right">操作</span>
                    </div>
                    <ul className="space-y-1">
                      {fsList.dirs.map((d) => (
                        <li
                          key={d.relPath}
                          className={`rounded border px-2 py-1.5 transition-colors ${
                            selectedDirRelPath === d.relPath
                              ? "border-sky-300 bg-sky-50"
                              : "bg-muted/30 border-border hover:bg-muted/40"
                          }`}
                        >
                          <div className="grid grid-cols-[1fr_90px] items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedDirRelPath(d.relPath)
                                setSelectedRelPath("")
                                setFsRichPreview({ type: "none" })
                              }}
                              onDoubleClick={() => void loadDirectory(d.relPath)}
                              className="flex min-w-0 items-center gap-2 text-left text-sm"
                              title={`${d.relPath}（双击进入）`}
                            >
                              <Folder className="size-4 shrink-0 text-sky-500" />
                              <span className="truncate">{d.name}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void loadDirectory(d.relPath)}
                              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-6 rounded px-2 text-[11px] font-medium transition-colors"
                            >
                              进入
                            </button>
                          </div>
                        </li>
                      ))}
                      {fsList.dirs.length === 0 && <li className="text-muted-foreground text-xs">当前无子目录</li>}
                    </ul>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1 grid grid-cols-[1fr_86px_64px_90px] items-center px-2 text-[11px]">
                      <span>
                        文件（共 {filePagination.total}）
                        {filePagination.total > 0 ? (
                          <span className="text-muted-foreground/80">
                            {" "}
                            · 第 {filePagination.from}–{filePagination.to} 条 · 每页 {FILES_PAGE_SIZE} 条
                          </span>
                        ) : null}
                      </span>
                      <span className="text-right">大小</span>
                      <span className="text-right">分块</span>
                      <span className="text-right">状态</span>
                    </div>
                    <ul className="space-y-1">
                    {filePagination.slice.map((f) => (
                      <li
                        key={f.absPath}
                        className={`rounded border px-2 py-1.5 transition-colors ${
                          selectedRelPath === f.relPath
                            ? "border-sky-300 bg-sky-50"
                            : "bg-muted/30 border-border hover:bg-muted/40"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => loadPreview(f.relPath)}
                          onDoubleClick={() => openRawFile(f.relPath)}
                          className="grid w-full grid-cols-[1fr_86px_64px_90px] items-center gap-2 text-left text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <File className="size-4 shrink-0 text-zinc-400" />
                            <span className="truncate">{f.name}</span>
                          </span>
                          <span className="text-muted-foreground text-right text-xs">{(f.size / 1024).toFixed(1)} KB</span>
                          <span className="text-muted-foreground text-right text-xs">{f.chunkCount}</span>
                          <span
                            className={`ml-auto inline-flex justify-center rounded border px-1.5 py-0.5 text-[10px] ${statusClass(f.indexStatus)}`}
                          >
                            {statusLabel(f.indexStatus)}
                          </span>
                        </button>
                        <div className="text-muted-foreground mt-1 flex items-center gap-2 text-[10px]">
                          <span>{new Date(f.mtime).toLocaleDateString()}</span>
                          {f.indexError ? <span className="text-rose-600 truncate">· {f.indexError}</span> : null}
                        </div>
                      </li>
                    ))}
                    {filePagination.total === 0 && <li className="text-muted-foreground text-xs">当前无文件</li>}
                    </ul>
                    {filePagination.totalPages > 1 && (
                      <div className="border-border/60 mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
                        <span className="text-muted-foreground">
                          第 {filePagination.page} / {filePagination.totalPages} 页
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={filePagination.page <= 1}
                            onClick={() => setFileListPage((p) => Math.max(1, p - 1))}
                            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded-md px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            上一页
                          </button>
                          <button
                            type="button"
                            disabled={filePagination.page >= filePagination.totalPages}
                            onClick={() =>
                              setFileListPage((p) => Math.min(filePagination.totalPages, p + 1))
                            }
                            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded-md px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            下一页
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <aside className="border-border bg-background/50 rounded-xl border p-3 shadow-inner">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">文件详情 / 预览</p>
                    <button
                      type="button"
                      disabled={!selectedRelPath || loading}
                      onClick={reindexSelectedFile}
                      className="bg-secondary text-secondary-foreground h-7 rounded-lg px-2.5 text-xs transition-colors hover:bg-secondary/80"
                    >
                      重建该文件索引
                    </button>
                  </div>
                  {!selectedRelPath && (
                    <p className="text-muted-foreground text-xs">
                      点击左侧文件可预览内容：Excel 为表格、PPT 为按页摘要，其余为文本；可单独重建索引。
                    </p>
                  )}
                  {selectedRelPath && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-muted-foreground break-all text-[11px]">{selectedRelPath}</p>
                        <button
                          type="button"
                          onClick={() => openRawFile(selectedRelPath)}
                          className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-6 shrink-0 rounded px-2 text-[11px] font-medium transition-colors"
                        >
                          打开原文件
                        </button>
                      </div>
                      {previewLoading ? (
                        <p className="text-muted-foreground text-xs">加载预览中…</p>
                      ) : fsRichPreview.type === "excel" ? (
                        <div className="bg-muted/20 max-h-[420px] space-y-3 overflow-auto rounded border border-border p-2">
                          {fsRichPreview.sheets.map((sh) => (
                            <div key={sh.name}>
                              <p className="text-foreground mb-1 text-xs font-semibold">{sh.name}</p>
                              <div className="overflow-x-auto rounded border border-border/80 bg-background/80">
                                <table className="border-border/60 text-xs [&_td]:border-border/50 [&_td]:border-r [&_td]:border-b [&_tr:last-child_td]:border-b-0 min-w-full border-collapse">
                                  <tbody>
                                    {sh.rows.map((row, ri) => (
                                      <tr key={ri}>
                                        {row.map((cell, ci) => (
                                          <td
                                            key={ci}
                                            className="max-w-[220px] px-1.5 py-1 align-top break-words whitespace-pre-wrap"
                                            title={cell}
                                          >
                                            {cell || "\u00a0"}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : fsRichPreview.type === "pptx" ? (
                        <div className="bg-muted/20 max-h-[420px] space-y-2 overflow-auto rounded border border-border p-2">
                          {fsRichPreview.slides.map((s) => (
                            <div
                              key={s.n}
                              className="border-border/80 from-card/60 rounded-lg border bg-gradient-to-b to-transparent p-2.5 shadow-sm"
                            >
                              <p className="text-primary mb-1 text-[11px] font-semibold">第 {s.n} 页</p>
                              <pre className="text-muted-foreground max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                                {s.text}
                              </pre>
                            </div>
                          ))}
                        </div>
                      ) : fsRichPreview.type === "image" ? (
                        <div className="bg-muted/20 space-y-2 rounded border border-border p-2">
                          <p className="text-muted-foreground text-[11px]">{fsRichPreview.caption}</p>
                          <img
                            src={fsImageSrc(fsRichPreview.relPath)}
                            alt=""
                            className="max-h-[380px] w-full rounded object-contain"
                            loading="lazy"
                          />
                        </div>
                      ) : fsRichPreview.type === "text" ? (
                        <pre className="bg-muted/20 max-h-[420px] overflow-auto rounded border border-border p-2 text-xs whitespace-pre-wrap">
                          {fsRichPreview.text || "（暂无预览）"}
                        </pre>
                      ) : (
                        <p className="text-muted-foreground text-xs">（暂无预览）</p>
                      )}
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        )}

        {tab === "search" && (
          <section
            id="section-search"
            className="border-border/80 bg-card/88 rounded-2xl border p-5 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Search className="size-4" />
              关键词检索
            </h2>
            {searchVectorInfo && (
              <p className="text-muted-foreground mb-2 text-xs">
                检索方式：{searchVectorInfo.vectorEnabled ? (searchVectorInfo.usedVector ? "混合检索（关键词+向量）" : "关键词（向量未命中）") : "关键词（向量功能关闭）"}
              </p>
            )}
            <div className="flex gap-2">
              <input
                className="border-input bg-background/80 h-10 flex-1 rounded-lg border px-3 text-sm"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                placeholder="输入关键词…"
              />
              <button
                type="button"
                onClick={doSearch}
                className="bg-secondary text-secondary-foreground h-10 rounded-lg px-4 text-sm font-medium transition-colors hover:bg-secondary/80"
              >
                搜索
              </button>
            </div>
            <ul className="mt-4 space-y-2">
              {hits.map((h) => (
                <li key={h.id} className="border-border bg-muted/30 rounded-lg border px-3 py-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{h.title}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">{h.score} 分</span>
                  </div>
                  {h.relPath && isImageRelPath(h.relPath) ? (
                    <img
                      src={fsImageSrc(h.relPath)}
                      alt=""
                      className="border-border/60 mt-2 max-h-48 w-full rounded border object-contain"
                      loading="lazy"
                    />
                  ) : null}
                  <p className="text-muted-foreground mt-1 line-clamp-3 text-xs">{h.snippet}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === "chat" && (
          <section
            id="section-chat"
            className="border-border/80 bg-card/88 rounded-2xl border p-4 shadow-[0_10px_35px_-20px_rgba(15,23,42,0.35)]"
          >
            <div className="grid h-[72vh] gap-4 lg:grid-cols-[260px_1fr]">
              <aside className="border-border bg-background/50 flex min-h-0 flex-col rounded-xl border p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold">会话</p>
                  <button type="button" onClick={newChatSession} className="text-primary text-xs hover:underline">
                    + 新会话
                  </button>
                </div>
                <div className="mb-2 flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => {
                      loadChatConversations().catch(() => {})
                      if (activeConversationId) loadChatHistory(activeConversationId).catch(() => {})
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    刷新
                  </button>
                  <button type="button" onClick={clearHistory} className="text-rose-600 hover:text-rose-700">
                    清空当前
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-1 overflow-auto">
                  {chatConversations.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-2 ${activeConversationId === c.id ? "border-sky-300 bg-sky-50" : "border-transparent hover:bg-muted/70"}`}
                    >
                      <button type="button" onClick={() => setActiveConversationId(c.id)} className="w-full text-left">
                        <p className="truncate text-xs font-medium">{c.title || "新会话"}</p>
                        <p className="text-muted-foreground mt-0.5 text-[10px]">{new Date(c.updatedAt).toLocaleString()}</p>
                      </button>
                      <div className="mt-1 text-right">
                        <button
                          type="button"
                          className="text-[10px] text-rose-600 hover:text-rose-700"
                          onClick={() => void removeConversationById(c.id)}
                        >
                          删除会话
                        </button>
                      </div>
                    </div>
                  ))}
                  {chatConversations.length === 0 ? <p className="text-muted-foreground text-xs">暂无会话</p> : null}
                </div>
              </aside>
              <div className="border-border bg-background/50 flex min-h-0 flex-col rounded-xl border">
                <div className="border-border flex items-center justify-between border-b px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold">{activeConversation?.title || "新会话"}</p>
                    <p className="text-muted-foreground text-[11px]">
                      {chatVectorInfo?.vectorEnabled
                        ? chatVectorInfo.usedVector
                          ? "混合检索"
                          : "关键词检索（向量未命中）"
                        : "关键词检索（向量关闭）"}
                    </p>
                  </div>
                  {historyLoading ? <span className="text-muted-foreground text-xs">加载中…</span> : null}
                </div>
                <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
                  {chatVisualSources.length > 0 ? (
                    <div className="bg-background/80 rounded-lg border p-2">
                      <p className="text-muted-foreground mb-2 text-xs">语义相关图表（PDF 页图 / MinerU 抽图）</p>
                      <div className="grid gap-2 md:grid-cols-2">
                        {chatVisualSources.map((v) => (
                          <div
                            key={`${v.kind ?? "pdf-page"}-${v.relPath}-${v.page}-${v.figureRel ?? ""}`}
                            className="rounded border p-2"
                          >
                            <p className="mb-1 line-clamp-1 text-[11px] font-medium">
                              {v.relPath}
                              {v.kind === "mineru-figure" ? " · MinerU 图块" : ` · 第 ${v.page} 页`}
                            </p>
                            <p className="text-muted-foreground mb-1 line-clamp-2 text-[11px]">说明：{v.title}</p>
                            <img src={v.imageUrl} alt="" className="max-h-56 w-full rounded border object-contain" loading="lazy" />
                            {v.chartMetaUrl ? (
                              <a
                                href={v.chartMetaUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary mt-1 inline-block text-[11px] underline-offset-2 hover:underline"
                              >
                                查看图表候选(JSON)
                              </a>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {chatTurns.map((item) => (
                    <div key={item.id} className="space-y-2">
                      <div className="flex justify-end">
                        <div className="max-w-[82%]">
                          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap">
                            {item.question}
                          </div>
                          <p className="text-muted-foreground mt-1 text-right text-[10px]">{formatChatTime(item.createdAt)}</p>
                        </div>
                      </div>
                      <div className="flex justify-start">
                        <div className="max-w-[90%]">
                          <div className="bg-muted/40 rounded-2xl rounded-bl-sm border px-3 py-2">
                          <div className="markdown-answer text-sm">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{buildAnswerMarkdown(item.answer, item.sources ?? [])}</ReactMarkdown>
                          </div>
                          {item.sources?.length ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {item.sources.map((s) => (
                                <button
                                  key={`${item.id}-${s.n}`}
                                  type="button"
                                  onClick={() => void openSourceInManager(s)}
                                  className="bg-background hover:bg-muted rounded border px-2 py-1 text-[11px]"
                                  title={s.relPath || s.title}
                                >
                                  [{s.n}] {s.title}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          </div>
                          <p className="text-muted-foreground mt-1 text-[10px]">{formatChatTime(item.createdAt)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {chatTurns.length === 0 && !chatting ? (
                    <p className="text-muted-foreground text-xs">开始提问后，这里会像聊天应用一样连续显示消息。</p>
                  ) : null}
                  {chatting ? (
                    <div className="flex justify-start">
                      <div className="bg-muted/40 text-muted-foreground rounded-2xl rounded-bl-sm border px-3 py-2 text-sm">
                        正在思考中...
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="border-border border-t px-3 py-3">
                  <textarea
                    className="border-input bg-background/90 min-h-20 w-full rounded-lg border px-3 py-2 text-sm"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={onChatInputKeyDown}
                    placeholder="继续追问，Enter 发送，Shift+Enter 换行"
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <p className="text-muted-foreground text-xs">模型参数由服务端 `.env` 托管</p>
                    <button
                      type="button"
                      disabled={chatting}
                      onClick={doChat}
                      className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-60"
                    >
                      {chatting ? "生成中..." : "发送"}
                    </button>
                  </div>
                  {chatErr ? <p className="mt-2 text-xs text-rose-600">{chatErr}</p> : null}
                </div>
              </div>
            </div>
          </section>
        )}

        <footer className="text-muted-foreground text-center text-[11px]">
          MVP：索引存于项目 <code className="bg-muted rounded px-1">data/store.json</code>。生产请换数据库与权限审计。
        </footer>
      </main>
      {rawViewerRelPath && (
        <div className="bg-background/70 fixed inset-0 z-50 flex items-center justify-center p-5 backdrop-blur-sm">
          <div className="bg-card border-border flex h-[86vh] w-[92vw] max-w-[1200px] flex-col rounded-xl border shadow-2xl">
            <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
              <p className="text-sm font-medium">源文件查看</p>
              <div className="flex items-center gap-2">
                {!canInlineRawPreview(rawViewerRelPath) ? (
                  <span className="text-muted-foreground text-xs">该格式浏览器可能无法内嵌预览</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => window.open(fsRawSrc(rawViewerRelPath), "_blank", "noopener,noreferrer")}
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded px-2.5 text-xs"
                >
                  新标签打开
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRawViewerRelPath("")
                    setRawViewerPreview({ type: "none" })
                    setRawViewerLoading(false)
                  }}
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded px-2.5 text-xs"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {canInlineRawPreview(rawViewerRelPath) ? (
                <iframe
                  src={fsRawSrc(rawViewerRelPath)}
                  title="raw-file-viewer"
                  className="h-full w-full rounded-b-xl"
                />
              ) : rawViewerLoading ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">正在加载站内预览…</div>
              ) : rawViewerPreview.type === "excel" ? (
                <div className="bg-muted/20 h-full space-y-3 overflow-auto p-3">
                  {rawViewerPreview.sheets.map((sh) => (
                    <div key={sh.name}>
                      <p className="text-foreground mb-1 text-xs font-semibold">{sh.name}</p>
                      <div className="overflow-x-auto rounded border border-border/80 bg-background/80">
                        <table className="border-border/60 text-xs [&_td]:border-border/50 [&_td]:border-r [&_td]:border-b [&_tr:last-child_td]:border-b-0 min-w-full border-collapse">
                          <tbody>
                            {sh.rows.map((row, ri) => (
                              <tr key={ri}>
                                {row.map((cell, ci) => (
                                  <td key={ci} className="max-w-[220px] px-1.5 py-1 align-top break-words whitespace-pre-wrap" title={cell}>
                                    {cell || "\u00a0"}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              ) : rawViewerPreview.type === "pptx" ? (
                <div className="bg-muted/20 h-full space-y-2 overflow-auto p-3">
                  {rawViewerPreview.slides.map((s) => (
                    <div key={s.n} className="border-border/80 from-card/60 rounded-lg border bg-gradient-to-b to-transparent p-2.5 shadow-sm">
                      <p className="text-primary mb-1 text-[11px] font-semibold">第 {s.n} 页</p>
                      <pre className="text-muted-foreground max-h-52 overflow-auto text-xs whitespace-pre-wrap">{s.text}</pre>
                    </div>
                  ))}
                </div>
              ) : rawViewerPreview.type === "image" ? (
                <div className="bg-muted/20 h-full space-y-2 overflow-auto p-3">
                  <p className="text-muted-foreground text-[11px]">{rawViewerPreview.caption}</p>
                  <img src={fsImageSrc(rawViewerPreview.relPath)} alt="" className="max-h-[72vh] w-full rounded object-contain" loading="lazy" />
                </div>
              ) : rawViewerPreview.type === "text" ? (
                <pre className="bg-muted/20 h-full overflow-auto p-3 text-xs whitespace-pre-wrap">{rawViewerPreview.text || "（暂无预览）"}</pre>
              ) : (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                  该格式暂不支持站内原生渲染，已尝试解析预览；如需原件请点“新标签打开”。
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {nasViewerPath && nasToken && (
        <div className="bg-background/70 fixed inset-0 z-50 flex items-center justify-center p-5 backdrop-blur-sm">
          <div className="bg-card border-border flex h-[86vh] w-[92vw] max-w-[1200px] flex-col rounded-xl border shadow-2xl">
            <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
              <p className="text-sm font-medium">NAS 文件预览：{nasViewerInfo?.fileName ?? "加载中..."}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      `/api/nas/preview?path=${encodeURIComponent(nasViewerPath)}&token=${encodeURIComponent(nasToken)}`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded px-2.5 text-xs"
                >
                  新标签打开
                </button>
                <button
                  type="button"
                  onClick={() => setNasViewerPath("")}
                  className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-7 rounded px-2.5 text-xs"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {nasViewerLoading ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">正在加载 NAS 预览…</div>
              ) : nasViewerError ? (
                <div className="flex h-full items-center justify-center px-4 text-sm text-rose-600">{nasViewerError}</div>
              ) : !nasViewerInfo ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">暂无预览内容</div>
              ) : nasViewerInfo.kind === "pdf" ? (
                <iframe src={nasViewerInfo.previewUrl} title="nas-file-viewer" className="h-full w-full rounded-b-xl" />
              ) : nasViewerInfo.kind === "image" ? (
                <div className="bg-muted/20 h-full overflow-auto p-3">
                  <img src={nasViewerInfo.imageUrl} alt="" className="mx-auto max-h-[78vh] w-auto max-w-full rounded object-contain" />
                </div>
              ) : nasViewerInfo.kind === "excel" ? (
                <div className="bg-muted/20 h-full space-y-3 overflow-auto p-3">
                  {nasViewerInfo.sheets.map((sh) => (
                    <div key={sh.name}>
                      <p className="text-foreground mb-1 text-xs font-semibold">{sh.name}</p>
                      <div className="overflow-x-auto rounded border border-border/80 bg-background/80">
                        <table className="border-border/60 text-xs [&_td]:border-border/50 [&_td]:border-r [&_td]:border-b [&_tr:last-child_td]:border-b-0 min-w-full border-collapse">
                          <tbody>
                            {sh.rows.map((row, ri) => (
                              <tr key={ri}>
                                {row.map((cell, ci) => (
                                  <td key={ci} className="max-w-[220px] px-1.5 py-1 align-top break-words whitespace-pre-wrap" title={cell}>
                                    {cell || "\u00a0"}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              ) : nasViewerInfo.kind === "pptx" ? (
                <div className="bg-muted/20 h-full space-y-2 overflow-auto p-3">
                  {nasViewerInfo.slides.map((s) => (
                    <div key={s.n} className="border-border/80 from-card/60 rounded-lg border bg-gradient-to-b to-transparent p-2.5 shadow-sm">
                      <p className="text-primary mb-1 text-[11px] font-semibold">第 {s.n} 页</p>
                      <pre className="text-muted-foreground max-h-52 overflow-auto text-xs whitespace-pre-wrap">{s.text}</pre>
                    </div>
                  ))}
                </div>
              ) : nasViewerInfo.kind === "text" ? (
                <pre className="bg-muted/20 h-full overflow-auto p-3 text-xs whitespace-pre-wrap">{nasViewerInfo.preview || "（暂无预览）"}</pre>
              ) : (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">{nasViewerInfo.preview}</div>
              )}
            </div>
          </div>
        </div>
      )}
        </div>
      </div>
    </div>
  )
}
