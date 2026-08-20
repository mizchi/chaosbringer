#!/usr/bin/env bash
# Witness-driven enumeration for the "add a todo" flow. Dev-time only: needs
# Quint + a JVM (Apalache downloads on first use). Outputs are committed, so
# `chaosbringer model run` needs neither.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-4}"

mkdir -p traces
: > targets.txt

emit() {
  local name="$1" pred="$2" out="traces/$1.itf.json"
  if $Q verify todo.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The write succeeded, so the app refreshes: three ways that refresh can end.
for l in fulfilled rejected bodyRejected; do
  emit "write-ok__refresh-${l}" "postState == \"fulfilled\" and listState == \"${l}\" and listDone == 2"
done

# The write failed: no refresh should follow it at all.
for p in rejected errored hung; do
  emit "write-${p}__no-refresh" "postState == \"${p}\" and listDone == 1"
done

# States the contract forbids. A witness here means the SPEC is wrong.
emit "contract-forbids-stuck" 'ui == "stuck"'
emit "contract-forbids-unhandled" "unhandled"
