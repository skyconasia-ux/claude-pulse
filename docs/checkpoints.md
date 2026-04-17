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

## CURRENT CHECKPOINT

### 2026-04-18 — Live Token Data via JSONL Journal Watcher

**Objective:** Surface real token counts, cost, burn rate, and ETA live — without OTEL config.

**Completed:**
- `JournalWatcher` tails `~/.claude/projects/**/*.jsonl` via `fs.watch`; each assistant response appends a line with `message.usage` — picked up immediately
- Bootstrap on startup: reads sessions modified in last 24h, emits cumulative token totals per session
- `token_delta` event type added — updates tokens/cost without clobbering lifecycle state
- Stats row consolidated to single 5-col row: COST · TURNS · BURN/S · ETA · TOOLS
- Checkpoint banner extended to 60s display
- 28/28 tests passing; pushed to GitHub

**Current state:** Server tails live JSONL. Tokens update per assistant turn. Hooks still count tool calls. Both complement each other.

**Next steps (pending, not started):**
- Confirm live token flow after server restart (user to test)
- PID tracking → real process kill on Abort
- Session history persistence to disk
- Terminal dashboard: multi-session layout
