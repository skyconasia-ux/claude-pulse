# LiveVisualUsage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time Claude Code CLI telemetry system that streams live token/cost/turn data to browser and terminal dashboards via WebSocket.

**Architecture:** Adapter-based pipeline — HooksAdapter and OtelAdapter feed raw events into EventNormalizer, which emits NormalizedEvents onto an EventBus. SessionStore consumes events and maintains state. WsBroadcaster pushes state snapshots and deltas to all connected WebSocket clients.

**Tech Stack:** TypeScript, Node.js, `ws` (WebSocket server), `express` (HTTP endpoints), `blessed-contrib` (terminal dashboard), `vitest` (tests), `supertest` (integration tests)

---

## File Map

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared interfaces: `NormalizedEvent`, `SessionState`, `WsMessage`, `AppConfig` |
| `src/config.ts` | Loads and validates `config.json` |
| `src/monitor/EventBus.ts` | Typed EventEmitter wrapper |
| `src/monitor/EventNormalizer.ts` | Converts raw hook/OTEL payloads → `NormalizedEvent` |
| `src/monitor/SessionStore.ts` | Consumes events, maintains `SessionState`, emits checkpoints |
| `src/wrapper/HooksAdapter.ts` | Express route `POST /hook` → EventNormalizer |
| `src/wrapper/OtelAdapter.ts` | Express route `POST /otel` → EventNormalizer, graceful disable |
| `src/server/WsBroadcaster.ts` | WebSocket server, snapshot on connect, delta ticks |
| `src/server/index.ts` | Wires all components, startup prompt, HTTP server |
| `src/frontend/browser/index.html` | Neon Cyber browser dashboard (Layout C hybrid) |
| `src/frontend/browser/dashboard.js` | WS client, DOM updates, checkpoint banners |
| `src/frontend/terminal/index.ts` | blessed-contrib dashboard, WS client |
| `tests/monitor/EventNormalizer.test.ts` | Unit tests for normalizer |
| `tests/monitor/SessionStore.test.ts` | Unit + checkpoint threshold tests |
| `tests/server/WsBroadcaster.test.ts` | WebSocket snapshot/delta integration tests |
| `tests/wrapper/adapters.test.ts` | HTTP endpoint integration tests |

---

## Task 0: Project scaffold + TypeScript setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `config.json`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create all empty directories per spec

- [ ] **Step 1: Create directory structure**

```bash
cd "<your-path>/LiveVisualUsage"
mkdir -p src/monitor src/wrapper src/server src/frontend/browser src/frontend/terminal
mkdir -p logs data tests/monitor tests/server tests/wrapper
mkdir -p docs/architecture docs system/prompts system/tasks system/pending system/helpers
mkdir -p tools skills/superpowers skills/brainstorm
```

- [ ] **Step 2: Init package.json**

```bash
cd "<your-path>/LiveVisualUsage"
npm init -y
```

- [ ] **Step 3: Install dependencies**

```bash
npm install express ws blessed blessed-contrib
npm install --save-dev typescript @types/node @types/express @types/ws @types/blessed vitest supertest @types/supertest tsx
```

- [ ] **Step 4: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Write config.json**

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

- [ ] **Step 6: Write src/types.ts**

```typescript
export interface NormalizedEvent {
  source: "hook" | "otel";
  type: "session_start" | "session_end" | "tool_use" | "turn_end" | "notification";
  tokens: { input: number; output: number };
  cost_usd: number;
  timestamp_ms: number;
  metadata: Record<string, unknown>;
}

export interface SessionState {
  session_id: string;
  started_at: number;
  turns: number;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  activity_state: "active" | "idle";
  burn_rate_per_sec: number;
  tokens_per_turn_avg: number;
  eta_to_threshold_sec: number;
  alert_level: "green" | "yellow" | "red";
  last_checkpoint_turn: number;
}

export type WsMessage =
  | { type: "snapshot"; state: SessionState }
  | { type: "delta"; changes: Partial<SessionState> }
  | { type: "checkpoint_event"; severity: "suggested" | "mandatory"; state: SessionState };

export interface AppConfig {
  token_threshold: number;
  turn_threshold: number;
  refresh_active_ms: number;
  refresh_idle_ms: number;
  server_port: number;
  ws_port: number;
  otel_enabled: boolean;
}
```

- [ ] **Step 7: Write src/config.ts**

```typescript
import fs from "fs";
import path from "path";
import { AppConfig } from "./types";

const raw = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../config.json"), "utf-8")
);

export const config: AppConfig = {
  token_threshold: raw.token_threshold ?? 100000,
  turn_threshold: raw.turn_threshold ?? 20,
  refresh_active_ms: raw.refresh_active_ms ?? 1000,
  refresh_idle_ms: raw.refresh_idle_ms ?? 5000,
  server_port: raw.server_port ?? 3001,
  ws_port: raw.ws_port ?? 3001,
  otel_enabled: raw.otel_enabled ?? true,
};
```

- [ ] **Step 8: Add scripts to package.json**

Open `package.json` and replace the `"scripts"` block with:

```json
"scripts": {
  "dev": "tsx src/server/index.ts",
  "terminal": "tsx src/frontend/terminal/index.ts",
  "build": "tsc",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 9: Commit**

```bash
git init
git add package.json tsconfig.json config.json src/types.ts src/config.ts
git commit -m "feat: project scaffold, types, config"
```

---

## Task 1: EventBus

**Files:**
- Create: `src/monitor/EventBus.ts`

- [ ] **Step 1: Write src/monitor/EventBus.ts**

```typescript
import { EventEmitter } from "events";
import { NormalizedEvent, SessionState } from "../types";

export type CheckpointSeverity = "suggested" | "mandatory";

export interface EventBusEvents {
  event: (e: NormalizedEvent) => void;
  state_updated: (state: SessionState) => void;
  checkpoint_suggested: (state: SessionState) => void;
  checkpoint_mandatory: (state: SessionState) => void;
}

