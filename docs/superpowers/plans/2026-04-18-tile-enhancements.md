# Tile Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session/project elapsed time and Claude Code usage-limit warning banners to each live monitoring tile.

**Architecture:** Three isolated layers — (1) extend `types.ts` + `StateStore` to persist `projectFirstSeen` alongside sessions, (2) add notification extraction in `SessionStore` and project-first-seen tracking in `SessionRegistry`, (3) add time row and warning banner in the browser frontend. No new HTTP endpoints. No new config keys. All existing tests must remain green.

**Tech Stack:** TypeScript (Node.js backend), vanilla JS (browser), Vitest (tests).

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add 3 fields to `SessionState` |
| `src/monitor/StateStore.ts` | New `loadPersistedData()` + updated `persistSessions()` signature |
| `src/monitor/SessionStore.ts` | Add notification branch + `setProjectFirstSeen()` method |
| `src/monitor/SessionRegistry.ts` | Add `projectFirstSeen` Map, wire up load/save/assign |
| `src/frontend/browser/index.html` | CSS for time row + warning banner |
| `src/frontend/browser/dashboard.js` | `fmtElapsed()`, time row ticker, warning banner render |
| `tests/monitor/SessionStore.test.ts` | 4 new notification tests |
| `tests/monitor/sessionRegistry.test.ts` | NEW — 3 project-first-seen tests |

---

## Task 1: Extend `SessionState` types + `StateStore` persistence

**Files:**
- Modify: `src/types.ts`
- Modify: `src/monitor/StateStore.ts`
- Modify: `src/monitor/SessionRegistry.ts`

### Context

`StateStore.ts` currently writes sessions as a bare JSON array:
```
fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2))
```
We need to wrap it in `{ sessions, projectFirstSeen }`. `SessionRegistry` calls `loadPersistedSessions()` and `persistSessions()` — both signatures change.

**Backward-compat migration:** If the file on disk is a bare array (old format), treat it as `{ sessions: array, projectFirstSeen: {} }`.

- [ ] **Step 1: Update `SessionState` in `src/types.ts`**

Add three optional fields after `last_checkpoint_turn`:
```typescript
last_checkpoint_turn: number;
last_notification?: string;
notification_level?: "warn" | "critical";
project_first_seen_ms?: number;
```

- [ ] **Step 2: Run existing tests to confirm they still pass**

