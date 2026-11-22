#!/bin/bash
# Clap three times to start JARVIS.
#
#   scripts/clap.sh on       build the listener and run it now and at every login
#   scripts/clap.sh off      stop listening and don't start at login any more
#   scripts/clap.sh status
#
# The listener is a tiny background app (scripts/clap/ClapListener.swift) built
# into ~/.jarvis/ClapListener.app. The first time it runs, macOS asks whether it
# may use the microphone. It only measures loudness; nothing is recorded.
# Logs: ~/.jarvis/logs/clap.log

set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/.jarvis/ClapListener.app"
LABEL="local.jarvis.clap"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$HOME/.jarvis/logs/clap.log"

build() {
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$HOME/.jarvis/logs"
  swiftc -O -o "$APP/Contents/MacOS/ClapListener" "$HERE/scripts/clap/ClapListener.swift" \
    -framework AVFoundation
  cat >"$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.jarvis.claplistener</string>
  <key>CFBundleName</key><string>Jarvis Clap Listener</string>
  <key>CFBundleExecutable</key><string>ClapListener</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Listens for three claps to start JARVIS. Nothing is recorded.</string>
</dict>
</plist>
PL
  codesign --force --sign - "$APP" >/dev/null
  echo "  built $APP"
}

on() {
  chmod +x "$HERE/scripts/jarvis.sh"
  build
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/ClapListener</string>
    <string>$HERE/scripts/jarvis.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- JARVIS itself is started in the background; don't kill it with the listener. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
  plutil -lint -s "$PLIST"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Listening. Clap three times to start JARVIS — now and after every login."
}

off() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "No longer listening for claps."
}

case "${1:-status}" in
  on) on ;;
  off) off ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then echo "Clap listener is on."
    else echo "Clap listener is off."; fi ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
