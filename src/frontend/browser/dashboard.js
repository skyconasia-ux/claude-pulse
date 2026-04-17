const WS_URL = `ws://${location.host}`;
const THRESHOLD = 100000;

let ws;
let sessions = {};        // keyed by session_id
let chartHistory = {};    // session_id → [{toolCalls, tokens}] — time-series, one point per update
let startedAt = null;
let elapsedTimer = null;
let pendingAbortId = null;

// ── Refresh rate ─────────────────────────────────────────
let refreshMode = "high";   // high | normal | low | paused
// Task Manager parity: High=1s, Normal=2s, Low=10s
const REFRESH_INTERVALS = { high: 1000, normal: 2000, low: 10000, paused: null };
let refreshTimer = null;
let pendingRender = false;

function setRefreshMode(mode) {
  refreshMode = mode;
  document.querySelectorAll(".rate-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.rate === mode);
  });
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (mode !== "paused") {
    refreshTimer = setInterval(flushRender, REFRESH_INTERVALS[mode]);
  }
}

function scheduleRender() {
  if (refreshMode === "high") { renderAll(); return; }
  if (refreshMode === "paused") { pendingRender = true; return; }
  pendingRender = true;
}

function flushRender() {
  if (pendingRender) { renderAll(); updateEmptyState(); pendingRender = false; }
}

// ── WebSocket ────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => setConnected(true);
  ws.onclose = () => { setConnected(false); setTimeout(connect, 2000); };
  ws.onerror = () => setConnected(false);
  ws.onmessage = (ev) => {
    try { handleMessage(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
  };
}

function setConnected(live) {
  document.getElementById("conn-dot").className = "conn-dot" + (live ? " live" : "");
  document.getElementById("conn-label").textContent = live ? "Live" : "Reconnecting...";
}

function recordHistory(s) {
  const sid = s.session_id;
  if (!chartHistory[sid]) chartHistory[sid] = [];
  const hist = chartHistory[sid];
  // Record every update as a time-series point — gives fluid live movement
  hist.push({ toolCalls: s.tool_calls_total || 0, tokens: s.tokens_total || 0 });
  if (hist.length > 120) hist.shift();
}

function handleMessage(msg) {
  if (msg.type === "sessions_snapshot") {
    sessions = {};
    for (const s of msg.sessions) { sessions[s.session_id] = s; recordHistory(s); }
    if (!startedAt) {
      startedAt = Date.now();
      elapsedTimer = setInterval(updateElapsed, 1000);
    }
    renderAll();
  } else if (msg.type === "session_updated") {
    sessions[msg.session.session_id] = msg.session;
    recordHistory(msg.session);
    pendingRender = true;
  } else if (msg.type === "checkpoint_event") {
    sessions[msg.state.session_id] = msg.state;
    recordHistory(msg.state);
    renderTile(msg.state);
    updateTopbar();
    updateEmptyState();
    showBanner(msg.severity, msg.state.project_name);
  }
}

// ── Render all ───────────────────────────────────────────
function renderAll() {
  const grid = document.getElementById("session-grid");
  const existing = new Set(Object.keys(sessions));

  // Remove tiles for sessions that no longer exist
  for (const el of grid.querySelectorAll(".tile")) {
    if (!existing.has(el.dataset.id)) el.remove();
  }

  // Add/update tiles
  for (const s of Object.values(sessions)) renderTile(s);
  updateTopbar();
  updateEmptyState();
}

function renderTile(state) {
  const grid = document.getElementById("session-grid");
  let tile = grid.querySelector(`[data-id="${CSS.escape(state.session_id)}"]`);
  if (!tile) {
    tile = buildTile(state.session_id);
    grid.appendChild(tile);
  }
  updateTile(tile, state);
}

function buildTile(sessionId) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = sessionId;
  tile.innerHTML = `
    <div class="tile-header">
      <div class="tile-name-wrap">
        <div class="tile-name" data-field="name"></div>
        <div class="tile-session-id" data-field="sid"></div>
      </div>
      <div class="tile-badges">
        <span class="badge" data-field="lifecycle"></span>
        <span class="badge badge-stale" data-field="stale" style="display:none">STALE</span>
      </div>
    </div>
    <div>
      <div class="token-hero-label">TOTAL TOKENS</div>
      <div class="token-hero-value" data-field="total">0</div>
      <div class="token-breakdown">
        <div class="seg seg-in">
          <div class="seg-label">IN</div>
          <div class="seg-val" data-field="in">0</div>
        </div>
        <div class="seg seg-out">
          <div class="seg-label">OUT</div>
          <div class="seg-val" data-field="out">0</div>
        </div>
        <div class="seg seg-left">
          <div class="seg-label">LEFT</div>
          <div class="seg-val" data-field="left">—</div>
        </div>
      </div>
    </div>
    <div>
      <div class="progress-meta">
        <span>0</span>
        <span data-field="pct">0%</span>
        <span>${fmt(THRESHOLD)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill" data-field="bar" style="width:0%"></div></div>
    </div>
    <div class="chart-wrap">
      <div class="chart-label" data-field="chart-label">TOOL CALLS — LIVE</div>
      <canvas class="tile-chart" data-field="chart"></canvas>
    </div>
    <div class="stats-row">
      <div class="stat stat-cost"><div class="stat-label">COST</div><div class="stat-value" data-field="cost">$0.00</div></div>
      <div class="stat stat-turns"><div class="stat-label">TURNS</div><div class="stat-value" data-field="turns">0</div></div>
      <div class="stat stat-burn"><div class="stat-label">BURN/S</div><div class="stat-value" data-field="burn">0</div></div>
      <div class="stat stat-eta"><div class="stat-label">ETA</div><div class="stat-value" data-field="eta">—</div></div>
      <div class="stat stat-tools"><div class="stat-label">TOOLS</div><div class="stat-value" data-field="tools">0</div></div>
    </div>
    <div class="tile-footer">
      <span class="alert-pill" data-field="alert">● GREEN</span>
      <button class="btn-abort" title="Code 10 Abort" data-sid="${sessionId}">Abort</button>
    </div>
  `;
  tile.querySelector(".btn-abort").addEventListener("click", (e) => {
    const sid = e.currentTarget.dataset.sid;
    openAbortConfirm(sid);
  });
  return tile;
}

