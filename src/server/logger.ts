import fs from "fs";
import path from "path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const LOG_DIR = path.resolve(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const minLevel: number = LEVELS[envLevel] ?? LEVELS.info;
const toConsole = minLevel === LEVELS.debug;

// Ensure logs/ exists at module load time
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level: Level, component: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(extra ?? {}),
  });

  // Always write info+ to file; debug only goes to file when LOG_LEVEL=debug
  if (LEVELS[level] >= LEVELS.info || toConsole) {
    try {
      fs.appendFileSync(LOG_FILE, entry + "\n");
    } catch {
      // file write failure must never crash the server
    }
  }

  if (toConsole) {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(entry);
  }
}

export function makeLogger(component: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => write("debug", component, msg, extra),
    info:  (msg: string, extra?: Record<string, unknown>) => write("info",  component, msg, extra),
    warn:  (msg: string, extra?: Record<string, unknown>) => write("warn",  component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => write("error", component, msg, extra),
  };
}
