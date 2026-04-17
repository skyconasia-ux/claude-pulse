import fs from "fs";
import path from "path";
import { AppConfig } from "./types";

const raw = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf-8")
);

export const config: AppConfig = {
  token_threshold: raw.token_threshold ?? 100000,
  turn_threshold: raw.turn_threshold ?? 20,
  refresh_active_ms: raw.refresh_active_ms ?? 1000,
  refresh_idle_ms: raw.refresh_idle_ms ?? 5000,
  server_port: raw.server_port ?? 3001,
  ws_port: raw.ws_port ?? 3001,
  otel_enabled: raw.otel_enabled ?? true,
};
