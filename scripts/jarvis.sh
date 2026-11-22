#!/bin/bash
# Start, stop or check JARVIS in the background, with no terminal window.
#
#   scripts/jarvis.sh start    start (if needed) and open it in Chrome
#   scripts/jarvis.sh stop     stop the brain and the face
#   scripts/jarvis.sh status   say whether it is running
#
# Used by the "Jarvis" and "Stop Jarvis" apps that scripts/make-apps.sh builds.
# Logs go to ~/.jarvis/logs/jarvis.log. Set JARVIS_WRITES=1 to start it with
# full computer control (same as `npm start -- --writes`), either in the
# environment or in ~/.jarvis/launch.env, which is read on every start.

set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.jarvis"
PIDFILE="$STATE/jarvis.pid"
LOG="$STATE/logs/jarvis.log"
URL="http://localhost:5173"
mkdir -p "$STATE/logs"
# shellcheck disable=SC1091
# Exported, so settings like ELEVENLABS_API_KEY and JARVIS_VOICE_ID reach JARVIS.
if [ -f "$STATE/launch.env" ]; then set -a; . "$STATE/launch.env"; set +a; fi

# "Mute me" turns the Mac's microphone down to zero. Starting or stopping
# JARVIS always puts it back, so it can never be left muted by accident.
restore_mic() {
  local f="$STATE/state/mic.json"
  [ -f "$f" ] || return 0
  grep -q '"muted": true' "$f" || return 0
  local level
  level=$(sed -n 's/.*"level": *\([0-9][0-9]*\).*/\1/p' "$f")
  osascript -e "set volume input volume ${level:-60}" >/dev/null 2>&1 &&
    printf '{\n  "muted": false,\n  "level": %s\n}\n' "${level:-60}" >"$f"
}

# Apps launched from Finder or Siri get a bare PATH, so find Node ourselves.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  [ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
fi

# The brain's port. Must match bridge/port.mjs (and VITE_BRIDGE_URL if you
# change it). Not 8787: other local tools, such as the Headroom proxy, use it.
BRIDGE_PORT="${JARVIS_BRIDGE_PORT:-8788}"
FACE_PORT=5173

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
running() { listening "$BRIDGE_PORT" && listening "$FACE_PORT"; }

notify() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "JARVIS"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

# The face gets its own Chrome window with its own profile, started so that
# it needs no clicks: sound plays without a gesture, the microphone is already
# allowed for this one local page, and the page powers itself up (?auto=1).
# Your normal Chrome, its tabs and its settings are untouched.
CHROME="/Applications/Google Chrome.app"
PROFILE="$STATE/chrome-profile"
face_open() { pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; }

allow_mic() {
  # Only while that Chrome is closed, or it would overwrite the change.
  face_open && return 0
  mkdir -p "$PROFILE/Default"
  node -e '
    const fs = require("fs"), f = process.argv[1]
    let p = {}
    try { p = JSON.parse(fs.readFileSync(f, "utf8")) } catch {}
    const ex = (((p.profile ??= {}).content_settings ??= {}).exceptions ??= {})
    for (const k of ["media_stream_mic"]) (ex[k] ??= {})["http://localhost:5173,*"] = { setting: 1 }
    fs.writeFileSync(f, JSON.stringify(p))
  ' "$PROFILE/Default/Preferences" 2>/dev/null || true
}

open_face() {
  if [ ! -d "$CHROME" ]; then open "$URL"; return; fi
  # Already showing: don't start a second face that would also be listening.
  face_open && return 0
  allow_mic
  # Your normal Chrome, where the Claude extension lives, so JARVIS can use the
  # browser from the first question. Started hidden, with no window.
  if ! ps -axo args= | grep -F "Google Chrome.app/Contents/MacOS/Google Chrome" | grep -vqE -- "--user-data-dir=|--type=|grep"; then
    open -g -na "$CHROME" --args --no-startup-window
    sleep 2
  fi
  open -na "$CHROME" --args \
    --user-data-dir="$PROFILE" \
    --app="$URL/?auto=1" \
    --autoplay-policy=no-user-gesture-required \
    --no-first-run --no-default-browser-check \
    --start-fullscreen \
    --window-size=1440,900
  # Fullscreen from the first frame; the window size is what it drops back to
  # on Cmd+Ctrl+F. Chrome's own fullscreen, not the page's: Esc would end the
  # page kind, and Esc is already how JARVIS is stood down.
}

close_face() {
  pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null || true
}

start() {
  restore_mic
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
    running || listening "$BRIDGE_PORT" || listening "$FACE_PORT" || break
    sleep 0.5
  done
  # Node processes only: the port can belong to some other program entirely,
  # and stopping JARVIS must never take that down with it.
  for port in "$BRIDGE_PORT" "$FACE_PORT"; do
    for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
      case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
        *node*) kill -TERM "$pid" 2>/dev/null ;;
      esac
    done
  done
  close_face
  restore_mic
  notify "JARVIS is off."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) if running; then echo "JARVIS is running at $URL"; else echo "JARVIS is not running"; fi ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
