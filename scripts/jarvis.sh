#!/bin/bash
# Start, stop or check JARVIS in the background, with no terminal window.
#
#   scripts/jarvis.sh start    start (if needed) and open it in Chrome
#   scripts/jarvis.sh stop     stop the brain and the face
#   scripts/jarvis.sh status   say whether it is running
#
# Used by the "Jarvis" and "Stop Jarvis" apps that scripts/make-apps.sh builds.
# Logs go to ~/.jarvis/logs/jarvis.log. Set JARVIS_WRITES=1 to start it with
# real actions allowed (same as `npm start -- --writes`).

set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.jarvis"
PIDFILE="$STATE/jarvis.pid"
LOG="$STATE/logs/jarvis.log"
URL="http://localhost:5173"
mkdir -p "$STATE/logs"

# Apps launched from Finder or Siri get a bare PATH, so find Node ourselves.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  [ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
fi

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
running() { listening 8787 && listening 5173; }

notify() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "JARVIS"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

open_face() {
  if [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$URL"; else open "$URL"; fi
}

start() {
  if running; then
    open_face
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    notify "Node.js was not found, so JARVIS can't start."
    exit 1
  fi
  notify "Starting up…"
  cd "$HERE" || exit 1
  # A clean environment for the brain: no Ollama or other redirect of Claude.
  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL
  args=()
  [ "${JARVIS_WRITES:-0}" = "1" ] && args=(--writes)
  echo "---- $(date) start ----" >>"$LOG"
  nohup node scripts/start.mjs "${args[@]+"${args[@]}"}" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 60); do
    if running; then
      open_face
      return 0
    fi
    sleep 0.5
  done
  notify "JARVIS didn't start. See ~/.jarvis/logs/jarvis.log"
  exit 1
}

stop() {
  if [ -f "$PIDFILE" ]; then
    kill -TERM "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
  fi
  # Anything still holding JARVIS's ports (e.g. started with `npm start`).
  for _ in 1 2 3 4 5 6; do
    running || listening 8787 || listening 5173 || break
    sleep 0.5
  done
  for port in 8787 5173; do
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
    [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
  done
  notify "JARVIS is off."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) if running; then echo "JARVIS is running at $URL"; else echo "JARVIS is not running"; fi ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
