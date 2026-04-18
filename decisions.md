# LiveVisualUsage — Design Decisions

Captured during brainstorming session (2026-04-17). Revisit here if you need to change direction.

---

## Q1: Dashboard visual style?
**Options:** Dark Terminal / Neon Cyber / Clean Light
**Decision: Neon Cyber**
Deep black background with glowing cyan/purple/green accents. High visual impact, sci-fi feel. Used for the browser dashboard theme.

---

## Q2: Backend language/runtime?
**Options:** Node.js+TypeScript / Python / Go
**Decision: TypeScript / Node.js**
Natural fit for WebSocket + real-time. Same ecosystem as Claude Code CLI. Frontend kept separate so both browser and terminal share the same live telemetry stream.

---

## Q3: How does the monitor get data from Claude Code?
**Options:**
- A. Claude Code hooks only
- B. OpenTelemetry only
- C. Both

**Decision: Both (C)**
Claude Code hooks = primary real-time event stream (configured via `.claude/settings.json` PostToolUse/Stop/Notification hooks that POST to the local server).
OpenTelemetry = supplementary metrics source when available.
Backend merges both into a single live session stream. Prefer native telemetry over terminal scraping.

---

## Q4: Terminal dashboard library?
**Options:** blessed/blessed-contrib / ink / custom ANSI
**Decision: blessed-contrib**
Proper live monitoring screen with charts, status panels, and alerts. Browser dashboard remains separate — both connect to the same WebSocket backend.

---

## Q5: Architecture pattern?
**Options:**
- A. Single Process Hub (simplest)
- B. Adapter-Based Pipeline (recommended)
- C. Multi-process Microservices (overkill)

**Decision: B — Adapter-Based Pipeline**
Central `TelemetryServer` owns a `SessionStore` and WebSocket broadcaster. Source adapters (`HooksAdapter`, `OtelAdapter`) feed in via typed interfaces. Both browser and terminal connect as WebSocket clients. Chosen because it matches the modularity/loose-coupling requirements from InstructionList.txt. New metric source = one new adapter file + one config line.

---

