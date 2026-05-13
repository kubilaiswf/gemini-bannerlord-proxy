# gemini-bannerlord-proxy

A tiny local HTTP server that lets the **[AI Influence](https://www.nexusmods.com/mountandblade2bannerlord/mods/9711) mod** for *Mount & Blade II: Bannerlord* talk to **Google Gemini** via the official **Gemini CLI** — so NPC dialogue, dynamic events and diplomatic statements are powered by your **Google account / Gemini subscription** instead of an OpenAI / OpenRouter / DeepSeek API bill.

The proxy impersonates an [Ollama](https://ollama.com/) server on `localhost:11434`. The mod thinks it's talking to a local Llama; under the hood every request is forwarded to `gemini -p` and the response is reformatted back into Ollama's wire format.

> Companion project: [claude-bannerlord-proxy](https://github.com/kubilaiswf/claude-bannerlord-proxy) — same idea but for Claude Pro / Max.

---

## Requirements

- **Windows** (tested on Win 11; should work on macOS / Linux with minor PATH tweaks)
- **[Node.js](https://nodejs.org/) 20+**
- **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** installed and logged in: `npm install -g @google/gemini-cli` then run `gemini` once to do the browser OAuth login with your Google account
- A **Google account** (the free tier works — see [Gemini CLI quotas](https://github.com/google-gemini/gemini-cli#quotas-and-limits) for the per-minute / per-day limits). Paid Gemini plans raise the limits.
- **Mount & Blade II: Bannerlord** with the **[AI Influence](https://www.nexusmods.com/mountandblade2bannerlord/mods/9711)** mod installed and enabled

---

## Setup

```powershell
git clone https://github.com/kubilaiswf/gemini-bannerlord-proxy.git
cd gemini-bannerlord-proxy
npm install
```

That's the whole install. Double-click **`start.bat`** to launch the proxy — it installs deps the first time and then runs `node server.js`. Leave the console window open while you play.

You should see:

```
=====================================================
 Gemini -> Ollama proxy for Bannerlord AIInfluence
=====================================================
 Listening on  http://127.0.0.1:11434
 Gemini bin    C:\Program Files\nodejs\node.exe ...\@google\gemini-cli\dist\index.js
 Default model flash (gemini-2.5-flash-lite)
 ...
```

### Configure the mod

In Bannerlord → **Options → Mod Options → AI Influence → API Settings**:

| Field                | Value                              |
|----------------------|------------------------------------|
| AI Provider          | `Ollama`                           |
| Ollama API URL       | `http://localhost:11434` (default) |
| Ollama Model         | `gemini-flash:latest`              |

For the model field, any of these work:

| Model tag                  | Underlying Gemini model      | Speed   | Use case                          |
|----------------------------|------------------------------|---------|-----------------------------------|
| `gemini-flash:latest`      | Gemini 2.5 Flash Lite        | Fastest | Action-heavy playthroughs         |
| `gemini-flash-3:latest`    | Gemini 3 Flash (preview)     | Balanced | Default for chatty campaigns     |
| `gemini-pro:latest`        | Gemini 3 Pro (preview)       | Slowest | Story-focused roleplay            |

You can change the model in MCM mid-game; the proxy honors whatever the mod sends per request — no restart needed.

### How model selection actually works

The model name field in MCM is **just a string** that gets forwarded to the proxy on every request. The proxy then decides which real Gemini model to call by walking this precedence list, top to bottom:

1. **`FORCE_MODEL` env var** — if set (e.g. `set FORCE_MODEL=flash` in `start.bat`), it wins every time and the mod's choice is ignored. Useful when you want to pin one model and forget MCM exists.
2. **Whatever the mod sent in the request** — the proxy looks for the substrings `pro`, `flash-3`/`flash3`, or `flash` in the model field, in that order. So `gemini-pro:latest`, `gemini-pro`, `pro-rp`, even `My-Custom-Pro-Build` all route to Pro.
3. **Full model ID passthrough** — if the field starts with `gemini-` and doesn't match an alias (e.g. `gemini-2.5-flash-lite`), it's passed to the CLI as-is. Use this if you want to pin a specific Gemini build.
4. **`GEMINI_MODEL` env var** — fallback when the mod sent nothing recognizable. Defaults to `flash`.

Practical examples:

| What you type in MCM "Ollama Model"      | Proxy calls                  |
|------------------------------------------|------------------------------|
| `gemini-flash:latest`                    | gemini-2.5-flash-lite        |
| `gemini-flash-3:latest`                  | gemini-3-flash-preview       |
| `gemini-pro:latest` *(recommended for RP)* | gemini-3-pro-preview       |
| `gemini-2.5-flash`                       | That exact build             |
| *(empty or `llama3`)*                    | `GEMINI_MODEL` fallback (Flash by default) |

If you set `FORCE_MODEL=pro` in `start.bat`, all of the above route to Pro regardless.

The proxy logs the picked model on every request — e.g. `model=gemini-flash:latest -> gemini-2.5-flash-lite` — so if something feels off, check the console.

---

## Configuration (environment variables)

Set these in `start.bat` before `node server.js`, e.g. `set GEMINI_MODEL=pro`.

| Variable                 | Default       | What it does                                                                  |
|--------------------------|---------------|-------------------------------------------------------------------------------|
| `PORT`                   | `11434`       | TCP port to listen on                                                         |
| `HOST`                   | `127.0.0.1`   | Bind address                                                                  |
| `GEMINI_MODEL`           | `flash`       | Fallback model when the mod sends nothing or an unknown tag                   |
| `FORCE_MODEL`            | (unset)       | If set, **always** use this model regardless of what the mod requests         |
| `GEMINI_TIMEOUT_MS`      | `120000`      | Hard timeout for a single CLI call                                            |
| `GEMINI_CLI_JS`          | (auto-detect) | Override the path to `@google/gemini-cli/dist/index.js`                       |

---

## How it works

```
┌────────────────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│ Bannerlord             │        │ This proxy           │        │ Gemini CLI         │
│ ─ AI Influence mod     │  POST  │ Express on :11434    │  spawn │ gemini -p ""       │
│ ─ "I think I'm talking │─────▶ │ Ollama-shaped routes │──────▶ │ (uses your Google  │
│    to Ollama"          │        │ /api/chat            │        │  OAuth token in    │
│                        │ ◀───── │ /api/generate        │ ◀───── │  ~/.gemini/        │
│                        │  JSON  │ /api/tags ...        │ stdout │  oauth_creds.json) │
└────────────────────────┘        └──────────────────────┘        └────────────────────┘
                                                                            │ HTTPS
                                                                            ▼
                                                                generativelanguage.googleapis.com
```

The mod uses either the new `/api/chat` (structured `messages` array) or the legacy `/api/generate` (single prompt string) Ollama endpoints. Both are implemented. Streaming is supported in single-chunk form.

Per request the proxy:

1. Parses out a system prompt and the user-facing prompt.
2. Concatenates them with a `---` separator (the Gemini CLI has no `--system-prompt` flag in headless mode; this is the cleanest way to inject role/world context).
3. Spawns `node <path>\@google\gemini-cli\dist\index.js -p "" --output-format json --model <picked> --yolo`.
4. Pipes the full concatenated payload to the child's stdin (keeps us under Windows' ~32 KB command-line arg limit).
5. Parses the resulting JSON, takes `.response`, returns it in Ollama format.

A few flags are load-bearing:

- `-p ""` — triggers headless / non-interactive mode without putting the prompt on the command line.
- `--yolo` — auto-approves any tool call so the CLI never blocks on a confirmation prompt. NPC dialogue doesn't need tools, but the model may still attempt one; we just want it to fail open rather than hang.
- `--output-format json` — single JSON object with the response in `.response` (much easier to parse than text mode).
- On Windows the proxy spawns `node index.js` directly instead of `gemini.cmd`, because Node 20+ refuses to `spawn()` `.cmd` files without `shell: true` (the EINVAL bug).

---

## Latency

Rough numbers on a stock dev machine, with a representative 50 KB system prompt from the mod:

| Model            | Wall time per NPC reply |
|------------------|-------------------------|
| Flash Lite (2.5) | **~5–8 s**              |
| Flash (3 preview) | **~7–10 s**            |
| Pro (3 preview)  | ~15–25 s                |

About **2 seconds** of every request is unavoidable Gemini CLI cold-start overhead (load bundle, settings, OAuth check). The rest is actual model inference. Flash Lite is the closest to "interactive feel" for action-heavy playthroughs.

If you want sub-second replies you'd need to either:

1. Switch `runGemini()` to use `@google/genai` directly with an API key (skips the CLI entirely, costs per-token).
2. Keep a long-lived Gemini CLI session alive and feed it requests over its stdin. Doable; not implemented here.

---

## Caveats & gotchas

- **Free-tier quotas.** Gemini CLI's free tier has per-minute and per-day request caps. A long Bannerlord session with chatty NPCs can drain them. The proxy will surface quota errors as `{"error": "..."}` responses; the mod typically retries or falls back. Bump to a paid Gemini plan if it bites.
- **Prompt length.** The mod can send 50 KB+ system context. We pipe it via stdin so the Windows command-line arg limit is not a concern, but the model's own context window still applies. Gemini Pro / Flash both have huge context windows so this rarely matters.
- **Global `GEMINI.md` bleed-through.** If you have a `~/.gemini/GEMINI.md` with personal instructions (e.g. "always respond in Markdown with code comments"), the CLI may auto-load it and contaminate NPC dialogue. If NPCs start sounding like a coding assistant, check that file.
- **No request queueing.** Each incoming HTTP request spawns its own `gemini` process. If the mod fires multiple parallel requests, they all spawn at once. Modern machines handle 3–5 concurrent fine; more, and you'll start swapping.

---

## Troubleshooting

| Symptom                                                          | Cause / fix                                                                                       |
|------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| Proxy starts, mod says "connection failed"                       | Make sure Ollama URL in MCM is exactly `http://localhost:11434` (no trailing slash, http not https) |
| `Error: spawn EINVAL`                                            | `gemini.cmd` couldn't be found; set `GEMINI_CLI_JS` env var to the absolute path of `dist/index.js` |
| `Approval mode "plan" is only available when experimental.plan is enabled` | You have an older `start.bat` / `server.js`; pull the latest — we switched to `--yolo`     |
| Every reply mentions "as an AI" / refuses to roleplay            | Your `GEMINI.md` may be telling Gemini to disclaim AI status; trim or move it                      |
| "Quota exceeded" / 429                                            | Free-tier limit hit; wait a minute or set `FORCE_MODEL=flash` to use the cheaper tier              |
| Replies take 30+ s and the mod times out                          | Probably picked Pro for a chatty scene. Set `FORCE_MODEL=flash` in `start.bat`.                    |

Look at the proxy console — every request is logged with model, prompt length and total ms.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Google, TaleWorlds, or the AI Influence mod author.
