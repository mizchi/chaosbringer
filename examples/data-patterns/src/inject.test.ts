import { describe, expect, it } from "vitest";
import { pathPattern, toCrawlOptions, toServedRoutes } from "./inject.js";
import { type DataPattern, type Injection, html, json, raw } from "./pattern.js";

const ctx = { thirdPartyOrigin: "http://localhost:4001" };

const withInject = (inject: Injection): DataPattern => ({
  id: "p",
  title: "t",
  category: inject.channel === "none" ? "oracle" : "bug-data",
  description: "d",
  fix: "f",
  realism: "r",
  routes: () => ({ "/": html("<h1>x</h1>"), "/api/user": json({ user: { name: "Ada" } }) }),
  inject,
  expect: inject.channel === "none" ? { signal: "none" } : { signal: { kind: "invariant", name: "data.xss-marker" } },
});

describe("pathPattern", () => {
  const re = pathPattern("/api/user");

  it("matches the path on any origin, with or without a query", () => {
    expect(re.test("http://127.0.0.1:5000/api/user")).toBe(true);
    expect(re.test("http://127.0.0.1:5000/api/user?x=1")).toBe(true);
    expect(re.test("http://localhost/api/user")).toBe(true);
  });

  it("matches nothing longer or elsewhere", () => {
    expect(re.test("http://127.0.0.1:5000/api/users")).toBe(false);
    expect(re.test("http://127.0.0.1:5000/api/user/1")).toBe(false);
    expect(re.test("http://127.0.0.1:5000/v2/api/user")).toBe(false);
    expect(re.test("http://127.0.0.1:5000/?next=/api/user")).toBe(false);
  });

  it("escapes the path", () => {
    expect(pathPattern("/api/a.b").test("http://x/api/aXb")).toBe(false);
    expect(pathPattern("/api/a.b").test("http://x/api/a.b")).toBe(true);
  });
});

describe("toCrawlOptions", () => {
  it("response: a status-200 rule on the path's fetch/XHR, named data:<path>, carrying the run's data", () => {
    const p = withInject({ channel: "response", path: "/api/user", bad: '{"user":null}', benign: '{"user":{"name":"Ada"}}' });
    const bad = toCrawlOptions(p, "bad", ctx);
    expect(bad.query).toBe("");
    expect(bad.options.lifecycleFaults).toBeUndefined();
    expect(bad.options.driver).toBeUndefined();
    expect(bad.options.faultInjection).toHaveLength(1);
    const rule = bad.options.faultInjection![0]!;
    expect(rule.name).toBe("data:/api/user");
    expect(rule.resourceTypes).toEqual(["fetch", "xhr"]);
    expect(rule.fault).toEqual({ kind: "status", status: 200, body: '{"user":null}', contentType: "application/json" });
    expect(String(rule.urlPattern)).toBe(String(pathPattern("/api/user")));

    const benign = toCrawlOptions(p, "benign", ctx).options.faultInjection![0]!;
    expect(benign.name).toBe("data:/api/user");
    expect(benign.fault).toMatchObject({ body: '{"user":{"name":"Ada"}}' });
  });

  it("response: keeps the entry's content type", () => {
    const p = withInject({ channel: "response", path: "/api/x", contentType: "text/html", bad: "<h1>502</h1>", benign: "{}" });
    expect(toCrawlOptions(p, "bad", ctx).options.faultInjection![0]!.fault).toMatchObject({ contentType: "text/html" });
    expect(toCrawlOptions(p, "benign", ctx).options.faultInjection![0]!.fault).toMatchObject({ contentType: "text/html" });
  });

  it("response: a content type per data", () => {
    const p = withInject({
      channel: "response",
      path: "/api/x",
      contentType: { bad: "text/html", benign: "application/json" },
      bad: "<h1>502</h1>",
      benign: "{}",
    });
    expect(toCrawlOptions(p, "bad", ctx).options.faultInjection![0]!.fault).toMatchObject({ contentType: "text/html" });
    expect(toCrawlOptions(p, "benign", ctx).options.faultInjection![0]!.fault).toMatchObject({ contentType: "application/json" });
    expect(toServedRoutes(p, "buggy", ctx)["/api/x"]).toEqual(raw("<h1>502</h1>", "text/html"));
  });

  it("query: the entry URL's suffix, from a string or from the route context", () => {
    const fixed = withInject({ channel: "query", bad: "?q=%3Cb%3E", benign: "?q=shoes" });
    expect(toCrawlOptions(fixed, "bad", ctx)).toEqual({ query: "?q=%3Cb%3E", options: {} });
    expect(toCrawlOptions(fixed, "benign", ctx)).toEqual({ query: "?q=shoes", options: {} });

    const computed = withInject({ channel: "query", bad: (c) => `?next=${encodeURIComponent(`${c.thirdPartyOrigin}/x`)}`, benign: "?next=/home" });
    expect(toCrawlOptions(computed, "bad", ctx).query).toBe(`?next=${encodeURIComponent("http://localhost:4001/x")}`);
  });

  it("storage: a tamperStorage fault after load, named data:<key>", () => {
    const p = withInject({ channel: "storage", key: "prefs", bad: "{bad", benign: '{"theme":"dark"}' });
    const { query, options } = toCrawlOptions(p, "bad", ctx);
    expect(query).toBe("");
    expect(options.faultInjection).toBeUndefined();
    expect(options.lifecycleFaults).toEqual([
      { when: "afterLoad", name: "data:prefs", action: { kind: "tamper-storage", scope: "localStorage", key: "prefs", value: "{bad" } },
    ]);

    const session = withInject({ channel: "storage", scope: "sessionStorage", key: "k", bad: "x", benign: "y" });
    expect(toCrawlOptions(session, "benign", ctx).options.lifecycleFaults![0]!.action).toMatchObject({ scope: "sessionStorage", value: "y" });
  });

  it("form: a payloadDriver", () => {
    const p = withInject({ channel: "form", bad: "<b data-cb-injected>x</b>", benign: "hello" });
    const { query, options } = toCrawlOptions(p, "bad", ctx);
    expect(query).toBe("");
    expect(options.faultInjection).toBeUndefined();
    expect(options.driver).toMatchObject({ name: "payload(payloads)" });
  });

  it("none: nothing, and only for an oracle entry", () => {
    const oracle = withInject({ channel: "none" });
    expect(toCrawlOptions(oracle, "none", ctx)).toEqual({ query: "", options: {} });
    expect(() => toCrawlOptions(oracle, "bad", ctx)).toThrow(/only an oracle entry runs without data/);
    const p = withInject({ channel: "query", bad: "?a", benign: "?b" });
    expect(() => toCrawlOptions(p, "none", ctx)).toThrow(/only an oracle entry runs without data/);
  });
});

describe("toServedRoutes", () => {
  it("serves a response entry's bad data from the app itself", () => {
    const p = withInject({ channel: "response", path: "/api/user", bad: '{"user":null}', benign: "{}" });
    const routes = toServedRoutes(p, "buggy", ctx);
    expect(routes["/api/user"]).toEqual(raw('{"user":null}', "application/json"));
    expect(routes["/"]).toEqual(html("<h1>x</h1>"));
  });

  it("leaves the other channels' routes alone", () => {
    const p = withInject({ channel: "query", bad: "?a", benign: "?b" });
    expect(toServedRoutes(p, "buggy", ctx)).toEqual(p.routes("buggy", ctx));
  });
});
