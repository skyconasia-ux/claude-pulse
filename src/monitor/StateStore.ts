import fs from "fs";
import path from "path";
import { SessionState } from "../types";
import { makeLogger } from "../server/logger";

const log = makeLogger("StateStore");
const DATA_FILE = path.join(process.cwd(), "data", "sessions.json");

export function loadPersistedSessions(): SessionState[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const sessions = JSON.parse(raw) as SessionState[];
    log.info("loaded persisted sessions", { count: sessions.length });
    return sessions;
  } catch (e) {
    log.warn("could not load persisted sessions", { err: String(e) });
    return [];
  }
}

export function persistSessions(sessions: SessionState[]): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2), "utf8");
  } catch (e) {
    log.warn("could not persist sessions", { err: String(e) });
  }
}
