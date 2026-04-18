# Claude Working Memory

Project: Claude Pulse
Last updated: 2026-04-18

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping
- session_id and project_name flow from hook payload (cwd → last path segment)
- WsMessage protocol: sessions_snapshot on connect, session_updated on change

## Current State
- Fully operational live monitoring — 2026-04-18
- All metrics from JSONL polling: tokens, cost, turns, tools, burn/s, ETA
- 28/28 tests passing
- GitHub: https://github.com/skyconasia-ux/claude-pulse (public, MIT)
- Port: 3001 (HTTP + WS on same port)
- Hooks: `~/.claude/settings.json` PostToolUse/Stop/Notification → PowerShell → localhost:3001/hook
- JournalWatcher: 1s poll, 1h window, 1 file per project dir, delta input tokens
- Each Claude Code session (PowerShell launch) = new JSONL = counters reset to 0
- Checkpoint banner: 60s blinking (0.7s mandatory, 1.2s suggested)
- Animated counters: 700ms ease-out on all numeric fields

## Architecture (immutable unless explicitly redesigned)
HooksAdapter / OtelAdapter / JournalWatcher → EventBus → SessionRegistry → N × SessionStore → WsBroadcaster → browser + terminal

## Key Types
- SessionState: tokens_*, cost_usd, turns, tool_calls_total, burn_rate_per_sec, eta_to_threshold_sec, alert_level
- NormalizedEvent: source ("hook"|"otel"|"journal"), type (includes "token_delta"), metadata.bootstrapTurns, metadata.toolsDelta
- token_delta: sets turns (bootstrap) or +1 (live); accumulates tools via toolsDelta; does NOT change lifecycle
- Abort: POST /abort/:sessionId → registry.markStopped()

## Pending
- PID tracking → real process kill on abort
- Terminal multi-session layout
- Fix cost estimate to use cache-tier rates

## Key Decisions
See decisions.md at project root for full Q&A log.
