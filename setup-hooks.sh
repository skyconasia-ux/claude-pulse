#!/usr/bin/env bash
# Claude Pulse — Hook Setup Script (Mac / Linux)
# Merges required hooks into ~/.claude/settings.json without overwriting existing config.

SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD='curl -s -X POST http://localhost:3001/hook -H "Content-Type: application/json" --data-binary @- 2>/dev/null || true'

echo ""
echo "  Claude Pulse Hook Setup"
echo "  =========================="
echo ""

if ! command -v python3 &>/dev/null; then
  echo "  ERROR: python3 not found — required for JSON manipulation."
  exit 1
fi

# Create settings file if it doesn't exist
if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  echo "{}" > "$SETTINGS"
  echo "  Created new settings: $SETTINGS"
else
  echo "  Found existing settings: $SETTINGS"
fi

python3 - "$SETTINGS" "$HOOK_CMD" <<'PYEOF'
import sys, json, copy

settings_path = sys.argv[1]
hook_cmd      = sys.argv[2]

with open(settings_path, "r", encoding="utf-8") as f:
    settings = json.load(f)

if "hooks" not in settings:
    settings["hooks"] = {}

hook_entry = {"type": "command", "command": hook_cmd}

def upsert_hook(event, matcher):
    hooks = settings["hooks"]
    entry = {"hooks": [hook_entry]}
    if matcher:
        entry["matcher"] = matcher

    if event not in hooks:
        hooks[event] = [entry]
        print(f"  {event} hook added")
        return

    existing = hooks[event]
    for item in existing:
        for h in item.get("hooks", []):
            if h.get("command") == hook_cmd:
                print(f"  {event} hook already configured — skipped")
                return

    hooks[event] = existing + [entry]
    print(f"  {event} hook added")

upsert_hook("PostToolUse", "*")
upsert_hook("Stop", None)
upsert_hook("Notification", None)

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)
PYEOF

echo ""
echo "  Done. Restart Claude Code for hooks to take effect."
echo ""
