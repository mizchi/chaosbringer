/**
 * Bridge for `chaosbringer model run` against this app.
 *
 * Note the two operations share one URL and are separated by method — this is
 * why `rules` accepts `{ urlPattern, methods }`: `GET /api/todos` (refresh)
 * and `POST /api/todos` (write) are different operations that a URL pattern
 * alone cannot tell apart.
 */
export default {
  rules: {
    post: { urlPattern: /\/api\/todos$/, methods: ["POST"] },
    list: { urlPattern: /\/api\/todos$/, methods: ["GET"] },
  },

  action: async (page) => {
    await page.getByRole("button", { name: "Add random todo" }).click();
  },

  uiProbe: async (page) => {
    const text = (await page.locator("#list").textContent()) ?? "";
    if (text.includes("loading...")) return "stuck";
    if (text.includes("error:")) return "error";
    return "ready";
  },

  /**
   * Must exceed the app's own request deadline (`AbortSignal.timeout(5000)`).
   * A shorter window makes the probe fire before the timeout does, and a
   * correctly-bounded request gets reported as "stuck".
   */
  settleMs: 6000,
};
