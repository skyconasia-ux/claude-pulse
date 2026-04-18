# Checkpoints (APPEND ONLY — DO NOT OVERWRITE)

## HISTORY

### 2026-04-17 — Project Initialized
- Shipped: full 10-task MVP — EventBus, EventNormalizer, SessionStore, HooksAdapter, OtelAdapter, WsBroadcaster, TelemetryServer, browser dashboard (Neon Cyber), terminal dashboard (blessed-contrib), structured logger
- 28/28 tests passing; pushed to GitHub

### 2026-04-17 — Multi-Session + Lifecycle Visibility
- Shipped: SessionRegistry (N sessions), LifecycleState (11 states), sessions_snapshot/session_updated WS protocol, full-width browser tile grid, per-tile Abort button (Code 10 Abort), stale detection, terminal dashboard updated
- 28/28 tests passing; pushed to GitHub

### 2026-04-17 — Operational / Stabilisation
- GitHub clean: .gitignore, MIT LICENSE, config.example.json, full README
- Port conflict resolved; server stable on `npm run dev`

### 2026-04-18 — Runtime Fixes + Hook Wiring
- Graceful shutdown, refresh-flicker suppression, auto-open browser, area chart restored (Layout C Hybrid)
- Global hooks wired via PowerShell `Invoke-RestMethod` (curl stdin unreliable on Windows)
- Task Manager refresh rate control (High/Normal/Low/Paused + Refresh Now)
- Fluid chart: one history point per session_updated (120-point ring buffer)
- 28/28 tests passing; pushed to GitHub

---

### 2026-04-18 — Live Token Data via JSONL Journal Watcher
- 1s polling replaces `fs.watch` (reliable on Windows); 1h active window, 1 file per project dir
- Token calc fixed: latest `input_tokens` = context size; live = delta per turn
- Totals box per tile; blinking banner; animated counters; empty-state grid fix

### 2026-04-18 — Full Live Metrics from JSONL
- Turns: count `assistant` lines in JSONL (bootstrap seeds, live +1 per turn)
- Tools: count `tool_use` content blocks per message via `metadata.toolsDelta`
- Burn/s + ETA: populate after ≥2 turns; all 28 tests passing

---

### 2026-04-18 — Polish + Persistence + Plan Badge

**Completed:**
- Project renamed to Claude Pulse everywhere; session state persistence (`data/sessions.json`); chart tooltip (delta, not cumulative); plan badge per tile (PRO/MAX/FREE from credentials)
- GitHub: `https://github.com/skyconasia-ux/claude-pulse`; release: `ClaudePulse-v1.0.0.zip`

### 2026-04-18 — Clauditor Panel + Checkpoint Button
- Collapsible history panel, `/api/history` endpoint, 7-day sessions table with waste/cost/turns, localStorage persistence

---

## CURRENT CHECKPOINT

### 2026-04-18 — Clauditor History Panel

**Completed:**
- Collapsible `▲ HISTORY` panel below live tiles (hidden by default, toggle in topbar)
- `GET /api/history` endpoint: merges `clauditor report --json` + `clauditor sessions --json`, 10s cache, stderr captured in error logs
- Flat chronological table: project, date, turns (colour-coded), waste (colour-coded), tokens, cache%, cost
- Waste bar per row (gradient green→red, scaled to wasteFactor/7)
- Refresh tied to topbar mode: High=15s, Normal=45s, Low=90s, Paused=off; ↺ Now triggers immediate refresh
- localStorage persistence for open/closed state
- 34/34 tests passing

**Next step:** PID tracking → real process kill on Abort

---

### 2026-04-18 — Tile Enhancements: Elapsed Time + Usage Warnings

**Completed:**
- Session elapsed time + project age (first-ever session for project) displayed in each tile time row
- `project_first_seen_ms` persisted in `data/sessions.json` alongside sessions; backward-compatible migration from bare-array format
- Usage-limit warning banner per tile: extracts message from Claude Code Notification hook, amber (≥70%) or red (≥90%), sticky until session ends
- 41/41 tests passing

**Next step:** Spec B — PID tracking + real process kill on Abort, cache-tier cost rates, terminal multi-session layout
