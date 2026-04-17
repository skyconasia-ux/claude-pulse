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

## CURRENT CHECKPOINT

### 2026-04-18 — Confirmed Live + Distribution Planning

**Objective:** Verify full live monitoring works end-to-end; plan distribution for other users.

**Completed:**
- All metrics confirmed live: tokens, cost, turns (784 in active session), tools, burn/s, ETA
- Each new PowerShell/Claude Code session resets counters to 0 (new JSONL file per session)
- Counter animation working (700ms ease-out roll-up on all numeric fields)
- 8 commits pushed to GitHub; repo at `skyconasia-ux/live-visual-usage`

**Current state:** Fully operational. Monitoring this session live. Repo is 8 commits ahead — pushing now.

**Next steps:**
- Distribution: build pipeline + Windows release package (Node.js 18+ required)
- PID tracking → real process kill on Abort
- Session history persistence to disk
- Terminal dashboard: multi-session layout
