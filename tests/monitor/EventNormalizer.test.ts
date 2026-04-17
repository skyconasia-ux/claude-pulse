// tests/monitor/EventNormalizer.test.ts
import { describe, it, expect } from "vitest";
import { normalizeHookPayload, normalizeOtelPayload } from "../../src/monitor/EventNormalizer";

describe("normalizeHookPayload", () => {
  it("maps PostToolUse to tool_use event", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_response: { output: "ok" },
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.source).toBe("hook");
    expect(event.type).toBe("tool_use");
    expect(event.tokens.input).toBe(100);
    expect(event.tokens.output).toBe(50);
    expect(event.timestamp_ms).toBe(1000);
    expect(event.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("maps Stop hook to turn_end event", () => {
    const raw = {
      hook_event_name: "Stop",
      usage: { input_tokens: 200, output_tokens: 80 },
      timestamp_ms: 2000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.type).toBe("turn_end");
  });

  it("maps Notification hook to notification event", () => {
    const raw = {
      hook_event_name: "Notification",
      message: "Task complete",
      usage: { input_tokens: 0, output_tokens: 0 },
      timestamp_ms: 3000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.type).toBe("notification");
  });

  it("defaults missing usage to zero tokens", () => {
    const raw = { hook_event_name: "Stop", timestamp_ms: 1000 };
    const event = normalizeHookPayload(raw);
    expect(event.tokens.input).toBe(0);
    expect(event.tokens.output).toBe(0);
  });
});

describe("normalizeOtelPayload", () => {
  it("maps OTEL span to tool_use event", () => {
    const raw = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "tool_use",
            startTimeUnixNano: "1000000000",
            attributes: [
              { key: "input_tokens", value: { intValue: 150 } },
              { key: "output_tokens", value: { intValue: 60 } },
            ],
          }],
        }],
      }],
    };
    const events = normalizeOtelPayload(raw);
    expect(events.length).toBe(1);
    expect(events[0].source).toBe("otel");
    expect(events[0].tokens.input).toBe(150);
    expect(events[0].tokens.output).toBe(60);
  });

  it("returns empty array for unrecognized OTEL shape", () => {
    const events = normalizeOtelPayload({});
    expect(events).toEqual([]);
  });
});
