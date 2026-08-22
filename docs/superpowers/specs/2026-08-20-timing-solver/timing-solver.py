#!/usr/bin/env python3
"""
Deterministically search for timing values THIS environment can honour.

The fault layers can express a delay, a deadline, a probe window and a page
timeout. Whether a given set of those values actually *decides* the thing you
want depends on the environment's floor and jitter, which calib.mts measures.
This turns "pick 1600ms and hope" into a constraint problem:

  fast   an injected delay the app must still tolerate      (verdict: success)
  slow   an injected delay that must trip the app's bound   (verdict: error)
  settle how long the harness waits before probing the UI
  release when a hung request is finally aborted
  pageTimeout the crawler's per-page bound

Every separation carries the measured jitter, so a solution is one the
environment can keep, not one that merely looks right on paper. When no
solution exists the unsat core names the constraint that made it impossible —
which is the useful answer, and the one a hand-picked constant never gives.

  ./timing_solver.py solve  --deadline 5000
  ./timing_solver.py solve  --deadline 120 --fast 20      # expect UNSAT
  ./timing_solver.py ladder --lo 20 --hi 15000 --budget 60000
  ./timing_solver.py check  --deadline 5000 --settle 1200 # the real misconfig
"""
import argparse
import json
import sys

from z3 import And, If, Implies, Int, Optimize, Solver, sat, unsat

DEFAULT_PROFILE = {
    "delayFloorMs": 4,
    "delayTailMs": 59,
    "tightTailMs": 36,
    "fixedPerPlanMs": 696,
}


def load_profile(path, safety):
    prof = dict(DEFAULT_PROFILE)
    if path:
        with open(path) as fh:
            prof.update(json.load(fh))
    # The tail is the one number a single calibration run under-reports (a cold
    # run measured 107ms where a warm one measured 14ms), so scale it. Floors
    # and fixed costs are stable and taken as measured.
    prof["delayTailMs"] = int(prof["delayTailMs"] * safety)
    prof["tightTailMs"] = int(prof["tightTailMs"] * safety)
    return prof


def build(prof, args, free_deadline=False):
    """Shared constraint system. Returns (vars, named constraints)."""
    floor = prof["delayFloorMs"]
    tail = prof["delayTailMs"]
    tight = prof["tightTailMs"]
    fixed = prof["fixedPerPlanMs"]
    margin = args.margin

    fast, slow, settle, release, page = (
        Int("fast"),
        Int("slow"),
        Int("settle"),
        Int("release"),
        Int("pageTimeout"),
    )
    deadline = Int("deadline") if free_deadline else args.deadline

    C = {
        # Nothing below the interception floor is expressible at all.
        "expressible": And(fast >= floor, slow >= floor, settle >= 0, release >= floor),
        # The tolerated case must land before the app's bound even on the worst
        # tail we have measured.
        "fast_tolerated": fast + tail + margin <= deadline,
        # The tripping case must miss the bound even when nothing is slow: the
        # earliest it can arrive is slow+floor, and the bound may fire as late
        # as deadline+tight.
        "slow_trips": slow + floor >= deadline + tight + margin,
        # The probe must fire after the app's own bound has resolved, or a
        # correctly-bounded request is judged as still hanging. (This is the
        # constraint the hand-picked settleMs=1200 violated against a 5000ms
        # deadline.)
        "probe_after_deadline": settle >= deadline + tight + margin,
        # A "stuck" verdict needs the probe to happen before the release.
        "stuck_observable": settle + margin <= release,
        # The whole plan has to fit inside the page timeout.
        "fits_page_timeout": fixed + settle + tail + margin <= page,
        # …and inside whatever budget the operator will tolerate.
        "within_budget": page <= args.budget,
    }
    return (fast, slow, settle, release, page, deadline), C


def cmd_solve(args, prof):
    (fast, slow, settle, release, page, deadline), C = build(prof, args)
    opt = Optimize()
    for name, c in C.items():
        opt.assert_and_track(c, name) if False else opt.add(c)
    if args.fast is not None:
        opt.add(fast == args.fast)
    # Wall clock per plan is dominated by the settle window plus fixed cost;
    # the release only has to outlast the probe.
    opt.minimize(settle)
    opt.minimize(release)
    opt.minimize(page)
    opt.maximize(fast)  # the most forgiving "fast" that is still tolerated
    if opt.check() != sat:
        return unsat_report(args, prof)
    m = opt.model()
    vals = {
        "fast": m[fast].as_long(),
        "slow": m[slow].as_long(),
        "settle": m[settle].as_long(),
        "release": m[release].as_long(),
        "pageTimeout": m[page].as_long(),
        "deadline": args.deadline,
    }
    print(json.dumps({"status": "sat", "profile": prof, "values": vals}, indent=2))
    print(f"\nper-plan wall clock ~= {prof['fixedPerPlanMs'] + vals['settle']}ms", file=sys.stderr)
    return 0


def unsat_report(args, prof):
    """Which constraint made it impossible? That is the actionable output."""
    (fast, slow, settle, release, page, deadline), C = build(prof, args)
    s = Solver()
    s.set(unsat_core=True)
    for name, c in C.items():
        s.assert_and_track(c, name)
    if args.fast is not None:
        s.assert_and_track(fast == args.fast, "fast_pinned")
    assert s.check() == unsat
    core = sorted(str(c) for c in s.unsat_core())
    print(
        json.dumps(
            {
                "status": "unsat",
                "profile": prof,
                "core": core,
                "explanation": explain(core, args, prof),
            },
            indent=2,
        )
    )
    return 1


