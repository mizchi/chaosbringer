import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { dataSafety, injectedMarkup, notBlank, prototypePollution, renderedGarbage, xssMarker } from "./data-invariants.js";
import { getExitCode } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { Invariant } from "./types.js";

/**
 * The data-safety presets on real pages: each one on a page that shows what
 * it looks for, and on the near misses an ordinary site has, which must stay
 * clean. Payloads only set markers.
 */
describe("data-safety invariant presets", () => {
  let server: TestServer;
  let browser: Browser;
  let base: string;
  let cross: string;

  const doc = (body: string) => `<!doctype html><html lang="en"><title>t</title><body>${body}</body></html>`;

  // The reflected-XSS pair the crawl tests run: the same query, rendered as
  // HTML and as text.
  const search = (sink: "innerHTML" | "textContent") =>
    doc(
      `<h1>Search</h1><p id="results"></p><script>` +
        `const q = new URLSearchParams(location.search).get("q") ?? "";` +
        `document.getElementById("results").${sink} = "Results for " + q;` +
        `</script>`
    );
  const XSS_QUERY = `?q=${encodeURIComponent('<details open ontoggle="window.__cb_xss_fired=1"></details>')}`;

  /** Page bodies by path. `{cross}` is the other origin. */
  const PAGES: Record<string, string> = {
    "/xss": `<h1>x</h1><script>window.__cb_xss_fired = 1</script>`,
    "/xss-in-frame": `<h1>x</h1><iframe title="embed" src="/embed/xss"></iframe>`,
    "/xss-cross-frame": `<h1>x</h1><iframe title="embed" src="{cross}/embed/xss"></iframe>`,
    "/embed/xss": `<p>embed</p><script>window.__xss_fired = 1</script>`,
    "/own-marker": `<h1>x</h1><script>window.__mine = true; window.__cb_xss_fired = 0</script>`,
    "/markup": `<h1>x</h1><b data-cb-injected>Admin</b><a href="javascript:window.__cb_xss_fired=1">site</a>`,
    // The URL parser drops tabs and leading spaces, decodes nothing in the
    // scheme, and ignores case: all four are `javascript:` URLs.
    "/markup-obfuscated":
      `<h1>x</h1><a href=" JaVa&#9;ScRiPt:window.__cb_xss_fired=1">a</a>` +
      `<form action="javascript:window.%5F%5Fxss_fired=1"></form>` +
      `<svg><a xlink:href="javascript:window.__xss_fired=1"><text>s</text></a></svg>` +
      `<button formaction="javascript:window.__cb_xss_fired=1">b</button>`,
    "/safe-links":
      `<h1>Contact</h1><a href="mailto:a@example.test">mail</a><a href="tel:+15550100">call</a>` +
      `<a href="javascript:void(0)">menu</a><a href="/search?q=__cb_xss_fired">search</a>` +
      `<span title='<b data-cb-injected>x</b> javascript:window.__cb_xss_fired=1'>escaped</span>` +
      `<p>&lt;details open ontoggle="window.__cb_xss_fired=1"&gt;</p>` +
      `<input aria-label="u" value="javascript:window.__cb_xss_fired=1"><textarea aria-label="t">&lt;b data-cb-injected&gt;</textarea>`,
    // An unguarded deep merge of parsed JSON: its own `__proto__` key walks
    // into Object.prototype.
    "/polluted":
      `<h1>x</h1><script>` +
      `function merge(target, source) {` +
      `  for (const key in source) {` +
      `    if (source[key] && typeof source[key] === "object") merge(target[key] ??= {}, source[key]);` +
      `    else target[key] = source[key];` +
      `  }` +
      `  return target;` +
      `}` +
      `merge({}, JSON.parse('{"theme":"dark","__proto__":{"cbPolluted":"1"}}'));` +
      `</script>`,
    "/own-keys":
      `<h1>__proto__</h1><script>` +
      `window.prefs = { cbPolluted: 1 };` +
      `window.parsed = JSON.parse('{"__proto__":{"cbPolluted":"1"}}');` +
      `Object.defineProperty(Object.prototype, "cbShim", { value: 1, enumerable: false });` +
      `</script>`,
    "/garbage":
      `<h1>Cart</h1><p>Total: <span>NaN</span></p><p>Hello undefined</p>` +
      `<p>Tags: [object Object]</p><p>Posted Invalid Date</p>`,
    "/garbage-long": `<h1>x</h1><p>${"word ".repeat(30)}NaN${" word".repeat(30)}</p>`,
    "/garbage-null": `<h1>x</h1><p>Name: null</p>`,
    // A `$NaN` price, text inside the shown `<option>` and a `display: contents`
    // wrapper: all on screen, all flagged.
    "/garbage-price": `<h1>Cart</h1><p>Total: $NaN</p>`,
    "/garbage-option": `<h1>x</h1><select aria-label="size"><option>undefined</option></select>`,
    "/garbage-contents": `<h1>x</h1><div style="display:contents">Posted Invalid Date</div>`,
    // The <title> is not rendered; the sample must not fold it in beside the token.
    "/garbage-svg": `<h1>x</h1><svg><text>NaN</text><title>undefined</title></svg>`,
    // An in-page editor: `undefined` is the content the user is editing, not
    // the app's own garbage, so `[contenteditable]` is in the default ignore.
    "/editor": `<h1>Editor</h1><div contenteditable><span>let x = undefined;</span></div>`,
    // DOM clobbering: an element whose id is a marker name shows up through
    // the prototype chain, not as an own property of `window`.
    "/clobber": `<h2 id="__xss_fired">window.__xss_fired</h2>`,
    // An event-handler attribute that names a marker, which the crawler never
    // fires: the sink, not its execution.
    "/handler-attr": `<h1>x</h1><img alt="avatar" onmouseover="window.__cb_xss_fired=1">`,
    // A web component renders its whole UI into an open shadow root, which
    // `innerText` does not descend into: the light DOM has no text of its own.
    "/shadow":
      `<my-panel></my-panel><script>` +
      `const host = document.querySelector("my-panel");` +
      `host.attachShadow({ mode: "open" }).innerHTML = "<h1>Dashboard</h1><p>Welcome back, Ada.</p>";` +
      `</script>`,
    "/code-sample":
      `<h1>Docs</h1><pre>let x = undefined;</pre><p>Returns <code>NaN</code>.</p>` +
      `<kbd>[object Object]</kbd><samp>Invalid Date</samp><textarea aria-label="t">undefined</textarea>` +
      `<p hidden>NaN</p><p style="display:none">undefined</p><p style="visibility:hidden">NaN</p>` +
      `<p>undefinedBehavior is a flag and NaN_count is an identifier.</p>` +
      `<template><p>undefined</p></template><noscript>undefined</noscript>`,
    "/blank": `<div id="app"></div>`,
    "/hidden-only": `<div hidden>Loading data</div>`,
    "/blank-with-frame": `<iframe title="embed" src="/embed/text"></iframe>`,
    "/embed/text": `<p>embedded text</p>`,
    "/error-screen": `<h1>Something went wrong</h1><p>Please try again.</p>`,
    "/cross-clean":
      `<h1>x</h1><iframe title="cross" src="{cross}/embed/text"></iframe>` +
      `<iframe title="sandboxed" sandbox src="/embed/text"></iframe>`,
    "/stuck": `<h1>x</h1><iframe title="stuck" src="{cross}/spin"></iframe>`,
    // Its main thread spins from just after load, as a stuck widget's does.
    "/spin": `<p>spin</p><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }))</script>`,
  };

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/search-unsafe" || path === "/search-safe") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(search(path === "/search-unsafe" ? "innerHTML" : "textContent"));
      }
      const body = PAGES[path];
      if (body === undefined) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(doc(body.replaceAll("{cross}", cross)));
    });
    base = server.url;
    // `localhost` is another origin than `127.0.0.1`.
    cross = `http://localhost:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  /** `invariant`'s verdict on a fresh page at `path`, so nothing a page set leaks into the next. */
  async function check(invariant: Invariant, path: string): Promise<boolean | string | void> {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}${path}`);
      return await invariant.check({ page, url: page.url(), errors: [], state: new Map() });
    } finally {
      await page.close();
    }
  }

  describe("xssMarker", () => {
    it("fails on a marker set in the top document", async () => {
      expect(await check(xssMarker(), "/xss")).toBe("XSS marker set: window.__cb_xss_fired");
    });

    it("fails on a marker set inside a same-origin iframe, naming the frame", async () => {
      expect(await check(xssMarker(), "/xss-in-frame")).toBe(
        `XSS marker set: in frame ${base}/embed/xss: window.__xss_fired`
      );
    });

    it("fails on a marker set inside a cross-origin iframe", async () => {
      expect(await check(xssMarker(), "/xss-cross-frame")).toBe(
        `XSS marker set: in frame ${cross}/embed/xss: window.__xss_fired`
      );
    });

    it("reads only the markers it is given, and only when truthy", async () => {
      expect(await check(xssMarker(), "/own-marker")).toBe(true);
      expect(await check(xssMarker({ markers: ["__mine"] }), "/own-marker")).toBe("XSS marker set: window.__mine");
    });

    it("stays clean on marker text in attributes, form values and escaped text", async () => {
      expect(await check(xssMarker(), "/safe-links")).toBe(true);
    });

    it("stays clean when an element's id clobbers a marker name", async () => {
      expect(await check(xssMarker(), "/clobber")).toBe(true);
    });
  });

  describe("injectedMarkup", () => {
    it("fails on an element carrying data-cb-injected and on a canary javascript: href", async () => {
      expect(await check(injectedMarkup(), "/markup")).toBe(
        'injected markup: <b data-cb-injected>, <a href="javascript:window.__cb_xss_fired=1">'
      );
    });

    it("reads javascript: URLs the way the URL parser does, in every URL attribute", async () => {
      expect(await check(injectedMarkup(), "/markup-obfuscated")).toBe(
        'injected markup: <a href=" JaVa ScRiPt:window.__cb_xss_fired=1">, ' +
          '<form action="javascript:window.%5F%5Fxss_fired=1">, ' +
          '<a xlink:href="javascript:window.__xss_fired=1"> (+1 more)'
      );
    });

    it("stays clean on mailto:, tel:, javascript:void(0) and marker text outside a URL", async () => {
      expect(await check(injectedMarkup(), "/safe-links")).toBe(true);
    });

    it("counts every javascript: URL with anyJavascriptUrl", async () => {
      expect(await check(injectedMarkup({ anyJavascriptUrl: true }), "/safe-links")).toBe(
        'injected markup: <a href="javascript:void(0)">'
      );
    });

    it("looks for the attribute it is given", async () => {
      expect(await check(injectedMarkup({ attribute: "data-other" }), "/markup")).toBe(
        'injected markup: <a href="javascript:window.__cb_xss_fired=1">'
      );
    });

    it("flags an event-handler attribute that names a marker, fired or not", async () => {
      expect(await check(injectedMarkup(), "/handler-attr")).toBe(
        'injected markup: <img onmouseover="window.__cb_xss_fired=1">'
      );
    });

    it("rejects an empty attribute when it is built", () => {
      expect(() => injectedMarkup({ attribute: "" })).toThrow(/attribute.*must not be empty/);
    });
  });

  describe("prototypePollution", () => {
    it("fails when a deep merge of a __proto__ key polluted Object.prototype", async () => {
      expect(await check(prototypePollution(), "/polluted")).toBe("Object.prototype polluted: cbPolluted");
    });

    it("stays clean on own cbPolluted and __proto__ keys and a non-enumerable shim", async () => {
      expect(await check(prototypePollution(), "/own-keys")).toBe(true);
    });
  });

  describe("renderedGarbage", () => {
    it("fails on each default token in visible text, with the text around it", async () => {
      expect(await check(renderedGarbage(), "/garbage")).toBe(
        'rendered garbage: NaN in "Total: NaN", undefined in "Hello undefined", ' +
          '[object Object] in "Tags: [object Object]" (+1 more)'
      );
    });

    it("cuts a long text to the part around the token", async () => {
      const message = await check(renderedGarbage(), "/garbage-long");
      expect(message).toMatch(/^rendered garbage: NaN in "…(word ){7}word NaN( word){7} word…"$/);
    });

    it("stays clean on tokens in code, form fields, hidden text and identifiers", async () => {
      expect(await check(renderedGarbage(), "/code-sample")).toBe(true);
    });

    it("is kept clean there by `ignore`: with none, the code samples fail", async () => {
      expect(await check(renderedGarbage({ ignore: "" }), "/code-sample")).toBe(
        'rendered garbage: undefined in "let x = undefined;", NaN in "Returns NaN.", ' +
          '[object Object] in "[object Object]" (+2 more)'
      );
    });

    it("takes null only when asked", async () => {
      expect(await check(renderedGarbage(), "/garbage-null")).toBe(true);
      expect(await check(renderedGarbage({ tokens: ["null"] }), "/garbage-null")).toBe(
        'rendered garbage: null in "Name: null"'
      );
    });

    it("flags a token next to a currency symbol", async () => {
      expect(await check(renderedGarbage(), "/garbage-price")).toBe('rendered garbage: NaN in "Total: $NaN"');
    });

    it("flags visible text the select shows in an option", async () => {
      expect(await check(renderedGarbage(), "/garbage-option")).toBe('rendered garbage: undefined in "undefined"');
    });

    it("flags visible text inside a display:contents element", async () => {
      expect(await check(renderedGarbage(), "/garbage-contents")).toBe('rendered garbage: Invalid Date in "Posted Invalid Date"');
    });

    it("keeps an SVG title out of the sample it builds for the token", async () => {
      expect(await check(renderedGarbage(), "/garbage-svg")).toBe('rendered garbage: NaN in "NaN"');
    });

    it("leaves a token in a contenteditable editor alone", async () => {
      expect(await check(renderedGarbage(), "/editor")).toBe(true);
    });

    it("throws on an invalid ignore selector on every page, matching token or not", async () => {
      await expect(check(renderedGarbage({ ignore: "pre,<<" }), "/garbage")).rejects.toThrow(/is not a valid selector/);
      await expect(check(renderedGarbage({ ignore: "pre,<<" }), "/blank")).rejects.toThrow(/is not a valid selector/);
    });
  });

  describe("notBlank", () => {
    it("fails on a page with no visible text", async () => {
      const blank = "blank page: 0 characters of visible text in body, fewer than 1";
      expect(await check(notBlank(), "/blank")).toBe(blank);
      expect(await check(notBlank(), "/hidden-only")).toBe(blank);
    });

    it("counts the text of every frame together", async () => {
      expect(await check(notBlank(), "/blank-with-frame")).toBe(true);
    });

    it("fails below minText", async () => {
      expect(await check(notBlank({ minText: 100 }), "/error-screen")).toBe(
        "blank page: 39 characters of visible text in body, fewer than 100"
      );
    });

    it("fails on error text, as a substring or a RegExp", async () => {
      expect(await check(notBlank({ errorText: ["Something went wrong", /try again/gi] }), "/error-screen")).toBe(
        'error text shown: "Something went wrong", "try again"'
      );
      expect(await check(notBlank({ errorText: ["Not found"] }), "/error-screen")).toBe(true);
    });

    it("counts text a web component renders into an open shadow root", async () => {
      expect(await check(notBlank(), "/shadow")).toBe(true);
    });
  });

  it("every preset stays clean on the near-miss pages", async () => {
    for (const path of ["/safe-links", "/own-keys", "/code-sample"]) {
      for (const invariant of [...dataSafety(), notBlank()]) {
        expect([path, invariant.name, await check(invariant, path)]).toEqual([path, invariant.name, true]);
      }
    }
  }, 30_000);

  it("every preset reads a page with cross-origin and sandboxed iframes without throwing", async () => {
    for (const invariant of [...dataSafety(), notBlank()]) {
      expect([invariant.name, await check(invariant, "/cross-clean")]).toEqual([invariant.name, true]);
    }
  }, 30_000);

  it("skips an out-of-process iframe whose main thread is stuck", async () => {
    const oopif = await chromium.launch({ args: ["--site-per-process"] });
    try {
      const page = await oopif.newPage();
      await page.goto(`${base}/stuck`);
      expect(await xssMarker().check({ page, url: page.url(), errors: [], state: new Map() })).toBe(true);
    } finally {
      await oopif.close();
    }
  }, 30_000);

  describe("in a crawl", () => {
    async function crawl(path: string, invariants: Invariant[] = [...dataSafety(), notBlank()]) {
      return new ChaosCrawler({
        baseUrl: `${base}${path}`,
        maxPages: 1,
        maxActionsPerPage: 0,
        headless: true,
        logLevel: "error",
        invariants,
      }).start();
    }

    it("reports a payload that ran as an invariant violation, and fails the run", async () => {
      const report = await crawl(`/search-unsafe${XSS_QUERY}`);
      // The payload ran (xss-marker) and its `ontoggle` handler names the
      // marker in the DOM (injected-markup); both are reported.
      expect(report.pages[0]!.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "invariant-violation",
            invariantName: "data.xss-marker",
            message: "[data.xss-marker] XSS marker set: window.__cb_xss_fired",
          }),
          expect.objectContaining({
            type: "invariant-violation",
            invariantName: "data.injected-markup",
            message: '[data.injected-markup] injected markup: <details ontoggle="window.__cb_xss_fired=1">',
          }),
        ])
      );
      expect(getExitCode(report)).toBe(1);
    }, 60_000);

    it("reports nothing for the page that renders the same query as text", async () => {
      const report = await crawl(`/search-safe${XSS_QUERY}`);
      expect(report.pages[0]!.status).toBe("success");
      expect(report.pages[0]!.errors).toEqual([]);
      expect(getExitCode(report, true)).toBe(0);
    }, 60_000);

    it("skips the error page a cross-origin iframe the crawl blocked (the default) is left with", async () => {
      let frames: string[] = [];
      const recordFrames: Invariant = {
        name: "frames",
        check: ({ page }) => {
          frames = page.frames().map((f) => f.url());
        },
      };
      const report = await crawl("/cross-clean", [...dataSafety(), notBlank(), recordFrames]);
      expect(frames.some((u) => u.startsWith("chrome-error:"))).toBe(true);
      expect(report.pages[0]!.errors.filter((e) => e.type === "invariant-violation")).toEqual([]);
    }, 60_000);
  });
});
