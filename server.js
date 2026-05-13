import express from "express";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 11434);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "flash";
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120_000);

const MODEL_ALIASES = {
  flash: "gemini-2.5-flash-lite",
  "flash-3": "gemini-3-flash-preview",
  pro: "gemini-3-pro-preview",
};

function resolveGeminiLauncher() {
  // 1. Explicit override
  if (process.env.GEMINI_CLI_JS && fs.existsSync(process.env.GEMINI_CLI_JS)) {
    return { cmd: process.execPath, baseArgs: [process.env.GEMINI_CLI_JS], shell: false };
  }

  if (os.platform() === "win32") {
    // 2. Read the .cmd shim and parse the real JS/EXE target out of it. This
    // is the most reliable method because it works for non-standard npm
    // prefixes (nvm-windows, scoop, custom --prefix, etc.).
    try {
      const where = spawnSync("where", ["gemini.cmd"], { encoding: "utf8" });
      const line = where.stdout.split(/\r?\n/).find((l) => l.trim().endsWith(".cmd"));
      if (line) {
        const cmdPath = line.trim();
        const cmdDir = path.dirname(cmdPath);
        const contents = fs.readFileSync(cmdPath, "utf8");
        // Pull out every quoted path-with-extension that mentions node_modules
        // (skips the node.exe self-reference in npm-generated shims). Expand
        // %dp0% / %~dp0 to the shim's directory.
        const matches = [...contents.matchAll(/"([^"]+node_modules[^"]+\.(?:js|exe))"/gi)];
        for (const m of matches) {
          const resolved = m[1].replace(/%~?dp0%\\?/gi, cmdDir + path.sep);
          if (fs.existsSync(resolved)) {
            if (resolved.toLowerCase().endsWith(".js")) {
              return { cmd: process.execPath, baseArgs: [resolved], shell: false };
            }
            return { cmd: resolved, baseArgs: [], shell: false };
          }
        }
        // Couldn't extract a usable target from the shim. Spawn the .cmd via
        // shell:true so cmd.exe handles it. Safe because our big payload
        // (the prompt) goes via stdin, not as an argument.
        return { cmd: `"${cmdPath}"`, baseArgs: [], shell: true };
      }
    } catch {}

    // 3. Known static install paths as a fallback (npm default prefix).
    const npmRoots = [
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@google", "gemini-cli"),
      path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@google", "gemini-cli"),
    ];
    for (const root of npmRoots) {
      if (!fs.existsSync(root)) continue;
      const jsCandidates = [
        path.join(root, "dist", "index.js"),
        path.join(root, "dist", "src", "gemini.js"),
        path.join(root, "bin", "gemini.js"),
        path.join(root, "index.js"),
      ];
      for (const p of jsCandidates) {
        if (fs.existsSync(p)) return { cmd: process.execPath, baseArgs: [p], shell: false };
      }
    }
  }

  // 4. Last resort: hope `gemini` is in PATH and let the shell find it.
  return { cmd: "gemini", baseArgs: [], shell: true };
}

const GEMINI_LAUNCHER = resolveGeminiLauncher();

const ADVERTISED_MODELS = [
  { tag: "gemini-flash:latest", alias: "flash" },
  { tag: "gemini-flash-3:latest", alias: "flash-3" },
  { tag: "gemini-pro:latest", alias: "pro" },
];

