import { Router, Request, Response } from "express";
import { normalizeOtelPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";

export function createOtelRouter(enabled: boolean): Router {
  const router = Router();
  if (!enabled) {
    console.warn("[OtelAdapter] OTEL disabled — POST /otel will return 503");
    router.post("/otel", (_req: Request, res: Response) => {
      res.status(503).json({ error: "otel_disabled" });
    });
    return router;
  }
  router.post("/otel", (req: Request, res: Response) => {
    const events = normalizeOtelPayload(req.body as Record<string, unknown>);
    for (const event of events) {
      eventBus.emit("event", event);
    }
    res.status(200).json({ ok: true, count: events.length });
  });
  return router;
}
