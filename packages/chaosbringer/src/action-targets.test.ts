import { describe, expect, it } from "vitest";
import {
  scrollOnlyTargets,
  weighActionTargets,
  type RawActionTarget,
  type UrlFamiliarity,
  type WeightingContext,
} from "./action-targets.js";
import { DEFAULT_ACTION_WEIGHTS } from "./defaults.js";

const element = (over: Partial<RawActionTarget> = {}): RawActionTarget => ({
  tag: "div",
  text: "",
  role: null,
  ariaLabel: null,
  index: 0,
  hasVisibleText: false,
  isNavLink: false,
  isInMainContent: false,
  ...over,
});

const context = (over: Partial<WeightingContext> = {}): WeightingContext => ({
  weights: DEFAULT_ACTION_WEIGHTS,
  baseOrigin: "https://example.com/",
  familiarity: () => "new",
  ...over,
});

/** Weight of the single non-scroll target produced for `el`. */
const weigh = (el: RawActionTarget, ctx = context()): number => {
  const targets = weighActionTargets([el], ctx);
  expect(targets).toHaveLength(2); // the element, plus the scroll fallback
  return targets[0]!.weight;
};

describe("weighActionTargets: element type", () => {
  it("weights each kind from its configured knob", () => {
    expect(weigh(element({ tag: "a", href: "https://example.com/x" }))).toBeCloseTo(
      DEFAULT_ACTION_WEIGHTS.navigationLinks * 3 // link, and unvisited
    );
    expect(weigh(element({ tag: "button" }))).toBe(DEFAULT_ACTION_WEIGHTS.buttons);
    expect(weigh(element({ tag: "input" }))).toBe(DEFAULT_ACTION_WEIGHTS.inputs);
    expect(weigh(element({ tag: "div", role: "tab" }))).toBe(
      DEFAULT_ACTION_WEIGHTS.ariaInteractive
    );
  });

  it("labels each kind so the crawler knows how to act on it", () => {
    const kind = (el: RawActionTarget) => weighActionTargets([el], context())[0]!.type;
    expect(kind(element({ tag: "a" }))).toBe("link");
    expect(kind(element({ tag: "div", role: "button" }))).toBe("button");
    expect(kind(element({ tag: "div", role: "searchbox" }))).toBe("input");
    expect(kind(element({ tag: "div", role: "menuitem" }))).toBe("interactive");
  });

  it("falls back to weight 1 for an element with no type signal at all", () => {
    expect(weigh(element())).toBe(1);
  });

  it("honours custom weights rather than the defaults", () => {
    const ctx = context({
      weights: { ...DEFAULT_ACTION_WEIGHTS, buttons: 42 },
    });
    expect(weigh(element({ tag: "button" }), ctx)).toBe(42);
  });
});

describe("weighActionTargets: link familiarity", () => {
  const link = element({ tag: "a", href: "https://example.com/target" });
  const withFamiliarity = (f: UrlFamiliarity) =>
    weigh(link, context({ familiarity: () => f }));

  it("boosts unexplored ground and demotes ground already covered", () => {
    const base = DEFAULT_ACTION_WEIGHTS.navigationLinks;
    expect(withFamiliarity("new")).toBeCloseTo(base * 3);
    expect(withFamiliarity("visited")).toBeCloseTo(base * 0.2);
  });

  it("leaves a queued-but-unvisited link at its base weight", () => {
    // The case that is neither new nor old: it is spoken for, so boosting it
    // would double-count, and demoting it would bury a page never yet seen.
    expect(withFamiliarity("queued")).toBeCloseTo(DEFAULT_ACTION_WEIGHTS.navigationLinks);
  });

  it("asks about the absolute, normalized URL, not the raw href", () => {
    const asked: string[] = [];
    weigh(
      element({ tag: "a", href: "/deep/../page#fragment" }),
      context({
        baseOrigin: "https://example.com/",
        familiarity: (url) => {
          asked.push(url);
          return "new";
        },
      })
    );
    expect(asked).toEqual(["https://example.com/page"]);
  });

  // These two assert on `asked` rather than throwing from `familiarity`: the
  // resolution step is inside a try/catch, so a throw would be swallowed and
  // the weight assertion alone would pass even if familiarity *were* consulted.
  it("keeps the base weight when the href cannot be resolved", () => {
    const asked: string[] = [];
    const ctx = context({
      baseOrigin: "not a base",
      familiarity: (url) => {
        asked.push(url);
        return "visited";
      },
    });
    expect(weigh(element({ tag: "a", href: "://broken" }), ctx)).toBe(
      DEFAULT_ACTION_WEIGHTS.navigationLinks
    );
    expect(asked).toEqual([]);
  });

  it("does not consult familiarity for a link with no href", () => {
    const asked: string[] = [];
    const ctx = context({
      familiarity: (url) => {
        asked.push(url);
        return "visited";
      },
    });
    expect(weigh(element({ tag: "a" }), ctx)).toBe(DEFAULT_ACTION_WEIGHTS.navigationLinks);
    expect(asked).toEqual([]);
  });
});

