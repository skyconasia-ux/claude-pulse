export type LifecycleState =
  | "not_launched" | "running" | "thinking" | "tool_use"
  | "idle" | "waiting" | "cancelled" | "closed"
  | "ctrl_c" | "stopped" | "unknown";

export interface NormalizedEvent {
  session_id?: string;
  project_name?: string;
  source: "hook" | "otel";
  type: "session_start" | "session_end" | "tool_use" | "turn_end" | "notification";
  tokens: { input: number; output: number };
  cost_usd: number;
  timestamp_ms: number;
  metadata: Record<string, unknown>;
}

export interface SessionState {
  session_id: string;
  project_name: string;
  lifecycle: LifecycleState;
  last_seen_ms: number;
  is_stale: boolean;
  started_at: number;
  turns: number;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  activity_state: "active" | "idle";
  burn_rate_per_sec: number;
  tokens_per_turn_avg: number;
  eta_to_threshold_sec: number;
  alert_level: "green" | "yellow" | "red";
  last_checkpoint_turn: number;
}

export type WsMessage =
  | { type: "sessions_snapshot"; sessions: SessionState[] }
  | { type: "session_updated"; session: SessionState }
  | { type: "checkpoint_event"; severity: "suggested" | "mandatory"; state: SessionState };

export interface AppConfig {
  token_threshold: number;
  turn_threshold: number;
  refresh_active_ms: number;
  refresh_idle_ms: number;
  server_port: number;
  ws_port: number;
  otel_enabled: boolean;
}
