// tests/server/WsBroadcaster.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "http";
import WebSocket from "ws";
import { WsBroadcaster } from "../../src/server/WsBroadcaster";
import { SessionState } from "../../src/types";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session",
    project_name: "test-project",
    lifecycle: "idle",
    last_seen_ms: Date.now(),
    is_stale: false,
    started_at: 1000,
    turns: 0,
    tokens_total: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    activity_state: "idle",
    burn_rate_per_sec: 0,
    tokens_per_turn_avg: 0,
    eta_to_threshold_sec: Infinity,
    alert_level: "green",
    last_checkpoint_turn: 0,
    ...overrides,
  };
}

describe("WsBroadcaster", () => {
  let broadcaster: WsBroadcaster;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    broadcaster = new WsBroadcaster(server);
    await new Promise<void>(r => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  it("sends sessions_snapshot to client on connect", async () => {
    const state = makeState({ tokens_total: 500 });
    broadcaster.setSession(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msg = await new Promise<string>(r => ws.on("message", d => r(d.toString())));
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe("sessions_snapshot");
    expect(parsed.sessions[0].tokens_total).toBe(500);
    ws.close();
  });

  it("broadcasts session_updated to connected clients", async () => {
    const state = makeState();
    broadcaster.setSession(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>(r => ws.once("message", () => r())); // consume snapshot

    const updatePromise = new Promise<string>(r => ws.on("message", d => r(d.toString())));
    broadcaster.broadcastSessionUpdate({ ...state, tokens_total: 999 });
    const parsed = JSON.parse(await updatePromise);
    expect(parsed.type).toBe("session_updated");
    expect(parsed.session.tokens_total).toBe(999);
    ws.close();
  });

  it("sends sessions_snapshot to reconnecting client", async () => {
    const state = makeState({ turns: 5 });
    broadcaster.setSession(state);
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msg = await new Promise<string>(r => ws.on("message", d => r(d.toString())));
    const parsed = JSON.parse(msg);
    expect(parsed.sessions[0].turns).toBe(5);
    ws.close();
  });
});
