# Clauditor History Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible bottom panel to the Claude Pulse browser dashboard showing `clauditor` 7-day session history (waste, tokens, cost, cache) fetched from the local CLI.

**Architecture:** A new `GET /api/history` Express endpoint runs `clauditor report --json` and `clauditor sessions --json` via `child_process.exec`, merges them with a pure function in `src/server/historyMerge.ts`, and caches the result 10s. The frontend fetches this endpoint on a timer tied to the existing refresh mode buttons, renders a scrollable table below the tile grid, and persists open/closed state to `localStorage`.

**Tech Stack:** TypeScript, Express, Node `child_process.exec`, vanilla JS/HTML/CSS (no framework), vitest, supertest.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `src/server/historyMerge.ts` | Pure merge function — report[] + sessions[] → `SessionRow[]` sorted newest-first |
| **Create** | `tests/server/historyMerge.test.ts` | Unit tests for merge logic |
| **Modify** | `src/server/index.ts` | Add `GET /api/history` with 10s cache |
| **Modify** | `src/frontend/browser/index.html` | CSS for history panel + `#history-panel` div + divider + HISTORY toggle button |
| **Modify** | `src/frontend/browser/dashboard.js` | `fetchHistory()`, render logic, refresh timer, ↺ Now integration, localStorage toggle |

---

## Task 1: Pure merge function + tests

**Files:**
- Create: `src/server/historyMerge.ts`
- Create: `tests/server/historyMerge.test.ts`

### Background

`clauditor report --json` uses label format `"quick/ProjectName"`.  
`clauditor sessions --json` uses label format `"ProjectName (branch)"`.  
Match key: extract trailing segment from report label + turns vs extract prefix before ` (` from sessions label + turns.

- [ ] **Step 1: Create `src/server/historyMerge.ts`**

```typescript
export interface ReportSession {
  label: string;
  turns: number;
  wasteFactor: number;
  totalTokens: number;
  date: string;
  avgCacheRatio: number;
}

export interface ClauditorSession {
  label: string;
  turns: number;
  cacheRatio: number;
  cost: number;
  model: string;
  lastUpdated: string;
}

export interface SessionRow {
  label: string;
  date: string;
  turns: number;
  wasteFactor: number;
  totalTokens: number;
  cacheRatio: number;
  cost: number;
  model: string;
}

function projectNameFromReport(label: string): string {
  // "quick/ProjectName" → "ProjectName"
  const parts = label.split("/");
  return parts[parts.length - 1].toLowerCase();
}

function projectNameFromSession(label: string): string {
  // "ProjectName (main)" → "projectname"
  return label.replace(/\s*\(.*\)$/, "").trim().toLowerCase();
}

export function mergeHistory(
  report: ReportSession[],
  sessions: ClauditorSession[],
): SessionRow[] {
  const sessionMap = new Map<string, ClauditorSession>();
  for (const s of sessions) {
    const key = `${projectNameFromSession(s.label)}|${s.turns}`;
    sessionMap.set(key, s);
  }

  return report
    .map((r): SessionRow => {
      const key = `${projectNameFromReport(r.label)}|${r.turns}`;
      const s = sessionMap.get(key);
      return {
        label: r.label,
        date: r.date,
        turns: r.turns,
        wasteFactor: r.wasteFactor ?? 1.0,
        totalTokens: r.totalTokens,
        cacheRatio: r.avgCacheRatio ?? s?.cacheRatio ?? 0,
        cost: s?.cost ?? 0,
        model: s?.model ?? "",
      };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
```

