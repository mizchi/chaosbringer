import { describe, expect, it } from "vitest";
import {
  TRACE_FORMAT_VERSION,
  actionToTraceEntry,
  groupTrace,
  metaOf,
  parseTrace,
  serializeTrace,
  type TraceEntry,
} from "./trace.js";
import type { ActionResult } from "./types.js";

const META: TraceEntry = {
  kind: "meta",
  v: TRACE_FORMAT_VERSION,
  seed: 42,
  baseUrl: "http://x/",
  startTime: 0,
};

describe("actionToTraceEntry", () => {
  it("copies optional fields only when set", () => {
    const action: ActionResult = {
      type: "click",
      target: "Home",
      selector: "a[href='/']",
      success: true,
      timestamp: 123,
    };
    expect(actionToTraceEntry(action, "http://x/")).toEqual({
      kind: "action",
      url: "http://x/",
      type: "click",
      target: "Home",
      selector: "a[href='/']",
      success: true,
    });
  });

  it("drops undefined optional fields", () => {
    const action: ActionResult = {
      type: "scroll",
      target: "scrollY: 200",
      success: true,
      timestamp: 0,
    };
    const entry = actionToTraceEntry(action, "http://x/");
    expect(entry).not.toHaveProperty("selector");
    expect(entry).not.toHaveProperty("error");
    expect(entry).not.toHaveProperty("blockedExternal");
  });
});

describe("serializeTrace / parseTrace", () => {
  it("round-trips a simple trace", () => {
    const entries: TraceEntry[] = [
      META,
      { kind: "visit", url: "http://x/" },
      {
        kind: "action",
        url: "http://x/",
        type: "click",
        target: "Home",
        selector: "a",
        success: true,
      },
    ];
    const parsed = parseTrace(serializeTrace(entries));
    expect(parsed).toEqual(entries);
  });

  it("rejects a serialize call that lacks a leading meta", () => {
    expect(() => serializeTrace([{ kind: "visit", url: "http://x/" }])).toThrow(/meta/);
  });

  it("ignores blank lines but rejects malformed JSON", () => {
    const ok = `${JSON.stringify(META)}\n\n${JSON.stringify({ kind: "visit", url: "/" })}\n`;
    expect(parseTrace(ok)).toHaveLength(2);

    const bad = `${JSON.stringify(META)}\nnot-json\n`;
    expect(() => parseTrace(bad)).toThrow(/line 2/);
  });

  it("rejects entries with unknown kinds", () => {
    const raw = `${JSON.stringify(META)}\n${JSON.stringify({ kind: "oops" })}\n`;
    expect(() => parseTrace(raw)).toThrow(/unknown kind/);
  });

  it("rejects traces missing the leading meta", () => {
    expect(() => parseTrace(`${JSON.stringify({ kind: "visit", url: "/" })}\n`)).toThrow(/meta/);
  });

  it("rejects traces with an unsupported format version", () => {
    const wrong = { ...META, v: TRACE_FORMAT_VERSION + 99 };
    expect(() => parseTrace(`${JSON.stringify(wrong)}\n`)).toThrow(/unsupported trace format/);
  });
});

describe("groupTrace", () => {
  it("splits actions by their preceding visit", () => {
    const groups = groupTrace([
      META,
      { kind: "visit", url: "http://x/a" },
      { kind: "action", url: "http://x/a", type: "click", success: true },
      { kind: "action", url: "http://x/a", type: "scroll", success: true },
      { kind: "visit", url: "http://x/b" },
      { kind: "action", url: "http://x/b", type: "input", success: true },
    ]);
    expect(groups).toEqual([
      {
        url: "http://x/a",
        actions: [
          { kind: "action", url: "http://x/a", type: "click", success: true },
          { kind: "action", url: "http://x/a", type: "scroll", success: true },
        ],
      },
      {
        url: "http://x/b",
        actions: [{ kind: "action", url: "http://x/b", type: "input", success: true }],
      },
    ]);
  });

  it("ignores actions that appear before any visit", () => {
    const groups = groupTrace([
      META,
      { kind: "action", url: "http://x/?", type: "click", success: true },
      { kind: "visit", url: "http://x/a" },
    ]);
    expect(groups).toEqual([{ url: "http://x/a", actions: [] }]);
  });
});

describe("metaOf", () => {
  it("returns the first entry when it is a meta", () => {
    expect(metaOf([META])).toBe(META);
  });

  it("throws when the trace is empty or starts with something else", () => {
    expect(() => metaOf([])).toThrow(/meta/);
    expect(() => metaOf([{ kind: "visit", url: "/" } as TraceEntry])).toThrow(/meta/);
  });
});
