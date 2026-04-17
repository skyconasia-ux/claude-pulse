import { Router, Request, Response } from "express";
import { normalizeHookPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";
import { makeLogger } from "../server/logger";

const log = makeLogger("HooksAdapter");

export function createHooksRouter(): Router {
  const router = Router();
  router.post("/hook", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!body.hook_event_name) {
      log.warn("POST /hook rejected: missing hook_event_name", { keys: Object.keys(body), body });
      res.status(400).json({ error: "missing hook_event_name" });
      return;
    }
    const event = normalizeHookPayload(body);
    log.info("POST /hook", { hook_event_name: body.hook_event_name as string, keys: Object.keys(body), has_usage: "usage" in body, usage: body.usage ?? null });
    eventBus.emit("event", event);
    res.status(200).json({ ok: true });
  });
  return router;
}
