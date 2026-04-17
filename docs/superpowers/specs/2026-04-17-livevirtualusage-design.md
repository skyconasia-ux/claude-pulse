# LiveVisualUsage — Design Spec

**Date:** 2026-04-17
**Status:** Approved
**Location:** `C:\Users\quick\LiveVisualUsage`

---

## 1. Objective

Build a real-time telemetry and visualization system for Claude Code CLI usage. The system streams live session data (tokens, cost, turns, burn rate, predictions) to two independent dashboards — a browser dashboard and a terminal dashboard — both fed by the same WebSocket backend.

---

## 2. Architecture

### Pattern: Adapter-Based Pipeline

One Node.js (TypeScript) process runs the entire backend. Source adapters feed raw events in. A normalized event pipeline processes them. A WebSocket broadcaster pushes state to all connected clients.

```
Claude Code CLI
   ├── hooks (PostToolUse, Stop, Notification)
   │      └─→ POST /hook
   │
   └── OTEL export (optional, supplementary)
          └─→ POST /otel
                     │
                     ▼
              TelemetryServer  (single Node.js process)
              ┌─────────────────────────────────────────┐
              │  HooksAdapter       OtelAdapter          │
              │        └──────────────┘                  │
              │                 │                        │
              │          EventNormalizer                 │
              │                 │                        │
              │            EventBus                      │
              │           ┌─────┴──────┐                │
              │      SessionStore   WS Broadcaster       │
              └─────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           Browser Dashboard        Terminal Dashboard
           (HTML/JS, Neon Cyber)    (blessed-contrib)
```

### Components

| Component | Responsibility |
|---|---|
| `HooksAdapter` | Receives raw Claude Code hook payloads via `POST /hook`, passes to EventNormalizer |
| `OtelAdapter` | Receives OTEL span/metric payloads via `POST /otel`. Disabled gracefully if OTEL is not configured. |
| `EventNormalizer` | Converts raw hook or OTEL payloads into a common `NormalizedEvent` schema |
| `EventBus` | Internal typed pub/sub (Node.js `EventEmitter`). Decouples adapters from consumers. |
| `SessionStore` | Subscribes to EventBus `"event"` topic. Maintains in-memory session state. Emits checkpoint events. |
| `WS Broadcaster` | Subscribes to EventBus `"state_updated"` topic. Manages WebSocket connections. Sends full snapshot on connect, deltas on ticks. |
| Browser Dashboard | Static HTML/JS. Connects as WS client. Neon Cyber visual theme. |
| Terminal Dashboard | Separate Node.js process (`blessed-contrib`). Connects as WS client. |

---

## 3. Data Model

### NormalizedEvent

```typescript
interface NormalizedEvent {
  source: "hook" | "otel";
  type: "session_start" | "session_end" | "tool_use" | "turn_end" | "notification";
  tokens: { input: number; output: number };
  cost_usd: number;
  timestamp_ms: number;
  metadata: Record<string, unknown>;
}
```

`session_start` and `session_end` are first-class event types — not derived from other events.

### SessionState

```typescript
interface SessionState {
  session_id: string;
  started_at: number;
  turns: number;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  activity_state: "active" | "idle";
  burn_rate_per_sec: number;       // rolling average, last 10 events
  tokens_per_turn_avg: number;
  eta_to_threshold_sec: number;
  alert_level: "green" | "yellow" | "red";
  last_checkpoint_turn: number;
}
```

### WebSocket Message Types

```typescript
// Sent once on connect or after session reset
{ type: "snapshot", state: SessionState }

// Sent on each active tick (1s) or idle tick (5s)
{ type: "delta", changes: Partial<SessionState> }

// Emitted when checkpoint threshold is crossed
{ type: "checkpoint_event", severity: "suggested" | "mandatory", state: SessionState }
```

---

## 4. Data Flow

1. Claude Code fires a hook (e.g. `PostToolUse`) → `POST /hook` with raw payload
2. `HooksAdapter` receives it → passes to `EventNormalizer`
3. `EventNormalizer` outputs a `NormalizedEvent` → emits `"event"` on EventBus
4. `SessionStore` receives event → updates in-memory `SessionState`
   - After every update, evaluates checkpoint thresholds. Token-based and turn-based conditions are fully independent — meeting either is sufficient to emit its event:
     - `tokens_total >= 70% of config.token_threshold` → emit `"checkpoint_suggested"`
     - `tokens_total >= 90% of config.token_threshold` → emit `"checkpoint_mandatory"`
     - `turns >= 10` → emit `"checkpoint_suggested"`
     - `turns >= config.turn_threshold (default 20)` → emit `"checkpoint_mandatory"`
     - Cooldown: 3 turns between checkpoint events, except `checkpoint_mandatory` always fires
   - Emits `"state_updated"` with full new state
5. `WS Broadcaster` receives `"state_updated"`:
   - New client connection → send `{ type: "snapshot" }` with full state
   - Active tick (1s interval) → send `{ type: "delta" }` with changed fields only
   - Idle tick (5s interval) → send smaller `{ type: "delta" }` with minimal changes
6. Both browser and terminal dashboards consume the identical JSON stream

**Burn rate prediction:** Rolling average of `tokens_delta / elapsed_seconds` over the last 10 events. No heavy computation — reuses existing state fields.

**Out-of-order events:** Accepted within a 5-second window **within the same session**. Events outside the window are dropped with a warning log. After server restart, all state clears and every incoming event starts a new `session_start`.

---

## 5. Claude Code Integration

