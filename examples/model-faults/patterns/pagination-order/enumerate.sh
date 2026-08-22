#!/usr/bin/env bash
# Witness-driven enumeration for the pagination-order pattern.
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
  if $Q verify feed.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The grid is on page 1's outcome, with page 2 always prompt. That is the axis
# that decides arrival order — and the terminal states are indistinguishable
# without it: `fulfil` and `slow` both end with four rows and a ready banner,
# which is exactly the pair a probability sweep would report as one state.
for f in fulfil slow rejectBefore; do
  emit "page1-${f}" "first == \"${f}\" and second == \"fulfil\""
done

# The states the contract forbids. A witness here means the SPEC is wrong.
emit "contract-forbids-partial-page" "not(noPartialPage)"
emit "contract-forbids-green-over-gap" "not(noGreenOverGap)"
emit "contract-forbids-unhandled" "unhandled"
emit "contract-forbids-phantom-rows" "not(noPhantomRows)"

# Classify the contract-forbids rows above: each one is re-asked against a
# knob-inverted copy of the model, so `targets.txt` distinguishes "unreachable
# because the contract forbids it" (`unreachable-live` — the checker could have
# said either thing) from "unreachable because the predicate is an identity of
# the model's own arithmetic" (`unreachable-by-construction` — a query with one
# possible answer, which the ~14s Apalache run above cannot tell you).
# quint run, ~3s, no JVM.
node ../vacuity.mjs pagination-order --annotate
