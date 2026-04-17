const WS_URL = `ws://${location.host}`;
let ws;
let state = {};
let burnHistory = [];
let startedAt = null;
let elapsedTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 2000);
}

function handleMessage(msg) {
  if (msg.type === "snapshot") {
    state = msg.state;
    startedAt = startedAt || Date.now();
    if (!elapsedTimer) elapsedTimer = setInterval(updateElapsed, 1000);
    render();
  } else if (msg.type === "delta") {
    state = { ...state, ...msg.changes };
    render();
  } else if (msg.type === "checkpoint_event") {
    state = msg.state;
    render();
    showBanner(msg.severity);
  }
}

function fmt(n) { return Number(n).toLocaleString(); }
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

function render() {
  const threshold = 100000;
  const total = state.tokens_total || 0;
  const pct = Math.min(total / threshold * 100, 100);
  const left = Math.max(threshold - total, 0);

  document.getElementById("tokens-total").textContent = fmt(total);
  document.getElementById("tokens-in").textContent = fmt(state.tokens_in || 0);
  document.getElementById("tokens-out").textContent = fmt(state.tokens_out || 0);
  document.getElementById("tokens-left").textContent = fmt(left);
  document.getElementById("progress-fill").style.width = pct.toFixed(1) + "%";
  document.getElementById("pct-label").textContent = pct.toFixed(0) + "% used";
  document.getElementById("cost").textContent = "$" + (state.cost_usd || 0).toFixed(4);
  document.getElementById("turns").textContent = state.turns || 0;
  document.getElementById("burn-rate").textContent = Math.round(state.burn_rate_per_sec || 0);
  document.getElementById("eta").textContent = fmtEta(state.eta_to_threshold_sec);

  const level = state.alert_level || "green";
  const alertBox = document.getElementById("alert-box");
  alertBox.className = `stat-box alert ${level}`;
  document.getElementById("alert-level").textContent =
    `● ${level.toUpperCase()}`;

  document.getElementById("activity").textContent =
    state.activity_state === "active" ? "● ACTIVE" : "● IDLE";
  document.getElementById("activity").style.color =
    state.activity_state === "active" ? "var(--green)" : "var(--dim)";

  document.getElementById("capacity-status").textContent =
    `● ${level === "green" ? "Capacity safe" : level === "yellow" ? "Approaching limit" : "CRITICAL"} — ${fmt(left)} tokens remaining`;

  const turnsToNext = Math.max(0, 20 - (state.turns || 0));
  document.getElementById("checkpoint-status").textContent =
    turnsToNext > 0 ? `⚠ Checkpoint in ${turnsToNext} turns (turn 20)` : "⚠ Checkpoint due";

  // Burn chart
  if (state.tokens_total !== undefined) {
    burnHistory.push(total);
    if (burnHistory.length > 30) burnHistory.shift();
    drawChart();
  }
}

function drawChart() {
  const canvas = document.getElementById("burn-chart");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.offsetWidth;
  canvas.height = 70;
  const w = canvas.width, h = canvas.height;
  const max = Math.max(...burnHistory, 1);
  ctx.clearRect(0, 0, w, h);
  if (burnHistory.length < 2) return;
  const step = w / (burnHistory.length - 1);
  const pts = burnHistory.map((v, i) => [i * step, h - (v / max) * (h - 8)]);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(0,255,240,0.3)");
  grad.addColorStop(1, "rgba(0,255,240,0.01)");
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  const lineGrad = ctx.createLinearGradient(0, 0, w, 0);
  lineGrad.addColorStop(0, "#00ff88");
  lineGrad.addColorStop(0.5, "#00fff0");
  lineGrad.addColorStop(1, "#bf00ff");
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2; ctx.stroke();

  // Dots
  for (const [x, y] of pts) {
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,255,240,0.6)"; ctx.fill();
  }
}

function showBanner(severity) {
  const banner = document.getElementById("banner");
  banner.textContent = severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
  banner.className = `banner ${severity}`;
  banner.style.display = "block";
  setTimeout(() => { banner.style.display = "none"; }, 4000);
}

function updateElapsed() {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  document.getElementById("elapsed").textContent =
    m > 0 ? `${m}m ${sec}s elapsed` : `${sec}s elapsed`;
}

connect();