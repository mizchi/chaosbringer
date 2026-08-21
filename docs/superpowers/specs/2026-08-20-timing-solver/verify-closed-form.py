#!/usr/bin/env python3
"""
The constraint system is difference logic, so it has a closed form. If that
closed form is provably the optimum, the shipping code needs no solver at
runtime — z3 stays a dev-time oracle, exactly as Quint stays a dev-time step
and plans ship as committed artifacts.

This sweeps the parameter space and asserts closed form == z3 optimum.
"""
from z3 import Int, Optimize, sat

def closed_form(deadline, floor, tail, tight, margin, fixed, budget):
    settle = deadline + tight + margin
    # The observation window has the same job one round later, so the same size.
    quiesce = deadline + tight + margin
    fast = deadline - tail - margin
    # Three requirements on the tripping delay, and the third is the one that
    # shipped wrong: it must miss the app's deadline, outlast the probe, and
    # outlast the probe *as the probe actually fires*. `page.waitForTimeout` is
    # itself a tight wait, so it overshoots by up to `tight`; a formula that
    # separates `slow` from the NOMINAL probe instant by `margin - floor` leaves
    # 22ms of separation whatever `tight` is, and a loaded machine eats that.
    # Then the tripping response lands BEFORE the probe and an app with no bound
    # at all reads healthy — the one verdict a timing plan must never produce.
    slow = settle + tight + margin - floor
    release = settle + margin
    page = fixed + slow + tail + margin
    wall = fixed + settle + quiesce
    if fast < floor or slow < floor or wall > budget:
        return None
    return {"fast": fast, "slow": slow, "settle": settle, "quiesce": quiesce,
            "release": release, "navTimeout": page, "wall": wall}

def z3_optimum(deadline, floor, tail, tight, margin, fixed, budget):
    fast, slow, settle, quiesce, release, page, wall = (
        Int(n) for n in ("fast","slow","settle","quiesce","release","page","wall"))
    o = Optimize()
    o.add(fast >= floor, slow >= floor, settle >= 0, quiesce >= 0, release >= floor)
    # A tolerated delay must still be inside the app's own bound.
    o.add(fast + tail + margin <= deadline)
    # A tripping delay must miss that bound...
    o.add(slow + floor >= deadline + tight + margin)
    # ...and be observable only after the probe has actually fired. The probe is
    # a tight wait of its own, so it can arrive up to `tight` late: separating
    # from `settle` alone is what let a 22ms gap ship.
    o.add(slow + floor >= settle + tight + margin)
    # The probe must fire after the app's deadline could have.
    o.add(settle >= deadline + tight + margin)
    # The observation window must outlast one more app-bounded round.
    o.add(quiesce >= deadline + tight + margin)
    # A hang released before the probe is not observable as a hang.
    o.add(settle + margin <= release)
    # Navigation only: the longest thing a plan can inject into a load.
    o.add(fixed + slow + tail + margin <= page)
    # The operator's budget is per-plan wall clock, which is both windows.
    o.add(wall >= fixed + settle + quiesce)
    o.add(wall <= budget)
    o.minimize(settle); o.minimize(quiesce); o.minimize(slow)
    o.minimize(release); o.minimize(page); o.minimize(wall); o.maximize(fast)
    if o.check() != sat:
        return None
    m = o.model()
    return {k: m[v].as_long() for k, v in
            (("fast",fast),("slow",slow),("settle",settle),("quiesce",quiesce),
             ("release",release),("navTimeout",page),("wall",wall))}

checked = agreed = infeasible = 0
for deadline in (50, 120, 147, 200, 600, 1000, 5000, 15000):
    for margin in (0, 25, 100):
        for tail, tight in ((14, 3), (59, 36), (118, 72), (250, 100)):
            for floor, fixed, budget in ((4, 696, 15000), (7, 700, 60000)):
                checked += 1
                cf = closed_form(deadline, floor, tail, tight, margin, fixed, budget)
                z3o = z3_optimum(deadline, floor, tail, tight, margin, fixed, budget)
                if cf is None and z3o is None:
                    infeasible += 1; agreed += 1; continue
                assert cf == z3o, f"MISMATCH deadline={deadline} margin={margin} tail={tail}: {cf} != {z3o}"
                agreed += 1
print(f"swept {checked} parameter combinations: closed form == z3 optimum in {agreed}/{checked}")
print(f"  ({infeasible} of them agreed on INFEASIBLE, which is the interesting half)")
