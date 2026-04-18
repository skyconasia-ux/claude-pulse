# PID Tracking + Real Process Kill on Abort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks Abort on a tile, actually kill the Claude Code process, not just mark it stopped in memory.

**Architecture:** The PowerShell hook script is modified to include its parent process ID (the Claude Code Node.js process) in every payload. The server stores this PID on `SessionState`. The `/abort/:sessionId` endpoint reads it and calls `process.kill(pid)` before marking the session stopped.

**Tech Stack:** TypeScript/Node.js, Express, `process.kill()`, PowerShell `Get-CimInstance Win32_Process`, Vitest

---

## File Map

| File | Change |
|---|---|
| `src/types.ts` | Add `pid?: number` to `NormalizedEvent` and `SessionState` |
| `src/monitor/EventNormalizer.ts` | Extract `pid` from raw hook payload |
| `src/monitor/SessionStore.ts` | Expose `setPid()` and store PID in state |
| `src/monitor/SessionRegistry.ts` | Call `process.kill(pid)` in `markStopped` |
| `src/server/index.ts` | Return `pid` in abort response for diagnostics |
| `~/.claude/settings.json` | Update PowerShell hook to inject parent PID |
| `tests/monitor/EventNormalizer.test.ts` | Test PID extraction |
| `tests/monitor/sessionRegistry.test.ts` | Test kill is attempted on abort |

---

### Task 1: Add `pid` to types and EventNormalizer

**Files:**
- Modify: `src/types.ts`
- Modify: `src/monitor/EventNormalizer.ts`
- Test: `tests/monitor/EventNormalizer.test.ts`

- [ ] **Step 1: Write failing test for PID extraction**

Add to `tests/monitor/EventNormalizer.test.ts`:

```typescript
it("extracts pid from hook payload", () => {
  const raw = {
    hook_event_name: "PostToolUse",
    session_id: "abc",
    cwd: "/home/user/MyProject",
    pid: 12345,
    usage: { input_tokens: 100, output_tokens: 50 },
    timestamp_ms: 1000,
  };
  const event = normalizeHookPayload(raw);
  expect(event.pid).toBe(12345);
});

it("leaves pid undefined when not in payload", () => {
  const raw = {
    hook_event_name: "PostToolUse",
    session_id: "abc",
    cwd: "/home/user/MyProject",
    usage: { input_tokens: 10, output_tokens: 5 },
    timestamp_ms: 1000,
  };
  const event = normalizeHookPayload(raw);
  expect(event.pid).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npx vitest run tests/monitor/EventNormalizer.test.ts
```
Expected: FAIL — "event.pid" does not exist on type

- [ ] **Step 3: Add `pid` to types**

In `src/types.ts`, add `pid?: number` to `NormalizedEvent` (after `timestamp_ms`):

```typescript
export interface NormalizedEvent {
  session_id?: string;
  project_name?: string;
  model?: string;
  pid?: number;
  source: "hook" | "otel" | "journal";
  type: "session_start" | "session_end" | "tool_use" | "turn_end" | "notification" | "token_delta";
  tokens: { input: number; output: number };
  cost_usd: number;
  timestamp_ms: number;
  metadata: Record<string, unknown>;
}
```

Add `pid?: number` to `SessionState` (after `model_last`):

```typescript
export interface SessionState {
  // ... existing fields ...
  model_last?: string;
  pid?: number;
  models?: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number }>;
  weighted_tokens_total?: number;
}
```

- [ ] **Step 4: Extract PID in EventNormalizer**

In `src/monitor/EventNormalizer.ts`, update `normalizeHookPayload`:

```typescript
export function normalizeHookPayload(raw: Record<string, unknown>): NormalizedEvent {
  const usage = (raw.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const model = raw.model as string | undefined;
  const pid = typeof raw.pid === "number" ? raw.pid : undefined;
  return {
    session_id: raw.session_id as string | undefined,
    project_name: extractProjectName(raw.cwd as string | undefined),
    model,
    pid,
    source: "hook",
    type: hookEventToType(raw.hook_event_name as string),
    tokens: { input, output },
    cost_usd: calcCost(input, output, model),
    timestamp_ms: (raw.timestamp_ms as number) || Date.now(),
    metadata: raw,
  };
}
```

