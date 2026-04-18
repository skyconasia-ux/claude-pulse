# Terminal Multi-Session Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-session terminal view with a multi-session layout: a session list table at the top (keyboard-navigable) plus a detail pane for the selected session below.

**Architecture:** The terminal dashboard (`src/frontend/terminal/index.ts`) is fully rewritten. All session states are maintained in a local `Map`. A `contrib.table` widget at the top shows all sessions. Arrow keys change the selected session; the detail pane (metrics, prediction, alert, burn chart) shows only the selected session. The `pickMostActive` fallback selects the most-recently-seen session on first connect.

**Tech Stack:** TypeScript, blessed, blessed-contrib, WebSocket (`ws`), Vitest

---

## File Map

| File | Change |
|---|---|
| `src/frontend/terminal/index.ts` | Full rewrite — multi-session layout |
| `tests/frontend/terminal.test.ts` | New test file — unit tests for pure logic helpers |

Note: The terminal dashboard has no existing tests. This plan adds a test file for the pure helper functions extracted from the dashboard logic. The blessed UI widgets cannot be unit-tested (they require a TTY) — integration is verified manually.

---

### Task 1: Extract and test pure helper logic

The current `index.ts` mixes UI setup with pure logic. Before rewriting, extract and test the helpers so they are safe to reuse.

**Files:**
- Create: `src/frontend/terminal/helpers.ts`
- Create: `tests/frontend/terminal.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/frontend/terminal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  pickMostActive,
  pickSelected,
  fmtEta,
  fmtTokens,
  alertColor,
  sessionRows,
} from "../../src/frontend/terminal/helpers";
import { SessionState } from "../../src/types";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "sess-1",
    project_name: "MyProject",
    lifecycle: "idle",
    last_seen_ms: 1000,
    is_stale: false,
    started_at: 900,
    turns: 5,
    tool_calls_total: 10,
    tokens_total: 50000,
    tokens_in: 30000,
    tokens_out: 20000,
    cost_usd: 0.12,
    activity_state: "idle",
    burn_rate_per_sec: 0,
    tokens_per_turn_avg: 10000,
    eta_to_threshold_sec: Infinity,
    alert_level: "green",
    last_checkpoint_turn: 0,
    ...overrides,
  };
}

describe("pickMostActive", () => {
  it("returns null for empty array", () => {
    expect(pickMostActive([])).toBeNull();
  });

  it("returns the session with the highest last_seen_ms", () => {
    const s1 = makeState({ session_id: "a", last_seen_ms: 100 });
    const s2 = makeState({ session_id: "b", last_seen_ms: 200 });
    expect(pickMostActive([s1, s2])?.session_id).toBe("b");
  });
});

describe("pickSelected", () => {
  it("returns the session matching selectedId", () => {
    const sessions = new Map([
      ["a", makeState({ session_id: "a" })],
      ["b", makeState({ session_id: "b" })],
    ]);
    expect(pickSelected(sessions, "b")?.session_id).toBe("b");
  });

  it("falls back to pickMostActive when selectedId not found", () => {
    const sessions = new Map([
      ["a", makeState({ session_id: "a", last_seen_ms: 100 })],
      ["b", makeState({ session_id: "b", last_seen_ms: 200 })],
    ]);
    expect(pickSelected(sessions, "missing")?.session_id).toBe("b");
  });

  it("returns null when map is empty", () => {
    expect(pickSelected(new Map(), "x")).toBeNull();
  });
});

describe("fmtEta", () => {
  it("returns em-dash for infinite eta", () => {
    expect(fmtEta(Infinity)).toBe("—");
  });
  it("returns em-dash for zero eta", () => {
    expect(fmtEta(0)).toBe("—");
  });
  it("returns seconds for < 60s", () => {
    expect(fmtEta(45)).toBe("45s");
  });
  it("returns minutes for >= 60s", () => {
    expect(fmtEta(90)).toBe("~2m");
  });
});

describe("fmtTokens", () => {
  it("formats thousands with k suffix", () => {
    expect(fmtTokens(12500)).toBe("12.5k");
  });
  it("formats millions with M suffix", () => {
    expect(fmtTokens(1200000)).toBe("1.2M");
  });
  it("returns raw number for < 1000", () => {
    expect(fmtTokens(500)).toBe("500");
  });
});

describe("alertColor", () => {
  it("returns green for green level", () => {
    expect(alertColor("green")).toBe("green");
  });
  it("returns yellow for yellow level", () => {
    expect(alertColor("yellow")).toBe("yellow");
  });
  it("returns red for red level", () => {
    expect(alertColor("red")).toBe("red");
  });
});

describe("sessionRows", () => {
  it("returns one row per session", () => {
    const sessions = new Map([
      ["a", makeState({ session_id: "a", project_name: "Proj1", alert_level: "green" })],
      ["b", makeState({ session_id: "b", project_name: "Proj2", alert_level: "red" })],
    ]);
    const rows = sessionRows(sessions, "a");
    expect(rows).toHaveLength(2);
  });

  it("marks the selected session with > prefix", () => {
    const sessions = new Map([
      ["a", makeState({ session_id: "a", project_name: "Proj1" })],
    ]);
    const rows = sessionRows(sessions, "a");
    expect(rows[0][0]).toContain(">");
  });

  it("includes project name, lifecycle, token count, and cost in each row", () => {
    const sessions = new Map([
      ["a", makeState({ session_id: "a", project_name: "TestProj", lifecycle: "idle", tokens_total: 50000, cost_usd: 0.12 })],
    ]);
    const rows = sessionRows(sessions, "a");
    expect(rows[0].join(" ")).toContain("TestProj");
    expect(rows[0].join(" ")).toContain("IDLE");
    expect(rows[0].join(" ")).toContain("50.0k");
    expect(rows[0].join(" ")).toContain("0.1200");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npx vitest run tests/frontend/terminal.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/frontend/terminal/helpers.ts`**

