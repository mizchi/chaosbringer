/**
 * `runRecipe`'s `baseUrl`: a recipe keeps the absolute URLs it was
 * recorded with (`drive` saves `http://127.0.0.1:4791/login`), and
 * replaying it "against" another host used to mean replaying it on the
 * recording host — a verify or a load run that reported success for a
 * server it never reached. The fake Page logs where `goto` went and
 * follows a submit to `/done` on whatever origin it is on, so an
 * expectation that names the recorded origin shows whether it moved too.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { rebaseNotice, rebaseRecipe, recipeOrigin, runRecipe } from "./replay.js";
import type { ActionRecipe, RecipeStep } from "./types.js";
import { emptyStats } from "./types.js";

const RECORDED = "http://127.0.0.1:4791";
const BASE = "http://127.0.0.1:5802";

function fakePage(): { page: Page; visits: string[] } {
  const visits: string[] = [];
  let current = "about:blank";
  const page = {
    url: () => current,
    goto: async (url: string) => {
      visits.push(url);
      current = url;
    },
    fill: async () => {},
    click: async () => {
      current = `${new URL(current).origin}/done`;
    },
    keyboard: { press: async () => {} },
    locator: () => ({ press: async () => {}, first: () => ({ isVisible: async () => true }) }),
  } as unknown as Page;
  return { page, visits };
}

function recipe(steps: RecipeStep[], preconditions: ActionRecipe["preconditions"] = []): ActionRecipe {
  return {
    name: "site/login",
    description: "",
    preconditions,
    steps,
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "ai-extracted",
    status: "candidate",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("runRecipe with a baseUrl", () => {
  it("navigates on the base URL's origin, the recorded path, query and hash kept", async () => {
    const { page, visits } = fakePage();
    const r = recipe([
      { kind: "navigate", url: `${RECORDED}/login?next=%2Fcart#form` },
      { kind: "fill", selector: "#user", value: "admin" },
      { kind: "click", selector: "button", expectAfter: { urlContains: "/done", timeoutMs: 200 } },
    ]);
    const result = await runRecipe(page, r, { baseUrl: `${BASE}/` });
    expect(result).toMatchObject({ ok: true });
    expect(visits).toEqual([`${BASE}/login?next=%2Fcart#form`]);
  });

  it("moves an expectation that names the recorded origin along with the page", async () => {
    const { page } = fakePage();
    const r = recipe([
      { kind: "navigate", url: `${RECORDED}/login` },
      {
        kind: "click",
        selector: "button",
        expectAfter: { urlContains: `${RECORDED}/done`, urlNotContains: `${RECORDED}/login`, timeoutMs: 200 },
      },
    ]);
    expect(await runRecipe(page, r, { baseUrl: BASE })).toMatchObject({ ok: true });
    expect(page.url()).toBe(`${BASE}/done`);
  });

  it("leaves a navigate to another origin alone", async () => {
    const { page, visits } = fakePage();
    const r = recipe([
      { kind: "navigate", url: `${RECORDED}/login` },
      { kind: "navigate", url: "https://sso.example.test/authorize?client=app" },
      { kind: "navigate", url: `${RECORDED}/callback` },
    ]);
    await runRecipe(page, r, { baseUrl: BASE });
    expect(visits).toEqual([`${BASE}/login`, "https://sso.example.test/authorize?client=app", `${BASE}/callback`]);
  });

  it("leaves a recipe that starts on the matched page, then goes to another site, where it goes", async () => {
    // Fired on a cart page by `recipeDriver`: the payment provider is the
    // only absolute URL in it, and is not where it was recorded.
    const { page, visits } = fakePage();
    const pay = "https://pay.example.test/checkout?session=abc";
    const r = recipe(
      [
        { kind: "click", selector: "#checkout" },
        { kind: "navigate", url: pay, expectAfter: { urlContains: "https://pay.example.test/checkout", timeoutMs: 200 } },
      ],
      [{ urlPattern: "/cart$" }],
    );
    expect(rebaseRecipe(r, BASE)).toBe(r);
    expect(await runRecipe(page, r, { baseUrl: BASE })).toMatchObject({ ok: true });
    expect(visits).toEqual([pay]);
  });

  it("keeps a {{var}} in the path, and substitutes it after the move", async () => {
    const { page, visits } = fakePage();
    const r = recipe([{ kind: "navigate", url: `${RECORDED}/users/{{id}}` }]);
    await runRecipe(page, r, { baseUrl: BASE, vars: { id: 7 } });
    expect(visits).toEqual([`${BASE}/users/7`]);
  });

  it("does not move a recipe whose vars name the site", async () => {
    const { page, visits } = fakePage();
    const r = recipe([{ kind: "navigate", url: "{{base}}/about" }]);
    await runRecipe(page, r, { baseUrl: BASE, vars: { base: RECORDED } });
    expect(visits).toEqual([`${RECORDED}/about`]);
  });

  it("replays where it was recorded without one", async () => {
    const { page, visits } = fakePage();
    await runRecipe(page, recipe([{ kind: "navigate", url: `${RECORDED}/login` }]));
    expect(visits).toEqual([`${RECORDED}/login`]);
  });

  it("refuses a base URL with no origin to move to", async () => {
    const { page, visits } = fakePage();
    const r = recipe([{ kind: "navigate", url: `${RECORDED}/login` }]);
    await expect(runRecipe(page, r, { baseUrl: "staging.example.test" })).rejects.toThrow(/not an absolute http\(s\) URL/);
    expect(visits).toEqual([]);
  });
});

describe("recipeOrigin / rebaseRecipe / rebaseNotice", () => {
  it("takes the origin of a leading navigate, normalised", () => {
    expect(recipeOrigin(recipe([{ kind: "navigate", url: "HTTP://Shop.Example.TEST:80/x" }]))).toBe("http://shop.example.test");
    expect(recipeOrigin(recipe([{ kind: "click", selector: "a" }]))).toBeNull();
    expect(recipeOrigin(recipe([{ kind: "navigate", url: "http://{{host}}/x" }]))).toBeNull();
  });

  it("never takes it from a later navigate", () => {
    const steps: RecipeStep[] = [
      { kind: "click", selector: "#checkout" },
      { kind: "navigate", url: "https://pay.example.test/checkout" },
    ];
    expect(recipeOrigin(recipe(steps))).toBeNull();
    expect(recipeOrigin(recipe(steps, [{ urlPattern: "/cart$" }]))).toBeNull();
  });

  it("falls back to a first precondition that spells out the scheme and host", () => {
    const click: RecipeStep[] = [{ kind: "click", selector: "a" }];
    const origin = (urlPattern: string) => recipeOrigin(recipe(click, [{ urlPattern }]));
    expect(origin("^https://shop\\.example\\.test/cart$")).toBe("https://shop.example.test");
    expect(origin("^http:\\/\\/127\\.0\\.0\\.1:4791\\/cart")).toBe("http://127.0.0.1:4791");
    expect(origin("^http://localhost:4791$")).toBe("http://localhost:4791");
    // Not a host the pattern names: it matches more than one.
    expect(origin("^https?://shop\\.example\\.test/")).toBeNull();
    expect(origin("^http://localhost:\\d+/")).toBeNull();
    expect(origin("^https://[a-z]+\\.example\\.test/")).toBeNull();
    expect(origin("^https://shop\\.example\\.tests?/")).toBeNull();
    expect(origin("shop\\.example\\.test/cart")).toBeNull();
    // A leading navigate says it first.
    expect(
      recipeOrigin(recipe([{ kind: "navigate", url: `${RECORDED}/login` }], [{ urlPattern: "^https://shop\\.example\\.test/" }])),
    ).toBe(RECORDED);
  });

  it("moves a later navigate when the precondition names its origin", () => {
    const r = recipe(
      [
        { kind: "click", selector: "#checkout" },
        { kind: "navigate", url: `${RECORDED}/thanks` },
        { kind: "navigate", url: "https://pay.example.test/checkout" },
      ],
      [{ urlPattern: "^http://127\\.0\\.0\\.1:4791/cart$" }],
    );
    expect(rebaseRecipe(r, BASE).steps.slice(1)).toEqual([
      { kind: "navigate", url: `${BASE}/thanks` },
      { kind: "navigate", url: "https://pay.example.test/checkout" },
    ]);
  });

  it("returns the recipe itself when there is nothing to move", () => {
    const r = recipe([{ kind: "navigate", url: `${RECORDED}/login` }]);
    expect(rebaseRecipe(r, `${RECORDED}/somewhere-else`)).toBe(r);
  });

  it("moves an origin that is written with its default port", () => {
    const r = recipe([{ kind: "navigate", url: "http://shop.example.test:80/cart" }]);
    expect(rebaseRecipe(r, "https://staging.example.test").steps[0]).toEqual({
      kind: "navigate",
      url: "https://staging.example.test/cart",
    });
  });

  it("does not take a longer port for the recorded one", () => {
    const r = recipe([
      { kind: "navigate", url: `${RECORDED}/login` },
      { kind: "click", selector: "a", expectAfter: { urlContains: `${RECORDED}0/x` } },
    ]);
    expect(rebaseRecipe(r, BASE).steps[1]).toEqual(r.steps[1]);
  });

  it("says when the base URL moves a recipe, and only then", () => {
    const r = recipe([{ kind: "navigate", url: `${RECORDED}/login` }]);
    expect(rebaseNotice(r, `${BASE}/`)).toBe(`site/login was recorded on ${RECORDED}; replaying it on ${BASE} instead`);
    expect(rebaseNotice(r, `${RECORDED}/`)).toBeNull();
    expect(rebaseNotice(recipe([{ kind: "navigate", url: "{{base}}/" }]), BASE)).toBeNull();
  });
});
