import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState, WsMessage } from "../types";
import { makeLogger } from "./logger";

const log = makeLogger("WsBroadcaster");

export class WsBroadcaster {
  private wss: WebSocketServer;
  private currentState: SessionState | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws: WebSocket) => {
      log.info("client connected", { clients: this.wss.clients.size });
      if (this.currentState) {
        const msg: WsMessage = { type: "snapshot", state: this.currentState };
        ws.send(JSON.stringify(msg));
        log.debug("snapshot sent to new client");
      }
      ws.on("close", () => log.info("client disconnected", { clients: this.wss.clients.size - 1 }));
      ws.on("error", (err) => log.error("client socket error", { message: err.message }));
    });
  }

  setState(state: SessionState): void {
    this.currentState = state;
  }

  broadcastDelta(changes: Partial<SessionState>): void {
    if (this.currentState) {
      this.currentState = { ...this.currentState, ...changes };
    }
    const msg: WsMessage = { type: "delta", changes };
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
