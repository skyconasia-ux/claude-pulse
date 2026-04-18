import { EventEmitter } from "events";
import { NormalizedEvent, SessionState, AppConfig, LifecycleState } from "../types";
import { v4 as uuidv4 } from "uuid";
import { makeLogger } from "../server/logger";

const log = makeLogger("SessionStore");

const SOFT_TURN = 10;
const CHECKPOINT_COOLDOWN_TURNS = 3;

function parseNotificationPct(msg: string): number {
  const m = msg.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) : 70;
}

const MODEL_WEIGHT: Record<string, number> = {
  "claude-opus":   5,
  "claude-sonnet": 1,
  "claude-haiku":  0.08,
};

function modelWeight(model?: string): number {
  if (!model) return 1;
  if (model.includes("opus"))   return MODEL_WEIGHT["claude-opus"];
  if (model.includes("haiku"))  return MODEL_WEIGHT["claude-haiku"];
  return MODEL_WEIGHT["claude-sonnet"];
}

function makeEmptyState(sessionId: string, projectName: string): SessionState {
  return {
    session_id: sessionId,
    project_name: projectName,
    lifecycle: "running",
    last_seen_ms: Date.now(),
    is_stale: false,
    started_at: Date.now(),
    turns: 0,
    tool_calls_total: 0,
    tokens_total: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    activity_state: "idle",
    burn_rate_per_sec: 0,
    tokens_per_turn_avg: 0,
    eta_to_threshold_sec: Infinity,
    alert_level: "green",
    last_checkpoint_turn: 0,
    models: {},
  };
}

function eventTypeToLifecycle(type: NormalizedEvent["type"]): LifecycleState {
  if (type === "tool_use") return "tool_use";
  if (type === "turn_end") return "idle";
  if (type === "session_start") return "running";
  if (type === "session_end") return "closed";
  return "running";
}

export class SessionStore extends EventEmitter {
  private state: SessionState;
  private recentTokenDeltas: Array<{ tokens: number; ts: number }> = [];
  private lastEventTs: number = Date.now();
  private checkpointSuggestedFiredForTurn = -1;
  private checkpointMandatoryFiredForTurn = -1;

  constructor(
    private cfg: AppConfig,
    sessionId?: string,
    projectName?: string,
    initialState?: SessionState,
  ) {
    super();
    this.state = initialState
      ? { ...initialState }
      : makeEmptyState(sessionId ?? uuidv4(), projectName ?? "unknown");
  }

  apply(event: NormalizedEvent): void {
    // Drop out-of-order hook/otel events older than 60s — journal events are exempt (bootstrap data)
    if (event.source !== "journal" && event.timestamp_ms < this.lastEventTs - 60_000) {
      log.warn("dropped out-of-order event", { type: event.type, timestamp_ms: event.timestamp_ms });
      return;
    }

    if (!this.state.project_path && event.metadata.cwd) {
      this.state.project_path = String(event.metadata.cwd);
    }

    if (event.type === "session_start") {
      const savedPath = this.state.project_path;
      const savedFirstSeen = this.state.project_first_seen_ms;
      this.state = makeEmptyState(this.state.session_id, this.state.project_name);
      if (savedPath) this.state.project_path = savedPath;
      if (savedFirstSeen) this.state.project_first_seen_ms = savedFirstSeen;
      this.recentTokenDeltas = [];
      this.checkpointSuggestedFiredForTurn = -1;
      this.checkpointMandatoryFiredForTurn = -1;
      this.emit("state_updated", { ...this.state });
      return;
    }

    if (event.type === "token_delta") {
      this.state.is_stale = false;
      const bootstrapTurns = event.metadata.bootstrapTurns as number | undefined;
      const toolsDelta = (event.metadata.toolsDelta as number | undefined) ?? 0;

      if (bootstrapTurns !== undefined) {
        // Bootstrap: merge with persisted state using Math.max — never overwrite higher values
        this.state.tokens_in = Math.max(this.state.tokens_in, event.tokens.input);
        this.state.tokens_out = Math.max(this.state.tokens_out, event.tokens.output);
        this.state.tokens_total = this.state.tokens_in + this.state.tokens_out;
        this.state.cost_usd = Math.max(this.state.cost_usd, event.cost_usd);
        this.state.turns = Math.max(this.state.turns, bootstrapTurns);
        this.state.tool_calls_total = Math.max(this.state.tool_calls_total, toolsDelta);
        this.state.last_seen_ms = Math.max(this.state.last_seen_ms, event.timestamp_ms);
      } else {
        // Live event: accumulate deltas normally
        const tokenDelta = event.tokens.input + event.tokens.output;
        this.state.tokens_in += event.tokens.input;
        this.state.tokens_out += event.tokens.output;
        this.state.tokens_total += tokenDelta;
        this.state.cost_usd += event.cost_usd;
        this.state.last_seen_ms = event.timestamp_ms;
        this.state.turns += 1;
        this.state.tool_calls_total += toolsDelta;
        if (event.pid !== undefined) this.setPid(event.pid);
        this.accumulateModel(event);
      }

      const totalDelta = event.tokens.input + event.tokens.output;
      if (totalDelta > 0) {
        this.recentTokenDeltas.push({ tokens: totalDelta, ts: event.timestamp_ms });
        if (this.recentTokenDeltas.length > 10) this.recentTokenDeltas.shift();
      }
      this.updatePredictions();
      this.updateAlertLevel();
      this.evaluateCheckpoints();
      this.emit("state_updated", { ...this.state });
      return;
    }

    if (event.type === "notification") {
      const msg = String(event.metadata.message ?? "");
      const lower = msg.toLowerCase();
      if (lower.includes("limit") || lower.includes("usage") || lower.includes("%")) {
        this.state.last_notification = msg;
        const pct = parseNotificationPct(msg);
        this.state.notification_level = pct >= 90 ? "critical" : "warn";
      }
      this.state.last_seen_ms = event.timestamp_ms;
      this.emit("state_updated", { ...this.state });
      return;
    }

    if (event.type === "session_end") {
      this.state.activity_state = "idle";
      this.state.lifecycle = "closed";
      this.state.last_seen_ms = event.timestamp_ms;
      this.emit("state_updated", { ...this.state });
      return;
    }

    const tokenDelta = event.tokens.input + event.tokens.output;
    this.state.tokens_in += event.tokens.input;
    this.state.tokens_out += event.tokens.output;
    this.state.tokens_total += tokenDelta;
    this.state.cost_usd += event.cost_usd;
    this.state.lifecycle = eventTypeToLifecycle(event.type);
    this.state.last_seen_ms = event.timestamp_ms;
    this.state.is_stale = false;

    if (event.pid !== undefined) this.setPid(event.pid);

    if (event.type === "turn_end") {
      this.state.turns += 1;
      this.state.activity_state = "idle";
    } else {
      this.state.activity_state = "active";
    }
    if (event.type === "tool_use") {
      this.state.tool_calls_total += 1;
    }
    this.accumulateModel(event);

    this.lastEventTs = event.timestamp_ms;

    this.recentTokenDeltas.push({ tokens: tokenDelta, ts: event.timestamp_ms });
    if (this.recentTokenDeltas.length > 10) this.recentTokenDeltas.shift();
    this.updatePredictions();
    this.updateAlertLevel();
    this.evaluateCheckpoints();

    this.emit("state_updated", { ...this.state });
  }

