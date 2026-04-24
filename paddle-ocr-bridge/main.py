"""
与 nas-rag-app 的 OCR_HTTP 约定对齐的最小服务：POST /ocr
Body: { "imageBase64", "mimeType", "label" } -> { "text": "..." }

需本机已安装 PaddlePaddle + paddleocr（见 README）。
"""

from __future__ import annotations

import base64
import io
import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from PIL import Image
import numpy as np

app = FastAPI(title="nas-rag-app PaddleOCR bridge", version="0.1.0")

_ocr_engine: Any = None

BRIDGE_TOKEN = os.environ.get("OCR_BRIDGE_TOKEN", "").strip()
PADDLE_OCR_LANG = (os.environ.get("PADDLE_OCR_LANG", "ch") or "ch").strip()


class OcrRequest(BaseModel):
    imageBase64: str = Field(..., description="图片 base64")
    mimeType: str = Field("image/png", description="仅用于日志，解码统一走 Pillow")
    label: str = Field("", description="可选，来自扫描端")


def _auth_ok(request: Request) -> bool:
    if not BRIDGE_TOKEN:
        return True
    auth = request.headers.get("authorization") or ""
    return auth == f"Bearer {BRIDGE_TOKEN}"


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is not None:
        return _ocr_engine
    try:
        from paddleocr import PaddleOCR
    except ImportError as e:
        raise RuntimeError(
            "未安装 paddleocr / paddlepaddle。请先按 paddle-ocr-bridge/README.md 安装。"
        ) from e

    kwargs: dict[str, Any] = {"lang": PADDLE_OCR_LANG}
    try:
        _ocr_engine = PaddleOCR(use_angle_cls=True, **kwargs)
    except TypeError:
        _ocr_engine = PaddleOCR(**kwargs)
    return _ocr_engine


def _rec_texts_from_page(page: Any) -> list[str]:
    """PaddleOCR 3.x：list[OCRResult]，含 rec_texts。"""
    if page is None:
        return []
    if isinstance(page, dict):
        rec = page.get("rec_texts") or []
        return [str(x) for x in rec] if isinstance(rec, list) else [str(rec)]
    rec = getattr(page, "rec_texts", None)
    if isinstance(rec, list) and rec:
        return [str(x) for x in rec]
    if isinstance(rec, str) and rec:
        return [rec]
    return []


def _flatten_paddle_result(result: Any) -> str:
    """兼容 OCRResult 列表（PaddleOCR 3.x）与旧版 det-rec 嵌套 list。"""
    if result is None:
        return ""
    if isinstance(result, dict):
        for key in ("rec_texts", "texts", "text"):
            if key in result and result[key]:
                v = result[key]
                if isinstance(v, list):
                    return "\n".join(str(x) for x in v).strip()
                return str(v).strip()
        return ""

    if not isinstance(result, list) or len(result) == 0:
        return ""

    lines: list[str] = []
    for page in result:
        chunk = _rec_texts_from_page(page)
        if chunk:
            lines.extend(chunk)
            continue
        if not isinstance(page, list):
            continue
        for item in page:
            if item is None or not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            rec = item[1]
            if isinstance(rec, (list, tuple)) and len(rec) > 0:
                lines.append(str(rec[0]))
            elif isinstance(rec, str):
                lines.append(rec)
            else:
                lines.append(str(rec))
    return "\n".join(lines).strip()


@app.get("/health")
def health():
    return {"ok": True, "lang": PADDLE_OCR_LANG}


@app.post("/ocr")
async def ocr_endpoint(request: Request, body: OcrRequest):
    if not _auth_ok(request):
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    try:
        raw = base64.b64decode(body.imageBase64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64")

    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="cannot decode image")

    arr = np.array(img)
    ocr = _get_ocr()

    try:
        pred = getattr(ocr, "predict", None)
        if callable(pred):
            out = pred(arr)
        else:
            out = ocr.ocr(arr)
    except TypeError:
        try:
            out = ocr.ocr(arr)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ocr failed: {e!s}") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ocr failed: {e!s}") from e

    if isinstance(out, list):
        text = _flatten_paddle_result(out)
    else:
        text = _flatten_paddle_result([out] if out is not None else [])
    return {"text": text, "label": body.label}
