export type LifecycleState =
  | "not_launched" | "running" | "thinking" | "tool_use"
  | "idle" | "waiting" | "cancelled" | "closed"
  | "ctrl_c" | "stopped" | "unknown";

export interface NormalizedEvent {
  session_id?: string;
  project_name?: string;
  model?: string;
  pid?: number;
  source: "hook" | "otel" | "journal";
  type: "session_start" | "session_end" | "tool_use" | "turn_end" | "notification" | "token_delta";
  tokens: { input: number; output: number };
  cost_usd: number;
  timestamp_ms: number;
  metadata: Record<string, unknown>;
}

export interface SessionState {
  session_id: string;
  project_name: string;
  project_path?: string;
  lifecycle: LifecycleState;
  last_seen_ms: number;
  is_stale: boolean;
  started_at: number;
  turns: number;
  tool_calls_total: number;
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
  last_notification?: string;
  notification_level?: "warn" | "critical";
  notification_received_ms?: number;
  notification_tokens_at_report?: number;   // session tokens_total when this notification arrived
  notification_pct_at_report?: number;      // % Claude Code reported at that moment
  last_notification_weekly?: string;
  notification_level_weekly?: "warn" | "critical";
  notification_weekly_received_ms?: number;
  derived_account_limit?: number;           // estimated account token limit, derived from 2+ notifications
  project_first_seen_ms?: number;
  model_last?: string;                  // set by SessionStore.accumulateModel
  pid?: number;
  models?: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number }>; // set by SessionStore.accumulateModel
  weighted_tokens_total?: number;       // Sonnet-equivalent budget units, set by SessionStore.accumulateModel
}

export interface AccountInfo {
  subscriptionType: string;   // "pro" | "free" | "max" | …
  rateLimitTier: string;      // "default_claude_ai" | "extra_usage_claude_ai" | …
}

export type WsMessage =
  | { type: "sessions_snapshot"; sessions: SessionState[]; accountInfo?: AccountInfo }
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
