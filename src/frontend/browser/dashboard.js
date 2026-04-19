const WS_URL = `ws://${location.host}`;
const THRESHOLD = 1000000;

let ws;
let sessions = {};        // keyed by session_id
let chartHistory = {};    // session_id → [{toolCalls, tokens, tokensDelta, toolsDelta, ts}]
let accountInfo = null;   // {subscriptionType, rateLimitTier} from credentials
let startedAt = null;
let elapsedTimer = null;
let pendingAbortId = null;

// ── History panel ────────────────────────────────────────
let historyOpen = localStorage.getItem("claudepulse_history_open") === "true";
let historyTimer = null;

const HISTORY_INTERVALS = { high: 15000, normal: 45000, low: 90000, paused: null };

// ── Refresh rate ─────────────────────────────────────────
let refreshMode = "high";   // high | normal | low | paused
// Task Manager parity: High=1s, Normal=2s, Low=10s
const REFRESH_INTERVALS = { high: 1000, normal: 3000, low: 5000, paused: null };
let refreshTimer = null;
let pendingRender = false;

function setRefreshMode(mode) {
  refreshMode = mode;
  document.querySelectorAll(".rate-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.rate === mode);
  });
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
  if (mode !== "paused") {
    refreshTimer = setInterval(flushRender, REFRESH_INTERVALS[mode]);
    const hi = HISTORY_INTERVALS[mode];
    if (hi) historyTimer = setInterval(fetchHistory, hi);
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
  const prev = hist.length > 0 ? hist[hist.length - 1] : null;
  const tokens = s.tokens_total || 0;
  const toolCalls = s.tool_calls_total || 0;
  hist.push({
    tokens,
    toolCalls,
    tokensDelta: prev ? Math.max(0, tokens - prev.tokens) : 0,
    toolsDelta:  prev ? Math.max(0, toolCalls - prev.toolCalls) : 0,
    model: s.model_last ?? null,
    ts: Date.now(),
  });
  if (hist.length > 120) hist.shift();
}

