# Tile Enhancements — Elapsed Time + Usage Warnings

**Goal:** Add session/project elapsed time and Claude Code usage-limit warnings to each live monitoring tile.

**Architecture:** Three isolated additions — a frontend-only time row, a backend notification extractor + frontend warning banner, and a persisted per-project first-seen timestamp. No new endpoints, no new config keys. `SessionState` gains three fields; `data/sessions.json` gains one top-level key.

**Tech Stack:** TypeScript (backend), vanilla JS + HTML (browser frontend), existing WebSocket pipeline.

---

## 1. Data Model Changes

### `src/types.ts`

Add to `SessionState`:
```typescript
last_notification?: string;       // raw message from Notification hook, if usage-limit related
notification_level?: "warn" | "critical"; // "warn" = ≥70%, "critical" = ≥90%
project_first_seen_ms?: number;   // epoch ms when Claude Pulse first saw any event for this project
```

### `data/sessions.json`

Add a top-level key alongside the `sessions` array:
```json
{
  "sessions": [...],
  "projectFirstSeen": { "LiveVisualUsage": 1713400000000, "OtherProject": 1713200000000 }
}
```

---

## 2. Backend — Notification Extraction

### `src/monitor/EventNormalizer.ts`

No structural changes. The `Notification` hook payload's `message` field is already captured in `metadata` (the full raw payload is passed through). No changes needed here — SessionStore reads it from `metadata`.

### `src/monitor/SessionStore.ts`

In the `apply()` method, add a branch for `event.type === "notification"`:
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

Add helper (module-level, not a class method):
```typescript
function parseNotificationPct(msg: string): number {
  const m = msg.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) : 70;
}
```

Clear `last_notification` and `notification_level` on `session_start` reset (already handled — `makeEmptyState` returns undefined for optional fields).

### `src/monitor/SessionRegistry.ts`

Add `projectFirstSeen: Map<string, number>` field, loaded from and saved to `data/sessions.json`.

```typescript
private projectFirstSeen = new Map<string, number>();
```

In `loadPersisted()`, load the map from disk using the updated `loadPersistedData()`:
```typescript
const { sessions, projectFirstSeen } = loadPersistedData();
for (const [k, v] of Object.entries(projectFirstSeen)) {
  this.projectFirstSeen.set(k, v);
}
// then restore sessions from `sessions` array as before
```

In `route()`, when creating a new SessionStore, assign `project_first_seen_ms`:
```typescript
if (!this.projectFirstSeen.has(name)) {
  this.projectFirstSeen.set(name, Date.now());
  this.scheduleSave(); // reuses existing debounced save
}
const firstSeen = this.projectFirstSeen.get(name)!;
// pass firstSeen into new SessionStore so it can stamp the initial state
```

In `destroy()` and `scheduleSave()`, pass `Object.fromEntries(this.projectFirstSeen)` as the second argument to `persistSessions()`.

Pass `project_first_seen_ms` into the session state on creation:
```typescript
const store = new SessionStore(this.cfg, id, name);
store.setProjectFirstSeen(firstSeen);
```

Add `setProjectFirstSeen(ms: number)` to `SessionStore`:
```typescript
setProjectFirstSeen(ms: number): void {
  this.state.project_first_seen_ms = ms;
}
```

