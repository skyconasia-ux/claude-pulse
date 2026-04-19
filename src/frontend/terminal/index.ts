import blessed from "blessed";
import contrib from "blessed-contrib";
import WebSocket from "ws";
import { SessionState, WsMessage } from "../../types";
import {
  pickMostActive,
  pickSelected,
  fmtEta,
  fmtTokens,
  fmtElapsed,
  alertColor,
  sessionRows,
  shortModelName,
} from "./helpers";

const WS_URL = "ws://localhost:3001";
const BURN_HISTORY_SIZE = 30;
const THRESHOLD = 1_000_000;

// ── Screen + Grid ────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: "Claude Pulse" });
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Row 0-2: session list
const sessionTable = grid.set(0, 0, 3, 12, contrib.table, {
  label: " SESSIONS (↑/↓ select) ",
  keys: false,
  columnSpacing: 2,
  columnWidth: [20, 10, 10, 10, 8],
  border: { type: "line", fg: "cyan" },
  style: {
    header: { fg: "cyan", bold: true },
    cell: { fg: "white", selected: { bg: "blue" } },
  },
});

// Row 3-7: burn chart + metrics
const burnChart = grid.set(3, 0, 5, 8, contrib.bar, {
  label: " BURN RATE (tok/s) ",
  barWidth: 4,
  barSpacing: 2,
  xOffset: 0,
  maxHeight: 100,
  style: { bar: { bg: "cyan" }, text: "cyan", baseline: "black" },
  border: { type: "line", fg: "cyan" },
});

const metricsBox = grid.set(3, 8, 5, 4, blessed.box, {
  label: " METRICS ",
  border: { type: "line", fg: "cyan" },
  style: { fg: "cyan" },
  tags: true,
  content: "Loading...",
});

// Row 8-9: prediction + alert
const predictionBox = grid.set(8, 0, 2, 6, blessed.box, {
  label: " PREDICTION ",
  border: { type: "line", fg: "magenta" },
  style: { fg: "magenta" },
  tags: true,
  content: "Loading...",
});

const alertBox = grid.set(8, 6, 2, 6, blessed.box, {
  label: " STATUS ",
  border: { type: "line", fg: "green" },
  style: { fg: "green" },
  tags: true,
  content: "● Connecting...",
});

// Row 10-11: log
const logBox = grid.set(10, 0, 2, 12, contrib.log, {
  label: " LOG ",
  border: { type: "line", fg: "grey" },
  style: { fg: "grey" },
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));

// ── State ────────────────────────────────────────────────
const allSessions = new Map<string, SessionState>();
let selectedId = "";
const burnHistory: number[] = [];
let burnViewSize = BURN_HISTORY_SIZE;
let burnViewOffset = 0;
let isDragging = false;
let lastDragX = 0;

// ── Helpers ──────────────────────────────────────────────
function log2(s: string) {
  (logBox as unknown as { log: (s: string) => void }).log(s);
}

// ── Render ───────────────────────────────────────────────
function renderSessionList(): void {
  const rows = sessionRows(allSessions, selectedId);
  (sessionTable as unknown as {
    setData: (d: { headers: string[]; data: string[][] }) => void
  }).setData({
    headers: ["PROJECT", "STATE", "TOKENS", "COST", "ALERT"],
    data: rows.length > 0 ? rows : [["(no sessions)", "", "", "", ""]],
  });
}