class TypedEventBus extends EventEmitter {
  on<K extends keyof EventBusEvents>(event: K, listener: EventBusEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  emit<K extends keyof EventBusEvents>(event: K, ...args: Parameters<EventBusEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

export const eventBus = new TypedEventBus();
```

- [ ] **Step 2: Commit**

```bash
git add src/monitor/EventBus.ts
git commit -m "feat: typed EventBus"
```

---

## Task 2: EventNormalizer — tests first

**Files:**
- Create: `src/monitor/EventNormalizer.ts`
- Create: `tests/monitor/EventNormalizer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/monitor/EventNormalizer.test.ts
import { describe, it, expect } from "vitest";
import { normalizeHookPayload, normalizeOtelPayload } from "../../src/monitor/EventNormalizer";

describe("normalizeHookPayload", () => {
  it("maps PostToolUse to tool_use event", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_response: { output: "ok" },
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.source).toBe("hook");
    expect(event.type).toBe("tool_use");
    expect(event.tokens.input).toBe(100);
    expect(event.tokens.output).toBe(50);
    expect(event.timestamp_ms).toBe(1000);
    expect(event.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("maps Stop hook to turn_end event", () => {
    const raw = {
      hook_event_name: "Stop",
      usage: { input_tokens: 200, output_tokens: 80 },
      timestamp_ms: 2000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.type).toBe("turn_end");
  });

  it("maps Notification hook to notification event", () => {
    const raw = {
      hook_event_name: "Notification",
      message: "Task complete",
      usage: { input_tokens: 0, output_tokens: 0 },
      timestamp_ms: 3000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.type).toBe("notification");
  });

  it("defaults missing usage to zero tokens", () => {
    const raw = { hook_event_name: "Stop", timestamp_ms: 1000 };
    const event = normalizeHookPayload(raw);
    expect(event.tokens.input).toBe(0);
    expect(event.tokens.output).toBe(0);
  });
});

describe("normalizeOtelPayload", () => {
  it("maps OTEL span to tool_use event", () => {
    const raw = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "tool_use",
            startTimeUnixNano: "1000000000",
            attributes: [
              { key: "input_tokens", value: { intValue: 150 } },
              { key: "output_tokens", value: { intValue: 60 } },
            ],
          }],
        }],
      }],
    };
    const events = normalizeOtelPayload(raw);
    expect(events.length).toBe(1);
    expect(events[0].source).toBe("otel");
    expect(events[0].tokens.input).toBe(150);
    expect(events[0].tokens.output).toBe(60);
  });

  it("returns empty array for unrecognized OTEL shape", () => {
    const events = normalizeOtelPayload({});
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/monitor/EventNormalizer.test.ts
```

Expected: `Cannot find module '../../src/monitor/EventNormalizer'`

- [ ] **Step 3: Write src/monitor/EventNormalizer.ts**

```typescript
import { NormalizedEvent } from "../types";

const COST_PER_INPUT_TOKEN = 0.000003;
const COST_PER_OUTPUT_TOKEN = 0.000015;

function calcCost(input: number, output: number): number {
  return input * COST_PER_INPUT_TOKEN + output * COST_PER_OUTPUT_TOKEN;
}

type HookEventName = "PostToolUse" | "Stop" | "Notification" | string;

function hookEventToType(name: HookEventName): NormalizedEvent["type"] {
  if (name === "PostToolUse") return "tool_use";
  if (name === "Stop") return "turn_end";
  if (name === "Notification") return "notification";
  return "notification";
}

export function normalizeHookPayload(raw: Record<string, unknown>): NormalizedEvent {
  const usage = (raw.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    source: "hook",
    type: hookEventToType(raw.hook_event_name as string),
    tokens: { input, output },
    cost_usd: calcCost(input, output),
    timestamp_ms: (raw.timestamp_ms as number) ?? Date.now(),
    metadata: raw,
  };
}

interface OtelAttribute {
  key: string;
  value: { intValue?: number; stringValue?: string };
}

interface OtelSpan {
  name: string;
  startTimeUnixNano: string;
  attributes?: OtelAttribute[];
}

function spanToType(name: string): NormalizedEvent["type"] {
  if (name.includes("tool")) return "tool_use";
  if (name.includes("turn")) return "turn_end";
  if (name.includes("session_start")) return "session_start";
  if (name.includes("session_end")) return "session_end";
  return "notification";
}

export function normalizeOtelPayload(raw: Record<string, unknown>): NormalizedEvent[] {
  try {
    const resourceSpans = raw.resourceSpans as Array<{ scopeSpans: Array<{ spans: OtelSpan[] }> }>;
    if (!Array.isArray(resourceSpans)) return [];
    const events: NormalizedEvent[] = [];
    for (const rs of resourceSpans) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const attrs = span.attributes ?? [];
          const get = (key: string) => attrs.find(a => a.key === key)?.value?.intValue ?? 0;
          const input = get("input_tokens");
          const output = get("output_tokens");
          events.push({
            source: "otel",
            type: spanToType(span.name),
            tokens: { input, output },
            cost_usd: calcCost(input, output),
            timestamp_ms: Math.floor(Number(span.startTimeUnixNano) / 1_000_000),
            metadata: span as unknown as Record<string, unknown>,
          });
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/monitor/EventNormalizer.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/monitor/EventNormalizer.ts tests/monitor/EventNormalizer.test.ts
git commit -m "feat: EventNormalizer with tests"
```

---

## Task 3: SessionStore — tests first

**Files:**
- Create: `src/monitor/SessionStore.ts`
- Create: `tests/monitor/SessionStore.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/monitor/SessionStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../../src/monitor/SessionStore";
import { NormalizedEvent } from "../../src/types";

const cfg = {
  token_threshold: 1000,
  turn_threshold: 20,
  refresh_active_ms: 1000,
  refresh_idle_ms: 5000,
  server_port: 3001,
  ws_port: 3001,
  otel_enabled: true,
};

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: "hook",
    type: "tool_use",
    tokens: { input: 10, output: 5 },
    cost_usd: 0.0001,
    timestamp_ms: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe("SessionStore — state accumulation", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(cfg); });

  it("starts with zeroed state", () => {
    const s = store.getState();
    expect(s.tokens_total).toBe(0);
    expect(s.turns).toBe(0);
    expect(s.cost_usd).toBe(0);
  });

  it("accumulates tokens on tool_use event", () => {
    store.apply(makeEvent({ tokens: { input: 100, output: 50 }, cost_usd: 0.001 }));
    const s = store.getState();
    expect(s.tokens_in).toBe(100);
    expect(s.tokens_out).toBe(50);
    expect(s.tokens_total).toBe(150);
  });

  it("increments turns on turn_end event", () => {
    store.apply(makeEvent({ type: "turn_end", tokens: { input: 50, output: 20 }, cost_usd: 0.0005 }));
    expect(store.getState().turns).toBe(1);
  });

  it("resets state on session_start", () => {
    store.apply(makeEvent({ tokens: { input: 500, output: 200 }, cost_usd: 0.005 }));
    store.apply(makeEvent({ type: "session_start", tokens: { input: 0, output: 0 }, cost_usd: 0 }));
    const s = store.getState();
    expect(s.tokens_total).toBe(0);
    expect(s.turns).toBe(0);
  });

  it("computes alert_level green below 70%", () => {
    store.apply(makeEvent({ tokens: { input: 300, output: 300 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("green");
  });

  it("computes alert_level yellow at 70%", () => {
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("yellow");
  });

  it("computes alert_level red at 90%", () => {
    store.apply(makeEvent({ tokens: { input: 450, output: 450 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("red");
  });
});

describe("SessionStore — checkpoint thresholds (independent)", () => {
  it("emits checkpoint_suggested when tokens reach 70% of threshold", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(fired).toContain("suggested");
  });

  it("emits checkpoint_mandatory when tokens reach 90% of threshold", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_mandatory", () => fired.push("mandatory"));
    store.apply(makeEvent({ tokens: { input: 450, output: 450 }, cost_usd: 0 }));
    expect(fired).toContain("mandatory");
  });

  it("emits checkpoint_suggested when turns reach 10", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    for (let i = 0; i < 10; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 1 }, cost_usd: 0 }));
    }
    expect(fired).toContain("suggested");
  });

  it("emits checkpoint_mandatory when turns reach turn_threshold (20)", () => {
    const store = new SessionStore({ ...cfg, turn_threshold: 20 });
    const fired: string[] = [];
    store.on("checkpoint_mandatory", () => fired.push("mandatory"));
    for (let i = 0; i < 20; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 1 }, cost_usd: 0 }));
    }
    expect(fired).toContain("mandatory");
  });

  it("does NOT require token condition to fire turn-based checkpoint", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    // Only 1 token each turn — nowhere near 70% threshold
    for (let i = 0; i < 10; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 0 }, cost_usd: 0 }));
    }
    expect(fired).toContain("suggested");
  });

  it("does NOT require turn condition to fire token-based checkpoint", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    // Single event that hits 70% tokens but turns = 0
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(fired).toContain("suggested");
  });
});

