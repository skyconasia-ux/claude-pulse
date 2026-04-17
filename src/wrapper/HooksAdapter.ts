import { Router, Request, Response } from "express";
import { normalizeHookPayload } from "../monitor/EventNormalizer";
import { eventBus } from "../monitor/EventBus";

export function createHooksRouter(): Router {
  const router = Router();
  router.post("/hook", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!body.hook_event_name) {
      res.status(400).json({ error: "missing hook_event_name" });
      return;
    }
    const event = normalizeHookPayload(body);
    eventBus.emit("event", event);
    res.status(200).json({ ok: true });
  });
  return router;
}