- [ ] **Step 2: Create `tests/server/historyMerge.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { mergeHistory, ReportSession, ClauditorSession } from "../../src/server/historyMerge";

const report: ReportSession[] = [
  { label: "quick/Alpha", turns: 50, wasteFactor: 2.5, totalTokens: 500_000, date: "2026-04-18T10:00:00Z", avgCacheRatio: 0.95 },
  { label: "quick/Beta",  turns: 10, wasteFactor: 1.2, totalTokens: 100_000, date: "2026-04-17T10:00:00Z", avgCacheRatio: 0.98 },
];

const sessions: ClauditorSession[] = [
  { label: "Alpha (main)", turns: 50, cacheRatio: 0.94, cost: 5.50, model: "claude-sonnet-4-6", lastUpdated: "2026-04-18T10:00:00Z" },
  { label: "Beta (master)", turns: 10, cacheRatio: 0.97, cost: 1.20, model: "claude-haiku-4-5", lastUpdated: "2026-04-17T10:00:00Z" },
];

describe("mergeHistory", () => {
  it("merges cost and model from sessions by projectName+turns", () => {
    const rows = mergeHistory(report, sessions);
    expect(rows).toHaveLength(2);
    expect(rows[0].cost).toBe(5.50);
    expect(rows[0].model).toBe("claude-sonnet-4-6");
  });

  it("sorts newest-first by date", () => {
    const rows = mergeHistory(report, sessions);
    expect(new Date(rows[0].date).getTime()).toBeGreaterThan(new Date(rows[1].date).getTime());
  });

  it("uses avgCacheRatio from report over sessions cacheRatio", () => {
    const rows = mergeHistory(report, sessions);
    expect(rows[0].cacheRatio).toBe(0.95);
  });

  it("defaults cost to 0 and model to empty string when no session match", () => {
    const rows = mergeHistory(report, []);
    expect(rows[0].cost).toBe(0);
    expect(rows[0].model).toBe("");
  });

  it("defaults wasteFactor to 1.0 when undefined", () => {
    const r: ReportSession[] = [
      { label: "quick/X", turns: 5, wasteFactor: undefined as any, totalTokens: 10_000, date: "2026-04-16T00:00:00Z", avgCacheRatio: 0.9 },
    ];
    const rows = mergeHistory(r, []);
    expect(rows[0].wasteFactor).toBe(1.0);
  });

  it("is case-insensitive on project name matching", () => {
    const r: ReportSession[] = [
      { label: "quick/MYPROJECT", turns: 20, wasteFactor: 2.0, totalTokens: 200_000, date: "2026-04-15T00:00:00Z", avgCacheRatio: 0.9 },
    ];
    const s: ClauditorSession[] = [
      { label: "MyProject (main)", turns: 20, cacheRatio: 0.88, cost: 3.00, model: "claude-sonnet-4-6", lastUpdated: "2026-04-15T00:00:00Z" },
    ];
    const rows = mergeHistory(r, s);
    expect(rows[0].cost).toBe(3.00);
  });
});
```

- [ ] **Step 3: Run tests — expect 5 passing**

```bash
npm test
```

Expected: all 5 new tests pass (28 existing + 5 new = 33 total).

- [ ] **Step 4: Commit**

```bash
git add src/server/historyMerge.ts tests/server/historyMerge.test.ts
git commit -m "feat: historyMerge — pure function merging clauditor report+sessions data"
```

---

## Task 2: `GET /api/history` endpoint

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add the endpoint after the `/abort` route in `src/server/index.ts`**

Add this import at the top of the file (after existing imports):
```typescript
import { mergeHistory, ReportSession, ClauditorSession } from "./historyMerge";
```

Add this block after the `/checkpoint` route:

```typescript
// ── History endpoint ─────────────────────────────────────
let historyCache: { data: unknown; expires: number } | null = null;

function execJson<T>(cmd: string): Promise<T> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout) as T); }
      catch (e) { reject(e); }
    });
  });
}

app.get("/api/history", async (_req: Request, res: Response) => {
  if (historyCache && Date.now() < historyCache.expires) {
    return res.json(historyCache.data);
  }
  try {
    const [report, sessions] = await Promise.all([
      execJson<{ sessions: ReportSession[] }>("clauditor report --json").then(r => r.sessions ?? []),
      execJson<ClauditorSession[]>("clauditor sessions --json"),
    ]);
    const data = mergeHistory(report, sessions);
    historyCache = { data, expires: Date.now() + 10_000 };
    res.json(data);
  } catch (err) {
    log.warn("history fetch failed", { message: (err as Error).message });
    res.status(500).json({ error: "clauditor unavailable" });
  }
});
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 3: Verify endpoint manually**

Start the server (`npm run dev`), then in another terminal:
```bash
curl http://localhost:3001/api/history
```
Expected: JSON array of session rows sorted newest-first.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: GET /api/history — merges clauditor report+sessions, 10s cache"
```

