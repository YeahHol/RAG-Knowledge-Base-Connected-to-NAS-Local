import type { Express, Request, Response } from "express"
import crypto from "node:crypto"

/** 飞书开放平台 API 根（国内默认 open.feishu.cn，海外可设 https://open.larksuite.com） */
const defaultApiBase = () => String(process.env.FEISHU_API_BASE ?? "https://open.feishu.cn").replace(/\/$/, "")

let tokenCache: { token: string; expireAt: number } | null = null
const recentMessageIds = new Map<string, number>()
const DEDUP_TTL_MS = 120_000
const DEDUP_MAX = 2000

function pruneDedup() {
  const now = Date.now()
  for (const [id, t] of recentMessageIds) {
    if (now - t > DEDUP_TTL_MS) recentMessageIds.delete(id)
  }
  if (recentMessageIds.size > DEDUP_MAX) {
    const entries = [...recentMessageIds.entries()].sort((a, b) => a[1] - b[1])
    for (let i = 0; i < entries.length - DEDUP_MAX; i++) recentMessageIds.delete(entries[i][0])
  }
}

function decryptFeishuPayload(encryptKey: string, encryptBase64: string): string {
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest()
  const buf = Buffer.from(encryptBase64, "base64")
  if (buf.length < 17) throw new Error("encrypt payload too short")
  const iv = buf.subarray(0, 16)
  const data = buf.subarray(16)
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

async function getTenantAccessToken(): Promise<string> {
  const appId = String(process.env.FEISHU_APP_ID ?? "").trim()
  const appSecret = String(process.env.FEISHU_APP_SECRET ?? "").trim()
  if (!appId || !appSecret) throw new Error("未配置 FEISHU_APP_ID / FEISHU_APP_SECRET")

  const now = Date.now()
  if (tokenCache && tokenCache.expireAt > now + 30_000) return tokenCache.token

  const base = defaultApiBase()
  const r = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const j = (await r.json()) as { code?: number; tenant_access_token?: string; expire?: number; msg?: string }
  if (!j.tenant_access_token || (j.code !== undefined && j.code !== 0)) {
    throw new Error(`飞书 tenant_token 失败: ${j.msg ?? JSON.stringify(j)}`)
  }
  const expireSec = Math.max(60, Number(j.expire) || 7200)
  tokenCache = { token: j.tenant_access_token, expireAt: now + expireSec * 1000 }
  return j.tenant_access_token
}

async function feishuReplyText(messageId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken()
  const base = defaultApiBase()
  const body = {
    content: JSON.stringify({ text }),
    msg_type: "text",
  }
  const r = await fetch(`${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string }
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    throw new Error(`飞书回复失败 HTTP ${r.status}: ${j.msg ?? r.statusText}`)
  }
}

function stripFeishuMentions(raw: string): string {
  return raw.replace(/@_user_\d+/g, "").replace(/\s+/g, " ").trim()
}

function flattenAnswerForFeishu(answer: string): string {
  const withoutImages = answer.replace(/!\[[^\]]*]\([^)]+\)/g, "")
  const linksAsText = withoutImages.replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
  const max = Math.min(12000, Math.max(500, Number(process.env.FEISHU_REPLY_MAX_CHARS ?? 12000) || 12000))
  return linksAsText.length > max ? `${linksAsText.slice(0, max)}\n\n…（已截断，完整内容见 Web 端会话）` : linksAsText
}

type FeishuImEventBody = {
  schema?: string
  header?: { event_type?: string; token?: string; app_id?: string }
  event?: {
    sender?: { sender_type?: string }
    message?: {
      message_id?: string
      chat_id?: string
      message_type?: string
      content?: string
    }
  }
  type?: string
  challenge?: string
  token?: string
}

function parseEventBody(raw: unknown): FeishuImEventBody {
  if (raw && typeof raw === "object") return raw as FeishuImEventBody
  return {}
}

export function setupFeishuWebhook(app: Express, ctx: { internalApiBase: string }) {
  const cred = Boolean(String(process.env.FEISHU_APP_ID ?? "").trim() && String(process.env.FEISHU_APP_SECRET ?? "").trim())
  if (cred) {
    console.log(
      "[feishu] 已注册 POST /api/feishu/webhook；请在开放平台订阅 im.message.receive_v1 并填写公网回调 URL（需 HTTPS）",
    )
  }

  app.post("/api/feishu/webhook", async (req: Request, res: Response) => {
    const appId = String(process.env.FEISHU_APP_ID ?? "").trim()
    const appSecret = String(process.env.FEISHU_APP_SECRET ?? "").trim()
    if (!appId || !appSecret) {
      res.status(503).json({ error: "飞书未配置：请设置 FEISHU_APP_ID 与 FEISHU_APP_SECRET" })
      return
    }

    let body = parseEventBody(req.body)
    const encryptKey = String(process.env.FEISHU_ENCRYPT_KEY ?? "").trim()
    const verifyToken = String(process.env.FEISHU_VERIFICATION_TOKEN ?? "").trim()

    if (body && typeof (body as { encrypt?: string }).encrypt === "string") {
      const enc = (body as { encrypt: string }).encrypt
      if (!encryptKey) {
        res.status(500).json({ error: "飞书推送为加密包，请在后台配置 Encrypt Key 并设置环境变量 FEISHU_ENCRYPT_KEY" })
        return
      }
      try {
        const plain = decryptFeishuPayload(encryptKey, enc)
        body = JSON.parse(plain) as FeishuImEventBody
      } catch (e) {
        res.status(400).json({ error: `解密失败: ${e instanceof Error ? e.message : String(e)}` })
        return
      }
    }

    if (body.type === "url_verification") {
      if (verifyToken && body.token !== verifyToken) {
        res.status(403).json({ error: "Verification Token 不匹配" })
        return
      }
      if (typeof body.challenge !== "string") {
        res.status(400).json({ error: "缺少 challenge" })
        return
      }
      res.json({ challenge: body.challenge })
      return
    }

    if (verifyToken && body.header?.token && body.header.token !== verifyToken) {
      res.status(403).json({})
      return
    }

    if (body.schema === "2.0" && body.header?.event_type === "im.message.receive_v1") {
      res.status(200).json({})
      void processImMessageV1(body, ctx.internalApiBase).catch((e) => {
        console.error("[feishu] 处理消息失败:", e)
      })
      return
    }

    res.status(200).json({})
  })
}

async function processImMessageV1(body: FeishuImEventBody, internalApiBase: string) {
  const ev = body.event
  if (!ev?.message?.message_id) return
  if (ev.sender?.sender_type === "app") return

  const mid = ev.message.message_id
  pruneDedup()
  if (recentMessageIds.has(mid)) return
  recentMessageIds.set(mid, Date.now())

  if (ev.message.message_type !== "text") {
    try {
      await feishuReplyText(mid, "当前仅支持文本消息提问，请发送纯文字。")
    } catch (e) {
      console.warn("[feishu] 回复非文本提示失败:", e)
    }
    return
  }

  let question = ""
  try {
    const c = JSON.parse(String(ev.message.content ?? "{}")) as { text?: string }
    question = stripFeishuMentions(String(c.text ?? ""))
  } catch {
    question = ""
  }
  if (!question) return

  const chatId = String(ev.message.chat_id ?? "unknown")
  const conversationId = `feishu:${chatId}`

  const chatUrl = `${internalApiBase.replace(/\/$/, "")}/api/chat`
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, conversationId }),
  })
  const j = (await r.json().catch(() => ({}))) as { error?: string; answer?: string }
  if (!r.ok) {
    await feishuReplyText(mid, `知识库回答失败：${j.error ?? r.statusText}`).catch((e) => console.warn("[feishu]", e))
    return
  }
  const answer = flattenAnswerForFeishu(String(j.answer ?? "（无正文）"))
  await feishuReplyText(mid, answer || "（无正文）")
}
