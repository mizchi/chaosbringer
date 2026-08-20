#!/usr/bin/env bash
# Witness-driven enumeration for the token-refresh pattern. Dev-time only.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-5}"
OUT="${OUT:-traces}"

mkdir -p "$OUT"
: > targets.txt

emit() {
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $Q verify token.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# Which requests hit an expired token. "both" is the case that separates a
# shared refresh from a stampede; the single-expiry cases are the control.
for me in fresh replayed; do
  for prefs in fresh replayed; do
    emit "me-${me}__prefs-${prefs}" \
      "opState.get(\"me\") == \"${me}\" and opState.get(\"prefs\") == \"${prefs}\" and ui == \"ready\""
  done
done

# States the contract forbids. A witness means the SPEC is wrong.
emit "contract-forbids-stampede" "refreshes >= 2"
emit "contract-forbids-error" 'ui == "error"'
emit "contract-forbids-unhandled" "unhandled"
