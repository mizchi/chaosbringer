import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRawTargets, weighActionTargets } from "./action-targets.js";
import { DEFAULT_ACTION_WEIGHTS } from "./defaults.js";
import type { ActionTarget } from "./types.js";

/**
 * Every generated selector has to actually resolve, against a real browser.
 *
 * This is the gap the unit tests structurally cannot cover. They pin the
 * *shape* of the selector string, but a string that matches zero elements looks
 * exactly like a correct one until a browser is asked. And a zero-match locator
 * is invisible downstream: `performActionOnTarget` reads
 * `isVisible().catch(() => false)`, which is `false` for a locator that matches
 * nothing just as it is for an element scrolled out of view, so the crawler
 * skips the target and says nothing.
 *
 * That is how the whole `inputs` weight came to be dead. Form fields got
 * `input:has-text("Search")` — built from a label or placeholder, against an
 * element with no text content — or `[role="input"]`, a role that does not
 * exist in HTML. Both match nothing, both were silently skipped, and a green
 * unit suite had no way to notice.
 *
 * `fill()` is exercised for the same reason: a selector that resolves is only
 * half the job if the action then throws, because a thrown fill is recorded as
 * a failed action against the page under test.
 */
describe("generated selectors resolve in a real browser", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Scrape `html`, weigh it, and return the targets the crawler would act on. */
  async function targetsFor(html: string): Promise<ActionTarget[]> {
    await page.setContent(html);
    const raw = await page.evaluate(collectRawTargets);
    return weighActionTargets(raw, {
      weights: DEFAULT_ACTION_WEIGHTS,
      baseOrigin: "http://localhost/",
      familiarity: () => "new",
    }).filter((t) => t.type !== "scroll");
  }

  /** Every shape of form control that shares the `<input>`/`<textarea>` markup. */
  const FORM_PAGE = `<main>
    <input placeholder="Search">
    <input aria-label="Email address" type="email">
    <input name="username">
    <input type="password" name="pw">
    <input>
    <input type="checkbox" name="agree">
    <input type="submit" value="Go">
    <input type="number" name="qty">
    <input type="file" name="doc">
    <textarea placeholder="Your message"></textarea>
    <textarea name="notes"></textarea>
    <div contenteditable aria-label="Rich editor">edit me</div>
    <div role="textbox" aria-label="Fake box"></div>
    <div role="searchbox" aria-label="Find"></div>
  </main>`;

  it("resolves every form-control selector to exactly one element", async () => {
    const targets = await targetsFor(FORM_PAGE);
    const unresolved: string[] = [];
    for (const t of targets) {
      if ((await page.locator(t.selector).count()) !== 1) unresolved.push(t.selector);
    }
    expect(unresolved).toEqual([]);
    // Guard against the assertion passing because nothing was scraped at all.
    expect(targets.length).toBe(14);
  });

  it("fills every target it typed as an input, without throwing", async () => {
    const targets = await targetsFor(FORM_PAGE);
    const inputs = targets.filter((t) => t.type === "input");
    const threw: string[] = [];
    for (const t of inputs) {
      try {
        await page
          .locator(t.selector)
          .first()
          .fill(t.fillValue ?? "test input", { timeout: 2000 });
      } catch {
        threw.push(`${t.selector} <- ${JSON.stringify(t.fillValue)}`);
      }
    }
    expect(threw).toEqual([]);
    // Five text-ish inputs (placeholder, email, username, password, bare), a
    // number, two textareas, one contenteditable.
    expect(inputs.length).toBe(9);
  });

  /** Every `<input type>` the crawler is expected to type into. */
  const TYPED_PAGE = `<main>
    <input name="email" type="email">
    <input name="tel" type="tel">
    <input name="url" type="url">
    <input name="num" type="number">
    <input name="rng" type="range">
    <input name="rng2" type="range" min="5" max="7">
    <input name="rng3" type="range" min="0" max="10" step="5">
    <input name="rng4" type="range" min="-10" max="-5">
    <input name="date" type="date">
    <input name="dtl" type="datetime-local">
    <input name="month" type="month">
    <input name="week" type="week">
    <input name="time" type="time">
    <input name="color" type="color">
  </main>`;

  it("types a value each field's own type will accept", async () => {
    // `fill()` writes the string and then checks the control kept it, so a
    // value of the wrong shape is rejected outright — this is the assertion
    // that a hand-written table of formats cannot substitute for.
    const targets = await targetsFor(TYPED_PAGE);
    expect(targets.every((t) => t.type === "input")).toBe(true);
    expect(targets.length).toBe(14);

    const rejected: string[] = [];
    const kept: Record<string, string> = {};
    for (const t of targets) {
      const field = page.locator(t.selector).first();
      try {
        await field.fill(t.fillValue!, { timeout: 2000 });
        kept[t.selector] = await field.inputValue();
      } catch {
        rejected.push(`${t.selector} <- ${JSON.stringify(t.fillValue)}`);
      }
    }
    expect(rejected).toEqual([]);
    // And the control kept what we sent, rather than silently coercing it.
    expect(kept['input[name="email"]']).toBe("test@example.com");
    expect(kept['input[name="date"]']).toBe("2024-01-15");
    expect(kept['input[name="color"]']).toBe("#336699");
  });

  it("respects a range's own bounds, which a fixed number would not", async () => {
    const targets = await targetsFor(TYPED_PAGE);
    const valueOf = (sel: string) => targets.find((t) => t.selector === sel)!.fillValue;
    expect(valueOf('input[name="rng"]')).toBe("0"); // implicit min
    expect(valueOf('input[name="rng2"]')).toBe("5");
    expect(valueOf('input[name="rng3"]')).toBe("0"); // step=5, and 0 is on grid
    expect(valueOf('input[name="rng4"]')).toBe("-10");
  });

  it("drops disabled controls, including those disabled by a fieldset", async () => {
    // Playwright will neither click nor fill a disabled control: each attempt
    // burns its full actionability timeout and is then recorded as a failed
    // action against the page. A <fieldset disabled> is the case `.disabled`
    // misses and `:disabled` catches.
    const targets = await targetsFor(`<main>
      <input name="live" placeholder="Live">
      <input name="dead" placeholder="Dead" disabled>
      <button>Live button</button>
      <button disabled>Dead button</button>
      <fieldset disabled>
        <input name="fsdead">
        <button>Dead by fieldset</button>
      </fieldset>
    </main>`);
    expect(targets.map((t) => t.selector)).toEqual([
      "button:has-text(\"Live button\")",
      'input[placeholder="Live"]',
    ]);
  });

  it("acts on every target it offers, with no manufactured failure", async () => {
    // The end-to-end claim: whatever the page contains, each target the
    // crawler is handed can actually be acted on the way its type says.
    const targets = await targetsFor(`<main>
      ${FORM_PAGE}${TYPED_PAGE}
      <a href="/x">Link</a><button disabled>Dead</button>
      <input readonly placeholder="Read only">
    </main>`);
    const failures: string[] = [];
    let acted = 0;
    for (const t of targets) {
      const el = page.locator(t.selector).first();
      // The same gate performActionOnTarget applies. An element with no box —
      // an empty role="textbox" div is zero-height — is skipped rather than
      // acted on, which is correct: it is not there to be interacted with.
      if (!(await el.isVisible().catch(() => false))) continue;
      acted++;
      try {
        if (t.type === "input") await el.fill(t.fillValue!, { timeout: 2000 });
        else if (t.type !== "link") await el.click({ timeout: 2000 });
      } catch (err) {
        failures.push(`${t.type} ${t.selector}: ${String(err).split("\n")[0]}`);
      }
    }
    expect(failures).toEqual([]);
    expect(acted).toBeGreaterThan(20);
  });

  it("classifies the controls fill() refuses as clickable, not as inputs", async () => {
    const targets = await targetsFor(FORM_PAGE);
    const byType = (type: ActionTarget["type"]) =>
      targets.filter((t) => t.type === type).map((t) => t.selector);

    // A checkbox, a submit, a file picker, and two role-only divs that are not
    // contenteditable: real controls, but ones fill() rejects at any value.
    // The number field is absent because it *is* fillable — with "42", not
    // with "test input".
    expect(byType("interactive")).toEqual([
      'input[name="agree"]',
      ":nth-match(input, 7)",
      'input[name="doc"]',
      'div[aria-label="Fake box"]',
      'div[aria-label="Find"]',
    ]);
  });

  it("resolves selectors for links, buttons and ARIA controls too", async () => {
    // The label-only entries are the ones that matter: an element whose only
    // name is an aria-label has no text content, so copying that label into
    // `text` produces a `:has-text()` selector matching nothing. The two
    // sliders pin the counting — the ARIA query walks every role at once, so
    // an index taken from it would put the first slider at position 3.
    const targets = await targetsFor(`<main>
      <a href="/one">Go somewhere</a>
      <a href="/two" aria-label="Icon only link"></a>
      <button aria-label="Save">Save</button>
      <button aria-label="Close"></button>
      <button></button>
      <div role="button" aria-label="Not a button element"></div>
      <div role="tab">Tab one</div>
      <div role="menuitem" aria-label="Open"></div>
      <div role="slider"></div>
      <div role="slider"></div>
    </main>`);
    const unresolved: string[] = [];
    for (const t of targets) {
      if ((await page.locator(t.selector).count()) !== 1) unresolved.push(t.selector);
    }
    expect(unresolved).toEqual([]);
    expect(targets.length).toBe(10);
  });

  it("addresses a label-only control by its label, and keeps its real tag", async () => {
    const targets = await targetsFor(`<main>
      <button aria-label="Close"></button>
      <div role="button" aria-label="Not a button element"></div>
      <a href="/two" aria-label="Icon only link"></a>
    </main>`);
    expect(targets.map((t) => t.selector)).toEqual([
      'a[aria-label="Icon only link"]',
      'button[aria-label="Close"]',
      'div[aria-label="Not a button element"]',
    ]);
  });

  it("resolves a positional selector to the element its index named", async () => {
    // The positional fallback is the one branch where a selector can resolve to
    // *an* element yet still be the wrong one, which no count() check catches.
    await page.setContent(
      `<main><div><input></div><div><input></div><div><input></div></main>`
    );
    const raw = await page.evaluate(collectRawTargets);
    const targets = weighActionTargets(raw, {
      weights: DEFAULT_ACTION_WEIGHTS,
      baseOrigin: "http://localhost/",
      familiarity: () => "new",
    }).filter((t) => t.type !== "scroll");

    // Each input is an only child, so every one of them is :nth-of-type(1) —
    // the construct the selector used to use would have collapsed all three
    // onto the first.
    await page.locator("input").nth(2).evaluate((el) => {
      (el as HTMLInputElement).dataset.marker = "third";
    });
    const third = targets[2]!;
    expect(third.selector).toBe(":nth-match(input, 3)");
    expect(
      await page.locator(third.selector).getAttribute("data-marker")
    ).toBe("third");
  });
});