Also call `setProjectFirstSeen` when restoring persisted sessions (carry over from loaded state — it's already in `SessionState` so it will round-trip via JSON).

### `src/monitor/StateStore.ts`

Extend the existing `loadPersistedSessions` and `persistSessions` functions to also carry `projectFirstSeen` in the same JSON file — no separate file, no split-write race.

Change the persisted format from:
```json
{ "sessions": [...] }
```
to:
```json
{ "sessions": [...], "projectFirstSeen": { "LiveVisualUsage": 1713400000000 } }
```

Update `loadPersistedSessions` to return `projectFirstSeen` alongside sessions:
```typescript
export function loadPersistedData(): {
  sessions: SessionState[];
  projectFirstSeen: Record<string, number>;
} {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
    return {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      projectFirstSeen: (raw.projectFirstSeen as Record<string, number>) ?? {},
    };
  } catch {
    return { sessions: [], projectFirstSeen: {} };
  }
}
```

Update `persistSessions` to accept and write `projectFirstSeen`:
```typescript
export function persistSessions(
  sessions: SessionState[],
  projectFirstSeen: Record<string, number>,
): void {
  try {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({ sessions, projectFirstSeen }, null, 2), "utf8");
  } catch {}
}
```

**Key:** `projectFirstSeen` map uses the project name exactly as returned by `extractProjectName()` (last path segment of `cwd`, no lowercasing). This matches the value stored in `SessionState.project_name`.

---

## 3. Frontend — Time Row

### `src/frontend/browser/index.html`

Add CSS for the time row (inside `<style>`):
```css
.tile-time-row {
  display: flex; gap: 16px; align-items: center;
  font-size: 9px; letter-spacing: 1px; color: rgba(255,255,255,0.3);
  border-top: 1px solid rgba(0,255,240,0.07); padding-top: 6px;
}
.tile-time-row .t-elapsed-val { color: rgba(0,255,240,0.6); }
.tile-time-row .t-sep { color: rgba(255,255,255,0.12); }
```

In the tile template in `dashboard.js`, add the time row div immediately after the `tile-header` div:
```html
<div class="tile-time-row">
  ⏱ session <span class="t-elapsed-val" data-elapsed-start></span>
  <span class="t-sep">|</span>
  project <span class="t-elapsed-val" data-elapsed-project></span>
</div>
```

### `src/frontend/browser/dashboard.js`

Add `fmtElapsed(ms)` helper:
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

Add a single `setInterval` (1000ms) that iterates all rendered tiles and updates both `data-elapsed-start` and `data-elapsed-project` spans. Store `started_at` and `project_first_seen_ms` as `data-*` attributes on the tile element when first rendered, so the ticker doesn't need to touch the sessions map:

```javascript
// On tile render/update:
el.dataset.startedAt = session.started_at;
el.dataset.projectFirstSeen = session.project_first_seen_ms ?? session.started_at;

// Ticker (runs every 1s):
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('.tile').forEach(el => {
    const sessEl = el.querySelector('[data-elapsed-start]');
    const projEl = el.querySelector('[data-elapsed-project]');
    if (sessEl && el.dataset.startedAt)
      sessEl.textContent = fmtElapsed(now - Number(el.dataset.startedAt));
    if (projEl && el.dataset.projectFirstSeen)
      projEl.textContent = fmtElapsed(now - Number(el.dataset.projectFirstSeen));
  });
}, 1000);
```

---

## 4. Frontend — Warning Banner

### `src/frontend/browser/index.html`

Add CSS for the warning banner:
```css
.tile-warn-banner {
  display: none; align-items: center; gap: 8px;
  border-radius: 5px; padding: 6px 10px;
  font-size: 9px; letter-spacing: 1px; font-weight: bold;
  animation: pulse 1s ease-in-out infinite;
}
.tile-warn-banner.open { display: flex; }
.tile-warn-banner.warn {
  background: rgba(255,170,0,0.08); border: 1px solid rgba(255,170,0,0.35);
  color: #ffaa00;
}
.tile-warn-banner.critical {
  background: rgba(255,68,85,0.08); border: 1px solid rgba(255,68,85,0.4);
  color: #ff4455;
}
.tile-warn-icon { font-size: 11px; }
.tile-warn-msg  { flex: 1; }
```

In the tile template, add the banner div just above the `tile-footer`:
```html
<div class="tile-warn-banner">
  <span class="tile-warn-icon">⚠</span>
  <span class="tile-warn-msg"></span>
</div>
```

### `src/frontend/browser/dashboard.js`

In the session update/render function, after rendering all fields, update the warning banner:
```javascript
const banner = el.querySelector('.tile-warn-banner');
if (session.last_notification) {
  banner.classList.add('open');
  banner.classList.toggle('warn', session.notification_level === 'warn');
  banner.classList.toggle('critical', session.notification_level === 'critical');
  banner.querySelector('.tile-warn-msg').textContent = session.last_notification;
} else {
  banner.classList.remove('open', 'warn', 'critical');
}
```

---

## 5. Tests

### `tests/monitor/sessionStore.test.ts` (extend existing)

Add test cases:
- Notification event with `"78% of your daily limit"` message → `last_notification` set, `notification_level === "warn"`
- Notification event with `"92% of your daily limit"` → `notification_level === "critical"`
- Notification event without limit keywords → `last_notification` unchanged
- `session_start` after notification → `last_notification` cleared (undefined)

### `tests/monitor/sessionRegistry.test.ts` (extend existing)

Add test cases:
- First event for new project → `project_first_seen_ms` set to ~`Date.now()`
- Second session for same project → `project_first_seen_ms` same as first session's value (not overwritten)
- Persisted sessions restored → `project_first_seen_ms` carried over from saved state

---

## 6. Scope Boundary

This spec covers **Spec A only**:
- Elapsed time row in tiles
- Usage-limit warning banner in tiles
- `project_first_seen_ms` persistence

**Not in scope (Spec B):**
- PID tracking / real process kill on Abort
- Terminal multi-session layout
- Cache-tier cost rate fix