---

## Task 3: HTML — CSS, layout structure, HISTORY toggle button

**Files:**
- Modify: `src/frontend/browser/index.html`

- [ ] **Step 1: Add CSS for history panel**

In `index.html`, add the following CSS block just before the closing `</style>` tag (after the existing `@keyframes blink-banner` rule):

```css
    /* ── History panel ─────────────────────────────────── */
    #history-divider {
      display: none; align-items: center; gap: 12px;
      margin: 16px 0 0; cursor: pointer; user-select: none;
    }
    #history-divider.open { display: flex; }
    .hist-divider-line { flex: 1; height: 1px; background: rgba(255,170,0,0.2); }
    .hist-divider-label {
      font-size: 10px; letter-spacing: 2px; color: rgba(255,170,0,0.6);
      padding: 2px 10px; border: 1px solid rgba(255,170,0,0.25);
      border-radius: 3px; white-space: nowrap;
    }
    #history-divider:hover .hist-divider-label { color: var(--amber); border-color: rgba(255,170,0,0.5); }

    #history-panel {
      display: none; flex-direction: column;
      max-height: 40vh; overflow-y: auto;
      margin-top: 12px; margin-bottom: 20px;
      border: 1px solid rgba(255,170,0,0.15); border-radius: 8px;
      background: var(--bg2);
    }
    #history-panel.open { display: flex; }

    .hist-header {
      display: grid;
      grid-template-columns: 2.5fr 1fr 0.7fr 0.7fr 0.8fr 0.7fr 0.9fr;
      gap: 6px; padding: 6px 14px;
      background: #070713; color: #333355;
      font-size: 8px; letter-spacing: 1.5px;
      border-bottom: 1px solid rgba(255,170,0,0.1);
      position: sticky; top: 0; z-index: 1;
    }

    .hist-row { padding: 7px 14px; border-bottom: 1px solid #0d0d1f; }
    .hist-row:last-child { border-bottom: none; }
    .hist-row-top {
      display: grid;
      grid-template-columns: 2.5fr 1fr 0.7fr 0.7fr 0.8fr 0.7fr 0.9fr;
      gap: 6px; margin-bottom: 4px; align-items: baseline;
    }
    .hist-project { color: var(--cyan); font-size: 10px; }
    .hist-branch   { color: var(--dim); font-size: 9px; }
    .hist-date     { color: var(--dim); font-size: 9px; }
    .hist-cost     { color: var(--purple); font-size: 10px; text-align: right; }

    .hist-bar-track { background: #0d0d1f; border-radius: 2px; height: 3px; margin-bottom: 4px; overflow: hidden; }
    .hist-bar-fill  { height: 100%; border-radius: 2px;
      background: linear-gradient(90deg, var(--green), var(--amber), var(--red));
      transition: width 0.4s ease; }

    .hist-row-bottom {
      display: grid;
      grid-template-columns: 2.5fr 1fr 0.7fr 0.7fr 0.8fr 0.7fr 0.9fr;
      gap: 6px; font-size: 9px; color: var(--dim);
    }
    .hist-turns-low      { color: #444466; }
    .hist-turns-normal   { color: var(--amber); }
    .hist-turns-high     { color: #ff6622; }
    .hist-turns-critical { color: var(--red); font-weight: bold; }
    .hist-waste-good     { color: var(--green); }
    .hist-waste-warn     { color: var(--amber); }
    .hist-waste-high     { color: #ff6622; }
    .hist-waste-critical { color: var(--red); }
    .hist-tokens { color: var(--cyan); }
    .hist-cache  { color: var(--green); }

    .hist-footer {
      padding: 6px 14px; background: #070713;
      display: flex; gap: 20px; flex-wrap: wrap;
      color: #333355; font-size: 9px; letter-spacing: 1px;
      border-top: 1px solid rgba(255,170,0,0.1);
      position: sticky; bottom: 0;
    }
    .hist-footer-tokens { color: var(--cyan); }
    .hist-footer-cost   { color: var(--purple); }
    .hist-footer-warn   { color: var(--amber); }
    .hist-footer-crit   { color: var(--red); }

    .btn-history {
      background: transparent; border: 1px solid rgba(255,170,0,0.3);
      color: rgba(255,170,0,0.7); font-family: var(--font); font-size: 10px;
      letter-spacing: 1px; padding: 3px 9px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
    }
    .btn-history:hover  { border-color: var(--amber); color: var(--amber); }
    .btn-history.active { background: rgba(255,170,0,0.1); border-color: var(--amber); color: var(--amber); }
```

