import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ariaCandidates, ariaOutline, parseAriaSnapshot, readAria } from "./aria-snapshot.js";

const PAGE = `<header><nav aria-label="Main"><a href="/a">About "us"</a><a href="/b">Blog</a></nav></header>
<main><h2>Checkout</h2><form>
<label>Name <input name=n value="Ada"></label>
<label><input type=checkbox checked> Remember me</label>
<select aria-label="Country"><option>Japan</option><option selected>France</option></select>
<textarea placeholder="Notes"></textarea>
<button disabled>Pay</button><button>Pay</button><button>Pay</button>
</form>
<div style="cursor:pointer" onclick="this.textContent='clicked'"><span>Open card</span></div>
<a href="/c"><div style="cursor:pointer">Inside a link</div></a>
<div role="dialog" aria-label="Cookies"><p>We use cookies: yes</p><button>Accept all</button></div>
<iframe srcdoc="<button>Inside</button>"></iframe>
</main>`;

describe("candidates from the accessibility snapshot", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(PAGE);
    await page.frameLocator("iframe").locator("button").waitFor();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("lists every operable control once, a dialog's first, with its state and where it sits", async () => {
    const { candidates } = await readAria(page);
    expect(candidates.map((c) => c.description)).toEqual([
      'button "Accept all" — in dialog "Cookies", under "Checkout"',
      'link "About \\"us\\"" -> /a — in navigation "Main"',
      'link "Blog" -> /b — in navigation "Main"',
      'textbox "Name" = "Ada" — in main, under "Checkout"',
      'checkbox "Remember me" [checked] — in main, under "Checkout"',
      'combobox "Country" options: Japan, France* — in main, under "Checkout"',
      'textbox "Notes" — in main, under "Checkout"',
      'button "Pay" — in main, under "Checkout"',
      'button "Pay" — in main, under "Checkout"',
      'clickable "Open card" — in main, under "Checkout"',
      'link "Inside a link" -> /c — in main, under "Checkout"',
    ]);
    expect(candidates.find((c) => c.role === "combobox")).toMatchObject({ type: "select", value: "France", options: ["Japan", "France"] });
    expect(candidates.find((c) => c.name === "Name")).toMatchObject({ type: "input", value: "Ada" });
    expect(candidates[0]!.inDialog).toBe(true);
  });

  it("gives each control a selector that finds the same element its ref does", async () => {
    const { candidates } = await readAria(page);
    for (const c of candidates) {
      const byRef = page.locator(`aria-ref=${c.ref}`);
      if (c.selector === undefined) {
        // Only the role-less clickable has none; it is still actionable by ref.
        expect(c.role).toBe("generic");
        expect(await byRef.count()).toBe(1);
        continue;
      }
      const bySelector = page.locator(c.selector);
      expect(await bySelector.count(), c.selector).toBe(1);
      const same = await bySelector.evaluate((el, ref) => el === ref, await byRef.elementHandle());
      expect(same, c.selector).toBe(true);
    }
    // The disabled "Pay" is counted, so the live ones are nth=1 and nth=2.
    expect(candidates.filter((c) => c.name === "Pay").map((c) => c.selector)).toEqual([
      'role=button[name="Pay"s] >> nth=1',
      'role=button[name="Pay"s] >> nth=2',
    ]);
  });

  it("acts on a role-less clickable through its ref", async () => {
    const { candidates } = await readAria(page);
    const card = candidates.find((c) => c.description.startsWith('clickable "Open card"'))!;
    await page.locator(`aria-ref=${card.ref}`).click();
    expect(await page.getByText("clicked").count()).toBe(1);
  });
});

describe("the outline a model reads", () => {
  it("tags candidates with their index and drops refs and urls", () => {
    const snapshot = [
      "- main [ref=e1]:",
      '  - heading "Shop" [level=1] [ref=e2]',
      '  - link "Home" [ref=e3] [cursor=pointer]:',
      "    - /url: /",
      '  - button "Buy" [ref=e4]',
    ].join("\n");
    const candidates = ariaCandidates(parseAriaSnapshot(snapshot));
    expect(ariaOutline(snapshot, candidates)).toBe(
      ["- main:", '  - heading "Shop" [level=1]', '  - [#0] link "Home":', '  - [#1] button "Buy"'].join("\n"),
    );
    expect(ariaOutline(snapshot, candidates, { maxLines: 2 })).toBe(["- main:", '  - heading "Shop" [level=1]', "… (2 more lines)"].join("\n"));
  });
});
