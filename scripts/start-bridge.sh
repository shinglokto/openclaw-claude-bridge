#!/bin/zsh
set -euo pipefail
ENV_FILE="$HOME/.config/openclaw/claude-bridge.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi
unset OPENAI_API_KEY
set -a
source "$ENV_FILE"
set +a
exec /opt/homebrew/bin/node src/index.js