describe("SessionStore — out-of-order events", () => {
  it("drops events older than 5s within the same session", () => {
    const store = new SessionStore(cfg);
    const now = Date.now();
    store.apply(makeEvent({ timestamp_ms: now }));
    const tokensBefore = store.getState().tokens_total;
    store.apply(makeEvent({ tokens: { input: 999, output: 999 }, timestamp_ms: now - 6000 }));
    expect(store.getState().tokens_total).toBe(tokensBefore);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/monitor/SessionStore.test.ts
```

Expected: `Cannot find module '../../src/monitor/SessionStore'`

- [ ] **Step 3: Write src/monitor/SessionStore.ts**

```typescript
import { EventEmitter } from "events";
import { NormalizedEvent, SessionState, AppConfig } from "../types";
import { v4 as uuidv4 } from "uuid";

const SOFT_TURN = 10;
const CHECKPOINT_COOLDOWN_TURNS = 3;

function makeEmptyState(): SessionState {
  return {
    session_id: uuidv4(),
    started_at: Date.now(),
    turns: 0,
    tokens_total: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    activity_state: "idle",
    burn_rate_per_sec: 0,
    tokens_per_turn_avg: 0,
    eta_to_threshold_sec: Infinity,
    alert_level: "green",
    last_checkpoint_turn: 0,
  };
}

export class SessionStore extends EventEmitter {
  private state: SessionState;
  private recentTokenDeltas: Array<{ tokens: number; ts: number }> = [];
  private lastEventTs: number = Date.now();
  private checkpointSuggestedFiredForTurn = -1;
  private checkpointMandatoryFiredForTurn = -1;

  constructor(private cfg: AppConfig) {
    super();
    this.state = makeEmptyState();
  }

  apply(event: NormalizedEvent): void {
    // Drop out-of-order events older than 5s within current session
    if (event.timestamp_ms < this.lastEventTs - 5000) {
      console.warn(`[SessionStore] dropped out-of-order event: ${event.type} at ${event.timestamp_ms}`);
      return;
    }

    if (event.type === "session_start") {
      this.state = makeEmptyState();
      this.recentTokenDeltas = [];
      this.checkpointSuggestedFiredForTurn = -1;
      this.checkpointMandatoryFiredForTurn = -1;
      this.emit("state_updated", { ...this.state });
      return;
    }

    if (event.type === "session_end") {
      this.state.activity_state = "idle";
      this.emit("state_updated", { ...this.state });
      return;
    }

    const tokenDelta = event.tokens.input + event.tokens.output;
    this.state.tokens_in += event.tokens.input;
    this.state.tokens_out += event.tokens.output;
    this.state.tokens_total += tokenDelta;
    this.state.cost_usd += event.cost_usd;

    if (event.type === "turn_end") {
      this.state.turns += 1;
      this.state.activity_state = "idle";
    } else {
      this.state.activity_state = "active";
    }

    this.lastEventTs = event.timestamp_ms;

    // Rolling burn rate (last 10 deltas)
    this.recentTokenDeltas.push({ tokens: tokenDelta, ts: event.timestamp_ms });
    if (this.recentTokenDeltas.length > 10) this.recentTokenDeltas.shift();
    this.updatePredictions();
    this.updateAlertLevel();
    this.evaluateCheckpoints();

    this.emit("state_updated", { ...this.state });
  }

  private updatePredictions(): void {
    const deltas = this.recentTokenDeltas;
    if (deltas.length >= 2) {
      const elapsed = (deltas[deltas.length - 1].ts - deltas[0].ts) / 1000;
      const total = deltas.reduce((s, d) => s + d.tokens, 0);
      this.state.burn_rate_per_sec = elapsed > 0 ? total / elapsed : 0;
    }
    this.state.tokens_per_turn_avg = this.state.turns > 0
      ? this.state.tokens_total / this.state.turns : 0;
    const remaining = this.cfg.token_threshold - this.state.tokens_total;
    this.state.eta_to_threshold_sec = this.state.burn_rate_per_sec > 0
      ? remaining / this.state.burn_rate_per_sec : Infinity;
  }

  private updateAlertLevel(): void {
    const pct = this.state.tokens_total / this.cfg.token_threshold;
    if (pct >= 0.9) this.state.alert_level = "red";
    else if (pct >= 0.7) this.state.alert_level = "yellow";
    else this.state.alert_level = "green";
  }

  private evaluateCheckpoints(): void {
    const { turns, tokens_total, last_checkpoint_turn } = this.state;
    const cooldownOk = turns - last_checkpoint_turn >= CHECKPOINT_COOLDOWN_TURNS;
    const tokenPct = tokens_total / this.cfg.token_threshold;

    // checkpoint_mandatory — always fires regardless of cooldown
    if (
      (tokenPct >= 0.9 || turns >= this.cfg.turn_threshold) &&
      turns !== this.checkpointMandatoryFiredForTurn
    ) {
      this.checkpointMandatoryFiredForTurn = turns;
      this.state.last_checkpoint_turn = turns;
      this.emit("checkpoint_mandatory", { ...this.state });
      return;
    }

    // checkpoint_suggested — respects cooldown
    if (
      cooldownOk &&
      (tokenPct >= 0.7 || turns >= SOFT_TURN) &&
      turns !== this.checkpointSuggestedFiredForTurn
    ) {
      this.checkpointSuggestedFiredForTurn = turns;
      this.state.last_checkpoint_turn = turns;
      this.emit("checkpoint_suggested", { ...this.state });
    }
  }

  getState(): Readonly<SessionState> {
    return { ...this.state };
  }
}
```

- [ ] **Step 4: Install uuid**

```bash
npm install uuid && npm install --save-dev @types/uuid
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
npx vitest run tests/monitor/SessionStore.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/monitor/SessionStore.ts tests/monitor/SessionStore.test.ts
git commit -m "feat: SessionStore with checkpoint logic and tests"
```

---

## Task 4: HTTP Adapters (HooksAdapter + OtelAdapter)

**Files:**
- Create: `src/wrapper/HooksAdapter.ts`
- Create: `src/wrapper/OtelAdapter.ts`
- Create: `tests/wrapper/adapters.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/wrapper/adapters.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHooksRouter } from "../../src/wrapper/HooksAdapter";
import { createOtelRouter } from "../../src/wrapper/OtelAdapter";
import { eventBus } from "../../src/monitor/EventBus";

describe("HooksAdapter POST /hook", () => {
  const app = express();
  app.use(express.json());
  app.use(createHooksRouter());

  it("returns 200 for valid PostToolUse payload", async () => {
    const res = await request(app).post("/hook").send({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: Date.now(),
    });
    expect(res.status).toBe(200);
  });

  it("emits normalized event on EventBus", async () => {
    const received: unknown[] = [];
    eventBus.on("event", (e) => received.push(e));
    await request(app).post("/hook").send({
      hook_event_name: "Stop",
      usage: { input_tokens: 20, output_tokens: 10 },
      timestamp_ms: Date.now(),
    });
    expect(received.length).toBeGreaterThan(0);
  });

  it("returns 400 for missing hook_event_name", async () => {
    const res = await request(app).post("/hook").send({ usage: {} });
    expect(res.status).toBe(400);
  });
});

describe("OtelAdapter POST /otel", () => {
  const app = express();
  app.use(express.json());
  app.use(createOtelRouter(true));

  it("returns 200 for valid OTEL payload", async () => {
    const res = await request(app).post("/otel").send({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "tool_use",
            startTimeUnixNano: "1000000000",
            attributes: [
              { key: "input_tokens", value: { intValue: 50 } },
              { key: "output_tokens", value: { intValue: 20 } },
            ],
          }],
        }],
      }],
    });
    expect(res.status).toBe(200);
  });

  it("returns 503 when otel_enabled is false", async () => {
    const disabledApp = express();
    disabledApp.use(express.json());
    disabledApp.use(createOtelRouter(false));
    const res = await request(disabledApp).post("/otel").send({});
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/wrapper/adapters.test.ts
```

Expected: `Cannot find module '../../src/wrapper/HooksAdapter'`

- [ ] **Step 3: Write src/wrapper/HooksAdapter.ts**

```typescript
import { Router, Request, Response } from "express";
import { normalizeHookPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";

export function createHooksRouter(): Router {
  const router = Router();
  router.post("/hook", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!body.hook_event_name) {
      res.status(400).json({ error: "missing hook_event_name" });
      return;
    }
    const event = normalizeHookPayload(body);
    eventBus.emit("event", event);
    res.status(200).json({ ok: true });
  });
  return router;
}
```

- [ ] **Step 4: Write src/wrapper/OtelAdapter.ts**

```typescript
import { Router, Request, Response } from "express";
import { normalizeOtelPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";

export function createOtelRouter(enabled: boolean): Router {
  const router = Router();
  if (!enabled) {
    console.warn("[OtelAdapter] OTEL disabled — POST /otel will return 503");
    router.post("/otel", (_req: Request, res: Response) => {
      res.status(503).json({ error: "otel_disabled" });
    });
    return router;
  }
  router.post("/otel", (req: Request, res: Response) => {
    const events = normalizeOtelPayload(req.body as Record<string, unknown>);
    for (const event of events) {
      eventBus.emit("event", event);
    }
    res.status(200).json({ ok: true, count: events.length });
  });
  return router;
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
npx vitest run tests/wrapper/adapters.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/wrapper/HooksAdapter.ts src/wrapper/OtelAdapter.ts tests/wrapper/adapters.test.ts
git commit -m "feat: HooksAdapter and OtelAdapter with tests"
```

---

## Task 5: WsBroadcaster — tests first

**Files:**
- Create: `src/server/WsBroadcaster.ts`
- Create: `tests/server/WsBroadcaster.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/server/WsBroadcaster.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import WebSocket from "ws";
import { WsBroadcaster } from "../../src/server/WsBroadcaster";
import { SessionState } from "../../src/types";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session",
    started_at: 1000,
    turns: 0,
    tokens_total: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    activity_state: "idle",
    burn_rate_per_sec: 0,
    tokens_per_turn_avg: 0,
    eta_to_threshold_sec: Infinity,
    alert_level: "green",
    last_checkpoint_turn: 0,
    ...overrides,
  };
}

describe("WsBroadcaster", () => {
  let broadcaster: WsBroadcaster;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    broadcaster = new WsBroadcaster(server);
    await new Promise<void>(r => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  it("sends full snapshot to client on connect", async () => {
    const state = makeState({ tokens_total: 500 });
    broadcaster.setState(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msg = await new Promise<string>(r => ws.on("message", d => r(d.toString())));
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.state.tokens_total).toBe(500);
    ws.close();
  });

  it("broadcasts delta to connected clients", async () => {
    const state = makeState();
    broadcaster.setState(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>(r => ws.once("message", () => r())); // consume snapshot

    const deltaPromise = new Promise<string>(r => ws.on("message", d => r(d.toString())));
    broadcaster.broadcastDelta({ tokens_total: 999 });
    const parsed = JSON.parse(await deltaPromise);
    expect(parsed.type).toBe("delta");
    expect(parsed.changes.tokens_total).toBe(999);
    ws.close();
  });

  it("sends full snapshot to reconnecting client", async () => {
    const state = makeState({ turns: 5 });
    broadcaster.setState(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msg = await new Promise<string>(r => ws.on("message", d => r(d.toString())));
    const parsed = JSON.parse(msg);
    expect(parsed.state.turns).toBe(5);
    ws.close();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/server/WsBroadcaster.test.ts
```

Expected: `Cannot find module '../../src/server/WsBroadcaster'`

- [ ] **Step 3: Write src/server/WsBroadcaster.ts**

```typescript
import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState, WsMessage } from "../types";

export class WsBroadcaster {
  private wss: WebSocketServer;
  private currentState: SessionState | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws: WebSocket) => {
      if (this.currentState) {
        const msg: WsMessage = { type: "snapshot", state: this.currentState };
        ws.send(JSON.stringify(msg));
      }
      ws.on("error", () => {});
    });
  }

  setState(state: SessionState): void {
    this.currentState = state;
  }

  broadcastDelta(changes: Partial<SessionState>): void {
    if (this.currentState) {
      this.currentState = { ...this.currentState, ...changes };
    }
    const msg: WsMessage = { type: "delta", changes };
    this.broadcast(msg);
  }

  broadcastCheckpoint(severity: "suggested" | "mandatory", state: SessionState): void {
    const msg: WsMessage = { type: "checkpoint_event", severity, state };
    this.broadcast(msg);
  }

  private broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/server/WsBroadcaster.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/WsBroadcaster.ts tests/server/WsBroadcaster.test.ts
git commit -m "feat: WsBroadcaster with snapshot/delta/checkpoint and tests"
```

---

## Task 6: TelemetryServer entry point

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Write src/server/index.ts**

```typescript
import http from "http";
import express from "express";
import readline from "readline";
import { config } from "../config";
import { eventBus } from "../monitor/EventBus";
import { SessionStore } from "../monitor/SessionStore";
import { WsBroadcaster } from "./WsBroadcaster";
import { createHooksRouter } from "../wrapper/HooksAdapter";
import { createOtelRouter } from "../wrapper/OtelAdapter";
import path from "path";

const app = express();
app.use(express.json());
app.use(createHooksRouter());
app.use(createOtelRouter(config.otel_enabled));
app.use("/dashboard", express.static(path.join(__dirname, "../frontend/browser")));

const server = http.createServer(app);
const broadcaster = new WsBroadcaster(server);
const store = new SessionStore(config);

// Wire EventBus → SessionStore
eventBus.on("event", (e) => store.apply(e));

// Wire SessionStore → Broadcaster
store.on("state_updated", (state) => {
  broadcaster.setState(state);
});

// Wire checkpoint events → Broadcaster
store.on("checkpoint_suggested", (state) => {
  broadcaster.broadcastCheckpoint("suggested", state);
});
store.on("checkpoint_mandatory", (state) => {
  broadcaster.broadcastCheckpoint("mandatory", state);
});

// Tick loop — broadcasts deltas on interval
let tickInterval: ReturnType<typeof setInterval>;
function startTick() {
  const ms = store.getState().activity_state === "active"
    ? config.refresh_active_ms
    : config.refresh_idle_ms;
  clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    broadcaster.broadcastDelta(store.getState());
    // Re-evaluate tick rate
    const newMs = store.getState().activity_state === "active"
      ? config.refresh_active_ms
      : config.refresh_idle_ms;
    if (newMs !== ms) startTick();
  }, ms);
}

async function promptFrontend(): Promise<"browser" | "terminal" | "both"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(
      "\nWhich dashboard?\n  [1] Browser\n  [2] Terminal\n  [3] Both\n\nChoice: ",
      (answer) => {
        rl.close();
        if (answer === "2") resolve("terminal");
        else if (answer === "3") resolve("both");
        else resolve("browser");
      }
    );
  });
}