- [ ] **Step 5: Run tests — expect pass**

```
npx vitest run tests/monitor/EventNormalizer.test.ts
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/monitor/EventNormalizer.ts tests/monitor/EventNormalizer.test.ts
git commit -m "feat: add pid field to NormalizedEvent and SessionState, extract from hook payload"
```

---

### Task 2: Store PID in SessionStore and propagate via SessionRegistry

**Files:**
- Modify: `src/monitor/SessionStore.ts`
- Modify: `src/monitor/SessionRegistry.ts`
- Test: `tests/monitor/sessionRegistry.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitor/sessionRegistry.test.ts`:

```typescript
it("stores pid from hook event on session state", () => {
  const registry = new SessionRegistry(cfg, () => {}, () => {});
  registry.route(makeEvent({ pid: 9999 }));
  const state = registry.getAllStates()[0];
  expect(state.pid).toBe(9999);
});

it("does not overwrite pid with undefined if subsequent event lacks pid", () => {
  let lastState: SessionState | undefined;
  const registry = new SessionRegistry(cfg, (s) => { lastState = s; }, () => {});
  registry.route(makeEvent({ pid: 9999 }));
  registry.route(makeEvent({ pid: undefined }));
  expect(lastState?.pid).toBe(9999);
});
```

Note: `makeEvent` in that test file already spreads overrides onto the event. The import for `SessionState` will need to be added at the top if not present:
```typescript
import { NormalizedEvent, SessionState } from "../../src/types";
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/monitor/sessionRegistry.test.ts
```
Expected: FAIL — `state.pid` is undefined

- [ ] **Step 3: Add `setPid` to SessionStore**

In `src/monitor/SessionStore.ts`, add this method after `setProjectFirstSeen`:

```typescript
setPid(pid: number): void {
  this.state.pid = pid;
}
```

Also update the `apply` method's token_delta live branch and the fallthrough branch to call `setPid` when `event.pid` is defined. Find the section in `apply()` where events are processed and add before the final `this.emit("state_updated", ...)`:

```typescript
if (event.pid !== undefined) this.setPid(event.pid);
```

Place this line once, near the end of the `apply()` method body (inside the method but after the token/lifecycle updates), just before `this.state.last_seen_ms = event.timestamp_ms` or wherever the final state mutation happens. Read the current `apply()` method to find the right spot — it should be added so it runs for every event type.

**Full patch for `apply()` — find and update the final lines before `this.emit("state_updated")`:**

In `apply()`, the last few lines before `this.emit("state_updated", ...)` should become:

```typescript
    this.state.last_seen_ms = event.timestamp_ms;
    if (event.pid !== undefined) this.setPid(event.pid);
    this.updateAlertLevel();
    this.emit("state_updated", this.state);
```

(Read the file to confirm the exact location — do not blindly insert; find the `this.state.last_seen_ms` assignment and add the `pid` line after it.)

- [ ] **Step 4: Run tests — expect pass**

```
npx vitest run tests/monitor/sessionRegistry.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/monitor/SessionStore.ts tests/monitor/sessionRegistry.test.ts
git commit -m "feat: track pid in SessionStore, preserve across events"
```

---

### Task 3: Kill process on abort

**Files:**
- Modify: `src/monitor/SessionRegistry.ts`
- Modify: `src/server/index.ts`
- Test: `tests/monitor/sessionRegistry.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitor/sessionRegistry.test.ts`:

```typescript
import { vi } from "vitest";

it("attempts to kill process when markStopped is called with a known pid", () => {
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const registry = new SessionRegistry(cfg, () => {}, () => {});
  registry.route(makeEvent({ pid: 5555 }));
  registry.markStopped("sess-abc");
  expect(killSpy).toHaveBeenCalledWith(5555);
  killSpy.mockRestore();
});

it("does not throw when markStopped is called and kill fails", () => {
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("EPERM"); });
  const registry = new SessionRegistry(cfg, () => {}, () => {});
  registry.route(makeEvent({ pid: 7777 }));
  expect(() => registry.markStopped("sess-abc")).not.toThrow();
  killSpy.mockRestore();
});

it("does not call kill when session has no pid", () => {
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const registry = new SessionRegistry(cfg, () => {}, () => {});
  registry.route(makeEvent());  // no pid
  registry.markStopped("sess-abc");
  expect(killSpy).not.toHaveBeenCalled();
  killSpy.mockRestore();
});
```

