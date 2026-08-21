/**
 * Bridge for the pagination-order pattern.
 *
 * The only pattern whose bug is invisible to every per-plan expectation. Both
 * variants end with four rows, a `ready` banner and no escaped rejection: the
 * model's prediction is met exactly. What differs is the *order* of the rows,
 * and that is a rule about this app's DOM rather than a state a model should
 * enumerate — so it is declared here once, as a `uiInvariants` entry, and
 * checked for every plan that reaches that label.
 */
import { readFileSync } from "node:fs";

const timingProfile = JSON.parse(
  readFileSync(new URL("../../model/profile.json", import.meta.url), "utf8"),
);

export default {
  rules: {
    // Two operations, distinguished by the page they ask for: a plan has to be
    // able to slow one and not the other.
    page1: { urlPattern: /\/api\/feed\?page=1$/, methods: ["GET"] },
    page2: { urlPattern: /\/api\/feed\?page=2$/, methods: ["GET"] },
  },

  /** Must match DEADLINE_MS in public/feed.js — the test asserts it does. */
  appDeadlineMs: 1200,
  timingProfile,

  action: async (page) => {
    // Both clicks before either response lands. Two requests in flight is the
    // precondition for the race; one at a time cannot reorder anything.
    const more = page.getByRole("button", { name: "Load more" });
    await more.click();
    await more.click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  stateProbe: async (page) =>
    page.evaluate(() => ({ items: document.querySelectorAll("#items li").length })),

  uiInvariants: {
    // "*" — the claim holds under every label the model can predict. A feed
    // with a failed page is still a feed in order.
    //
    // Two checks, and the first one is what makes the second mean anything.
    // `data-idx` is written by the app, so comparing it against its own sort
    // is only an assertion while the attribute is *independently derivable*
    // from the row: an app that writes the render position into it
    // (`dataset.idx = list.children.length + 1`, the shape of every
    // `key={i}` bug) is ascending and unique by construction, and the
    // ordering check compares the render order against itself. So correlate
    // two sources that come from different places first — the attribute
    // against the row's own rendered content, which comes from the payload —
    // and only then ask whether the sequence is in order.
    "*": async (page) =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll("#items li")];
        const mislabelled = rows
          .filter((li) => li.textContent.trim() !== `Post ${li.dataset.idx}`)
          .map((li) => `${li.dataset.idx}≠"${li.textContent.trim()}"`);
        if (mislabelled.length > 0) {
          return (
            `a row's index does not match its own content: ${mislabelled.join(", ")} — ` +
            `data-idx is not derived from the response, so "in order" is the app's ` +
            `opinion of its own order`
          );
        }
        const idx = rows.map((li) => Number(li.dataset.idx));
        const sorted = [...idx].sort((a, b) => a - b);
        if (idx.join() !== sorted.join()) {
          return `rows are out of order: rendered ${idx.join(",")}, expected ${sorted.join(",")}`;
        }
        if (new Set(idx).size !== idx.length) return `a row is repeated: ${idx.join(",")}`;
        return "";
      }),
  },

  // No settleMs: solved from appDeadlineMs + timingProfile, because the delay
  // that makes page 1 lose the race is solved from the same number.
};
