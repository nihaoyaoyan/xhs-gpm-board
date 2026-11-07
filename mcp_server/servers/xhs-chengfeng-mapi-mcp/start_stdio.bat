@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo [WARN] .env not found. Copy .env.example to .env and fill credentials first.
)
echo Starting MCP over stdio. Normally the IDE launches this, not a human.
python server.py