  setLifecycle(lifecycle: LifecycleState): void {
    this.state.lifecycle = lifecycle;
    if (lifecycle === "stopped" || lifecycle === "closed") {
      this.state.activity_state = "idle";
    }
  }

  setStale(stale: boolean): void {
    this.state.is_stale = stale;
    if (stale) this.state.lifecycle = "closed";
  }

  setProjectFirstSeen(ms: number): void {
    this.state.project_first_seen_ms = ms;
  }

  private setPid(pid: number): void {
    this.state.pid = pid;
  }

  private accumulateModel(event: NormalizedEvent): void {
    const m = event.model ?? "unknown";
    if (!this.state.models) this.state.models = {};
    if (!this.state.models[m]) {
      this.state.models[m] = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    }
    this.state.models[m].tokens_in  += event.tokens.input;
    this.state.models[m].tokens_out += event.tokens.output;
    this.state.models[m].cost_usd   += event.cost_usd;
    this.state.model_last = m;
    const w = modelWeight(event.model);
    this.state.weighted_tokens_total =
      (this.state.weighted_tokens_total ?? 0) +
      (event.tokens.input + event.tokens.output) * w;
  }

  private updatePredictions(): void {
    const deltas = this.recentTokenDeltas;
    if (deltas.length >= 2) {
      const elapsed = (deltas[deltas.length - 1].ts - deltas[0].ts) / 1000;
      const total = deltas.reduce((s, d) => s + d.tokens, 0);
      this.state.burn_rate_per_sec = elapsed > 0 ? total / elapsed : 0;
    }
    this.state.tokens_per_turn_avg = this.state.turns > 0
      ? this.state.tokens_total / this.state.turns : 0;
    const effective = this.state.weighted_tokens_total ?? this.state.tokens_total;
    const remaining = this.cfg.token_threshold - effective;
    this.state.eta_to_threshold_sec = this.state.burn_rate_per_sec > 0
      ? remaining / this.state.burn_rate_per_sec : Infinity;
  }

  private updateAlertLevel(): void {
    const effective = this.state.weighted_tokens_total ?? this.state.tokens_total;
    const pct = effective / this.cfg.token_threshold;
    if (pct >= 0.9) this.state.alert_level = "red";
    else if (pct >= 0.7) this.state.alert_level = "yellow";
    else this.state.alert_level = "green";
  }

  private evaluateCheckpoints(): void {
    const { turns, tokens_total } = this.state;
    const lastSuggestedTurn = this.checkpointSuggestedFiredForTurn;
    const cooldownOk = lastSuggestedTurn === -1 ||
      turns - lastSuggestedTurn >= CHECKPOINT_COOLDOWN_TURNS;
    const effective = this.state.weighted_tokens_total ?? tokens_total;
    const tokenPct = effective / this.cfg.token_threshold;

    if (
      (tokenPct >= 0.9 || turns >= this.cfg.turn_threshold) &&
      turns !== this.checkpointMandatoryFiredForTurn
    ) {
      this.checkpointMandatoryFiredForTurn = turns;
      this.state.last_checkpoint_turn = turns;
      log.warn("checkpoint_mandatory fired", { turns, token_pct: (tokenPct * 100).toFixed(1) });
      this.emit("checkpoint_mandatory", { ...this.state });
      return;
    }

    if (
      cooldownOk &&
      (tokenPct >= 0.7 || turns >= SOFT_TURN) &&
      turns !== this.checkpointSuggestedFiredForTurn
    ) {
      this.checkpointSuggestedFiredForTurn = turns;
      this.state.last_checkpoint_turn = turns;
      log.info("checkpoint_suggested fired", { turns, token_pct: (tokenPct * 100).toFixed(1) });
      this.emit("checkpoint_suggested", { ...this.state });
    }
  }

  getState(): Readonly<SessionState> {
    return { ...this.state };
  }
}
