# Model-Aware Token Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-model token usage and cost, compute a Sonnet-equivalent weighted budget, fix alert thresholds to use weighted tokens, and render a per-model breakdown in each live tile.

**Architecture:** Four layers — (1) `NormalizedEvent` gains a `model?` field extracted by `EventNormalizer`; (2) `SessionState` gains `model_last`, `models` map, and `weighted_tokens_total`; (3) `SessionStore` accumulates per-model stats and uses weighted tokens for alert/ETA logic; (4) browser frontend renders a model breakdown row and switches the progress bar to weighted tokens. No new HTTP endpoints. No new config keys (`token_threshold` is already 1 000 000).

**Tech Stack:** TypeScript (Node.js backend), vanilla JS (browser), Vitest (tests), Playwright (browser verification).

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `model?` to `NormalizedEvent`; add `model_last?`, `models?`, `weighted_tokens_total?` to `SessionState` |
| `src/monitor/EventNormalizer.ts` | Extract `model` from hook/otel payload; replace flat cost constants with `MODEL_RATES` lookup |
| `src/monitor/SessionStore.ts` | Accumulate `models` map + `weighted_tokens_total`; use weighted in `updateAlertLevel`, `updatePredictions`, `evaluateCheckpoints` |
| `src/frontend/browser/index.html` | Add model-breakdown CSS |
| `src/frontend/browser/dashboard.js` | Render per-model rows; switch progress bar to weighted tokens; cosmetic "BUDGET LEFT" label |
| `tests/monitor/EventNormalizer.test.ts` | 4 new tests: model extraction, per-model cost rates |
| `tests/monitor/SessionStore.test.ts` | 5 new tests: model accumulation, weighted tokens, alert level |

---

## Task 1: Types + EventNormalizer — model extraction + model-aware costs

**Files:**
- Modify: `src/types.ts`
- Modify: `src/monitor/EventNormalizer.ts`
- Modify: `tests/monitor/EventNormalizer.test.ts`

### Context

`EventNormalizer` currently uses two hardcoded constants for all models:
```typescript
const COST_PER_INPUT_TOKEN  = 0.000003;   // always Sonnet price
const COST_PER_OUTPUT_TOKEN = 0.000015;   // always Sonnet price
```
Hook payloads from Claude Code include a `model` field at the top level (e.g. `raw.model === "claude-sonnet-4-6"`). OTel spans may carry it as a span attribute with key `"model"`.

- [ ] **Step 1: Add `model?` to `NormalizedEvent` in `src/types.ts`**

Find:
```typescript
export interface NormalizedEvent {
  session_id?: string;
  project_name?: string;
  source: "hook" | "otel" | "journal";
```
Replace with:
```typescript
export interface NormalizedEvent {
  session_id?: string;
  project_name?: string;
  model?: string;
  source: "hook" | "otel" | "journal";
```

- [ ] **Step 2: Add `model_last?`, `models?`, `weighted_tokens_total?` to `SessionState` in `src/types.ts`**

Find:
```typescript
  last_notification?: string;
  notification_level?: "warn" | "critical";
  project_first_seen_ms?: number;
```
Replace with:
```typescript
  last_notification?: string;
  notification_level?: "warn" | "critical";
  project_first_seen_ms?: number;
  model_last?: string;
  models?: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number }>;
  weighted_tokens_total?: number;
```

- [ ] **Step 3: Write 4 failing tests in `tests/monitor/EventNormalizer.test.ts`**

Append a new `describe` block at the end of the file:
```typescript
describe("EventNormalizer — model extraction and model-aware costs", () => {
  it("extracts model from hook payload", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.model).toBe("claude-sonnet-4-6");
  });

  it("uses Opus rates for Opus model hook events", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-opus-4-7",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Opus input rate: $15/MTok = 0.000015 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.000015, 5);
  });

  it("uses Haiku rates for Haiku model hook events", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Haiku input rate: $0.25/MTok = 0.00000025 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.00000025, 8);
  });

  it("falls back to Sonnet rates when model is absent", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Sonnet input rate: $3/MTok = 0.000003 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.000003, 5);
    expect(event.model).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests to confirm 4 fail**
```bash
cd /c/users/quick/LiveVisualUsage && npm test -- --run tests/monitor/EventNormalizer.test.ts
```
Expected: 4 new tests FAIL.

- [ ] **Step 5: Rewrite `src/monitor/EventNormalizer.ts`**

Replace the entire file:
```typescript
import { NormalizedEvent } from "../types";

