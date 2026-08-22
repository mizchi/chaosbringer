#!/usr/bin/env bash
# Witness-driven enumeration for the stale-revalidate pattern.
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
  if $Q verify swr.qnt --max-steps="$DEPTH" --invariant="not($pred)" --out-itf="$out" >/dev/null 2>&1; then
    echo "unreachable  $name" | tee -a targets.txt
    rm -f "$out"
  else
    echo "reachable    $name" | tee -a targets.txt
  fi
}

# The revalidation's three outcomes. Two of them are the same obligation from
# different causes, which is deliberate: the model distinguishes them and most
# implementations do not, and the coverage fingerprints say so out loud.
for r in fulfil reject serverError; do
  emit "revalidate-${r}" "revalidate == \"${r}\""
done

# The states the contract forbids. A witness here means the SPEC is wrong.
emit "contract-forbids-silent-stale" "not(noSilentStale)"
emit "contract-forbids-unlabelled-stale" "not(staleIsLabelled)"
emit "contract-forbids-unhandled" "unhandled"

# `noInventedRevision` (shown <= received) is NOT enumerated, and the omission
# is the point: no setting of any contract knob can produce a witness, because
# every assignment to `shown` is either `received` or the value it already had.
# The invariant restates the model's own arithmetic, so the query would have one
# possible answer and would cost ~14s of Apalache to not learn it. Kept as a
# `val` in the spec — it is a true and useful sanity property to read — but a
# tautology does not get a target. `../vacuity.mjs` is what caught this.

# Every contract target above is only worth its ~14s if a witness was possible
# at all. Classify them rather than leaving identical-looking rows — and never
# under `|| true`: this is the one check in the pipeline whose job is to find
# checks that cannot fail, so swallowing its failure is the bug it looks for.
node ../vacuity.mjs stale-revalidate --annotate
