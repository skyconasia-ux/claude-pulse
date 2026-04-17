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

## Stack
TypeScript · Node.js · ws · express · blessed-contrib

## Decisions log
See `decisions.md` for all design Q&A.
