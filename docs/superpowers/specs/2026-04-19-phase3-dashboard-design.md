# Phase 3 Dashboard Design
_Written 2026-04-19. Approved by user before implementation._

---

## Scope

Incremental upgrades to the existing Claude Pulse browser dashboard. Architecture unchanged. Data sources unchanged (hooks + JSONL journal). No process scanning.

**Already complete — do not re-implement:**
- Multi-session tile grid (`#session-grid`, auto-fill)
- All lifecycle state badges (`not_launched` → `closed`)
- Elapsed time row per tile (session + project)
- Token/cost/turns/tools display
- Model breakdown rows (SONNET/OPUS/HAIKU with IN/OUT/cost)
- Abort button with confirmation overlay
- Session auto-registration + stale marking
- History panel (Clauditor)

**Gaps this spec closes — 4 targeted changes:**

1. Live usage % alert card + header badge
2. 5-band usage warning visual system (70 / 80 / 90 / 99 / exceeded)
3. Graph history records model per point; tooltip shows model
4. Reset time + /upgrade parsed from notification into structured display

---

## 1. Live Usage % Alert Card + Header Badge

### Activation
Alert card and header badge appear whenever the tile's computed `pct ≥ 70`. They are **not** gated on `last_notification` — they show as soon as the weighted budget crosses the threshold.

```
pct = Math.round((s.weighted_tokens_total ?? s.tokens_total) / THRESHOLD * 100)
```

### Live update
`pct` is recomputed on every `updateTile()` call. The displayed percentage updates live: 70 → 71 → … → 99 → 100. No caching, no snapshot.

### Header badge (NEW)
Added to `.tile-badges` alongside the lifecycle badge:
```html
<span class="badge-alert" data-field="alert-badge">⚠ 86%</span>
```
- Visible only when `pct ≥ 70`; hidden otherwise
- Blinks at 0.75 s (same animation as alert card)
- Text: `⚠ {pct}%`

### Alert card (REPLACES existing `.tile-warn-banner`)
The current plain blinking banner strip is replaced by the structured alert card. Position: between stats-row and tile-footer.

```
┌─────────────────────────────────────────────┐
│ ⚠  USAGE LIMIT WARNING                      │
│ USED          RESETS                         │
│ 86%           1am SGT                        │
│ ⬡ /upgrade to keep using Claude Code         │
└─────────────────────────────────────────────┘
```

**Fields:**
- `USED` — always shown; value = live `pct%`
- `RESETS` — shown only if reset time parsed from `last_notification`; format `Xam/pm TZ`
- `/upgrade line` — shown only if `last_notification` contains "upgrade"

**Parsing `last_notification`** (frontend, in `updateTile`):
```js
// Extract reset time
const resetMatch = s.last_notification?.match(/resets\s+(\d+[ap]m)(?:\s*\(([^)]+)\))?/i);
const resetStr = resetMatch ? resetMatch[1] + (resetMatch[2] ? ' ' + resetMatch[2] : '') : null;

// Detect upgrade prompt
const hasUpgrade = s.last_notification?.toLowerCase().includes('upgrade') ?? false;
```

**Visibility:** card shown when `pct ≥ 70`. RESETS line and /upgrade line shown only when parsed from notification.

**Animation:** `animation: pulse 0.8s ease-in-out infinite` (same keyframe already in CSS).

---

## 2. Five-Band Warning System

### Bands
| Band | Threshold | Tile border | Badge color | Behaviour |
|------|-----------|-------------|-------------|-----------|
| normal | < 70% | cyan dim | — | — |
| warn-70 | ≥ 70% | amber | amber alert badge | alert card appears |
| warn-80 | ≥ 80% | amber bright | amber | same |
| warn-90 | ≥ 90% | red | red alert badge | tile red glow |
| warn-99 | ≥ 99% | red bright | red, faster blink | tile intense glow |
| exceeded | = 100% | red + lock | red `⚠ MAX` | lock icon in badge |

### Implementation
Computed in `updateTile()` from `pct`:
```js
function usageBand(pct) {
  if (pct >= 100) return 'exceeded';
  if (pct >= 99)  return 'warn-99';
  if (pct >= 90)  return 'warn-90';
  if (pct >= 80)  return 'warn-80';
  if (pct >= 70)  return 'warn-70';
  return 'normal';
}
```

Tile gets a data-band attribute: `tile.dataset.band = band`. CSS selectors drive all visual changes:
```css
.tile[data-band="warn-70"]  { border-color: rgba(255,170,0,0.35); }
.tile[data-band="warn-80"]  { border-color: rgba(255,170,0,0.55); }
.tile[data-band="warn-90"]  { border-color: rgba(255,68,85,0.4); box-shadow: 0 0 16px rgba(255,68,85,0.12); }
.tile[data-band="warn-99"]  { border-color: rgba(255,68,85,0.7); box-shadow: 0 0 24px rgba(255,68,85,0.22); animation: tile-pulse 0.7s ease-in-out infinite; }
.tile[data-band="exceeded"] { border-color: var(--red); box-shadow: 0 0 32px rgba(255,68,85,0.3); animation: tile-pulse 0.5s ease-in-out infinite; }
```

