import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState, WsMessage, AccountInfo } from "../types";
import { makeLogger } from "./logger";

const log = makeLogger("WsBroadcaster");

export class WsBroadcaster {
  private wss: WebSocketServer;
  private sessions: SessionState[] = [];
  private noClientsCallback?: () => void;
  private newClientCallback?: () => void;
  private sessionUpdateCallback?: (state: SessionState) => void;
  private accountInfo?: AccountInfo;

  constructor(server: Server, accountInfo?: AccountInfo) {
    this.accountInfo = accountInfo;
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws: WebSocket) => {
      log.info("client connected", { clients: this.wss.clients.size });
      this.newClientCallback?.();
      const msg: WsMessage = { type: "sessions_snapshot", sessions: this.sessions, accountInfo: this.accountInfo };
      try {
        ws.send(JSON.stringify(msg));
        log.debug("sessions_snapshot sent to new client", { session_count: this.sessions.length });
      } catch (err) {
        log.error("failed to send snapshot", { message: (err as Error).message });
      }
      const connectedAt = Date.now();
      ws.on("close", () => {
        log.info("client disconnected", { clients: this.wss.clients.size - 1 });
        const duration = Date.now() - connectedAt;
        // setImmediate ensures the ws library has removed the client from wss.clients before we check
        // Only trigger shutdown if the connection was stable for > 3s — ignores page refreshes and load-time flickers
        setImmediate(() => {
          if (this.wss.clients.size === 0 && duration >= 3000) this.noClientsCallback?.();
        });
      });
      ws.on("error", (err) => log.error("client socket error", { message: err.message }));
    });
  }

  onNoClients(cb: () => void): void { this.noClientsCallback = cb; }
  onNewClient(cb: () => void): void { this.newClientCallback = cb; }
  onSessionUpdate(cb: (state: SessionState) => void): void { this.sessionUpdateCallback = cb; }

  close(): void {
    for (const client of this.wss.clients) client.close();
    this.wss.close();
  }

  setSession(state: SessionState): void {
    const idx = this.sessions.findIndex(s => s.session_id === state.session_id);
    if (idx >= 0) this.sessions[idx] = state;
    else this.sessions.push(state);
  }

  broadcastSessionUpdate(state: SessionState): void {
    this.setSession(state);
    this.sessionUpdateCallback?.(state);
    const msg: WsMessage = { type: "session_updated", session: state };
    this.broadcast(msg);
  }

  broadcastCheckpoint(severity: "suggested" | "mandatory", state: SessionState): void {
    const msg: WsMessage = { type: "checkpoint_event", severity, state };
    this.broadcast(msg);
  }

  private broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err) {
          log.error("broadcast send failed", { message: (err as Error).message });
        }
      }
    }
  }
}
