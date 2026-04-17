import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState, WsMessage } from "../types";

export class WsBroadcaster {
  private wss: WebSocketServer;
  private currentState: SessionState | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws: WebSocket) => {
      if (this.currentState) {
        const msg: WsMessage = { type: "snapshot", state: this.currentState };
        ws.send(JSON.stringify(msg));
      }
      ws.on("error", () => {});
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
        client.send(payload);
      }
    }
  }
}
