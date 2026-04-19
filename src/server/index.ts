import http from "http";
import express, { Request, Response } from "express";
import readline from "readline";
import { exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../config";
import { eventBus } from "../monitor/EventBus";
import { SessionRegistry } from "../monitor/SessionRegistry";
import { WsBroadcaster } from "./WsBroadcaster";
import { createHooksRouter } from "../wrapper/HooksAdapter";
import { createOtelRouter } from "../wrapper/OtelAdapter";
import { JournalWatcher } from "../wrapper/JournalWatcher";
import { makeLogger } from "./logger";
import { AccountInfo } from "../types";
import { mergeHistory, ReportSession, ClauditorSession } from "./historyMerge";

function readAccountInfo(): AccountInfo | undefined {
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
    const oauth = raw?.claudeAiOauth;
    if (!oauth) return undefined;
    return {
      subscriptionType: String(oauth.subscriptionType ?? "unknown"),
      rateLimitTier: String(oauth.rateLimitTier ?? "unknown"),
    };
  } catch { return undefined; }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) log.warn("could not open browser", { message: err.message }); });
}

const log = makeLogger("TelemetryServer");

const app = express();
app.use(express.json());
app.use(createHooksRouter());
app.use(createOtelRouter(config.otel_enabled));
app.use("/dashboard", express.static(path.join(__dirname, "../frontend/browser")));

const server = http.createServer(app);
const broadcaster = new WsBroadcaster(server, readAccountInfo());

const registry = new SessionRegistry(
  config,
  (state) => broadcaster.broadcastSessionUpdate(state),
  (severity, state) => broadcaster.broadcastCheckpoint(severity, state),
  (sessionId) => broadcaster.broadcastSessionRemoved(sessionId),
);

eventBus.on("event", (e) => registry.route(e));

const journalWatcher = new JournalWatcher();
journalWatcher.start();

const SHUTDOWN_GRACE_MS = 3_000;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info("shutting down cleanly");
  console.log("\n[Claude Pulse] Shutting down — port released.");
  journalWatcher.stop();
  registry.destroy();
  broadcaster.close();
  server.close(() => { log.info("port released"); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}

broadcaster.onNoClients(() => {
  if (shutdownTimer || isShuttingDown) return;
  log.info("no clients — shutting down in 3s");
  console.log("[Claude Pulse] Browser closed — shutting down in 3s...");
  shutdownTimer = setTimeout(shutdown, SHUTDOWN_GRACE_MS);
});

broadcaster.onNewClient(() => {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.post("/abort/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params["sessionId"] as string;
  const states = registry.getAllStates();
  const before = states.find(s => s.session_id === sessionId);
  const ok = registry.markStopped(sessionId);
  if (ok) {
    log.warn("abort requested", { session_id: sessionId, had_pid: before?.pid != null });
    res.json({ ok: true, killed: before?.pid != null });
  } else {
    res.status(404).json({ error: "session not found" });
  }
});

// ── Checkpoint button ────────────────────────────────────
const pendingCheckpoints = new Set<string>();

function runGitCheckpoint(projectPath: string, sessionId: string): void {
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const cmd = `git -C "${projectPath}" add -A && git -C "${projectPath}" commit -m "checkpoint: ${ts}" --allow-empty && git -C "${projectPath}" push`;
  exec(cmd, (err, stdout, stderr) => {
    if (err) log.warn("git checkpoint failed", { session_id: sessionId, message: err.message, stderr });
    else log.info("git checkpoint pushed", { session_id: sessionId, stdout: stdout.trim() });
  });
}

app.post("/checkpoint/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params["sessionId"] as string;
  const states = registry.getAllStates();
  const session = states.find(s => s.session_id === sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!session.project_path) return res.status(400).json({ error: "project path unknown" });

  const activeStates: Array<typeof session.lifecycle> = ["running", "tool_use", "thinking"];
  if (activeStates.includes(session.lifecycle)) {
    pendingCheckpoints.add(sessionId);
    log.info("checkpoint queued (session active)", { session_id: sessionId });
    return res.json({ status: "queued" });
  }

  runGitCheckpoint(session.project_path, sessionId);
  res.json({ status: "ok" });
});

// Drain queued checkpoints when a session goes idle
broadcaster.onSessionUpdate((state) => {
  if (!pendingCheckpoints.has(state.session_id)) return;
  const activeStates: Array<typeof state.lifecycle> = ["running", "tool_use", "thinking"];
  if (!activeStates.includes(state.lifecycle) && state.project_path) {
    pendingCheckpoints.delete(state.session_id);
    log.info("checkpoint draining queued", { session_id: state.session_id });
    runGitCheckpoint(state.project_path, state.session_id);
  }
});

// ── History endpoint ─────────────────────────────────────
let historyCache: { data: unknown; expires: number } | null = null;

function execJson<T>(cmd: string): Promise<T> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      try { resolve(JSON.parse(stdout) as T); }
      catch (e) { reject(e); }
    });
  });
}

app.get("/api/history", async (_req: Request, res: Response) => {
  if (historyCache && Date.now() < historyCache.expires) {
    return res.json(historyCache.data);
  }
  try {
    const [report, sessions] = await Promise.all([
      execJson<{ sessions: ReportSession[] }>("clauditor report --json").then(r => r.sessions ?? []),
      execJson<ClauditorSession[]>("clauditor sessions --json"),
    ]);
    const data = mergeHistory(report, sessions);
    historyCache = { data, expires: Date.now() + 10_000 };
    res.json(data);
  } catch (err) {
    log.warn("history fetch failed", { message: (err as Error).message, stderr: (err as any).stderr });
    res.status(500).json({ error: "clauditor unavailable" });
  }
});

async function promptFrontend(): Promise<"browser" | "terminal" | "both"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(
      "\nWhich dashboard?\n  [1] Browser\n  [2] Terminal\n  [3] Both\n\nChoice: ",
      (answer) => {
        rl.close();
        if (answer === "2") resolve("terminal");
        else if (answer === "3") resolve("both");
        else resolve("browser");
      }
    );
  });
}

async function main() {
  const choice = await promptFrontend();
  server.listen(config.server_port, () => {
    log.info("HTTP server started", { port: config.server_port });
    log.info("WebSocket server started", { port: config.ws_port });
    console.log(`\n[Claude Pulse] Server running on http://localhost:${config.server_port}`);
    console.log(`[Claude Pulse] WebSocket on ws://localhost:${config.ws_port}`);
    if (choice === "browser" || choice === "both") {
      const dashUrl = `http://localhost:${config.server_port}/dashboard`;
      console.log(`[Claude Pulse] Browser dashboard → ${dashUrl}`);
      openBrowser(dashUrl);
    }
    console.log(`[Claude Pulse] Active Claude sessions will auto-register on first hook event.`);
    if (choice === "terminal" || choice === "both") {
      console.log(`[Claude Pulse] Starting terminal dashboard...`);
      const termPath = "../frontend/terminal/index";
      import(/* webpackIgnore: true */ termPath).catch((err: Error) => log.error("terminal dashboard failed to load", { message: err.message }));
    }
  });
  server.on("error", (err) => log.error("HTTP server error", { message: err.message }));
}

main().catch(console.error);
