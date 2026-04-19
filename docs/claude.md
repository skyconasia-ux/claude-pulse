# Claude Working Memory

Project: Claude Pulse
Last updated: 2026-04-19

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping
- session_id and project_name flow from hook payload (cwd → last path segment)
- WsMessage protocol: sessions_snapshot on connect, session_updated on change

## Current State
- Fully operational live monitoring — 2026-04-19
- All metrics from JSONL polling: tokens, cost, turns, tools, burn/s, ETA
- 80/80 tests passing
- PID tracking: real process kill on Abort (parent PID injected via PowerShell hook)
- Terminal dashboard: multi-session layout with keyboard navigation, model badge, weighted budget
- Tile enhancements: elapsed time row + usage-limit warning banner per tile
- Phase 3 browser dashboard: live usage % alert card, 5-band warning system (70/80/90/99/exceeded), header alert badge, model in graph tooltip
- In-tile warning system: real CLI message text, daily/weekly bars, severity-driven blink (yellow=1s, red=0.4s), advisory text
- Model-aware token tracking: per-model breakdown, weighted Sonnet-equivalent budget bar, correct cost rates
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
- SessionState model fields: model_last (last model seen), models (per-model tokens/cost map), weighted_tokens_total (Sonnet-equiv budget units, undefined until first model event)
- NormalizedEvent: source ("hook"|"otel"|"journal"), type (includes "token_delta"), model?, metadata.bootstrapTurns, metadata.toolsDelta
- token_delta: sets turns (bootstrap) or +1 (live); accumulates tools via toolsDelta; does NOT change lifecycle
- Weighted budget: Opus×5, Sonnet×1, Haiku×0.08; ceiling 1,000,000; alert/ETA use weighted_tokens_total ?? tokens_total
- Abort: POST /abort/:sessionId → registry.markStopped()

## Pending
- Smoke test: fire curl notification → verify in-tile warning shows real message text + blink color
- Phase 5: abort controls, production hardening
- v0.1 public release

## Key Decisions
See decisions.md at project root for full Q&A log.