async function main() {
  const choice = await promptFrontend();
  server.listen(config.server_port, () => {
    console.log(`\n[LiveVisualUsage] Server running on http://localhost:${config.server_port}`);
    console.log(`[LiveVisualUsage] WebSocket on ws://localhost:${config.ws_port}`);
    if (choice === "browser" || choice === "both") {
      console.log(`[LiveVisualUsage] Browser dashboard → http://localhost:${config.server_port}/dashboard`);
    }
    if (choice === "terminal" || choice === "both") {
      console.log(`[LiveVisualUsage] Starting terminal dashboard...`);
      import("../frontend/terminal/index").catch(console.error);
    }
  });
  startTick();
}

main().catch(console.error);
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: TelemetryServer entry point, wires all components"
```

---

## Task 7: Browser Dashboard (Neon Cyber — Layout C Hybrid)

**Files:**
- Create: `src/frontend/browser/index.html`
- Create: `src/frontend/browser/dashboard.js`

- [ ] **Step 1: Write src/frontend/browser/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LiveVisualUsage</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #05050f; --bg2: #0a0a1a; --bg3: #0d0d22;
      --cyan: #00fff0; --purple: #bf00ff; --green: #00ff88;
      --amber: #ffaa00; --red: #ff4455; --dim: rgba(255,255,255,0.25);
      --font: 'Courier New', monospace;
    }
    body { background: var(--bg); color: var(--cyan); font-family: var(--font); min-height: 100vh; padding: 16px; }
    #app { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }

    .topbar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg2); border: 1px solid rgba(0,255,240,0.15); border-radius: 6px; }
    .topbar .logo { color: var(--cyan); text-shadow: 0 0 10px var(--cyan); font-size: 14px; letter-spacing: 2px; }
    .topbar .status { display: flex; gap: 16px; font-size: 11px; color: var(--dim); }
    .topbar .status .active { color: var(--green); text-shadow: 0 0 6px var(--green); }

    .main-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 10px; }

    .hero { background: var(--bg2); border: 1px solid rgba(0,255,240,0.2); border-radius: 8px; padding: 16px; }
    .hero .label { color: var(--dim); font-size: 9px; letter-spacing: 2px; margin-bottom: 6px; }
    .hero .total { color: var(--cyan); font-size: 42px; font-weight: bold; text-shadow: 0 0 20px var(--cyan); letter-spacing: 4px; line-height: 1; }
    .hero .breakdown { display: flex; gap: 20px; margin-top: 8px; font-size: 11px; }
    .hero .breakdown .in { color: rgba(0,255,240,0.6); }
    .hero .breakdown .out { color: rgba(191,0,255,0.7); }
    .hero .breakdown .left { color: var(--dim); }
    .hero .breakdown span.val { font-size: 13px; font-weight: bold; }
    .hero .progress-wrap { margin-top: 10px; }
    .hero .progress-meta { display: flex; justify-content: space-between; color: var(--dim); font-size: 8px; margin-bottom: 3px; }
    .progress-bar { background: #111; border-radius: 4px; height: 8px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--green), var(--cyan), var(--purple)); box-shadow: 0 0 10px rgba(0,255,240,0.4); transition: width 0.5s ease; }

    .chart-box { background: var(--bg2); border: 1px solid rgba(0,255,240,0.1); border-radius: 8px; padding: 12px; }
    .chart-box .label { color: var(--dim); font-size: 9px; letter-spacing: 2px; margin-bottom: 6px; }
    canvas { width: 100%; height: 70px; display: block; }

    .sidebar { display: flex; flex-direction: column; gap: 8px; }
    .stat-box { background: var(--bg2); border-radius: 6px; padding: 12px; }
    .stat-box .label { color: var(--dim); font-size: 8px; letter-spacing: 2px; margin-bottom: 4px; }
    .stat-box .value { font-size: 20px; font-weight: bold; }
    .stat-box.cost .value { color: var(--purple); text-shadow: 0 0 10px var(--purple); border-color: rgba(191,0,255,0.2); }
    .stat-box.turns .value { color: var(--amber); text-shadow: 0 0 10px var(--amber); }
    .stat-box.burn .value { color: var(--cyan); text-shadow: 0 0 10px var(--cyan); }
    .stat-box.eta .value { color: var(--green); text-shadow: 0 0 10px var(--green); }
    .stat-box.alert .value { font-size: 13px; letter-spacing: 3px; }
    .stat-box.alert.green { border: 1px solid rgba(0,255,136,0.25); }
    .stat-box.alert.green .value { color: var(--green); text-shadow: 0 0 10px var(--green); }
    .stat-box.alert.yellow { border: 1px solid rgba(255,170,0,0.3); }
    .stat-box.alert.yellow .value { color: var(--amber); text-shadow: 0 0 10px var(--amber); }
    .stat-box.alert.red { border: 1px solid rgba(255,68,85,0.3); }
    .stat-box.alert.red .value { color: var(--red); text-shadow: 0 0 10px var(--red); }

    .alertbar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg2); border: 1px solid rgba(0,255,240,0.1); border-radius: 6px; font-size: 9px; }
    .alertbar .capacity { color: var(--green); }
    .alertbar .checkpoint { color: var(--amber); }

    .banner { display: none; position: fixed; top: 20px; left: 50%; transform: translateX(-50%); padding: 12px 24px; border-radius: 8px; font-size: 13px; letter-spacing: 2px; font-weight: bold; z-index: 100; animation: fadeout 4s forwards; }
    .banner.suggested { background: rgba(255,170,0,0.15); border: 1px solid var(--amber); color: var(--amber); text-shadow: 0 0 10px var(--amber); }
    .banner.mandatory { background: rgba(255,68,85,0.15); border: 1px solid var(--red); color: var(--red); text-shadow: 0 0 10px var(--red); }
    @keyframes fadeout { 0%{opacity:1} 70%{opacity:1} 100%{opacity:0} }
  </style>
</head>
<body>
  <div id="app">
    <div class="topbar">
      <span class="logo">⬡ LiveVisualUsage</span>
      <div class="status">
        <span id="elapsed">0s elapsed</span>
        <span id="activity" class="active">● IDLE</span>
      </div>
    </div>
    <div class="main-grid">
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div class="hero">
          <div class="label">TOTAL TOKENS</div>
          <div class="total" id="tokens-total">0</div>
          <div class="breakdown">
            <div class="in">IN <span class="val" id="tokens-in">0</span></div>
            <div style="color:rgba(255,255,255,0.1)">│</div>
            <div class="out">OUT <span class="val" id="tokens-out">0</span></div>
            <div style="color:rgba(255,255,255,0.1)">│</div>
            <div class="left">LEFT <span class="val" id="tokens-left">100,000</span></div>
          </div>
          <div class="progress-wrap">
            <div class="progress-meta">
              <span>0</span>
              <span id="pct-label">0% used</span>
              <span id="threshold-label">100,000</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
          </div>
        </div>
        <div class="chart-box">
          <div class="label">TURN-BY-TURN TOKEN BURN</div>
          <canvas id="burn-chart" height="70"></canvas>
        </div>
      </div>
      <div class="sidebar">
        <div class="stat-box cost"><div class="label">COST</div><div class="value" id="cost">$0.00</div></div>
        <div class="stat-box turns"><div class="label">TURNS</div><div class="value" id="turns">0</div></div>
        <div class="stat-box burn"><div class="label">BURN / SEC</div><div class="value" id="burn-rate">0</div></div>
        <div class="stat-box eta"><div class="label">ETA TO LIMIT</div><div class="value" id="eta">—</div></div>
        <div class="stat-box alert green" id="alert-box"><div class="label">ALERT</div><div class="value" id="alert-level">● GREEN</div></div>
      </div>
    </div>
    <div class="alertbar">
      <span class="capacity" id="capacity-status">● Capacity safe — 100,000 tokens remaining</span>
      <span class="checkpoint" id="checkpoint-status">—</span>
    </div>
  </div>
  <div class="banner" id="banner"></div>
  <script src="dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write src/frontend/browser/dashboard.js**

```javascript
const WS_URL = `ws://${location.host}`;
let ws;
let state = {};
let burnHistory = [];
let startedAt = null;
let elapsedTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 2000);
}

