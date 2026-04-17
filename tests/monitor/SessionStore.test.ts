// tests/monitor/SessionStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../../src/monitor/SessionStore";
import { NormalizedEvent } from "../../src/types";

const cfg = {
  token_threshold: 1000,
  turn_threshold: 20,
  refresh_active_ms: 1000,
  refresh_idle_ms: 5000,
  server_port: 3001,
  ws_port: 3001,
  otel_enabled: true,
};

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: "hook",
    type: "tool_use",
    tokens: { input: 10, output: 5 },
    cost_usd: 0.0001,
    timestamp_ms: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe("SessionStore — state accumulation", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(cfg); });

  it("starts with zeroed state", () => {
    const s = store.getState();
    expect(s.tokens_total).toBe(0);
    expect(s.turns).toBe(0);
    expect(s.cost_usd).toBe(0);
  });

  it("accumulates tokens on tool_use event", () => {
    store.apply(makeEvent({ tokens: { input: 100, output: 50 }, cost_usd: 0.001 }));
    const s = store.getState();
    expect(s.tokens_in).toBe(100);
    expect(s.tokens_out).toBe(50);
    expect(s.tokens_total).toBe(150);
  });

  it("increments turns on turn_end event", () => {
    store.apply(makeEvent({ type: "turn_end", tokens: { input: 50, output: 20 }, cost_usd: 0.0005 }));
    expect(store.getState().turns).toBe(1);
  });

  it("resets state on session_start", () => {
    store.apply(makeEvent({ tokens: { input: 500, output: 200 }, cost_usd: 0.005 }));
    store.apply(makeEvent({ type: "session_start", tokens: { input: 0, output: 0 }, cost_usd: 0 }));
    const s = store.getState();
    expect(s.tokens_total).toBe(0);
    expect(s.turns).toBe(0);
  });

  it("computes alert_level green below 70%", () => {
    store.apply(makeEvent({ tokens: { input: 300, output: 300 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("green");
  });

  it("computes alert_level yellow at 70%", () => {
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("yellow");
  });

  it("computes alert_level red at 90%", () => {
    store.apply(makeEvent({ tokens: { input: 450, output: 450 }, cost_usd: 0 }));
    expect(store.getState().alert_level).toBe("red");
  });
});

describe("SessionStore — checkpoint thresholds (independent)", () => {
  it("emits checkpoint_suggested when tokens reach 70% of threshold", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(fired).toContain("suggested");
  });

  it("emits checkpoint_mandatory when tokens reach 90% of threshold", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_mandatory", () => fired.push("mandatory"));
    store.apply(makeEvent({ tokens: { input: 450, output: 450 }, cost_usd: 0 }));
    expect(fired).toContain("mandatory");
  });

  it("emits checkpoint_suggested when turns reach 10", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    for (let i = 0; i < 10; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 1 }, cost_usd: 0 }));
    }
    expect(fired).toContain("suggested");
  });

  it("emits checkpoint_mandatory when turns reach turn_threshold (20)", () => {
    const store = new SessionStore({ ...cfg, turn_threshold: 20 });
    const fired: string[] = [];
    store.on("checkpoint_mandatory", () => fired.push("mandatory"));
    for (let i = 0; i < 20; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 1 }, cost_usd: 0 }));
    }
    expect(fired).toContain("mandatory");
  });

  it("does NOT require token condition to fire turn-based checkpoint", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    // Only 1 token each turn — nowhere near 70% threshold
    for (let i = 0; i < 10; i++) {
      store.apply(makeEvent({ type: "turn_end", tokens: { input: 1, output: 0 }, cost_usd: 0 }));
    }
    expect(fired).toContain("suggested");
  });

  it("does NOT require turn condition to fire token-based checkpoint", () => {
    const store = new SessionStore(cfg);
    const fired: string[] = [];
    store.on("checkpoint_suggested", () => fired.push("suggested"));
    // Single event that hits 70% tokens but turns = 0
    store.apply(makeEvent({ tokens: { input: 350, output: 350 }, cost_usd: 0 }));
    expect(fired).toContain("suggested");
  });
});

describe("SessionStore — out-of-order events", () => {
  it("drops events older than 60s within the same session", () => {
    const store = new SessionStore(cfg);
    const now = Date.now();
    store.apply(makeEvent({ timestamp_ms: now }));
    const tokensBefore = store.getState().tokens_total;
    store.apply(makeEvent({ tokens: { input: 999, output: 999 }, timestamp_ms: now - 61_000 }));
    expect(store.getState().tokens_total).toBe(tokensBefore);
  });
});
