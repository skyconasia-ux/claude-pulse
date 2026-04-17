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
- `JournalWatcher` switched from `fs.watch` to 1s polling (reliable on Windows)
- Only bootstraps most-recent JSONL per project dir within 1h window — no ghost tiles
- Token calculation fixed: bootstrap uses latest `input_tokens` (context window size, not sum); live = delta per turn
- Totals box added to each tile (TOTAL TOKENS / COST / TURNS / TOOLS) with animated counters
- Blinking checkpoint banner (0.7s mandatory, 1.2s suggested), 60s display
- Empty-state grid-hide bug fixed; High refresh = 1s timer
- 28/28 tests passing; pushed to GitHub

---

## CURRENT CHECKPOINT

### 2026-04-18 — Full Live Metrics from JSONL

**Objective:** Fix turns, tools, burn/s, ETA all showing 0 — derive them directly from JSONL.

**Completed:**
- Turns: count `assistant` lines per session in JSONL — bootstrap seeds historical count, each live event increments by 1
- Tools: count `tool_use` content blocks inside each assistant message — passed via `metadata.toolsDelta`
- `SessionStore.token_delta` handler now applies `bootstrapTurns` (set) and `toolsDelta` (accumulate) from event metadata
- Burn/s + ETA: now populate naturally once 2+ turn events arrive
- Animated counters on all numeric fields (700ms ease-out roll-up)
- 28/28 tests passing

**Current state:** Tokens, cost, turns, tools all derive from JSONL polling. Burn/s and ETA populate after ≥2 turns.

**Next steps:**
- PID tracking → real process kill on Abort
- Session history persistence to disk
- Terminal dashboard: multi-session layout
