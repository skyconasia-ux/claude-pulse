import { EventEmitter } from "events";
import { NormalizedEvent, SessionState } from "../types";

export type CheckpointSeverity = "suggested" | "mandatory";

export interface EventBusEvents {
  event: (e: NormalizedEvent) => void;
  state_updated: (state: SessionState) => void;
  checkpoint_suggested: (state: SessionState) => void;
  checkpoint_mandatory: (state: SessionState) => void;
}

class TypedEventBus extends EventEmitter {
  on<K extends keyof EventBusEvents>(event: K, listener: EventBusEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  emit<K extends keyof EventBusEvents>(event: K, ...args: Parameters<EventBusEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

export const eventBus = new TypedEventBus();