- [ ] **Step 2: Add `▲ HISTORY` button to topbar**

In the `.topbar-right` div, add the HISTORY button just before the connection dot span:

```html
      <button class="btn-history" id="btn-history">▲ HISTORY</button>
```

So the topbar-right becomes:
```html
    <div class="topbar-right">
      <div class="rate-group">
        <span class="rate-label">UPDATE</span>
        <button class="rate-btn" data-rate="high">High</button>
        <button class="rate-btn" data-rate="normal">Normal</button>
        <button class="rate-btn" data-rate="low">Low</button>
        <button class="rate-btn" data-rate="paused">Paused</button>
        <button class="rate-btn refresh-btn" data-rate="refresh">↺ Now</button>
      </div>
      <button class="btn-history" id="btn-history">▲ HISTORY</button>
      <span><span class="conn-dot" id="conn-dot"></span><span id="conn-label">Connecting...</span></span>
      <span id="session-count">0 sessions</span>
      <span id="elapsed">0s</span>
    </div>
```

- [ ] **Step 3: Add divider and panel below `#session-grid`**

Replace the `<div id="session-grid"></div>` block (and the empty-state that follows) with:

```html
  <div id="session-grid"></div>
  <div id="empty-state">
    <div class="empty-icon">⬡</div>
    <div>No sessions yet — start Claude Code with hooks configured</div>
  </div>

  <div id="history-divider">
    <div class="hist-divider-line"></div>
    <span class="hist-divider-label">▲ HISTORY</span>
    <div class="hist-divider-line"></div>
  </div>

  <div id="history-panel">
    <div class="hist-header">
      <span>PROJECT · BRANCH</span><span>DATE</span><span>TURNS</span>
      <span>WASTE</span><span>TOKENS</span><span>CACHE</span><span style="text-align:right">COST</span>
    </div>
    <div id="history-rows"></div>
    <div class="hist-footer" id="history-footer">Loading...</div>
  </div>
```

- [ ] **Step 4: Build to verify no errors**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/browser/index.html
git commit -m "feat: history panel HTML/CSS — collapsible panel, table layout, colour classes"
```

---

## Task 4: JS — `fetchHistory()`, render, toggle

**Files:**
- Modify: `src/frontend/browser/dashboard.js`

- [ ] **Step 1: Add history state + toggle logic at the top of `dashboard.js`**

After the `let pendingAbortId = null;` line, add:

```javascript
// ── History panel ────────────────────────────────────────
let historyOpen = localStorage.getItem("claudepulse_history_open") === "true";
let historyTimer = null;

