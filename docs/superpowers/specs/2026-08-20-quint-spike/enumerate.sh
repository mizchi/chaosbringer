#!/bin/bash
# Witness-driven exhaustive enumeration: for every target state predicate,
# ask Apalache for a trace that reaches it. A counterexample IS the test case;
# "no counterexample up to depth k" means unreachable within the bound.
cd "$(dirname "$0")"
mkdir -p traces
for ui in loading done error stuck; do
  for un in false true; do
    P="ui == \"$ui\" and unhandled == $un"
    out="traces/${ui}_${un}.itf.json"
    if timeout 120 npx quint verify promise.qnt --max-steps=5 \
        --invariant="not($P)" --out-itf="$out" >/dev/null 2>&1; then
      echo "UNREACHABLE(<=5 steps)  $P"
    else
      steps=$(python3 -c "import json,sys;print(len(json.load(open('$out'))['states'])-1)" 2>/dev/null || echo "?")
      echo "REACHABLE  $P   witness=$steps steps -> $out"
    fi
  done
done
