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

### 2026-04-18 — Clauditor History Panel
- Collapsible `▲ HISTORY` panel; `GET /api/history`; flat table with waste bar; refresh tied to topbar mode; localStorage persistence; 34/34 tests

### 2026-04-18 — Tile Enhancements: Elapsed Time + Usage Warnings
- Session + project elapsed time row per tile; `project_first_seen_ms` persisted (backward-compat migration); usage-limit warning banner (amber ≥70%, red ≥90%); 41/41 tests

---

## CURRENT CHECKPOINT

### 2026-04-18 — Model-Aware Token Tracking (plan written, not yet executed)

**Objective:** Per-model token breakdown, weighted Sonnet-equivalent budget bar, correct cost rates per model.

**Completed:**
- All tile enhancements shipped (elapsed time, usage banner, first-seen tracking) — 41/41 tests
- Implementation plan written: `docs/superpowers/plans/2026-04-18-model-aware-token-tracking.md`

**Current progress:** Plan ready, not yet implemented.

**Next step:** Execute model-aware token tracking plan (6 tasks).

**Pending:**
- Model-aware token tracking (Tasks 1–6 in plan)
- PID tracking → real process kill on Abort
- Terminal multi-session layout
