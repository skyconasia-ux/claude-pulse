import blessed from "blessed";
import contrib from "blessed-contrib";
import WebSocket from "ws";
import { SessionState, WsMessage } from "../../types";

const WS_URL = "ws://localhost:3001";
const BURN_HISTORY_SIZE = 30;

const screen = blessed.screen({ smartCSR: true, title: "Claude Pulse" });
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

const burnChart = grid.set(0, 0, 6, 8, contrib.bar, {
  label: " BURN RATE (tok/turn) ",
  barWidth: 4,
  barSpacing: 2,
  xOffset: 0,
  maxHeight: 100,
  style: { bar: { bg: "cyan" }, text: "cyan", baseline: "black" },
  border: { type: "line", fg: "cyan" },
});

const metricsBox = grid.set(0, 8, 6, 4, blessed.box, {
  label: " METRICS ",
  border: { type: "line", fg: "cyan" },
  style: { fg: "cyan" },
  tags: true,
  content: "Loading...",
});

const predictionBox = grid.set(6, 0, 4, 6, blessed.box, {
  label: " PREDICTION ",
  border: { type: "line", fg: "magenta" },
  style: { fg: "magenta" },
  tags: true,
  content: "Loading...",
});

const alertBox = grid.set(6, 6, 4, 6, blessed.box, {
  label: " STATUS ",
  border: { type: "line", fg: "green" },
  style: { fg: "green" },
  tags: true,
  content: "● Connecting...",
});

const logBox = grid.set(10, 0, 2, 12, contrib.log, {
  label: " LOG ",
  border: { type: "line", fg: "grey" },
  style: { fg: "grey" },
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));

let burnHistory: number[] = [];
let localState: SessionState = {
  session_id: "",
  project_name: "unknown",
  lifecycle: "not_launched",
  last_seen_ms: Date.now(),
  is_stale: false,
  started_at: Date.now(),
  turns: 0,
  tool_calls_total: 0,
  tokens_total: 0,
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: 0,
  activity_state: "idle",
  burn_rate_per_sec: 0,
  tokens_per_turn_avg: 0,
  eta_to_threshold_sec: Infinity,
  alert_level: "green",
  last_checkpoint_turn: 0,
};

function log2(s: string) {
  (logBox as unknown as { log: (s: string) => void }).log(s);
}

function fmt(n: number): string { return n.toLocaleString(); }
function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

function pickMostActive(sessions: SessionState[]): SessionState | null {
  if (sessions.length === 0) return null;
  return sessions.slice().sort((a, b) => b.last_seen_ms - a.last_seen_ms)[0];
}

function update(state: SessionState) {
  const threshold = 1000000;
  const left = Math.max(threshold - state.tokens_total, 0);
  const pct = ((state.tokens_total / threshold) * 100).toFixed(1);

  metricsBox.setContent([
    `{cyan-fg}PROJECT{/}  ${state.project_name}`,
    `{cyan-fg}STATE{/}    ${state.lifecycle.toUpperCase()}`,
    `{cyan-fg}TOK IN{/}   ${fmt(state.tokens_in)}`,
    `{magenta-fg}TOK OUT{/}  ${fmt(state.tokens_out)}`,
    `{white-fg}TOTAL{/}    ${fmt(state.tokens_total)}`,
    `{magenta-fg}COST{/}     $${state.cost_usd.toFixed(4)}`,
    `{yellow-fg}TURNS{/}    ${state.turns}`,
    `{white-fg}USED{/}     ${pct}%`,
  ].join("\n"));

  predictionBox.setContent([
    `{cyan-fg}BURN/SEC{/}  ${Math.round(state.burn_rate_per_sec)} tok/s`,
    `{cyan-fg}ETA{/}       ${fmtEta(state.eta_to_threshold_sec)}`,
    `{white-fg}LEFT{/}      ${fmt(left)} tokens`,
    `{white-fg}TOK/TURN{/}  ${Math.round(state.tokens_per_turn_avg)}`,
  ].join("\n"));

  const alertColor = state.alert_level === "green" ? "green"
    : state.alert_level === "yellow" ? "yellow" : "red";
  alertBox.style.border = { type: "line", fg: alertColor };
  const turnsToNext = Math.max(0, 20 - state.turns);
  alertBox.setContent([
    `{${alertColor}-fg}● ${state.alert_level.toUpperCase()}{/}`,
    ``,
    turnsToNext > 0
      ? `{yellow-fg}⚠ Checkpoint in ${turnsToNext} turns{/}`
      : `{red-fg}⚠ Checkpoint due{/}`,
  ].join("\n"));

  burnHistory.push(Math.round(state.burn_rate_per_sec));
  if (burnHistory.length > BURN_HISTORY_SIZE) burnHistory.shift();
  burnChart.setData({
    titles: burnHistory.map((_, i) => String(i + 1)),
    data: burnHistory,
  });

  screen.render();
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => log2("Connected to Claude Pulse server"));
  ws.on("message", (data) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log2("Parse error: malformed message");
      return;
    }
    if (msg.type === "sessions_snapshot") {
      const active = pickMostActive(msg.sessions);
      if (active) {
        localState = active;
        log2(`Showing session: ${active.project_name} (${active.session_id.slice(0, 8)})`);
        update(localState);
      }
    } else if (msg.type === "session_updated") {
      if (localState.session_id === "" || msg.session.session_id === localState.session_id) {
        localState = msg.session;
        update(localState);
      }
    } else if (msg.type === "checkpoint_event") {
      if (msg.state.session_id === localState.session_id) {
        localState = msg.state;
        const label = msg.severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
        log2(label);
        update(localState);
      }
    }
  });
  ws.on("close", () => {
    log2("Disconnected — retrying in 2s...");
    setTimeout(connect, 2000);
  });
  ws.on("error", (err) => log2(`Error: ${err.message}`));
}

connect();
