@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo [WARN] .env not found. Copy .env.example to .env and fill credentials first.
)
echo HTTP endpoint: http://127.0.0.1:8000/mcp (loopback only)
python serve_http.py --host 127.0.0.1 --port 8000
