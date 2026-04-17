import fs from "fs";
import path from "path";
import os from "os";
import { eventBus } from "../monitor/EventBus";
import { makeLogger } from "../server/logger";
import { NormalizedEvent } from "../types";

const log = makeLogger("JournalWatcher");

const COST_PER_INPUT = 0.000003;
const COST_PER_OUTPUT = 0.000015;
const STALE_HOURS = 24;

function extractProjectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() ?? "unknown";
}

function parseUsageLine(line: string): { sessionId: string; projectName: string; input: number; output: number; cost: number; ts: number } | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== "assistant") return null;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, number> | undefined;
  if (!usage) return null;

  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  if (input === 0 && output === 0) return null;

  const cost = input * COST_PER_INPUT + output * COST_PER_OUTPUT;
  const ts = obj.timestamp ? new Date(obj.timestamp as string).getTime() : Date.now();

  return {
    sessionId: (obj.sessionId as string) ?? "",
    projectName: extractProjectName(obj.cwd as string | undefined),
    input, output, cost, ts,
  };
}

interface FileState { size: number; buf: string; }

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

    // Watch for new project directories being created
    const topWatcher = fs.watch(this.claudeDir, (_ev, filename) => {
      if (!filename) return;
      const fullPath = path.join(this.claudeDir, filename);
      try {
        if (fs.statSync(fullPath).isDirectory()) this.watchProjectDir(fullPath);
      } catch { /* dir may not exist yet */ }
    });
    this.dirWatchers.set(this.claudeDir, topWatcher);
    log.info("watching Claude journals", { path: this.claudeDir });
  }

  private watchProjectDir(dirPath: string): void {
    if (this.dirWatchers.has(dirPath)) return;

    try {
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith(".jsonl")) continue;
        const filePath = path.join(dirPath, f);
        try {
          const mtime = fs.statSync(filePath).mtimeMs;
          const ageMs = Date.now() - mtime;
          if (ageMs < STALE_HOURS * 3_600_000) {
            this.bootstrapFile(filePath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable dirs */ }

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

    this.fileStates.set(filePath, { size, buf: "" });
    this.watchFile(filePath);

    // Aggregate historical tokens per session and emit a single bootstrap event
    const totals: Record<string, { input: number; output: number; cost: number; projectName: string; ts: number }> = {};
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseUsageLine(line);
      if (!parsed || !parsed.sessionId) continue;
      if (!totals[parsed.sessionId]) {
        totals[parsed.sessionId] = { input: 0, output: 0, cost: 0, projectName: parsed.projectName, ts: parsed.ts };
      }
      totals[parsed.sessionId].input += parsed.input;
      totals[parsed.sessionId].output += parsed.output;
      totals[parsed.sessionId].cost += parsed.cost;
      totals[parsed.sessionId].ts = parsed.ts;
    }

    for (const [sessionId, t] of Object.entries(totals)) {
      if (t.input === 0 && t.output === 0) continue;
      this.emit(sessionId, t.projectName, t.input, t.output, t.cost, t.ts);
      log.debug("bootstrapped session tokens", { sessionId: sessionId.slice(0, 8), input: t.input, output: t.output });
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
      const parsed = parseUsageLine(line);
      if (!parsed) continue;
      const sessionId = parsed.sessionId || path.basename(filePath, ".jsonl");
      this.emit(sessionId, parsed.projectName, parsed.input, parsed.output, parsed.cost, Date.now());
      log.debug("journal token event", { sessionId: sessionId.slice(0, 8), input: parsed.input, output: parsed.output });
    }
  }

  private emit(sessionId: string, projectName: string, input: number, output: number, cost: number, ts: number): void {
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