```typescript
import { SessionState } from "../../types";

export function pickMostActive(sessions: SessionState[]): SessionState | null {
  if (sessions.length === 0) return null;
  return sessions.slice().sort((a, b) => b.last_seen_ms - a.last_seen_ms)[0];
}

export function pickSelected(
  sessions: Map<string, SessionState>,
  selectedId: string,
): SessionState | null {
  if (sessions.has(selectedId)) return sessions.get(selectedId)!;
  return pickMostActive(Array.from(sessions.values()));
}

export function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function alertColor(level: SessionState["alert_level"]): string {
  if (level === "yellow") return "yellow";
  if (level === "red") return "red";
  return "green";
}

export function sessionRows(
  sessions: Map<string, SessionState>,
  selectedId: string,
): string[][] {
  return Array.from(sessions.values()).map(s => [
    s.session_id === selectedId ? "> " + s.project_name : "  " + s.project_name,
    s.lifecycle.toUpperCase(),
    fmtTokens(s.tokens_total),
    `$${s.cost_usd.toFixed(4)}`,
    s.alert_level.toUpperCase(),
  ]);
}
```

- [ ] **Step 4: Run tests — expect pass**

```
npx vitest run tests/frontend/terminal.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/frontend/terminal/helpers.ts tests/frontend/terminal.test.ts
git commit -m "feat: extract terminal dashboard helpers, add unit tests"
```

---

### Task 2: Rewrite terminal dashboard with multi-session layout

**Files:**
- Modify: `src/frontend/terminal/index.ts` (full rewrite)

New grid layout (12 rows × 12 cols):
```
Row 0-2  (3 rows): session list table (full width 12 cols)
Row 3-7  (5 rows): burn chart (8 cols) | metrics (4 cols)
Row 8-9  (2 rows): prediction (6 cols) | alert (6 cols)
Row 10-11 (2 rows): log (full width 12 cols)
```

