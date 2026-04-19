import fs from "fs";
import path from "path";
import os from "os";
import { eventBus } from "../monitor/EventBus";
import { makeLogger } from "../server/logger";
import { NormalizedEvent } from "../types";

const log = makeLogger("JournalWatcher");

const COST_PER_INPUT = 0.000003;
const COST_PER_OUTPUT = 0.000015;
const ACTIVE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const POLL_INTERVAL_MS = 1000;            // poll every second (fs.watch unreliable on Windows)

function extractProjectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() ?? "unknown";
}

interface ParsedLine {
  sessionId: string;
  projectName: string;
  model?: string;
  inputAbsolute: number;
  output: number;
  cost: number;
  toolCalls: number;
}

function parseUsageLine(line: string): ParsedLine | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== "assistant") return null;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, number> | undefined;
  if (!usage) return null;

  const inputAbsolute = (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  if (inputAbsolute === 0 && output === 0) return null;

  const cost = inputAbsolute * COST_PER_INPUT + output * COST_PER_OUTPUT;
  const model = (msg?.model as string | undefined) || undefined;

  // Count tool_use blocks inside this assistant message content
  const content = (msg?.content as Array<Record<string, unknown>> | undefined) ?? [];
  const toolCalls = content.filter(c => c.type === "tool_use").length;

  return {
    sessionId: (obj.sessionId as string) ?? "",
    projectName: extractProjectName(obj.cwd as string | undefined),
    model, inputAbsolute, output, cost, toolCalls,
  };
}

interface FileState {
  size: number;
  buf: string;
  prevInputAbsolute: number;
}

export class JournalWatcher {
  private claudeDir: string;
  private fileStates: Map<string, FileState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir ?? path.join(os.homedir(), ".claude", "projects");
  }

  start(): void {
    if (!fs.existsSync(this.claudeDir)) {
      log.warn("Claude projects dir not found — journal watching disabled", { path: this.claudeDir });
      return;
    }

    this.scanAndBootstrap();

    // Poll: scan for new files + read new lines from known files
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    log.info("polling Claude journals", { path: this.claudeDir, intervalMs: POLL_INTERVAL_MS });
  }

  private scanAndBootstrap(): void {
    try {
      for (const entry of fs.readdirSync(this.claudeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        this.bootstrapProjectDir(path.join(this.claudeDir, entry.name));
      }
    } catch (e) {
      log.warn("error scanning projects dir", { err: String(e) });
    }
  }

  private bootstrapProjectDir(dirPath: string): void {
    let candidates: { file: string; mtime: number }[] = [];
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
    } catch { return; }

    if (candidates.length === 0) return;
    // Most recent file only per project dir
    candidates.sort((a, b) => b.mtime - a.mtime);
    this.bootstrapFile(path.join(dirPath, candidates[0].file));
  }

  private bootstrapFile(filePath: string): void {
    if (this.fileStates.has(filePath)) return;

    let content: string;
    let size: number;
    try {
      content = fs.readFileSync(filePath, "utf8");
      size = fs.statSync(filePath).size;
    } catch { return; }

    // Compute correct session snapshot from all historical lines:
    // - latestInput  = most recent turn's context window size (NOT a sum)
    // - totalOutput  = sum of all output tokens
    // - totalCost    = sum of all per-turn costs
    const sessions: Record<string, {
      latestInput: number; totalOutput: number; totalCost: number;
      totalTools: number; turns: number; projectName: string; lastModel?: string;
    }> = {};

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const p = parseUsageLine(line);
      if (!p || !p.sessionId) continue;
      if (!sessions[p.sessionId]) {
        sessions[p.sessionId] = { latestInput: 0, totalOutput: 0, totalCost: 0, totalTools: 0, turns: 0, projectName: p.projectName };
      }
      sessions[p.sessionId].latestInput = p.inputAbsolute; // latest wins — current context size
      sessions[p.sessionId].totalOutput += p.output;
      sessions[p.sessionId].totalCost += p.cost;
      sessions[p.sessionId].totalTools += p.toolCalls;
      sessions[p.sessionId].turns += 1; // each assistant line = one completed turn
      if (p.model) sessions[p.sessionId].lastModel = p.model;
    }

    let prevInput = 0;
    for (const [sessionId, s] of Object.entries(sessions)) {
      if (s.latestInput === 0 && s.totalOutput === 0) continue;
      prevInput = s.latestInput;
      this.emitEvent(sessionId, s.projectName, s.latestInput, s.totalOutput, s.totalCost, s.lastModel, {
        bootstrapTurns: s.turns,
        toolsDelta: s.totalTools,
      });
      log.info("bootstrapped session", { session: sessionId.slice(0, 8), contextTokens: s.latestInput, turns: s.turns, tools: s.totalTools });
    }

    this.fileStates.set(filePath, { size, buf: "", prevInputAbsolute: prevInput });
  }

  private poll(): void {
    // Discover new project dirs and their most recent JSONL
    try {
      for (const entry of fs.readdirSync(this.claudeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(this.claudeDir, entry.name);
        // Find the most recent active JSONL in this dir
        let best: { file: string; mtime: number } | null = null;
        try {
          for (const f of fs.readdirSync(dirPath)) {
            if (!f.endsWith(".jsonl")) continue;
            try {
              const mtime = fs.statSync(path.join(dirPath, f)).mtimeMs;
              if (Date.now() - mtime < ACTIVE_WINDOW_MS) {
                if (!best || mtime > best.mtime) best = { file: f, mtime };
              }
            } catch { /* skip */ }
          }
        } catch { continue; }
        if (best) {
          const filePath = path.join(dirPath, best.file);
          if (!this.fileStates.has(filePath)) {
            // Evict any previously tracked file from this same directory
            for (const existing of this.fileStates.keys()) {
              if (path.dirname(existing) === dirPath) this.fileStates.delete(existing);
            }
            this.bootstrapFile(filePath);
          }
        }
      }
    } catch { /* skip */ }

    // Read new lines from all known files
    for (const filePath of this.fileStates.keys()) {
      this.readNewLines(filePath);
    }
  }

  private readNewLines(filePath: string): void {
    const state = this.fileStates.get(filePath);
    if (!state) return;

    let newSize: number;
    try { newSize = fs.statSync(filePath).size; } catch { return; }
    if (newSize <= state.size) return;

    const toRead = newSize - state.size;
    const buf = Buffer.alloc(toRead);
    let fd: number;
    try { fd = fs.openSync(filePath, "r"); } catch { return; }
    fs.readSync(fd, buf, 0, toRead, state.size);
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

      const inputDelta = Math.max(0, p.inputAbsolute - state.prevInputAbsolute);
      state.prevInputAbsolute = p.inputAbsolute;

      this.emitEvent(sessionId, p.projectName, inputDelta, p.output, p.cost, p.model, { toolsDelta: p.toolCalls });
      log.info("live token event", { session: sessionId.slice(0, 8), inputDelta, output: p.output, tools: p.toolCalls, model: p.model });
    }
  }

  private emitEvent(
    sessionId: string, projectName: string,
    input: number, output: number, cost: number,
    model: string | undefined,
    meta: Record<string, unknown> = {},
  ): void {
    const event: NormalizedEvent = {
      session_id: sessionId,
      project_name: projectName,
      model,
      source: "journal",
      type: "token_delta",
      tokens: { input, output },
      cost_usd: cost,
      timestamp_ms: Date.now(),
      metadata: meta,
    };
    eventBus.emit("event", event);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.fileStates.clear();
  }
}
