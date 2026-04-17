import { Router, Request, Response } from "express";
import { normalizeOtelPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";
import { makeLogger } from "../server/logger";

const log = makeLogger("OtelAdapter");

export function createOtelRouter(enabled: boolean): Router {
  const router = Router();
  if (!enabled) {
    log.warn("OTEL disabled — POST /otel will return 503");
    router.post("/otel", (_req: Request, res: Response) => {
      res.status(503).json({ error: "otel_disabled" });
    });
    return router;
  }
  log.info("OTEL adapter enabled, listening on POST /otel");
  router.post("/otel", (req: Request, res: Response) => {
    const events = normalizeOtelPayload(req.body as Record<string, unknown>);
    if (events.length === 0) {
      log.warn("POST /otel produced no events — payload may be malformed or unsupported");
    } else {
      log.debug("POST /otel received", { event_count: events.length });
    }
    for (const event of events) {
      eventBus.emit("event", event);
    }
    res.status(200).json({ ok: true, count: events.length });
  });
  return router;
}