- [ ] **Step 1: No new tests needed** — UI-only rewrite; all logic is tested via helpers.ts. Verify manually.

- [ ] **Step 2: Write the new `index.ts`**

Replace entire content of `src/frontend/terminal/index.ts` with:

```typescript
import blessed from "blessed";
import contrib from "blessed-contrib";
import WebSocket from "ws";
import { SessionState, WsMessage } from "../../types";
import {
  pickMostActive,
  pickSelected,
  fmtEta,
  fmtTokens,
  alertColor,
  sessionRows,
} from "./helpers";

const WS_URL = "ws://localhost:3001";
const BURN_HISTORY_SIZE = 30;
const THRESHOLD = 1_000_000;

// ── Screen + Grid ────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: "Claude Pulse" });
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Row 0-2: session list
const sessionTable = grid.set(0, 0, 3, 12, contrib.table, {
  label: " SESSIONS (↑/↓ select) ",
  keys: false,
  columnSpacing: 2,
  columnWidth: [20, 10, 10, 10, 8],
  border: { type: "line", fg: "cyan" },
  style: {
    header: { fg: "cyan", bold: true },
    cell: { fg: "white", selected: { bg: "blue" } },
  },
});

// Row 3-7: burn chart + metrics
const burnChart = grid.set(3, 0, 5, 8, contrib.bar, {
  label: " BURN RATE (tok/s) ",
  barWidth: 4,
  barSpacing: 2,
  xOffset: 0,
  maxHeight: 100,
  style: { bar: { bg: "cyan" }, text: "cyan", baseline: "black" },
  border: { type: "line", fg: "cyan" },
});

const metricsBox = grid.set(3, 8, 5, 4, blessed.box, {
  label: " METRICS ",
  border: { type: "line", fg: "cyan" },
  style: { fg: "cyan" },
  tags: true,
  content: "Loading...",
});

// Row 8-9: prediction + alert
const predictionBox = grid.set(8, 0, 2, 6, blessed.box, {
  label: " PREDICTION ",
  border: { type: "line", fg: "magenta" },
  style: { fg: "magenta" },
  tags: true,
  content: "Loading...",
});

const alertBox = grid.set(8, 6, 2, 6, blessed.box, {
  label: " STATUS ",
  border: { type: "line", fg: "green" },
  style: { fg: "green" },
  tags: true,
  content: "● Connecting...",
});

// Row 10-11: log
const logBox = grid.set(10, 0, 2, 12, contrib.log, {
  label: " LOG ",
  border: { type: "line", fg: "grey" },
  style: { fg: "grey" },
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));

// ── State ────────────────────────────────────────────────
const allSessions = new Map<string, SessionState>();
let selectedId = "";
const burnHistory: number[] = [];

// ── Helpers ──────────────────────────────────────────────
function log2(s: string) {
  (logBox as unknown as { log: (s: string) => void }).log(s);
}

// ── Render ───────────────────────────────────────────────
function renderSessionList(): void {
  const rows = sessionRows(allSessions, selectedId);
  (sessionTable as unknown as {
    setData: (d: { headers: string[]; data: string[][] }) => void
  }).setData({
    headers: ["PROJECT", "STATE", "TOKENS", "COST", "ALERT"],
    data: rows.length > 0 ? rows : [["(no sessions)", "", "", "", ""]],
  });
}

function renderDetail(state: SessionState): void {
  const weighted = state.weighted_tokens_total ?? state.tokens_total;
  const left = Math.max(THRESHOLD - weighted, 0);
  const pct = ((weighted / THRESHOLD) * 100).toFixed(1);

  metricsBox.setContent([
    `{cyan-fg}PROJECT{/}  ${state.project_name}`,
    `{cyan-fg}STATE{/}    ${state.lifecycle.toUpperCase()}`,
    `{cyan-fg}TOK IN{/}   ${fmtTokens(state.tokens_in)}`,
    `{magenta-fg}TOK OUT{/}  ${fmtTokens(state.tokens_out)}`,
    `{white-fg}TOTAL{/}    ${fmtTokens(state.tokens_total)}`,
    `{magenta-fg}COST{/}     $${state.cost_usd.toFixed(4)}`,
    `{yellow-fg}TURNS{/}    ${state.turns}`,
    `{white-fg}BUDGET{/}   ${pct}%`,
  ].join("\n"));

  predictionBox.setContent([
    `{cyan-fg}BURN/SEC{/}  ${Math.round(state.burn_rate_per_sec)} tok/s`,
    `{cyan-fg}ETA{/}       ${fmtEta(state.eta_to_threshold_sec)}`,
    `{white-fg}LEFT{/}      ${fmtTokens(left)}`,
    `{white-fg}TOK/TURN{/}  ${Math.round(state.tokens_per_turn_avg)}`,
  ].join("\n"));

  const color = alertColor(state.alert_level);
  alertBox.style.border = { type: "line", fg: color };
  const turnsToNext = Math.max(0, 20 - state.turns);
  alertBox.setContent([
    `{${color}-fg}● ${state.alert_level.toUpperCase()}{/}`,
    ``,
    turnsToNext > 0
      ? `{yellow-fg}⚠ Checkpoint in ${turnsToNext} turns{/}`
      : `{red-fg}⚠ Checkpoint due{/}`,
  ].join("\n"));

  burnHistory.push(Math.round(state.burn_rate_per_sec));
  if (burnHistory.length > BURN_HISTORY_SIZE) burnHistory.shift();
  burnChart.setData({
    titles: burnHistory.map((_, i) => String(i + 1)),
    data: burnHistory,
  });
}

function render(): void {
  renderSessionList();
  const state = pickSelected(allSessions, selectedId);
  if (state) renderDetail(state);
  screen.render();
}

// ── Keyboard navigation ──────────────────────────────────
function sessionIds(): string[] {
  return Array.from(allSessions.keys());
}

screen.key(["up", "k"], () => {
  const ids = sessionIds();
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectedId);
  selectedId = ids[Math.max(0, idx - 1)];
  render();
});

screen.key(["down", "j"], () => {
  const ids = sessionIds();
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectedId);
  selectedId = ids[Math.min(ids.length - 1, idx + 1)];
  render();
});

// ── WebSocket ────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => log2("Connected to Claude Pulse server"));

  ws.on("message", (data) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log2("Parse error: malformed message");
      return;
    }

    if (msg.type === "sessions_snapshot") {
      allSessions.clear();
      for (const s of msg.sessions) allSessions.set(s.session_id, s);
      if (!allSessions.has(selectedId)) {
        const active = pickMostActive(msg.sessions);
        selectedId = active?.session_id ?? "";
        if (active) log2(`Auto-selected: ${active.project_name} (${active.session_id.slice(0, 8)})`);
      }
      render();
    } else if (msg.type === "session_updated") {
      allSessions.set(msg.session.session_id, msg.session);
      if (selectedId === "" || selectedId === msg.session.session_id) {
        selectedId = msg.session.session_id;
      }
      render();
    } else if (msg.type === "checkpoint_event") {
      allSessions.set(msg.state.session_id, msg.state);
      if (msg.state.session_id === selectedId) {
        const label = msg.severity === "mandatory" ? "⚠ CHECKPOINT CREATED" : "● RECOMMEND CHECKPOINT";
        log2(label);
      }
      render();
    }
  });

  ws.on("close", () => {
    log2("Disconnected — retrying in 2s...");
    setTimeout(connect, 2000);
  });
  ws.on("error", (err) => log2(`Error: ${err.message}`));
}

connect();
```

