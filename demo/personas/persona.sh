#!/usr/bin/env sh
# Start a Claude Code session as one demo persona (macOS/Linux/Git Bash).
#   ./persona.sh analyst-b analyst
#   ./persona.sh engineer engineer detection-eng
# The soc-ir-profile plugin must be installed. This only overrides who you are.
set -eu
if [ $# -lt 1 ]; then echo "Usage: persona.sh <name> <analyst|lead|manager|engineer> [team]"; exit 1; fi
export IR_ANALYST_NAME="$1"
export IR_ANALYST_ROLE="${2:-analyst}"
export IR_ANALYST_TEAM="${3:-}"
export IR_SERVER_URL="${IR_SERVER_URL:-http://127.0.0.1:7400}"
CFG="${TMPDIR:-/tmp}/ir-persona-$IR_ANALYST_NAME.json"
printf '{"mcpServers":{"incident-mcp":{"type":"http","url":"%s/mcp","headers":{"X-Analyst-Name":"%s","X-Analyst-Role":"%s","X-Analyst-Team":"%s"}}}}\n' \
  "$IR_SERVER_URL" "$IR_ANALYST_NAME" "$IR_ANALYST_ROLE" "$IR_ANALYST_TEAM" > "$CFG"
printf '\033]0;%s (%s)\007' "$IR_ANALYST_NAME" "$IR_ANALYST_ROLE"
exec claude --strict-mcp-config --mcp-config "$CFG"
