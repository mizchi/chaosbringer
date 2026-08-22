#!/usr/bin/env bash
# Witness-driven enumeration for the token-refresh pattern. Dev-time only.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-6}"
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

# The rung the model used to have no action for: the refresh itself 401s. Both
# requests are stale, so it is also the maximum fan-out — under the contract one
# POST and a terminal state the user can read; without it, one POST per retry
# against an endpoint that is already failing. This is the only rung on which a
# client that loops forever differs from one that gives up, and until the
# refresh became an operation no plan could express it.
emit "refresh-failed" \
  'opState.get("me") == "stale" and opState.get("prefs") == "stale" and refreshState == "failed"'

# States the contract forbids. A witness means the SPEC is wrong.
#
# `vacuity.mjs` below re-asks each of these against a knob-inverted copy of the
# model, so the file records which of them a witness could ever have answered:
# `unreachable-live` is a verification result, `unreachable-by-construction` is
# a predicate the model's own arithmetic makes an identity.
emit "contract-forbids-stampede" "refreshCalls >= 2"
emit "contract-forbids-error" 'ui == "error"'
emit "contract-forbids-unhandled" "unhandled"
emit "contract-forbids-refresh-loop" "not(saysSoWhenSignedOut)"

# Classify the contract-forbids rows above (quint run, ~3s, no JVM).
node ../vacuity.mjs token-refresh --annotate
