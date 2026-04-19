import { describe, it, expect } from "vitest";
import {
  pickMostActive,
  pickSelected,
  fmtEta,
  fmtTokens,
  alertColor,
  sessionRows,
  shortModelName,
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
  it("returns em-dash for undefined", () => {
    expect(shortModelName(undefined)).toBe("—");
  });
});
