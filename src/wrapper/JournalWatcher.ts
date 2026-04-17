import fs from "fs";
import path from "path";
import os from "os";
import { eventBus } from "../monitor/EventBus";
import { makeLogger } from "../server/logger";
import { NormalizedEvent } from "../types";

const log = makeLogger("JournalWatcher");

const COST_PER_INPUT = 0.000003;
const COST_PER_OUTPUT = 0.000015;
// Only bootstrap sessions active within the last hour
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

function extractProjectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() ?? "unknown";
}

interface ParsedLine {
  sessionId: string;
  projectName: string;
  inputAbsolute: number;  // full context size sent to model this turn
  output: number;
  cost: number;
  ts: number;
}

function parseUsageLine(line: string): ParsedLine | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== "assistant") return null;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, number> | undefined;
  if (!usage) return null;

  // input_tokens = prompt tokens; cache_* = cached context (still billed)
  const inputAbsolute = (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  if (inputAbsolute === 0 && output === 0) return null;

  const cost = inputAbsolute * COST_PER_INPUT + output * COST_PER_OUTPUT;
  const ts = obj.timestamp ? new Date(obj.timestamp as string).getTime() : Date.now();

  return {
    sessionId: (obj.sessionId as string) ?? "",
    projectName: extractProjectName(obj.cwd as string | undefined),
    inputAbsolute, output, cost, ts,
  };
}

interface FileState {
  size: number;
  buf: string;
  prevInputAbsolute: number; // last known context window size, for delta calculation
}