def explain(core, args, prof):
    tail, tight, floor = prof["delayTailMs"], prof["tightTailMs"], prof["delayFloorMs"]
    if "expressible" in core and "fast_tolerated" in core:
        return (
            f"no expressible delay is tolerable under a {args.deadline}ms deadline: this "
            f"environment's own jitter is {tail}ms and the floor is {floor}ms, so even the "
            f"smallest injectable delay can be observed at {floor + tail}ms. A deadline that "
            f"tight is inside the noise — raise it above {floor + tail + args.margin}ms, or "
            f"stop asserting on timing at this scale."
        )
    if "fast_pinned" in core and "fast_tolerated" in core:
        need = args.fast + tail + args.margin
        return (
            f"a {args.fast}ms delay cannot be distinguished from a failure under a "
            f"{args.deadline}ms deadline in this environment: worst-case it is observed at "
            f"{need}ms, which the deadline must exceed. Raise the deadline above {need}ms, "
            f"or accept that {args.fast}ms is inside the noise."
        )
    if "fast_tolerated" in core and "slow_trips" in core:
        span = tail + tight + floor + 2 * args.margin
        return (
            f"tolerated and tripping cases cannot coexist: separating them needs at least "
            f"{span}ms of headroom around the deadline, more than a {args.deadline}ms bound allows."
        )
    if "within_budget" in core:
        floor_budget = prof["fixedPerPlanMs"] + args.deadline + tight + tail + 2 * args.margin
        return (
            f"the budget is too small: one plan cannot cost less than ~{floor_budget}ms "
            f"(fixed {prof['fixedPerPlanMs']}ms + a probe that must outlast a {args.deadline}ms deadline)."
        )
    return "see core"


def cmd_check(args, prof):
    """Verify a proposed config and report the slack on every constraint."""
    floor, tail, tight, fixed = (
        prof["delayFloorMs"],
        prof["delayTailMs"],
        prof["tightTailMs"],
        prof["fixedPerPlanMs"],
    )
    rows = []
    settle, deadline = args.settle, args.deadline
    rows.append(
        (
            "probe_after_deadline",
            settle - (deadline + tight + args.margin),
            f"settle={settle} vs deadline={deadline}+tail={tight}+margin={args.margin}",
        )
    )
    if args.fast is not None:
        rows.append(
            ("fast_tolerated", (deadline - args.margin) - (args.fast + tail), f"fast={args.fast}")
        )
    if args.slow is not None:
        rows.append(
            ("slow_trips", (args.slow + floor) - (deadline + tight + args.margin), f"slow={args.slow}")
        )
    rows.append(
        ("fits_page_timeout", args.budget - (fixed + settle + tail + args.margin), f"budget={args.budget}")
    )
    ok = all(slack >= 0 for _, slack, _ in rows)
    print(json.dumps({"status": "ok" if ok else "violated", "profile": prof}, indent=2))
    for name, slack, ctx in rows:
        verdict = "OK  " if slack >= 0 else "FAIL"
        print(f"  {verdict} {name:<22} slack {slack:>7}ms   ({ctx})")
    return 0 if ok else 1


def cmd_ladder(args, prof):
    """
    How many mutually distinguishable delay rungs fit in [lo, hi] under a total
    wall-clock budget? Each rung costs its own delay plus the fixed per-plan
    overhead, so the budget — not the arithmetic — is what bounds it.
    """
    tail, floor, fixed = prof["delayTailMs"], prof["delayFloorMs"], prof["fixedPerPlanMs"]
    sep = tail - floor + args.margin  # d[i+1] observed-min must exceed d[i] observed-max
    best = None
    for n in range(1, args.max_rungs + 1):
        opt = Optimize()
        d = [Int(f"d{i}") for i in range(n)]
        opt.add(d[0] >= args.lo, d[n - 1] <= args.hi)
        for i in range(n - 1):
            opt.add(d[i + 1] >= d[i] + sep)
        total = sum(d) + n * (fixed + args.margin)
        opt.add(total <= args.budget)
        opt.minimize(sum(d))
        if opt.check() != sat:
            break
        m = opt.model()
        best = {
            "rungs": n,
            "delays": [m[x].as_long() for x in d],
            "separationMs": sep,
            "estimatedTotalMs": sum(m[x].as_long() for x in d) + n * (fixed + args.margin),
        }
    print(json.dumps({"status": "sat" if best else "unsat", "profile": prof, "ladder": best}, indent=2))
    return 0 if best else 1


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode", choices=["solve", "check", "ladder"])
    p.add_argument("--profile", help="calibration JSON from calib.mts")
    p.add_argument("--safety", type=float, default=2.0, help="multiplier on measured jitter")
    p.add_argument("--margin", type=int, default=25, help="required slack per separation (ms)")
    p.add_argument("--deadline", type=int, default=5000, help="the app's own request bound")
    p.add_argument("--fast", type=int, default=None)
    p.add_argument("--slow", type=int, default=None)
    p.add_argument("--settle", type=int, default=None)
    p.add_argument("--budget", type=int, default=15000)
    p.add_argument("--lo", type=int, default=20)
    p.add_argument("--hi", type=int, default=15000)
    p.add_argument("--max-rungs", type=int, default=24)
    args = p.parse_args()
    prof = load_profile(args.profile, args.safety)
    if args.mode == "solve":
        return cmd_solve(args, prof)
    if args.mode == "check":
        if args.settle is None:
            p.error("check needs --settle")
        return cmd_check(args, prof)
    return cmd_ladder(args, prof)


if __name__ == "__main__":
    sys.exit(main())
