// tests/monitor/sessionRegistry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionRegistry } from "../../src/monitor/SessionRegistry";
import { NormalizedEvent, SessionState } from "../../src/types";

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

describe("SessionRegistry — PID tracking", () => {
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
});
