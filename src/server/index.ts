import http from "http";
import express, { Request, Response } from "express";
import readline from "readline";
import { config } from "../config";
import { eventBus } from "../monitor/EventBus";
import { SessionRegistry } from "../monitor/SessionRegistry";
import { WsBroadcaster } from "./WsBroadcaster";
import { createHooksRouter } from "../wrapper/HooksAdapter";
import { createOtelRouter } from "../wrapper/OtelAdapter";
import { makeLogger } from "./logger";
import path from "path";

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
      console.log(`[LiveVisualUsage] Browser dashboard → http://localhost:${config.server_port}/dashboard`);
    }
    if (choice === "terminal" || choice === "both") {
      console.log(`[LiveVisualUsage] Starting terminal dashboard...`);
      const termPath = "../frontend/terminal/index";
      import(/* webpackIgnore: true */ termPath).catch((err: Error) => log.error("terminal dashboard failed to load", { message: err.message }));
    }
  });
  server.on("error", (err) => log.error("HTTP server error", { message: err.message }));
}

main().catch(console.error);
