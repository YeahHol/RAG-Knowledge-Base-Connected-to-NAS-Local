# PaddleOCR 桥接服务（嵌入本仓库）

PaddleOCR 是 **Python + PaddlePaddle** 项目，不能作为普通 npm 依赖打进 Node 进程。本目录把 **开源推理** 放在同仓库里，用 **小 HTTP 服务** 对接 `nas-rag-app` 已有的 `OCR_HTTP_URL` 协议，相当于把「它的做法」嵌进你们的交付物里，而不是嵌进 `node_modules`。

## 能力边界

- 使用 **PP-OCR 系列**通用检测+识别（`PaddleOCR(...).ocr(...)`），适合图片、PDF 渲页后的文字提取。
- **不包含** PaddleOCR-VL / PP-StructureV3 整页 Markdown 文档解析（依赖与算力更重，需要可另起官方管线）。

## 安装

1. Python 3.8–3.12，建议使用虚拟环境。
2. 安装 **paddlepaddle**（Windows CPU 建议使用 **3.2.2**，避免 3.3.x 在部分机器上出现 oneDNN `NotImplementedError`）：

```powershell
cd paddle-ocr-bridge
.\.venv\Scripts\pip install paddlepaddle==3.2.2 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
.\.venv\Scripts\pip install -r requirements.txt
```

或在本仓库执行一键脚本（需已安装 Python 3.12 并在默认路径）：

```powershell
cd paddle-ocr-bridge
.\scripts\install.ps1
```

3. 首次下载模型若访问 HuggingFace 超时，可在启动前设置：`$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True"`（将走 ModelScope 等备用源）。

首次运行会从模型源下载权重，需能访问模型站或按 PaddleOCR 文档配置镜像。

## 运行

```bash
cd paddle-ocr-bridge
set OCR_BRIDGE_TOKEN=你的可选密钥
set PADDLE_OCR_LANG=ch
python -m uvicorn main:app --host 127.0.0.1 --port 8890
```

## 与 nas-rag-app 对接

在 `nas-rag-app` 根目录 `.env`：

```env
ENABLE_OCR=true
OCR_PROVIDER=http
OCR_HTTP_URL=http://127.0.0.1:8890/ocr
OCR_HTTP_TOKEN=与 OCR_BRIDGE_TOKEN 相同（若桥接开了鉴权）
```

扫描/抽取时，Node 端会把 PNG 的 base64 POST 到本服务，响应中的 `text` 会写回索引。

## 接口说明

- `POST /ocr`：请求体与主项目 README 中「HTTP OCR 网关」一致；响应 `{ "text": "...", "label": "..." }`。
- `GET /health`：健康检查。

## 许可

桥接代码为本项目补充；PaddleOCR 与模型遵循其官方开源许可（见 [PaddleOCR 仓库](https://github.com/PaddlePaddle/PaddleOCR)）。
