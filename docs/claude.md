# Claude Working Memory

Project: LiveVisualUsage
Last updated: 2026-04-17

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping
- session_id and project_name flow from hook payload (cwd → last path segment)
- WsMessage protocol: sessions_snapshot on connect, session_updated on change (no more single-session snapshot/delta)

## Current State
- MVP: complete, tested, shipped
- Multi-session + lifecycle upgrade: complete, tested, shipped
- 28/28 tests passing

## Architecture (immutable unless explicitly redesigned)
HooksAdapter / OtelAdapter → EventBus → SessionRegistry → N × SessionStore → WsBroadcaster → browser + terminal

## Key Decisions
See decisions.md at project root for full Q&A log.

## Active Fields Added (2026-04-17)
- SessionState: project_name, lifecycle (LifecycleState), last_seen_ms, is_stale
- NormalizedEvent: session_id? (optional), project_name? (optional)
- Abort endpoint: POST /abort/:sessionId → registry.markStopped()
