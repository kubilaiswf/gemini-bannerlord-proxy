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

REM How many gemini CLI processes to keep pre-spawned per model. Hides the
REM ~2-5s CLI boot from each request, at the cost of ~150 MB RAM each.
REM Set to 0 to disable and spawn cold every time (old behaviour).
REM set GEMINI_POOL_SIZE=1

node server.js
pause
