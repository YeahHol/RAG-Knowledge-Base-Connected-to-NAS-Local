# NAS 知识检索 · 问答 MVP（`nas-rag-app`）

类似 **ima / 晓智能** 的最小闭环：**连 NAS（UNC 或映射盘）→ 扫描抽取 → 关键词检索 → 基于检索片段调用大模型 API 回答**。

## 功能

- **NAS**：填写本机可读的根路径（如 `Z:\资料` 或 `\\NAS\share\咨询`），由 Node 直接读文件（需运行用户对路径有权限）。
- **格式（常见办公与文本）**：`.pdf` `.doc` `.docx` `.txt` `.md` `.xlsx` **`.xls`** `.pptx` 与图片 `.png` `.jpg` `.jpeg` `.webp`（单文件 >40MB 默认跳过扫描）。`.doc` 用 [word-extractor](https://www.npmjs.com/package/word-extractor)；`.xls/.xlsx` 用 SheetJS 抽成表格文本；**`.csv` `.tsv` `.json` `.html` `.xml` `.yaml` `.rtf` 及常见源码扩展名**（`.py` `.js` `.ts` `.java` `.go` …）按 UTF-8 读入，HTML/XML/SVG 会粗去标签便于检索。旧版 **`.ppt`**、**`.pages`** 等未接入。  
- **MinerU（可选）**：仅当 `.env` 中 **`MINERU_ENABLED=true`** 且本机能运行 **`mineru`**（或配置了 `MINERU_API_URL` 等）时，对 **PDF、PPTX** 会**先**调 MinerU 抽 Markdown；否则**不会调用**，自动用内置 `pdf-parse` / PPTX 解压逻辑。启动后端时控制台会打印一行 `MinerU: 已启用/未启用`；也可看 `GET /api/health` 的 `mineruEnabled` 字段。
- **索引**：分块后写入项目内 `data/store.json`（MVP，生产请换数据库）。
- **检索**：Fuse.js 模糊搜索。
- **问答**：`/api/chat` 先检索 Top 片段，再由服务端请求 **OpenAI 兼容** `POST /v1/chat/completions`（可改 base URL 对接内网网关、通义、DeepSeek 等）。

## 运行

```bash
cd nas-rag-app
npm install
npm run dev
```

- 后端：<http://127.0.0.1:8787>  
- 前端：<http://127.0.0.1:5174>（已代理 `/api`）

在根目录创建 `.env` 并配置（见 `.env.example`）：

- `OPENAI_API_KEY`（必填）
- `OPENAI_BASE_URL`（可选，默认 `https://api.openai.com/v1`）
- `OPENAI_MODEL`（可选，默认 `gpt-4o-mini`）
- `ENABLE_OCR`（可选，默认 `true`）
- `OCR_PROVIDER`（可选：`tesseract` | `http` | `off`；若配置了 `OCR_HTTP_URL` 且未写本项，则默认使用 `http`）
- `OCR_LANG`（可选，默认 `chi_sim+eng`，仅 `tesseract` 生效）
- `OCR_LANG_PATH`（可选，默认 `https://tessdata.projectnaptha.com/4.0.0`，仅 `tesseract`：语言包下载基址）
- `OCR_HTTP_URL` / `OCR_HTTP_TOKEN`（可选，`http` 模式：内网 OCR 网关地址与鉴权）
- `ENABLE_PDF_OCR`（可选，默认 `true`，PDF 文本较少时自动做页面 OCR）
- `PDF_OCR_ALWAYS`（可选，默认 `false`，设为 `true` 时 PDF 始终叠加 OCR）
- `PDF_OCR_MAX_PAGES`（可选，默认 `5`，限制每个 PDF 的 OCR 页数）
- `PDF_OCR_MAX_FILE_MB`（可选，默认 `12`，超过该大小的 PDF 不做逐页渲染 OCR）
- `EMBED_CONCURRENCY`（可选，默认 `4`：扫描时同一文件内多个文本块请求向量接口的并发数；原先串行请求，文件多时会极慢）
- `MINERU_ENABLED` / `MINERU_CLI` / `MINERU_API_URL` / `MINERU_METHOD` / `MINERU_BACKEND` / `MINERU_LANG` / `MINERU_TIMEOUT_MS`（可选，见下文「MinerU」）

### HTTP OCR 网关（可选，替代 Tesseract）

当 `OCR_PROVIDER=http`（或已配置 `OCR_HTTP_URL`）时，本服务对每张待识别图片向 `OCR_HTTP_URL` 发送 **POST**，`Content-Type: application/json`，请求体示例：

```json
{ "imageBase64": "<PNG 的 base64>", "mimeType": "image/png", "label": "pdf-page-1" }
```

若设置了 `OCR_HTTP_TOKEN`，会附带请求头 `Authorization: Bearer <token>`。

网关应返回 **JSON**，且至少包含以下之一（字符串）：`text`、`result`，或 `data.text`。也接受纯文本响应体。适合内网用 **PaddleOCR**、**阿里云/腾讯云 OCR** 等封装一层，避免本机 tessdata 与 Node 版本带来的兼容问题。

**仓库内已带 PaddleOCR 最小桥接**（Python 子项目，与上述协议一致）：见 [`paddle-ocr-bridge/README.md`](./paddle-ocr-bridge/README.md)。开源模型在本机或内网跑，Node 侧只配 `OCR_HTTP_URL` 即可，无需把 Paddle 写进 `npm` 依赖。

### MinerU（可选，PDF + PPTX）

[MinerU](https://github.com/opendatalab/MinerU) 可将 **PDF、PPTX**（及官方支持的 Office/图片）解析为 **Markdown**，表格与复杂版式通常优于「纯文本 + 简单 OCR」。

1. 按 [MinerU 文档](https://opendatalab.github.io/MinerU/usage/cli_tools/) 在本机安装 `mineru` 命令行（或配置常驻 `mineru-api` 后填 `MINERU_API_URL`）。  
2. 在 `.env` 中设置 `MINERU_ENABLED=true`，可选：`MINERU_CLI`（默认可执行文件 `mineru`）、`MINERU_API_URL`、`MINERU_METHOD`（`auto` / `txt` / `ocr`）、`MINERU_BACKEND`、`MINERU_LANG`、`MINERU_TIMEOUT_MS`。  
3. 扫描/抽取 **`.pdf`、`.pptx`** 时会先调用 MinerU；若失败或未启用，则自动回退到原有 `pdf-parse` / PPTX 解压逻辑。

## 安全说明（必读）

- 当前版本采用 **服务端密钥托管**：前端不接触 API Key。生产仍建议对接 **SSO + 权限审计 + 密钥轮换**。  
- 扫描路径请使用 **只读账号**，并对敏感目录做 **白名单**（后续可加）。

## 与你们主项目的关系

可与 `consulting-kb-demo`、PandaWiki 思路并行：此处负责 **NAS 原件侧管线**；门户与权限可逐步替换为正式栈。

## 快速演示数据

仓库内可自带轻量样例（若存在）：

- `demo-data/客户A/制造业MES可研摘要.md`
- `demo-data/客户B/医疗信息化方案.txt`
- `demo-data/内部方法论/供应链控制塔白皮书.md`
- `demo-data/法务与制度/AI投标使用边界.txt`
- `demo-data/DEMO-CASES.md`（建议提问与期望结果）

你也可以把 **真实资料目录** 指到 `demo-data`（或任意路径）。请注意：

- **当前支持的扩展名**：办公类见上；另含 **`.csv` `.tsv` `.json` `.jsonl` `.html` `.xml` `.yaml` `.rtf` `.mdx` 及多种源码后缀**（详见 `server/extract.ts` 中 `PLAIN_TEXT_EXT`）。**`.ppt`（PowerPoint 97–2003）** 仍不支持，请另存为 `.pptx`。  
- **删除或移走 `~$` 开头的文件**（Word/PPT 打开时产生的临时锁文件），否则会当作文档去解压/OCR，容易报错。  
- **大批量、大体积 PDF**：默认对「单文件超过 `PDF_OCR_MAX_FILE_MB`」的 PDF **不做逐页渲染 OCR**（仍保留 `pdf-parse` 文本层）；需要整页 OCR 时可调大该值或启用 **MinerU**，批量扫描时也可暂时设 `ENABLE_PDF_OCR=false` 减轻本机压力。

演示时可把根路径填为：`d:\test1st\nas-rag-app\demo-data`（按你本机实际路径调整）。