- [ ] **Step 2: Run tests — confirm fail**

```
npx vitest run tests/monitor/sessionRegistry.test.ts
```
Expected: FAIL — kill not called

- [ ] **Step 3: Update `markStopped` in SessionRegistry**

Replace the current `markStopped` method in `src/monitor/SessionRegistry.ts`:

```typescript
markStopped(sessionId: string): boolean {
  const store = this.sessions.get(sessionId);
  if (!store) return false;
  const state = store.getState();
  if (state.pid !== undefined) {
    try {
      process.kill(state.pid);
      log.warn("kill signal sent to Claude process", { session_id: sessionId, pid: state.pid });
    } catch (err) {
      log.warn("kill failed (process may have already exited)", {
        session_id: sessionId,
        pid: state.pid,
        message: (err as Error).message,
      });
    }
  }
  store.setLifecycle("stopped");
  log.warn("session marked stopped", { session_id: sessionId });
  this.onUpdate(store.getState() as SessionState);
  return true;
}
```

- [ ] **Step 4: Run tests — expect pass**

```
npx vitest run tests/monitor/sessionRegistry.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Update abort response to include kill status**

In `src/server/index.ts`, update the abort handler:

```typescript
app.post("/abort/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params["sessionId"] as string;
  const states = registry.getAllStates();
  const before = states.find(s => s.session_id === sessionId);
  const ok = registry.markStopped(sessionId);
  if (ok) {
    log.warn("abort requested", { session_id: sessionId, had_pid: before?.pid != null });
    res.json({ ok: true, killed: before?.pid != null });
  } else {
    res.status(404).json({ error: "session not found" });
  }
});
```

- [ ] **Step 6: Run full test suite**

```
npx vitest run
```
Expected: all tests pass (count should match or exceed previous)

- [ ] **Step 7: Commit**

```bash
git add src/monitor/SessionRegistry.ts src/server/index.ts tests/monitor/sessionRegistry.test.ts
git commit -m "feat: kill Claude process on abort if pid is known"
```

---

### Task 4: Update PowerShell hook to include parent PID

**Files:**
- Modify: `~/.claude/settings.json` (i.e. `C:\Users\quick\.claude\settings.json`)

Context: The current hook command is:
```
powershell -NoProfile -Command "$body = $input | Out-String; if ($body.Trim()) { try { Invoke-RestMethod -Uri 'http://localhost:3001/hook' -Method Post -Body $body -ContentType 'application/json' | Out-Null } catch {} }"
```

The new command must:
1. Parse the JSON body
2. Add `pid` = the parent process ID of the PowerShell hook script (which is the Claude Code Node.js process)
3. Re-serialize and POST

The parent PID is obtained via: `(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId`

- [ ] **Step 1: Write new PowerShell command string**

The full new command for all three hook types (PostToolUse, Stop, Notification):

```
powershell -NoProfile -Command "$raw = $input | Out-String; if ($raw.Trim()) { try { $body = $raw | ConvertFrom-Json; $ppid = (Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").ParentProcessId; $body | Add-Member -NotePropertyName 'pid' -NotePropertyValue $ppid -Force; Invoke-RestMethod -Uri 'http://localhost:3001/hook' -Method Post -Body (ConvertTo-Json $body -Compress) -ContentType 'application/json' | Out-Null } catch {} }"
```

- [ ] **Step 2: Update `~/.claude/settings.json`**

Replace the `command` value for all three hook types (PostToolUse, Stop, Notification) with the new command above. The file is at `C:\Users\quick\.claude\settings.json`.

The full updated file:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "powershell -NoProfile -Command \"$raw = $input | Out-String; if ($raw.Trim()) { try { $body = $raw | ConvertFrom-Json; $ppid = (Get-CimInstance Win32_Process -Filter \\\"ProcessId=$PID\\\").ParentProcessId; $body | Add-Member -NotePropertyName 'pid' -NotePropertyValue $ppid -Force; Invoke-RestMethod -Uri 'http://localhost:3001/hook' -Method Post -Body (ConvertTo-Json $body -Compress) -ContentType 'application/json' | Out-Null } catch {} }\"" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "powershell -NoProfile -Command \"$raw = $input | Out-String; if ($raw.Trim()) { try { $body = $raw | ConvertFrom-Json; $ppid = (Get-CimInstance Win32_Process -Filter \\\"ProcessId=$PID\\\").ParentProcessId; $body | Add-Member -NotePropertyName 'pid' -NotePropertyValue $ppid -Force; Invoke-RestMethod -Uri 'http://localhost:3001/hook' -Method Post -Body (ConvertTo-Json $body -Compress) -ContentType 'application/json' | Out-Null } catch {} }\"" }]
    }],
    "Notification": [{
      "hooks": [{ "type": "command", "command": "powershell -NoProfile -Command \"$raw = $input | Out-String; if ($raw.Trim()) { try { $body = $raw | ConvertFrom-Json; $ppid = (Get-CimInstance Win32_Process -Filter \\\"ProcessId=$PID\\\").ParentProcessId; $body | Add-Member -NotePropertyName 'pid' -NotePropertyValue $ppid -Force; Invoke-RestMethod -Uri 'http://localhost:3001/hook' -Method Post -Body (ConvertTo-Json $body -Compress) -ContentType 'application/json' | Out-Null } catch {} }\"" }]
    }]
  },
  "enabledPlugins": {
    "github@claude-plugins-official": true,
    "playwright@claude-plugins-official": true,
    "superpowers@claude-plugins-official": true,
    "claude-md-management@claude-plugins-official": true,
    "skill-creator@claude-plugins-official": true,
    "security-guidance@claude-plugins-official": true,
    "claude-code-setup@claude-plugins-official": true,
    "supabase@claude-plugins-official": true,
    "agent-sdk-dev@claude-plugins-official": true,
    "chrome-devtools-mcp@claude-plugins-official": true
  }
}
```