describe("weighActionTargets: positional boosts", () => {
  it("multiplies a nav-region link by 1.5", () => {
    const inNav = weigh(element({ tag: "a", isNavLink: true }));
    const elsewhere = weigh(element({ tag: "a" }));
    expect(inNav / elsewhere).toBeCloseTo(1.5);
  });

  it("multiplies an element in main content by 1.5, whatever its kind", () => {
    for (const tag of ["a", "button", "input"]) {
      const inMain = weigh(element({ tag, isInMainContent: true }));
      const elsewhere = weigh(element({ tag }));
      expect(inMain / elsewhere).toBeCloseTo(1.5);
    }
  });

  it("applies the visible-text knob to elements that carry visible text", () => {
    const visible = weigh(element({ tag: "button", hasVisibleText: true }));
    const blank = weigh(element({ tag: "button" }));
    expect(visible / blank).toBeCloseTo(DEFAULT_ACTION_WEIGHTS.visibleText);
  });

  it("compounds every boost that applies", () => {
    const el = element({
      tag: "a",
      href: "https://example.com/x",
      isNavLink: true,
      isInMainContent: true,
      hasVisibleText: true,
    });
    expect(weigh(el)).toBeCloseTo(
      DEFAULT_ACTION_WEIGHTS.navigationLinks *
        1.5 * // nav region
        3 * // unvisited
        DEFAULT_ACTION_WEIGHTS.visibleText *
        1.5 // main content
    );
  });
});

describe("weighActionTargets: selectors", () => {
  const selectorOf = (el: RawActionTarget) =>
    weighActionTargets([el], context())[0]!.selector;

  it("prefers matching on short visible text", () => {
    expect(selectorOf(element({ tag: "button", text: "Save" }))).toBe(
      'button:has-text("Save")'
    );
  });

  it("falls back to the aria-label once the text is too long to be stable", () => {
    expect(
      selectorOf(element({ tag: "button", text: "x".repeat(60), ariaLabel: "Save" }))
    ).toBe('button[aria-label="Save"]');
  });

  it("falls back to role position when there is neither text nor label", () => {
    expect(selectorOf(element({ tag: "div", role: "tab", index: 2 }))).toBe(
      '[role="tab"]:nth-of-type(3)'
    );
  });

  it("falls back to tag position as a last resort", () => {
    expect(selectorOf(element({ tag: "span", index: 0 }))).toBe("span:nth-of-type(1)");
  });

  it("escapes quotes in text so the selector stays parseable", () => {
    expect(selectorOf(element({ tag: "button", text: 'Say "hi"' }))).toBe(
      'button:has-text("Say \\"hi\\"")'
    );
  });
});

describe("weighActionTargets: the scroll fallback", () => {
  it("always offers scrolling, at its configured weight", () => {
    const targets = weighActionTargets([], context());
    expect(targets).toEqual([
      { selector: "window", weight: DEFAULT_ACTION_WEIGHTS.scroll, type: "scroll" },
    ]);
  });

  it("appends scroll after the page's own targets", () => {
    const targets = weighActionTargets([element({ tag: "button" })], context());
    expect(targets.map((t) => t.type)).toEqual(["button", "scroll"]);
  });

  it("offers scrolling alone when the page could not be scraped", () => {
    expect(scrollOnlyTargets()).toEqual([
      { selector: "window", weight: 1, type: "scroll" },
    ]);
  });
});
