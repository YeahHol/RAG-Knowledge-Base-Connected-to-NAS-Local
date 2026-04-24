# 在 paddle-ocr-bridge 目录下创建 .venv 并安装依赖（Windows）
# Windows CPU 上 Paddle 3.3.x 与 oneDNN 存在已知问题，固定使用 3.2.2 + paddleocr 3.3.3。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
if (-not (Test-Path $py)) {
  Write-Error "未找到 $py ，请先安装 Python 3.12 并勾选 Add to PATH。"
}

& $py -m venv .venv
$pip = Join-Path $root ".venv\Scripts\pip.exe"
& $pip install --upgrade pip
& $pip install "paddlepaddle==3.2.2" -i "https://www.paddlepaddle.org.cn/packages/stable/cpu/"
& $pip install -r (Join-Path $root "requirements.txt")
Write-Host "完成。启动: .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8890"