function handleMessage(msg) {
  if (msg.type === "sessions_snapshot") {
    if (msg.accountInfo) accountInfo = msg.accountInfo;
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
    // If a checkpoint was queued and session is now idle, server will run it — clear queued state
    const activeLifecycles = ["running", "tool_use", "thinking"];
    if (!activeLifecycles.includes(msg.session.lifecycle)) {
      const tile = document.querySelector(`.tile[data-id="${msg.session.session_id}"]`);
      const btn = tile?.querySelector(".btn-checkpoint");
      if (btn?.classList.contains("queued")) {
        btn.classList.remove("queued");
        btn.classList.add("done");
        btn.textContent = "⬡ Pushed";
        setTimeout(() => {
          btn.classList.remove("done");
          btn.textContent = "⬡ Checkpoint";
          btn.disabled = false;
        }, 3000);
      }
    }
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
    <div class="tile-totals">
      <div class="tot-cell tot-tokens">
        <div class="tot-label">TOTAL TOKENS</div>
        <div class="tot-value" data-field="tot-tokens">0</div>
      </div>
      <div class="tot-cell tot-cost">
        <div class="tot-label">TOTAL COST</div>
        <div class="tot-value" data-field="tot-cost">$0.00</div>
      </div>
      <div class="tot-cell tot-turns">
        <div class="tot-label">TOTAL TURNS</div>
        <div class="tot-value" data-field="tot-turns">0</div>
      </div>
      <div class="tot-cell tot-tools">
        <div class="tot-label">TOTAL TOOLS</div>
        <div class="tot-value" data-field="tot-tools">0</div>
      </div>
    </div>
    <div class="tile-header">
      <div class="tile-name-wrap">
        <div class="tile-name" data-field="name"></div>
        <div class="tile-session-id" data-field="sid"></div>
      </div>
      <div class="tile-badges">
        <span class="badge" data-field="lifecycle"></span>
        <span class="badge badge-stale" data-field="stale" style="display:none">STALE</span>
        <span class="badge-alert" data-field="alert-badge" style="display:none"></span>
      </div>
    </div>
    <div class="tile-time-row">
      ⏱ session <span class="ttr-val" data-field="elapsed-sess">—</span>
      <span class="ttr-sep">|</span>
      project <span class="ttr-val" data-field="elapsed-proj">—</span>
    </div>
    <div class="plan-bar" data-field="plan-bar"></div>
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
          <div class="seg-label">BUDGET LEFT</div>
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
    <div class="model-breakdown" data-field="model-breakdown"></div>
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
    <div class="alert-card" data-field="alert-card">
      <div class="ac-header">
        <span class="ac-icon">⚠</span>
        <span class="ac-title">USAGE LIMIT WARNING</span>
      </div>
      <div class="ac-fields">
        <div class="ac-field">
          <div class="ac-lbl">USED</div>
          <div class="ac-val pct" data-field="ac-pct">—</div>
        </div>
        <div class="ac-field" data-field="ac-reset-wrap" style="display:none">
          <div class="ac-lbl">RESETS</div>
          <div class="ac-val time" data-field="ac-reset">—</div>
        </div>
      </div>
      <div class="ac-upgrade" data-field="ac-upgrade" style="display:none">⬡ /upgrade to keep using Claude Code</div>
    </div>
    <div class="tile-footer">
      <span class="alert-pill" data-field="alert">● GREEN</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-checkpoint" title="Checkpoint — git commit + push" data-sid="${sessionId}">⬡ Checkpoint</button>
        <button class="btn-abort" title="Code 10 Abort" data-sid="${sessionId}">Abort</button>
      </div>
    </div>
  `;
  tile.querySelector(".btn-abort").addEventListener("click", (e) => {
    const sid = e.currentTarget.dataset.sid;
    openAbortConfirm(sid);
  });
  tile.querySelector(".btn-checkpoint").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const sid = btn.dataset.sid;
    btn.disabled = true;
    btn.textContent = "…";
    fetch(`/checkpoint/${sid}`, { method: "POST" })
      .then(r => r.json())
      .then(data => {
        if (data.status === "queued") {
          btn.classList.add("queued");
          btn.textContent = "⬡ Queued";
          btn.disabled = false;
        } else {
          btn.classList.add("done");
          btn.textContent = "⬡ Pushed";
          setTimeout(() => {
            btn.classList.remove("done");
            btn.textContent = "⬡ Checkpoint";
            btn.disabled = false;
          }, 3000);
        }
      })
      .catch(() => {
        btn.textContent = "⬡ Checkpoint";
        btn.disabled = false;
      });
  });
  return tile;
}

function updateTile(tile, s) {
  const total    = s.tokens_total || 0;
  const weighted = s.weighted_tokens_total ?? total;
  const pct      = Math.min(weighted / THRESHOLD * 100, 100);
  const left     = Math.max(THRESHOLD - weighted, 0);

  animNum(tile, "tot-tokens", total,                fmtInt);
  animNum(tile, "tot-cost",   s.cost_usd || 0,      fmtCost2);
  animNum(tile, "tot-turns",  s.turns || 0,          fmtWhole);
  animNum(tile, "tot-tools",  s.tool_calls_total||0, fmtWhole);

  renderPlanBar(tile);
  set(tile, "name", s.project_name || s.session_id.slice(0, 12));
  set(tile, "sid", s.session_id.slice(0, 16) + (s.session_id.length > 16 ? "…" : ""));
  animNum(tile, "total", total,                fmtInt);
  animNum(tile, "in",    s.tokens_in  || 0,   fmtInt);
  animNum(tile, "out",   s.tokens_out || 0,   fmtInt);
  animNum(tile, "left",  left,                fmtInt);
  animNum(tile, "cost",  s.cost_usd   || 0,   fmtCost4);
  animNum(tile, "turns", s.turns      || 0,   fmtWhole);
  animNum(tile, "burn",  s.burn_rate_per_sec || 0, fmtWhole);
  animNum(tile, "tools", s.tool_calls_total  || 0, fmtWhole);

  // Progress bar — % text and fill width
  const pctEl = tile.querySelector("[data-field='pct']");
  countUp(pctEl, pct, n => n.toFixed(0) + "% used");
  tile.querySelector("[data-field='bar']").style.width = pct.toFixed(1) + "%";

  set(tile, "eta", fmtEta(s.eta_to_threshold_sec));

  // Lifecycle badge
  const lc = s.lifecycle || "unknown";
  const lcEl = tile.querySelector("[data-field='lifecycle']");
  lcEl.className = `badge badge-${lc}`;
  lcEl.textContent = lc.replace(/_/g, " ").toUpperCase();

  // Stale badge
  tile.querySelector("[data-field='stale']").style.display = s.is_stale ? "" : "none";

  // Alert badge in header
  const alertBadge = tile.querySelector("[data-field='alert-badge']");
  if (alertBadge) {
    if (pct >= 70) {
      alertBadge.style.display = "";
      alertBadge.textContent = pct >= 100 ? "⚠ MAX" : `⚠ ${Math.round(pct)}%`;
      alertBadge.className = "badge-alert" + (pct < 90 ? " warn-amber" : "");
    } else {
      alertBadge.style.display = "none";
    }
  }

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
    const modelTag = s.model_last ? " [" + shortModelName(s.model_last) + "]" : "";
    set(tile, "chart-label", (hasTokens ? "TOKEN BURN — LIVE" : "TOOL CALLS — LIVE") + modelTag);
    drawChart(canvas, s.session_id);
    if (!canvas._tooltipWired) {
      canvas._tooltipWired = true;
      wireChartTooltip(canvas, s.session_id);
    }
    canvas._sessionId = s.session_id;
  }

  // Tile border — data-band drives 5-band CSS
  tile.className = "tile" + (s.is_stale ? " stale" : "");
  tile.dataset.band = usageBand(pct);
  tile.dataset.id = s.session_id;
  if (s.started_at) tile.dataset.startedAt = s.started_at;
  if (s.project_first_seen_ms) tile.dataset.projectFirstSeen = s.project_first_seen_ms;

  // Model breakdown
  const mbEl = tile.querySelector("[data-field='model-breakdown']");
  if (mbEl && s.models && Object.keys(s.models).length > 0) {
    mbEl.innerHTML = Object.entries(s.models).map(([id, stats]) => `
      <div class="model-row">
        <span class="model-name">
          <span class="model-badge ${modelBadgeClass(id)}">${shortModelName(id)}</span>
          ${id === s.model_last ? ' <span style="color:#00ff88;font-size:8px">&#9679; ACTIVE</span>' : ''}
        </span>
        <span class="model-tokens-in">IN ${fmtInt(stats.tokens_in)}</span>
        <span class="model-tokens-out">OUT ${fmtInt(stats.tokens_out)}</span>
        <span class="model-cost">${fmtCost4(stats.cost_usd)}</span>
      </div>
    `).join("");
    mbEl.style.display = "";
  } else if (mbEl) {
    mbEl.style.display = "none";
  }

  // Alert card — live usage % + parsed reset time + upgrade prompt
  const alertCard = tile.querySelector("[data-field='alert-card']");
  if (alertCard) {
    if (pct >= 70) {
      alertCard.classList.add('open');
      alertCard.classList.toggle('warn-amber', pct < 90);
      set(tile, 'ac-pct', Math.round(pct) + '%');
      const { resetStr, hasUpgrade } = parseNotification(s.last_notification);
      const resetWrap = tile.querySelector("[data-field='ac-reset-wrap']");
      const resetEl   = tile.querySelector("[data-field='ac-reset']");
      const upgradeEl = tile.querySelector("[data-field='ac-upgrade']");
      if (resetWrap) resetWrap.style.display = resetStr ? "" : "none";
      if (resetEl && resetStr) resetEl.textContent = resetStr;
      if (upgradeEl) upgradeEl.style.display = hasUpgrade ? "" : "none";
    } else {
      alertCard.classList.remove('open', 'warn-amber');
    }
  }
}

function set(tile, field, val) {
  const el = tile.querySelector(`[data-field="${field}"]`);
  if (el) el.textContent = val;
}

// ── Animated number counter ──────────────────────────────
function countUp(el, toVal, fmt) {
  if (!el) return;
  const fromVal = parseFloat(el.dataset.rawVal ?? "0") || 0;
  el.dataset.rawVal = String(toVal);
  if (Math.abs(toVal - fromVal) < 0.0001) { el.textContent = fmt(toVal); return; }
  if (el._af) { cancelAnimationFrame(el._af); el._af = null; }
  const start = performance.now();
  const dur = 700;
  const diff = toVal - fromVal;
  function step(now) {
    const t = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = fmt(fromVal + diff * e);
    el._af = t < 1 ? requestAnimationFrame(step) : null;
  }
  el._af = requestAnimationFrame(step);
}

function animNum(tile, field, rawVal, formatter) {
  const el = tile.querySelector(`[data-field="${field}"]`);
  countUp(el, rawVal, formatter);
}

const fmtInt  = n => Math.round(n).toLocaleString();
const fmtCost4 = n => "$" + n.toFixed(4);
const fmtCost2 = n => "$" + n.toFixed(2);
const fmtWhole = n => String(Math.round(n));

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return h + 'h ' + rm + 'm';
  const d = Math.floor(h / 24), rh = h % 24;
  return d + 'd ' + rh + 'h';
}

function modelBadgeClass(modelId) {
  if (modelId.includes("opus"))   return "model-badge-opus";
  if (modelId.includes("haiku"))  return "model-badge-haiku";
  return "model-badge-sonnet";
}

function shortModelName(modelId) {
  if (modelId.includes("opus"))   return "OPUS";
  if (modelId.includes("haiku"))  return "HAIKU";
  if (modelId.includes("sonnet")) return "SONNET";
  return modelId.replace("claude-", "").toUpperCase().slice(0, 12);
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

// ── Plan badge ───────────────────────────────────────────
function planLabel(info) {
  if (!info) return null;
  const sub = (info.subscriptionType || "unknown").toLowerCase();
  const tier = (info.rateLimitTier || "").toLowerCase();

  const planText = sub === "pro" ? "PRO" : sub === "max" ? "MAX" : sub === "free" ? "FREE" : sub.toUpperCase();
  const planClass = ["pro","max","free"].includes(sub) ? sub : "unknown";

  let tierText = "INCLUDED USAGE";
  let tierClass = "";
  if (tier.includes("extra")) { tierText = "EXTRA USAGE"; tierClass = "extra"; }
  else if (tier.includes("api")) { tierText = "API KEY"; }
  else if (tier.includes("default_claude_ai")) { tierText = "INCLUDED USAGE"; }
  else if (tier) { tierText = tier.replace(/_/g, " ").toUpperCase(); }

  return { planText, planClass, tierText, tierClass };
}

function renderPlanBar(tile) {
  const bar = tile.querySelector("[data-field='plan-bar']");
  if (!bar || bar._rendered) return;
  const p = planLabel(accountInfo);
  if (!p) { bar.style.display = "none"; return; }
  bar.innerHTML = `<span class="plan-pill ${p.planClass}">${p.planText}</span><span class="plan-tier ${p.tierClass}">${p.tierText}</span>`;
  bar._rendered = true;
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

// ── Chart tooltip ────────────────────────────────────────
const tooltip    = document.getElementById("chart-tooltip");
const ttTime     = document.getElementById("tt-time");
const ttVal      = document.getElementById("tt-val");

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    + "  " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function wireChartTooltip(canvas, sessionId) {
  canvas.addEventListener("mousemove", e => {
    const sid  = canvas._sessionId || sessionId;
    const hist = chartHistory[sid] || [];
    if (hist.length < 2) { tooltip.style.display = "none"; return; }

    const rect = canvas.getBoundingClientRect();
    const xRel = e.clientX - rect.left;
    const pad  = 4;
    const cW   = rect.width - pad * 2;
    const idx  = Math.round(((xRel - pad) / cW) * (hist.length - 1));
    const i    = Math.max(0, Math.min(hist.length - 1, idx));
    const pt   = hist[i];

    const hasTokens = hist.some(p => p.tokens > 0);
    const delta = hasTokens ? pt.tokensDelta : pt.toolsDelta;
    const label = hasTokens
      ? (delta > 0 ? "+" : "") + Number(delta).toLocaleString() + " tokens burned"
      : (delta > 0 ? "+" : "") + Number(delta).toLocaleString() + " tool calls";

    ttTime.textContent = fmtTs(pt.ts);
    ttVal.textContent  = label;
    const ttModel = document.getElementById("tt-model");
    if (ttModel) ttModel.textContent = pt.model ? shortModelName(pt.model) : "";
    tooltip.style.display = "block";
    tooltip.style.left = e.clientX + "px";
    tooltip.style.top  = e.clientY + "px";
  });

  canvas.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
}

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

  // Dots — colored by model (opus=purple, haiku=green, sonnet=cyan)
  for (let i = 0; i < hist.length; i++) {
    const isLast = i === hist.length - 1;
    const m = hist[i].model || "";
    const solid = m.includes("opus") ? "#bf00ff" : m.includes("haiku") ? "#00ff88" : "#00fff0";
    const dim   = m.includes("opus") ? "rgba(191,0,255,0.55)" : m.includes("haiku") ? "rgba(0,255,136,0.55)" : "rgba(0,255,240,0.55)";
    ctx.beginPath();
    ctx.arc(px(i), py(vals[i]), isLast ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fillStyle = isLast ? solid : dim;
    ctx.shadowColor = solid;
    ctx.shadowBlur = isLast ? 6 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

// ── Helpers ──────────────────────────────────────────────
function usageBand(pct) {
  if (pct >= 100) return 'exceeded';
  if (pct >= 99)  return 'warn-99';
  if (pct >= 90)  return 'warn-90';
  if (pct >= 80)  return 'warn-80';
  if (pct >= 70)  return 'warn-70';
  return 'normal';
}

function parseNotification(text) {
  if (!text) return { resetStr: null, hasUpgrade: false };
  const m = text.match(/resets\s+(\d+[ap]m)(?:\s*\(([^)]+)\))?/i);
  const resetStr = m ? m[1] + (m[2] ? ' ' + m[2] : '') : null;
  return { resetStr, hasUpgrade: text.toLowerCase().includes('upgrade') };
}

function fmt(n) { return Number(n).toLocaleString(); }
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

function fmtTokensM(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function turnClass(turns) {
  if (turns < 20)  return "hist-turns-low";
  if (turns < 50)  return "hist-turns-normal";
  if (turns < 100) return "hist-turns-high";
  return "hist-turns-critical";
}

function wasteClass(w) {
  if (w < 2) return "hist-waste-good";
  if (w < 3) return "hist-waste-warn";
  if (w < 5) return "hist-waste-high";
  return "hist-waste-critical";
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseLabel(label) {
  // "quick/ProjectName" → { project: "ProjectName", branch: "" }
  // "ProjectName (main)" → { project: "ProjectName", branch: "main" }
  const slashMatch = label.match(/^[^/]+\/(.+)$/);
  if (slashMatch) return { project: slashMatch[1], branch: "" };
  const parenMatch = label.match(/^(.+?)\s*\((.+)\)$/);
  if (parenMatch) return { project: parenMatch[1], branch: parenMatch[2] };
  return { project: label, branch: "" };
}

function renderHistoryRows(rows) {
  const container = document.getElementById("history-rows");
  const footer    = document.getElementById("history-footer");
  if (!container || !footer) return;

  if (!rows || rows.length === 0) {
    container.innerHTML = '<div style="padding:14px;color:#444466;font-size:10px;text-align:center">No sessions in the last 7 days</div>';
    footer.textContent = "—";
    return;
  }

  let totalTokens = 0, totalCost = 0, warn3x = 0, crit5x = 0;

  container.innerHTML = rows.map(r => {
    totalTokens += r.totalTokens || 0;
    totalCost   += r.cost        || 0;
    if (r.wasteFactor >= 5) crit5x++;
    else if (r.wasteFactor >= 3) warn3x++;

    const { project, branch } = parseLabel(r.label);
    const barW  = Math.min((r.wasteFactor || 1) / 7, 1) * 100;
    const tCls  = turnClass(r.turns);
    const wCls  = wasteClass(r.wasteFactor);
    const cache = r.cacheRatio ? Math.round(r.cacheRatio * 100) + "%" : "—";
    const cost  = r.cost ? "$" + r.cost.toFixed(2) : "—";

    return `<div class="hist-row">
      <div class="hist-row-top">
        <span class="hist-project">${project}${branch ? ` <span class="hist-branch">${branch}</span>` : ""}</span>
        <span class="hist-date">${fmtDate(r.date)}</span>
        <span class="${tCls}">${r.turns}</span>
        <span class="${wCls}">${(r.wasteFactor || 1).toFixed(1)}x</span>
        <span class="hist-tokens">${fmtTokensM(r.totalTokens || 0)}</span>
        <span class="hist-cache">${cache}</span>
        <span class="hist-cost">${cost}</span>
      </div>
      <div class="hist-bar-track">
        <div class="hist-bar-fill" style="width:${barW.toFixed(1)}%"></div>
      </div>
    </div>`;
  }).join("");

  const parts = [
    `${rows.length} sessions`,
    `<span class="hist-footer-tokens">${fmtTokensM(totalTokens)} tokens</span>`,
    totalCost > 0 ? `<span class="hist-footer-cost">$${totalCost.toFixed(2)}</span>` : null,
    warn3x > 0   ? `<span class="hist-footer-warn">${warn3x} ≥3x waste</span>` : null,
    crit5x > 0   ? `<span class="hist-footer-crit">${crit5x} ≥5x waste</span>` : null,
  ].filter(Boolean);
  footer.innerHTML = parts.join(" · ");
}

function fetchHistory() {
  if (!historyOpen) return;
  fetch("/api/history")
    .then(r => r.json())
    .then(renderHistoryRows)
    .catch(() => {
      const footer = document.getElementById("history-footer");
      if (footer) footer.textContent = "clauditor unavailable";
    });
}

function setHistoryOpen(open) {
  historyOpen = open;
  localStorage.setItem("claudepulse_history_open", String(open));

  const panel   = document.getElementById("history-panel");
  const divider = document.getElementById("history-divider");
  const btn     = document.getElementById("btn-history");

  panel  ?.classList.toggle("open", open);
  divider?.classList.toggle("open", open);
  btn    ?.classList.toggle("active", open);
  btn && (btn.textContent = open ? "▼ HISTORY" : "▲ HISTORY");

  if (open) fetchHistory();
}

// ── Refresh rate buttons ─────────────────────────────────
document.querySelectorAll(".rate-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.rate;
    if (mode === "refresh") {
      renderAll();
      fetchHistory();
      return;
    }
    setRefreshMode(mode);
  });
});
setRefreshMode("high");

// History toggle
document.getElementById("btn-history")?.addEventListener("click", () => {
  setHistoryOpen(!historyOpen);
});
document.getElementById("history-divider")?.addEventListener("click", () => {
  setHistoryOpen(false);
});

// Restore persisted open state on load
if (historyOpen) setHistoryOpen(true);

setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('.tile').forEach(el => {
    const sa = el.dataset.startedAt;
    const pf = el.dataset.projectFirstSeen;
    const sessEl = el.querySelector('[data-field="elapsed-sess"]');
    const projEl = el.querySelector('[data-field="elapsed-proj"]');
    if (sessEl && sa) sessEl.textContent = fmtElapsed(now - Number(sa));
    if (projEl && pf) projEl.textContent = fmtElapsed(now - Number(pf));
  });
}, 1000);

connect();
