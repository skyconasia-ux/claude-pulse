import { SessionState } from "../../types";

export function pickMostActive(sessions: SessionState[]): SessionState | null {
  if (sessions.length === 0) return null;
  return sessions.slice().sort((a, b) => b.last_seen_ms - a.last_seen_ms)[0];
}

export function pickSelected(
  sessions: Map<string, SessionState>,
  selectedId: string,
): SessionState | null {
  if (sessions.has(selectedId)) return sessions.get(selectedId)!;
  return pickMostActive(Array.from(sessions.values()));
}

export function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  return `~${Math.round(sec / 60)}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function alertColor(level: SessionState["alert_level"]): string {
  if (level === "yellow") return "yellow";
  if (level === "red") return "red";
  return "green";
}

export function sessionRows(
  sessions: Map<string, SessionState>,
  selectedId: string,
): string[][] {
  return Array.from(sessions.values()).map(s => [
    s.session_id === selectedId ? "> " + s.project_name : "  " + s.project_name,
    s.lifecycle.toUpperCase(),
    fmtTokens(s.tokens_total),
    `$${s.cost_usd.toFixed(4)}`,
    s.alert_level.toUpperCase(),
  ]);
}

export function shortModelName(model: string | undefined): string {
  if (!model) return "—";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}
