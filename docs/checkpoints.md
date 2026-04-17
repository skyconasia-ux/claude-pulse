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

### 2026-04-18 — Polish + Persistence + Plan Badge

**Completed since last checkpoint:**
- **Project renamed** to Claude Pulse everywhere: package.json, all source files, docs, GitHub repo (`skyconasia-ux/claude-pulse`), release zip
- **Session state persistence** (`data/sessions.json`): saves every 3s + on clean shutdown; loads on startup; bootstrap uses `Math.max` so token counts survive restarts without dropping
- **Chart tooltip** on TOKEN BURN — LIVE: hover any point to see exact date/time recorded + tokens burned at that point (delta, not cumulative)
- **Plan badge** per tile: reads `~/.claude/.credentials.json` → shows subscription type (PRO/MAX/FREE) + usage tier label. Note: billing pool switching (Pro included → $20 CC promo → extra credits) is NOT detectable from local files — Anthropic doesn't write that state anywhere locally
- GitHub repo: `https://github.com/skyconasia-ux/claude-pulse`; release: `ClaudePulse-v1.0.0.zip`

**Known limitation — cost display:**
Cost shown is a *calculated estimate* at API rates ($3/M input, $15/M output flat). Actual API pricing differentiates cache reads ($0.30/M) vs cache writes ($3.75/M) vs regular input — so displayed cost is an overestimate. For Pro/promo users: this is the hypothetical API cost, not what you're actually charged (you pay a flat subscription).

**Next steps:**
- PID tracking → real process kill on Abort
- Terminal dashboard: multi-session layout
- Fix cost calculation to use correct cache-tier rates
