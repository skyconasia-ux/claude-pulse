// tests/wrapper/adapters.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHooksRouter } from "../../src/wrapper/HooksAdapter";
import { createOtelRouter } from "../../src/wrapper/OtelAdapter";
import { eventBus } from "../../src/monitor/EventBus";

describe("HooksAdapter POST /hook", () => {
  const app = express();
  app.use(express.json());
  app.use(createHooksRouter());

  it("returns 200 for valid PostToolUse payload", async () => {
    const res = await request(app).post("/hook").send({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      usage: { input_tokens: 100, output_tokens: 50 },
      timestamp_ms: Date.now(),
    });
    expect(res.status).toBe(200);
  });

  it("emits normalized event on EventBus", async () => {
    const received: unknown[] = [];
    eventBus.on("event", (e) => received.push(e));
    await request(app).post("/hook").send({
      hook_event_name: "Stop",
      usage: { input_tokens: 20, output_tokens: 10 },
      timestamp_ms: Date.now(),
    });
    expect(received.length).toBeGreaterThan(0);
  });

  it("returns 400 for missing hook_event_name", async () => {
    const res = await request(app).post("/hook").send({ usage: {} });
    expect(res.status).toBe(400);
  });
});

describe("OtelAdapter POST /otel", () => {
  const app = express();
  app.use(express.json());
  app.use(createOtelRouter(true));

  it("returns 200 for valid OTEL payload", async () => {
    const res = await request(app).post("/otel").send({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "tool_use",
            startTimeUnixNano: "1000000000",
            attributes: [
              { key: "input_tokens", value: { intValue: 50 } },
              { key: "output_tokens", value: { intValue: 20 } },
            ],
          }],
        }],
      }],
    });
    expect(res.status).toBe(200);
  });

  it("returns 503 when otel_enabled is false", async () => {
    const disabledApp = express();
    disabledApp.use(express.json());
    disabledApp.use(createOtelRouter(false));
    const res = await request(disabledApp).post("/otel").send({});
    expect(res.status).toBe(503);
  });
});