const app = express();
app.use(express.json({ limit: "20mb" }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Map whatever the mod sends to a real Gemini model ID.
// FORCE_MODEL pins one model and ignores the mod's choice.
// Otherwise: try keyword matches, then full passthrough, then DEFAULT_MODEL.
function pickModelId(requestedModel) {
  const force = process.env.FORCE_MODEL;
  if (force) return MODEL_ALIASES[force] || force;
  if (!requestedModel) return MODEL_ALIASES[DEFAULT_MODEL] || DEFAULT_MODEL;
  const m = String(requestedModel).toLowerCase();
  if (m.includes("pro")) return MODEL_ALIASES.pro;
  if (m.includes("flash-3") || m.includes("flash3")) return MODEL_ALIASES["flash-3"];
  if (m.includes("flash")) return MODEL_ALIASES.flash;
  if (m.startsWith("gemini-")) return requestedModel;
  return MODEL_ALIASES[DEFAULT_MODEL] || DEFAULT_MODEL;
}

function splitMessages(messages) {
  const systemParts = [];
  const convo = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg.content !== "string") continue;
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user") {
      convo.push(`Human: ${msg.content}`);
    } else if (msg.role === "assistant") {
      convo.push(`Assistant: ${msg.content}`);
    }
  }
  return {
    system: systemParts.join("\n\n").trim(),
    userPrompt: convo.join("\n\n").trim(),
  };
}

function runGemini({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    const effectiveSystem = system && system.trim().length > 0
      ? system
      : "You are roleplaying inside a Mount and Blade: Bannerlord scene. Follow the instructions in the user message and respond directly in character. Do not mention being an AI, an assistant, tools, or coding. Reply only with the in-character text the game expects.";

    // Gemini CLI has no --system-prompt flag in headless mode. Prepend the
    // system text to the user prompt with a clear marker. Whole payload goes
    // via stdin (-p "" triggers headless mode without putting the prompt on
    // the command line, which would hit Windows' ~32 KB arg-length limit).
    const stdinPayload = effectiveSystem + "\n\n---\n\n" + (prompt || "");

    // --yolo auto-approves any tool call so the CLI never blocks on a
    // confirmation prompt (NPC dialogue doesn't need tools, but the model may
    // still attempt one — we just want it not to hang).
    const cliArgs = [
      "-p", "",
      "--output-format", "json",
      "--model", model,
      "--yolo",
    ];

    // In shell:true mode, cmd.exe collapses bare empty-string args, which
    // would turn `-p ""` into `-p` (no value) and break headless mode.
    // Replace empties with explicit literal "".
    const useShell = GEMINI_LAUNCHER.shell === true;
    const spawnArgs = useShell
      ? [...GEMINI_LAUNCHER.baseArgs, ...cliArgs].map((a) => a === "" ? '""' : a)
      : [...GEMINI_LAUNCHER.baseArgs, ...cliArgs];

    const child = spawn(GEMINI_LAUNCHER.cmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new Error(`gemini CLI timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        reject(new Error(`gemini exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(`gemini error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          return;
        }
        const text = typeof parsed.response === "string" ? parsed.response : "";
        resolve({ text: String(text).trim(), raw: parsed });
      } catch (err) {
        reject(new Error(`failed to parse gemini output: ${err.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });

    child.stdin.end(stdinPayload, "utf8");
  });
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("Ollama is running");
});

app.get("/api/version", (_req, res) => {
  res.json({ version: "0.1.50-gemini-proxy" });
});

app.get("/api/tags", (_req, res) => {
  const now = new Date().toISOString();
  res.json({
    models: ADVERTISED_MODELS.map(({ tag }) => ({
      name: tag,
      model: tag,
      modified_at: now,
      size: 0,
      digest: "sha256:gemini",
      details: {
        parent_model: "",
        format: "gguf",
        family: "gemini",
        families: ["gemini"],
        parameter_size: "N/A",
        quantization_level: "N/A",
      },
    })),
  });
});

app.post("/api/show", (req, res) => {
  const name = req.body?.name || "gemini-flash:latest";
  res.json({
    modelfile: `# Gemini proxy: ${name}`,
    parameters: "",
    template: "{{ .Prompt }}",
    details: {
      parent_model: "",
      format: "gguf",
      family: "gemini",
      families: ["gemini"],
      parameter_size: "N/A",
      quantization_level: "N/A",
    },
  });
});

