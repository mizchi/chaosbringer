#!/usr/bin/env bash
# Witness-driven enumeration for the optimistic-rollback pattern.
# Dev-time only (Quint + a JVM). Outputs are committed; replay needs neither.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-4}"
OUT="${OUT:-traces}"

mkdir -p "$OUT"
: > targets.txt

emit() {
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $Q verify rollback.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The write's four outcomes. This is the whole grid — one operation, and the
# interesting variation is in what the *server* ended up holding, which the
# outcome decides: rejectBefore and serverError commit nothing, rejectAfter
# commits and loses the reply, fulfil commits and reports it.
for w in fulfil rejectBefore serverError rejectAfter; do
  emit "write-${w}" "write == \"${w}\""
done

# The states the contract forbids. A witness here means the SPEC is wrong, not
# the app — which is the only reason to enumerate them.
emit "contract-forbids-screen-ahead" 'settled and shown > committed'
emit "contract-forbids-screen-behind" 'settled and shown < committed'
emit "contract-forbids-unhandled" "unhandled"
emit "contract-forbids-phantom-success" 'ui == "saved" and committed == 0'
emit "contract-forbids-double-write" "noteCalls >= 2"
