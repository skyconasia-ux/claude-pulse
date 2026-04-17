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

---

## CURRENT CHECKPOINT

### 2026-04-18 — Runtime Fixes + Hook Wiring

**Objective:** Fix production runtime issues: shutdown spam, missing area chart, hooks not wired.

**Completed:**
- Graceful shutdown: WS no-clients → 3s grace → clean port release (SIGINT/SIGTERM same path)
- Shutdown spam fixed: 3s minimum connection duration before shutdown triggers (suppresses refresh/load flicker)
- Auto-open browser on startup (`child_process` exec, cross-platform)
- Area chart restored per Layout C Hybrid spec: per-tile canvas, turn-by-turn token burn, gradient fill + glow dots
- Global hooks wired: `~/.claude/settings.json` PostToolUse/Stop/Notification → `POST localhost:3001/hook`
- 28/28 tests passing; all changes pushed to GitHub

**Current state:** Server functional. Hooks configured globally. Existing Claude sessions need restart to pick up hooks.

**Next steps (pending, not started):**
- PID tracking → real process kill on Abort
- Session history persistence to disk
- Terminal dashboard: multi-session layout
