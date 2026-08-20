#!/usr/bin/env bash
# Witness-driven enumeration for the retry pattern. Dev-time only (Quint + JVM).
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-4}"
OUT="${OUT:-traces}"

mkdir -p "$OUT"
: > targets.txt

emit() {
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $Q verify retry.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The per-attempt grid. Terminal-state targets alone would be satisfied by a
# first attempt that just works, and the retry — the whole point — would never
# be exercised.
for f in fulfil rejectBefore rejectAfter; do
  if [ "$f" = "fulfil" ]; then
    emit "first-${f}" "first == \"${f}\" and second == \"none\""
    continue
  fi
  for sec in fulfil rejectBefore rejectAfter; do
    emit "first-${f}__then-${sec}" "first == \"${f}\" and second == \"${sec}\""
  done
done

# The states the contract forbids. A witness here means the SPEC is wrong.
emit "contract-forbids-double-write" "orders >= 2"
emit "contract-forbids-unhandled" "unhandled"
emit "contract-forbids-phantom-success" 'ui == "placed" and orders == 0'