const HISTORY_INTERVALS = { high: 15000, normal: 45000, low: 90000, paused: null };
```

- [ ] **Step 2: Add `turnClass`, `wasteClass`, `fmtTokensM` helpers**

Add these helpers near the existing format helpers (look for `function fmtInt` or similar):

```javascript
function fmtTokensM(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function turnClass(turns) {
  if (turns < 20)  return "hist-turns-low";
  if (turns < 50)  return "hist-turns-normal";
  if (turns < 100) return "hist-turns-high";
  return "hist-turns-critical";
}

function wasteClass(w) {
  if (w < 2) return "hist-waste-good";
  if (w < 3) return "hist-waste-warn";
  if (w < 5) return "hist-waste-high";
  return "hist-waste-critical";
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseLabel(label) {
  // "quick/ProjectName" → { project: "ProjectName", branch: "" }
  // "ProjectName (main)" → { project: "ProjectName", branch: "main" }
  const slashMatch = label.match(/^[^/]+\/(.+)$/);
  if (slashMatch) return { project: slashMatch[1], branch: "" };
  const parenMatch = label.match(/^(.+?)\s*\((.+)\)$/);
  if (parenMatch) return { project: parenMatch[1], branch: parenMatch[2] };
  return { project: label, branch: "" };
}
```

- [ ] **Step 3: Add `renderHistoryRows(rows)` function**

```javascript
function renderHistoryRows(rows) {
  const container = document.getElementById("history-rows");
  const footer    = document.getElementById("history-footer");
  if (!container || !footer) return;

  if (!rows || rows.length === 0) {
    container.innerHTML = '<div style="padding:14px;color:#444466;font-size:10px;text-align:center">No sessions in the last 7 days</div>';
    footer.textContent = "—";
    return;
  }

  let totalTokens = 0, totalCost = 0, warn3x = 0, crit5x = 0;

  container.innerHTML = rows.map(r => {
    totalTokens += r.totalTokens || 0;
    totalCost   += r.cost        || 0;
    if (r.wasteFactor >= 5) crit5x++;
    else if (r.wasteFactor >= 3) warn3x++;

    const { project, branch } = parseLabel(r.label);
    const barW  = Math.min((r.wasteFactor || 1) / 7, 1) * 100;
    const tCls  = turnClass(r.turns);
    const wCls  = wasteClass(r.wasteFactor);
    const cache = r.cacheRatio ? Math.round(r.cacheRatio * 100) + "%" : "—";
    const cost  = r.cost ? "$" + r.cost.toFixed(2) : "—";

    return `<div class="hist-row">
      <div class="hist-row-top">
        <span class="hist-project">${project}${branch ? ` <span class="hist-branch">${branch}</span>` : ""}</span>
        <span class="hist-date">${fmtDate(r.date)}</span>
        <span class="${tCls}">${r.turns}</span>
        <span class="${wCls}">${(r.wasteFactor || 1).toFixed(1)}x</span>
        <span class="hist-tokens">${fmtTokensM(r.totalTokens || 0)}</span>
        <span class="hist-cache">${cache}</span>
        <span class="hist-cost">${cost}</span>
      </div>
      <div class="hist-bar-track">
        <div class="hist-bar-fill" style="width:${barW.toFixed(1)}%"></div>
      </div>
    </div>`;
  }).join("");

  const parts = [
    `${rows.length} sessions`,
    `<span class="hist-footer-tokens">${fmtTokensM(totalTokens)} tokens</span>`,
    totalCost > 0 ? `<span class="hist-footer-cost">$${totalCost.toFixed(2)}</span>` : null,
    warn3x > 0   ? `<span class="hist-footer-warn">${warn3x} ≥3x waste</span>` : null,
    crit5x > 0   ? `<span class="hist-footer-crit">${crit5x} ≥5x waste</span>` : null,
  ].filter(Boolean);
  footer.innerHTML = parts.join(" · ");
}
```

- [ ] **Step 4: Add `fetchHistory()` and `setHistoryOpen()` functions**

```javascript
function fetchHistory() {
  if (!historyOpen) return;
  fetch("/api/history")
    .then(r => r.json())
    .then(renderHistoryRows)
    .catch(() => {
      const footer = document.getElementById("history-footer");
      if (footer) footer.textContent = "clauditor unavailable";
    });
}

function setHistoryOpen(open) {
  historyOpen = open;
  localStorage.setItem("claudepulse_history_open", String(open));

  const panel   = document.getElementById("history-panel");
  const divider = document.getElementById("history-divider");
  const btn     = document.getElementById("btn-history");

  panel  ?.classList.toggle("open", open);
  divider?.classList.toggle("open", open);
  btn    ?.classList.toggle("active", open);
  btn && (btn.textContent = open ? "▼ HISTORY" : "▲ HISTORY");

  if (open) fetchHistory();
}
```

- [ ] **Step 5: Wire up the toggle button and history refresh timer**

In the `connect()` or init section (look for where `setRefreshMode` is called or the `DOMContentLoaded` / bottom of file setup), add the following initialisation block. Place it just before the `connect()` call at the bottom of the file:

```javascript
// History toggle
document.getElementById("btn-history")?.addEventListener("click", () => {
  setHistoryOpen(!historyOpen);
});
document.getElementById("history-divider")?.addEventListener("click", () => {
  setHistoryOpen(false);
});

// Restore persisted open state
if (historyOpen) setHistoryOpen(true);
```

- [ ] **Step 6: Hook `fetchHistory` into `setRefreshMode` and `↺ Now`**

In the existing `setRefreshMode(mode)` function, after the line `if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }`, update the function to also manage the history timer:

```javascript
function setRefreshMode(mode) {
  refreshMode = mode;
  document.querySelectorAll(".rate-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.rate === mode);
  });
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
  if (mode !== "paused") {
    refreshTimer = setInterval(flushRender, REFRESH_INTERVALS[mode]);
    const hi = HISTORY_INTERVALS[mode];
    if (hi) historyTimer = setInterval(fetchHistory, hi);
  }
}
```

Find the existing `↺ Now` button handler (look for `data-rate="refresh"` in the click listener near `setRefreshMode`) and add `fetchHistory()` to it:

```javascript
  } else if (rate === "refresh") {
    flushRender();
    fetchHistory();
  }