export class JournalWatcher {
  private claudeDir: string;
  private dirWatchers: Map<string, fs.FSWatcher> = new Map();
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();
  private fileStates: Map<string, FileState> = new Map();

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir ?? path.join(os.homedir(), ".claude", "projects");
  }

  start(): void {
    if (!fs.existsSync(this.claudeDir)) {
      log.warn("Claude projects dir not found — journal watching disabled", { path: this.claudeDir });
      return;
    }

    try {
      for (const entry of fs.readdirSync(this.claudeDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          this.watchProjectDir(path.join(this.claudeDir, entry.name));
        }
      }
    } catch (e) {
      log.warn("error scanning projects dir", { err: String(e) });
    }

    const topWatcher = fs.watch(this.claudeDir, (_ev, filename) => {
      if (!filename) return;
      const fullPath = path.join(this.claudeDir, filename);
      try {
        if (fs.statSync(fullPath).isDirectory()) this.watchProjectDir(fullPath);
      } catch { /* not yet created */ }
    });
    this.dirWatchers.set(this.claudeDir, topWatcher);
    log.info("watching Claude journals", { path: this.claudeDir });
  }

  private watchProjectDir(dirPath: string): void {
    if (this.dirWatchers.has(dirPath)) return;

    // Only bootstrap the single most-recently-modified JSONL in this project dir
    // that was active within the last hour — avoids ghost tiles from old sessions
    const candidates: { file: string; mtime: number }[] = [];
    try {
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          const mtime = fs.statSync(path.join(dirPath, f)).mtimeMs;
          if (Date.now() - mtime < ACTIVE_WINDOW_MS) {
            candidates.push({ file: f, mtime });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    if (candidates.length > 0) {
      // Most recent file only — one active session per project
      candidates.sort((a, b) => b.mtime - a.mtime);
      this.bootstrapFile(path.join(dirPath, candidates[0].file));
    }

    const watcher = fs.watch(dirPath, (_ev, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      const filePath = path.join(dirPath, filename);
      if (!this.fileStates.has(filePath)) {
        this.bootstrapFile(filePath);
      } else {
        this.readNewLines(filePath);
      }
    });
    this.dirWatchers.set(dirPath, watcher);
  }

  private bootstrapFile(filePath: string): void {
    if (this.fileStates.has(filePath)) return;

    let content: string;
    let size: number;
    try {
      content = fs.readFileSync(filePath, "utf8");
      size = fs.statSync(filePath).size;
    } catch { return; }

    // Parse ALL existing lines to build a correct snapshot:
    // - inputAbsolute = LATEST turn's context size (not a sum — context window is absolute)
    // - output = sum of all output tokens across turns (cumulative generation)
    // - cost = sum of all turn costs (what was actually billed)
    const sessions: Record<string, {
      latestInput: number; totalOutput: number; totalCost: number;
      projectName: string; ts: number;
    }> = {};

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const p = parseUsageLine(line);
      if (!p || !p.sessionId) continue;
      if (!sessions[p.sessionId]) {
        sessions[p.sessionId] = { latestInput: 0, totalOutput: 0, totalCost: 0, projectName: p.projectName, ts: p.ts };
      }
      // Replace input with latest (each turn's value is the current context size)
      sessions[p.sessionId].latestInput = p.inputAbsolute;
      sessions[p.sessionId].totalOutput += p.output;
      sessions[p.sessionId].totalCost += p.cost;
      sessions[p.sessionId].ts = p.ts;
    }

    for (const [sessionId, s] of Object.entries(sessions)) {
      if (s.latestInput === 0 && s.totalOutput === 0) continue;
      this.fileStates.set(filePath, { size, buf: "", prevInputAbsolute: s.latestInput });
      this.watchFile(filePath);
      // Emit bootstrap: input = current context window size (absolute, not delta)
      // This is the ONE event that seeds the session state correctly
      this.emitEvent(sessionId, s.projectName, s.latestInput, s.totalOutput, s.totalCost, s.ts);
      log.debug("bootstrapped", { session: sessionId.slice(0, 8), contextTokens: s.latestInput, output: s.totalOutput });
    }

    // File had no usage lines — still watch it for future updates
    if (!this.fileStates.has(filePath)) {
      this.fileStates.set(filePath, { size, buf: "", prevInputAbsolute: 0 });
      this.watchFile(filePath);
    }
  }

  private watchFile(filePath: string): void {
    if (this.fileWatchers.has(filePath)) return;
    const watcher = fs.watch(filePath, () => this.readNewLines(filePath));
    this.fileWatchers.set(filePath, watcher);
  }

  private readNewLines(filePath: string): void {
    const state = this.fileStates.get(filePath);
    if (!state) return;

    let newSize: number;
    try { newSize = fs.statSync(filePath).size; } catch { return; }
    if (newSize <= state.size) return;

    const buf = Buffer.alloc(newSize - state.size);
    let fd: number;
    try { fd = fs.openSync(filePath, "r"); } catch { return; }
    fs.readSync(fd, buf, 0, buf.length, state.size);
    fs.closeSync(fd);
    state.size = newSize;

    const chunk = state.buf + buf.toString("utf8");
    const lines = chunk.split("\n");
    state.buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const p = parseUsageLine(line);
      if (!p) continue;
      const sessionId = p.sessionId || path.basename(filePath, ".jsonl");

      // Emit DELTA input (context window growth this turn), not absolute
      const inputDelta = Math.max(0, p.inputAbsolute - state.prevInputAbsolute);
      state.prevInputAbsolute = p.inputAbsolute;

      this.emitEvent(sessionId, p.projectName, inputDelta, p.output, p.cost, Date.now());
      log.debug("live token event", { session: sessionId.slice(0, 8), inputDelta, output: p.output });
    }
  }

  private emitEvent(sessionId: string, projectName: string, input: number, output: number, cost: number, ts: number): void {
    const event: NormalizedEvent = {
      session_id: sessionId,
      project_name: projectName,
      source: "journal",
      type: "token_delta",
      tokens: { input, output },
      cost_usd: cost,
      timestamp_ms: ts,
      metadata: {},
    };
    eventBus.emit("event", event);
  }

  stop(): void {
    for (const w of [...this.dirWatchers.values(), ...this.fileWatchers.values()]) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.dirWatchers.clear();
    this.fileWatchers.clear();
    this.fileStates.clear();
  }
}