function renderDetail(state: SessionState): void {
  const weighted = state.weighted_tokens_total ?? state.tokens_total;
  const left = Math.max(THRESHOLD - weighted, 0);
  const pct = ((weighted / THRESHOLD) * 100).toFixed(1);

  const now = Date.now();
  const sessElapsed = fmtElapsed(now - state.started_at);
  const projElapsed = state.project_first_seen_ms
    ? fmtElapsed(now - state.project_first_seen_ms)
    : "—";

  metricsBox.setContent([
    `{cyan-fg}PROJECT{/}  ${state.project_name}`,
    `{cyan-fg}STATE{/}    ${state.lifecycle.toUpperCase()}`,
    `{cyan-fg}MODEL{/}    ${shortModelName(state.model_last)}`,
    `{cyan-fg}TOK IN{/}   ${fmtTokens(state.tokens_in)}`,
    `{magenta-fg}TOK OUT{/}  ${fmtTokens(state.tokens_out)}`,
    `{white-fg}TOTAL{/}    ${fmtTokens(state.tokens_total)}`,
    `{magenta-fg}COST{/}     $${state.cost_usd.toFixed(4)}`,
    `{yellow-fg}TURNS{/}    ${state.turns}`,
    `{white-fg}BUDGET{/}   ${pct}%`,
    `{cyan-fg}SESS{/}     ${sessElapsed}`,
    `{cyan-fg}PROJ{/}     ${projElapsed}`,
  ].join("\n"));

  predictionBox.setContent([
    `{cyan-fg}BURN/SEC{/}  ${Math.round(state.burn_rate_per_sec)} tok/s`,
    `{cyan-fg}ETA{/}       ${fmtEta(state.eta_to_threshold_sec)}`,
    `{white-fg}LEFT{/}      ${fmtTokens(left)}`,
    `{white-fg}TOK/TURN{/}  ${Math.round(state.tokens_per_turn_avg)}`,
  ].join("\n"));

  const color = alertColor(state.alert_level);
  alertBox.style.border = { type: "line", fg: color };
  const turnsToNext = Math.max(0, 20 - state.turns);
  alertBox.setContent([
    `{${color}-fg}● ${state.alert_level.toUpperCase()}{/}`,
    ``,
    turnsToNext > 0
      ? `{yellow-fg}⚠ Checkpoint in ${turnsToNext} turns{/}`
      : `{red-fg}⚠ Checkpoint due{/}`,
  ].join("\n"));

  burnHistory.push(Math.round(state.burn_rate_per_sec));
  if (burnHistory.length > BURN_HISTORY_SIZE) burnHistory.shift();
  burnViewOffset = Math.max(0, Math.min(burnViewOffset, Math.max(0, burnHistory.length - burnViewSize)));
  const endIdx = Math.max(0, burnHistory.length - burnViewOffset);
  const startIdx = Math.max(0, endIdx - burnViewSize);
  const viewData = burnHistory.slice(startIdx, endIdx);
  const zoomLabel = burnViewSize < BURN_HISTORY_SIZE ? ` [${burnViewSize}pt zoom]` : "";
  (burnChart as unknown as { setLabel: (s: string) => void }).setLabel(` BURN RATE (tok/s)${zoomLabel} `);
  burnChart.setData({
    titles: viewData.map((_, i) => String(startIdx + i + 1)),
    data: viewData,
  });
}

function render(): void {
  renderSessionList();
  const state = pickSelected(allSessions, selectedId);
  if (state) renderDetail(state);
  screen.render();
}

// ── Keyboard navigation ──────────────────────────────────
function sessionIds(): string[] {
  return Array.from(allSessions.keys());
}

screen.key(["up", "k"], () => {
  const ids = sessionIds();
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectedId);
  selectedId = ids[Math.max(0, idx - 1)];
  render();
});

screen.key(["down", "j"], () => {
  const ids = sessionIds();
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectedId);
  selectedId = ids[Math.min(ids.length - 1, idx + 1)];
  render();
});

// ── Mouse: zoom + pan ────────────────────────────────────
screen.enableMouse();
screen.on("mouse", (data: { action: string; button?: string; x: number; y: number }) => {
  if (data.action === "wheelup") {
    burnViewSize = Math.max(5, burnViewSize - 3);
    render();
  } else if (data.action === "wheeldown") {
    burnViewSize = Math.min(BURN_HISTORY_SIZE, burnViewSize + 3);
    render();
  } else if (data.action === "mousedown" && data.button === "left") {
    isDragging = true;
    lastDragX = data.x;
  } else if (data.action === "mouseup") {
    isDragging = false;
  } else if (data.action === "mousemove" && isDragging) {
    const delta = Math.round((lastDragX - data.x) / 2);
    if (delta !== 0) {
      burnViewOffset = Math.max(0, Math.min(Math.max(0, burnHistory.length - burnViewSize), burnViewOffset + delta));
      lastDragX = data.x;
      render();
    }
  }
});

// ── WebSocket ────────────────────────────────────────────
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
      allSessions.clear();
      for (const s of msg.sessions) allSessions.set(s.session_id, s);
      if (!allSessions.has(selectedId)) {
        const active = pickMostActive(msg.sessions);
        selectedId = active?.session_id ?? "";
        if (active) log2(`Auto-selected: ${active.project_name} (${active.session_id.slice(0, 8)})`);
      }
      render();
    } else if (msg.type === "session_updated") {
      allSessions.set(msg.session.session_id, msg.session);
      if (selectedId === "" || selectedId === msg.session.session_id) {
        selectedId = msg.session.session_id;
      }
      render();
    } else if (msg.type === "checkpoint_event") {
      allSessions.set(msg.state.session_id, msg.state);
      if (msg.state.session_id === selectedId) {
        const label = msg.severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
        log2(label);
      }
      render();
    }
  });

  ws.on("close", () => {
    log2("Disconnected — retrying in 2s...");
    setTimeout(connect, 2000);
  });
  ws.on("error", (err) => log2(`Error: ${err.message}`));
}

connect();
