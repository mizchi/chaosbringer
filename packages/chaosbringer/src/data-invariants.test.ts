import { describe, expect, it } from "vitest";
import {
  dataSafety,
  formatFrameHits,
  garbagePattern,
  injectedMarkup,
  notBlank,
  prototypePollution,
  renderedGarbage,
  xssMarker,
} from "./data-invariants.js";
import { invariants } from "./invariants.js";
import type { InvariantContext } from "./types.js";

describe("data-safety preset factories", () => {
  const presets = [
    ["data.xss-marker", xssMarker],
    ["data.injected-markup", injectedMarkup],
    ["data.prototype-pollution", prototypePollution],
    ["data.rendered-garbage", renderedGarbage],
    ["data.not-blank", notBlank],
  ] as const;

  it.each(presets)("%s: defaults to that name, afterActions and every URL", (name, preset) => {
    const inv = preset();
    expect(inv.name).toBe(name);
    expect(inv.when).toBe("afterActions");
    expect(inv.urlPattern).toBeUndefined();
    expect(typeof inv.check).toBe("function");
  });

  it.each(presets)("%s: honours name / when / urlPattern", (_, preset) => {
    const inv = preset({ name: "mine", when: "afterLoad", urlPattern: /\/checkout/ });
    expect(inv).toMatchObject({ name: "mine", when: "afterLoad", urlPattern: /\/checkout/ });
  });

  it("are re-exported on the invariants namespace", () => {
    expect(invariants).toMatchObject({ xssMarker, injectedMarkup, prototypePollution, renderedGarbage, notBlank, dataSafety });
  });

  it("renderedGarbage with no tokens passes without reading the page", async () => {
    const page = new Proxy(
      {},
      {
        get: () => {
          throw new Error("page read");
        },
      }
    ) as InvariantContext["page"];
    const result = await renderedGarbage({ tokens: [""] }).check({ page, url: "http://x/", errors: [], state: new Map() });
    expect(result).toBe(true);
  });
});

describe("dataSafety", () => {
  it("returns the four security and rendering presets in order, without notBlank", () => {
    expect(dataSafety().map((i) => i.name)).toEqual([
      "data.xss-marker",
      "data.injected-markup",
      "data.prototype-pollution",
      "data.rendered-garbage",
    ]);
  });

  it("applies the shared when / urlPattern to every preset", () => {
    for (const inv of dataSafety({ when: "afterLoad", urlPattern: "/app" })) {
      expect([inv.name, inv.when, inv.urlPattern]).toEqual([inv.name, "afterLoad", "/app"]);
    }
  });

  it("lets a preset's own options win over the shared ones", () => {
    const [xss, markup, pollution] = dataSafety({ when: "afterLoad", prototypePollution: { when: "afterActions", name: "pp" } });
    expect(xss!.when).toBe("afterLoad");
    expect(markup!.when).toBe("afterLoad");
    expect(pollution).toMatchObject({ name: "pp", when: "afterActions" });
  });
});

describe("garbagePattern", () => {
  const re = new RegExp(garbagePattern(["undefined", "NaN", "[object Object]", "Invalid Date"]));

  it.each(["undefined", "Hello undefined!", "Total: NaN", "NaN%", "Tags: [object Object]", "(Invalid Date)"])(
    "matches %j",
    (text) => {
      expect(re.test(text)).toBe(true);
    }
  );

  it.each(["undefinedBehavior", "isNaN", "NaN_count", "$NaN", "NaN$", "nan", "[object Objects]", "Invalid Dates"])(
    "leaves %j alone",
    (text) => {
      expect(re.test(text)).toBe(false);
    }
  );

  it("matches a token's regex characters literally", () => {
    expect(new RegExp(garbagePattern(["a.b"])).test("axb")).toBe(false);
    expect(new RegExp(garbagePattern(["a.b"])).test("a.b")).toBe(true);
  });
});

describe("formatFrameHits", () => {
  it("passes when no frame found anything", () => {
    expect(formatFrameHits("XSS marker set", [])).toBe(true);
    expect(formatFrameHits("XSS marker set", [{ count: 0, samples: [] }, { frame: "http://x/a", count: 0, samples: [] }])).toBe(true);
  });

  it("lists the top document first and names each iframe", () => {
    expect(
      formatFrameHits("XSS marker set", [
        { count: 1, samples: ["window.__cb_xss_fired"] },
        { frame: "http://x/embed", count: 1, samples: ["window.__xss_fired"] },
      ])
    ).toBe("XSS marker set: window.__cb_xss_fired; in frame http://x/embed: window.__xss_fired");
  });

  it("has no top-document section when only an iframe found something", () => {
    expect(formatFrameHits("Object.prototype polluted", [{ count: 0, samples: [] }, { frame: "http://x/a", count: 1, samples: ["cbPolluted"] }])).toBe(
      "Object.prototype polluted: in frame http://x/a: cbPolluted"
    );
  });

  it("shows three samples per frame and counts the rest", () => {
    expect(formatFrameHits("injected markup", [{ count: 5, samples: ["a", "b", "c", "d", "e"] }])).toBe(
      "injected markup: a, b, c (+2 more)"
    );
    expect(formatFrameHits("injected markup", [{ count: 2, samples: [] }])).toBe("injected markup: (+2 more)");
  });

  it("collapses whitespace and cuts each sample to 120 characters", () => {
    const out = formatFrameHits("rendered garbage", [{ count: 1, samples: [`NaN in "a\n\n  b ${"x".repeat(200)}"`] }]);
    expect(out).toBe(`rendered garbage: ${`NaN in "a b ${"x".repeat(200)}`.slice(0, 119)}…`);
  });
});
