import http from "http";
import express from "express";
import readline from "readline";
import { config } from "../config";
import { eventBus } from "../monitor/EventBus";
import { SessionStore } from "../monitor/SessionStore";
import { WsBroadcaster } from "./WsBroadcaster";
import { createHooksRouter } from "../wrapper/HooksAdapter";
import { createOtelRouter } from "../wrapper/OtelAdapter";
import path from "path";

const app = express();
app.use(express.json());
app.use(createHooksRouter());
app.use(createOtelRouter(config.otel_enabled));
app.use("/dashboard", express.static(path.join(__dirname, "../frontend/browser")));

const server = http.createServer(app);
const broadcaster = new WsBroadcaster(server);
const store = new SessionStore(config);

// Wire EventBus → SessionStore
eventBus.on("event", (e) => store.apply(e));

// Wire SessionStore → Broadcaster
store.on("state_updated", (state) => {
  broadcaster.setState(state);
});

// Wire checkpoint events → Broadcaster
store.on("checkpoint_suggested", (state) => {
  broadcaster.broadcastCheckpoint("suggested", state);
});
store.on("checkpoint_mandatory", (state) => {
  broadcaster.broadcastCheckpoint("mandatory", state);
});

// Tick loop — broadcasts deltas on interval
let tickInterval: ReturnType<typeof setInterval>;
function startTick() {
  const ms = store.getState().activity_state === "active"
    ? config.refresh_active_ms
    : config.refresh_idle_ms;
  clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    broadcaster.broadcastDelta(store.getState());
    // Re-evaluate tick rate
    const newMs = store.getState().activity_state === "active"
      ? config.refresh_active_ms
      : config.refresh_idle_ms;
    if (newMs !== ms) startTick();
  }, ms);
}

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
    console.log(`\n[LiveVisualUsage] Server running on http://localhost:${config.server_port}`);
    console.log(`[LiveVisualUsage] WebSocket on ws://localhost:${config.ws_port}`);
    if (choice === "browser" || choice === "both") {
      console.log(`[LiveVisualUsage] Browser dashboard → http://localhost:${config.server_port}/dashboard`);
    }
    if (choice === "terminal" || choice === "both") {
      console.log(`[LiveVisualUsage] Starting terminal dashboard...`);
      // Dynamic import — terminal module added in Task 8; path kept as string to avoid compile-time resolution
      const termPath = "../frontend/terminal/index";
      import(/* webpackIgnore: true */ termPath).catch(console.error);
    }
  });
  startTick();
}

main().catch(console.error);