- [ ] **Step 3: Run full test suite (helpers + all existing tests)**

```
npx vitest run
```
Expected: all tests pass (count unchanged — terminal rewrite adds no new test failures)

- [ ] **Step 4: Start terminal dashboard and verify visually**

```bash
echo "2" | npm run dev
```

Expected:
- Top section shows table with one row per connected session (or "(no sessions)" if none)
- Pressing ↑/↓ (or j/k) changes the selected row; detail pane updates
- Detail pane shows metrics, prediction, alert, burn chart for the selected session
- Log box shows connection status
- q / Ctrl+C exits

If no sessions are connected, the session table shows the placeholder row. Fire a test hook:
```bash
curl -s -X POST http://localhost:3001/hook \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PostToolUse","session_id":"term-test","cwd":"C:/test/TermProj","usage":{"input_tokens":1000,"output_tokens":500}}'
```
A row should appear in the table and the detail pane should populate.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/terminal/index.ts
git commit -m "feat: terminal multi-session layout with keyboard navigation"
```

---

### Task 3: Final polish — model badge + weighted budget in detail pane

**Files:**
- Modify: `src/frontend/terminal/helpers.ts`
- Modify: `src/frontend/terminal/index.ts`
- Modify: `tests/frontend/terminal.test.ts`

The detail pane should show the last model used and the weighted budget (not just raw tokens). These are already on `SessionState` from the model-aware tracking feature.

- [ ] **Step 1: Add failing test for model display helper**

Add to `tests/frontend/terminal.test.ts`:

```typescript
describe("shortModelName", () => {
  it("shortens opus model", () => {
    expect(shortModelName("claude-opus-4-7")).toBe("opus");
  });
  it("shortens sonnet model", () => {
    expect(shortModelName("claude-sonnet-4-6")).toBe("sonnet");
  });
  it("shortens haiku model", () => {
    expect(shortModelName("claude-haiku-4-5")).toBe("haiku");
  });
  it("returns unknown for undefined", () => {
    expect(shortModelName(undefined)).toBe("—");
  });
});
```

Add import: `import { ..., shortModelName } from "../../src/frontend/terminal/helpers";`

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/frontend/terminal.test.ts
```
Expected: FAIL — shortModelName not exported

