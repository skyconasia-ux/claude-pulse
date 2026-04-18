#!/usr/bin/env bash
set -e

echo ""
echo "  Claude Pulse - Claude Code Session Monitor"
echo "  ================================================"
echo ""

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js not found."
  echo "  Install from https://nodejs.org (LTS) then run this again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run: installing dependencies..."
  echo ""
  npm ci --omit=dev
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "  Created config.json from template."
fi

node dist/server/index.js
