# Quint feasibility spike — Promise fault-state enumeration

Reference material for
[`../2026-08-20-quint-model-driven-promise-faults-design.md`](../2026-08-20-quint-model-driven-promise-faults-design.md).
Kept so the measurements in that design's Appendix A are reproducible; the
shipping model and its fixture app land under `examples/model-faults/` in
PR 3 of the sequencing plan.

Nothing here is wired into the build. Requires network access for the Quint
install and a JVM for Apalache.

```bash
npm i @informalsystems/quint@0.32.0

# 1. typecheck the model
npx quint typecheck promise.qnt

# 2. cheap tier — random traces, per-predicate hit rates (~0.3s / 500 traces)
npx quint run promise.qnt --backend=typescript --max-steps=5 --max-samples=500 \
  --witnesses 'unhandled' 'ui == "stuck"' 'ui == "done"'

# 3. exhaustive tier — one witness trace per target state (~14s per target)
./enumerate.sh          # writes traces/<ui>_<unhandled>.itf.json

# 4. ITF witnesses -> deterministic fault plans
node itf-to-plan.mjs
```

`--backend=typescript` is required in sandboxes without GitHub access: the
default Rust evaluator is fetched from GitHub releases on first use.
