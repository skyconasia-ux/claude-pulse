# LiveVisualUsage

Real-time telemetry and visualization for Claude Code CLI.

## Quick Start

cp config.example.json config.json
npm install
npm run dev

Choose browser / terminal / both at startup.
Browser dashboard: http://localhost:3001/dashboard

## Claude Code Integration

Add to `.claude/settings.json`:

{
  "hooks": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @-" }] }]
  }
}

## Logs

While the server is running, tail `logs/app.log` for structured JSON output:

```bash
tail -f logs/app.log
```

Set `LOG_LEVEL=debug` to see verbose telemetry messages (hook events, WS snapshots, etc.):

```bash
LOG_LEVEL=debug npm run dev
```

## Stack
TypeScript · Node.js · ws · express · blessed-contrib

## Decisions log
See `decisions.md` for all design Q&A.