```

The existing handler should look something like:
```javascript
document.querySelectorAll(".rate-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const rate = btn.dataset.rate;
    if (rate === "refresh") {
      flushRender();
      fetchHistory();        // ← add this line
    } else {
      setRefreshMode(rate);
    }
  });
});
```

- [ ] **Step 7: Build and verify**

```bash
npm run build
```

Expected: clean build, no TypeScript errors, frontend files copied.

- [ ] **Step 8: Manual smoke test**
  1. Run `npm run dev`, open `http://localhost:3001/dashboard`
  2. Click `▲ HISTORY` — panel opens, rows appear, footer shows totals
  3. Click `▼ HISTORY` or the divider — panel collapses
  4. Reload — panel state restores from localStorage
  5. Click `↺ Now` while panel is open — history refreshes (check Network tab)
  6. Switch to `Paused` mode — history timer stops

- [ ] **Step 9: Commit**

```bash
git add src/frontend/browser/dashboard.js
git commit -m "feat: history panel JS — fetchHistory, render, toggle, refresh timer integration"
```

---

## Task 5: Final build, full test run, push

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass (28 original + 5 new from Task 1 = 33 total).

- [ ] **Step 2: Build final dist**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 4: Update checkpoint docs**

In `docs/checkpoints.md`, move current checkpoint to HISTORY and add:

```markdown
## CURRENT CHECKPOINT

### 2026-04-18 — Clauditor History Panel

**Completed:**
- Collapsible `▲ HISTORY` panel below live tiles
- `GET /api/history` endpoint: merges `clauditor report --json` + `clauditor sessions --json`, 10s cache
- Flat chronological table: project, date, turns (colour-coded), waste (colour-coded), tokens, cache%, cost
- Refresh tied to topbar mode (High=15s, Normal=45s, Low=90s, Paused=off); ↺ Now triggers immediate refresh
- localStorage persistence for open/closed state
- 33/33 tests passing

**Next step:** PID tracking → real process kill on Abort
```

In `docs/claude.md`, update the Pending list:
- Remove the clauditor bottom panel entry
- Keep: PID tracking, terminal multi-session, fix cost estimate

```bash
git add docs/checkpoints.md docs/claude.md
git commit -m "docs: checkpoint — clauditor history panel complete"
git push origin main
```