function handleMessage(msg) {
  if (msg.type === "snapshot") {
    state = msg.state;
    startedAt = startedAt || Date.now();
    if (!elapsedTimer) elapsedTimer = setInterval(updateElapsed, 1000);
    render();
  } else if (msg.type === "delta") {
    state = { ...state, ...msg.changes };
    render();
  } else if (msg.type === "checkpoint_event") {
    state = msg.state;
    render();
    showBanner(msg.severity);
  }
}

function fmt(n) { return Number(n).toLocaleString(); }
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

function render() {
  const threshold = 100000;
  const total = state.tokens_total || 0;
  const pct = Math.min(total / threshold * 100, 100);
  const left = Math.max(threshold - total, 0);

  document.getElementById("tokens-total").textContent = fmt(total);
  document.getElementById("tokens-in").textContent = fmt(state.tokens_in || 0);
  document.getElementById("tokens-out").textContent = fmt(state.tokens_out || 0);
  document.getElementById("tokens-left").textContent = fmt(left);
  document.getElementById("progress-fill").style.width = pct.toFixed(1) + "%";
  document.getElementById("pct-label").textContent = pct.toFixed(0) + "% used";
  document.getElementById("cost").textContent = "$" + (state.cost_usd || 0).toFixed(4);
  document.getElementById("turns").textContent = state.turns || 0;
  document.getElementById("burn-rate").textContent = Math.round(state.burn_rate_per_sec || 0);
  document.getElementById("eta").textContent = fmtEta(state.eta_to_threshold_sec);

  const level = state.alert_level || "green";
  const alertBox = document.getElementById("alert-box");
  alertBox.className = `stat-box alert ${level}`;
  document.getElementById("alert-level").textContent =
    `● ${level.toUpperCase()}`;

  document.getElementById("activity").textContent =
    state.activity_state === "active" ? "● ACTIVE" : "● IDLE";
  document.getElementById("activity").style.color =
    state.activity_state === "active" ? "var(--green)" : "var(--dim)";

  document.getElementById("capacity-status").textContent =
    `● ${level === "green" ? "Capacity safe" : level === "yellow" ? "Approaching limit" : "CRITICAL"} — ${fmt(left)} tokens remaining`;

  const turnsToNext = Math.max(0, 20 - (state.turns || 0));
  document.getElementById("checkpoint-status").textContent =
    turnsToNext > 0 ? `⚠ Checkpoint in ${turnsToNext} turns (turn 20)` : "⚠ Checkpoint due";

  // Burn chart
  if (state.tokens_total !== undefined) {
    burnHistory.push(total);
    if (burnHistory.length > 30) burnHistory.shift();
    drawChart();
  }
}