function updateTile(tile, s) {
  const total = s.tokens_total || 0;
  const pct = Math.min(total / THRESHOLD * 100, 100);
  const left = Math.max(THRESHOLD - total, 0);

  set(tile, "name", s.project_name || s.session_id.slice(0, 12));
  set(tile, "sid", s.session_id.slice(0, 16) + (s.session_id.length > 16 ? "…" : ""));
  set(tile, "total", fmt(total));
  set(tile, "in", fmt(s.tokens_in || 0));
  set(tile, "out", fmt(s.tokens_out || 0));
  set(tile, "left", fmt(left));
  set(tile, "pct", pct.toFixed(0) + "% used");
  tile.querySelector("[data-field='bar']").style.width = pct.toFixed(1) + "%";
  set(tile, "cost", "$" + (s.cost_usd || 0).toFixed(4));
  set(tile, "turns", s.turns || 0);
  set(tile, "burn", Math.round(s.burn_rate_per_sec || 0));
  set(tile, "eta", fmtEta(s.eta_to_threshold_sec));
  set(tile, "tools", s.tool_calls_total || 0);

  // Lifecycle badge
  const lc = s.lifecycle || "unknown";
  const lcEl = tile.querySelector("[data-field='lifecycle']");
  lcEl.className = `badge badge-${lc}`;
  lcEl.textContent = lc.replace(/_/g, " ").toUpperCase();

  // Stale badge
  tile.querySelector("[data-field='stale']").style.display = s.is_stale ? "" : "none";

  // Alert level
  const alertEl = tile.querySelector("[data-field='alert']");
  const level = s.alert_level || "green";
  alertEl.className = `alert-pill alert-${level}`;
  alertEl.textContent = `● ${level.toUpperCase()}`;

  // Area chart
  const canvas = tile.querySelector("[data-field='chart']");
  if (canvas) {
    const hist = chartHistory[s.session_id] || [];
    const hasTokens = hist.some(p => p.tokens > 0);
    set(tile, "chart-label", hasTokens ? "TOKEN BURN — LIVE" : "TOOL CALLS — LIVE");
    drawChart(canvas, s.session_id);
  }

  // Tile border class
  tile.className = "tile" +
    (s.is_stale ? " stale" : "") +
    (level === "yellow" ? " alert-yellow" : "") +
    (level === "red" ? " alert-red" : "");
  tile.dataset.id = s.session_id;
}

function set(tile, field, val) {
  const el = tile.querySelector(`[data-field="${field}"]`);
  if (el) el.textContent = val;
}

