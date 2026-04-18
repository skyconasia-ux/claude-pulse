import { NormalizedEvent, SessionState, AppConfig } from "../types";
import { SessionStore } from "./SessionStore";
import { loadPersistedSessions, persistSessions } from "./StateStore";
import { makeLogger } from "../server/logger";

const log = makeLogger("SessionRegistry");

const STALE_WARN_MS = 120_000;
const STALE_CLOSE_MS = 600_000;

export class SessionRegistry {
  private sessions = new Map<string, SessionStore>();
  private staleTimer: ReturnType<typeof setInterval>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private cfg: AppConfig,
    private onUpdate: (state: SessionState) => void,
    private onCheckpoint: (severity: "suggested" | "mandatory", state: SessionState) => void,
  ) {
    this.staleTimer = setInterval(() => this.checkStale(), 15_000);
    this.loadPersisted();
  }

  private loadPersisted(): void {
    const now = Date.now();
    for (const state of loadPersistedSessions()) {
      // Reset last_seen_ms so persisted sessions get a full grace period before stale check fires.
      // Also drop any active lifecycle to "waiting" — we don't know if Claude is still running.
      const activeLifecycles: Array<typeof state.lifecycle> = ["running", "tool_use", "thinking"];
      const restoredState: SessionState = {
        ...state,
        last_seen_ms: now,
        lifecycle: activeLifecycles.includes(state.lifecycle) ? "waiting" : state.lifecycle,
        is_stale: false,
      };
      const store = new SessionStore(this.cfg, state.session_id, state.project_name, restoredState);
      store.on("state_updated", (s: SessionState) => { this.onUpdate(s); this.scheduleSave(); });
      store.on("checkpoint_suggested", (s: SessionState) => this.onCheckpoint("suggested", s));
      store.on("checkpoint_mandatory", (s: SessionState) => this.onCheckpoint("mandatory", s));
      this.sessions.set(state.session_id, store);
      log.info("restored session from disk", { session_id: state.session_id, project: state.project_name });
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      persistSessions(this.getAllStates());
    }, 3_000);
  }

  route(event: NormalizedEvent): void {
    const id = event.session_id ?? "default";
    const name = event.project_name ?? "unknown";

    if (!this.sessions.has(id)) {
      log.info("new session registered", { session_id: id, project_name: name });
      const store = new SessionStore(this.cfg, id, name);
      store.on("state_updated", (s: SessionState) => { this.onUpdate(s); this.scheduleSave(); });
      store.on("checkpoint_suggested", (s: SessionState) => this.onCheckpoint("suggested", s));
      store.on("checkpoint_mandatory", (s: SessionState) => this.onCheckpoint("mandatory", s));
      this.sessions.set(id, store);
    }

    this.sessions.get(id)!.apply(event);
  }

  getAllStates(): SessionState[] {
    return Array.from(this.sessions.values()).map(s => s.getState() as SessionState);
  }

  markStopped(sessionId: string): boolean {
    const store = this.sessions.get(sessionId);
    if (!store) return false;
    store.setLifecycle("stopped");
    log.warn("session marked stopped", { session_id: sessionId });
    this.onUpdate(store.getState() as SessionState);
    return true;
  }

  destroy(): void {
    clearInterval(this.staleTimer);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    persistSessions(this.getAllStates());
    log.info("sessions persisted on shutdown");
  }

  private checkStale(): void {
    const now = Date.now();
    for (const [, store] of this.sessions) {
      const state = store.getState();
      if (state.lifecycle === "stopped" || state.lifecycle === "closed") continue;
      const age = now - state.last_seen_ms;
      if (age > STALE_CLOSE_MS && !state.is_stale) {
        store.setStale(true);
        log.info("session marked stale", { session_id: state.session_id, age_s: Math.round(age / 1000) });
        this.onUpdate(store.getState() as SessionState);
      } else if (age > STALE_WARN_MS && state.lifecycle !== "waiting" && state.lifecycle !== "idle") {
        store.setLifecycle("waiting");
        this.onUpdate(store.getState() as SessionState);
      }
    }
  }
}
