import { EventEmitter } from "events";
import { NormalizedEvent, SessionState, AppConfig, LifecycleState } from "../types";
import { v4 as uuidv4 } from "uuid";
import { makeLogger } from "../server/logger";

const log = makeLogger("SessionStore");

const SOFT_TURN = 10;
const CHECKPOINT_COOLDOWN_TURNS = 3;

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
  ) {
    super();
    this.state = makeEmptyState(sessionId ?? uuidv4(), projectName ?? "unknown");
  }

  apply(event: NormalizedEvent): void {
    // Drop out-of-order events older than 60s — avoids false drops when hook timestamps lag real-time
    if (event.timestamp_ms < this.lastEventTs - 60_000) {
      log.warn("dropped out-of-order event", { type: event.type, timestamp_ms: event.timestamp_ms });
      return;
    }

    if (event.type === "session_start") {
      this.state = makeEmptyState(this.state.session_id, this.state.project_name);
      this.recentTokenDeltas = [];
      this.checkpointSuggestedFiredForTurn = -1;
      this.checkpointMandatoryFiredForTurn = -1;
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

    if (event.type === "turn_end") {
      this.state.turns += 1;
      this.state.activity_state = "idle";
    } else {
      this.state.activity_state = "active";
    }
    if (event.type === "tool_use") {
      this.state.tool_calls_total += 1;
    }

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

  private updatePredictions(): void {
    const deltas = this.recentTokenDeltas;
    if (deltas.length >= 2) {
      const elapsed = (deltas[deltas.length - 1].ts - deltas[0].ts) / 1000;
      const total = deltas.reduce((s, d) => s + d.tokens, 0);
      this.state.burn_rate_per_sec = elapsed > 0 ? total / elapsed : 0;
    }
    this.state.tokens_per_turn_avg = this.state.turns > 0
      ? this.state.tokens_total / this.state.turns : 0;
    const remaining = this.cfg.token_threshold - this.state.tokens_total;
    this.state.eta_to_threshold_sec = this.state.burn_rate_per_sec > 0
      ? remaining / this.state.burn_rate_per_sec : Infinity;
  }

  private updateAlertLevel(): void {
    const pct = this.state.tokens_total / this.cfg.token_threshold;
    if (pct >= 0.9) this.state.alert_level = "red";
    else if (pct >= 0.7) this.state.alert_level = "yellow";
    else this.state.alert_level = "green";
  }

  private evaluateCheckpoints(): void {
    const { turns, tokens_total } = this.state;
    const lastSuggestedTurn = this.checkpointSuggestedFiredForTurn;
    const cooldownOk = lastSuggestedTurn === -1 ||
      turns - lastSuggestedTurn >= CHECKPOINT_COOLDOWN_TURNS;
    const tokenPct = tokens_total / this.cfg.token_threshold;

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
