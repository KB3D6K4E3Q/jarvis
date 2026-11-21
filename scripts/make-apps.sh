#!/bin/bash
# Build two small Mac apps in /Applications that run scripts/jarvis.sh:
#
#   Jarvis.app       starts JARVIS in the background and opens it in Chrome
#   Stop Jarvis.app  turns it off
#
# Once they exist you can start JARVIS from Spotlight (Cmd-Space, "Jarvis"),
# the Dock, or by voice: "Hey Siri, open Jarvis".
# Re-run this if you move the jarvis folder.

set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# /Applications if we may write there (admin accounts can), else ~/Applications.
# JARVIS_APPS_DIR picks somewhere else.
if [ -n "${JARVIS_APPS_DIR:-}" ]; then DEST="$JARVIS_APPS_DIR"
elif [ -w /Applications ]; then DEST="/Applications"
else DEST="$HOME/Applications"; fi
mkdir -p "$DEST"
chmod +x "$HERE/scripts/jarvis.sh"

make_app() {
  local name="$1" action="$2"
  local src
  src="$(mktemp -t jarvis-app).applescript"
  # The path is passed as a quoted form, so spaces in it are safe.
  cat >"$src" <<EOF
do shell script quoted form of "$HERE/scripts/jarvis.sh" & " $action > /dev/null 2>&1 &"
EOF
  rm -rf "$DEST/$name.app"
  osacompile -o "$DEST/$name.app" "$src"
  rm -f "$src"
  # Keep it out of the Dock while it runs; it finishes in a moment anyway.
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$DEST/$name.app/Contents/Info.plist" 2>/dev/null || true
  # Changing Info.plist voids osacompile's signature; sign it again (ad hoc).
  codesign --force --sign - "$DEST/$name.app" >/dev/null 2>&1 || true
  echo "  made $DEST/$name.app"
}

make_app "Jarvis" start
make_app "Stop Jarvis" stop
# One copy of each, so Spotlight and Siri don't find two: drop copies an
# earlier run left in the other place (only ones that run this jarvis.sh).
for other in /Applications "$HOME/Applications"; do
  [ "$other" = "$DEST" ] && continue
  for name in "Jarvis" "Stop Jarvis"; do
    app="$other/$name.app"
    [ -d "$app" ] || continue
    if osadecompile "$app/Contents/Resources/Scripts/main.scpt" 2>/dev/null | grep -qF "$HERE/scripts/jarvis.sh"; then
      rm -rf "$app" && echo "  removed the old copy in $other"
    fi
  done
done
# Let Spotlight and Siri see them straight away.
mdimport "$DEST" 2>/dev/null || true
echo "Done. Try Cmd-Space, \"Jarvis\", or \"Hey Siri, open Jarvis\"."
