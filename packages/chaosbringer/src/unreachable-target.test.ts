import { describe, expect, it } from "vitest";
import { fakePage, fakeReport } from "./perf-fixtures.test-helpers.js";
import type { PageResult } from "./types.js";
import { unreachableTarget, UnreachableTargetError } from "./unreachable-target.js";

const U = "http://127.0.0.1:4999";

function failed(url: string, message: string, extra: Partial<PageResult> = {}): PageResult {
  return fakePage(url, undefined, {
    status: "error",
    errors: [{ type: "navigation", message, url, timestamp: 0 }],
    hasErrors: true,
    ...extra,
  });
}

describe("unreachableTarget", () => {
  it("names the start URL and the net error when nothing loaded because nothing answered", () => {
    const report = fakeReport([failed(`${U}/`, `page.goto: net::ERR_CONNECTION_REFUSED at ${U}/`)], [], { baseUrl: `${U}/` });
    const found = unreachableTarget(report);
    expect(found).toEqual({ url: `${U}/`, reason: `net::ERR_CONNECTION_REFUSED at ${U}/` });
    expect(new UnreachableTargetError(found!).message).toBe(
      `could not reach ${U}/: is the server running? (net::ERR_CONNECTION_REFUSED at ${U}/)`,
    );
  });

  it("is null when the site answered: a reset connection, an empty response, a page that loaded", () => {
    const reset = fakeReport([failed(`${U}/`, `page.goto: net::ERR_CONNECTION_RESET at ${U}/`)], [], { baseUrl: `${U}/` });
    expect(unreachableTarget(reset)).toBeNull();
    // One page loaded: the server is up, and the one that did not is a finding.
    const some = fakeReport(
      [fakePage(`${U}/`), failed(`${U}/a`, `page.goto: net::ERR_CONNECTION_REFUSED at ${U}/a`)],
      [],
      { baseUrl: `${U}/` },
    );
    expect(unreachableTarget(some)).toBeNull();
  });

  it("is null for another origin's host being down, and when a fault the run injected could be the cause", () => {
    const other = fakeReport([failed(`${U}/`, "page.goto: net::ERR_NAME_NOT_RESOLVED at https://sso.example.invalid/")], [], {
      baseUrl: `${U}/`,
    });
    expect(unreachableTarget(other)).toBeNull();
    const faulted = fakeReport([failed(`${U}/`, `page.goto: net::ERR_CONNECTION_REFUSED at ${U}/`)], [], {
      baseUrl: `${U}/`,
      faultInjections: [{ rule: "abort-all", matched: 1, injected: 1 }],
    });
    expect(unreachableTarget(faulted)).toBeNull();
  });

  // The goto error names the URL navigated to: a running site whose start
  // URL redirects to a host that is down (an SSO not up yet) fails it as
  // `ERR_CONNECTION_REFUSED at <start URL>` too, and was refused as down.
  it("is null when the start navigation followed a redirect: the site answered", () => {
    const message = `page.goto: net::ERR_CONNECTION_REFUSED at ${U}/sso`;
    const redirected = fakeReport([failed(`${U}/sso`, message)], [], { baseUrl: `${U}/sso` });
    redirected.pages[0]!.errors[0]!.redirected = true;
    expect(unreachableTarget(redirected)).toBeNull();
  });

  // Every navigation fails as ERR_INTERNET_DISCONNECTED under the offline
  // profile, which is what it is for: the run's own doing, not the server.
  it("is null under the run's own --network offline", () => {
    const offline = fakeReport([failed(`${U}/`, `page.goto: net::ERR_INTERNET_DISCONNECTED at ${U}/`)], [], { baseUrl: `${U}/` });
    expect(unreachableTarget(offline)).not.toBeNull();
    expect(unreachableTarget(offline, { network: "offline" })).toBeNull();
    expect(unreachableTarget(offline, { network: "slow-3g" })).not.toBeNull();
  });
});