- [ ] **Step 3: Add `shortModelName` to helpers**

Add to `src/frontend/terminal/helpers.ts`:

```typescript
export function shortModelName(model: string | undefined): string {
  if (!model) return "—";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}
```

- [ ] **Step 4: Update metrics box in `renderDetail`**

In `src/frontend/terminal/index.ts`, update `renderDetail` to use `weighted_tokens_total` and show model. Update the import from `./helpers` to include `shortModelName`.

Replace the `metricsBox.setContent` call in `renderDetail`:

```typescript
  metricsBox.setContent([
    `{cyan-fg}PROJECT{/}  ${state.project_name}`,
    `{cyan-fg}STATE{/}    ${state.lifecycle.toUpperCase()}`,
    `{cyan-fg}MODEL{/}    ${shortModelName(state.model_last)}`,
    `{cyan-fg}TOK IN{/}   ${fmtTokens(state.tokens_in)}`,
    `{magenta-fg}TOK OUT{/}  ${fmtTokens(state.tokens_out)}`,
    `{white-fg}TOTAL{/}    ${fmtTokens(state.tokens_total)}`,
    `{magenta-fg}COST{/}     $${state.cost_usd.toFixed(4)}`,
    `{yellow-fg}TURNS{/}    ${state.turns}`,
    `{white-fg}BUDGET{/}   ${pct}%`,
  ].join("\n"));
```

- [ ] **Step 5: Run full test suite**

```
npx vitest run
```
Expected: all tests pass

- [ ] **Step 6: Commit and push**

```bash
git add src/frontend/terminal/helpers.ts src/frontend/terminal/index.ts tests/frontend/terminal.test.ts
git commit -m "feat: show model + weighted budget in terminal detail pane"
git push
```