### Hooks Configuration (`.claude/settings.json`)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ]
  }
}
```

Hooks are fire-and-forget. If the server is not running, Claude Code continues unaffected.

### OTEL Configuration (supplementary)

Set in Claude Code settings or environment:
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3001/otel
```

`OtelAdapter` logs a warning at startup if OTEL is not available and disables itself. The system runs on hooks alone.

---

## 6. Frontend

### Startup Choice

At launch, the user is prompted:
```
Which dashboard?
  [1] Browser
  [2] Terminal
  [3] Both
```

Selected frontend(s) connect to the same WebSocket at `ws://localhost:3001`.

### Browser Dashboard (Neon Cyber)

**Layout C — Hybrid:**

| Region | Content |
|---|---|
| Top bar | App name, elapsed time, ACTIVE/IDLE state |
| Hero block | Large `tokens_total`, sub-labels: `IN` / `OUT` / `LEFT`, threshold progress bar (gradient green→cyan→purple) |
| Area chart | Turn-by-turn token burn, gradient fill, dot markers per turn |
| Sidebar | COST, TURNS, BURN/SEC, ETA, explicit GREEN/YELLOW/RED alert box |
| Alert bar | Left: capacity status + absolute remaining. Right: checkpoint countdown ("turn 20 in 6 turns") |

Checkpoint events display as overlay banners:
- `RECOMMEND CHECKPOINT` (suggested)
- `CHECKPOINT CREATED` (mandatory)

**Visual theme:** Deep black (`#05050f`) background, glowing cyan (`#00fff0`) / purple (`#bf00ff`) / green (`#00ff88`) accents, monospace font.

### Terminal Dashboard (blessed-contrib)

| Panel | Content |
|---|---|
| 6-box metric grid | TOK IN, TOK OUT, TOTAL, COST, TURNS, ETA |
| Bar chart | Burn rate history (last N turns), blessed-contrib `bar` widget |
| Alert line | `● GREEN/YELLOW/RED — N tokens left`, checkpoint countdown |

---

## 7. Configuration (`config.json`)

```json
{
  "token_threshold": 100000,
  "turn_threshold": 20,
  "refresh_active_ms": 1000,
  "refresh_idle_ms": 5000,
  "server_port": 3001,
  "ws_port": 3001,
  "otel_enabled": true
}
```

All thresholds, ports, and refresh rates are driven by `config.json`. No hardcoded values in source.

---

## 8. Error Handling

| Scenario | Behavior |
|---|---|
| Hook receiver unreachable | Claude Code fails the hook silently — no impact on Claude Code itself |
| OTEL unavailable | `OtelAdapter` logs a warning at startup and disables; system runs on hooks only |
| WS client disconnect | Client removed from broadcaster; full state snapshot re-sent on reconnect |
| Out-of-order events | Accepted within 5s window within the same session. Outside window: dropped + warning log. After restart: new session, all state reset. |
| Server crash/restart | State is memory-only. Clients reconnect and receive a new `session_start` snapshot. |

---

## 9. Testing Strategy

| Layer | Approach |
|---|---|
| `SessionStore` | Pure unit tests — feed `NormalizedEvent` objects in, assert `SessionState` output |
| `SessionStore` checkpoint logic | Dedicated unit test block — four independent assertions: (1) `checkpoint_suggested` fires when tokens reach 70% of threshold; (2) `checkpoint_suggested` fires when turns reach 10; (3) `checkpoint_mandatory` fires when tokens reach 90% of threshold; (4) `checkpoint_mandatory` fires when turns reach `turn_threshold`. Each tested in isolation — no condition depends on another. |
| `EventNormalizer` | Unit tests with raw hook payloads and raw OTEL payloads — assert correct `NormalizedEvent` shape |
| `HooksAdapter` + `OtelAdapter` | Integration tests against real HTTP endpoints via `supertest` |
| `WS Broadcaster` | Real WebSocket client: assert full snapshot on connect, assert deltas on subsequent state updates |
| E2E | None for MVP — too brittle |

---

## 10. File Structure

```
LiveVisualUsage/
├── src/
│   ├── monitor/
│   │   ├── SessionStore.ts
│   │   ├── EventNormalizer.ts
│   │   └── EventBus.ts
│   ├── wrapper/
│   │   ├── HooksAdapter.ts
│   │   └── OtelAdapter.ts
│   ├── server/
│   │   ├── index.ts          ← TelemetryServer entry point
│   │   └── WsBroadcaster.ts
│   └── frontend/
│       ├── browser/          ← Static HTML/JS (Neon Cyber)
│       └── terminal/         ← blessed-contrib dashboard
├── logs/
├── data/
├── docs/
│   ├── architecture.md
│   ├── checkpoints.md
│   ├── claude.md
│   └── superpowers/specs/
│       └── 2026-04-17-livevirtualusage-design.md
├── system/
│   ├── prompts/
│   ├── tasks/
│   ├── pending/
│   └── helpers/
├── tools/
├── skills/
│   ├── superpowers/
│   └── brainstorm/
├── config.json
├── decisions.md
└── README.md
```

---

## 11. Scalability Notes

The adapter pattern means extending the system requires:
- **New metric source** → one new `*Adapter.ts` in `src/wrapper/`, one line in `EventNormalizer`
- **New dashboard** → one new WebSocket client, no backend changes
- **New transport** → one new broadcaster alongside `WsBroadcaster`
- **New threshold/metric** → one new field in `SessionState`, one check in `SessionStore`