const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 0.000015,    output: 0.000075   },
  "claude-opus-4-5":   { input: 0.000015,    output: 0.000075   },
  "claude-sonnet-4-6": { input: 0.000003,    output: 0.000015   },
  "claude-sonnet-4-5": { input: 0.000003,    output: 0.000015   },
  "claude-haiku-4-5":  { input: 0.00000025,  output: 0.00000125 },
};

const DEFAULT_RATE = { input: 0.000003, output: 0.000015 };

function getRates(model?: string): { input: number; output: number } {
  if (!model) return DEFAULT_RATE;
  const key = Object.keys(MODEL_RATES).find(k => model.startsWith(k));
  return key ? MODEL_RATES[key] : DEFAULT_RATE;
}

function calcCost(input: number, output: number, model?: string): number {
  const r = getRates(model);
  return input * r.input + output * r.output;
}

function extractProjectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() ?? "unknown";
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
  const model = raw.model as string | undefined;
  return {
    session_id: raw.session_id as string | undefined,
    project_name: extractProjectName(raw.cwd as string | undefined),
    model,
    source: "hook",
    type: hookEventToType(raw.hook_event_name as string),
    tokens: { input, output },
    cost_usd: calcCost(input, output, model),
    timestamp_ms: (raw.timestamp_ms as number) || Date.now(),
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
    const resourceSpans = raw.resourceSpans as Array<{
      resource?: { attributes?: OtelAttribute[] };
      scopeSpans: Array<{ spans: OtelSpan[] }>;
    }>;
    if (!Array.isArray(resourceSpans)) return [];
    const events: NormalizedEvent[] = [];
    for (const rs of resourceSpans) {
      const resAttrs = rs.resource?.attributes ?? [];
      const getStr = (key: string) => resAttrs.find(a => a.key === key)?.value?.stringValue;
      const sessionId = getStr("session.id");
      const cwd = getStr("process.cwd");
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const attrs = span.attributes ?? [];
          const getInt = (key: string) => attrs.find(a => a.key === key)?.value?.intValue ?? 0;
          const getStrAttr = (key: string) => attrs.find(a => a.key === key)?.value?.stringValue;
          const input = getInt("input_tokens");
          const output = getInt("output_tokens");
          const model = getStrAttr("model");
          events.push({
            session_id: sessionId,
            project_name: extractProjectName(cwd),
            model,
            source: "otel",
            type: spanToType(span.name),
            tokens: { input, output },
            cost_usd: calcCost(input, output, model),
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

- [ ] **Step 6: Run EventNormalizer tests**
```bash
npm test -- --run tests/monitor/EventNormalizer.test.ts
```
Expected: all tests pass (4 original + 4 new = 8 total).

- [ ] **Step 7: Run full suite**
```bash
npm test -- --run
```
Expected: all 41 tests still pass.

- [ ] **Step 8: Commit**
```bash
git add src/types.ts src/monitor/EventNormalizer.ts tests/monitor/EventNormalizer.test.ts
git commit -m "feat: extract model from hook/otel payloads, add model-aware cost rates"
```

---

## Task 2: SessionStore — per-model accumulation + weighted token budget

**Files:**
- Modify: `src/monitor/SessionStore.ts`
- Modify: `tests/monitor/SessionStore.test.ts`

### Context

`SessionStore` accumulates tokens in two paths: the `token_delta` branch (JournalWatcher, no model info) and the fallthrough branch (hook events: `tool_use`, `turn_end`). Model tracking is added to both paths using `event.model ?? "unknown"`. Bootstrap `token_delta` events (where `bootstrapTurns !== undefined`) skip model accumulation since they replay historical data without per-model breakdown.

`updateAlertLevel`, `updatePredictions`, and `evaluateCheckpoints` all currently use `tokens_total`. They must prefer `weighted_tokens_total` when available.

Model weight constants (Sonnet-equivalent multipliers):
- Opus → 5
- Haiku → 0.08
- Sonnet / unknown → 1

- [ ] **Step 1: Write 5 failing tests in `tests/monitor/SessionStore.test.ts`**

Append a new `describe` block at the end of the file:
```typescript
describe("SessionStore — model-aware tracking", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(cfg); });

  it("accumulates models map on tool_use with model field", () => {
    store.apply(makeEvent({
      type: "tool_use", model: "claude-sonnet-4-6",
      tokens: { input: 100, output: 50 }, cost_usd: 0.00045,
    }));
    const s = store.getState();
    expect(s.models?.["claude-sonnet-4-6"]?.tokens_in).toBe(100);
    expect(s.models?.["claude-sonnet-4-6"]?.tokens_out).toBe(50);
    expect(s.model_last).toBe("claude-sonnet-4-6");
  });

  it("sets weighted_tokens_total = tokens for Sonnet (weight 1)", () => {
    store.apply(makeEvent({
      type: "tool_use", model: "claude-sonnet-4-6",
      tokens: { input: 200, output: 100 }, cost_usd: 0,
    }));
    const s = store.getState();
    expect(s.weighted_tokens_total).toBeCloseTo(300, 1);
  });

  it("sets weighted_tokens_total ≈ 5× tokens for Opus", () => {
    store.apply(makeEvent({
      type: "tool_use", model: "claude-opus-4-7",
      tokens: { input: 200, output: 100 }, cost_usd: 0,
    }));
    const s = store.getState();
    expect(s.weighted_tokens_total).toBeCloseTo(300 * 5, 1);
  });

  it("sets weighted_tokens_total ≈ 0.08× tokens for Haiku", () => {
    store.apply(makeEvent({
      type: "tool_use", model: "claude-haiku-4-5-20251001",
      tokens: { input: 200, output: 100 }, cost_usd: 0,
    }));
    const s = store.getState();
    expect(s.weighted_tokens_total).toBeCloseTo(300 * 0.08, 3);
  });

  it("alert_level uses weighted_tokens_total when available", () => {
    // 150 raw Opus tokens × 5 = 750 weighted → 75% of 1000 threshold → yellow
    store.apply(makeEvent({
      type: "tool_use", model: "claude-opus-4-7",
      tokens: { input: 100, output: 50 }, cost_usd: 0,
    }));
    expect(store.getState().alert_level).toBe("yellow");
  });
});
```

- [ ] **Step 2: Run tests to confirm 5 fail**
```bash
npm test -- --run tests/monitor/SessionStore.test.ts
```
Expected: 5 new tests FAIL.

- [ ] **Step 3: Add `modelWeight` helper and initialise new fields in `makeEmptyState` in `src/monitor/SessionStore.ts`**

Add the `MODEL_WEIGHT` constant and `modelWeight` function immediately after the `parseNotificationPct` function:
```typescript
const MODEL_WEIGHT: Record<string, number> = {
  "claude-opus":   5,
  "claude-sonnet": 1,
  "claude-haiku":  0.08,
};

function modelWeight(model?: string): number {
  if (!model) return 1;
  if (model.includes("opus"))   return MODEL_WEIGHT["claude-opus"];
  if (model.includes("haiku"))  return MODEL_WEIGHT["claude-haiku"];
  return MODEL_WEIGHT["claude-sonnet"];
}
```

In `makeEmptyState`, add two new fields at the end of the returned object (after `last_checkpoint_turn: 0`):
```typescript
    models: {},
    weighted_tokens_total: 0,
```

- [ ] **Step 4: Add per-model accumulation helper and call it in both token paths**

Add a private helper method to `SessionStore` (after `setProjectFirstSeen`):
```typescript
private accumulateModel(event: NormalizedEvent): void {
  const m = event.model ?? "unknown";
  if (!this.state.models) this.state.models = {};
  if (!this.state.models[m]) {
    this.state.models[m] = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  }
  this.state.models[m].tokens_in  += event.tokens.input;
  this.state.models[m].tokens_out += event.tokens.output;
  this.state.models[m].cost_usd   += event.cost_usd;
  this.state.model_last = m;
  const w = modelWeight(event.model);
  this.state.weighted_tokens_total =
    (this.state.weighted_tokens_total ?? 0) +
    (event.tokens.input + event.tokens.output) * w;
}
```

In the `token_delta` branch, add a call to `this.accumulateModel(event)` **only for live events** (inside the `else` block, after `this.state.tool_calls_total += toolsDelta`):

Find:
```typescript
      } else {
        // Live event: accumulate deltas normally
        const tokenDelta = event.tokens.input + event.tokens.output;
        this.state.tokens_in += event.tokens.input;
        this.state.tokens_out += event.tokens.output;
        this.state.tokens_total += tokenDelta;
        this.state.cost_usd += event.cost_usd;
        this.state.last_seen_ms = event.timestamp_ms;
        this.state.turns += 1;
        this.state.tool_calls_total += toolsDelta;
      }
```
Replace with:
```typescript
      } else {
        // Live event: accumulate deltas normally
        const tokenDelta = event.tokens.input + event.tokens.output;
        this.state.tokens_in += event.tokens.input;
        this.state.tokens_out += event.tokens.output;
        this.state.tokens_total += tokenDelta;
        this.state.cost_usd += event.cost_usd;
        this.state.last_seen_ms = event.timestamp_ms;
        this.state.turns += 1;
        this.state.tool_calls_total += toolsDelta;
        this.accumulateModel(event);
      }
```

In the fallthrough branch (after `if (event.type === "tool_use") { this.state.tool_calls_total += 1; }`), add `this.accumulateModel(event);` immediately after:

Find:
```typescript
    if (event.type === "tool_use") {
      this.state.tool_calls_total += 1;
    }

    this.lastEventTs = event.timestamp_ms;
```
Replace with:
```typescript
    if (event.type === "tool_use") {
      this.state.tool_calls_total += 1;
    }
    this.accumulateModel(event);

    this.lastEventTs = event.timestamp_ms;
```

- [ ] **Step 5: Update `updateAlertLevel`, `updatePredictions`, and `evaluateCheckpoints` to use weighted tokens**

In `updateAlertLevel`, replace:
```typescript
  private updateAlertLevel(): void {
    const pct = this.state.tokens_total / this.cfg.token_threshold;
```
with:
```typescript
  private updateAlertLevel(): void {
    const effective = this.state.weighted_tokens_total ?? this.state.tokens_total;
    const pct = effective / this.cfg.token_threshold;
```

In `updatePredictions`, replace:
```typescript
    const remaining = this.cfg.token_threshold - this.state.tokens_total;
```
with:
```typescript
    const effective = this.state.weighted_tokens_total ?? this.state.tokens_total;
    const remaining = this.cfg.token_threshold - effective;
```

In `evaluateCheckpoints`, replace:
```typescript
    const tokenPct = tokens_total / this.cfg.token_threshold;
```
with:
```typescript
    const effective = this.state.weighted_tokens_total ?? tokens_total;
    const tokenPct = effective / this.cfg.token_threshold;
```

- [ ] **Step 6: Run SessionStore tests**
```bash
npm test -- --run tests/monitor/SessionStore.test.ts
```
Expected: all tests pass (38 existing + 5 new = 43 total in that file).

- [ ] **Step 7: Run full suite**
```bash
npm test -- --run
```
Expected: all 46 tests pass (41 existing + 5 new).

- [ ] **Step 8: Commit**
```bash
git add src/monitor/SessionStore.ts tests/monitor/SessionStore.test.ts
git commit -m "feat: accumulate per-model token map and weighted budget in SessionStore"
```

---

## Task 3: Frontend — model breakdown section

**Files:**
- Modify: `src/frontend/browser/index.html`
- Modify: `src/frontend/browser/dashboard.js`

### Context

`buildTile()` builds the tile HTML. The token hero block contains `token-hero-label`, `token-hero-value`, and `token-breakdown` (IN / OUT / LEFT segments). The model breakdown `div` goes immediately after the `token-breakdown` div, before the `tile-chart` canvas.

`updateTile(tile, s)` runs on every state update. It reads `s.models` (the per-model map from `SessionState`) and `s.model_last`.

Two helper functions (`modelBadgeClass`, `shortModelName`) are added as standalone functions near the format helpers.

CSS variables already defined in the file:
- `--cyan`: `rgba(0,255,240,1)` — Sonnet colour
- `--purple`: `rgba(191,0,255,1)` — Opus colour
- `--green` is not defined; use `#00ff88` directly for Haiku

- [ ] **Step 1: Add CSS to `src/frontend/browser/index.html`**

Find:
```css
    .tile-warn-msg  { flex: 1; }

    .chart-wrap { position: relative; }
```
Replace with:
```css
    .tile-warn-msg  { flex: 1; }

    .model-breakdown {
      display: flex; flex-direction: column; gap: 6px;
      border-top: 1px solid rgba(0,255,240,0.07); padding-top: 8px;
    }
    .model-row {
      display: grid; grid-template-columns: 1fr auto auto auto;
      gap: 8px; align-items: center; font-size: 10px;
    }
    .model-name { color: var(--cyan); letter-spacing: 1px; font-size: 9px; }
    .model-badge {
      font-size: 8px; letter-spacing: 1.5px; padding: 1px 6px; border-radius: 3px;
      font-weight: bold;
    }
    .model-badge-opus   { background: rgba(191,0,255,0.15); border: 1px solid rgba(191,0,255,0.4); color: var(--purple); }
    .model-badge-sonnet { background: rgba(0,255,240,0.10); border: 1px solid rgba(0,255,240,0.35); color: var(--cyan); }
    .model-badge-haiku  { background: rgba(0,255,136,0.10); border: 1px solid rgba(0,255,136,0.35); color: #00ff88; }
    .model-tokens-in  { color: rgba(0,255,240,0.75); }
    .model-tokens-out { color: rgba(191,0,255,0.85); }
    .model-cost       { color: var(--purple); }

    .chart-wrap { position: relative; }
```

- [ ] **Step 2: Add model-breakdown div to `buildTile()` in `dashboard.js`**

In `buildTile()`, find the `token-breakdown` closing div followed by the chart-wrap:
```javascript
      </div>
    </div>
    <div class="chart-wrap">
```
Replace with:
```javascript
      </div>
    </div>
    <div class="model-breakdown" data-field="model-breakdown"></div>
    <div class="chart-wrap">
```

- [ ] **Step 3: Add `modelBadgeClass` and `shortModelName` helpers to `dashboard.js`**

Find:
```javascript
const fmtWhole = n => String(Math.round(n));
```
Replace with:
```javascript
const fmtWhole = n => String(Math.round(n));

function modelBadgeClass(modelId) {
  if (modelId.includes("opus"))   return "model-badge-opus";
  if (modelId.includes("haiku"))  return "model-badge-haiku";
  return "model-badge-sonnet";
}

function shortModelName(modelId) {
  if (modelId.includes("opus"))   return "OPUS";
  if (modelId.includes("haiku"))  return "HAIKU";
  if (modelId.includes("sonnet")) return "SONNET";
  return modelId.replace("claude-", "").toUpperCase().slice(0, 12);
}
```

- [ ] **Step 4: Add model breakdown render block to `updateTile()` in `dashboard.js`**

Find the usage warning banner block near the end of `updateTile()`:
```javascript
  // Usage warning banner
  const banner = tile.querySelector('.tile-warn-banner');
```
Insert the following **before** that block:
```javascript
  // Model breakdown
  const mbEl = tile.querySelector("[data-field='model-breakdown']");
  if (mbEl && s.models && Object.keys(s.models).length > 0) {
    mbEl.innerHTML = Object.entries(s.models).map(([id, stats]) => `
      <div class="model-row">
        <span class="model-name">
          <span class="model-badge ${modelBadgeClass(id)}">${shortModelName(id)}</span>
          ${id === s.model_last ? ' <span style="color:#00ff88;font-size:8px">&#9679; ACTIVE</span>' : ''}
        </span>
        <span class="model-tokens-in">IN ${fmtInt(stats.tokens_in)}</span>
        <span class="model-tokens-out">OUT ${fmtInt(stats.tokens_out)}</span>
        <span class="model-cost">${fmtCost4(stats.cost_usd)}</span>
      </div>
    `).join("");
    mbEl.style.display = "";
  } else if (mbEl) {
    mbEl.style.display = "none";
  }

```

- [ ] **Step 5: Build and verify**
```bash
cd /c/users/quick/LiveVisualUsage && npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 6: Run full test suite**
```bash
npm test -- --run
```
Expected: all 46 tests pass.

- [ ] **Step 7: Commit**
```bash
git add src/frontend/browser/index.html src/frontend/browser/dashboard.js
git commit -m "feat: add per-model breakdown section to tiles"
```

---

## Task 4: Frontend — weighted progress bar + cosmetic labels

**Files:**
- Modify: `src/frontend/browser/dashboard.js`
- Modify: `src/frontend/browser/index.html` (seg-left label only)

### Context

`updateTile()` currently computes `pct` and `left` from raw `tokens_total`. The spec switches these to use `weighted_tokens_total` (Sonnet-equivalent units) so that the progress bar and ETA reflect the actual budget pressure.

The "LEFT" segment label in `buildTile()` becomes "BUDGET LEFT". The threshold annotation below the progress bar already reads `fmt(THRESHOLD)` (= `1,000,000`) — that stays unchanged.

- [ ] **Step 1: Switch progress bar to weighted tokens in `updateTile()`**

Find:
```javascript
  const total = s.tokens_total || 0;
  const pct = Math.min(total / THRESHOLD * 100, 100);
  const left = Math.max(THRESHOLD - total, 0);
```
Replace with:
```javascript
  const total    = s.tokens_total || 0;
  const weighted = s.weighted_tokens_total ?? total;
  const pct      = Math.min(weighted / THRESHOLD * 100, 100);
  const left     = Math.max(THRESHOLD - weighted, 0);
```

- [ ] **Step 2: Update the LEFT label to "BUDGET LEFT" in `buildTile()`**

Find:
```javascript
      <div class="seg seg-left">
          <div class="seg-label">LEFT</div>
```
Replace with:
```javascript
      <div class="seg seg-left">
          <div class="seg-label">BUDGET LEFT</div>
```

- [ ] **Step 3: Build and verify**
```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 4: Run full test suite**
```bash
npm test -- --run
```
Expected: all 46 tests pass.

- [ ] **Step 5: Commit**
```bash
git add src/frontend/browser/dashboard.js
git commit -m "feat: switch progress bar to weighted token budget, label BUDGET LEFT"
```

---

## Task 5: Playwright browser verification

**Files:**
- No source changes — verification only

### Context

The dev server runs on `http://localhost:3001`. Start it before the Playwright checks. The dashboard is a single-page app served at `/`. Since live Claude Code sessions may not be running, inject synthetic state via the `/hook` endpoint (POST JSON) to exercise the model breakdown rendering.

Playwright is already configured in the project. Use `mcp__plugin_playwright_playwright__*` tools.

- [ ] **Step 1: Start the dev server**
```bash
npm run build && npm start &
```
Wait 2 seconds for the server to be ready.

- [ ] **Step 2: Navigate to the dashboard**

Use Playwright `browser_navigate` to open `http://localhost:3001`.

Take a screenshot to confirm the empty state loads cleanly (no JS errors).

- [ ] **Step 3: POST a synthetic Sonnet hook event**
```bash
curl -s -X POST http://localhost:3001/hook \
  -H "Content-Type: application/json" \
  -d '{
    "hook_event_name": "PostToolUse",
    "session_id": "test-sonnet-1",
    "cwd": "/home/user/TestProject",
    "model": "claude-sonnet-4-6",
    "usage": { "input_tokens": 300000, "output_tokens": 100000 },
    "timestamp_ms": '"$(date +%s%3N)"'
  }'
```

- [ ] **Step 4: Take a screenshot and verify tile renders**

Use Playwright `browser_take_screenshot`. Confirm:
- A tile for "TestProject" appears
- Progress bar shows ~40% (400k / 1M weighted = 40%)
- Model breakdown shows SONNET row with IN 300,000 / OUT 100,000
- ACTIVE dot is visible

- [ ] **Step 5: POST a synthetic Opus hook event (same session)**
```bash
curl -s -X POST http://localhost:3001/hook \
  -H "Content-Type: application/json" \
  -d '{
    "hook_event_name": "PostToolUse",
    "session_id": "test-sonnet-1",
    "cwd": "/home/user/TestProject",
    "model": "claude-opus-4-7",
    "usage": { "input_tokens": 50000, "output_tokens": 20000 },
    "timestamp_ms": '"$(($(date +%s%3N) + 1000))"'
  }'
```

- [ ] **Step 6: Take a screenshot and verify mixed-model tile**

Confirm:
- SONNET row still present
- OPUS row added with IN 50,000 / OUT 20,000
- OPUS row shows ACTIVE dot (most recent)
- Progress bar increased due to Opus weight (50k+20k tokens × 5 = 350k additional weighted units → total weighted ≈ 750k → ~75%, yellow alert)

- [ ] **Step 7: Check browser console for errors**

Use Playwright `browser_console_messages`. Confirm no JS errors.

- [ ] **Step 8: Stop the dev server**
```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 9: Commit verification note**
```bash
git commit --allow-empty -m "chore: browser-verified model breakdown + weighted progress bar"
```

---

## Task 6: Update docs

**Files:**
- Modify: `docs/checkpoints.md`
- Modify: `docs/CLAUDE.md`

- [ ] **Step 1: Append checkpoint to `docs/checkpoints.md`**

Append:
```markdown
---

### 2026-04-18 — Model-Aware Token Tracking

**Completed:**
- `NormalizedEvent.model` extracted from hook payload (`raw.model`) and OTel span attributes
- Model-aware cost rates: Opus ($15/$75 per MTok), Sonnet ($3/$15), Haiku ($0.25/$1.25); Sonnet fallback for unknown models
- `SessionState.models` map: per-model tokens_in/out/cost; `model_last` tracks active model
- `SessionState.weighted_tokens_total`: Sonnet-equivalent budget units (Opus×5, Haiku×0.08)
- Alert levels, ETA, checkpoint thresholds all use weighted tokens
- Per-model breakdown rows in each tile (badge + ACTIVE dot + IN/OUT/cost)
- Progress bar switched to weighted budget; segment label "BUDGET LEFT"
- 46/46 tests passing

**Next step:** PID tracking + real process kill on Abort
```

- [ ] **Step 2: Update `docs/CLAUDE.md` Current State**

Find:
```
- 41/41 tests passing
- Tile enhancements: elapsed time row + usage-limit warning banner per tile
```
Replace with:
```
- 46/46 tests passing
- Tile enhancements: elapsed time row + usage-limit warning banner per tile
- Model-aware token tracking: per-model cost, weighted budget bar, breakdown UI per tile
```

Also update Key Types section. Find:
```
- SessionState: tokens_*, cost_usd, turns, tool_calls_total, burn_rate_per_sec, eta_to_threshold_sec, alert_level
- NormalizedEvent: source ("hook"|"otel"|"journal"), type (includes "token_delta"), metadata.bootstrapTurns, metadata.toolsDelta
```
Replace with:
```
- SessionState: tokens_*, cost_usd, turns, tool_calls_total, burn_rate_per_sec, eta_to_threshold_sec, alert_level, models (per-model map), weighted_tokens_total, model_last
- NormalizedEvent: source ("hook"|"otel"|"journal"), type (includes "token_delta"), model?, metadata.bootstrapTurns, metadata.toolsDelta
```

- [ ] **Step 3: Commit and push**
```bash
git add docs/checkpoints.md docs/CLAUDE.md
git commit -m "docs: model-aware token tracking checkpoint"
git push
```
