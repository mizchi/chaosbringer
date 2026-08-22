#!/usr/bin/env bash
# Witness-driven enumeration for the timeout pattern. Dev-time only.
set -uo pipefail
cd "$(dirname "$0")"

Q="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
DEPTH="${DEPTH:-3}"
OUT="${OUT:-traces}"

mkdir -p "$OUT"
: > targets.txt

emit() {
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $Q verify ladder.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The three rungs. "slow" is the control: an app that fails on merely slow
# responses is as broken as one that never gives up, and only enumerating the
# extremes would miss it.
for rung in quick slow tooSlow; do
  emit "report-${rung}" "opState == \"${rung}\""
done

# States the contract forbids.
emit "contract-forbids-stuck" 'ui == "stuck"'
emit "contract-forbids-slow-error" 'opState == "slow" and ui == "error"'
emit "contract-forbids-unhandled" "unhandled"

# Classify the contract-forbids rows above: each one is re-asked against a
# knob-inverted copy of the model, so `targets.txt` distinguishes "unreachable
# because the contract forbids it" (`unreachable-live` — the checker could have
# said either thing) from "unreachable because the predicate is an identity of
# the model's own arithmetic" (`unreachable-by-construction` — a query with one
# possible answer, which the ~14s Apalache run above cannot tell you).
# quint run, ~3s, no JVM.
node ../vacuity.mjs timeout-ladder --annotate
