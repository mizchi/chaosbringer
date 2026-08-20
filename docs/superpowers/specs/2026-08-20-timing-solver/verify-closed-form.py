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
    fast = deadline - tail - margin
    slow = deadline + tight + margin - floor
    release = settle + margin
    page = fixed + settle + tail + margin
    if fast < floor or slow < floor or page > budget:
        return None
    return {"fast": fast, "slow": slow, "settle": settle, "release": release, "pageTimeout": page}

def z3_optimum(deadline, floor, tail, tight, margin, fixed, budget):
    fast, slow, settle, release, page = (Int(n) for n in ("fast","slow","settle","release","page"))
    o = Optimize()
    o.add(fast >= floor, slow >= floor, settle >= 0, release >= floor)
    o.add(fast + tail + margin <= deadline)
    o.add(slow + floor >= deadline + tight + margin)
    o.add(settle >= deadline + tight + margin)
    o.add(settle + margin <= release)
    o.add(fixed + settle + tail + margin <= page)
    o.add(page <= budget)
    o.minimize(settle); o.minimize(slow); o.minimize(release); o.minimize(page); o.maximize(fast)
    if o.check() != sat:
        return None
    m = o.model()
    return {k: m[v].as_long() for k, v in
            (("fast",fast),("slow",slow),("settle",settle),("release",release),("pageTimeout",page))}

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