Alert badge color follows band: amber for warn-70/80, red for warn-90/99/exceeded.
Badge text: `⚠ {pct}%` for warn-70 through warn-99; `⚠ MAX` for exceeded.

**Note:** `alert_level` (green/yellow/red) on `SessionState` drives the existing footer alert pill unchanged. The new band system is frontend-only, computed from `pct`.

**Migration — remove old class-based tile borders:** The existing `updateTile` code sets `.alert-yellow` / `.alert-red` classes on the tile element. These conflict with the new `data-band` CSS. Replace that block:

```js
// REMOVE:
tile.className = "tile" +
  (s.is_stale ? " stale" : "") +
  (level === "yellow" ? " alert-yellow" : "") +
  (level === "red" ? " alert-red" : "");

// REPLACE WITH:
tile.className = "tile" + (s.is_stale ? " stale" : "");
tile.dataset.band = usageBand(pct);
```

The `.alert-yellow` and `.alert-red` CSS rules in `index.html` can be left in place (they become dead code) or removed — either is fine.

---

## 3. Model-Aware Graph Tooltip

### `recordHistory` change
Add `model` field to each history point:
```js
hist.push({
  tokens, toolCalls,
  tokensDelta, toolsDelta,
  model: s.model_last ?? null,   // NEW
  ts: Date.now(),
});
```

### Tooltip change
`wireChartTooltip` currently shows:
```
Apr 19  10:23:45
+12,400 tokens burned
```

New format:
```
Apr 19  10:23:45
+12,400 tokens burned
sonnet
```

Model line shown only when `pt.model` is non-null. Uses `shortModelName(pt.model)` (already defined in `dashboard.js`).

**CSS addition** for tooltip model line:
```css
#chart-tooltip .tt-model { color: rgba(191,0,255,0.8); font-size: 9px; margin-top: 1px; }
```

HTML in `index.html`:
```html
<div id="chart-tooltip">
  <div class="tt-time" id="tt-time"></div>
  <div class="tt-val"  id="tt-val"></div>
  <div class="tt-model" id="tt-model"></div>   <!-- NEW -->
</div>
```

---

## 4. Files Changed

| File | Change |
|------|--------|
| `src/frontend/browser/index.html` | Add `.badge-alert` CSS, 5-band CSS, `.alert-card` CSS, `tt-model` CSS + DOM element, `data-field="alert-badge"` in tile template, replace `.tile-warn-banner` with `.alert-card` markup |
| `src/frontend/browser/dashboard.js` | `recordHistory`: add `model` field; `updateTile`: compute `pct` + `band`, update alert badge, render alert card with parsed RESETS+upgrade, hide old warn-banner; `wireChartTooltip`: show model line |

**No backend changes required.** All data needed (`weighted_tokens_total`, `last_notification`, `model_last`) is already on `SessionState` and sent via WebSocket.

---

## 5. Tile HTML Template Delta

Remove:
```html
<div class="tile-warn-banner">
  <span class="tile-warn-icon">⚠</span>
  <span class="tile-warn-msg"></span>
</div>
```

Add in `buildTile` — header badges area gets alert badge slot:
```html
<div class="tile-badges">
  <span class="badge" data-field="lifecycle"></span>
  <span class="badge" data-field="stale" style="display:none">STALE</span>
  <span class="badge-alert" data-field="alert-badge" style="display:none"></span>  <!-- NEW -->
</div>
```

Add after stats-row, before footer:
```html
<div class="alert-card" data-field="alert-card" style="display:none">
  <div class="ac-header">
    <span class="ac-icon">⚠</span>
    <span class="ac-title">USAGE LIMIT WARNING</span>
  </div>
  <div class="ac-fields">
    <div class="ac-field"><div class="ac-lbl">USED</div><div class="ac-val pct" data-field="ac-pct">—</div></div>
    <div class="ac-field ac-reset-wrap" style="display:none"><div class="ac-lbl">RESETS</div><div class="ac-val time" data-field="ac-reset">—</div></div>
  </div>
  <div class="ac-upgrade" data-field="ac-upgrade" style="display:none">⬡ /upgrade to keep using Claude Code</div>
</div>
```

---

## 6. Testing Checklist

- [ ] At pct < 70: alert card hidden, no header badge, tile border cyan-dim
- [ ] At pct = 70: alert card visible, header badge `⚠ 70%` amber, tile amber border
- [ ] At pct = 80: badge `⚠ 80%` brighter amber border
- [ ] At pct = 90: badge red, tile red glow
- [ ] At pct = 99: tile intense glow, badge faster blink
- [ ] At pct = 100: badge shows `⚠ MAX`, lock styling
- [ ] pct increments live (each session_updated recalculates)
- [ ] RESETS line shows only when `last_notification` contains reset time
- [ ] /upgrade line shows only when notification contains "upgrade"
- [ ] Graph tooltip shows model line for points where model is known
- [ ] Graph tooltip shows no model line when model is null
- [ ] All existing tests still pass (80/80)
