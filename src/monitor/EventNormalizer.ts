import { NormalizedEvent } from "../types";

const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 0.000015,    output: 0.000075   },
  "claude-opus-4-5":   { input: 0.000015,    output: 0.000075   },
  "claude-sonnet-4-6": { input: 0.000003,    output: 0.000015   },
  "claude-sonnet-4-5": { input: 0.000003,    output: 0.000015   },
  "claude-haiku-4-5":  { input: 0.00000025,  output: 0.00000125 },
};

const DEFAULT_RATE = { input: 0.000003, output: 0.000015 };

function getRates(model?: string): { input: number; output: number } {
  if (!model) return DEFAULT_RATE;
  const key = Object.keys(MODEL_RATES)
    .sort((a, b) => b.length - a.length)
    .find(k => model.startsWith(k));
  return key ? MODEL_RATES[key] : DEFAULT_RATE;
}

function calcCost(input: number, output: number, model?: string): number {
  const r = getRates(model);
  return input * r.input + output * r.output;
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
  return "notification";
}

export function normalizeHookPayload(raw: Record<string, unknown>): NormalizedEvent {
  const usage = (raw.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const model = raw.model as string | undefined;
  return {
    session_id: raw.session_id as string | undefined,
    project_name: extractProjectName(raw.cwd as string | undefined),
    model,
    source: "hook",
    type: hookEventToType(raw.hook_event_name as string),
    tokens: { input, output },
    cost_usd: calcCost(input, output, model),
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
          const getInt = (key: string) => attrs.find(a => a.key === key)?.value?.intValue ?? 0;
          const getStrAttr = (key: string) => attrs.find(a => a.key === key)?.value?.stringValue;
          const input = getInt("input_tokens");
          const output = getInt("output_tokens");
          const model = getStrAttr("model");
          events.push({
            session_id: sessionId,
            project_name: extractProjectName(cwd),
            model,
            source: "otel",
            type: spanToType(span.name),
            tokens: { input, output },
            cost_usd: calcCost(input, output, model),
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
