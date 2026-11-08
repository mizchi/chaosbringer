import { describe, expect, it } from "vitest";
import type { CrawlReport, PageError } from "../types.js";
import { analyzeScan } from "./analyze.js";
import { clusterErrors } from "../clusters.js";
import { fakePage, fakeReport } from "../perf-fixtures.test-helpers.js";
import { blockedResponses, key, markServed, probeServed, SERVED_NOTE, type BlockedResponse } from "./blocked-responses.js";

const ORB = "net::ERR_BLOCKED_BY_ORB" as const;
const CORP = "net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin" as const;
const AVATAR = "https://secure.gravatar.com/avatar/72ea?size=120";
const BROKEN = "https://blog-images.example/images/gone.png";
const SCRIPT = "https://cdn.analytics.example/script.js";
const AD = "https://ads.example/api/decision/?format=jsonp";
const LOCKED = "https://cdn.locked.example/widget.js";
const at = "https://site.example/team/";
const refused = (url: string, code: string = ORB): PageError => ({ type: "network", message: `${url} - ${code}`, url: at, timestamp: 0 });
const echo = (code: string): PageError => ({ type: "console", message: `Failed to load resource: ${code}`, url: at, timestamp: 0 });
const withErrors = (errors: PageError[]): CrawlReport =>
  fakeReport([fakePage(at, undefined, { errors, hasErrors: errors.length > 0 })], [], { errorClusters: clusterErrors(errors) });
const served = (...bs: BlockedResponse[]) => new Set(bs.map(key));

/** A server that answers each URL with its own status and headers. */
function fakeFetch(answers: Record<string, { status: number; headers: Record<string, string> }>): typeof fetch {
  return (async (url: string) => {
    const a = answers[url];
    if (!a) throw new Error("offline");
    return new Response("x", a);
  }) as typeof fetch;
}

describe("responses the browser refused because of the scan", () => {
  it("lists each refused URL once, with its code", () => {
    expect(blockedResponses([withErrors([refused(AVATAR), refused(BROKEN), refused(AVATAR), refused(AD, CORP), echo(CORP)])])).toEqual([
      { url: AVATAR, code: ORB },
      { url: BROKEN, code: ORB },
      { url: AD, code: CORP },
    ]);
  });

  it("counts an ORB block as the scan's when the file is an image, media, font, script or stylesheet", async () => {
    const fetchImpl = fakeFetch({
      [AVATAR]: { status: 200, headers: { "content-type": "image/jpeg" } },
      [SCRIPT]: { status: 200, headers: { "content-type": "application/javascript" } },
      [BROKEN]: { status: 403, headers: { "content-type": "application/xml" } },
    });
    const blocked = [AVATAR, SCRIPT, BROKEN].map((url) => ({ url, code: ORB }));
    expect([...(await probeServed(blocked, { fetchImpl }))]).toEqual([key(blocked[0]!), key(blocked[1]!)]);
    expect([...(await probeServed([{ url: "https://down.example/a.png", code: ORB }], { fetchImpl }))]).toEqual([]);
  });

  it("counts a CORP refusal as the scan's only when a direct fetch is served without one", async () => {
    // eslint.org's ad server: 403 with `same-origin` to HeadlessChrome, 200 to everyone else.
    const fetchImpl = fakeFetch({
      [AD]: { status: 200, headers: { "content-type": "application/javascript" } },
      [LOCKED]: { status: 200, headers: { "content-type": "application/javascript", "cross-origin-resource-policy": "same-origin" } },
    });
    const blocked = [AD, LOCKED].map((url) => ({ url, code: CORP }));
    expect([...(await probeServed(blocked, { fetchImpl }))]).toEqual([key(blocked[0]!)]);
  });

  it("fetches one URL per path and lets it answer for every query of that path", async () => {
    // eslint.org's ad requests: one per page view, differing in random ids.
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return new Response("x", { status: 200, headers: { "content-type": "application/javascript" } });
    }) as typeof fetch;
    const blocked = Array.from({ length: 30 }, (_, i) => ({ url: `${AD}&div_ids=ad_${i}`, code: CORP }));
    expect((await probeServed(blocked, { fetchImpl })).size).toBe(30);
    expect(fetched).toEqual([`${AD}&div_ids=ad_0`]);
  });

  it("turns the served ones into environment notes and keeps the broken one a finding", () => {
    const marked = markServed(withErrors([refused(AVATAR), refused(BROKEN), refused(AD, CORP), echo(CORP)]), served(
      { url: AVATAR, code: ORB },
      { url: AD, code: CORP },
    ));
    expect(marked.pages[0]!.errors.map((e) => e.message)).toEqual([
      `${AVATAR} - ${ORB} ${SERVED_NOTE}`,
      `${BROKEN} - ${ORB}`,
      `${AD} - ${CORP} ${SERVED_NOTE}`,
      `Failed to load resource: ${CORP} ${SERVED_NOTE}`,
    ]);
    const analysis = analyzeScan(marked, []);
    expect(analysis.environment.map((n) => n.code).sort()).toEqual([`${ORB} (served fine)`, `${CORP} (served fine)`]);
    expect(analysis.findings.filter((f) => f.rule === "console-error")).toEqual([]);
    const failed = analysis.findings.filter((f) => f.rule === "request-failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain("gone.png");
  });

  it("keeps the console echo a finding while any refusal with its code on the page stays one", () => {
    const marked = markServed(withErrors([refused(AD, CORP), refused(LOCKED, CORP), echo(CORP), echo(CORP)]), served({ url: AD, code: CORP }));
    expect(marked.pages[0]!.errors.map((e) => e.message)).toEqual([
      `${AD} - ${CORP} ${SERVED_NOTE}`,
      `${LOCKED} - ${CORP}`,
      `Failed to load resource: ${CORP}`,
      `Failed to load resource: ${CORP}`,
    ]);
  });
});
