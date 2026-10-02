import { describe, expect, it } from "vitest";
import type { CrawlReport, PageError } from "../types.js";
import { analyzeScan } from "./analyze.js";
import { clusterErrors } from "../clusters.js";
import { fakePage, fakeReport } from "../perf-fixtures.test-helpers.js";
import { markServedOrb, ORB_SERVED_NOTE, orbBlockedUrls, probeServedUrls } from "./orb.js";

const AVATAR = "https://secure.gravatar.com/avatar/72ea?size=120";
const BROKEN = "https://blog-images.example/images/gone.png";
const orb = (url: string): PageError => ({ type: "network", message: `${url} - net::ERR_BLOCKED_BY_ORB`, url: "https://site.example/team/", timestamp: 0 });

describe("ORB blocks the scan caused", () => {
  const withErrors = (errors: PageError[]): CrawlReport =>
    fakeReport([fakePage("https://site.example/team/", undefined, { errors, hasErrors: errors.length > 0 })], [], {
      errorClusters: clusterErrors(errors),
    });

  it("lists the blocked URLs", () => {
    expect(orbBlockedUrls([withErrors([orb(AVATAR), orb(BROKEN), orb(AVATAR)])])).toEqual([AVATAR, BROKEN]);
  });

  it("keeps only URLs that answer 2xx with an image, media or font type", async () => {
    const fetchImpl = (async (url: string) =>
      new Response("x", {
        status: url === AVATAR ? 200 : 403,
        headers: { "content-type": url === AVATAR ? "image/jpeg" : "application/xml" },
      })) as typeof fetch;
    expect([...(await probeServedUrls([AVATAR, BROKEN], { fetchImpl }))]).toEqual([AVATAR]);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect([...(await probeServedUrls([AVATAR], { fetchImpl: failing }))]).toEqual([]);
  });

  it("turns the served one into an environment note and keeps the broken one a finding", () => {
    const clean = withErrors([orb(AVATAR), orb(BROKEN)]);
    const marked = markServedOrb(clean, new Set([AVATAR]));
    expect(marked.pages[0]!.errors.map((e) => e.message)).toEqual([
      `${AVATAR} - net::ERR_BLOCKED_BY_ORB ${ORB_SERVED_NOTE}`,
      `${BROKEN} - net::ERR_BLOCKED_BY_ORB`,
    ]);
    const analysis = analyzeScan(marked, []);
    expect(analysis.environment.map((n) => n.code)).toEqual(["net::ERR_BLOCKED_BY_ORB (served fine)"]);
    const failed = analysis.findings.filter((f) => f.rule === "request-failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain("gone.png");
    expect(JSON.stringify(failed[0])).not.toContain("gravatar");
  });
});