function drawChart() {
  const canvas = document.getElementById("burn-chart");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.offsetWidth;
  canvas.height = 70;
  const w = canvas.width, h = canvas.height;
  const max = Math.max(...burnHistory, 1);
  ctx.clearRect(0, 0, w, h);
  if (burnHistory.length < 2) return;
  const step = w / (burnHistory.length - 1);
  const pts = burnHistory.map((v, i) => [i * step, h - (v / max) * (h - 8)]);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(0,255,240,0.3)");
  grad.addColorStop(1, "rgba(0,255,240,0.01)");
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  const lineGrad = ctx.createLinearGradient(0, 0, w, 0);
  lineGrad.addColorStop(0, "#00ff88");
  lineGrad.addColorStop(0.5, "#00fff0");
  lineGrad.addColorStop(1, "#bf00ff");
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2; ctx.stroke();

  // Dots
  for (const [x, y] of pts) {
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,255,240,0.6)"; ctx.fill();
  }
}

function showBanner(severity) {
  const banner = document.getElementById("banner");
  banner.textContent = severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
  banner.className = `banner ${severity}`;
  banner.style.display = "block";
  setTimeout(() => { banner.style.display = "none"; }, 4000);
}

function updateElapsed() {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  document.getElementById("elapsed").textContent =
    m > 0 ? `${m}m ${sec}s elapsed` : `${sec}s elapsed`;
}