app.post("/api/chat", async (req, res) => {
  const { model, messages, stream } = req.body || {};
  const geminiModel = pickModelId(model);
  const { system, userPrompt } = splitMessages(messages);

  console.log(`  -> /api/chat model=${model} -> ${geminiModel}, msgs=${messages?.length ?? 0}, stream=${!!stream}, sysLen=${system.length}, promptLen=${userPrompt.length}`);
  const t0 = Date.now();

  try {
    const { text } = await runGemini({ system, prompt: userPrompt, model: geminiModel });
    const dt = Date.now() - t0;
    console.log(`  <- /api/chat done in ${dt}ms, replyLen=${text.length}`);
    const now = new Date().toISOString();

    if (stream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.write(JSON.stringify({
        model: model || "gemini-flash:latest",
        created_at: now,
        message: { role: "assistant", content: text },
        done: false,
      }) + "\n");
      res.write(JSON.stringify({
        model: model || "gemini-flash:latest",
        created_at: now,
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        total_duration: dt * 1_000_000,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: dt * 1_000_000,
      }) + "\n");
      res.end();
    } else {
      res.json({
        model: model || "gemini-flash:latest",
        created_at: now,
        message: { role: "assistant", content: text },
        done: true,
        done_reason: "stop",
        total_duration: dt * 1_000_000,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: dt * 1_000_000,
      });
    }
  } catch (err) {
    console.error("  !! /api/chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/generate", async (req, res) => {
  const { model, prompt, system, stream } = req.body || {};
  const geminiModel = pickModelId(model);

  console.log(`  -> /api/generate model=${model} -> ${geminiModel}, stream=${!!stream}, sysLen=${(system||"").length}, promptLen=${(prompt||"").length}`);
  const t0 = Date.now();

  try {
    const { text } = await runGemini({ system: system || "", prompt: prompt || "", model: geminiModel });
    const dt = Date.now() - t0;
    console.log(`  <- /api/generate done in ${dt}ms`);
    const now = new Date().toISOString();

    if (stream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.write(JSON.stringify({
        model: model || "gemini-flash:latest",
        created_at: now,
        response: text,
        done: false,
      }) + "\n");
      res.write(JSON.stringify({
        model: model || "gemini-flash:latest",
        created_at: now,
        response: "",
        done: true,
        done_reason: "stop",
        total_duration: dt * 1_000_000,
        load_duration: 0,
      }) + "\n");
      res.end();
    } else {
      res.json({
        model: model || "gemini-flash:latest",
        created_at: now,
        response: text,
        done: true,
        done_reason: "stop",
        total_duration: dt * 1_000_000,
        load_duration: 0,
      });
    }
  } catch (err) {
    console.error("  !! /api/generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  console.log(`  ?? unhandled ${req.method} ${req.url}`);
  res.status(404).json({ error: "not found" });
});

app.listen(PORT, HOST, () => {
  console.log("=====================================================");
  console.log(" Gemini -> Ollama proxy for Bannerlord AIInfluence");
  console.log("=====================================================");
  console.log(` Listening on  http://${HOST}:${PORT}`);
  console.log(` Gemini bin    ${GEMINI_LAUNCHER.cmd} ${GEMINI_LAUNCHER.baseArgs.join(" ")}`);
  console.log(` Default model ${DEFAULT_MODEL} (${MODEL_ALIASES[DEFAULT_MODEL] || DEFAULT_MODEL})`);
  console.log("");
  console.log(" In Bannerlord MCM > AIInfluence:");
  console.log("   Provider     = Ollama");
  console.log(`   API URL      = http://localhost:${PORT}`);
  console.log("   Model        = gemini-flash:latest   (fast, cheapest)");
  console.log("                  gemini-flash-3:latest (balanced)");
  console.log("                  gemini-pro:latest     (smartest, slowest)");
  console.log("");
  console.log(" Logs from each request appear below. Ctrl+C to stop.");
  console.log("-----------------------------------------------------");
});
