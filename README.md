# LiveVisualUsage

Real-time telemetry and visualization for Claude Code CLI.  
Monitor token usage, cost, turn count, and session lifecycle across multiple concurrent Claude instances — from a browser dashboard or terminal UI.

---

## What It Does

LiveVisualUsage runs a local server that receives telemetry from Claude Code hooks and OpenTelemetry, then streams live data to a browser dashboard and/or a terminal dashboard via WebSocket.

- **Multi-session monitoring** — one neon-cyber tile per Claude project, all in the same browser tab
- **Full lifecycle visibility** — tracks every state: `tool_use`, `idle`, `waiting`, `closed`, `stopped`, `unknown`, and more
- **Stale detection** — sessions that go quiet are dimmed but stay visible; they close automatically after 5 minutes
- **Per-session Abort** — each tile has an Abort button (tooltip: *Code 10 Abort*) with a confirmation step
- **Dual frontend** — browser dashboard (Neon Cyber theme) or blessed-contrib terminal UI
- **Structured logging** — JSON log lines in `logs/app.log`; `LOG_LEVEL=debug` for verbose console output

---

## Quick Start

```bash
cp config.example.json config.json
npm install
npm run dev
```

Choose `[1] Browser`, `[2] Terminal`, or `[3] Both` at the prompt.  
Browser dashboard: **http://localhost:3001/dashboard**

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| Claude Code CLI | any (hooks support required) |
| OS | Windows, macOS, Linux |

---

## Claude Code Integration

Add to `.claude/settings.json` in the project you want to monitor:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }]
    }],
    "Notification": [{
      "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }]
    }]
  }
}
```

The server must be running before Claude Code starts. It does not need to be restarted between Claude sessions.

---

## Configuration

Edit `config.json` (gitignored — copy from `config.example.json`):

| Key | Default | Description |
|---|---|---|
| `token_threshold` | `100000` | Token limit before checkpoint alerts |
| `turn_threshold` | `20` | Turn limit before mandatory checkpoint |
| `refresh_active_ms` | `1000` | Tick interval when session is active |
| `refresh_idle_ms` | `5000` | Tick interval when session is idle |
| `server_port` | `3001` | HTTP + WebSocket port |
| `ws_port` | `3001` | WebSocket port (same as HTTP) |
| `otel_enabled` | `true` | Enable OpenTelemetry endpoint |

---

## Architecture

```
Claude Code CLI
  ├── hooks (PostToolUse / Stop / Notification)  →  POST /hook
  └── OpenTelemetry spans (optional)             →  POST /otel
                          ▼
               TelemetryServer (Express + WS)
               ┌─────────────────────────────────┐
               │ HooksAdapter                     │
               │ OtelAdapter                      │
               │ EventNormalizer                  │
               │ EventBus (typed pub/sub)          │
               │ SessionRegistry ─────────────────┤
               │   └─ SessionStore × N            │
               │ WsBroadcaster                    │
               └─────────────────────────────────┘
                          ▼              ▼
               Browser Dashboard   Terminal Dashboard
```

**Data flow:**
1. Hooks/OTEL payloads arrive at HTTP endpoints
2. `EventNormalizer` extracts `session_id` (from hook payload), `project_name` (from `cwd`), tokens, cost, and lifecycle type
3. `EventBus` distributes `NormalizedEvent` to `SessionRegistry`
4. `SessionRegistry` routes each event to the matching `SessionStore` (creates one if new)
5. `SessionStore` updates `SessionState` and emits checkpoints
6. `WsBroadcaster` pushes `sessions_snapshot` on new WS connection, `session_updated` on every state change

---

## Session Lifecycle States

| State | Meaning |
|---|---|
| `not_launched` | No events received yet |
| `running` | Claude is active (Notification hook) |
| `tool_use` | Claude is executing a tool (PostToolUse hook) |
| `thinking` | Inferred: active but no tool confirmed |
| `idle` | Turn complete, awaiting user (Stop hook) |
| `waiting` | Idle for > 60 seconds |
| `cancelled` | Action was cancelled |
| `ctrl_c` | Ctrl+C detected |
| `closed` | Session ended or stale > 5 minutes |
| `stopped` | Abort requested via dashboard |
| `unknown` | State cannot be determined |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/hook` | Receive Claude Code hook event |
| `POST` | `/otel` | Receive OpenTelemetry span batch |
| `POST` | `/abort/:sessionId` | Mark session as stopped |
| `GET` | `/dashboard` | Serve browser dashboard |
| `WS` | `ws://localhost:3001` | Live session stream |

### WebSocket Message Types

```typescript
{ type: "sessions_snapshot", sessions: SessionState[] }   // sent on connect
{ type: "session_updated",   session: SessionState }       // sent on any change
{ type: "checkpoint_event",  severity: "suggested" | "mandatory", state: SessionState }
```

---

## File Map

```
src/
  types.ts                     Shared types: NormalizedEvent, SessionState, WsMessage, AppConfig
  config.ts                    Loads config.json
  monitor/
    EventBus.ts                Typed EventEmitter singleton
    EventNormalizer.ts         Raw hook/OTEL payload → NormalizedEvent
    SessionStore.ts            Single-session state machine + checkpoint logic
    SessionRegistry.ts         Multi-session router + stale detection
  wrapper/
    HooksAdapter.ts            POST /hook → EventBus
    OtelAdapter.ts             POST /otel → EventBus (optional, graceful disable)
  server/
    WsBroadcaster.ts           WebSocket server: sessions_snapshot + session_updated
    logger.ts                  Structured JSON logger (4 levels, file + console)
    index.ts                   Entry point: wires all components, abort endpoint
  frontend/
    browser/
      index.html               Neon Cyber multi-session dashboard
      dashboard.js             WS client, tile rendering, abort flow
    terminal/
      index.ts                 blessed-contrib terminal UI (most-active session)
tests/
  monitor/EventNormalizer.test.ts
  monitor/SessionStore.test.ts
  server/WsBroadcaster.test.ts
  wrapper/adapters.test.ts
docs/
  architecture.md
  checkpoints.md
  claude.md
  decisions.md                 All design Q&A decisions
```

---

## Checkpoint Logic

Checkpoints are **independent** — token-based and turn-based fire separately:

| Trigger | Event |
|---|---|
| tokens ≥ 70% of `token_threshold` | `checkpoint_suggested` |
| tokens ≥ 90% of `token_threshold` | `checkpoint_mandatory` |
| turns ≥ 10 | `checkpoint_suggested` |
| turns ≥ `turn_threshold` | `checkpoint_mandatory` |

A 3-turn cooldown prevents repeated `checkpoint_suggested` spam. `checkpoint_mandatory` always fires.

---

## Logs

While the server is running, tail `logs/app.log` for structured JSON output:

```bash
tail -f logs/app.log
```

Set `LOG_LEVEL=debug` to see verbose telemetry messages (hook events, WS snapshots, etc.):

```bash
LOG_LEVEL=debug npm run dev
```

---

## Development

```bash
npm test          # run all tests (vitest)
npm run build     # compile TypeScript to dist/
npm run dev       # run server via tsx (no compile step)
```

---

## Stack

TypeScript · Node.js · Express · ws · blessed-contrib · vitest · supertest
