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

### 2026-04-18 — Model-Aware Token Tracking
- Per-model cost rates (Opus/Sonnet/Haiku); `model` extracted from hook + OTel payloads
- `accumulateModel()` in SessionStore: per-model token/cost map, `model_last`, `weighted_tokens_total`
- Weighted Sonnet-equivalent budget bar in tiles (Opus×5, Haiku×0.08, Sonnet×1); label "BUDGET LEFT"
- Per-model breakdown section in each tile; alert/ETA use weighted budget; 51/51 tests

---

---

### 2026-04-19 — PID Tracking + Terminal Multi-Session (complete)

**PID Tracking (all 5 tasks done):**
- `pid` field added to `NormalizedEvent` and `SessionState`
- PID extracted from hook payload in `EventNormalizer`
- PID stored and preserved in `SessionStore` across events
- `markStopped` in `SessionRegistry` calls `process.kill(pid)` with error handling
- PowerShell hooks updated to inject parent PID in all three hook types
- 58/58 tests passing after PID work

**Terminal Multi-Session (all 3 tasks done):**
- `src/frontend/terminal/helpers.ts` created with pure logic helpers (pickMostActive, pickSelected, fmtEta, fmtTokens, alertColor, sessionRows, shortModelName)
- `tests/frontend/terminal.test.ts` — 22 new tests, all passing
- `src/frontend/terminal/index.ts` — full rewrite: session list table (top, keyboard-navigable), detail pane (metrics + model badge + weighted budget, burn chart, prediction, alert), log box
- 80/80 tests total; pushed to GitHub

### 2026-04-19 — Phase 3 Browser Dashboard (complete)
- Model tooltip, 5-band warning CSS, header alert badge, structured alert card; 80/80 tests

---

### 2026-04-19 — Phase 4 + Smoke Test Bug Fixes (HISTORY)
- Phase 4 complete: model detection, project elapsed time, terminal zoom/pan, chart model dots
- Smoke test fixes: JSONL model extraction, duplicate events, Stop hook PS fix, CLOSED→IDLE fix
- 3 permanent model rows, warning sync with CLI notification_level, chart zoom/drag
- 80/80 tests passing

### 2026-04-19 — Dashboard Redesign + Warning System (HISTORY)
- Command center box above tiles: aggregate tokens/cost/turns/tools/burn + 3 model blocks (OPUS/SONNET/HAIKU with IN/OUT/COST)
- Alert card always visible in every tile: green=all clear, yellow=slow blink+checkpoint advisory, red=fast blink+abort advisory
- Floating checkpoint banner removed; replaced by in-tile checkpoint button flash
- Honest notification display: reported % + age + live extrapolation when account limit known
- Daily bar = session token count (honest); weekly bar shown only when CLI sends weekly notification
- OTel span attr logging added to discover rate-limit keys

---

### 2026-04-19 — Production Ready / Open for Contributors (HISTORY)

- Full multi-session browser dashboard with command center aggregate box
- Per-tile: model rows (OPUS/SONNET/HAIKU), elapsed time, chart zoom/drag, always-on warning card
- Warning card: green/yellow/red severity, real CLI message, live reset countdown, advisory text
- Account usage: notification snapshot + live extrapolation from derived account limit
- Floating banner removed; all warnings in-tile or command center
- Terminal dashboard: keyboard nav, model badge, weighted budget, burn chart zoom/pan
- 80/80 tests; tsc clean; GitHub public MIT

---

### 2026-04-19 — Session Lifecycle + Pre-Release Security (HISTORY)

- `session_removed` WS message; server removes closed/stopped sessions after 30s; browser tile fades out
- Security: personal paths and username scrubbed from all tracked docs, tests, and comments
- 80/80 tests; tsc clean; pushed to GitHub

---

## CURRENT CHECKPOINT

### 2026-04-20 — v0.1.0 Public Release

**Objective:** Ship the first tagged public release on GitHub.

**Completed work:**
- `gh release create v0.1.0` — release published at https://github.com/skyconasia-ux/claude-pulse/releases/tag/v0.1.0
- Release notes: feature list, quick start, requirements, v0.2 roadmap

**Current progress:** v0.1.0 live on GitHub. Repo public, MIT licensed.

**Next step:** Community testing; monitor issues; plan v0.2.

**Pending tasks:**
- OTel span inspection: check server logs for `anthropic-ratelimit-*` keys after next `claude` run
- Phase 5: abort controls in browser dashboard
- Production hardening
