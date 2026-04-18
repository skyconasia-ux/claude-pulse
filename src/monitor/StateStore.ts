import fs from "fs";
import path from "path";
import { SessionState } from "../types";
import { makeLogger } from "../server/logger";

const log = makeLogger("StateStore");
const DATA_FILE = path.join(process.cwd(), "data", "sessions.json");

interface PersistedData {
  sessions: SessionState[];
  projectFirstSeen: Record<string, number>;
}

export function loadPersistedData(): PersistedData {
  try {
    if (!fs.existsSync(DATA_FILE)) return { sessions: [], projectFirstSeen: {} };
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    // Backward compat: old format was a bare array
    if (Array.isArray(raw)) {
      log.info("migrating sessions file from array to object format");
      return { sessions: raw as SessionState[], projectFirstSeen: {} };
    }
    const sessions = Array.isArray(raw.sessions) ? raw.sessions as SessionState[] : [];
    const projectFirstSeen = (raw.projectFirstSeen as Record<string, number>) ?? {};
    log.info("loaded persisted data", { sessions: sessions.length, projects: Object.keys(projectFirstSeen).length });
    return { sessions, projectFirstSeen };
  } catch (e) {
    log.warn("could not load persisted data", { err: String(e) });
    return { sessions: [], projectFirstSeen: {} };
  }
}

export function persistSessions(
  sessions: SessionState[],
  projectFirstSeen: Record<string, number>,
): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions, projectFirstSeen }, null, 2), "utf8");
  } catch (e) {
    log.warn("could not persist sessions", { err: String(e) });
  }
}
