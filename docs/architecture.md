# Live Visual Usage Monitor — Architecture
Status: Initialized

## Pattern
Adapter-Based Pipeline — single Node.js process.

## Components
- HooksAdapter: receives Claude Code hooks via POST /hook
- OtelAdapter: receives OTEL spans via POST /otel (optional)
- EventNormalizer: converts raw payloads to NormalizedEvent
- EventBus: internal typed pub/sub (EventEmitter)
- SessionStore: maintains SessionState, emits checkpoints
- WsBroadcaster: pushes snapshots/deltas to all WS clients
- Browser Dashboard: Neon Cyber HTML/JS at /dashboard
- Terminal Dashboard: blessed-contrib WS client

## Ports
- HTTP + WS: 3001 (configured in config.json)
