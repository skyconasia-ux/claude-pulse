# Claude Working Memory

Project: LiveVisualUsage
Last updated: 2026-04-17

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping
- session_id and project_name flow from hook payload (cwd → last path segment)
- WsMessage protocol: sessions_snapshot on connect, session_updated on change

## Current State
- All features shipped and stable
- 28/28 tests passing
- GitHub: https://github.com/skyconasia-ux/live-visual-usage (public, MIT)
- Port: 3001 (HTTP + WS)

## Architecture (immutable unless explicitly redesigned)
HooksAdapter / OtelAdapter → EventBus → SessionRegistry → N × SessionStore → WsBroadcaster → browser + terminal

## Key Types
- SessionState: session_id, project_name, lifecycle (LifecycleState), last_seen_ms, is_stale, tokens_*, cost_usd, turns, alert_level
- NormalizedEvent: session_id? (optional), project_name? (optional), source, type, tokens, cost_usd, timestamp_ms
- Abort endpoint: POST /abort/:sessionId → registry.markStopped()

## Pending (not started)
- PID tracking → real process kill on abort
- Session history persistence to disk
- Terminal multi-session layout

## Key Decisions
See decisions.md at project root for full Q&A log.