```bash
cd /c/users/quick/LiveVisualUsage && npm test -- --run
```
Expected: all 34 tests pass (optional fields don't break anything).

- [ ] **Step 3: Rewrite `src/monitor/StateStore.ts`**

Replace the entire file content:
```typescript
import fs from "fs";
import path from "path";
import { SessionState } from "../types";
import { makeLogger } from "../server/logger";

const log = makeLogger("StateStore");
const DATA_FILE = path.join(process.cwd(), "data", "sessions.json");

interface PersistedData {
  sessions: SessionState[];
  projectFirstSeen: Record<string, number>;
}

export function loadPersistedData(): PersistedData {
  try {
    if (!fs.existsSync(DATA_FILE)) return { sessions: [], projectFirstSeen: {} };
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    // Backward compat: old format was a bare array
    if (Array.isArray(raw)) {
      log.info("migrating sessions file from array to object format");
      return { sessions: raw as SessionState[], projectFirstSeen: {} };
    }
    const sessions = Array.isArray(raw.sessions) ? raw.sessions as SessionState[] : [];
    const projectFirstSeen = (raw.projectFirstSeen as Record<string, number>) ?? {};
    log.info("loaded persisted data", { sessions: sessions.length, projects: Object.keys(projectFirstSeen).length });
    return { sessions, projectFirstSeen };
  } catch (e) {
    log.warn("could not load persisted data", { err: String(e) });
    return { sessions: [], projectFirstSeen: {} };
  }
}

export function persistSessions(
  sessions: SessionState[],
  projectFirstSeen: Record<string, number>,
): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions, projectFirstSeen }, null, 2), "utf8");
  } catch (e) {
    log.warn("could not persist sessions", { err: String(e) });
  }
}
```

- [ ] **Step 4: Update `SessionRegistry.ts` to use new StateStore API**

The registry calls `loadPersistedSessions()` and `persistSessions(sessions)` in two places. Change both:

In the import at the top, change:
```typescript
import { loadPersistedSessions, persistSessions } from "./StateStore";
```
to:
```typescript
import { loadPersistedData, persistSessions } from "./StateStore";
```

In `loadPersisted()`, change:
```typescript
for (const state of loadPersistedSessions()) {
```
to:
```typescript
const { sessions } = loadPersistedData();
for (const state of sessions) {
```

In `scheduleSave()` callback, change:
```typescript
persistSessions(this.getAllStates());
```
to:
```typescript
persistSessions(this.getAllStates(), {});
```

In `destroy()`, change:
```typescript
persistSessions(this.getAllStates());
```
to:
```typescript
persistSessions(this.getAllStates(), {});
```

(The `{}` is a temporary placeholder — Task 3 replaces it with the real map.)

- [ ] **Step 5: Run all tests**

```bash
npm test -- --run
```
Expected: all 34 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/monitor/StateStore.ts src/monitor/SessionRegistry.ts
git commit -m "feat: extend SessionState types + refactor StateStore to persist projectFirstSeen"
```

---

## Task 2: Notification extraction in `SessionStore`

**Files:**
- Modify: `src/monitor/SessionStore.ts`
- Modify: `tests/monitor/SessionStore.test.ts`

### Context

When Claude Code hits a usage limit, it fires a `Notification` hook with a `message` field in the raw payload. The full raw payload is already stored in `event.metadata` by `EventNormalizer`. The `SessionStore.apply()` method handles `notification` events in the fallthrough branch but does nothing with the message content.

We add:
1. A `parseNotificationPct(msg)` helper that extracts the first `NN%` from the message string.
2. In `apply()`, a dedicated branch for `notification` events that checks for limit/usage keywords and sets `last_notification` + `notification_level` on state.
3. `makeEmptyState()` already returns `undefined` for optional fields, so `session_start` clears the notification automatically.

- [ ] **Step 1: Write 4 failing tests in `tests/monitor/SessionStore.test.ts`**

Add a new `describe` block at the end of the file:
```typescript
describe("SessionStore — notification events", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(cfg); });

  it("sets last_notification and warn level on 70–89% message", () => {
    store.apply(makeEvent({
      type: "notification",
      tokens: { input: 0, output: 0 },
      cost_usd: 0,
      metadata: { message: "You have used 78% of your daily usage limit." },
    }));
    const s = store.getState();
    expect(s.last_notification).toBe("You have used 78% of your daily usage limit.");
    expect(s.notification_level).toBe("warn");
  });

  it("sets critical level on ≥90% message", () => {
    store.apply(makeEvent({
      type: "notification",
      tokens: { input: 0, output: 0 },
      cost_usd: 0,
      metadata: { message: "You have used 92% of your usage limit." },
    }));
    expect(store.getState().notification_level).toBe("critical");
  });

  it("ignores notification with no limit keywords", () => {
    store.apply(makeEvent({
      type: "notification",
      tokens: { input: 0, output: 0 },
      cost_usd: 0,
      metadata: { message: "Tool completed successfully." },
    }));
    expect(store.getState().last_notification).toBeUndefined();
  });

  it("clears last_notification on session_start", () => {
    store.apply(makeEvent({
      type: "notification",
      tokens: { input: 0, output: 0 },
      cost_usd: 0,
      metadata: { message: "You have used 78% of your daily usage limit." },
    }));
    store.apply(makeEvent({ type: "session_start", tokens: { input: 0, output: 0 }, cost_usd: 0 }));
    expect(store.getState().last_notification).toBeUndefined();
    expect(store.getState().notification_level).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm 4 new tests fail**

```bash
npm test -- --run tests/monitor/SessionStore.test.ts
```
Expected: 4 new tests FAIL, all existing tests pass.

- [ ] **Step 3: Add `parseNotificationPct` helper + notification branch to `SessionStore.ts`**

Add `parseNotificationPct` as a module-level function above the `SessionStore` class:
```typescript
function parseNotificationPct(msg: string): number {
  const m = msg.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) : 70;
}
```

In `apply()`, add a new branch **before** the `session_end` branch (after the `token_delta` branch):
```typescript
if (event.type === "notification") {
  const msg = String(event.metadata.message ?? "");
  const lower = msg.toLowerCase();
  if (lower.includes("limit") || lower.includes("usage") || lower.includes("%")) {
    this.state.last_notification = msg;
    const pct = parseNotificationPct(msg);
    this.state.notification_level = pct >= 90 ? "critical" : "warn";
  }
  this.state.last_seen_ms = event.timestamp_ms;
  this.emit("state_updated", { ...this.state });
  return;
}
```

Place it immediately after the closing brace of the `token_delta` block (around line 119), before the `session_end` block.

- [ ] **Step 4: Run tests**

```bash
npm test -- --run tests/monitor/SessionStore.test.ts
```
Expected: all tests pass (including 4 new ones).

- [ ] **Step 5: Run full suite**

```bash
npm test -- --run
```
Expected: all 38 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/monitor/SessionStore.ts tests/monitor/SessionStore.test.ts
git commit -m "feat: extract usage-limit notifications from Notification hook events"
```

---

## Task 3: Project first-seen tracking in `SessionRegistry`

**Files:**
- Modify: `src/monitor/SessionRegistry.ts`
- Modify: `src/monitor/SessionStore.ts`
- Create: `tests/monitor/sessionRegistry.test.ts`

### Context

`SessionRegistry` manages all sessions. When it creates a new `SessionStore`, it needs to:
1. Check if `projectFirstSeen` has an entry for this project name.
2. If not, record `Date.now()` as the first-seen time.
3. Call `store.setProjectFirstSeen(ms)` to stamp the initial session state.
4. Pass the real `projectFirstSeen` map to `persistSessions()` in `scheduleSave()` and `destroy()`.

For restored sessions: `project_first_seen_ms` is already serialised in `SessionState`, so it round-trips through JSON automatically. But we also need to repopulate the `projectFirstSeen` Map from loaded sessions so future new sessions for the same project get the correct historical first-seen time.

- [ ] **Step 1: Create `tests/monitor/sessionRegistry.test.ts`**

```typescript
// tests/monitor/sessionRegistry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionRegistry } from "../../src/monitor/SessionRegistry";
import { NormalizedEvent } from "../../src/types";

// Prevent disk I/O in tests
vi.mock("../../src/monitor/StateStore", () => ({
  loadPersistedData: () => ({ sessions: [], projectFirstSeen: {} }),
  persistSessions: vi.fn(),
}));

const cfg = {
  token_threshold: 1000, turn_threshold: 20,
  refresh_active_ms: 1000, refresh_idle_ms: 5000,
  server_port: 3001, ws_port: 3001, otel_enabled: false,
};

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: "hook", type: "tool_use",
    tokens: { input: 10, output: 5 }, cost_usd: 0.0001,
    timestamp_ms: Date.now(), metadata: { cwd: "/home/user/MyProject" },
    session_id: "sess-abc", project_name: "MyProject",
    ...overrides,
  };
}

