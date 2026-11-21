#!/bin/bash
# Start JARVIS automatically when you log in to this Mac, or stop doing so.
#
#   scripts/autostart.sh on       start at every login (in the background,
#                                 then opens it in Chrome)
#   scripts/autostart.sh off      don't start at login any more
#   scripts/autostart.sh status
#
# It's a LaunchAgent in ~/Library/LaunchAgents, so it is yours alone and needs
# no admin password. macOS lists it under System Settings → General → Login
# Items & Extensions, where you can also switch it off.

set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.jarvis.autostart"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

on() {
  chmod +x "$HERE/scripts/jarvis.sh"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.jarvis/logs"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/scripts/jarvis.sh</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- jarvis.sh hands off to a background process and exits; keep that process alive. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$HOME/.jarvis/logs/autostart.log</string>
  <key>StandardErrorPath</key><string>$HOME/.jarvis/logs/autostart.log</string>
</dict>
</plist>
EOF
  plutil -lint -s "$PLIST"
  # Register it for future logins. RunAtLoad also starts JARVIS right now.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  echo "JARVIS will start when you log in."
}

off() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "JARVIS will no longer start at login."
}

case "${1:-status}" in
  on) on ;;
  off) off ;;
  status) if [ -f "$PLIST" ]; then echo "Autostart is on."; else echo "Autostart is off."; fi ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