// ── Topbar ───────────────────────────────────────────────
function updateTopbar() {
  const all = Object.values(sessions);
  const active = all.filter(s => !s.is_stale && s.lifecycle !== "closed" && s.lifecycle !== "stopped");
  document.getElementById("session-count").textContent =
    active.length + " session" + (active.length !== 1 ? "s" : "") +
    (all.length > active.length ? ` (${all.length - active.length} closed)` : "");
}

function updateEmptyState() {
  const empty = Object.keys(sessions).length === 0;
  document.getElementById("session-grid").style.display = empty ? "none" : "";
  document.getElementById("empty-state").style.display = empty ? "block" : "none";
}

function updateElapsed() {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  document.getElementById("elapsed").textContent = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ── Checkpoint banner ────────────────────────────────────
function showBanner(severity, projectName) {
  const banner = document.getElementById("banner");
  banner.textContent = severity === "mandatory"
    ? `⚠ CHECKPOINT — ${projectName}`
    : `● RECOMMEND CHECKPOINT — ${projectName}`;
  banner.className = `banner ${severity}`;
  banner.style.display = "block";
  setTimeout(() => { banner.style.display = "none"; }, 60000);
}

// ── Abort ────────────────────────────────────────────────
function openAbortConfirm(sessionId) {
  pendingAbortId = sessionId;
  const s = sessions[sessionId];
  const name = s ? s.project_name : sessionId.slice(0, 16);
  document.getElementById("abort-confirm-text").textContent =
    `Abort session "${name}"?\nThis marks the session as stopped in the monitor.`;
  document.getElementById("abort-overlay").classList.add("open");
}

document.getElementById("abort-cancel").addEventListener("click", () => {
  document.getElementById("abort-overlay").classList.remove("open");
  pendingAbortId = null;
});

document.getElementById("abort-confirm").addEventListener("click", async () => {
  if (!pendingAbortId) return;
  const id = pendingAbortId;
  document.getElementById("abort-overlay").classList.remove("open");
  pendingAbortId = null;
  try {
    const res = await fetch(`/abort/${encodeURIComponent(id)}`, { method: "POST" });
    if (!res.ok) console.warn("Abort returned", res.status);
  } catch (err) {
    console.error("Abort request failed", err);
  }
});

// ── Area chart ───────────────────────────────────────────
function drawChart(canvas, sessionId) {
  const hist = chartHistory[sessionId] || [];
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 380;
  const H = 72;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (hist.length < 2) {
    ctx.fillStyle = "rgba(0,255,240,0.04)";
    ctx.fillRect(0, 0, W, H);
    if (hist.length === 1) {
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00fff0";
      ctx.fill();
    }
    return;
  }

  // Use token data when available (OTEL), otherwise tool call count as activity proxy
  const hasTokens = hist.some(p => p.tokens > 0);
  const vals = hist.map(p => hasTokens ? p.tokens : p.toolCalls);
  const maxVal = Math.max(...vals, 1);
  const pad = { t: 8, b: 8, l: 4, r: 4 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  const px = (i) => pad.l + (i / (hist.length - 1)) * cW;
  const py = (v) => pad.t + cH - (v / maxVal) * cH;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, H);
  grad.addColorStop(0, "rgba(0,255,240,0.28)");
  grad.addColorStop(0.6, "rgba(0,255,240,0.06)");
  grad.addColorStop(1, "rgba(0,255,240,0)");

  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0]));
  for (let i = 1; i < hist.length; i++) ctx.lineTo(px(i), py(vals[i]));
  ctx.lineTo(px(hist.length - 1), H - pad.b);
  ctx.lineTo(px(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0]));
  for (let i = 1; i < hist.length; i++) ctx.lineTo(px(i), py(vals[i]));
  ctx.strokeStyle = "#00fff0";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "#00fff0";
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dots
  for (let i = 0; i < hist.length; i++) {
    ctx.beginPath();
    ctx.arc(px(i), py(vals[i]), i === hist.length - 1 ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fillStyle = i === hist.length - 1 ? "#00fff0" : "rgba(0,255,240,0.55)";
    ctx.shadowColor = "#00fff0";
    ctx.shadowBlur = i === hist.length - 1 ? 6 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

// ── Helpers ──────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString(); }
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

// ── Refresh rate buttons ─────────────────────────────────
document.querySelectorAll(".rate-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.rate;
    if (mode === "refresh") { renderAll(); return; }
    setRefreshMode(mode);
  });
});
setRefreshMode("high");

connect();
