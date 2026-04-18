# Clauditor History Panel — Design Spec
Date: 2026-04-18

## Objective
Add a collapsible bottom panel to the Claude Pulse browser dashboard showing `clauditor` 7-day session history, without disrupting the live tile grid.

---

## 1. Layout

**Collapsible panel, hidden by default.**

- The topbar gains a `▲ HISTORY` toggle button (amber, beside the refresh rate buttons).
- When closed: live tiles fill the full viewport (current behaviour preserved).
- When open: page splits into two scrollable regions:
  - **Top** — live tile grid (scrollable, min-height ~50vh)
  - **Divider** — 1px line with a `▲ HISTORY` label centred on it (click to collapse)
  - **Bottom** — history panel (scrollable, ~40vh)
- Open/closed state persists in `localStorage` key `claudepulse_history_open`.

---

## 2. Data

**Two CLI calls, merged by label+turns:**

```
GET /api/history
  → runs: clauditor sessions --json  (cost, model, cacheRatio)
  → runs: clauditor report --json    (wasteFactor, totalTokens, date, avgCacheRatio)
  → merges on label+turns, returns unified array sorted newest-first
```

Server endpoint: `GET /api/history` — executes both CLI commands via `child_process.exec`, merges results, returns JSON.

Merged row shape:
```ts
{
  label: string          // "LiveVisualUsage (main)"
  date: string           // ISO date from report
  turns: number
  wasteFactor: number    // from report; 1.0 if not in report
  totalTokens: number    // from report
  cacheRatio: number     // avgCacheRatio from report, fallback cacheRatio from sessions
  cost: number           // from sessions; 0 if not matched
  model: string          // from sessions
}
```

---

## 3. Refresh

Tied to the existing topbar refresh mode — no new control:

| Mode | History refresh interval |
|------|--------------------------|
| High | 15s |
| Normal | 30s |
| Low | 60s |
| Paused | no auto-refresh |

`↺ Now` button triggers an immediate history refresh in addition to the tile refresh.

History is fetched by the frontend via `fetch('/api/history')` on a timer (separate from the WebSocket tile loop).

---

## 4. Table Columns & Visual Design

Each row is one session, newest-first. Layout per row:

```
[PROJECT · BRANCH]  [DATE]  [TURNS]  [WASTE]  [TOKENS]  [CACHE%]  [COST]
━━━━━━ waste bar (full width, gradient green→red) ━━━━━━
```

**Turns colour thresholds:**
- `< 20` — dim (`#444466`)
- `20–49` — amber (`#ffaa00`)
- `50–99` — orange (`#ff6622`)
- `100+` — red (`#ff4455`)

**Waste colour thresholds:**
- `< 2x` — green (`#00ff88`)
- `2–3x` — amber (`#ffaa00`)
- `3–5x` — orange (`#ff6622`)
- `≥ 5x` — red (`#ff4455`)

**Waste bar:** `width = min(wasteFactor / 7, 1) * 100%`; gradient `green → red`.

**Footer row:** session count · total tokens · total cost · `N sessions ≥3x` · `N sessions ≥5x`.

---

## 5. Server Changes

- `src/server/index.ts`: add `GET /api/history` endpoint
  - Runs `clauditor sessions --json` and `clauditor report --json` via `exec`
  - Merges on `label + turns`; returns unified array
  - Caches result for 10s to avoid hammering the CLI on rapid refreshes

---

## 6. Frontend Changes

- `src/frontend/browser/index.html`:
  - Add `▲ HISTORY` toggle button to `.topbar-right`
  - Add `#history-panel` section below `#session-grid` (hidden by default)
  - Add CSS for panel, divider, table rows, turn/waste colour classes

- `src/frontend/browser/dashboard.js`:
  - `historyOpen` flag, persisted to `localStorage`
  - `fetchHistory()` — calls `/api/history`, renders rows into `#history-panel`
  - History refresh timer tied to `refreshMode` (15s/30s/60s/none)
  - `↺ Now` button triggers `fetchHistory()` in addition to existing `flushRender()`

---

## 7. Out of Scope

- No per-row expand/collapse
- No sorting controls (always newest-first)
- No project filtering
- No subagent session merging beyond label+turns match
