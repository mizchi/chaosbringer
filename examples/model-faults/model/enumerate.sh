#!/usr/bin/env bash
# Witness-driven enumeration: for every target state, ask the model checker
# for a trace that reaches it. A counterexample IS the test case; "no
# counterexample within DEPTH" means the state is unreachable in the model,
# which is the coverage statement a probability sweep cannot make.
#
# Dev-time only. Needs Quint + a JVM (Apalache downloads on first use).
# Outputs are committed: `chaosbringer model run` needs neither.
#
#   ./enumerate.sh              # 4x4 per-operation grid + contract checks
#   DEPTH=4 ./enumerate.sh      # tighter bound (faster, fewer witnesses)
set -uo pipefail
cd "$(dirname "$0")"

QUINT="${QUINT:-npx --yes @informalsystems/quint@0.32.0}"
SPEC="${SPEC:-checkout.qnt}"
DEPTH="${DEPTH:-4}"
OUT="${OUT:-traces}"
TERMINALS=(fulfilled rejected bodyRejected hung)

mkdir -p "$OUT"
: > targets.txt

emit() { # $1 = target name, $2 = predicate
  local name="$1" pred="$2" out="$OUT/$1.itf.json"
  if $QUINT verify "$SPEC" --max-steps="$DEPTH" \
      --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name  $pred" | tee -a targets.txt
    rm -f "$out"
  else
    local steps
    steps=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$out','utf8')).states.length-1)" 2>/dev/null || echo '?')
    echo "reachable    $name  $pred  (witness: $steps steps)" | tee -a targets.txt
  fi
}

# Per-operation terminal-state grid: this is where the interesting
# combinations live (two rejections, a rejection racing a hang, …).
for cart in "${TERMINALS[@]}"; do
  for shipping in "${TERMINALS[@]}"; do
    emit "cart-${cart}__shipping-${shipping}" \
      "opState.get(\"cart\") == \"${cart}\" and opState.get(\"shipping\") == \"${shipping}\""
  done
done

# The two states the contract forbids. Both must come back unreachable — a
# witness here means the SPEC is wrong, not the app. Reachable UI labels are
# deliberately not enumerated: they are already covered by the grid above,
# and "idle" / "loading" are transient, so a probe fired after the settle
# window would judge them on timing rather than on behaviour.
emit "contract-forbids-stuck" 'ui == "stuck"'
emit "contract-forbids-unhandled" "unhandled"

# Classify the contract-forbids rows above: each one is re-asked against a
# knob-inverted copy of the model, so `targets.txt` distinguishes "unreachable
# because the contract forbids it" (`unreachable-live` — the checker could have
# said either thing) from "unreachable because the predicate is an identity of
# the model's own arithmetic" (`unreachable-by-construction` — a query with one
# possible answer, which the ~14s Apalache run above cannot tell you).
# quint run, ~3s, no JVM.
node ../patterns/vacuity.mjs model --annotate