connect();
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/browser/index.html src/frontend/browser/dashboard.js
git commit -m "feat: browser dashboard, Neon Cyber layout C hybrid"
```

---

## Task 8: Terminal Dashboard (blessed-contrib)

**Files:**
- Create: `src/frontend/terminal/index.ts`

- [ ] **Step 1: Write src/frontend/terminal/index.ts**

```typescript
import blessed from "blessed";
import contrib from "blessed-contrib";
import WebSocket from "ws";
import { SessionState, WsMessage } from "../../types";

const WS_URL = "ws://localhost:3001";
const BURN_HISTORY_SIZE = 30;

const screen = blessed.screen({ smartCSR: true, title: "LiveVisualUsage" });
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

const burnChart = grid.set(0, 0, 6, 8, contrib.bar, {
  label: " BURN RATE (tok/turn) ",
  barWidth: 4,
  barSpacing: 2,
  xOffset: 0,
  maxHeight: 100,
  style: { bar: { bg: "cyan" }, text: "cyan", baseline: "black" },
  border: { type: "line", fg: "cyan" },
});

const metricsBox = grid.set(0, 8, 6, 4, blessed.box, {
  label: " METRICS ",
  border: { type: "line", fg: "cyan" },
  style: { fg: "cyan" },
  content: "Loading...",
});

const predictionBox = grid.set(6, 0, 4, 6, blessed.box, {
  label: " PREDICTION ",
  border: { type: "line", fg: "magenta" },
  style: { fg: "magenta" },
  content: "Loading...",
});

const alertBox = grid.set(6, 6, 4, 6, blessed.box, {
  label: " STATUS ",
  border: { type: "line", fg: "green" },
  style: { fg: "green" },
  content: "● Connecting...",
});

const logBox = grid.set(10, 0, 2, 12, contrib.log, {
  label: " LOG ",
  border: { type: "line", fg: "grey" },
  style: { fg: "grey" },
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));

let burnHistory: number[] = [];
let localState: SessionState = {
  session_id: "", started_at: 0, turns: 0, tokens_total: 0, tokens_in: 0,
  tokens_out: 0, cost_usd: 0, activity_state: "idle", burn_rate_per_sec: 0,
  tokens_per_turn_avg: 0, eta_to_threshold_sec: Infinity,
  alert_level: "green", last_checkpoint_turn: 0,
};

function fmt(n: number): string { return n.toLocaleString(); }
function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

