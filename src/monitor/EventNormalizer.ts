import { NormalizedEvent } from "../types";

const COST_PER_INPUT_TOKEN = 0.000003;
const COST_PER_OUTPUT_TOKEN = 0.000015;

function calcCost(input: number, output: number): number {
  return input * COST_PER_INPUT_TOKEN + output * COST_PER_OUTPUT_TOKEN;
}

function extractProjectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() ?? "unknown";
}

type HookEventName = "PostToolUse" | "Stop" | "Notification" | string;

function hookEventToType(name: HookEventName): NormalizedEvent["type"] {
  if (name === "PostToolUse") return "tool_use";
  if (name === "Stop") return "turn_end";
  if (name === "Notification") return "notification";
  return "notification";
}

export function normalizeHookPayload(raw: Record<string, unknown>): NormalizedEvent {
  const usage = (raw.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    session_id: raw.session_id as string | undefined,
    project_name: extractProjectName(raw.cwd as string | undefined),
    source: "hook",
    type: hookEventToType(raw.hook_event_name as string),
    tokens: { input, output },
    cost_usd: calcCost(input, output),
    timestamp_ms: (raw.timestamp_ms as number) || Date.now(),
    metadata: raw,
  };
}

interface OtelAttribute {
  key: string;
  value: { intValue?: number; stringValue?: string };
}

interface OtelSpan {
  name: string;
  startTimeUnixNano: string;
  attributes?: OtelAttribute[];
}

function spanToType(name: string): NormalizedEvent["type"] {
  if (name.includes("tool")) return "tool_use";
  if (name.includes("turn")) return "turn_end";
  if (name.includes("session_start")) return "session_start";
  if (name.includes("session_end")) return "session_end";
  return "notification";
}

export function normalizeOtelPayload(raw: Record<string, unknown>): NormalizedEvent[] {
  try {
    const resourceSpans = raw.resourceSpans as Array<{
      resource?: { attributes?: OtelAttribute[] };
      scopeSpans: Array<{ spans: OtelSpan[] }>;
    }>;
    if (!Array.isArray(resourceSpans)) return [];
    const events: NormalizedEvent[] = [];
    for (const rs of resourceSpans) {
      const resAttrs = rs.resource?.attributes ?? [];
      const getStr = (key: string) => resAttrs.find(a => a.key === key)?.value?.stringValue;
      const sessionId = getStr("session.id");
      const cwd = getStr("process.cwd");
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const attrs = span.attributes ?? [];
          const get = (key: string) => attrs.find(a => a.key === key)?.value?.intValue ?? 0;
          const input = get("input_tokens");
          const output = get("output_tokens");
          events.push({
            session_id: sessionId,
            project_name: extractProjectName(cwd),
            source: "otel",
            type: spanToType(span.name),
            tokens: { input, output },
            cost_usd: calcCost(input, output),
            timestamp_ms: Math.floor(Number(span.startTimeUnixNano) / 1_000_000),
            metadata: span as unknown as Record<string, unknown>,
          });
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}
