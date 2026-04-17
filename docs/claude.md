# Claude Working Memory

Project: LiveVisualUsage
Last updated: 2026-04-18

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping
- session_id and project_name flow from hook payload (cwd → last path segment)
- WsMessage protocol: sessions_snapshot on connect, session_updated on change

## Current State
- All metrics live from JSONL: tokens, cost, turns, tools, burn/s, ETA — 2026-04-18
- 28/28 tests passing
- GitHub: https://github.com/skyconasia-ux/live-visual-usage (public, MIT)
- Port: 3001 (HTTP + WS)
- Global hooks: `~/.claude/settings.json` (PostToolUse/Stop/Notification → localhost:3001/hook via PowerShell)
- Shutdown: WS disconnect ≥3s → 3s grace → clean exit; refresh/flicker suppressed
- Area chart: per-tile canvas, turn-by-turn token burn (Layout C Hybrid)
- Stats: COST · TURNS · BURN/S · ETA · TOOLS (single 5-col row)
- Checkpoint banner: 60s display

## Architecture (immutable unless explicitly redesigned)
HooksAdapter / OtelAdapter / JournalWatcher → EventBus → SessionRegistry → N × SessionStore → WsBroadcaster → browser + terminal

## Key Types
- SessionState: session_id, project_name, lifecycle (LifecycleState), last_seen_ms, is_stale, tokens_*, cost_usd, turns, tool_calls_total, alert_level
- NormalizedEvent: source ("hook"|"otel"|"journal"), type (includes "token_delta"), tokens, cost_usd, timestamp_ms
- token_delta: updates tokens/cost only — does not change lifecycle or activity_state
- Abort endpoint: POST /abort/:sessionId → registry.markStopped()

## Pending (not started)
- Confirm live token flow after server restart
- PID tracking → real process kill on abort
- Session history persistence to disk
- Terminal multi-session layout

## Key Decisions
See decisions.md at project root for full Q&A log.
