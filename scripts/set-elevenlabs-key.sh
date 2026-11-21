#!/bin/bash
# Save your ElevenLabs API key for JARVIS, without it showing on screen.
# Writes ELEVENLABS_API_KEY into ~/.jarvis/launch.env (readable only by you).
set -eu
FILE="$HOME/.jarvis/launch.env"
mkdir -p "$(dirname "$FILE")"
touch "$FILE"
chmod 600 "$FILE"

printf 'Paste your ElevenLabs API key and press Enter (it stays hidden): '
IFS= read -rs KEY
echo
# Drop stray spaces, quotes and line breaks a copy can bring along.
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]"'"'")"
if [ -z "$KEY" ]; then
  echo "Nothing pasted — no change made."
  exit 1
fi

# Replace the existing line, or add one.
TMP="$(mktemp)"
grep -v '^ELEVENLABS_API_KEY=' "$FILE" >"$TMP" || true
printf 'ELEVENLABS_API_KEY=%s\n' "$KEY" >>"$TMP"
mv "$TMP" "$FILE"
chmod 600 "$FILE"
echo "Saved (${#KEY} characters). Restart JARVIS to use it."