describe("SessionRegistry — project first-seen", () => {
  let registry: SessionRegistry;
  beforeEach(() => {
    registry = new SessionRegistry(cfg, () => {}, () => {});
  });

  it("stamps project_first_seen_ms on first event for a new project", () => {
    const before = Date.now();
    registry.route(makeEvent());
    const after = Date.now();
    const state = registry.getAllStates()[0];
    expect(state.project_first_seen_ms).toBeGreaterThanOrEqual(before);
    expect(state.project_first_seen_ms).toBeLessThanOrEqual(after);
  });

  it("does not overwrite project_first_seen_ms for a second session of the same project", () => {
    registry.route(makeEvent({ session_id: "sess-1" }));
    const first = registry.getAllStates().find(s => s.session_id === "sess-1")!.project_first_seen_ms!;
    // Small delay to ensure Date.now() would be different
    registry.route(makeEvent({ session_id: "sess-2" }));
    const second = registry.getAllStates().find(s => s.session_id === "sess-2")!.project_first_seen_ms!;
    expect(second).toBe(first);
  });

  it("carries project_first_seen_ms across session_start reset", () => {
    registry.route(makeEvent());
    const before = registry.getAllStates()[0].project_first_seen_ms!;
    registry.route(makeEvent({ type: "session_start", tokens: { input: 0, output: 0 }, cost_usd: 0 }));
    const after = registry.getAllStates()[0].project_first_seen_ms!;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run test file to confirm 3 tests fail**

```bash
npm test -- --run tests/monitor/sessionRegistry.test.ts
```
Expected: 3 tests FAIL.

- [ ] **Step 3: Update `session_start` branch in `SessionStore.ts` to preserve `project_first_seen_ms`**

In `SessionStore.apply()`, find the `session_start` branch (currently around line 72):
```typescript
if (event.type === "session_start") {
  const savedPath = this.state.project_path;
  this.state = makeEmptyState(this.state.session_id, this.state.project_name);
  if (savedPath) this.state.project_path = savedPath;
```

Replace with:
```typescript
if (event.type === "session_start") {
  const savedPath = this.state.project_path;
  const savedFirstSeen = this.state.project_first_seen_ms;
  this.state = makeEmptyState(this.state.session_id, this.state.project_name);
  if (savedPath) this.state.project_path = savedPath;
  if (savedFirstSeen) this.state.project_first_seen_ms = savedFirstSeen;
```

- [ ] **Step 4: Add `setProjectFirstSeen()` to `SessionStore.ts`**

Add this method to the `SessionStore` class (after `setStale`):
```typescript
setProjectFirstSeen(ms: number): void {
  this.state.project_first_seen_ms = ms;
}
```

- [ ] **Step 5: Update `SessionRegistry.ts` — add `projectFirstSeen` Map and wire it up**

Add the field declaration at the top of the class (after `private sessions`):
```typescript
private projectFirstSeen = new Map<string, number>();
```

Update `loadPersisted()` to also populate the map from loaded data AND from session states (for backward compat with sessions that already have `project_first_seen_ms` but no top-level `projectFirstSeen` entry):
```typescript
private loadPersisted(): void {
  const now = Date.now();
  const { sessions, projectFirstSeen } = loadPersistedData();
  // Load project first-seen map from persisted top-level key
  for (const [k, v] of Object.entries(projectFirstSeen)) {
    this.projectFirstSeen.set(k, v);
  }
  for (const state of sessions) {
    // Also seed from session state for backward compat
    if (state.project_first_seen_ms && !this.projectFirstSeen.has(state.project_name)) {
      this.projectFirstSeen.set(state.project_name, state.project_first_seen_ms);
    }
    const activeLifecycles: Array<typeof state.lifecycle> = ["running", "tool_use", "thinking"];
    const restoredState = {
      ...state,
      last_seen_ms: now,
      lifecycle: activeLifecycles.includes(state.lifecycle) ? "waiting" as const : state.lifecycle,
      is_stale: false,
    };
    const store = new SessionStore(this.cfg, state.session_id, state.project_name, restoredState);
    store.on("state_updated", (s: SessionState) => { this.onUpdate(s); this.scheduleSave(); });
    store.on("checkpoint_suggested", (s: SessionState) => this.onCheckpoint("suggested", s));
    store.on("checkpoint_mandatory", (s: SessionState) => this.onCheckpoint("mandatory", s));
    this.sessions.set(state.session_id, store);
    log.info("restored session from disk", { session_id: state.session_id, project: state.project_name });
  }
}
```

Update `route()` to assign `project_first_seen_ms` when creating a new store:
```typescript
route(event: NormalizedEvent): void {
  const id = event.session_id ?? "default";
  const name = event.project_name ?? "unknown";

  if (!this.sessions.has(id)) {
    log.info("new session registered", { session_id: id, project_name: name });
    if (!this.projectFirstSeen.has(name)) {
      this.projectFirstSeen.set(name, Date.now());
      this.scheduleSave();
    }
    const store = new SessionStore(this.cfg, id, name);
    store.setProjectFirstSeen(this.projectFirstSeen.get(name)!);
    store.on("state_updated", (s: SessionState) => { this.onUpdate(s); this.scheduleSave(); });
    store.on("checkpoint_suggested", (s: SessionState) => this.onCheckpoint("suggested", s));
    store.on("checkpoint_mandatory", (s: SessionState) => this.onCheckpoint("mandatory", s));
    this.sessions.set(id, store);
  }

  this.sessions.get(id)!.apply(event);
}
```

Update `scheduleSave()` to pass `projectFirstSeen`:
```typescript
private scheduleSave(): void {
  if (this.saveTimer) return;
  this.saveTimer = setTimeout(() => {
    this.saveTimer = null;
    persistSessions(this.getAllStates(), Object.fromEntries(this.projectFirstSeen));
  }, 3_000);
}
```

Update `destroy()` to pass `projectFirstSeen`:
```typescript
destroy(): void {
  clearInterval(this.staleTimer);
  if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  persistSessions(this.getAllStates(), Object.fromEntries(this.projectFirstSeen));
  log.info("sessions persisted on shutdown");
}
```

- [ ] **Step 6: Run all tests**

```bash
npm test -- --run
```
Expected: all 41 tests pass (34 original + 4 notification + 3 registry).

- [ ] **Step 7: Commit**

```bash
git add src/monitor/SessionStore.ts src/monitor/SessionRegistry.ts tests/monitor/sessionRegistry.test.ts
git commit -m "feat: track project first-seen timestamp, persist alongside sessions"
```

---

## Task 4: Frontend — elapsed time row

**Files:**
- Modify: `src/frontend/browser/index.html`
- Modify: `src/frontend/browser/dashboard.js`

### Context

`buildTile()` in `dashboard.js` constructs the tile HTML string. We add a `.tile-time-row` div immediately after the `tile-header` div. We store `started_at` and `project_first_seen_ms` as `data-started-at` and `data-project-first-seen` attributes on the tile element itself. A single `setInterval` at 1s walks all tiles and fills the two span elements.

`updateTile()` must keep those attributes in sync as state updates arrive (in case `project_first_seen_ms` arrives later than tile creation).

- [ ] **Step 1: Add CSS to `src/frontend/browser/index.html`**

Add the following CSS block inside `<style>`, after the `.plan-bar` block (around line 162):
```css
.tile-time-row {
  display: flex; gap: 16px; align-items: center;
  font-size: 9px; letter-spacing: 1px; color: rgba(255,255,255,0.3);
  border-top: 1px solid rgba(0,255,240,0.07); padding-top: 6px;
}
.tile-time-row .ttr-val { color: rgba(0,255,240,0.6); }
.tile-time-row .ttr-sep { color: rgba(255,255,255,0.12); }
```

- [ ] **Step 2: Add time row to `buildTile()` in `dashboard.js`**

In `buildTile()`, find the line:
```javascript
    <div class="plan-bar" data-field="plan-bar"></div>
```

Insert the following **before** it:
```javascript
    <div class="tile-time-row">
      ⏱ session <span class="ttr-val" data-field="elapsed-sess">—</span>
      <span class="ttr-sep">|</span>
      project <span class="ttr-val" data-field="elapsed-proj">—</span>
    </div>
```

- [ ] **Step 3: Add `fmtElapsed()` helper and 1s ticker to `dashboard.js`**

Add `fmtElapsed` near the other format helpers (alongside `fmt`, `fmtCost4`, etc.):
```javascript
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return h + 'h ' + rm + 'm';
  const d = Math.floor(h / 24), rh = h % 24;
  return d + 'd ' + rh + 'h';
}
```

Add the ticker at the bottom of the script (before or after `connect()`):
```javascript
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('.tile').forEach(el => {
    const sa = el.dataset.startedAt;
    const pf = el.dataset.projectFirstSeen;
    const sessEl = el.querySelector('[data-field="elapsed-sess"]');
    const projEl = el.querySelector('[data-field="elapsed-proj"]');
    if (sessEl && sa) sessEl.textContent = fmtElapsed(now - Number(sa));
    if (projEl && pf) projEl.textContent = fmtElapsed(now - Number(pf));
  });
}, 1000);
```

- [ ] **Step 4: Update `updateTile()` to stamp data attributes**

In `updateTile(tile, s)`, add the following two lines immediately after `tile.dataset.id = s.session_id;` (the last line of the function):
```javascript
if (s.started_at) tile.dataset.startedAt = s.started_at;
if (s.project_first_seen_ms) tile.dataset.projectFirstSeen = s.project_first_seen_ms;
```

- [ ] **Step 5: Build and verify**

```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 6: Run full test suite**

```bash
npm test -- --run
```
Expected: all 41 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/browser/index.html src/frontend/browser/dashboard.js
git commit -m "feat: add elapsed time row (session + project age) to tiles"
```

---

## Task 5: Frontend — usage warning banner

**Files:**
- Modify: `src/frontend/browser/index.html`
- Modify: `src/frontend/browser/dashboard.js`

### Context

`SessionState` now carries `last_notification?: string` and `notification_level?: "warn" | "critical"`. We add a `.tile-warn-banner` div just above `.tile-footer` in `buildTile()`. In `updateTile()` we show/hide it based on `last_notification`.

The banner uses `pulse` animation (already defined as `@keyframes pulse` in the existing CSS).

- [ ] **Step 1: Add CSS to `src/frontend/browser/index.html`**

Add the following CSS block inside `<style>`, after the `.tile-time-row` block added in Task 4:
```css
.tile-warn-banner {
  display: none; align-items: center; gap: 8px;
  border-radius: 5px; padding: 6px 10px;
  font-size: 9px; letter-spacing: 1px; font-weight: bold;
  animation: pulse 1s ease-in-out infinite;
}
.tile-warn-banner.open { display: flex; }
.tile-warn-banner.level-warn {
  background: rgba(255,170,0,0.08); border: 1px solid rgba(255,170,0,0.35); color: #ffaa00;
}
.tile-warn-banner.level-critical {
  background: rgba(255,68,85,0.08); border: 1px solid rgba(255,68,85,0.4); color: #ff4455;
}
.tile-warn-icon { font-size: 11px; }
.tile-warn-msg  { flex: 1; }
```

- [ ] **Step 2: Add banner HTML to `buildTile()` in `dashboard.js`**

In `buildTile()`, find:
```javascript
    <div class="tile-footer">
```

Insert the following **before** it:
```javascript
    <div class="tile-warn-banner">
      <span class="tile-warn-icon">⚠</span>
      <span class="tile-warn-msg"></span>
    </div>
```

- [ ] **Step 3: Update `updateTile()` to drive the banner**

In `updateTile(tile, s)`, add the following block after the `// Tile border class` block (i.e. after the `tile.className` and `tile.dataset.id` lines):
```javascript
// Usage warning banner
const banner = tile.querySelector('.tile-warn-banner');
if (banner) {
  if (s.last_notification) {
    banner.classList.add('open');
    banner.classList.toggle('level-warn',     s.notification_level === 'warn');
    banner.classList.toggle('level-critical', s.notification_level === 'critical');
    banner.querySelector('.tile-warn-msg').textContent = s.last_notification;
  } else {
    banner.classList.remove('open', 'level-warn', 'level-critical');
  }
}
```

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 5: Run full test suite**

```bash
npm test -- --run
```
Expected: all 41 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/browser/index.html src/frontend/browser/dashboard.js
git commit -m "feat: add usage-limit warning banner to tiles"
```

---

## Task 6: Update docs + push

**Files:**
- Modify: `docs/checkpoints.md`
- Modify: `docs/claude.md`

- [ ] **Step 1: Append checkpoint to `docs/checkpoints.md`**

Append to the end of the file:
```markdown
---

### 2026-04-18 — Tile Enhancements: Elapsed Time + Usage Warnings

**Completed:**
- Session elapsed time + project age (first-ever session for project) displayed in each tile time row
- `project_first_seen_ms` persisted in `data/sessions.json` alongside sessions; backward-compatible migration from bare-array format
- Usage-limit warning banner per tile: extracts message from Claude Code Notification hook, amber (≥70%) or red (≥90%), sticky until session ends
- 41/41 tests passing

**Next step:** Spec B — PID tracking + real process kill on Abort, cache-tier cost rates, terminal multi-session layout
```

- [ ] **Step 2: Update `docs/claude.md` Pending section**

In `docs/claude.md`, find:
```
## Pending
- PID tracking → real process kill on abort
- Terminal multi-session layout
- Fix cost estimate to use cache-tier rates
```

Replace with:
```
## Pending
- PID tracking → real process kill on abort
- Terminal multi-session layout
- Fix cost estimate to use cache-tier rates
```

(No change — these are still pending from Spec B. The Tile Enhancements are now in Current State.)

Also update the Current State section. Find:
```
- 34/34 tests passing
```
Replace with:
```
- 41/41 tests passing
- Tile enhancements: elapsed time row + usage-limit warning banner per tile
```

- [ ] **Step 3: Commit and push**

```bash
git add docs/checkpoints.md docs/claude.md
git commit -m "docs: tile enhancements checkpoint"
git push
```
