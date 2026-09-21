import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILL_VALUE,
  fillValueFor,
  scrollOnlyTargets,
  selectValueFor,
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
  placeholder: null,
  name: null,
  fillable: false,
  inputType: null,
  min: null,
  max: null,
  options: [],
  currentValue: null,
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
    expect(weigh(element({ tag: "input", fillable: true }))).toBe(
      DEFAULT_ACTION_WEIGHTS.inputs
    );
    expect(weigh(element({ tag: "div", role: "tab" }))).toBe(
      DEFAULT_ACTION_WEIGHTS.ariaInteractive
    );
  });

  it("labels each kind so the crawler knows how to act on it", () => {
    const kind = (el: RawActionTarget) => weighActionTargets([el], context())[0]!.type;
    expect(kind(element({ tag: "a" }))).toBe("link");
    expect(kind(element({ tag: "div", role: "button" }))).toBe("button");
    expect(kind(element({ tag: "input", fillable: true }))).toBe("input");
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
      ':nth-match([role="tab"], 3)'
    );
  });

  it("falls back to tag position as a last resort", () => {
    expect(selectorOf(element({ tag: "span", index: 0 }))).toBe(":nth-match(span, 1)");
  });

  it("counts page matches, not same-tag siblings, in the positional fallback", () => {
    // `index` is the element's position among this page's matches for its
    // query. `:nth-of-type(n)` means something else entirely — the nth child of
    // that tag under one parent — so a selector built with it points at the
    // wrong element, or at none.
    for (const sel of [
      selectorOf(element({ tag: "span", index: 4 })),
      selectorOf(element({ tag: "div", role: "tab", index: 4 })),
    ]) {
      expect(sel).toContain(":nth-match(");
      expect(sel).not.toContain(":nth-of-type(");
    }
  });

  it("escapes a role value, which comes from the page and not from us", () => {
    // Reachable: the form-field scrape reads `role` straight off the element,
    // so a page can put anything there.
    expect(selectorOf(element({ tag: "input", role: 'we"ird', index: 0 }))).toBe(
      ':nth-match([role="we\\"ird"], 1)'
    );
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

describe("weighActionTargets: form fields", () => {
  const field = (over: Partial<RawActionTarget> = {}) =>
    element({ tag: "input", text: "", ...over });
  const targetFor = (el: RawActionTarget) => weighActionTargets([el], context())[0]!;

  // The bug these cover: every form field used to get a selector that matched
  // nothing. A label or placeholder was copied into `text`, which sent
  // selectorFor down the `:has-text()` branch — and an <input> has no text
  // content, so `input:has-text("Search")` matches zero elements. An unlabelled
  // field fared no better: `role` defaulted to the invented value "input",
  // producing `[role="input"]`, which nothing in HTML ever carries. Downstream
  // a zero-match locator reports `isVisible() === false`, so the crawler
  // skipped the target silently and the `inputs` weight did nothing at all.

  it("addresses a field by attribute, never by text it does not have", () => {
    for (const el of [
      field({ ariaLabel: "Email address" }),
      field({ placeholder: "Search" }),
      field({ name: "username" }),
    ]) {
      expect(targetFor(el).selector).not.toContain(":has-text(");
    }
  });

  it("prefers aria-label, then placeholder, then name", () => {
    expect(
      targetFor(field({ ariaLabel: "Email", placeholder: "you@example.com", name: "em" }))
        .selector
    ).toBe('input[aria-label="Email"]');
    expect(targetFor(field({ placeholder: "Search", name: "q" })).selector).toBe(
      'input[placeholder="Search"]'
    );
    expect(targetFor(field({ name: "username" })).selector).toBe('input[name="username"]');
  });

  it("falls back to page position for a field with no identifying attribute", () => {
    expect(targetFor(field({ index: 2 })).selector).toBe(":nth-match(input, 3)");
  });

  it("keeps the element's real tag, so textareas are addressable", () => {
    expect(targetFor(field({ tag: "textarea", name: "notes" })).selector).toBe(
      'textarea[name="notes"]'
    );
    expect(
      targetFor(field({ tag: "div", ariaLabel: "Rich editor", fillable: true })).selector
    ).toBe('div[aria-label="Rich editor"]');
  });

  it("escapes attribute values so the selector stays parseable", () => {
    expect(targetFor(field({ placeholder: 'Say "hi"' })).selector).toBe(
      'input[placeholder="Say \\"hi\\""]'
    );
  });

  it("types only fillable fields as input; the rest are clicked", () => {
    // fill() throws on a checkbox, a submit button, or a role="textbox" div
    // that is not contenteditable, and a thrown fill is recorded as a failed
    // action against the page under test. Keeping them as clickable targets
    // exercises them without inventing failures.
    expect(targetFor(field({ name: "q", fillable: true })).type).toBe("input");
    expect(targetFor(field({ name: "agree", fillable: false })).type).toBe("interactive");
    expect(
      targetFor(field({ tag: "div", role: "textbox", ariaLabel: "Fake", fillable: false }))
        .type
    ).toBe("interactive");
  });

  it("still offers a non-fillable control at the interactive weight, not weight 1", () => {
    expect(weigh(field({ name: "agree", fillable: false }))).toBe(
      DEFAULT_ACTION_WEIGHTS.ariaInteractive
    );
  });
});

describe("fillValueFor", () => {
  const field = (over: Partial<RawActionTarget> = {}) =>
    element({ tag: "input", fillable: true, ...over });

  // `fill()` writes the string and then checks the control kept it, so a value
  // of the wrong shape is rejected as "Malformed value" — and that rejection is
  // recorded as a failed action against the page under test. Every format here
  // is pinned end-to-end against Chromium in action-targets.e2e.test.ts; these
  // cases exist so a change to the table is visible in the diff.

  it("types plain text into a plain text field", () => {
    for (const inputType of ["text", "search", "password", null]) {
      expect(fillValueFor(field({ inputType }))).toBe(DEFAULT_FILL_VALUE);
    }
  });

  it("gives a typed field a value of that type's shape", () => {
    const valueFor = (inputType: string) => fillValueFor(field({ inputType }));
    expect(valueFor("email")).toBe("test@example.com");
    expect(valueFor("tel")).toBe("+15555550123");
    expect(valueFor("url")).toBe("https://example.com");
    expect(valueFor("number")).toBe("42");
    expect(valueFor("date")).toBe("2024-01-15");
    expect(valueFor("datetime-local")).toBe("2024-01-15T10:30");
    expect(valueFor("month")).toBe("2024-01");
    expect(valueFor("week")).toBe("2024-W03");
    expect(valueFor("time")).toBe("10:30");
    expect(valueFor("color")).toBe("#336699");
  });

  it("falls back to plain text for a type it has no shape for", () => {
    expect(fillValueFor(field({ inputType: "some-future-type" }))).toBe(
      DEFAULT_FILL_VALUE
    );
  });

  it("gives a range its own minimum, which is always on the step grid", () => {
    // A range rejects any value off its step grid, so a fixed number fails even
    // when it sits inside [min, max]. Step counting starts at min, so min is
    // valid whatever the step — and being the minimum rather than the midpoint,
    // it also differs from the control's default, so the fill actually moves it.
    expect(fillValueFor(field({ inputType: "range", min: "5", max: "7" }))).toBe("5");
    expect(fillValueFor(field({ inputType: "range", min: "0", max: "10" }))).toBe("0");
    expect(fillValueFor(field({ inputType: "range", min: "-10", max: "-5" }))).toBe(
      "-10"
    );
    expect(fillValueFor(field({ inputType: "range", min: "0.5", max: "1" }))).toBe(
      "0.5"
    );
  });

  it("uses the implicit minimum when a range declares none", () => {
    expect(fillValueFor(field({ inputType: "range" }))).toBe("0");
    expect(fillValueFor(field({ inputType: "range", max: "10" }))).toBe("0");
  });

  it("falls back to 0 rather than passing on a min it cannot read", () => {
    expect(fillValueFor(field({ inputType: "range", min: "abc" }))).toBe("0");
    expect(fillValueFor(field({ inputType: "range", min: "" }))).toBe("0");
  });

  it("is only consulted for targets typed as input", () => {
    const targets = weighActionTargets(
      [
        field({ inputType: "date", name: "d" }),
        element({ tag: "button", text: "Save" }),
        element({ tag: "a", href: "https://example.com/x", text: "Link" }),
        field({ inputType: "checkbox", name: "c", fillable: false }),
      ],
      context()
    );
    expect(targets.map((t) => [t.type, t.fillValue])).toEqual([
      ["input", "2024-01-15"],
      ["button", undefined],
      ["link", undefined],
      ["interactive", undefined],
      ["scroll", undefined],
    ]);
  });
});

describe("selectValueFor", () => {
  const dropdown = (over: Partial<RawActionTarget> = {}) =>
    element({ tag: "select", ...over });

  it("takes the first offered value that is not the one already set", () => {
    expect(
      selectValueFor(
        dropdown({
          currentValue: "standard",
          options: [
            { value: "standard", label: "Standard" },
            { value: "express", label: "Express" },
          ],
        }),
      ),
    ).toBe("express");
  });

  it("does not choose the value already set, even when it is first", () => {
    // Setting what is set costs a step, succeeds, and reads in the report
    // as an action that did something. A driver that keeps picking it
    // oscillates on a dropdown that never moves.
    expect(
      selectValueFor(
        dropdown({
          currentValue: "standard",
          options: [{ value: "standard", label: "Standard" }],
        }),
      ),
    ).toBeUndefined();
  });

  it("is undefined when the page offers nothing", () => {
    // Every option was a placeholder, so the scrape kept none.
    expect(selectValueFor(dropdown({ currentValue: "", options: [] }))).toBeUndefined();
  });

  it("is deterministic — the same dropdown gives the same value", () => {
    const d = dropdown({
      currentValue: "a",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    });
    expect(selectValueFor(d)).toBe(selectValueFor(d));
    expect(selectValueFor(d)).toBe("b");
  });
});

describe("weighActionTargets: a dropdown", () => {
  it("is a select target, not an interactive one", () => {
    // `interactive` would mean "click it", and clicking a native <select>
    // opens its list and selects nothing.
    const [target] = weighActionTargets(
      [
        element({
          tag: "select",
          name: "shipping",
          currentValue: "standard",
          options: [
            { value: "standard", label: "Standard" },
            { value: "express", label: "Express" },
          ],
        }),
      ],
      context(),
    );
    expect(target!.type).toBe("select");
    expect(target!.selectValue).toBe("express");
    // Not a fill target: `fill()` throws on a <select>.
    expect(target!.fillValue).toBeUndefined();
  });

  it("is weighted like the field it is", () => {
    expect(
      weigh(element({ tag: "select", options: [{ value: "x", label: "X" }] })),
    ).toBe(DEFAULT_ACTION_WEIGHTS.inputs);
  });

  it("carries no selectValue when there is nothing to set", () => {
    const [target] = weighActionTargets(
      [element({ tag: "select", currentValue: "only", options: [{ value: "only", label: "Only" }] })],
      context(),
    );
    expect(target!.type).toBe("select");
    expect(target!.selectValue).toBeUndefined();
  });
});
