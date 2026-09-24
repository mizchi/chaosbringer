import { describe, expect, it } from "vitest";
import { selectTerminalBrowserTarget } from "./terminal-browser.js";

const listing = (browsers: unknown[]) => ({ browsers });
const browser = (cdpPort: number | null, tabs: unknown[]) => ({ cdpPort, tabs });
const tab = (url: string, targetId: string, active = true) => ({ url, targetId, active });

describe("selectTerminalBrowserTarget", () => {
  it("selects the only tab with the exact URL", () => {
    expect(selectTerminalBrowserTarget(listing([
      browser(9222, [tab("http://localhost:3000/", "wanted"), tab("https://example.com/", "other", false)]),
      browser(9333, [tab("https://elsewhere.test/", "elsewhere")]),
    ]), "http://localhost:3000")).toEqual({ cdpEndpoint: "9222", cdpTargetId: "wanted" });
  });

  it("selects the active tab on the same origin when the route differs", () => {
    expect(selectTerminalBrowserTarget(listing([
      browser(9222, [tab("http://localhost:3000/dashboard", "inactive", false), tab("http://localhost:3000/settings", "active")]),
    ]), "http://localhost:3000/")).toEqual({ cdpEndpoint: "9222", cdpTargetId: "active" });
  });

  it("rejects ambiguous matching tabs", () => {
    expect(() => selectTerminalBrowserTarget(listing([
      browser(9222, [tab("http://localhost:3000/", "one")]),
      browser(9333, [tab("http://localhost:3000/", "two")]),
    ]), "http://localhost:3000/")).toThrow(/multiple.*--cdp/);
  });

  it("rejects unrelated tabs and missing CDP ports", () => {
    expect(() => selectTerminalBrowserTarget(listing([
      browser(9222, [tab("https://example.com/", "other")]),
    ]), "http://localhost:3000/")).toThrow(/no matching tab/);
    expect(() => selectTerminalBrowserTarget(listing([
      browser(null, [tab("http://localhost:3000/", "wanted")]),
    ]), "http://localhost:3000/")).toThrow(/CDP port/);
  });

  it("rejects malformed listing output", () => {
    expect(() => selectTerminalBrowserTarget({ browsers: "broken" }, "http://localhost:3000/")).toThrow(/invalid.*JSON/);
  });
});