## Q6: Component map — approved architecture (Section 1)?
**Presented:**
```
Claude Code CLI
   ├── hooks → POST /hook
   └── OTEL  → POST /otel
                    ▼
             TelemetryServer
             ┌──────────────────────────────┐
             │ HooksAdapter                 │
             │ OtelAdapter                  │
             │ EventNormalizer              │
             │ SessionStore                 │
             │ EventBus / StateEmitter      │
             │ WS Broadcaster               │
             └──────────────────────────────┘
                    ▼                ▼
         Browser Dashboard   Terminal Dashboard
```
**Decision: Approved with refinement**
User added `EventNormalizer` (normalizes raw hook/OTEL events into a common schema before SessionStore) and `EventBus / StateEmitter` (internal pub/sub so adapters don't directly call the broadcaster — decoupled via events).

---

## Q7: Data flow + session model — approved (Section 2)?
**Decision: Approved with refinements**
- `SessionStore` emits `checkpoint_suggested` (soft threshold) and `checkpoint_mandatory` (hard threshold) separately
- WS Broadcaster sends **full state snapshot** only on new client connect or after session reset
- During active mode (1s tick): send **deltas** only
- During idle mode (5s tick): send smaller periodic delta updates
- `session_start` and `session_end` are explicit first-class event types in the NormalizedEvent model
- Both dashboards consume the identical JSON stream regardless of view

---

## Q8: Frontend layout — approved (Section 3)?
**Options:** A (Grid + Sparkline) / B (Hero + Sidebar) / C (Hybrid)
**Decision: C — Hybrid**
- Hero total token count (large) with IN / OUT / LEFT sub-labels directly underneath
- Threshold progress bar (gradient green→cyan→purple) showing % used
- Gradient-filled area chart for turn-by-turn burn history
- Sidebar: COST, TURNS, BURN/SEC, ETA, explicit GREEN/YELLOW/RED alert box
- Full-width alert bar: capacity status (absolute remaining) + checkpoint countdown
- Terminal: 6-box grid (TOK IN, TOK OUT, TOTAL, COST, TURNS, ETA) + bar chart + alert line

---

## Q9: Layout comparison — total vs in/out tokens, and what each layout was missing?
**Question:** Layout A shows tokens_in and tokens_out separately. Layout B shows tokens_total as hero. Which is better?
**Analysis:**
- A has but B lacks: separate IN/OUT counts (useful — output costs ~5x input on Claude), explicit GREEN/YELLOW/RED text alert label, absolute remaining capacity as a number
- B has but A lacks: hero total with threshold progress bar (instant capacity awareness), filled area chart (trend more readable), checkpoint countdown in alert bar
**Decision: Hybrid C** — combines both. Hero total with IN/OUT/LEFT as sub-labels underneath, progress bar, area chart, explicit alert label, checkpoint countdown.

---

## Q10: Error handling (Section 4) + Testing strategy (Section 5) — approved with tweaks?
**Decision: Approved with the following clarifications/additions**

**Error handling (exact):**
- Hook receiver unreachable: silent fail, no Claude Code impact
- OTEL unavailable: OtelAdapter warns at startup and disables itself — system runs on hooks only
- WS client disconnect: client removed, full state snapshot re-sent on reconnect
- Out-of-order events: accepted within a 5-second window **within the same session only** — late events outside the window are dropped with a log. After server restart, all state resets and everything begins as a new session_start.
- Server crash/restart: memory-only state, clients reconnect and receive a fresh session_start event

**Testing strategy (exact):**
- SessionStore: pure unit tests — feed NormalizedEvent in, assert state output
- EventNormalizer: unit tests with raw hook and OTEL payloads, assert correct NormalizedEvent shape
- HooksAdapter + OtelAdapter: integration tests via real HTTP endpoints (supertest)
- WS Broadcaster: real WebSocket client — connect, assert full snapshot, assert deltas after events
- **Checkpoint logic (clarified):** Token-based and turn-based thresholds are fully independent — meeting either is sufficient to emit its event. Four separate triggers:
  - `tokens >= 70% of token_threshold` → `checkpoint_suggested`
  - `tokens >= 90% of token_threshold` → `checkpoint_mandatory`
  - `turns >= 10` → `checkpoint_suggested`
  - `turns >= turn_threshold (default 20)` → `checkpoint_mandatory`
  Tested in four independent unit test assertions — no condition depends on another.
- No E2E tests for MVP

---

---

## Q11: Bottom panel layout — collapsible vs fixed vs draggable?
**Options:**
- A. Fixed Split 60/40 — always visible, no interaction
- B. Collapsible Panel — hidden by default, toggle button in topbar
- C. Draggable Divider — resizable split, position saved in localStorage

**Decision: B — Collapsible Panel**
History panel hidden by default so live tiles get full viewport. A "▲ HISTORY" toggle button in the topbar opens/collapses it. Keeps the dashboard clean for users who don't need historical view constantly.

---

## Q12: History table row style — grouped vs compact vs flat?
**Options:**
- A. Compact table sorted by waste factor, color-coded rows
- B. Grouped by project, expandable sessions
- C. Flat chronological newest-first with mini waste bar

**Decision: C — Flat chronological**
Newest sessions at top. Mini waste bar per row. User also requested: show token count per row, color-code turns by severity (low/normal/high/critical).

---

## Q13: History table row design — columns and turn color thresholds?
**Decision: Approved (C-v2 mockup)**
Columns: PROJECT · BRANCH, DATE, TURNS (color-coded), WASTE (color-coded), TOKENS, CACHE%, COST
Turn thresholds: `<20` dim · `20–49` amber · `50–99` orange · `100+` red
Waste bar: gradient green→red scaled to wasteFactor, shown below project name
Summary footer: session count, total tokens, total cost, waste warning counts
Data source: merge `clauditor report --json` (waste, tokens, cache) + `clauditor sessions --json` (cost, model) — matched by label+turns

---

## Q14: History panel refresh rate — separate control or tied to topbar buttons?
**Decision: Tied to existing topbar refresh rate buttons**
No new UI. History panel inherits the current refresh mode:
High=15s · Normal=30s · Low=60s · Paused=no refresh
Paused still allows manual refresh via the existing "↺ Now" button.

---

## Q15: Tile enhancements layout — time row + warning banner placement?
**Options:**
- A. Dedicated time row below header + blinking warning banner above footer
- B. Elapsed time sub-text under session ID + left-border strip at bottom
- C. Extra stat cells in 7-column grid + warning replaces alert pill

**Decision: A — Dedicated time row + warning banner**
Elapsed time (session age + project age) gets its own slim row immediately below the tile header — always visible. Usage-limit warnings from Claude Code Notification hooks appear as a blinking amber/red banner above the tile footer, only when triggered.

---

## Q16: Project age definition — what clock does the tile show?
**Options:**
- A. Session elapsed only — one timer for current Claude Code window
- B. First-ever session for this project — persisted across restarts
- C. Oldest JSONL file on disk

**Decision: B — First-ever session (persisted)**
"Project age" = how long ago Claude Pulse first saw any activity for this project directory. Stored as `project_first_seen_ms` in persistent session state. Even if current session started today, the tile can show "5d 3h" if the project was first tracked 5 days ago.

---

## Q17: Usage warning persistence — how long does the banner stay in the tile?
**Options:**
- A. Auto-clear on next hook event
- B. Sticky until session ends or new session starts
- C. Fixed timeout (e.g. 5 min)

**Decision: B — Sticky until new session**
Warning stays visible for the lifetime of the session once triggered. High-signal info shouldn't auto-dismiss just because Claude is busy.
Percentage shown must match exactly what Claude Code's CLI reported — taken verbatim from the Notification hook `message` field, not computed from our own token counts.
