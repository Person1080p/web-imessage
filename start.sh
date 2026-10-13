#!/bin/bash
# Start web-imessage and keep the Mac awake while it runs. The display stays on too: incoming calls are read
# from the call banner on screen, and a sleeping display shows (and locks behind) a black screen.
cd "$(dirname "$0")"
# Build the call helper the first time (and whenever its source changes).
if [ ! -x bridge/callbridge ] || [ bridge/callbridge.swift -nt bridge/callbridge ]; then
  echo "Building call helper…"
  swiftc -O -o bridge/callbridge bridge/callbridge.swift || echo "Call helper failed to build; calls will be unavailable."
fi
exec caffeinate -i -d /usr/bin/python3 server.py "$@"
