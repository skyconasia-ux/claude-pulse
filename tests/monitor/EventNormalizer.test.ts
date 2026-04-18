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

describe("EventNormalizer — model extraction and model-aware costs", () => {
  it("extracts model from hook payload", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    expect(event.model).toBe("claude-sonnet-4-6");
  });

  it("uses Opus rates for Opus model hook events", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-opus-4-7",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Opus input rate: $15/MTok = 0.000015 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.000015, 5);
  });

  it("uses Haiku rates for Haiku model hook events", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Haiku input rate: $0.25/MTok = 0.00000025 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.00000025, 8);
  });

  it("falls back to Sonnet rates when model is absent", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      usage: { input_tokens: 100000, output_tokens: 0 },
      timestamp_ms: 1000,
    };
    const event = normalizeHookPayload(raw);
    // Sonnet input rate: $3/MTok = 0.000003 per token
    expect(event.cost_usd).toBeCloseTo(100000 * 0.000003, 5);
    expect(event.model).toBeUndefined();
  });
});
