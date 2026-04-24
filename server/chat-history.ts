import fs from "node:fs/promises"
import path from "node:path"
import { v4 as uuid } from "uuid"

export interface ChatSourceItem {
  n: number
  title: string
  score: number
  relPath: string
}

export interface ChatHistoryItem {
  id: string
  conversationId: string
  question: string
  answer: string
  sources: ChatSourceItem[]
  createdAt: string
}

export interface ChatConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

const DATA_DIR = path.join(process.cwd(), "data")
const CHATS_DIR = path.join(DATA_DIR, "chats")
const CONVERSATIONS_FILE = path.join(CHATS_DIR, "conversations.json")
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, "chat-history.json")
const MAX_HISTORY = 300
const DEFAULT_CONVERSATION_TITLE = "新会话"

function deriveConversationTitle(input?: string): string {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return (normalized || DEFAULT_CONVERSATION_TITLE).slice(0, 80)
}

async function ensureDataDir() {
  await fs.mkdir(CHATS_DIR, { recursive: true })
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDataDir()
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
}

function conversationHistoryFile(conversationId: string) {
  return path.join(CHATS_DIR, `${conversationId}.json`)
}

export async function loadConversations(): Promise<ChatConversation[]> {
  await ensureDataDir()
  const parsed = await readJsonFile<ChatConversation[]>(CONVERSATIONS_FILE, [])
  if (!Array.isArray(parsed)) return []
  return parsed.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

async function saveConversations(items: ChatConversation[]) {
  await writeJsonFile(CONVERSATIONS_FILE, items)
}

export async function createConversation(title = DEFAULT_CONVERSATION_TITLE): Promise<ChatConversation> {
  const items = await loadConversations()
  const now = new Date().toISOString()
  const created: ChatConversation = {
    id: uuid(),
    title: deriveConversationTitle(title),
    createdAt: now,
    updatedAt: now,
  }
  await saveConversations([created, ...items])
  return created
}

export async function removeConversation(conversationId: string): Promise<boolean> {
  const items = await loadConversations()
  const next = items.filter((x) => x.id !== conversationId)
  if (next.length === items.length) return false
  await saveConversations(next)
  await fs.rm(conversationHistoryFile(conversationId), { force: true }).catch(() => {})
  return true
}

async function touchConversation(conversationId: string, defaultTitleFromQuestion?: string) {
  let items = await loadConversations()
  const now = new Date().toISOString()
  const idx = items.findIndex((x) => x.id === conversationId)
  if (idx < 0) {
    const title = deriveConversationTitle(defaultTitleFromQuestion)
    items = [
      {
        id: conversationId,
        title,
        createdAt: now,
        updatedAt: now,
      },
      ...items,
    ]
  } else {
    const existing = items[idx]
    const shouldPromoteTitle =
      existing.title.trim() === DEFAULT_CONVERSATION_TITLE && !!defaultTitleFromQuestion?.trim()
    items[idx] = {
      ...existing,
      title: shouldPromoteTitle ? deriveConversationTitle(defaultTitleFromQuestion) : existing.title,
      updatedAt: now,
    }
    items = [items[idx], ...items.filter((_, i) => i !== idx)]
  }
  await saveConversations(items)
}

async function loadLegacyHistory(): Promise<ChatHistoryItem[]> {
  const parsed = await readJsonFile<Omit<ChatHistoryItem, "conversationId">[]>(LEGACY_HISTORY_FILE, [])
  if (!Array.isArray(parsed)) return []
  return parsed.map((x) => ({ ...x, conversationId: "legacy-default" }))
}

export async function loadChatHistory(conversationId?: string): Promise<ChatHistoryItem[]> {
  await ensureDataDir()
  if (conversationId) {
    const parsed = await readJsonFile<ChatHistoryItem[]>(conversationHistoryFile(conversationId), [])
    if (!Array.isArray(parsed)) return []
    return parsed
  }
  const convs = await loadConversations()
  if (convs.length > 0) {
    const all = await Promise.all(convs.map((x) => loadChatHistory(x.id)))
    return all.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }
  const legacy = await loadLegacyHistory()
  if (legacy.length === 0) return []
  const byConversation = legacy.slice(0, MAX_HISTORY)
  await writeJsonFile(conversationHistoryFile("legacy-default"), byConversation)
  await saveConversations([
    {
      id: "legacy-default",
      title: "历史会话",
      createdAt: byConversation[byConversation.length - 1]?.createdAt ?? new Date().toISOString(),
      updatedAt: byConversation[0]?.createdAt ?? new Date().toISOString(),
    },
  ])
  return byConversation
}

async function saveChatHistory(conversationId: string, items: ChatHistoryItem[]) {
  await writeJsonFile(conversationHistoryFile(conversationId), items)
}

export async function removeChatHistoryItem(id: string, conversationId?: string): Promise<boolean> {
  if (!conversationId) {
    const convs = await loadConversations()
    for (const conv of convs) {
      const ok = await removeChatHistoryItem(id, conv.id)
      if (ok) return true
    }
    return false
  }
  const items = await loadChatHistory(conversationId)
  const next = items.filter((x) => x.id !== id)
  if (next.length === items.length) return false
  await saveChatHistory(conversationId, next)
  await touchConversation(conversationId)
  return true
}

export async function clearChatHistory(conversationId?: string): Promise<void> {
  if (!conversationId) {
    const convs = await loadConversations()
    await Promise.all(convs.map((x) => clearChatHistory(x.id)))
    return
  }
  await saveChatHistory(conversationId, [])
  await touchConversation(conversationId)
}

export async function appendChatHistory(input: {
  conversationId: string
  question: string
  answer: string
  sources: ChatSourceItem[]
}): Promise<ChatHistoryItem> {
  const items = await loadChatHistory(input.conversationId)
  const created: ChatHistoryItem = {
    id: uuid(),
    conversationId: input.conversationId,
    question: input.question,
    answer: input.answer,
    sources: input.sources,
    createdAt: new Date().toISOString(),
  }
  const next = [created, ...items].slice(0, MAX_HISTORY)
  await saveChatHistory(input.conversationId, next)
  await touchConversation(input.conversationId, input.question)
  return created
}
