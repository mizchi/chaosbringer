#!/usr/bin/env bash
# Witness-driven enumeration for the reconnect-budget pattern.
# Dev-time only (Quint + a JVM). Outputs are committed; replay needs neither.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-5}"
OUT="${OUT:-traces}"

mkdir -p "$OUT"
: > targets.txt

emit() {
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $Q verify reconnect.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The ladder, one rung per attempt that finally connects, plus the rung where
# the budget runs out. Terminal-state targets alone would collapse the first
# three into "live" and never say how many attempts it took — which is the only
# thing this pattern measures.
emit "connect-on-1" 'a1 == "fulfil"'
emit "connect-on-2" 'a1 == "reject" and a2 == "fulfil"'
emit "connect-on-3" 'a1 == "reject" and a2 == "reject" and a3 == "fulfil"'
emit "budget-exhausted" 'a1 == "reject" and a2 == "reject" and a3 == "reject"'

# The states the contract forbids. A witness here means the SPEC is wrong.
#
# `vacuity.mjs` below re-asks each of these against a knob-inverted copy of the
# model, so the file records which of them a witness could ever have answered:
# `unreachable-live` is a verification result, `unreachable-by-construction` is
# a predicate the model's own arithmetic makes an identity. All four here are
# live because of `BUDGETED` — before that knob existed, three of them restated
# their own assignments and `contract-forbids-runaway`, this pattern's headline
# property, could only ever come back one way.
emit "contract-forbids-runaway" "not(withinBudget)"
emit "contract-forbids-endless-spinner" "not(noEndlessSpinner)"
emit "contract-forbids-unhandled" "unhandled"
emit "contract-forbids-phantom-live" "not(noPhantomLive)"

# Classify the contract-forbids rows above (quint run, ~3s, no JVM).
node ../vacuity.mjs reconnect-budget --annotate
