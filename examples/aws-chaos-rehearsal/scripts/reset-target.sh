#!/usr/bin/env bash
# Reset target/src/server.ts to the fragile baseline, kill any running
# tsx target, and restart it. Used between drill runs so the next agent
# starts from a clean broken state.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cp "$HERE/target/src/server.fragile.ts" "$HERE/target/src/server.ts"
pkill -f "tsx.*server.ts" 2>/dev/null || true
sleep 0.5
(cd "$HERE" && nohup npx tsx target/src/server.ts > /tmp/target.log 2>&1 &)
sleep 2
curl -s http://localhost:3000/ -m 3 && echo " | target up (fragile baseline)"
