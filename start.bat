@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

REM Uncomment to pin a model and ignore whatever MCM is set to:
REM set FORCE_MODEL=flash

REM Fallback when the mod sends an unknown tag (flash / flash-3 / pro):
REM set GEMINI_MODEL=flash

node server.js
pause