function update(state: SessionState) {
  const threshold = 100000;
  const left = Math.max(threshold - state.tokens_total, 0);
  const pct = ((state.tokens_total / threshold) * 100).toFixed(1);

  metricsBox.setContent([
    `{cyan-fg}TOK IN{/}   ${fmt(state.tokens_in)}`,
    `{magenta-fg}TOK OUT{/}  ${fmt(state.tokens_out)}`,
    `{white-fg}TOTAL{/}    ${fmt(state.tokens_total)}`,
    `{magenta-fg}COST{/}     $${state.cost_usd.toFixed(4)}`,
    `{yellow-fg}TURNS{/}    ${state.turns}`,
    `{cyan-fg}STATE{/}    ${state.activity_state.toUpperCase()}`,
    `{white-fg}USED{/}     ${pct}%`,
  ].join("\n"));

  predictionBox.setContent([
    `{cyan-fg}BURN/SEC{/}  ${Math.round(state.burn_rate_per_sec)} tok/s`,
    `{cyan-fg}ETA{/}       ${fmtEta(state.eta_to_threshold_sec)}`,
    `{white-fg}LEFT{/}      ${fmt(left)} tokens`,
    `{white-fg}TOK/TURN{/}  ${Math.round(state.tokens_per_turn_avg)}`,
  ].join("\n"));

  const alertColor = state.alert_level === "green" ? "green"
    : state.alert_level === "yellow" ? "yellow" : "red";
  alertBox.style.border = { type: "line", fg: alertColor };
  const turnsToNext = Math.max(0, 20 - state.turns);
  alertBox.setContent([
    `{${alertColor}-fg}● ${state.alert_level.toUpperCase()}{/}`,
    ``,
    turnsToNext > 0
      ? `{yellow-fg}⚠ Checkpoint in ${turnsToNext} turns{/}`
      : `{red-fg}⚠ Checkpoint due{/}`,
  ].join("\n"));

  // Burn chart
  burnHistory.push(Math.round(state.burn_rate_per_sec));
  if (burnHistory.length > BURN_HISTORY_SIZE) burnHistory.shift();
  burnChart.setData({
    titles: burnHistory.map((_, i) => String(i + 1)),
    data: burnHistory,
  });

  screen.render();
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => (logBox as unknown as { log: (s: string) => void }).log("Connected to LiveVisualUsage server"));
  ws.on("message", (data) => {
    const msg: WsMessage = JSON.parse(data.toString());
    if (msg.type === "snapshot") {
      localState = msg.state;
      update(localState);
    } else if (msg.type === "delta") {
      localState = { ...localState, ...msg.changes };
      update(localState);
    } else if (msg.type === "checkpoint_event") {
      localState = msg.state;
      const label = msg.severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
      (logBox as unknown as { log: (s: string) => void }).log(label);
      update(localState);
    }
  });
  ws.on("close", () => {
    (logBox as unknown as { log: (s: string) => void }).log("Disconnected — retrying in 2s...");
    setTimeout(connect, 2000);
  });
  ws.on("error", (err) => (logBox as unknown as { log: (s: string) => void }).log(`Error: ${err.message}`));
}

connect();
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (or only blessed-contrib type warnings which can be ignored).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/terminal/index.ts
git commit -m "feat: terminal dashboard with blessed-contrib"
```

---

## Task 9: Project initialization files (Step 0 from InstructionList.txt)

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/checkpoints.md`
- Create: `docs/claude.md`
- Create: `README.md`

- [ ] **Step 1: Write docs/architecture.md**

```markdown
# Live Visual Usage Monitor — Architecture
Status: Initialized

## Pattern
Adapter-Based Pipeline — single Node.js process.

## Components
- HooksAdapter: receives Claude Code hooks via POST /hook
- OtelAdapter: receives OTEL spans via POST /otel (optional)
- EventNormalizer: converts raw payloads to NormalizedEvent
- EventBus: internal typed pub/sub (EventEmitter)
- SessionStore: maintains SessionState, emits checkpoints
- WsBroadcaster: pushes snapshots/deltas to all WS clients
- Browser Dashboard: Neon Cyber HTML/JS at /dashboard
- Terminal Dashboard: blessed-contrib WS client

## Ports
- HTTP + WS: 3001 (configured in config.json)
```

- [ ] **Step 2: Write docs/checkpoints.md**

```markdown
# Checkpoints (APPEND ONLY — DO NOT OVERWRITE)

## 2026-04-17 — Project Initialized
- Objective: real-time Claude Code CLI telemetry + dual dashboard
- Completed: design spec, decisions log, implementation plan
- Current: ready to implement
- Next: Task 0 (scaffold) → Task 1 (EventBus) → ... → Task 9
```

- [ ] **Step 3: Write docs/claude.md**

```markdown
# Claude Working Memory

Project: LiveVisualUsage
Last updated: 2026-04-17

## Rules
- Do not re-derive architecture once defined
- Always update checkpoints after major progress
- Keep tasks and pending tasks in sync
- Prefer native telemetry over terminal scraping

## Current State
- Design: approved
- Implementation plan: written
- Next step: execute Task 0 (scaffold)

## Key Decisions
See decisions.md at project root for full Q&A log.
```

- [ ] **Step 4: Write README.md**

```markdown
# LiveVisualUsage

Real-time telemetry and visualization for Claude Code CLI.

## Quick Start

```bash
npm install
npm run dev
```

Choose browser / terminal / both at startup.
Browser dashboard: http://localhost:3001/dashboard

## Claude Code Integration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }]
  }
}
```

## Stack
TypeScript · Node.js · ws · express · blessed-contrib

## Decisions log
See `decisions.md` for all design Q&A.
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/checkpoints.md docs/claude.md README.md
git commit -m "docs: architecture, checkpoints, claude memory, README"
```

---

## Task 10: Run full test suite + smoke test

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass across EventNormalizer, SessionStore, adapters, WsBroadcaster.

- [ ] **Step 2: Smoke test server startup**

```bash
npm run dev
```

Type `1` (Browser) at the prompt. Expected:
```
[LiveVisualUsage] Server running on http://localhost:3001
[LiveVisualUsage] WebSocket on ws://localhost:3001
[LiveVisualUsage] Browser dashboard → http://localhost:3001/dashboard
```

Open `http://localhost:3001/dashboard` in browser — should see the Neon Cyber dashboard.

- [ ] **Step 3: Smoke test hooks**

With server running, in a second terminal:

```bash
curl -s -X POST http://localhost:3001/hook \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PostToolUse","tool_name":"Bash","usage":{"input_tokens":500,"output_tokens":200},"timestamp_ms":'"$(date +%s000)"'}'
```

Expected: browser dashboard updates within 1 second showing token counts.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verified full test suite and smoke test pass"
```
