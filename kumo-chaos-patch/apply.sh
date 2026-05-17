#!/usr/bin/env bash
# Apply the chaos patch to a kumo checkout.
#
# Usage:
#   ./apply.sh /path/to/kumo-fork
#
# Each edit is independently idempotent — re-running after a partial failure
# is safe. Anchors use whitespace-tolerant regex so gofmt's column alignment
# does not break the patch.
#
# Targets sivchari/kumo with PR #667 (config-driven latency emulator) merged.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <kumo-checkout-path>" >&2
  exit 64
fi

KUMO_DIR=$(cd "$1" && pwd)
PATCH_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

require_file() {
  [[ -f "$KUMO_DIR/$1" ]] || { echo "ERROR: missing $1 in $KUMO_DIR — wrong path or kumo layout changed" >&2; exit 1; }
}
require_file go.mod
require_file internal/server/server.go
require_file internal/server/router.go
require_file internal/awsapi/request.go
require_file internal/latency/types.go

# ---- 1. copy new package + handler files (overwrite; this script owns these paths) ----
mkdir -p "$KUMO_DIR/internal/chaos"
cp "$PATCH_DIR"/internal/chaos/*.go "$KUMO_DIR/internal/chaos/"
cp "$PATCH_DIR"/internal/server/chaos_handlers.go "$KUMO_DIR/internal/server/"
cp "$PATCH_DIR"/internal/server/chaos_wire.go "$KUMO_DIR/internal/server/"
echo "[copy] chaos package + server handlers installed"

# ---- 2. helpers ----
insert_after() {
  # insert_after FILE ANCHOR_REGEX NEW_LINE
  local file="$1" anchor="$2" newline="$3"
  python3 - "$file" "$anchor" "$newline" <<'PY'
import re, sys
file, anchor, newline = sys.argv[1], sys.argv[2], sys.argv[3]
with open(file) as f:
    text = f.read()
# Idempotency: don't insert if the new line is already in the file.
if newline.strip() and newline.strip() in text:
    sys.exit(0)
pat = re.compile(anchor, re.MULTILINE)
m = pat.search(text)
if not m:
    sys.stderr.write(f"anchor not found in {file}: {anchor!r}\n")
    sys.exit(2)
end = text.find("\n", m.end()) + 1
text = text[:end] + newline + ("\n" if not newline.endswith("\n") else "") + text[end:]
with open(file, "w") as f:
    f.write(text)
PY
}

# ---- 3. patch internal/server/server.go ----
SRV="$KUMO_DIR/internal/server/server.go"

# 3a. import
if ! grep -q '"github.com/sivchari/kumo/internal/chaos"' "$SRV"; then
  insert_after "$SRV" '^\s*"github\.com/sivchari/kumo/internal/latency"$' $'\t"github.com/sivchari/kumo/internal/chaos"'
  echo "[edit] server.go: added chaos import"
fi

# 3b. Config.ChaosEnabled
if ! grep -qE '^\s*ChaosEnabled\s+bool' "$SRV"; then
  insert_after "$SRV" '^\s*LatencyConfig\s+string.*$' $'\tChaosEnabled  bool   // Enables /kumo/chaos/* runtime endpoints'
  echo "[edit] server.go: added Config.ChaosEnabled"
fi

# 3c. Server.chaosEngine field
if ! grep -qE '^\s*chaosEngine\s+\*chaos\.Engine' "$SRV"; then
  insert_after "$SRV" '^\s*latencyEngine\s+\*latency\.Engine\s*$' $'\tchaosEngine     *chaos.Engine'
  echo "[edit] server.go: added Server.chaosEngine"
fi

# 3d. New(): wire chaos after latency-config block.
if ! grep -q 'srv.SetChaosEngine(' "$SRV"; then
  python3 - "$SRV" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
anchor = re.compile(r'logger\.Info\("loaded latency config".*?\n\t\t\}\n\t\}\n', re.S)
m = anchor.search(text)
if not m:
    sys.stderr.write("could not find latency-config block to anchor on\n")
    sys.exit(2)
inject = (
    "\n"
    "\tif config.ChaosEnabled || os.Getenv(\"KUMO_CHAOS_ENABLED\") == \"1\" {\n"
    "\t\tsrv.SetChaosEngine(chaos.NewEngine(catalog))\n"
    "\t}\n"
)
end = m.end()
text = text[:end] + inject + text[end:]
with open(path, "w") as f:
    f.write(text)
PY
  echo "[edit] server.go: wired SetChaosEngine in New()"
fi

# ---- 4. patch internal/server/router.go ----
RTR="$KUMO_DIR/internal/server/router.go"

# 4a. import
if ! grep -q '"github.com/sivchari/kumo/internal/chaos"' "$RTR"; then
  insert_after "$RTR" '^\s*"github\.com/sivchari/kumo/internal/latency"$' $'\t"github.com/sivchari/kumo/internal/chaos"'
  echo "[edit] router.go: added chaos import"
fi

# 4b. Router.chaosEngine field
if ! grep -qE '^\s*chaosEngine\s+\*chaos\.Engine' "$RTR"; then
  insert_after "$RTR" '^\s*latencyEngine\s+\*latency\.Engine\s*$' $'\tchaosEngine   *chaos.Engine'
  echo "[edit] router.go: added Router.chaosEngine"
fi

# 4c. wrapHandler: add chaos hook after latency hook.
if ! grep -q 'r.evaluateChaos(' "$RTR"; then
  python3 - "$RTR" <<'PY'
import re, sys
path = sys.argv[1]
with open(path) as f:
    text = f.read()
# Anchor: the closing `}` of the latency `if decision := r.evaluateLatency(...)` block
# inside wrapHandler. We match the whole block so we can insert immediately after.
anchor = re.compile(
    r'if decision := r\.evaluateLatency\(.*?\n\t\t\}\n',
    re.S,
)
m = anchor.search(text)
if not m:
    sys.stderr.write("could not find latency hook in wrapHandler to anchor on\n")
    sys.exit(2)
inject = (
    "\n"
    "\t\tif r.evaluateChaos(&info, wrapped, req) {\n"
    "\t\t\treturn\n"
    "\t\t}\n"
)
end = m.end()
text = text[:end] + inject + text[end:]
with open(path, "w") as f:
    f.write(text)
PY
  echo "[edit] router.go: wired evaluateChaos in wrapHandler"
fi

# ---- 5. verify ----
cd "$KUMO_DIR"
echo "[build] go build ./..."
go build ./...
echo "[test] go test ./internal/chaos/..."
go test ./internal/chaos/...
echo "[test] go test ./internal/server/... (sanity check)"
go test ./internal/server/... > /tmp/kumo-server-tests.log 2>&1 || {
  echo "WARN: existing server tests failed; see /tmp/kumo-server-tests.log"
  tail -20 /tmp/kumo-server-tests.log
}
echo
echo "OK. Run kumo with KUMO_CHAOS_ENABLED=1 to expose /kumo/chaos/* endpoints."
