import { resolvePlanTiming } from "chaosbringer";
import { readFileSync } from "node:fs";
const profile = JSON.parse(readFileSync(new URL("../model/profile.json", import.meta.url), "utf8"));
for (const d of [400, 600, 800, 1200]) {
  console.log(d, JSON.stringify(resolvePlanTiming({ appDeadlineMs: d, timingProfile: profile })));
}