Note on JSON escaping: inside the outer JSON string, inner double quotes become `\"`, and the `Win32_Process` filter string `"ProcessId=$PID"` needs its quotes as `\\\"`. Test the PowerShell command in a PowerShell console first if unsure.

- [ ] **Step 3: Smoke-test the hook**

Start Claude Pulse (`echo "1" | npm run dev`), then in a separate Claude Code session do any tool use. Check the server log for a line like:
```
POST /hook  { hook_event_name: 'PostToolUse', has_usage: true, ... }
```
Then GET `http://localhost:3001/dashboard` and confirm the tile shows a non-zero PID in state (visible via browser console: `window.__sessions` or WS message).

Alternatively, POST a test payload manually:
```bash
curl -s -X POST http://localhost:3001/hook \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PostToolUse","session_id":"pid-test","cwd":"C:/test/MyProject","pid":99999,"usage":{"input_tokens":100,"output_tokens":50}}'
```
Then confirm via WS or GET /api/state that `pid: 99999` appears on the session.

- [ ] **Step 4: Commit**

```bash
git add C:/Users/quick/.claude/settings.json
git commit -m "feat: inject parent PID into hook payload via PowerShell"
```

Note: `~/.claude/settings.json` is outside the project repo. The commit above is for tracking purposes only — this file won't be in the project git. Document the change in `docs/CLAUDE.md` under "Hooks" instead:

```bash
git add docs/CLAUDE.md
git commit -m "docs: note PID injection in hook script"
```

---

### Task 5: Run full suite + verify end-to-end

- [ ] **Step 1: Run all tests**

```
npx vitest run
```
Expected: all tests pass (≥54 tests)

- [ ] **Step 2: Verify abort kills process**

Start Claude Pulse, open dashboard. In a new PowerShell, start a Claude Code session (`claude`) in a test directory. Wait for it to appear in the dashboard (a tile should show). Click Abort — confirm the tile transitions to "stopped" state and the Claude Code process in the other PowerShell terminates (prompt returns, or you see an exit message).

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: adjust pid kill flow based on e2e testing"
git push
```
