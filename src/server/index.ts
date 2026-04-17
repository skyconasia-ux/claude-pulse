import http from "http";
import express, { Request, Response } from "express";
import readline from "readline";
import { exec } from "child_process";
import { config } from "../config";
import { eventBus } from "../monitor/EventBus";
import { SessionRegistry } from "../monitor/SessionRegistry";
import { WsBroadcaster } from "./WsBroadcaster";
import { createHooksRouter } from "../wrapper/HooksAdapter";
import { createOtelRouter } from "../wrapper/OtelAdapter";
import { JournalWatcher } from "../wrapper/JournalWatcher";
import { makeLogger } from "./logger";
import path from "path";

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
const broadcaster = new WsBroadcaster(server);

const registry = new SessionRegistry(
  config,
  (state) => broadcaster.broadcastSessionUpdate(state),
  (severity, state) => broadcaster.broadcastCheckpoint(severity, state),
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
  console.log("\n[LiveVisualUsage] Shutting down — port released.");
  journalWatcher.stop();
  registry.destroy();
  broadcaster.close();
  server.close(() => { log.info("port released"); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}

broadcaster.onNoClients(() => {
  if (shutdownTimer || isShuttingDown) return;
  log.info("no clients — shutting down in 3s");
  console.log("[LiveVisualUsage] Browser closed — shutting down in 3s...");
  shutdownTimer = setTimeout(shutdown, SHUTDOWN_GRACE_MS);
});

broadcaster.onNewClient(() => {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.post("/abort/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params["sessionId"] as string;
  const ok = registry.markStopped(sessionId);
  if (ok) {
    log.warn("abort requested", { session_id: sessionId });
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "session not found" });
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
    console.log(`\n[LiveVisualUsage] Server running on http://localhost:${config.server_port}`);
    console.log(`[LiveVisualUsage] WebSocket on ws://localhost:${config.ws_port}`);
    if (choice === "browser" || choice === "both") {
      const dashUrl = `http://localhost:${config.server_port}/dashboard`;
      console.log(`[LiveVisualUsage] Browser dashboard → ${dashUrl}`);
      openBrowser(dashUrl);
    }
    console.log(`[LiveVisualUsage] Active Claude sessions will auto-register on first hook event.`);
    if (choice === "terminal" || choice === "both") {
      console.log(`[LiveVisualUsage] Starting terminal dashboard...`);
      const termPath = "../frontend/terminal/index";
      import(/* webpackIgnore: true */ termPath).catch((err: Error) => log.error("terminal dashboard failed to load", { message: err.message }));
    }
  });
  server.on("error", (err) => log.error("HTTP server error", { message: err.message }));
}

main().catch(console.error);
